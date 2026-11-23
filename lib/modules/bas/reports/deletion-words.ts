/**
 * Deleting a report run, in words and numbers (2026-11-20). No imports: the
 * Reports list and Recently deleted (client components), the editor, the
 * service and the scheduler job all read these, and a client component that
 * imports anything reaching @/lib/db breaks the build.
 *
 * A deleted run sits in Recently deleted for RECYCLE_DAYS, then the
 * scheduler purges it for good. "Keep generated runs for" on a report moves
 * its older runs there the same way.
 */

/** How long a deleted run can be restored before the scheduler purges it. */
export const RECYCLE_DAYS = 15;
export const RECYCLE_MS = RECYCLE_DAYS * 24 * 60 * 60 * 1000;

/** The retention choices a report offers, in months; null is never. */
export const RUN_RETENTION_MONTHS = [3, 6, 12] as const;
export type RunRetentionMonths = (typeof RUN_RETENTION_MONTHS)[number];

export function isRunRetentionMonths(value: unknown): value is RunRetentionMonths {
  return typeof value === "number" && (RUN_RETENTION_MONTHS as readonly number[]).includes(value);
}

/** The editor's options, never first. */
export const RUN_RETENTION_OPTIONS: ReadonlyArray<{ value: "never" | `${RunRetentionMonths}`; label: string }> = [
  { value: "never", label: "Never" },
  { value: "3", label: "3 months" },
  { value: "6", label: "6 months" },
  { value: "12", label: "12 months" },
];

/** "Keeps runs 6 months", for the Scheduled list's summary line; null for never, which says nothing. */
export function describeRunRetention(months: RunRetentionMonths | null): string | null {
  return months === null ? null : `Keeps runs ${months} months`;
}

/**
 * The instant `months` calendar months before `now`, in UTC, the day clamped
 * to the target month's last day - 31 May less three months is 28 (or 29)
 * February, never 3 March. A run created before it is older than the setting.
 */
export function monthsBefore(now: Date, months: number): Date {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() - months;
  const targetYear = y + Math.floor(m / 12);
  const targetMonth = ((m % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      Math.min(now.getUTCDate(), lastDay),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  );
}

/** When a run deleted at `deletedAt` is due to be purged. */
export function purgeDueAt(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + RECYCLE_MS);
}

/**
 * Whole days left before the purge, rounded up: 15 on the day it was
 * deleted, 1 in its last day, 0 once it is due (the next scheduler pass,
 * within fifteen minutes, removes it).
 */
export function daysRemaining(deletedAt: Date, now: Date): number {
  const left = purgeDueAt(deletedAt).getTime() - now.getTime();
  return left <= 0 ? 0 : Math.ceil(left / (24 * 60 * 60 * 1000));
}

export function describeDaysRemaining(days: number): string {
  if (days <= 0) return "Purged at the next pass";
  return days === 1 ? "1 day left" : `${days} days left`;
}

/** Who moved a run to Recently deleted, in the list's words. */
export function describeDeletedBy(by: "person" | "retention", email: string | null, retentionMonths: RunRetentionMonths | null): string {
  if (by === "retention") return retentionMonths === null ? "Retention" : `Retention (${retentionMonths} months)`;
  return email ?? "A person whose account is gone";
}

/** The confirm dialog's heading and sentence, from the count. */
export function deleteConfirmHeading(count: number): string {
  return count === 1 ? "Delete 1 run?" : `Delete ${count} runs?`;
}

export const DELETE_CONFIRM_SENTENCE = `They leave this list now and go to Recently deleted, where they can be restored for ${RECYCLE_DAYS} days. After that they are removed for good, with their findings, PDF and email record. No email goes out for a deleted run.`;

/** What a PDF render queued when its run was deleted says afterwards. Retry PDF after a restore renders it. */
export const PDF_DELETED_SENTENCE =
  "Not rendered: the run was deleted while its PDF was queued. Restore the run, then use Retry PDF.";

/** What a delivery still waiting when its run was deleted says afterwards. Resend after a restore sends it. */
export const DELIVERY_DELETED_SENTENCE =
  "Not sent: the run was deleted before this email went out. Restore the run, then use Resend.";

// ---------------------------------------------------------------------------
// Deleting a report (the definition), 2026-11-20
// ---------------------------------------------------------------------------

/** Beside a run whose report was deleted: no more will come. */
export const SCHEDULE_DELETED_LABEL = "(schedule deleted)";

export function reportDeleteHeading(name: string): string {
  return `Delete the report "${name}"?`;
}

/** The confirmation's sentence: future runs stop, and every generated report stays. */
export function reportDeleteSentence(runCount: number): string {
  if (runCount === 0) return "This stops future runs. It has no generated reports.";
  return runCount === 1
    ? "This stops future runs. The 1 generated report stays."
    : `This stops future runs. The ${runCount} generated reports stay.`;
}

/** Why Delete is greyed while a run is in flight. */
export const REPORT_DELETE_IN_FLIGHT_TITLE = "A run of this report is queued or running. Delete it once the run has finished.";
