import { prisma } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { BAS_MODULE_KEY } from "../constants";
import type { Narrator } from "./engine/narrative";
import { ReportRunError, executeQueuedRun } from "./engine/run";

/**
 * The report worker (Reports, Phase 3): claims the oldest queued run, holds
 * it with a heartbeat, executes the Phase 2 engine on it, and goes back for
 * the next one until the queue is empty.
 *
 * `scripts/bas-reports-worker.ts` is the entry point, under tsx - the same
 * loader `bas:report:run` uses, which is why the template's JSX pragma and
 * tests/bas-reports-worker-render.test.ts matter to this file: the engine
 * is reached through `executeQueuedRun` and nothing else, so what that test
 * proves about the render holds here. In Azure a Container Apps Job runs
 * the script per execution (infra/main.bicep, basReportsWorkerJob), started
 * by a KEDA scaler that counts queued runs and stalled ones.
 *
 * CLAIMING. One UPDATE with FOR UPDATE SKIP LOCKED, the cip-worker pattern:
 * two workers never take the same run, and a row another worker is holding
 * is skipped rather than waited for. A stalled run - `running` with no
 * heartbeat for STALE_AFTER_MS - is claimable ONCE more (attempts < 2); a
 * run that stalls a second time is failed by `failExhaustedStaleRuns`, with
 * an error that says so, before any claim is made. The scaler's query and
 * the claim's WHERE agree on what counts as work.
 *
 * DRAINING. An execution works until the queue is empty or DRAIN_WINDOW_MS
 * has passed since it started, then exits and lets the scaler start a fresh
 * one for whatever is left. The window plus the most minutes the module's
 * safety ceiling may hold (MAX_CEILING_MINUTES, ceiling.ts) stays under the
 * job's replicaTimeout.
 */

/** A `running` run with no heartbeat for this long is a worker that died. */
export const STALE_AFTER_MS = 10 * 60 * 1000;
export const HEARTBEAT_EVERY_MS = 30_000;
/** Claims a run may take: the first, and one reclaim after a stall. */
export const MAX_ATTEMPTS = 2;
/** How long one execution keeps claiming new runs before it exits. */
export const DRAIN_WINDOW_MS = 4 * 60 * 1000;

export const STALLED_TWICE_ERROR =
  "The worker stopped twice while running this report. Run it again from Scheduled; if it stops again, see the runbook entry \"Reports: a run is stuck or failed\".";

export interface Claim {
  runId: bigint;
  reportId: bigint;
  /** 1 on a first claim, 2 when a stalled run was reclaimed. */
  attempts: number;
  reclaimed: boolean;
}

export interface WorkerOptions {
  /** Null means no model key: every run finishes partial and says so. */
  narrator: Narrator | null;
  /** Tests shorten it. */
  heartbeatMs?: number;
  /** The clock the time cap reads. Tests move it. */
  clock?: () => number;
}

/**
 * Take the oldest run that needs a worker, or null. Queued runs and stalled
 * running ones with a reclaim left, oldest first; SKIP LOCKED, so a second
 * worker in the same instant takes the next one. `started_at` restarts on a
 * reclaim: the duration shown is this attempt's, not the stall's.
 */
export async function claimNextRun(now = new Date()): Promise<Claim | null> {
  const staleBefore = new Date(now.getTime() - STALE_AFTER_MS);
  const rows = await prisma.$queryRaw<{ run_id: bigint; report_id: bigint; attempts: number }[]>`
    UPDATE bas_report_runs
       SET status = 'running', started_at = ${now}, heartbeat_at = ${now}, attempts = attempts + 1
     WHERE run_id = (
       SELECT run_id FROM bas_report_runs
        WHERE status = 'queued'
           OR (status = 'running' AND heartbeat_at < ${staleBefore} AND attempts < ${MAX_ATTEMPTS})
        ORDER BY created_at, run_id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
    RETURNING run_id, report_id, attempts`;
  const row = rows[0];
  if (row === undefined) return null;
  const attempts = Number(row.attempts);
  return { runId: row.run_id, reportId: row.report_id, attempts, reclaimed: attempts > 1 };
}

