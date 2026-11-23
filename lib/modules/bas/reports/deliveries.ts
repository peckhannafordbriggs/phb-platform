import type { Prisma } from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { MAX_DELIVERY_ATTEMPTS, SEND_DISABLED_MESSAGE, type DeliverySource } from "./delivery-words";
import { normaliseEmail } from "./recipients";

/**
 * The delivery queue (Reports, Phase 4, the email half - 2026-11-17): which
 * addresses a run goes to, how the worker takes one, and what it writes
 * back. Database only - no Graph, no React - so the web app's Resend and
 * Send to me (runs-service.ts) and the scheduler's guards can share it with
 * the worker without reaching the sender (email/mailer.ts), which only the
 * worker imports.
 *
 * WHEN. A run's rows are written when its PDF becomes ready (pdf/jobs.ts),
 * in the same transaction, and only for a run that succeeded or finished
 * partial: the plan's "after a run succeeds (or is partial) and its PDF is
 * ready". A run whose PDF fails is not emailed until Retry PDF makes one.
 *
 * WHO, IN ORDER. The report's OWNER first, from the employee record at that
 * moment - never from a recipient row, so no screen or API can take the
 * owner off - then each recipient row in the order it was added. Position 0
 * is the owner.
 *
 * ONCE. One row per (run, email), the unique key: writing the rows again (a
 * Retry PDF after a ready PDF, a worker that repeats itself) writes nothing,
 * and a row already sent is never claimed again.
 *
 * ATTEMPTS. A claim counts as an attempt BEFORE the Graph call, and leases
 * the row for DELIVERY_LEASE_MS with a sentence saying an attempt started
 * and has not finished - the PDF claim's pattern. A failure that another try
 * could fix waits DELIVERY_BACKOFF_MS[attempt] and goes again, three
 * attempts in all; then it is failed, with Resend. A worker that dies
 * mid-send leaves the lease to expire and the next worker takes the row,
 * the attempt already counted. The send itself (sendMail) answers with no
 * message id, so a worker that dies between Graph's 202 and this write can
 * send that one message twice; nothing else can.
 */

/** The wait after attempt 1 and after attempt 2. */
export const DELIVERY_BACKOFF_MS = [60_000, 5 * 60_000] as const;
/** How long an attempt in flight holds its row. A sendMail call is seconds; this is a worker that died. */
export const DELIVERY_LEASE_MS = 5 * 60_000;
/** A delivery due this long and never taken is a worker that is not starting (queue-guards.ts). */
export const DELIVERY_UNCLAIMED_AFTER_MS = 60 * 60_000;

/** How a delivery an attempt is holding begins its last_error; run-deletion.ts leaves such a row to its attempt. */
export const DELIVERY_IN_PROGRESS_PREFIX = "An attempt started at ";

export const deliveryInProgressSentence = (now: Date) =>
  `${DELIVERY_IN_PROGRESS_PREFIX}${now.toISOString()} and has not finished.`;

export function deliveryBackoffMs(attempts: number): number {
  return DELIVERY_BACKOFF_MS[Math.min(Math.max(attempts, 1), DELIVERY_BACKOFF_MS.length) - 1]!;
}

type Db = Prisma.TransactionClient | typeof prisma;

/** The rows a finished run is sent to, owner first. Pure, for a test. */
export function deliveryAddresses(ownerEmail: string, recipients: ReadonlyArray<{ email: string }>): Array<{ email: string; source: DeliverySource; position: number }> {
  const seen = new Set<string>();
  const rows: Array<{ email: string; source: DeliverySource; position: number }> = [];
  const owner = normaliseEmail(ownerEmail);
  rows.push({ email: owner, source: "owner", position: 0 });
  seen.add(owner);
  for (const r of recipients) {
    const email = normaliseEmail(r.email);
    if (seen.has(email)) continue;
    seen.add(email);
    rows.push({ email, source: "recipient", position: rows.length });
  }
  return rows;
}

/**
 * Write a finished run's delivery rows, owner first. A run that did not
 * succeed or finish partial gets none, and neither does a DELETED run
 * (2026-11-20): a render that was already in progress when the run was
 * deleted still stores its PDF, but no email follows it. Idempotent on
 * (run, email). Returns how many rows were new.
 */
