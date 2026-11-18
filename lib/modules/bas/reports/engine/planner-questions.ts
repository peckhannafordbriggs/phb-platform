import type { Pool } from "pg";
import { planAndAnswer, type CoreResult, type Planner } from "../../analyze/core";
import { ANALYZE_MODEL, createAnthropicPlanner, type PlannerCallUsage } from "../../analyze/planner";
import { DEFAULT_RUN_OPTIONS, getAnalyzePool, type RunOptions } from "../../analyze/pool";
import type { Cell, ReportContext } from "../../analyze/types";
import { costOf, type Usage } from "./pricing";
import type { PlannerAnswer, PlannerOutcome, PlannerProvenance } from "./types";

/**
 * Planner questions in batch (Reports, Phase 6): a report's typed, personal
 * and shared planner-kind questions, each answered by the Analyze planner
 * with the report's building, stations and period as fixed context.
 *
 * THE SAME PATH AS THE ANALYZE TAB. `planAndAnswer` (analyze/core.ts) is
 * steps 4-9 of an Analyze question, shared with the tab: the model writes
 * one SELECT, sql-guard.ts refuses anything else, it runs on the
 * `bas_analyze` role inside a READ ONLY transaction with the tab's timeout
 * and row cap, the platform computes the provenance, and zero rows or all
 * NULL is `no_data` with the platform's explanation - the summariser is
 * never asked about nothing. That role cannot read a bas_report_* table
 * (ANALYZE_WITHHELD in analyze/role.ts), so a question cannot read the
 * report it is part of, or any other.
 *
 * WHAT IS DIFFERENT. No rate limit (the run is one action, and the
 * module's safety ceiling bounds it); no `bas.question_asked` row (the run
 * stores the question, the SQL and the outcome in report_json, and its own
 * audit rows say the run happened); and the outcome is CHECKED against the
 * context after it runs - a point on another building, a period other
 * than the report's - and the check is printed beside the answer, because
 * the prompt asks and the platform verifies.
 *
 * Per-site scoping: Analyze refuses outright the day `basSiteScope`
 * returns a list, because free SQL cannot be confined to a subset of
 * buildings. The same is true here, and the same refusal belongs in
 * run.ts on the report owner's scope the day that function changes; today
 * it returns null for everyone and the report's own visibility is the
 * whole check.
 *
 * COST. Every model call the planner makes - one or two plans, one summary
 * - is metered from the API's usage through `onUsage` and priced with the
 * engine's table (pricing.ts), so the run's tokens and dollars include the
 * planner's exactly as they include the narrative's.
 */

/**
 * The per-question estimate before any history exists: a plan call with the
 * schema block (most of the prompt) and one summary, on claude-opus-5.
 * Measured on the office's dev run of 2026-11-16 (run 18): $0.2313 for a
 * question whose plan wrote a correlated occupancy subquery (26,032 tokens
 * in, 2,945 out), $0.0631 for a per-day count - $0.147 a question on
 * average. Set above the dearer of the two, so the first run of a fresh
 * database errs towards stopping early rather than late; the history
 * replaces it from the second run on.
 */
export const PLANNER_START_ESTIMATE_USD = 0.25;
/** How many recent runs with planner questions the estimate averages over. */
export const PLANNER_HISTORY_RUNS = 20;
/** Rows of a planner answer kept on the document, for the page and the PDF. */
export const PLANNER_ROWS_KEPT = 50;
/** Point names kept in a planner answer's provenance. */
export const PLANNER_POINTS_KEPT = 30;
/** How far a declared period may sit from the report's before the page says so. */
const PERIOD_TOLERANCE_MS = 60 * 60_000;

export interface PlannerCallResult {
  result: CoreResult;
  usage: Usage;
  costUsd: number;
  calls: number;
  durationMs: number;
}

/** What the engine asks a planner question through. Null on a run means none is configured. */
export interface ReportPlanner {
  model: string;
  answer(question: string, context: ReportContext): Promise<PlannerCallResult>;
}

/** Collects the usage of every model call between two drains. */
export interface PlannerMeter {
  record(usage: PlannerCallUsage): void;
  drain(): { usage: Usage; costUsd: number; calls: number };
}

