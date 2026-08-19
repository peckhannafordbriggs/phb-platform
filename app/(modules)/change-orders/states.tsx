/**
 * The four states every pane needs, in one place so they read identically
 * wherever they appear.
 *
 * PHASE-5: "Every pane needs all four, and they will all occur in practice."
 * The empty state especially - the Drafts folder is genuinely empty most of the
 * day, and it is the first thing the primary user sees.
 */

export function PaneMessage({
  title,
  detail,
  tone = "neutral",
  action,
}: {
  title: string;
  detail?: string;
  tone?: "neutral" | "error";
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <p
          className={
            "text-sm font-medium " +
            (tone === "error" ? "text-red-800" : "text-[var(--foreground)]")
          }
        >
          {title}
        </p>
        {detail !== undefined && (
          <p className="mt-1.5 text-sm text-[var(--muted)]">{detail}</p>
        )}
        {action !== undefined && <div className="mt-4">{action}</div>}
      </div>
    </div>
  );
}

/**
 * Skeletons rather than a spinner. A spinner that is replaced by content shifts
 * the layout every time a folder is opened; a skeleton occupies the space the
 * rows are about to take.
 */
export function MessageListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <ul className="divide-y divide-[var(--border)]" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="px-4 py-3">
          <div className="h-3 w-3/4 animate-pulse rounded bg-[var(--border)]" />
          <div className="mt-2 h-2.5 w-1/2 animate-pulse rounded bg-[var(--border)]" />
          <div className="mt-1.5 h-2.5 w-1/4 animate-pulse rounded bg-[var(--border)]" />
        </li>
      ))}
    </ul>
  );
}

export function ReadingPaneSkeleton() {
  return (
    <div className="p-6" aria-hidden="true">
      <div className="h-4 w-2/3 animate-pulse rounded bg-[var(--border)]" />
      <div className="mt-3 h-3 w-1/3 animate-pulse rounded bg-[var(--border)]" />
      <div className="mt-8 space-y-2.5">
        {Array.from({ length: 8 }, (_, i) => (
          <div
            key={i}
            className="h-3 animate-pulse rounded bg-[var(--border)]"
            style={{ width: `${90 - (i % 4) * 12}%` }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Renders a typed error from the mail service. The `code` comes from
 * lib/modules/change-orders/mail/http.ts, never from Graph, and the message is
 * the non-technical one the service already wrote.
 */
export function MailErrorState({
  code,
  message,
  onRetry,
}: {
  code: string;
  message: string;
  onRetry?: () => void;
}) {
  if (code === "mail_not_configured") {
    return (
      <PaneMessage
        title="The mailbox is not connected yet"
        detail="An administrator needs to finish the Microsoft 365 setup. Outlook is unaffected and still works normally."
      />
    );
  }

  return (
    <PaneMessage
      title="That did not load"
      detail={message}
      tone="error"
      action={
        onRetry === undefined ? undefined : (
          <button
            type="button"
            onClick={onRetry}
            className="rounded border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--surface)]"
          >
            Try again
          </button>
        )
      }
    />
  );
}
