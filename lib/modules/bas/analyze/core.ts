import type { Pool } from "pg";
import { QueryFailure, runGuardedSelect, type RunOptions } from "./pool";
import { computeProvenance } from "./provenance";
import { getSchemaContext, type SchemaContext } from "./schema-context";
import { filtersByTime, guardSql, readsReadings } from "./sql-guard";
import {
  PlannerError,
  type AnalyzeResult,
  type Attempt,
  type Cell,
  type NoDataReason,
  type Plan,
  type PriorTurn,
  type Provenance,
  type ReportContext,
  type ResultTable,
} from "./types";

/**
 * Steps 4 to 9 of an Analyze question - plan, guard, run, provenance,
 * no-data check, summarise - with nothing around them: no configuration
 * read, no entitlement, no rate limit, no audit row, no log line.
 *
 * Two callers, one path. `analyzeQuestion` (service.ts) wraps it with
 * steps 1-3 and 10 for the Analyze tab, exactly as before this file
 * existed. The report engine (reports/engine/planner-questions.ts, Reports
 * Phase 6) calls it once per planner question with the report's building,
 * stations and period as fixed context, through the same bas_analyze pool,
 * the same guard and the same provenance - and records the outcome on the
 * run instead of as a `bas.question_asked` row.
 *
 * A file of its own, rather than an export of service.ts, because the
 * report worker must not import lib/env.ts (tests/bas-reports-jobs-env.test.ts
 * walks its import graph): service.ts reads the environment through env.ts,
 * and this file reads nothing but its arguments. It imports pg, the guard,
 * the provenance queries and the types; never the database client, never
 * the environment.
 */

export interface Planner {
  plan(input: {
    question: string;
    schema: SchemaContext;
    nowUtc: string;
    /** On a retry: what the first attempt produced and why it was unusable. */
    previous: Attempt | null;
    /**
     * Today's earlier turns, as the browser sent them and the route checked
     * them. Empty for a first question. Shown to the model as data; never
     * acted on by the platform.
     */
    priorTurns: PriorTurn[];
    /**
     * A report's building, stations and period (Reports, Phase 6), or
     * absent on the Analyze tab. Shown to the model as fixed context; the
     * platform checks the result against it afterwards (the report's
     * planner section names any point outside the building and any period
     * other than the report's) rather than trusting the prompt.
     */
    reportContext?: ReportContext | null;
  }): Promise<Plan>;

  summarise(input: {
    question: string;
    interpretation: string;
    sql: string;
    table: ResultTable;
    provenance: Provenance;
    /** The same clock the plan call saw: the worked timezone example is drawn from it. */
    nowUtc: string;
  }): Promise<string>;
}

/** Every outcome an answer can have once the configuration has been read. */
export type CoreResult = Exclude<AnalyzeResult, { kind: "not_configured" }>;

export interface CoreOutcome {
  result: CoreResult;
  /** The SQL to record, for a result that does not carry its own (a provenance failure). */
  sqlForRecord: string | null;
  rowCountForRecord: number | null;
}

export interface CoreInput {
  question: string;
  priorTurns: PriorTurn[];
  nowUtc: string;
  /** Epoch ms the question was taken: the durationMs on a result counts from here. */
  started: number;
  reportContext?: ReportContext | null;
}

export interface CoreDeps {
  planner: Planner;
  pool: Pool;
  run: RunOptions;
  /** The schema context's cache key: the ask URL. */
  schemaKey: string;
  /** Called when the summariser throws; the rows are returned regardless. */
  onSummariseFailed?: (error: unknown) => void;
}

