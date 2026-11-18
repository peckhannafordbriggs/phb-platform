"use client";

import { Download, Printer, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { pdfStateKind, pdfTooltip, type PdfState } from "@/lib/modules/bas/reports/pdf/naming";
import { ApiError } from "./health-client";
import { downloadRunPdf, fetchRun, retryRunPdf } from "./reports-client";

/**
 * The run page's top-right row (Phase 4), on Freeze Protection's Report tab
 * exactly: a secondary *Print* and a red primary *Download*, kit buttons,
 * in the bar's actions slot. Print is the browser's own dialog over the
 * page's print stylesheet (the report alone, the chrome hidden); Download
 * fetches the stored PDF through the run's own route.
 *
 * Download is greyed, with a tooltip saying why, until the PDF is ready: a
 * run from before PDFs says "use Re-run", a queued or rendering one says to
 * wait, a failed one says to retry - and *Retry PDF* appears beside it for
 * exactly that case, queueing a render without re-running the analysis.
 * While a render is queued or in progress the row polls the run every ten
 * seconds and settles on its own.
 *
 * The kit's disabled button turns pointer events off, so the tooltip sits on
 * a wrapper the pointer still reaches.
 */

export const PDF_POLL_MS = 10_000;
/** The id the print stylesheet keeps visible; the run page puts it on the report's section. */
export const REPORT_PRINT_ID = "bas-report-print";

/** Print the report alone: everything else on the page is hidden, and the report fills the sheet. */
export const PRINT_PAGE_CSS = `@media print {
  html, body { overflow: visible !important; height: auto !important; background: #fff !important; }
  body * { visibility: hidden; }
  #${REPORT_PRINT_ID}, #${REPORT_PRINT_ID} * { visibility: visible; }
  #${REPORT_PRINT_ID} { position: absolute; inset: 0 auto auto 0; width: 100%; margin: 0; padding: 0; box-shadow: none !important; border: 0 !important; background: #fff !important; }
  #${REPORT_PRINT_ID} tr, #${REPORT_PRINT_ID} .incident, #${REPORT_PRINT_ID} .partial { break-inside: avoid; }
  #${REPORT_PRINT_ID} h1, #${REPORT_PRINT_ID} h2, #${REPORT_PRINT_ID} h3 { break-after: avoid; }
}`;

export function RunActions({ runId, pdf: initial }: { runId: string; pdf: PdfState }) {
  const [pdf, setPdf] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const kind = pdfStateKind(pdf);

  useEffect(() => {
    if (kind !== "queued" && kind !== "rendering") return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      fetchRun(runId)
        .then((run) => setPdf(run.pdf))
        .catch(() => undefined);
    }, PDF_POLL_MS);
    return () => clearInterval(timer);
  }, [kind, runId]);

  async function retry() {
    setBusy(true);
    setMessage(null);
    try {
      await retryRunPdf(runId);
      const run = await fetchRun(runId);
      setPdf(run.pdf);
    } catch (cause) {
      setMessage(cause instanceof ApiError ? cause.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {message !== null && (
        <span className="text-xs text-[var(--danger)]" role="alert">
          {message}
        </span>
      )}
      {kind === "failed" && (
        <Button disabled={busy} onClick={() => void retry()} title={pdf.error ?? undefined} testId="run-retry-pdf">
          <RefreshCw size={16} aria-hidden="true" />
          Retry PDF
        </Button>
      )}
      <Button onClick={() => window.print()} testId="run-print">
        <Printer size={16} aria-hidden="true" />
        Print
      </Button>
      <DownloadPdfButton pdf={pdf} onClick={() => downloadRunPdf(runId)} variant="primary" />
    </>
  );
}

/**
 * Download, enabled only when the PDF is ready. Greyed, the button sits in a
 * span carrying the tooltip, because a disabled kit button takes no pointer
 * events and a tooltip on it would never show.
 */
export function DownloadPdfButton({
  pdf,
  onClick,
  variant = "secondary",
  size = "md",
  disabled = false,
}: {
  pdf: Pick<PdfState, "status" | "error">;
  onClick: () => void;
  variant?: "primary" | "secondary";
  size?: "md" | "sm";
  disabled?: boolean;
}) {
  const tooltip = pdfTooltip(pdf);
  const button = (
    <Button variant={variant} size={size} onClick={onClick} disabled={disabled || tooltip !== undefined} testId="run-download-pdf">
      <Download size={size === "sm" ? 14 : 16} aria-hidden="true" />
      Download
    </Button>
  );
  if (tooltip === undefined) return button;
  return (
    <span title={tooltip} className="inline-flex" data-testid="run-download-pdf-disabled">
      {button}
    </span>
  );
}