export function createPlannerMeter(): PlannerMeter {
  let usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let costUsd = 0;
  let calls = 0;
  return {
    record(u) {
      const one: Usage = {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheWriteTokens: u.cacheWriteTokens,
      };
      costUsd += costOf(u.model, one);
      calls += 1;
      usage = {
        inputTokens: usage.inputTokens + one.inputTokens,
        outputTokens: usage.outputTokens + one.outputTokens,
        cacheReadTokens: usage.cacheReadTokens + one.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens + one.cacheWriteTokens,
      };
    },
    drain() {
      const out = { usage, costUsd, calls };
      usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      costUsd = 0;
      calls = 0;
      return out;
    },
  };
}

/**
 * A report planner over any `Planner` - the Anthropic one, or a test's
 * scripted one that records its usage on the meter as the real one does.
 */
export function createReportPlanner(options: {
  planner: Planner;
  pool: Pool;
  schemaKey: string;
  meter: PlannerMeter;
  model: string;
  run?: RunOptions;
  now?: () => Date;
}): ReportPlanner {
  const { planner, pool, schemaKey, meter } = options;
  return {
    model: options.model,
    async answer(question, context) {
      const started = Date.now();
      meter.drain();
      const outcome = await planAndAnswer(
        { question, priorTurns: [], nowUtc: (options.now ?? (() => new Date()))().toISOString(), started, reportContext: context },
        { planner, pool, run: options.run ?? DEFAULT_RUN_OPTIONS, schemaKey },
      );
      const spent = meter.drain();
      return { result: outcome.result, usage: spent.usage, costUsd: spent.costUsd, calls: spent.calls, durationMs: Date.now() - started };
    },
  };
}

/** The production one: claude-opus-5 through the BAS key, SQL through the bas_analyze URL. */
export function createAnthropicReportPlanner(options: { apiKey: string; askDatabaseUrl: string }): ReportPlanner {
  const meter = createPlannerMeter();
  return createReportPlanner({
    planner: createAnthropicPlanner(options.apiKey, { onUsage: (u) => meter.record(u) }),
    pool: getAnalyzePool(options.askDatabaseUrl),
    schemaKey: options.askDatabaseUrl,
    meter,
    model: ANALYZE_MODEL,
  });
}

/**
 * The per-question estimate: the average cost of a planner question over
 * the recent history plus what this run has spent so far, or the starting
 * figure when neither has asked anything yet. An average, so one long
 * answer does not stop the next report early; the ceiling's check is made
 * before every question with the latest figure, and the metered cost
 * replaces the estimate the moment a question returns.
 */
export function plannerEstimate(
  history: { askedQuestions: number; costUsd: number },
  thisRun: { askedQuestions: number; costUsd: number },
): { perQuestionUsd: number; source: "history" | "start" } {
  const asked = history.askedQuestions + thisRun.askedQuestions;
  if (asked === 0) return { perQuestionUsd: PLANNER_START_ESTIMATE_USD, source: "start" };
  return { perQuestionUsd: (history.costUsd + thisRun.costUsd) / asked, source: "history" };
}

export interface PlannerQuestionMeta {
  position: number;
  text: string;
  source: PlannerAnswer["source"];
  libraryKey: string | null;
  sectionLabel: string | null;
}

/** A planner answer that never reached the planner: skipped, not monitored, not applicable, not configured. */
export function plannerNotAsked(meta: PlannerQuestionMeta, outcome: Exclude<PlannerOutcome, "answered" | "no_data" | "cannot_answer" | "clarify">, reason: string): PlannerAnswer {
  return {
    ...meta,
    outcome,
    answer: null,
    reason,
    interpretation: null,
    sql: null,
    table: null,
    provenance: null,
    notes: [],
    retried: false,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    durationMs: 0,
  };
}

const keptRows = (rows: Cell[][]) => rows.slice(0, PLANNER_ROWS_KEPT);