export async function enqueueRunDeliveries(db: Db, runId: bigint, now = new Date()): Promise<number> {
  const run = await db.basReportRun.findUnique({
    where: { runId },
    select: {
      status: true,
      deletedAt: true,
      report: {
        select: {
          owner: { select: { email: true } },
          recipients: { select: { email: true }, orderBy: [{ createdAt: "asc" }, { recipientId: "asc" }] },
        },
      },
    },
  });
  if (run === null || run.deletedAt !== null || (run.status !== "succeeded" && run.status !== "partial")) return 0;
  const rows = deliveryAddresses(run.report.owner.email, run.report.recipients);
  const created = await db.basReportDelivery.createMany({
    data: rows.map((r) => ({ runId, email: r.email, source: r.source, position: r.position, nextAttemptAt: now })),
    skipDuplicates: true,
  });
  return created.count;
}

export interface ClaimedDelivery {
  deliveryId: bigint;
  runId: bigint;
  email: string;
  /** This attempt's number, 1 to 3. */
  attempt: number;
}

/**
 * Take the next delivery that is due, or null: pending, its time come, an
 * attempt left; by run, owner first. SKIP LOCKED, so two workers never take
 * the same row; the lease keeps it from the next worker while the call is
 * in flight.
 */
export async function claimNextDelivery(now = new Date()): Promise<ClaimedDelivery | null> {
  const leaseUntil = new Date(now.getTime() + DELIVERY_LEASE_MS);
  const rows = await prisma.$queryRaw<Array<{ delivery_id: bigint; run_id: bigint; email: string; attempts: number }>>`
    UPDATE bas_report_deliveries AS d
       SET attempts = d.attempts + 1, next_attempt_at = ${leaseUntil}, last_error = ${deliveryInProgressSentence(now)}, updated_at = ${now}
     WHERE d.delivery_id = (
       SELECT delivery_id FROM bas_report_deliveries
        WHERE status = 'pending' AND next_attempt_at <= ${now} AND attempts < ${MAX_DELIVERY_ATTEMPTS}
        ORDER BY run_id, position, delivery_id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
    RETURNING d.delivery_id, d.run_id, d.email, d.attempts`;
  const row = rows[0];
  if (row === undefined) return null;
  return { deliveryId: row.delivery_id, runId: row.run_id, email: row.email, attempt: Number(row.attempts) };
}

/** Graph accepted it. Only the attempt that holds the row may write it. */
export async function recordDeliverySent(claim: ClaimedDelivery, requestId: string | null, now = new Date()): Promise<void> {
  await prisma.basReportDelivery.updateMany({
    where: { deliveryId: claim.deliveryId, status: "pending", attempts: claim.attempt },
    data: { status: "sent", sentAt: now, graphRequestId: requestId, lastError: null, nextAttemptAt: now },
  });
}

/**
 * An attempt failed. Retryable with an attempt left: pending again after the
 * backoff. Otherwise failed, which is where Resend starts. Returns the
 * status written.
 */
export async function recordDeliveryFailure(
  claim: ClaimedDelivery,
  message: string,
  retryable: boolean,
  requestId: string | null,
  now = new Date(),
): Promise<"pending" | "failed"> {
  const again = retryable && claim.attempt < MAX_DELIVERY_ATTEMPTS;
  const lastError = again ? message : claim.attempt >= MAX_DELIVERY_ATTEMPTS && retryable ? `${MAX_DELIVERY_ATTEMPTS} attempts failed; the last: ${message}` : message;
  await prisma.basReportDelivery.updateMany({
    where: { deliveryId: claim.deliveryId, status: "pending", attempts: claim.attempt },
    data: again
      ? { status: "pending", nextAttemptAt: new Date(now.getTime() + deliveryBackoffMs(claim.attempt)), lastError, graphRequestId: requestId }
      : { status: "failed", nextAttemptAt: now, lastError, graphRequestId: requestId },
  });
  return again ? "pending" : "failed";
}

/**
 * The send gate is closed: every delivery that is due becomes not_sent, in
 * one statement, before a single claim - so nothing is attempted, nothing
 * is counted as an attempt, and no request leaves. Rows in a backoff or a
 * lease are left for their time. Returns the rows it marked.
 */
