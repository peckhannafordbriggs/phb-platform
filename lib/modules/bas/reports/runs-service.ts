import { hasModuleAdmin, type Viewer } from "@/lib/authz";
import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { BAS_MODULE_KEY } from "../constants";
import { BasError } from "../errors";
import { basSiteScope } from "../service";
import {
  countDeliveries,
  type DeliveryRowView,
  type DeliverySource,
  type DeliveryStatus,
  type DeliverySummary,
} from "./delivery-words";
import { daysRemaining, isRunRetentionMonths, purgeDueAt, type RunRetentionMonths } from "./deletion-words";
import type { ReportDocument, RunStatus } from "./engine/types";
import { pdfFileName, pdfStateKind, type PdfState } from "./pdf/naming";
import { isExternalAddress, normaliseEmail } from "./recipients";
import { FINISHED_RUN_STATUSES, markRunsDeleted, markRunsRestored } from "./run-deletion";

/**
 * Reading runs (Reports, Phase 2). The same visibility as a definition: its
 * owner, or a module admin; anyone else is told the run does not exist.
 * A run is written by the engine and the worker; the writes here are
 * Retry PDF (Phase 4), which queues a render on a run's own columns and
 * never touches the run, and - the email half of Phase 4, 2026-11-17 -
 * Resend and Send to me, which write delivery rows for the worker to send.
 * Nothing here sends: the web app never imports the sender
 * (email/mailer.ts), and the worker job is the only process that does.
 *
 * The PDF's bytes are read by `loadRunPdf` alone, by name. Every other read
 * of a run here is a `select` that leaves `pdf` out - a few hundred KB a
 * row, and the list reads up to 200 rows every ten seconds.
 * tests/bas-reports-pdf.test.ts holds every basReportRun read in lib/ and
 * app/ to a select, and the summaries to carrying no bytes.
 *
 * DELETED RUNS (2026-11-20). Delete moves runs to Recently deleted and
 * Restore brings them back (run-deletion.ts does the writes). A deleted run
 * is missing from the list and answers 404 to everything a run offers -
 * opening it, its PDF, Retry PDF, Resend, Send to me - until it is restored:
 * every read below that serves one adds `ON_LIST`. The visibility rule is
 * unchanged and shared with the Usage page, which keeps counting a deleted
 * run's spend until the purge: the money was spent.
 *
 * A DELETED REPORT (2026-11-20) changes nothing here: its runs keep their
 * visibility (the report's owner, or a module admin - the row is kept for
 * exactly that), open, download and email as before, and carry
 * `reportDeleted` so the screens can say no more will come.
 */

export interface RunSummary {
  runId: string;
  reportId: string;
  reportName: string;
  /** The report itself was deleted (2026-11-20): no more runs will come. The screens add "(schedule deleted)". */
  reportDeleted: boolean;
  buildingName: string;
  status: RunStatus;
  trigger: string;
  periodStart: string;
  periodEnd: string;
  timezone: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationS: number | null;
  costUsd: number;
  budgetUsd: number;
  inputTokens: number;
  outputTokens: number;
  partialReason: string | null;
  error: string | null;
  /** Findings new or still open; cleared rows are not counted. */
  findings: number;
  buildingStatus: string | null;
  startedBy: string | null;
  /** The PDF's state (Phase 4); the bytes travel only through the pdf route. */
  pdf: PdfState;
  /** The email (Phase 4, 2026-11-17): counts by state, and why there are none when there are none. */
  delivery: DeliverySummary;
}

export interface RunDetail extends RunSummary {
  document: ReportDocument | null;
  previousRunId: string | null;
  /** One row per address, owner first. */
  deliveries: DeliveryRowView[];
}

export interface RunsList {
  runs: RunSummary[];
  runsInDatabase: number;
}

