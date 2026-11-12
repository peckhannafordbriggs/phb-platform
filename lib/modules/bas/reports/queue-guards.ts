import { prisma } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { BAS_MODULE_KEY } from "../constants";

/**
 * The rules that take abandoned work OUT of the queue (Reports, Phase 3 and
 * 4), in a module of their own because two jobs apply them: the worker
 * before it claims (the stall rule), and the scheduler on every pass (all
 * three). Imports no React, so the scheduler - which never renders a page -
 * can share them with the worker.
 *
 * WHY THE SCHEDULER APPLIES THEM (2026-11-13). The worker job's scaler
 * counts queued runs and stalled ones, and starts an execution for each. On
 * the night of 2026-11-12 a worker that crashed at startup was restarted by
 * the scaler every 45 seconds all night, against ONE queued run that it
 * never reached: the count never fell, so the restarts never stopped. The
 * worker cannot fix that - it is the thing that is broken - so the one job
 * that is still running takes the run out of the count, with an error that
 * says what happened and what to do:
 *
 *   - a run QUEUED for more than UNCLAIMED_AFTER_MS and never claimed
 *     (attempts = 0) is failed: the worker is not starting, or is failing
 *     before it can claim;
 *   - a run claimed and LOST TWICE (running, no heartbeat, attempts at
 *     MAX_ATTEMPTS) is failed, as the worker would have failed it;
 *   - a PDF render queued for more than UNCLAIMED_AFTER_MS and never claimed
 *     is failed on its own column; the run it belongs to is untouched.
 *
 * Each is one audit row where a run's outcome changed, and one log line.
 * The scaler's query (infra/main.bicep) counts exactly these states, so
 * after a pass that applies them its count is zero and the restarts stop.
 */

/** A `running` run with no heartbeat for this long is a worker that died. */
export const STALE_AFTER_MS = 10 * 60 * 1000;
/** Claims a run may take: the first, and one reclaim after a stall. */
export const MAX_ATTEMPTS = 2;
/** Queued work nobody has picked up for this long is abandoned. */
export const UNCLAIMED_AFTER_MS = 60 * 60 * 1000;

export const STALLED_TWICE_ERROR =
  "The worker stopped twice while running this report. Run it again from Scheduled; if it stops again, see the runbook entry \"Reports: a run is stuck or failed\".";

export function unclaimedRunError(queuedAt: Date, now: Date): string {
  const minutes = Math.round((now.getTime() - queuedAt.getTime()) / 60_000);
  return `Queued for ${minutes} minutes and never picked up by a worker: the worker job is not starting executions, or every execution fails before it can claim a run. Check the worker job's executions and their logs (runbook entry "Reports: a run is stuck or failed"), then Run now.`;
}

export function unclaimedPdfError(queuedAt: Date, now: Date): string {
  const minutes = Math.round((now.getTime() - queuedAt.getTime()) / 60_000);
  return `The PDF render was queued for ${minutes} minutes and never picked up by a worker; the report itself is stored. Check the worker job's executions (runbook entry "Reports: the PDF"), then Retry PDF.`;
}

/** One piece of work a guard failed. */
export interface AbandonedWork {
  runId: string;
  reportId: string;
  name: string;
  error: string;
}

export interface AbandonedWorkReport {
  unclaimedRuns: AbandonedWork[];
  stalledRuns: AbandonedWork[];
  unclaimedPdfs: AbandonedWork[];
}

async function auditFailed(
  tx: Parameters<typeof writeAuditEvent>[0],
  run: { runId: bigint; reportId: bigint; name: string; attempts: number },
  error: string,
  extra: Record<string, unknown>,
): Promise<void> {
  await writeAuditEvent(tx, {
    action: "bas.report_run_finished",
    actorEmployeeId: null,
    moduleKey: BAS_MODULE_KEY,
    metadata: {
      reportId: run.reportId.toString(),
      runId: run.runId.toString(),
      name: run.name,
      status: "failed",
      error,
      attempts: run.attempts,
      ...extra,
    },
  });
}

/**
 * Fail every running run that has stalled with no reclaim left. Each is
 * one audit row; the error on the run says what happened and what to do.
 */