export async function markDueDeliveriesNotSent(now = new Date()): Promise<Array<{ deliveryId: bigint; runId: bigint; email: string }>> {
  const rows = await prisma.$queryRaw<Array<{ delivery_id: bigint; run_id: bigint; email: string }>>`
    UPDATE bas_report_deliveries
       SET status = 'not_sent', last_error = ${SEND_DISABLED_MESSAGE}, updated_at = ${now}
     WHERE status = 'pending' AND next_attempt_at <= ${now}
    RETURNING delivery_id, run_id, email`;
  if (rows.length > 0) {
    logger.info("bas.report_delivery_not_sent", { outcome: "not_sent", reason: `${rows.length} delivery(ies): BAS_REPORTS_ALLOW_SEND is not true` });
  }
  return rows.map((r) => ({ deliveryId: r.delivery_id, runId: r.run_id, email: r.email }));
}

/**
 * A pending row whose attempts are used up and whose lease has run out: the
 * worker died during its last attempt. Failed, keeping what the lease said.
 * The worker applies this before it claims; the scheduler on every pass.
 */
export async function failExhaustedDeliveries(now = new Date()): Promise<Array<{ deliveryId: bigint; runId: bigint; email: string }>> {
  const rows = await prisma.$queryRaw<Array<{ delivery_id: bigint; run_id: bigint; email: string }>>`
    UPDATE bas_report_deliveries
       SET status = 'failed',
           last_error = ${`${MAX_DELIVERY_ATTEMPTS} attempts made and the worker stopped during the last; `} || coalesce(last_error, 'no reason recorded'),
           updated_at = ${now}
     WHERE status = 'pending' AND attempts >= ${MAX_DELIVERY_ATTEMPTS} AND next_attempt_at <= ${now}
    RETURNING delivery_id, run_id, email`;
  for (const r of rows) {
    logger.error("bas.report_delivery_stalled", { outcome: "failed", reason: `delivery ${r.delivery_id} of run ${r.run_id}: attempts used up` });
  }
  return rows.map((r) => ({ deliveryId: r.delivery_id, runId: r.run_id, email: r.email }));
}

export const unclaimedDeliveryError = (dueSince: Date, now: Date) =>
  `Waiting for a worker for ${Math.round((now.getTime() - dueSince.getTime()) / 60_000)} minutes and never sent: the worker job is not starting executions, or every execution fails before it reaches the email. Check the worker job's executions (runbook: "A report email did not arrive"), then Resend.`;

/**
 * A delivery due for DELIVERY_UNCLAIMED_AFTER_MS and never taken: the
 * scheduler's spin guard (queue-guards.ts), so a worker that cannot start
 * does not hold the scaler's count above zero all night.
 */
export async function failUnclaimedDeliveries(now = new Date()): Promise<Array<{ deliveryId: bigint; runId: bigint; email: string; error: string }>> {
  const dueBefore = new Date(now.getTime() - DELIVERY_UNCLAIMED_AFTER_MS);
  const stale = await prisma.basReportDelivery.findMany({
    where: { status: "pending", attempts: { lt: MAX_DELIVERY_ATTEMPTS }, nextAttemptAt: { lt: dueBefore } },
    select: { deliveryId: true, runId: true, email: true, nextAttemptAt: true },
    orderBy: { deliveryId: "asc" },
  });
  const failed: Array<{ deliveryId: bigint; runId: bigint; email: string; error: string }> = [];
  for (const d of stale) {
    const error = unclaimedDeliveryError(d.nextAttemptAt, now);
    const updated = await prisma.basReportDelivery.updateMany({
      where: { deliveryId: d.deliveryId, status: "pending", nextAttemptAt: { lt: dueBefore } },
      data: { status: "failed", lastError: error },
    });
    if (updated.count === 0) continue;
    failed.push({ ...d, error });
    logger.error("bas.report_delivery_unclaimed", { outcome: "failed", reason: `delivery ${d.deliveryId} of run ${d.runId} due since ${d.nextAttemptAt.toISOString()} and never taken` });
  }
  return failed;
}
