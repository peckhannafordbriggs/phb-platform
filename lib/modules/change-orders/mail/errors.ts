/**
 * The failure vocabulary of the mail boundary.
 *
 * Callers branch on `kind`. They never see an HTTP status code, a Graph error
 * string, or a GraphError instance - that is the whole point of the boundary.
 * If a new Graph failure needs distinct handling, it gets a kind here; it does
 * not get a status-code check at the call site.
 */

export type MailErrorKind =
  /** No Graph credential is configured. A deployment problem, not a user one. */
  | "not_configured"
  /** The credential exists but Entra would not issue a token for it. */
  | "auth_failed"
  /**
   * Graph answered 403. Overwhelmingly the ApplicationAccessPolicy denying the
   * mailbox - see docs/runbook.md. Never means "this employee lacks access";
   * employee authorization happens well before we reach Graph.
   */
  | "mailbox_forbidden"
  /** The folder or message is gone. Power Automate moves things constantly. */
  | "not_found"
  /** Graph throttled us. Already retried once. */
  | "throttled"
  /** The request never got an answer. */
  | "network"
  /** PHB_ALLOW_SEND is not true. */
  | "send_not_allowed"
  /** Non-production write attempted against a message that is not a ZZTEST. */
  | "write_not_allowed"
  | "unexpected";

/**
 * `message` is the non-technical string a browser may see. `detail` is the
 * diagnostic half and is logged server-side only - it must never be serialised
 * into a response. Keeping them as separate fields is what makes that rule
 * mechanical rather than a habit.
 */
const USER_MESSAGES: Record<MailErrorKind, string> = {
  not_configured:
    "The change-order mailbox is not connected yet. Contact IT and keep using Outlook in the meantime.",
  auth_failed:
    "The platform could not sign in to the change-order mailbox. Contact IT.",
  mailbox_forbidden:
    "The platform is not permitted to read the change-order mailbox. Contact IT.",
  not_found: "That item is no longer in the mailbox.",
  throttled: "The mailbox is busy. Try again in a moment.",
  network: "The mailbox could not be reached. Try again in a moment.",
  send_not_allowed: "Sending is disabled in this environment.",
  write_not_allowed: "This message cannot be modified in this environment.",
  unexpected: "Something went wrong reaching the mailbox. Try again.",
};

export class MailError extends Error {
  readonly kind: MailErrorKind;
  /** Server-side diagnostics. Never returned to a browser. */
  readonly detail: string | null;
  /** Present on `throttled`, from Graph's Retry-After. */
  readonly retryAfterSeconds: number | null;

  constructor(
    kind: MailErrorKind,
    options: { detail?: string; retryAfterSeconds?: number; cause?: unknown } = {},
  ) {
    // The Error message is the user-facing one, so an accidental
    // `String(error)` anywhere leaks nothing.
    super(USER_MESSAGES[kind], { cause: options.cause });
    this.name = "MailError";
    this.kind = kind;
    this.detail = options.detail ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }

  /** Alias for readability at call sites that render it. */
  get userMessage(): string {
    return this.message;
  }
}

export function isMailError(error: unknown): error is MailError {
  return error instanceof MailError;
}
