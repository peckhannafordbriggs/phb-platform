import {
  describeAuditEvent,
  type DescribableAuditEvent,
} from "@/lib/admin/audit-describe";

/**
 * One rendering of the audit log, used by both places that show it.
 *
 * The audit page and the inline history on an employee's detail page render the
 * same rows through the same `describeAuditEvent`. Two renderers would
 * eventually disagree about what an action means, and the log is the one place
 * in the platform where that is not a cosmetic problem: under app-only Graph
 * auth these rows are the only record of which *person* sent a message.
 *
 * A server component. Nothing here is interactive.
 */

export interface AuditListRow extends DescribableAuditEvent {
  id: string;
  occurredAt: Date;
}

export function AuditList({
  events,
  moduleNames,
  /**
   * Suppresses the "to <person>" half of a row.
   *
   * On an employee's own page every row is about them, so repeating the name on
   * every line is noise. On the audit page it is the most important column.
   */
  hideTarget = false,
  emptyMessage,
}: {
  events: AuditListRow[];
  moduleNames: ReadonlyMap<string, string>;
  hideTarget?: boolean;
  emptyMessage: string;
}) {
  if (events.length === 0) {
    return <p className="px-4 py-6 text-sm text-[var(--muted)]">{emptyMessage}</p>;
  }

  return (
    <ul className="divide-y divide-[var(--border)]">
      {events.map((event) => {
        const described = describeAuditEvent(event, moduleNames);

        return (
          <li key={event.id} className="px-4 py-3 text-sm">
            <p className={described.known ? "" : "font-mono text-xs"}>
              {described.sentence}
              {/*
                PHASE-10 asks for self-changed versus admin-changed to be
                distinguishable. It is in the sentence already - "changed their
                own position" - and the badge makes it scannable down a column
                of a hundred rows, which the sentence alone is not.
              */}
              {described.self && (
                <span className="ml-2 rounded bg-[var(--surface)] px-1.5 py-0.5 text-[0.625rem] font-medium uppercase text-[var(--muted)]">
                  self
                </span>
              )}
              {/*
                An action this build has no wording for. Marked rather than
                dressed up: a later phase adds actions, and a viewer that
                invented plausible prose for one it did not recognise would be
                worse than one that admits it.
              */}
              {!described.known && (
                <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[0.625rem] font-medium uppercase text-amber-900">
                  unrecognised action
                </span>
              )}
            </p>

            <p className="mt-0.5 text-xs text-[var(--muted)]">
              <time dateTime={event.occurredAt.toISOString()}>
                {formatDateTime(event.occurredAt)}
              </time>
              {!hideTarget && described.targetLabel !== null && (
                <> · about {described.targetLabel}</>
              )}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

function formatDateTime(value: Date): string {
  return value.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
