import type { Pool } from "pg";
import type { Viewer } from "@/lib/authz";
import { writeAuditEvent } from "@/lib/audit";
import { databaseQueried } from "./types";
import { prisma } from "@/lib/db";
import { logger, logUnexpected } from "@/lib/logger";
import { BAS_MODULE_KEY } from "../constants";
import { basSiteScope } from "../service";
import { readAnalyzeEnv, type EnvLike } from "./env";
import {
  DEFAULT_RUN_OPTIONS,
  QueryFailure,
  getAnalyzePool,
  runGuardedSelect,
  type RunOptions,
} from "./pool";
import { computeProvenance } from "./provenance";
import { QuestionRateLimiter, questionRateLimiter } from "./rate-limit";
import { getSchemaContext, type SchemaContext } from "./schema-context";
import { filtersByTime, guardSql, readsReadings } from "./sql-guard";
import {
  PlannerError,
  type AnalyzeResult,
  type Attempt,
  type Cell,
  type NoDataReason,
  type Plan,
  type Provenance,
  type ResultTable,
} from "./types";

/**
 * The Analyze service: a question in, an AnalyzeResult out.
 *
 * The order of operations is the safety model, and it is the same order every
 * time:
 *
 *   1. configuration     no key or no URL -> `not_configured`, nothing else
 *   2. entitlement       per-site scoping would make free SQL a leak; refused
 *                        outright the day it arrives
 *   3. rate limit        before any token is spent
 *   4. plan              the model writes SQL, or asks, or declines
 *   5. guard             sql-guard.ts refuses anything that is not one SELECT
 *   6. run               READ ONLY, cursor, timeout, row cap (pool.ts)
 *   7. provenance        OUR queries: gaps, horizons, coverage
 *   8. no-data check     zero rows, or rows that are all NULL, stop here.
 *                        The summariser is never called with nothing.
 *   9. summarise         the model's sentence about the rows, labelled as such
 *  10. record            one log line and one audit row, whatever happened
 *
 * One retry, at step 4/5/6, when the plan was unusable (unparseable, refused by
 * the guard, or refused by the database). The retry is told what went wrong.
 * There is no second retry, and the result says a retry happened.
 *
 * The planner is a dependency rather than an import so that every path above
 * can be driven against the real test database with a fake planner. The
 * Anthropic-backed one is `createAnthropicPlanner` in planner.ts.
 */

export interface Planner {
  plan(input: {
    question: string;
    schema: SchemaContext;
    nowUtc: string;
    /** On a retry: what the first attempt produced and why it was unusable. */
    previous: Attempt | null;
  }): Promise<Plan>;

  summarise(input: {
    question: string;
    interpretation: string;
    sql: string;
    table: ResultTable;
    provenance: Provenance;
  }): Promise<string>;
}

export interface AnalyzeDeps {
  planner: Planner;
  env?: EnvLike;
  run?: RunOptions;
  rateLimiter?: QuestionRateLimiter;
  /** Injected for tests that need a pool on a specific role. */
  pool?: Pool;
  now?: () => Date;
}

export const MAX_QUESTION_LENGTH = 1_000;

export class RateLimited extends Error {
  constructor(readonly retryAfterMs: number) {
    super("Too many questions in a short time. Wait a moment and ask again.");
    this.name = "RateLimited";
  }
}

