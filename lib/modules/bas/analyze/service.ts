import type { Pool } from "pg";
import type { Viewer } from "@/lib/authz";
import { writeAuditEvent } from "@/lib/audit";
import { databaseQueried, type PriorTurn } from "./types";
import { prisma } from "@/lib/db";
import { logger, logUnexpected } from "@/lib/logger";
import { BAS_MODULE_KEY } from "../constants";
import { basSiteScope } from "../service";
import { readAnalyzeEnv, type EnvLike } from "./env";
import { DEFAULT_RUN_OPTIONS, getAnalyzePool, type RunOptions } from "./pool";
import { QuestionRateLimiter, questionRateLimiter } from "./rate-limit";
import { detectNoData, explainNoData, planAndAnswer, type Planner } from "./core";
import type { AnalyzeResult } from "./types";

// Steps 4-9 live in core.ts since Reports Phase 6, so the report worker can
// run them without this file's environment read. Re-exported here so every
// existing importer keeps its path.
export { detectNoData, explainNoData, type Planner };

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
  /**
   * Today's earlier turns, for a follow-up. The route has capped and
   * validated them; the service passes them to the planner as data and
   * otherwise never reads a field of them except to name the source of a
   * from-memory answer. Absent for a first question, which then runs
   * exactly as before this parameter existed.
   */
  priorTurns: PriorTurn[] = [],
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

  const core = await planAndAnswer(
    { question, priorTurns, nowUtc, started },
    {
      planner: deps.planner,
      pool,
      run,
      schemaKey: env.values.askDatabaseUrl,
      onSummariseFailed: (error) => logUnexpected("bas.analyze.summarise_failed", error, { employeeId: viewer.id }),
    },
  );
  const sqlForRecord = core.sqlForRecord;
  const rowCountForRecord = core.rowCountForRecord;
  return record(core.result);

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
      reason:
        outcome.kind === "from_prior"
          ? `from_prior source="${outcome.source.question}" priorTurns=${priorTurns.length}`
          : priorTurns.length > 0
            ? `priorTurns=${priorTurns.length}`
            : undefined,
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
          /** How many earlier turns the browser sent, and for a from-memory answer, which one it read from. */
          priorTurns: priorTurns.length,
          sourceQuestion: outcome.kind === "from_prior" ? outcome.source.question : null,
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
