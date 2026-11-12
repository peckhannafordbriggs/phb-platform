/**
 * The PDF's name and its state, as pure functions (Reports, Phase 4, the
 * PDF half - 2026-11-13). Shared by the worker that renders a PDF, the
 * route that serves it and the screens that offer it.
 *
 * This file imports nothing from Playwright and is the ONLY part of `pdf/`
 * on the web app's import graph. `render.ts` - the module that launches
 * Chromium - is reached by the worker alone; tests/bas-reports-pdf.test.ts
 * walks the web app's graph and fails if that changes.
 */

export type PdfStatus = "none" | "queued" | "ready" | "failed";
export const PDF_STATUSES: readonly PdfStatus[] = ["none", "queued", "ready", "failed"];

/** The PDF's five columns beside the bytes, as the API carries them. */
export interface PdfState {
  status: PdfStatus;
  /** Set exactly when `failed`: why, or that a render started and has not finished. */
  error: string | null;
  /** Set exactly when `ready`. */
  bytes: number | null;
  /** Set exactly while `queued`. */
  queuedAt: string | null;
  /** Set exactly when `ready`. */
  renderedAt: string | null;
}

export const RUNBOOK_PDF_ENTRY = 'the runbook entry "Reports: the PDF"';

/**
 * What a worker writes when it CLAIMS a queued render, before Chromium runs:
 * the row reads failed with this sentence until the render succeeds and
 * overwrites it with ready. A worker that dies mid-render therefore leaves a
 * row that says what happened and offers Retry PDF, never one that reads
 * "queued" forever.
 */
export const RENDER_IN_PROGRESS_PREFIX = "A PDF render started at ";

export function renderInProgressSentence(startedAt: Date): string {
  return `${RENDER_IN_PROGRESS_PREFIX}${startedAt.toISOString()} and has not finished. If this stays, the worker stopped before it could store the PDF; use Retry PDF.`;
}

export function isRenderInProgress(error: string | null): boolean {
  return error !== null && error.startsWith(RENDER_IN_PROGRESS_PREFIX);
}

/** The most of a renderer's error that is stored: Chromium can be verbose. */
export const MAX_RENDER_ERROR_CHARS = 1500;

export function renderFailedSentence(message: string): string {
  const trimmed = message.replace(/\s+/g, " ").trim();
  const shown = trimmed.length > MAX_RENDER_ERROR_CHARS ? `${trimmed.slice(0, MAX_RENDER_ERROR_CHARS)}…` : trimmed;
  return `The PDF could not be rendered: ${shown}. The report itself is unaffected; use Retry PDF, and if it fails again see ${RUNBOOK_PDF_ENTRY}.`;
}

/**
 * How the state reads on a screen. A render in progress is stored as a
 * failure (see RENDER_IN_PROGRESS_PREFIX) and shown as rendering.
 */
export type PdfStateKind = "none" | "queued" | "rendering" | "ready" | "failed";

export function pdfStateKind(pdf: Pick<PdfState, "status" | "error">): PdfStateKind {
  if (pdf.status === "failed") return isRenderInProgress(pdf.error) ? "rendering" : "failed";
  return pdf.status;
}

/** The tooltip on a greyed Download, by the user's wording for a run from before the column existed. */
export const PDF_NOT_AVAILABLE_TOOLTIP = "PDF not available for this run — use Re-run";

/** Why Download is greyed; undefined when it is not. */
export function pdfTooltip(pdf: Pick<PdfState, "status" | "error">): string | undefined {
  switch (pdfStateKind(pdf)) {
    case "ready":
      return undefined;
    case "none":
      return PDF_NOT_AVAILABLE_TOOLTIP;
    case "queued":
      return "The PDF is queued for the worker; Download works when it has rendered.";
    case "rendering":
      return "The PDF is being rendered; Download works when it has finished.";
    case "failed":
      return `The PDF failed to render. Use Retry PDF. ${pdf.error ?? ""}`.trim();
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One phrase for a list cell: the state and, when ready, the size. */
export function describePdfState(pdf: PdfState): string {
  switch (pdfStateKind(pdf)) {
    case "ready":
      return `Ready${pdf.bytes !== null ? ` · ${formatBytes(pdf.bytes)}` : ""}`;
    case "queued":
      return "Queued for the worker";
    case "rendering":
      return "Rendering…";
    case "failed":
      return "Failed";
    case "none":
      return "Not available";
  }
}

const ISO_DAY = new Map<string, Intl.DateTimeFormat>();

/** A calendar date in the building's zone, as YYYY-MM-DD. */
export function isoDayInZone(instant: Date | string, timezone: string): string {
  let f = ISO_DAY.get(timezone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    ISO_DAY.set(timezone, f);
  }
  return f.format(typeof instant === "string" ? new Date(instant) : instant);
}

/** The period as two dates in the building's zone: "2026-11-05 to 2026-11-12". In the PDF's header and its file name. */
export function periodLabel(periodStart: Date | string, periodEnd: Date | string, timezone: string): string {
  return `${isoDayInZone(periodStart, timezone)} to ${isoDayInZone(periodEnd, timezone)}`;
}

/** The most of a report's name that goes in a file name. */
const MAX_NAME_CHARS = 100;

/**
 * "<report name> <period>.pdf", with the characters a file system refuses
 * removed from the name and whitespace collapsed. The period is two ISO
 * dates, so a folder of them sorts by report and then by week.
 */
export function pdfFileName(reportName: string, periodStart: Date | string, periodEnd: Date | string, timezone: string): string {
  const safe = reportName
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_CHARS)
    .trim();
  const name = safe.length === 0 ? "BAS report" : safe;
  return `${name} ${periodLabel(periodStart, periodEnd, timezone)}.pdf`;
}

/**
 * A Content-Disposition that every browser reads: an ASCII fallback in
 * `filename` and the exact name in `filename*` (RFC 6266 / 5987).
 */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