export async function failExhaustedStaleRuns(now = new Date()): Promise<AbandonedWork[]> {
  const staleBefore = new Date(now.getTime() - STALE_AFTER_MS);
  const stale = await prisma.basReportRun.findMany({
    where: { status: "running", heartbeatAt: { lt: staleBefore }, attempts: { gte: MAX_ATTEMPTS } },
    select: { runId: true, reportId: true, attempts: true, heartbeatAt: true, report: { select: { name: true } } },
    orderBy: { runId: "asc" },
  });
  const failed: AbandonedWork[] = [];
  for (const run of stale) {
    await prisma.$transaction(async (tx) => {
      // Re-checked inside the transaction: a worker may have heartbeat since.
      const updated = await tx.basReportRun.updateMany({
        where: { runId: run.runId, status: "running", heartbeatAt: { lt: staleBefore } },
        data: { status: "failed", error: STALLED_TWICE_ERROR, finishedAt: now },
      });
      if (updated.count === 0) return;
      failed.push({ runId: run.runId.toString(), reportId: run.reportId.toString(), name: run.report.name, error: STALLED_TWICE_ERROR });
      await auditFailed(tx, { ...run, name: run.report.name }, STALLED_TWICE_ERROR, {
        lastHeartbeatAt: run.heartbeatAt?.toISOString() ?? null,
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
 * Fail every queued run that no worker has claimed in UNCLAIMED_AFTER_MS.
 * `attempts = 0` is "never claimed": a reclaimed run is `running`, and a
 * run the dev script executes is claimed by it in the same breath.
 */
export async function failUnclaimedRuns(now = new Date()): Promise<AbandonedWork[]> {
  const queuedBefore = new Date(now.getTime() - UNCLAIMED_AFTER_MS);
  const abandoned = await prisma.basReportRun.findMany({
    where: { status: "queued", attempts: 0, createdAt: { lt: queuedBefore } },
    select: { runId: true, reportId: true, attempts: true, createdAt: true, report: { select: { name: true } } },
    orderBy: { runId: "asc" },
  });
  const failed: AbandonedWork[] = [];
  for (const run of abandoned) {
    const error = unclaimedRunError(run.createdAt, now);
    await prisma.$transaction(async (tx) => {
      // Re-checked: a worker may have claimed it since the list was read.
      const updated = await tx.basReportRun.updateMany({
        where: { runId: run.runId, status: "queued", attempts: 0 },
        data: { status: "failed", error, finishedAt: now },
      });
      if (updated.count === 0) return;
      failed.push({ runId: run.runId.toString(), reportId: run.reportId.toString(), name: run.report.name, error });
      await auditFailed(tx, { ...run, name: run.report.name }, error, {
        queuedAt: run.createdAt.toISOString(),
        queuedMinutes: Math.round((now.getTime() - run.createdAt.getTime()) / 60_000),
      });
    });
    logger.error("bas.report_run_unclaimed", {
      outcome: "failed",
      reason: `run ${run.runId} of report ${run.reportId} queued since ${run.createdAt.toISOString()} and never claimed; failed`,
    });
  }
  return failed;
}

/**
 * Fail every PDF render queued for UNCLAIMED_AFTER_MS and never claimed.
 * The run is untouched - its page and findings are stored - so this is a
 * log line and the run's own PDF columns, not an audit row about the run.
 */
export async function failUnclaimedPdfs(now = new Date()): Promise<AbandonedWork[]> {
  const queuedBefore = new Date(now.getTime() - UNCLAIMED_AFTER_MS);
  const abandoned = await prisma.basReportRun.findMany({
    where: { pdfStatus: "queued", pdfQueuedAt: { lt: queuedBefore } },
    select: { runId: true, reportId: true, pdfQueuedAt: true, report: { select: { name: true } } },
    orderBy: { runId: "asc" },
  });
  const failed: AbandonedWork[] = [];
  for (const run of abandoned) {
    const error = unclaimedPdfError(run.pdfQueuedAt ?? queuedBefore, now);
    const updated = await prisma.basReportRun.updateMany({
      where: { runId: run.runId, pdfStatus: "queued" },
      data: { pdfStatus: "failed", pdfError: error, pdfQueuedAt: null },
    });
    if (updated.count === 0) continue;
    failed.push({ runId: run.runId.toString(), reportId: run.reportId.toString(), name: run.report.name, error });
    logger.error("bas.report_pdf_unclaimed", {
      outcome: "failed",
      reason: `PDF of run ${run.runId} (report ${run.reportId}) queued since ${run.pdfQueuedAt?.toISOString() ?? "?"} and never claimed; failed`,
    });
  }
  return failed;
}

/** All three, in the order the scheduler applies them. */
export async function failAbandonedWork(now = new Date()): Promise<AbandonedWorkReport> {
  return {
    unclaimedRuns: await failUnclaimedRuns(now),
    stalledRuns: await failExhaustedStaleRuns(now),
    unclaimedPdfs: await failUnclaimedPdfs(now),
  };
}
