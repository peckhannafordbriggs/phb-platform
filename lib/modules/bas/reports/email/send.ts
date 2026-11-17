import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  claimNextDelivery,
  failExhaustedDeliveries,
  markDueDeliveriesNotSent,
  recordDeliveryFailure,
  recordDeliverySent,
  type ClaimedDelivery,
} from "../deliveries";
import type { ReportDocument } from "../engine/types";
import { pdfFileName } from "../pdf/naming";
import { buildReportEmail, type EmailPdf, type ReportEmail } from "./message";
import { EMAIL_ATTACHMENT_MAX_BYTES, ReportMailError, isReportMailError, type ReportMailer } from "./mailer";

/**
 * The worker's half of the report email (Reports, Phase 4, the email half -
 * 2026-11-17): take each delivery that is due, build its message from the
 * stored run, send it through the mailer, and write what happened back on the
 * row. One message per row - one address - never a list.
 *
 * The gate comes first: when BAS_REPORTS_ALLOW_SEND is not "true" every due
 * row is marked not sent in one statement and nothing is claimed, built or
 * sent. The mailer refuses again on its own if it is ever asked.
 *
 * A run's message and PDF are read once per drain and reused for each of its
 * addresses. The PDF's bytes are read here and in the download route
 * (runs-service.ts loadRunPdf) and nowhere else, and only when the PDF is
 * small enough to attach.
 */

export interface DeliveryOptions {
  mailer: ReportMailer;
  platformUrl: string | null;
  /** Tests move it. */
  now?: () => Date;
}

export interface DeliveryOutcome {
  deliveryId: bigint;
  runId: bigint;
  email: string;
  status: "sent" | "pending" | "failed" | "not_sent";
  error: string | null;
}

interface RunEmail {
  email: ReportEmail;
  attachment: { name: string; bytes: Uint8Array } | null;
}

/** The message every address of one run receives, and the PDF when it can ride along. */
export async function loadRunEmail(runId: bigint, platformUrl: string | null): Promise<RunEmail> {
  const run = await prisma.basReportRun.findUnique({
    where: { runId },
    select: {
      status: true,
      partialReason: true,
      periodStart: true,
      periodEnd: true,
      timezone: true,
      reportJson: true,
      pdfStatus: true,
      pdfBytes: true,
      pdfError: true,
      report: { select: { name: true, site: { select: { name: true } } } },
    },
  });
  if (run === null) throw new ReportMailError("run_unavailable", `Run ${runId} no longer exists.`, false);
  if (run.status !== "succeeded" && run.status !== "partial") {
    throw new ReportMailError("run_unavailable", `Run ${runId} finished ${run.status}; there is no report to send.`, false);
  }
  const document = (run.reportJson as unknown as ReportDocument | null) ?? null;
  const fileName = pdfFileName(run.report.name, run.periodStart, run.periodEnd, run.timezone);

  let pdf: EmailPdf;
  let attachment: RunEmail["attachment"] = null;
  if (run.pdfStatus === "ready" && run.pdfBytes !== null) {
    if (run.pdfBytes > EMAIL_ATTACHMENT_MAX_BYTES) {
      pdf = { kind: "too_large", bytes: run.pdfBytes, limitBytes: EMAIL_ATTACHMENT_MAX_BYTES };
    } else {
      const bytes = (await prisma.basReportRun.findUnique({ where: { runId }, select: { pdf: true } }))?.pdf ?? null;
      if (bytes === null) {
        pdf = { kind: "unavailable", reason: "the PDF was not found when the email was built." };
      } else {
        attachment = { name: fileName, bytes };
        pdf = { kind: "attached", fileName, bytes: bytes.length };
      }
    }
  } else if (run.pdfStatus === "failed") {
    pdf = { kind: "unavailable", reason: "the PDF failed to render." };
  } else if (run.pdfStatus === "queued") {
    pdf = { kind: "unavailable", reason: "the PDF was still being made when this was sent." };
  } else {
    pdf = { kind: "unavailable", reason: "this run has no PDF." };
  }

  const email = buildReportEmail({
    runId: runId.toString(),
    reportName: run.report.name,
    buildingName: document?.header?.buildingName ?? run.report.site.name,
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    timezone: run.timezone,
    runStatus: run.status,
    partialReason: run.partialReason,
    document,
    platformUrl,
    pdf,
  });
  return { email, attachment };
}

async function sendOne(claim: ClaimedDelivery, options: DeliveryOptions, cache: Map<bigint, RunEmail | ReportMailError>): Promise<DeliveryOutcome> {
  const now = options.now ?? (() => new Date());
  const base = { deliveryId: claim.deliveryId, runId: claim.runId, email: claim.email };
  try {
    let built = cache.get(claim.runId);
    if (built === undefined) {
      try {
        built = await loadRunEmail(claim.runId, options.platformUrl);
      } catch (error) {
        built = isReportMailError(error) ? error : new ReportMailError("run_unavailable", error instanceof Error ? error.message : String(error), true);
      }
      cache.set(claim.runId, built);
    }
    if (built instanceof ReportMailError) throw built;
    const sent = await options.mailer.send({
      to: claim.email,
      subject: built.email.subject,
      html: built.email.html,
      attachment: built.attachment,
      deliveryId: claim.deliveryId.toString(),
    });
    await recordDeliverySent(claim, sent.requestId, now());
    logger.info("bas.report_delivery_sent", { outcome: "sent", reason: `delivery ${claim.deliveryId} of run ${claim.runId}, attempt ${claim.attempt}` });
    return { ...base, status: "sent", error: null };
  } catch (error) {
    const failure = isReportMailError(error)
      ? error
      : new ReportMailError("network", error instanceof Error ? error.message : String(error), true);
    const status = await recordDeliveryFailure(claim, failure.message, failure.retryable, failure.requestId, now());
    logger.error("bas.report_delivery_failed", {
      outcome: status,
      reason: `delivery ${claim.deliveryId} of run ${claim.runId}, attempt ${claim.attempt}: ${failure.kind}: ${failure.message}`,
    });
    return { ...base, status, error: failure.message };
  }
}

/**
 * Send every delivery that is due, until none is left or a limit is reached.
 * Null options - no mailer at all - claims nothing and leaves the rows for a
 * worker that has one.
 */
export async function drainDeliveries(
  options: DeliveryOptions | null,
  limits: { max?: number; deadlineMs?: number } = {},
): Promise<DeliveryOutcome[]> {
  if (options === null) return [];
  const now = options.now ?? (() => new Date());
  await failExhaustedDeliveries(now());

  if (!options.mailer.allowSend) {
    const marked = await markDueDeliveriesNotSent(now());
    return marked.map((m) => ({ ...m, status: "not_sent" as const, error: null }));
  }

  const done: DeliveryOutcome[] = [];
  const cache = new Map<bigint, RunEmail | ReportMailError>();
  for (;;) {
    if (limits.max !== undefined && done.length >= limits.max) break;
    if (limits.deadlineMs !== undefined && Date.now() > limits.deadlineMs) break;
    const claim = await claimNextDelivery(now());
    if (claim === null) break;
    done.push(await sendOne(claim, options, cache));
  }
  return done;
}
