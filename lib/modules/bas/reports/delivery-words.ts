/**
 * A run's email deliveries in words (Reports, Phase 4, the email half -
 * 2026-11-17). No imports: the Reports list (a client component), the run
 * page and the worker all read these, and the worker's import graph must
 * stay small.
 */

export type DeliveryStatus = "pending" | "sent" | "failed" | "not_sent";
export type DeliverySource = "owner" | "recipient" | "requested";

export const MAX_DELIVERY_ATTEMPTS = 3;

/** The words the list and the run page show for a row the closed gate stopped. */
export const SEND_DISABLED_LABEL = "Not sent — sending disabled";

/** What a delivery row says when the gate was closed. The variable is named; nothing else is. */
export const SEND_DISABLED_MESSAGE =
  'Not sent - sending disabled: BAS_REPORTS_ALLOW_SEND is not "true" on the worker, so nothing left the platform.';

export interface DeliveryRowView {
  deliveryId: string;
  email: string;
  source: DeliverySource;
  status: DeliveryStatus;
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  /** When the worker may next try it, for a pending row in its backoff. */
  nextAttemptAt: string | null;
  isExternal: boolean;
}

export interface DeliveryCounts {
  total: number;
  sent: number;
  failed: number;
  pending: number;
  notSent: number;
}

export interface DeliverySummary extends DeliveryCounts {
  /**
   * Why there are no rows, when there are none:
   *   waiting_for_pdf  the run finished and its PDF is queued - the worker
   *                    writes the rows when the PDF is ready
   *   no_pdf           the run finished but its PDF failed or was never made;
   *                    Retry PDF, and the email follows a ready PDF
   *   not_finished     queued, running or failed - there is no report to send
   *   none             a run from before the email existed, or one that was
   *                    never queued for email
   */
  emptyReason: "waiting_for_pdf" | "no_pdf" | "not_finished" | "none" | null;
}

export function countDeliveries(rows: ReadonlyArray<{ status: string }>): DeliveryCounts {
  const counts: DeliveryCounts = { total: rows.length, sent: 0, failed: 0, pending: 0, notSent: 0 };
  for (const r of rows) {
    if (r.status === "sent") counts.sent += 1;
    else if (r.status === "failed") counts.failed += 1;
    else if (r.status === "not_sent") counts.notSent += 1;
    else counts.pending += 1;
  }
  return counts;
}

/**
 * The Delivery column's words. One phrase, worst news first:
 *   "1 failed"                       - any failed row (Resend is offered beside it)
 *   "Not sent — sending disabled"    - every row stopped by the closed gate
 *   "2 of 3 sent · 1 waiting"        - some still with the worker
 *   "3 of 3 sent"                    - all of them
 */
export function describeDelivery(d: DeliverySummary): string {
  if (d.total === 0) {
    switch (d.emptyReason) {
      case "waiting_for_pdf":
        return "Waiting for the PDF";
      case "no_pdf":
        return "Not sent: no PDF";
      case "not_finished":
        return "—";
      default:
        return "Not emailed";
    }
  }
  if (d.failed > 0) return `${d.failed} failed`;
  if (d.notSent > 0 && d.sent === 0 && d.pending === 0) return SEND_DISABLED_LABEL;
  if (d.pending > 0) return `${d.sent} of ${d.total} sent · ${d.pending} waiting`;
  if (d.notSent > 0) return `${d.sent} of ${d.total} sent · ${d.notSent} not sent (sending disabled)`;
  return `${d.sent} of ${d.total} sent`;
}

/** The second line under the phrase, when there is one worth reading. */
export function deliveryDetail(d: DeliverySummary): string | null {
  if (d.total === 0) {
    if (d.emptyReason === "no_pdf") return "The email follows a ready PDF: use Retry PDF.";
    if (d.emptyReason === "none") return "This run was not emailed: it was made before report email existed, or none was queued.";
    return null;
  }
  if (d.failed > 0) return `${d.sent} of ${d.total} sent. Resend tries the failed ${d.failed === 1 ? "one" : "ones"} again.`;
  return null;
}

export const SOURCE_WORDS: Record<DeliverySource, string> = {
  owner: "Report owner",
  recipient: "Recipient",
  requested: "Send to me",
};

export function deliveryStatusLabel(status: DeliveryStatus): string {
  switch (status) {
    case "sent":
      return "Sent";
    case "failed":
      return "Failed";
    case "not_sent":
      return SEND_DISABLED_LABEL;
    default:
      return "Waiting";
  }
}