/** A run in Recently deleted (2026-11-20). */
export interface DeletedRunSummary {
  runId: string;
  reportId: string;
  reportName: string;
  reportDeleted: boolean;
  buildingName: string;
  status: RunStatus;
  trigger: string;
  periodStart: string;
  periodEnd: string;
  timezone: string;
  finishedAt: string | null;
  deletedAt: string;
  deletedBy: "person" | "retention";
  /** The person who deleted it; null for retention, or a person whose row is gone. */
  deletedByEmail: string | null;
  /** The report's "Keep generated runs for", as it stands now. */
  retentionMonths: RunRetentionMonths | null;
  /** When the scheduler purges it, and the whole days until then (0 once due). */
  purgeAt: string;
  daysRemaining: number;
}

export interface DeletedRunsList {
  runs: DeletedRunSummary[];
  runsInDatabase: number;
}

/** A run that is on the list: not in Recently deleted. Every read that serves a run adds it. */
const ON_LIST = { deletedAt: null } as const;

function toStatus(value: string): RunStatus {
  return value === "queued" || value === "running" || value === "succeeded" || value === "partial" || value === "failed" ? value : "failed";
}

/** Every column a summary reads, by name, and never `pdf`. */
const RUN_SELECT = {
  runId: true,
  reportId: true,
  status: true,
  trigger: true,
  periodStart: true,
  periodEnd: true,
  timezone: true,
  startedAt: true,
  finishedAt: true,
  budgetUsd: true,
  costUsd: true,
  inputTokens: true,
  outputTokens: true,
  partialReason: true,
  error: true,
  reportJson: true,
  previousRunId: true,
  pdfStatus: true,
  pdfError: true,
  pdfBytes: true,
  pdfQueuedAt: true,
  pdfRenderedAt: true,
  report: { select: { name: true, ownerEmployeeId: true, siteId: true, deletedAt: true, site: { select: { name: true } } } },
  startedBy: { select: { email: true } },
  _count: { select: { findings: { where: { state: { not: "cleared" } } } } },
  deliveries: {
    select: { deliveryId: true, email: true, source: true, status: true, attempts: true, lastError: true, sentAt: true, nextAttemptAt: true },
    // One key, not a list: RUN_SELECT is `as const`, and a readonly tuple is not an orderBy. Positions do not repeat within a run.
    orderBy: { position: "asc" },
  },
} as const;

type RunRow = Awaited<ReturnType<typeof prisma.basReportRun.findFirstOrThrow<{ select: typeof RUN_SELECT }>>>;

function pdfState(r: Pick<RunRow, "pdfStatus" | "pdfError" | "pdfBytes" | "pdfQueuedAt" | "pdfRenderedAt">): PdfState {
  const status = r.pdfStatus;
  return {
    status: status === "queued" || status === "ready" || status === "failed" ? status : "none",
    error: r.pdfError,
    bytes: r.pdfBytes,
    queuedAt: r.pdfQueuedAt?.toISOString() ?? null,
    renderedAt: r.pdfRenderedAt?.toISOString() ?? null,
  };
}

function toDeliveryStatus(value: string): DeliveryStatus {
  return value === "sent" || value === "failed" || value === "not_sent" ? value : "pending";
}

function deliverySummary(r: RunRow): DeliverySummary {
  const counts = countDeliveries(r.deliveries);
  let emptyReason: DeliverySummary["emptyReason"] = null;
  if (counts.total === 0) {
    if (r.status !== "succeeded" && r.status !== "partial") emptyReason = "not_finished";
    else if (r.pdfStatus === "queued") emptyReason = "waiting_for_pdf";
    else if (r.pdfStatus === "failed") emptyReason = "no_pdf";
    else emptyReason = "none";
  }
  return { ...counts, emptyReason };
}

