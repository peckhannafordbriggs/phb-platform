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
  /**
   * The message is not a draft. Editing or sending a message that has already
   * been sent is refused in the service, not in the UI.
   */
  | "not_draft"
  /**
   * The draft changed in Exchange since it was read. Outlook edits the same
   * mailbox and always wins; this is how the platform notices rather than
   * silently overwriting.
   */
  | "conflict"
  /** Another employee holds the advisory edit lock on this draft. */
  | "locked"
  /**
   * The attachment is over the platform's limit. Refused before the upload
   * starts, not after Exchange rejects the message at send time.
   */
  | "attachment_too_large"
  /**
   * The attachment is executable content, empty, or otherwise something the
   * platform will not put in a message to a vendor.
   */
  | "attachment_rejected"
  /**
   * A move or delete was asked for on something that cannot take it - notably
   * removing an attachment from a message that has already been sent.
   */
  | "not_permitted"
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
  not_draft:
    "This message has already been sent, so it can no longer be edited or sent.",
  conflict:
    "This draft changed in Outlook while you were editing. Reload it to see the current version before saving again.",
  locked: "Someone else in the platform is editing this draft.",
  attachment_too_large:
    "That file is too large to attach. The limit is 25 MB per file.",
  attachment_rejected:
    "That kind of file cannot be attached. Program and script files are not allowed.",
  not_permitted:
    "That is not something that can be done to this message.",
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