export async function analyzeQuestion(
  viewer: Viewer,
  rawQuestion: string,
  deps: AnalyzeDeps,
): Promise<AnalyzeResult> {
  const question = rawQuestion.trim();
  const started = Date.now();

  // 1. Configuration.
  const env = readAnalyzeEnv(deps.env ?? process.env);
  if (!env.present) {
    return { kind: "not_configured", missing: env.missing };
  }

  // 2. Entitlement. Free-form SQL cannot be scoped to a subset of sites, so
  // the moment `basSiteScope` returns a list rather than null this feature
  // stops rather than leaking. Today it is null for everyone.
  const scope = await basSiteScope(viewer);
  if (scope.entitled !== null) {
    return {
      kind: "cannot_answer",
      reason:
        "Your Building Automation access is limited to particular buildings, and " +
        "Analyze cannot yet confine its queries to a subset. Use the other tabs.",
      attempts: [],
      retried: false,
    };
  }

  // 3. Rate limit.
  const limiter = deps.rateLimiter ?? questionRateLimiter;
  const verdict = limiter.check(viewer.id);
  if (!verdict.allowed) throw new RateLimited(verdict.retryAfterMs);

  const pool = deps.pool ?? getAnalyzePool(env.values.askDatabaseUrl);
  const run = deps.run ?? DEFAULT_RUN_OPTIONS;
  const nowUtc = (deps.now ?? (() => new Date()))().toISOString();

  let result: AnalyzeResult;
  let sqlForRecord: string | null = null;
  let rowCountForRecord: number | null = null;

  try {
    const schema = await getSchemaContext(pool, env.values.askDatabaseUrl);

    const attempts: Attempt[] = [];
    let retried = false;
    let plan: Plan | null = null;
    let ran: (ResultTable & { durationMs: number }) | null = null;

    // 4-6, at most twice.
    for (let attempt = 0; attempt < 2 && ran === null; attempt += 1) {
      retried = attempt === 1;
      const previous = attempts[attempts.length - 1] ?? null;

      try {
        plan = await deps.planner.plan({ question, schema, nowUtc, previous });
      } catch (error) {
        if (error instanceof PlannerError) {
          // A refusal or an outage is not something a retry fixes; an
          // unparseable answer might be.
          if (error.code !== "unparseable" || retried) {
            result = {
              kind: "cannot_answer",
              reason: plannerFailureReason(error),
              attempts,
              retried,
            };
            return await record(result);
          }
          attempts.push({ sql: "", error: error.message, ran: false });
          continue;
        }
        throw error;
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
      result = {
        kind: "cannot_answer",
        reason: "No plan could be produced for this question.",
        attempts,
        retried,
      };
      return await record(result);
    }

    if (plan.kind === "clarify") {
      result = {
        kind: "clarify",
        question: plan.question,
        interpretation: plan.interpretation,
      };
      return await record(result);
    }

    if (plan.kind === "cannot_answer") {
      result = { kind: "cannot_answer", reason: plan.reason, attempts, retried };
      return await record(result);
    }

    if (ran === null) {
      const last = attempts[attempts.length - 1];
      result = {
        kind: "cannot_answer",
        reason:
          last !== undefined && last.error.startsWith("The query took too long")
            ? last.error
            : retried
              ? "Two attempts at a query for this question could not be run. What was tried is below."
              : "The query for this question could not be run. What was tried is below.",
        attempts,
        retried,
      };
      return await record(result);
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
      result = {
        kind: "no_data",
        reason: noData,
        explanation: explainNoData(noData, plan.timeRange, provenance),
        sql: plan.sql,
        interpretation: plan.interpretation,
        table,
        provenance,
        durationMs: Date.now() - started,
        retried,
      };
      return await record(result);
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
      });
    } catch (error) {
      // The rows are on screen either way. A failed summary is said, not hidden.
      logUnexpected("bas.analyze.summarise_failed", error, { employeeId: viewer.id });
      answer =
        "The rows below were retrieved, but no summary could be written for them. Read the table directly.";
    }

    result = {
      kind: "answered",
      answer,
      interpretation: plan.interpretation,
      sql: plan.sql,
      table,
      provenance,
      durationMs: Date.now() - started,
      retried,
    };
    return await record(result);
  } catch (error) {
    if (error instanceof QueryFailure) {
      // A provenance query failed: the role cannot read something it should.
      // This is a configuration fault, not the question's.
      result = {
        kind: "cannot_answer",
        reason:
          "The platform could not read the tables it needs to check this answer. " +
          "Contact IT. (" + error.message + ")",
        attempts:
          sqlForRecord === null ? [] : [{ sql: sqlForRecord, error: error.message, ran: true }],
        retried: false,
      };
      return await record(result);
    }
    throw error;
  }

  /**
   * 10. One log line and one audit row per question, whatever the outcome.
   *
   * The log carries the question and the SQL - docs/BAS-B5.md: "That log is
   * how you learn what people actually ask, and the only way to audit a wrong
   * answer after the fact." The audit row is the durable copy: container logs
   * age out, audit_events does not, and /admin/audit already filters by
   * action. The row is the ONLY place a question survives once the container
   * restarts.
   */
  async function record(outcome: AnalyzeResult): Promise<AnalyzeResult> {
    const durationMs = Date.now() - started;
    const sql =
      "sql" in outcome ? outcome.sql : sqlForRecord ?? lastAttemptSql(outcome);
    const rowCount =
      "table" in outcome ? outcome.table.rowCount : rowCountForRecord;
    // Whether ANY SQL reached the database - the first thing a reader of a
    // wrong answer needs to know, and the one the `sql` field alone cannot
    // say, since it is also recorded for an attempt the guard refused.
    const queried = databaseQueried(outcome);

    logger.info("bas.analyze.question", {
      employeeId: viewer.id,
      moduleKey: BAS_MODULE_KEY,
      outcome: outcome.kind,
      durationMs,
      count: rowCount ?? undefined,
      question,
      sql: sql ?? undefined,
      queried,
    });

    try {
      await writeAuditEvent(prisma, {
        action: "bas.question_asked",
        actorEmployeeId: viewer.id,
        moduleKey: BAS_MODULE_KEY,
        metadata: {
          question,
          outcome: outcome.kind,
          sql,
          queried,
          rowCount,
          durationMs,
          retried: "retried" in outcome ? outcome.retried : false,
          gapHours:
            "provenance" in outcome ? outcome.provenance.gaps?.totalHours ?? null : null,
          unknownHorizonPoints:
            "provenance" in outcome ? outcome.provenance.unknownHorizon.count : null,
        },
      });
    } catch (error) {
      // The answer still goes back; a lost audit row is logged, not fatal.
      logUnexpected("bas.analyze.audit_failed", error, { employeeId: viewer.id });
    }

    return outcome;
  }
}

function lastAttemptSql(outcome: AnalyzeResult): string | null {
  if (outcome.kind !== "cannot_answer") return null;
  const last = outcome.attempts[outcome.attempts.length - 1];
  return last === undefined || last.sql.length === 0 ? null : last.sql;
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
  const lead =
    reason === "no_rows"
      ? "The query returned no rows. That is not an answer of zero: no data matched."
      : "The query returned a row with nothing in it - an aggregate over no readings. That is not an answer of zero: no data matched.";

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
            (coverage.neverCollected.length > 5
              ? ` and ${coverage.neverCollected.length - 5} more.`
              : "."),
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
    notes.push(
      `Not currently collected: ${uncollected.slice(0, 5).map((p) => p.name).join(", ")}.`,
    );
  }

  if (provenance.unclassifiedExcluded > 0) {
    notes.push(
      `${provenance.unclassifiedExcluded} points have no role and were outside a search by what a point measures.`,
    );
  }

  return notes.length === 0 ? lead : `${lead} ${notes.join(" ")}`;
}

function plannerFailureReason(error: PlannerError): string {
  switch (error.code) {
    case "refused":
      return "The model declined to write a query for this question.";
    case "unparseable":
      return "The model did not produce a usable plan, twice.";
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
