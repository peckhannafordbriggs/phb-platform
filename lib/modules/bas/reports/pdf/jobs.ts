import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { periodLabel, renderFailedSentence, renderInProgressSentence } from "./naming";
import { looksLikePdf, type PdfBytes, type PdfRenderer } from "./render";

/**
 * The PDF queue (Reports, Phase 4, the PDF half - 2026-11-13): which runs
 * need a PDF, how a worker takes one, and what it writes back.
 *
 * A render is a row in `queued` before it is anything else - set by the
 * engine the moment it stores a run's page (engine/run.ts), and by Retry
 * PDF on a failed one (runs-service.ts). The worker job's scaler counts
 * queued renders beside queued runs (infra/main.bicep), so a retry wakes
 * a worker on its own, and the scheduler's pass fails a render that waited
 * an hour unclaimed (queue-guards.ts) so the count returns to zero.
 *
 * THE CLAIM WRITES THE FAILURE FIRST. Taking a queued render sets it to
 * `failed` with a sentence saying a render started at this time and has
 * not finished; success overwrites that with `ready`. There is no
 * `rendering` state to get stuck in and no heartbeat to keep: a worker
 * that dies mid-render - out of memory under Chromium, killed by the
 * replica timeout - leaves a row that says exactly what happened and
 * offers Retry PDF, which is the honest outcome. FOR UPDATE SKIP LOCKED,
 * as the run claim does, so two workers never print the same report.
 *
 * A failed render never touches the run: status, page and findings stay
 * what the engine stored, and `renderClaimedPdf` never throws for a render
 * that failed - only for a database that would not take the result, which
 * is the worker's to stop on.
 */

export interface PdfJob {
  runId: bigint;
  reportId: bigint;
  name: string;
  html: string;
  /** The header's two lines (pdf/render.ts). */
  title: string;
  period: string;
}

export interface PdfOutcome {
  runId: bigint;
  reportId: bigint;
  name: string;
  ok: boolean;
  bytes: number | null;
  error: string | null;
}

/**
 * Take the oldest queued render, or null. The row is marked as a render in
 * progress - see the module comment - and its page comes back with it.
 */
export async function claimNextPdfJob(now = new Date()): Promise<PdfJob | null> {
  const sentence = renderInProgressSentence(now);
  const rows = await prisma.$queryRaw<
    Array<{ run_id: bigint; report_id: bigint; report_html: string; period_start: Date; period_end: Date; timezone: string; name: string }>
  >`
    UPDATE bas_report_runs AS r
       SET pdf_status = 'failed', pdf_error = ${sentence}, pdf_queued_at = NULL
     WHERE r.run_id = (
       SELECT run_id FROM bas_report_runs
        WHERE pdf_status = 'queued' AND report_html IS NOT NULL
        ORDER BY pdf_queued_at, run_id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
    RETURNING r.run_id, r.report_id, r.report_html, r.period_start, r.period_end, r.timezone,
              (SELECT d.name FROM bas_report_definitions AS d WHERE d.report_id = r.report_id) AS name`;
  const row = rows[0];
  if (row === undefined) return null;
  return {
    runId: row.run_id,
    reportId: row.report_id,
    name: row.name,
    html: row.report_html,
    title: row.name,
    period: periodLabel(row.period_start, row.period_end, row.timezone),
  };
}

/**
 * Print a claimed render and store the result: the bytes, their length and
 * the time as `ready`, or the reason as `failed`. Returns what happened;
 * throws only when the database refuses the write.
 */
export async function renderClaimedPdf(job: PdfJob, renderer: PdfRenderer, now: () => Date = () => new Date()): Promise<PdfOutcome> {
  const base = { runId: job.runId, reportId: job.reportId, name: job.name };
  let bytes: PdfBytes;
  try {
    bytes = await renderer.render({ html: job.html, title: job.title, period: job.period });
    if (!looksLikePdf(bytes)) throw new Error(`the renderer returned ${bytes.length} bytes that are not a PDF`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const sentence = renderFailedSentence(message);
    await prisma.basReportRun.update({
      where: { runId: job.runId },
      data: { pdfStatus: "failed", pdfError: sentence, pdfQueuedAt: null, pdf: null, pdfBytes: null, pdfRenderedAt: null },
      select: { runId: true },
    });
    logger.error("bas.report_pdf_failed", { outcome: "failed", reason: `run ${job.runId} of report ${job.reportId}: ${message}` });
    return { ...base, ok: false, bytes: null, error: sentence };
  }

  await prisma.basReportRun.update({
    where: { runId: job.runId },
    data: { pdf: bytes, pdfBytes: bytes.length, pdfRenderedAt: now(), pdfStatus: "ready", pdfError: null, pdfQueuedAt: null },
    // The bytes just written are not echoed back.
    select: { runId: true },
  });
  logger.info("bas.report_pdf_rendered", { outcome: "ready", reason: `run ${job.runId} of report ${job.reportId}: ${bytes.length} bytes` });
  return { ...base, ok: true, bytes: bytes.length, error: null };
}

/**
 * Render every queued PDF, oldest first, until none is left or a limit is
 * reached. With no renderer - the worker started with --no-pdf, or a dev
 * script that carries no Chromium - nothing is claimed and the rows stay
 * queued for a worker that has one.
 */
export async function drainPdfQueue(
  renderer: PdfRenderer | null,
  limits: { max?: number; deadlineMs?: number } = {},
): Promise<PdfOutcome[]> {
  const done: PdfOutcome[] = [];
  if (renderer === null) return done;
  for (;;) {
    if (limits.max !== undefined && done.length >= limits.max) break;
    if (limits.deadlineMs !== undefined && Date.now() > limits.deadlineMs) break;
    const job = await claimNextPdfJob();
    if (job === null) break;
    done.push(await renderClaimedPdf(job, renderer));
  }
  return done;
}
