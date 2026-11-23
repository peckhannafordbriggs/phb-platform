import type { Prisma } from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { DELIVERY_IN_PROGRESS_PREFIX } from "./deliveries";
import {
  DELIVERY_DELETED_SENTENCE,
  PDF_DELETED_SENTENCE,
  RECYCLE_MS,
  isRunRetentionMonths,
  monthsBefore,
  type RunRetentionMonths,
} from "./deletion-words";

/**
 * Deleting report runs (2026-11-20): the database half, shared by the web
 * app's Delete and Restore (runs-service.ts) and the scheduler job's
 * retention and purge step (scripts/bas-reports-scheduler.ts). No Graph, no
 * React, no lib/env.ts - the scheduler imports it.
 *
 * DELETE IS A MARK. A deleted run keeps its findings, page and PDF; it
 * leaves the Reports list, the comparison (a deleted run is never the
 * previous run), every action on a run (404 until restored), and the email.
 * RECYCLE_DAYS after `deleted_at` the scheduler purges it, and its findings
 * and deliveries go with it by ON DELETE CASCADE.
 *
 * ONLY A FINISHED RUN. A queued or running run is the worker's; a CHECK
 * holds it (bas_report_runs_deleted_only_finished).
 *
 * NOTHING LEFT WAITING. The worker job's scaler counts queued PDFs and due
 * deliveries (infra/main.bicep). A deleted run's queued PDF and its pending
 * deliveries are settled to failed in the same transaction as the delete,
 * with a sentence saying why and what to do after a restore - so the scaler
 * never counts work the worker would refuse, and no worker spins on it. A
 * delivery an attempt is holding (its lease sentence) is left to that
 * attempt: the worker checks the run immediately before it sends
 * (email/send.ts) and fails the row itself if the run is gone.
 *
 * NOT AUDITED. The run is the owner's own data; deleted_by and
 * deleted_by_employee_id are the record until the purge, and the purge is
 * a log line per pass.
 */

type Db = Prisma.TransactionClient | typeof prisma;

export const FINISHED_RUN_STATUSES = ["succeeded", "partial", "failed"] as const;

export type DeletedBy = { kind: "person"; employeeId: string } | { kind: "retention" };

/**
 * Settle the work a deleted run would otherwise leave waiting: a queued PDF
 * becomes failed, a pending delivery no attempt is holding becomes failed,
 * each with the sentence that says Restore, then Retry PDF or Resend.
 */
export async function settleDeletedRunWork(db: Db, runIds: readonly bigint[], now: Date): Promise<{ pdfs: number; deliveries: number }> {
  if (runIds.length === 0) return { pdfs: 0, deliveries: 0 };
  const pdfs = await db.basReportRun.updateMany({
    where: { runId: { in: [...runIds] }, deletedAt: { not: null }, pdfStatus: "queued" },
    data: { pdfStatus: "failed", pdfError: PDF_DELETED_SENTENCE, pdfQueuedAt: null },
  });
  const deliveries = await db.basReportDelivery.updateMany({
    where: {
      runId: { in: [...runIds] },
      status: "pending",
      // NULL-safe: NOT (last_error LIKE ...) is NULL for a row never tried,
      // and that row is exactly the one to settle.
      OR: [{ lastError: null }, { NOT: { lastError: { startsWith: DELIVERY_IN_PROGRESS_PREFIX } } }],
    },
    data: { status: "failed", lastError: DELIVERY_DELETED_SENTENCE, nextAttemptAt: now },
  });
  return { pdfs: pdfs.count, deliveries: deliveries.count };
}

/**
 * Move runs to Recently deleted inside the caller's transaction, and settle
 * their waiting work. Only runs that are finished and not already deleted
 * move; returns the ids that did.
 */
export async function markRunsDeleted(tx: Prisma.TransactionClient, runIds: readonly bigint[], by: DeletedBy, now: Date): Promise<bigint[]> {
  if (runIds.length === 0) return [];
  const moved = await tx.basReportRun.updateManyAndReturn({
    where: { runId: { in: [...runIds] }, deletedAt: null, status: { in: [...FINISHED_RUN_STATUSES] } },
    data: {
      deletedAt: now,
      deletedBy: by.kind,
      deletedByEmployeeId: by.kind === "person" ? by.employeeId : null,
    },
    select: { runId: true },
  });
  const ids = moved.map((r) => r.runId);
  await settleDeletedRunWork(tx, ids, now);
  return ids;
}

