import { prisma } from "@/lib/db";
import type { Narrator } from "./engine/narrative";
import { ReportRunError, executeQueuedRun } from "./engine/run";
import { drainPdfQueue, type PdfOutcome } from "./pdf/jobs";
import type { PdfRenderer } from "./pdf/render";
import { MAX_ATTEMPTS, STALE_AFTER_MS, STALLED_TWICE_ERROR, failExhaustedStaleRuns } from "./queue-guards";

/**
 * The report worker (Reports, Phase 3): claims the oldest queued run, holds
 * it with a heartbeat, executes the Phase 2 engine on it, and goes back for
 * the next one until the queue is empty. Since Phase 4 (2026-11-13) it then
 * prints every queued PDF - the run it just finished, and any Retry PDF
 * waiting - with headless Chromium (pdf/render.ts).
 *
 * `scripts/bas-reports-worker.ts` is the entry point, under tsx - the same
 * loader `bas:report:run` uses, which is why the template's JSX pragma and
 * tests/bas-reports-worker-render.test.ts matter to this file: the engine
 * is reached through `executeQueuedRun` and nothing else, so what that test
 * proves about the render holds here. In Azure a Container Apps Job runs
 * the script per execution (infra/main.bicep, basReportsWorkerJob), started
 * by a KEDA scaler that counts queued runs, stalled ones and queued PDFs.
 *
 * CLAIMING. One UPDATE with FOR UPDATE SKIP LOCKED, the cip-worker pattern:
 * two workers never take the same run, and a row another worker is holding
 * is skipped rather than waited for. A stalled run - `running` with no
 * heartbeat for STALE_AFTER_MS - is claimable ONCE more (attempts < 2); a
 * run that stalls a second time is failed by `failExhaustedStaleRuns`
 * (queue-guards.ts, shared with the scheduler), with an error that says so,
 * before any claim is made. The scaler's query and the claim's WHERE agree
 * on what counts as work.
 *
 * THE PDF NEVER FAILS THE RUN. The engine stores the run and queues its
 * render in the same transaction; the render is a separate claim on the
 * PDF columns (pdf/jobs.ts) whose failure is recorded on those columns and
 * nowhere else. A worker with no renderer (--no-pdf) leaves renders queued
 * for one that has.
 *
 * DRAINING. An execution works until the queue is empty or DRAIN_WINDOW_MS
 * has passed since it started, then exits and lets the scaler start a fresh
 * one for whatever is left. The window plus the most minutes the module's
 * safety ceiling may hold (MAX_CEILING_MINUTES, ceiling.ts) stays under the
 * job's replicaTimeout.
 */

export { MAX_ATTEMPTS, STALE_AFTER_MS, STALLED_TWICE_ERROR, failExhaustedStaleRuns };

export const HEARTBEAT_EVERY_MS = 30_000;
/** How long one execution keeps claiming new runs before it exits. */
export const DRAIN_WINDOW_MS = 4 * 60 * 1000;

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
  /** Null means no Chromium (--no-pdf, or a test): queued PDFs stay queued. */
  pdf: PdfRenderer | null;
  /** Tests shorten it. */
  heartbeatMs?: number;
  /** The clock the time cap reads. Tests move it. */
  clock?: () => number;
}

export interface Drained {
  runs: Claim[];
  pdfs: PdfOutcome[];
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
 * One run: fail the exhausted stalls, claim the next, heartbeat while the
 * engine works, and return what was claimed (null when nothing was). A run
 * the engine fails is stored as failed by the engine itself and is not
 * rethrown; anything else - the database gone, say - propagates, and the
 * run's heartbeat stops with it, which is what the next worker reclaims on.
 * The run's PDF is queued by the engine and printed by `drainQueue`, not here.
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
 * Work until the queue is empty or the window closes, printing queued PDFs
 * after every run and once more at the end (a Retry PDF with no run to
 * follow), and say what was done. `maxRuns` is for `--once`.
 */
export async function drainQueue(
  options: WorkerOptions,
  limits: { windowMs?: number; maxRuns?: number } = {},
): Promise<Drained> {
  const started = Date.now();
  const windowMs = limits.windowMs ?? DRAIN_WINDOW_MS;
  const deadlineMs = started + windowMs;
  const runs: Claim[] = [];
  const pdfs: PdfOutcome[] = [];
  for (;;) {
    if (limits.maxRuns !== undefined && runs.length >= limits.maxRuns) break;
    if (runs.length > 0 && Date.now() > deadlineMs) break;
    const claim = await workOnce(options);
    if (claim === null) break;
    runs.push(claim);
    pdfs.push(...(await drainPdfQueue(options.pdf, { deadlineMs })));
  }
  // What was queued by a retry, or by a run from another worker, while this
  // one had no run of its own. The first pass has no deadline: a worker that
  // started only for a retry must get to it.
  pdfs.push(...(await drainPdfQueue(options.pdf, runs.length === 0 ? {} : { deadlineMs })));
  return { runs, pdfs };
}