/** The planner's outcome as the report stores it, with the platform's checks against the context. */
export function toPlannerAnswer(meta: PlannerQuestionMeta, call: PlannerCallResult, context: ReportContext): PlannerAnswer {
  const r = call.result;
  const base = {
    ...meta,
    costUsd: call.costUsd,
    inputTokens: call.usage.inputTokens + call.usage.cacheReadTokens + call.usage.cacheWriteTokens,
    outputTokens: call.usage.outputTokens,
    calls: call.calls,
    durationMs: call.durationMs,
  };
  switch (r.kind) {
    case "answered":
    case "no_data": {
      const provenance: PlannerProvenance = {
        timeRange: r.provenance.timeRange,
        periodUndeclared: r.provenance.periodUndeclared,
        points: r.provenance.points.slice(0, PLANNER_POINTS_KEPT).map((p) => p.name),
        pointCount: r.provenance.points.length,
        gapHours: r.provenance.gaps === null ? null : r.provenance.gaps.totalHours,
        coverageShortfall: r.provenance.coverageShortfall,
        unknownHorizonCount: r.provenance.unknownHorizon.count,
        unclassifiedExcluded: r.provenance.unclassifiedExcluded,
        neverCollected: r.provenance.coverage?.neverCollected ?? [],
      };
      return {
        ...base,
        outcome: r.kind,
        answer: r.kind === "answered" ? r.answer : null,
        reason: r.kind === "no_data" ? r.explanation : null,
        interpretation: r.interpretation,
        sql: r.sql,
        table: { columns: r.table.columns, rows: keptRows(r.table.rows), rowCount: r.table.rowCount, truncated: r.table.truncated, kept: Math.min(r.table.rows.length, PLANNER_ROWS_KEPT) },
        provenance,
        notes: contextNotes(r.provenance.points, r.provenance.timeRange, context),
        retried: r.retried,
      };
    }
    case "clarify":
      return {
        ...base,
        outcome: "clarify",
        answer: null,
        reason: `The planner asked: "${r.question}" Nobody can answer that in a scheduled report; reword the question on the report to say which is meant.`,
        interpretation: r.interpretation,
        sql: null,
        table: null,
        provenance: null,
        notes: [],
        retried: false,
      };
    case "cannot_answer": {
      const last = r.attempts[r.attempts.length - 1];
      return {
        ...base,
        outcome: "cannot_answer",
        answer: null,
        reason: last !== undefined && last.error.length > 0 && !r.reason.includes(last.error) ? `${r.reason} (${last.error})` : r.reason,
        interpretation: null,
        sql: last === undefined || last.sql.length === 0 ? null : last.sql,
        table: null,
        provenance: null,
        notes: [],
        retried: r.retried,
      };
    }
    case "from_prior":
      // A batch question carries no earlier turns, so the core refuses any
      // from-memory plan before it gets here; kept total for the type.
      return {
        ...base,
        outcome: "cannot_answer",
        answer: null,
        reason: "The planner answered from an earlier question, and a report question has none.",
        interpretation: r.interpretation,
        sql: null,
        table: null,
        provenance: null,
        notes: [],
        retried: r.retried,
      };
  }
}

/**
 * The platform's checks of an answer against the report's fixed context.
 * The prompt tells the planner the building and the period; this says
 * whether it kept to them, from the provenance the platform computed.
 */
export function contextNotes(
  points: ReadonlyArray<{ name: string; site: string }>,
  timeRange: { start: string; end: string } | null,
  context: ReportContext,
): string[] {
  const notes: string[] = [];
  const elsewhere = points.filter((p) => p.site !== context.siteName);
  if (elsewhere.length > 0) {
    const sites = [...new Set(elsewhere.map((p) => p.site))];
    notes.push(
      `This answer read ${elsewhere.length} point${elsewhere.length === 1 ? "" : "s"} on ${sites.join(", ")}, not on ${context.siteName}: ${elsewhere
        .slice(0, 5)
        .map((p) => p.name)
        .join(", ")}${elsewhere.length > 5 ? ` and ${elsewhere.length - 5} more` : ""}.`,
    );
  }
  if (timeRange !== null) {
    const start = Date.parse(timeRange.start);
    const end = Date.parse(timeRange.end);
    const wantStart = Date.parse(context.periodStart);
    const wantEnd = Date.parse(context.periodEnd);
    if (Number.isFinite(start) && Number.isFinite(end) && (Math.abs(start - wantStart) > PERIOD_TOLERANCE_MS || Math.abs(end - wantEnd) > PERIOD_TOLERANCE_MS)) {
      const f = new Intl.DateTimeFormat("en-GB", { timeZone: context.timezone, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
      notes.push(`The query covered ${f.format(new Date(start))} to ${f.format(new Date(end))}, not the report's period.`);
    }
  }
  return notes;
}