/**
 * Fail every running run that has stalled with no reclaim left. Each is
 * one audit row; the error on the run says what happened and what to do.
 * Returns how many were failed.
 */
export async function failExhaustedStaleRuns(now = new Date()): Promise<number> {
  const staleBefore = new Date(now.getTime() - STALE_AFTER_MS);
  const stale = await prisma.basReportRun.findMany({
    where: { status: "running", heartbeatAt: { lt: staleBefore }, attempts: { gte: MAX_ATTEMPTS } },
    select: { runId: true, reportId: true, attempts: true, heartbeatAt: true, report: { select: { name: true } } },
    orderBy: { runId: "asc" },
  });
  let failed = 0;
  for (const run of stale) {
    await prisma.$transaction(async (tx) => {
      // Re-checked inside the transaction: a worker may have heartbeat since.
      const updated = await tx.basReportRun.updateMany({
        where: { runId: run.runId, status: "running", heartbeatAt: { lt: staleBefore } },
        data: { status: "failed", error: STALLED_TWICE_ERROR, finishedAt: now },
      });
      if (updated.count === 0) return;
      failed += 1;
      await writeAuditEvent(tx, {
        action: "bas.report_run_finished",
        actorEmployeeId: null,
        moduleKey: BAS_MODULE_KEY,
        metadata: {
          reportId: run.reportId.toString(),
          runId: run.runId.toString(),
          name: run.report.name,
          status: "failed",
          error: STALLED_TWICE_ERROR,
          attempts: run.attempts,
          lastHeartbeatAt: run.heartbeatAt?.toISOString() ?? null,
        },
      });
    });
    logger.error("bas.report_run_stalled", {
      outcome: "failed",
      reason: `run ${run.runId} of report ${run.reportId} stalled ${run.attempts} times; failed`,
    });
  }
  return failed;
}

/**
 * One run: fail the exhausted stalls, claim the next, heartbeat while the
 * engine works, and return what was claimed (null when nothing was). A run
 * the engine fails is stored as failed by the engine itself and is not
 * rethrown; anything else - the database gone, say - propagates, and the
 * run's heartbeat stops with it, which is what the next worker reclaims on.
 */
export async function workOnce(options: WorkerOptions, now = new Date()): Promise<Claim | null> {
  await failExhaustedStaleRuns(now);
  const claim = await claimNextRun(now);
  if (claim === null) return null;

  const heartbeat = setInterval(() => {
    prisma.basReportRun
      .updateMany({ where: { runId: claim.runId, status: "running" }, data: { heartbeatAt: new Date() } })
      .catch(() => undefined);
  }, options.heartbeatMs ?? HEARTBEAT_EVERY_MS);
  try {
    await executeQueuedRun(claim.runId, { narrator: options.narrator, attempt: claim.attempts, clock: options.clock });
  } catch (error) {
    if (!(error instanceof ReportRunError && error.code === "run_failed")) throw error;
  } finally {
    clearInterval(heartbeat);
  }
  return claim;
}

/**
 * Work until the queue is empty or the window closes, and say what was done.
 * `maxRuns` is for `--once`.
 */
export async function drainQueue(
  options: WorkerOptions,
  limits: { windowMs?: number; maxRuns?: number } = {},
): Promise<Claim[]> {
  const started = Date.now();
  const windowMs = limits.windowMs ?? DRAIN_WINDOW_MS;
  const done: Claim[] = [];
  for (;;) {
    if (limits.maxRuns !== undefined && done.length >= limits.maxRuns) break;
    if (done.length > 0 && Date.now() - started > windowMs) break;
    const claim = await workOnce(options);
    if (claim === null) break;
    done.push(claim);
  }
  return done;
}