export async function planAndAnswer(input: CoreInput, deps: CoreDeps): Promise<CoreOutcome> {
  const { question, priorTurns, nowUtc, started } = input;
  const reportContext = input.reportContext ?? null;
  const { pool, run } = deps;
  let sqlForRecord: string | null = null;
  let rowCountForRecord: number | null = null;
  const done = (result: CoreResult): CoreOutcome => ({ result, sqlForRecord, rowCountForRecord });

  try {
    const schema = await getSchemaContext(pool, deps.schemaKey);

    const attempts: Attempt[] = [];
    let retried = false;
    let plan: Plan | null = null;
    let ran: (ResultTable & { durationMs: number }) | null = null;

    // 4-6, at most twice.
    for (let attempt = 0; attempt < 2 && ran === null; attempt += 1) {
      retried = attempt === 1;
      const previous = attempts[attempts.length - 1] ?? null;

      try {
        plan = await deps.planner.plan({
          question,
          schema,
          nowUtc,
          previous,
          priorTurns,
          ...(reportContext === null ? {} : { reportContext }),
        });
      } catch (error) {
        if (error instanceof PlannerError) {
          // A refusal or an outage is not something a retry fixes; an
          // unparseable answer might be.
          if (error.code !== "unparseable" || retried) {
            return done({ kind: "cannot_answer", reason: plannerFailureReason(error), attempts, retried });
          }
          attempts.push({ sql: "", error: error.message, ran: false });
          continue;
        }
        throw error;
      }

      if (plan.kind === "from_prior") {
        // The source must be one of the turns THIS request carried. An index
        // outside them is an unusable plan - the model named a turn it was
        // not shown - and gets the one retry an unparseable answer gets.
        const source = priorTurns[plan.sourceTurn];
        if (source === undefined || plan.answer.length === 0) {
          attempts.push({
            sql: "",
            error:
              `A from_prior answer named earlier question ${plan.sourceTurn + 1}, ` +
              `but ${priorTurns.length === 0 ? "no earlier questions were given" : `only ${priorTurns.length} were given`}` +
              `${plan.answer.length === 0 ? ", and the answer was empty" : ""}. ` +
              "Write a query, or name one of the earlier questions given.",
            ran: false,
          });
          plan = null;
          continue;
        }
        break;
      }

      if (plan.kind !== "query") break;

      const guarded = guardSql(plan.sql);
      if (!guarded.ok) {
        attempts.push({ sql: plan.sql, error: guarded.reason, ran: false });
        continue;
      }

      // A period in the SQL with no declared range is unusable ONCE: the
      // retry asks for the range, because without it the gap overlap - the
      // one figure that checks a numeric answer over a month - cannot be
      // computed. Found live on 2026-09-21: `now() - interval '30 days'` in
      // the SQL, `time_range: null` beside it. If the second plan still
      // omits it, the query runs and the provenance carries the flag; the
      // screen then says "period not stated" in amber rather than
      // pretending the question had no period.
      if (plan.timeRange === null && filtersByTime(guarded.sql) && !retried) {
        attempts.push({
          sql: guarded.sql,
          error:
            "The SQL filters or buckets by time, but time_range was null. Declare the UTC " +
            "start and end the SQL covers, resolving now() and any interval to timestamps.",
          ran: false,
        });
        continue;
      }

      try {
        ran = await runGuardedSelect(pool, guarded.sql, run);
        plan = { ...plan, sql: guarded.sql };
      } catch (error) {
        if (error instanceof QueryFailure) {
          // The database received it: a refusal, an error or a timeout is
          // still a query that ran.
          attempts.push({ sql: guarded.sql, error: describeQueryFailure(error), ran: true });
          // A timeout is not a planning mistake to be retried into a second
          // fifteen-second wait; it is the answer.
          if (error.timedOut) break;
          continue;
        }
        throw error;
      }
    }

    if (plan === null) {
      return done({ kind: "cannot_answer", reason: "No plan could be produced for this question.", attempts, retried });
    }

    if (plan.kind === "clarify") {
      return done({ kind: "clarify", question: plan.question, interpretation: plan.interpretation });
    }

    if (plan.kind === "cannot_answer") {
      return done({ kind: "cannot_answer", reason: plan.reason, attempts, retried });
    }

    if (plan.kind === "from_prior") {
      // Validated in the loop: the source exists among what was sent.
      const source = priorTurns[plan.sourceTurn]!;
      return done({
        kind: "from_prior",
        answer: plan.answer,
        interpretation: plan.interpretation,
        source: {
          id: source.id,
          question: source.question,
          kind: source.kind,
          rowsWerePartial: source.rowsArePartial,
          rowCount: source.rowCount,
        },
        durationMs: Date.now() - started,
        retried,
      });
    }

    if (ran === null) {
      const last = attempts[attempts.length - 1];
      return done({
        kind: "cannot_answer",
        reason:
          last !== undefined && last.error.startsWith("The query took too long")
            ? last.error
            : retried
              ? "Two attempts at a query for this question could not be run. What was tried is below."
              : "The query for this question could not be run. What was tried is below.",
        attempts,
        retried,
      });
    }

    sqlForRecord = plan.sql;
    rowCountForRecord = ran.rowCount;

    // 7. Provenance - ours.
    const touchesReadings = readsReadings(plan.sql);
    const provenance = await computeProvenance(pool, {
      pointIds: plan.pointIds,
      timeRange: plan.timeRange,
      readsReadings: touchesReadings,
      filtersByRole: plan.filtersByRole,
      periodUndeclared: plan.timeRange === null && filtersByTime(plan.sql),
    });

    const table: ResultTable = {
      columns: ran.columns,
      rows: ran.rows,
      rowCount: ran.rowCount,
      truncated: ran.truncated,
      rowCap: ran.rowCap,
    };

    // 8. No data is not zero.
    const noData = detectNoData(table);
    if (noData !== null) {
      return done({
        kind: "no_data",
        reason: noData,
        explanation: explainNoData(noData, plan.timeRange, provenance),
        sql: plan.sql,
        interpretation: plan.interpretation,
        table,
        provenance,
        durationMs: Date.now() - started,
        retried,
      });
    }

    // 9. The model's sentence about real rows.
    let answer: string;
    try {
      answer = await deps.planner.summarise({
        question,
        interpretation: plan.interpretation,
        sql: plan.sql,
        table,
        provenance,
        nowUtc,
      });
    } catch (error) {
      // The rows are on screen either way. A failed summary is said, not hidden.
      deps.onSummariseFailed?.(error);
      answer = "The rows below were retrieved, but no summary could be written for them. Read the table directly.";
    }

    return done({
      kind: "answered",
      answer,
      interpretation: plan.interpretation,
      sql: plan.sql,
      table,
      provenance,
      durationMs: Date.now() - started,
      retried,
    });
  } catch (error) {
    if (error instanceof QueryFailure) {
      // A provenance query failed: the role cannot read something it should.
      // This is a configuration fault, not the question's.
      return done({
        kind: "cannot_answer",
        reason: "The platform could not read the tables it needs to check this answer. Contact IT. (" + error.message + ")",
        attempts: sqlForRecord === null ? [] : [{ sql: sqlForRecord, error: error.message, ran: true }],
        retried: false,
      });
    }
    throw error;
  }
}