function deliveryRows(r: RunRow): DeliveryRowView[] {
  return r.deliveries.map((d) => {
    const status = toDeliveryStatus(d.status);
    return {
      deliveryId: d.deliveryId.toString(),
      email: d.email,
      source: (d.source === "owner" || d.source === "requested" ? d.source : "recipient") as DeliverySource,
      status,
      attempts: d.attempts,
      lastError: d.lastError,
      sentAt: d.sentAt?.toISOString() ?? null,
      nextAttemptAt: status === "pending" ? d.nextAttemptAt.toISOString() : null,
      isExternal: isExternalAddress(d.email),
    };
  });
}

function toSummary(r: RunRow): RunSummary {
  const doc = r.reportJson as unknown as ReportDocument | null;
  return {
    runId: r.runId.toString(),
    reportId: r.reportId.toString(),
    reportName: r.report.name,
    reportDeleted: r.report.deletedAt !== null,
    buildingName: r.report.site.name,
    status: toStatus(r.status),
    trigger: r.trigger,
    periodStart: r.periodStart.toISOString(),
    periodEnd: r.periodEnd.toISOString(),
    timezone: r.timezone,
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    durationS:
      r.startedAt !== null && r.finishedAt !== null ? Math.round((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000) : null,
    costUsd: Number(r.costUsd),
    budgetUsd: Number(r.budgetUsd),
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    partialReason: r.partialReason,
    error: r.error,
    findings: r._count.findings,
    buildingStatus: doc?.summary?.status ?? null,
    startedBy: r.startedBy?.email ?? null,
    pdf: pdfState(r),
    delivery: deliverySummary(r),
  };
}

/** The runs the viewer may see: their own reports', or every report's for a module admin. Shared with the Usage page. */
export async function visibilityWhere(viewer: Viewer) {
  const admin = await hasModuleAdmin(viewer.id, BAS_MODULE_KEY);
  const { entitled } = await basSiteScope(viewer);
  return {
    report: {
      ...(admin ? {} : { ownerEmployeeId: viewer.id }),
      ...(entitled === null ? {} : { siteId: { in: entitled } }),
    },
  };
}

export async function listRuns(viewer: Viewer, reportIdText: string | null): Promise<RunsList> {
  const visible = await visibilityWhere(viewer);
  const reportId = reportIdText !== null && /^[0-9]{1,20}$/.test(reportIdText) ? BigInt(reportIdText) : null;
  const where = { ...visible, ...ON_LIST, ...(reportId === null ? {} : { reportId }) };
  const [rows, runsInDatabase] = await Promise.all([
    prisma.basReportRun.findMany({
      where,
      select: RUN_SELECT,
      orderBy: [{ createdAt: "desc" }, { runId: "desc" }],
      take: 200,
    }),
    prisma.basReportRun.count({ where }),
  ]);
  return { runs: rows.map(toSummary), runsInDatabase };
}

const runNotFound = () => new BasError("run_not_found", "That run does not exist, or you do not have access to it.");
const RUN_ID = /^[0-9]{1,20}$/;

export async function getRun(viewer: Viewer, runIdText: string): Promise<RunDetail> {
  if (!RUN_ID.test(runIdText)) throw runNotFound();
  const visible = await visibilityWhere(viewer);
  const row = await prisma.basReportRun.findFirst({ where: { runId: BigInt(runIdText), ...visible, ...ON_LIST }, select: RUN_SELECT });
  if (row === null) throw runNotFound();
  return {
    ...toSummary(row),
    document: (row.reportJson as unknown as ReportDocument | null) ?? null,
    previousRunId: row.previousRunId?.toString() ?? null,
    deliveries: deliveryRows(row),
  };
}

// ---------------------------------------------------------------------------
// The PDF (Phase 4)
// ---------------------------------------------------------------------------

export interface RunPdfFile {
  runId: string;
  /** "<report name> <period>.pdf" (pdf/naming.ts). */
  fileName: string;
  bytes: Uint8Array;
}

/** Why a visible run has no PDF to download, in the words the button's tooltip uses. */
function pdfUnavailableMessage(pdf: Pick<PdfState, "status" | "error">): string {
  switch (pdfStateKind(pdf)) {
    case "queued":
      return "The PDF is queued for the worker and is not ready yet.";
    case "rendering":
      return "The PDF is being rendered and is not ready yet.";
    case "failed":
      return pdf.error ?? "The PDF failed to render; use Retry PDF.";
    default:
      return "PDF not available for this run: it was made before PDFs were rendered. Run the report again from Scheduled to get one.";
  }
}

/**
 * The run's PDF, for the download route: the same visibility as viewing the
 * run (owner or module admin, 404 otherwise), then 409 `pdf_not_available`
 * with the reason when the run has no ready PDF. The ONE read of the bytes.
 */
export async function loadRunPdf(viewer: Viewer, runIdText: string): Promise<RunPdfFile> {
  if (!RUN_ID.test(runIdText)) throw runNotFound();
  const visible = await visibilityWhere(viewer);
  const row = await prisma.basReportRun.findFirst({
    where: { runId: BigInt(runIdText), ...visible, ...ON_LIST },
    select: {
      runId: true,
      pdf: true,
      pdfStatus: true,
      pdfError: true,
      periodStart: true,
      periodEnd: true,
      timezone: true,
      report: { select: { name: true } },
    },
  });
  if (row === null) throw runNotFound();
  if (row.pdfStatus !== "ready" || row.pdf === null) {
    throw new BasError("pdf_not_available", pdfUnavailableMessage({ status: row.pdfStatus === "queued" || row.pdfStatus === "failed" ? row.pdfStatus : "none", error: row.pdfError }));
  }
  return {
    runId: row.runId.toString(),
    fileName: pdfFileName(row.report.name, row.periodStart, row.periodEnd, row.timezone),
    bytes: row.pdf,
  };
}

function pdfNotRetryableMessage(pdf: Pick<PdfState, "status" | "error">): string {
  switch (pdfStateKind(pdf)) {
    case "ready":
      return "The PDF is ready; download it.";
    case "queued":
      return "The PDF is already queued for the worker.";
    case "rendering":
      return "The PDF is being rendered now.";
    case "failed":
      return "The PDF is no longer failed; reload the page.";
    default:
      return "This run has no PDF to retry: it was made before PDFs were rendered. Run the report again from Scheduled to get one.";
  }
}

/**
 * Retry PDF: queue a FAILED render again, without re-running the analysis.
 * Owner or module admin by the run's visibility; 409 `pdf_not_retryable`
 * for any other PDF state. One audit row, the person as actor. The worker
 * job's scaler counts the queued render, so a worker starts on its own.
 */
export async function retryRunPdf(viewer: Viewer, runIdText: string, now = new Date()): Promise<{ runId: string; pdf: PdfState }> {
  if (!RUN_ID.test(runIdText)) throw runNotFound();
  const visible = await visibilityWhere(viewer);
  const row = await prisma.basReportRun.findFirst({
    where: { runId: BigInt(runIdText), ...visible, ...ON_LIST },
    select: { runId: true, reportId: true, pdfStatus: true, pdfError: true, report: { select: { name: true } } },
  });
  if (row === null) throw runNotFound();
  const before: Pick<PdfState, "status" | "error"> = {
    status: row.pdfStatus === "queued" || row.pdfStatus === "ready" || row.pdfStatus === "failed" ? row.pdfStatus : "none",
    error: row.pdfError,
  };
  if (before.status !== "failed") throw new BasError("pdf_not_retryable", pdfNotRetryableMessage(before));

  await prisma.$transaction(async (tx) => {
    // Re-checked on the write: a worker may have taken or finished it since.
    const updated = await tx.basReportRun.updateMany({
      where: { runId: row.runId, pdfStatus: "failed", ...ON_LIST },
      data: { pdfStatus: "queued", pdfQueuedAt: now, pdfError: null },
    });
    if (updated.count === 0) throw new BasError("pdf_not_retryable", pdfNotRetryableMessage({ status: "failed", error: null }));
    await writeAuditEvent(tx, {
      action: "bas.report_pdf_retry_requested",
      actorEmployeeId: viewer.id,
      moduleKey: BAS_MODULE_KEY,
      metadata: {
        reportId: row.reportId.toString(),
        runId: row.runId.toString(),
        name: row.report.name,
        previousError: row.pdfError,
      },
    });
  });

  return {
    runId: row.runId.toString(),
    pdf: { status: "queued", error: null, bytes: null, queuedAt: now.toISOString(), renderedAt: null },
  };
}

// ---------------------------------------------------------------------------
// The email (Phase 4, the email half - 2026-11-17)
// ---------------------------------------------------------------------------

/** A run the viewer may see, with what Resend and Send to me need. Owner or module admin; 404 otherwise. */
async function visibleRunForEmail(viewer: Viewer, runIdText: string) {
  if (!RUN_ID.test(runIdText)) throw runNotFound();
  const visible = await visibilityWhere(viewer);
  const row = await prisma.basReportRun.findFirst({
    where: { runId: BigInt(runIdText), ...visible, ...ON_LIST },
    select: { runId: true, reportId: true, status: true, report: { select: { name: true } } },
  });
  if (row === null) throw runNotFound();
  return row;
}

/**
 * Resend: queue the run's FAILED deliveries again - and only those. A sent
 * row is not sent twice, a pending one is already with the worker, and a
 * row the closed gate stopped stays as it is (Send to me reaches one
 * address on such a run). Each row starts again with three attempts. Owner
 * or module admin; 409 `nothing_to_resend` when no row has failed. One
 * audit row naming the addresses. The worker sends them: the scaler counts
 * the rows, so a worker starts on its own.
 */
export async function resendFailedDeliveries(
  viewer: Viewer,
  runIdText: string,
  now = new Date(),
): Promise<{ runId: string; requeued: number }> {
  const run = await visibleRunForEmail(viewer, runIdText);
  const requeued = await prisma.$transaction(async (tx) => {
    const failed = await tx.basReportDelivery.findMany({
      where: { runId: run.runId, status: "failed" },
      select: { deliveryId: true, email: true, lastError: true },
      orderBy: [{ position: "asc" }, { deliveryId: "asc" }],
    });
    if (failed.length === 0) {
      throw new BasError("nothing_to_resend", "No email of this run has failed, so there is nothing to resend.");
    }
    const updated = await tx.basReportDelivery.updateMany({
      where: { deliveryId: { in: failed.map((d) => d.deliveryId) }, status: "failed" },
      data: { status: "pending", attempts: 0, nextAttemptAt: now, lastError: null, graphRequestId: null, requestedById: viewer.id },
    });
    await writeAuditEvent(tx, {
      action: "bas.report_resend_requested",
      actorEmployeeId: viewer.id,
      moduleKey: BAS_MODULE_KEY,
      metadata: {
        reportId: run.reportId.toString(),
        runId: run.runId.toString(),
        name: run.report.name,
        emails: failed.map((d) => d.email),
        count: updated.count,
      },
    });
    return updated.count;
  });
  return { runId: run.runId.toString(), requeued };
}

/**
 * Send to me: one copy of the run to the person asking, whoever is on the
 * report's list. Owner or module admin, on a run that succeeded or finished
 * partial (409 `run_not_sendable` otherwise). The address is the viewer's
 * own, from their session - never a parameter - so this can reach nobody
 * else. One row per (run, address): an existing row for the address is
 * queued again with three fresh attempts, whatever it was before - sent,
 * failed, not sent - and a row already waiting is 409 `delivery_pending`.
 * Audited, with the row's previous state.
 */
export async function sendRunToMe(
  viewer: Viewer,
  runIdText: string,
  now = new Date(),
): Promise<{ runId: string; email: string }> {
  const run = await visibleRunForEmail(viewer, runIdText);
  if (run.status !== "succeeded" && run.status !== "partial") {
    throw new BasError("run_not_sendable", "This run has no finished report to send: it is queued, running or failed.");
  }
  const email = normaliseEmail(viewer.email);
  await prisma.$transaction(async (tx) => {
    const existing = await tx.basReportDelivery.findUnique({
      where: { runId_email: { runId: run.runId, email } },
      select: { deliveryId: true, status: true },
    });
    if (existing?.status === "pending") {
      throw new BasError("delivery_pending", "A copy to you is already waiting for the worker.");
    }
    if (existing === null) {
      const last = await tx.basReportDelivery.aggregate({ where: { runId: run.runId }, _max: { position: true } });
      await tx.basReportDelivery.create({
        data: {
          runId: run.runId,
          email,
          source: "requested",
          position: (last._max.position ?? 0) + 1,
          nextAttemptAt: now,
          requestedById: viewer.id,
        },
      });
    } else {
      await tx.basReportDelivery.update({
        where: { deliveryId: existing.deliveryId },
        data: { status: "pending", attempts: 0, nextAttemptAt: now, lastError: null, graphRequestId: null, sentAt: null, requestedById: viewer.id },
      });
    }
    await writeAuditEvent(tx, {
      action: "bas.report_send_to_me_requested",
      actorEmployeeId: viewer.id,
      moduleKey: BAS_MODULE_KEY,
      metadata: {
        reportId: run.reportId.toString(),
        runId: run.runId.toString(),
        name: run.report.name,
        email,
        previousStatus: existing?.status ?? null,
      },
    });
  });
  return { runId: run.runId.toString(), email };
}

// ---------------------------------------------------------------------------
// Delete, Recently deleted and Restore (2026-11-20)
// ---------------------------------------------------------------------------

/** The most a request may name: the list shows 200 rows. */
export const MAX_RUN_SELECTION = 200;

function parseRunIds(texts: readonly string[]): bigint[] {
  const ids = new Set<bigint>();
  for (const t of texts) {
    if (!RUN_ID.test(t)) throw runNotFound();
    ids.add(BigInt(t));
  }
  return [...ids];
}

/**
 * Delete: move runs to Recently deleted. The report's owner or a module
 * admin - the run's visibility, so anyone else is told the run does not
 * exist. ALL OR NOTHING in one transaction: a run that is not visible, or is
 * already deleted, refuses the whole selection as 404 (reload the list); a
 * run still queued or running refuses it as 409 `run_not_finished`. Not
 * audited: the run is the owner's own data, and deleted_by_employee_id is
 * the record until the purge.
 */
export async function deleteRuns(viewer: Viewer, runIdTexts: readonly string[], now = new Date()): Promise<{ deleted: number }> {
  const ids = parseRunIds(runIdTexts);
  if (ids.length === 0) return { deleted: 0 };
  const visible = await visibilityWhere(viewer);
  const deleted = await prisma.$transaction(async (tx) => {
    const rows = await tx.basReportRun.findMany({
      where: { runId: { in: ids }, ...visible, ...ON_LIST },
      select: { runId: true, status: true },
    });
    if (rows.length !== ids.length) {
      throw new BasError(
        "run_not_found",
        ids.length === 1
          ? "That run does not exist, is already deleted, or you do not have access to it. Reload the list."
          : "One or more of these runs does not exist, is already deleted, or you do not have access to it. Nothing was deleted; reload the list.",
      );
    }
    const unfinished = rows.filter((r) => !(FINISHED_RUN_STATUSES as readonly string[]).includes(r.status));
    if (unfinished.length > 0) {
      throw new BasError(
        "run_not_finished",
        ids.length === 1
          ? "This run is still queued or running. A run can be deleted once it has finished."
          : `${unfinished.length} of these runs ${unfinished.length === 1 ? "is" : "are"} still queued or running. A run can be deleted once it has finished; nothing was deleted.`,
      );
    }
    const moved = await markRunsDeleted(tx, ids, { kind: "person", employeeId: viewer.id }, now);
    if (moved.length !== ids.length) {
      // Another tab got there between the read and the write.
      throw new BasError("run_not_found", "The list changed while these runs were being deleted. Nothing was deleted; reload the list.");
    }
    return moved.length;
  });
  return { deleted };
}

/**
 * Restore: bring runs back from Recently deleted, whole - findings, page,
 * PDF and email record as they were. Same visibility; all or nothing, 404
 * when one is not in the viewer's Recently deleted (purged, already
 * restored, or not theirs). A restored run is never taken by retention
 * again. Not audited, like the delete.
 */
export async function restoreRuns(viewer: Viewer, runIdTexts: readonly string[], now = new Date()): Promise<{ restored: number }> {
  const ids = parseRunIds(runIdTexts);
  if (ids.length === 0) return { restored: 0 };
  const visible = await visibilityWhere(viewer);
  const restored = await prisma.$transaction(async (tx) => {
    const rows = await tx.basReportRun.findMany({
      where: { runId: { in: ids }, ...visible, deletedAt: { not: null } },
      select: { runId: true },
    });
    if (rows.length !== ids.length) {
      throw new BasError(
        "run_not_found",
        ids.length === 1
          ? "That run is not in Recently deleted: it was restored already, it was purged, or you do not have access to it. Reload the list."
          : "One or more of these runs is not in Recently deleted: restored already, purged, or not yours to see. Nothing was restored; reload the list.",
      );
    }
    const back = await markRunsRestored(tx, ids, now);
    if (back.length !== ids.length) {
      throw new BasError("run_not_found", "The list changed while these runs were being restored. Nothing was restored; reload the list.");
    }
    return back.length;
  });
  return { restored };
}

/**
 * Recently deleted: the viewer's deleted runs - their own reports', or
 * every report's for a module admin - newest deletion first, with when each
 * is purged.
 */
export async function listDeletedRuns(viewer: Viewer, now = new Date()): Promise<DeletedRunsList> {
  const visible = await visibilityWhere(viewer);
  const where = { ...visible, deletedAt: { not: null } };
  const [rows, runsInDatabase] = await Promise.all([
    prisma.basReportRun.findMany({
      where,
      select: {
        runId: true,
        reportId: true,
        status: true,
        trigger: true,
        periodStart: true,
        periodEnd: true,
        timezone: true,
        finishedAt: true,
        deletedAt: true,
        deletedBy: true,
        deletedByEmployee: { select: { email: true } },
        report: { select: { name: true, runRetentionMonths: true, deletedAt: true, site: { select: { name: true } } } },
      },
      orderBy: [{ deletedAt: "desc" }, { runId: "desc" }],
      take: MAX_RUN_SELECTION,
    }),
    prisma.basReportRun.count({ where }),
  ]);
  return {
    runs: rows.map((r) => {
      const deletedAt = r.deletedAt ?? now;
      const months = r.report.runRetentionMonths;
      const view: DeletedRunSummary = {
        runId: r.runId.toString(),
        reportId: r.reportId.toString(),
        reportName: r.report.name,
        reportDeleted: r.report.deletedAt !== null,
        buildingName: r.report.site.name,
        status: toStatus(r.status),
        trigger: r.trigger,
        periodStart: r.periodStart.toISOString(),
        periodEnd: r.periodEnd.toISOString(),
        timezone: r.timezone,
        finishedAt: r.finishedAt?.toISOString() ?? null,
        deletedAt: deletedAt.toISOString(),
        deletedBy: r.deletedBy === "retention" ? "retention" : "person",
        deletedByEmail: r.deletedByEmployee?.email ?? null,
        retentionMonths: isRunRetentionMonths(months) ? months : null,
        purgeAt: purgeDueAt(deletedAt).toISOString(),
        daysRemaining: daysRemaining(deletedAt, now),
      };
      return view;
    }),
    runsInDatabase,
  };
}
