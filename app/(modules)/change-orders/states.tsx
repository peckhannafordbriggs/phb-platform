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
 *
 * PHASE-9: every error state needs a way forward - "an error with no action is a
 * dead end". So this takes two actions and always renders at least one of them
 * where one exists: `onRetry` for anything transient, `onBack` for anything that
 * will not resolve by trying again. A caller that supplies neither gets a state
 * that says what happened and why there is nothing to press, rather than a
 * button that would do nothing.
 */
export function MailErrorState({
  code,
  message,
  onRetry,
  onBack,
  backLabel = "Back to the list",
}: {
  code: string;
  message: string;
  onRetry?: () => void;
  onBack?: () => void;
  backLabel?: string;
}) {
  const retry =
    onRetry === undefined ? null : (
      <button
        type="button"
        onClick={onRetry}
        className="rounded border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--surface)]"
      >
        Try again
      </button>
    );

  const back =
    onBack === undefined ? null : (
      <button
        type="button"
        onClick={onBack}
        className="rounded border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--surface)]"
      >
        {backLabel}
      </button>
    );

  const actions =
    retry === null && back === null ? undefined : (
      <div className="flex items-center justify-center gap-2">
        {retry}
        {back}
      </div>
    );

  /**
   * The three "the platform cannot reach the mailbox" codes, kept apart from
   * everything else because retrying will not fix any of them and because none
   * of them is this employee's fault.
   *
   * `mail_auth_failed` is the credential-expiry case PHASE-9 asks for by name.
   * In production nothing is supposed to expire - CLAUDE.md forbids a credential
   * that does - but a federated credential misconfigured after a redeploy lands
   * here, and so does a local `.env.local` secret that has run out. What it must
   * never be is a crash or a Graph error string: it is a stated "not connected"
   * with Outlook named as the working path, because Outlook genuinely still
   * works and saying so is the difference between an outage and an inconvenience.
   */
  if (
    code === "mail_not_configured" ||
    code === "mail_auth_failed" ||
    code === "mail_access_denied"
  ) {
    const detail =
      code === "mail_not_configured"
        ? "An administrator needs to finish the Microsoft 365 setup."
        : code === "mail_auth_failed"
          ? "The platform's sign-in to the mailbox is no longer being accepted. An administrator needs to renew it."
          : "The platform is not permitted to read this mailbox. An administrator needs to check the Exchange access policy.";

    return (
      <PaneMessage
        title="Not connected to the mailbox"
        detail={`${detail} Outlook is unaffected and still works normally.`}
        action={actions}
      />
    );
  }

  /**
   * A message or folder that is no longer there. Ordinary rather than broken -
   * Power Automate moves messages constantly, and a moved message is a stale id
   * on every surface that held one. Retrying the same id is pointless, so the
   * action offered is the way back.
   */
  if (code === "not_found") {
    return (
      <PaneMessage
        title="That is no longer in the mailbox"
        detail="It was moved, filed by an automation, or deleted. The list has the current contents."
        action={back ?? actions}
      />
    );
  }

  /** Busy or unreachable: exactly the cases where trying again is the answer. */
  if (code === "mail_busy" || code === "mail_unreachable") {
    return (
      <PaneMessage
        title={code === "mail_busy" ? "The mailbox is busy" : "Could not reach the mailbox"}
        detail={`${message} Nothing was changed.`}
        tone="error"
        action={actions}
      />
    );
  }

  return (
    <PaneMessage title="That did not load" detail={message} tone="error" action={actions} />
  );
}
