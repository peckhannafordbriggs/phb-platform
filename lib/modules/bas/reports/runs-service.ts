import { hasModuleAdmin, type Viewer } from "@/lib/authz";
import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { BAS_MODULE_KEY } from "../constants";
import { BasError } from "../errors";
import { basSiteScope } from "../service";
import type { ReportDocument, RunStatus } from "./engine/types";
import { pdfFileName, pdfStateKind, type PdfState } from "./pdf/naming";

/**
 * Reading runs (Reports, Phase 2). The same visibility as a definition: its
 * owner, or a module admin; anyone else is told the run does not exist.
 * A run is written by the engine and the worker; the one write here is
 * Retry PDF (Phase 4), which queues a render on a run's own columns and
 * never touches the run.
 *
 * The PDF's bytes are read by `loadRunPdf` alone, by name. Every other read
 * of a run here is a `select` that leaves `pdf` out - a few hundred KB a
 * row, and the list reads up to 200 rows every ten seconds.
 * tests/bas-reports-pdf.test.ts holds every basReportRun read in lib/ and
 * app/ to a select, and the summaries to carrying no bytes.
 */

export interface RunSummary {
  runId: string;
  reportId: string;
  reportName: string;
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
}

export interface RunDetail extends RunSummary {
  document: ReportDocument | null;
  previousRunId: string | null;
}

export interface RunsList {
  runs: RunSummary[];
  runsInDatabase: number;
}

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
  report: { select: { name: true, ownerEmployeeId: true, siteId: true, site: { select: { name: true } } } },
  startedBy: { select: { email: true } },
  _count: { select: { findings: { where: { state: { not: "cleared" } } } } },
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

function toSummary(r: RunRow): RunSummary {
  const doc = r.reportJson as unknown as ReportDocument | null;
  return {
    runId: r.runId.toString(),
    reportId: r.reportId.toString(),
    reportName: r.report.name,
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
  const where = { ...visible, ...(reportId === null ? {} : { reportId }) };
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
  const row = await prisma.basReportRun.findFirst({ where: { runId: BigInt(runIdText), ...visible }, select: RUN_SELECT });
  if (row === null) throw runNotFound();
  return {
    ...toSummary(row),
    document: (row.reportJson as unknown as ReportDocument | null) ?? null,
    previousRunId: row.previousRunId?.toString() ?? null,
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
    where: { runId: BigInt(runIdText), ...visible },
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
    where: { runId: BigInt(runIdText), ...visible },
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
      where: { runId: row.runId, pdfStatus: "failed" },
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