/**
 * Zero rows, or rows in which every cell is NULL.
 *
 * The second case is the disguised one: `SELECT avg(value_num) FROM ...` with
 * no matching readings returns ONE row holding NULL, and a screen that rendered
 * it as a table would show a blank where a number goes and a summary would say
 * "no average was recorded". It means exactly what zero rows means.
 */
export function detectNoData(table: ResultTable): NoDataReason | null {
  if (table.rowCount === 0) return "no_rows";
  const allNull = table.rows.every((row) => row.every((cell: Cell) => cell === null));
  return allNull ? "all_null" : null;
}

/**
 * Why nothing matched, from what the database holds - written here, not by
 * the model. The cases docs/BAS-B5.md names, in the order they are checked.
 */
export function explainNoData(
  reason: NoDataReason,
  range: Provenance["timeRange"],
  provenance: Provenance,
): string {
  // Worded for the person at the keyboard (docs/11-analyze-voice.md), with
  // the one property that matters kept in the same words: it is not an
  // answer of zero.
  const lead =
    reason === "no_rows"
      ? "Nothing in the data matched this question. That is not an answer of zero: there is no reading to answer it with."
      : "The query came back empty - an average over no readings. That is not an answer of zero: there is no reading to answer it with.";

  const notes: string[] = [];
  const coverage = provenance.coverage;

  if (provenance.scope !== "none" && provenance.points.length === 0) {
    notes.push("No points matched the question at all.");
  }

  if (coverage !== null) {
    if (coverage.readings === 0) {
      notes.push(
        provenance.points.length === 1
          ? `${provenance.points[0]!.name} has never had a reading collected.`
          : `None of the ${provenance.points.length} points in scope has a reading collected.`,
      );
    } else {
      if (coverage.neverCollected.length > 0) {
        notes.push(
          `Never collected: ${coverage.neverCollected.slice(0, 5).join(", ")}` +
            (coverage.neverCollected.length > 5 ? ` and ${coverage.neverCollected.length - 5} more.` : "."),
        );
      }
      // One definition of "the period is not covered", shared with every
      // answered result through Provenance.coverageShortfall.
      if (provenance.coverageShortfall !== null) {
        notes.push(provenance.coverageShortfall);
      }
    }
  }

  const uncollected = provenance.points.filter((p) => !p.collected);
  if (uncollected.length > 0 && (coverage === null || coverage.readings > 0)) {
    notes.push(`Not currently collected: ${uncollected.slice(0, 5).map((p) => p.name).join(", ")}.`);
  }

  if (provenance.unclassifiedExcluded > 0) {
    notes.push(
      `${provenance.unclassifiedExcluded} points have no role assigned yet, so a search by what a point measures could not include them.`,
    );
  }

  return notes.length === 0 ? lead : `${lead} ${notes.join(" ")}`;
}

function plannerFailureReason(error: PlannerError): string {
  switch (error.code) {
    case "refused":
      return "The answer service declined to write a query for this question.";
    case "unparseable":
      return "The answer service could not produce a usable query for this question, twice.";
    case "unavailable":
      // The planner's own message names which of the failure modes it was -
      // key rejected, rate limited, unreachable, an HTTP status. Rendering a
      // single generic sentence for all of them hid a 401 behind "could not
      // be reached" on the first live run, and the person reading the screen
      // needs to know whether to wait or to go and fix the key.
      return `${error.message} Nothing was queried.`;
  }
}

function describeQueryFailure(error: QueryFailure): string {
  if (error.timedOut) {
    return "The query took too long and was stopped. Narrow the question - a shorter period or fewer points.";
  }
  return error.message;
}