/** Bring runs back from Recently deleted. Returns the ids restored. */
export async function markRunsRestored(tx: Prisma.TransactionClient, runIds: readonly bigint[], now: Date): Promise<bigint[]> {
  if (runIds.length === 0) return [];
  const restored = await tx.basReportRun.updateManyAndReturn({
    where: { runId: { in: [...runIds] }, deletedAt: { not: null } },
    data: { deletedAt: null, deletedBy: null, deletedByEmployeeId: null, restoredAt: now },
    select: { runId: true },
  });
  return restored.map((r) => r.runId);
}

// ---------------------------------------------------------------------------
// The scheduler's step
// ---------------------------------------------------------------------------

export interface RetainedRun {
  runId: string;
  reportId: string;
  name: string;
  months: RunRetentionMonths;
  createdAt: string;
}

export interface PurgedRun {
  runId: string;
  reportId: string;
  deletedAt: string;
  deletedBy: string;
}

export interface RetentionPass {
  at: string;
  /** Runs this pass moved to Recently deleted because their report keeps runs for less. */
  retained: RetainedRun[];
  /** Runs removed for good: deleted RECYCLE_DAYS ago or more. */
  purged: PurgedRun[];
}

/**
 * Retention: for every report with "Keep generated runs for" set, move its
 * finished runs created before that many months ago to Recently deleted, as
 * a person's Delete would, with deleted_by = 'retention'. A run a person
 * restored is never taken again; a run already deleted is not touched; and
 * a deleted report's runs are not taken at all.
 */
export async function applyRunRetention(now = new Date()): Promise<RetainedRun[]> {
  // A deleted report's runs go only by their own Delete (2026-11-20), so
  // retention stops with the report.
  const defs = await prisma.basReportDefinition.findMany({
    where: { runRetentionMonths: { not: null }, deletedAt: null },
    select: { reportId: true, name: true, runRetentionMonths: true },
    orderBy: { reportId: "asc" },
  });
  const retained: RetainedRun[] = [];
  for (const def of defs) {
    const months = def.runRetentionMonths;
    if (!isRunRetentionMonths(months)) continue;
    const cutoff = monthsBefore(now, months);
    const moved = await prisma.$transaction(async (tx) => {
      const due = await tx.basReportRun.findMany({
        where: {
          reportId: def.reportId,
          deletedAt: null,
          restoredAt: null,
          status: { in: [...FINISHED_RUN_STATUSES] },
          createdAt: { lt: cutoff },
        },
        select: { runId: true, createdAt: true },
        orderBy: { runId: "asc" },
      });
      const ids = await markRunsDeleted(tx, due.map((r) => r.runId), { kind: "retention" }, now);
      const idSet = new Set(ids);
      return due.filter((r) => idSet.has(r.runId));
    });
    for (const r of moved) {
      retained.push({ runId: r.runId.toString(), reportId: def.reportId.toString(), name: def.name, months, createdAt: r.createdAt.toISOString() });
    }
  }
  return retained;
}

/**
 * The purge: every run deleted RECYCLE_DAYS ago or more is removed for good
 * in one statement - its findings and deliveries by cascade, its page and
 * PDF with the row. A run restored in the meantime has no deleted_at and is
 * not touched. Logged, never audited per run.
 */
export async function purgeDeletedRuns(now = new Date()): Promise<PurgedRun[]> {
  const cutoff = new Date(now.getTime() - RECYCLE_MS);
  const rows = await prisma.$queryRaw<Array<{ run_id: bigint; report_id: bigint; deleted_at: Date; deleted_by: string }>>`
    DELETE FROM bas_report_runs
     WHERE deleted_at IS NOT NULL AND deleted_at <= ${cutoff}
    RETURNING run_id, report_id, deleted_at, deleted_by`;
  return rows
    .map((r) => ({ runId: r.run_id.toString(), reportId: r.report_id.toString(), deletedAt: r.deleted_at.toISOString(), deletedBy: r.deleted_by }))
    .sort((a, b) => Number(BigInt(a.runId) - BigInt(b.runId)));
}

/** Retention first, then the purge, then one log line each. */
export async function runRetentionPass(now = new Date()): Promise<RetentionPass> {
  const retained = await applyRunRetention(now);
  const purged = await purgeDeletedRuns(now);
  logger.info("bas.report_runs_retention", {
    outcome: "ok",
    reason:
      retained.length === 0
        ? "no run older than its report keeps"
        : `${retained.length} run(s) moved to Recently deleted by retention: ${retained.map((r) => r.runId).join(", ")}`,
  });
  logger.info("bas.report_runs_purged", {
    outcome: "ok",
    reason:
      purged.length === 0
        ? "no deleted run due"
        : `${purged.length} run(s) purged with their findings, deliveries and PDF: ${purged.map((r) => `${r.runId} (${r.deletedBy}, deleted ${r.deletedAt})`).join(", ")}`,
  });
  return { at: now.toISOString(), retained, purged };
}
