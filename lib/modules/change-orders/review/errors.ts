import { mapGraphError } from "../graph/errors";
import { isMailError, type MailErrorKind } from "../mail/errors";

/**
 * The failure vocabulary of the Needs Review boundary.
 *
 * The same shape as MailError and for the same reason: routes and components
 * branch on `kind`, never on an HTTP status, a Graph error code or a GraphError
 * instance. The vocabulary is smaller because the surface is - this module
 * reads one folder and writes nothing, so there is no conflict, no lock, no
 * send gate and no attachment rule to name.
 */
export type ReviewErrorKind =
  /** No review app registration or folder is configured. A deployment state. */
  | "not_configured"
  /** The credential exists but Entra would not issue a token for it. */
  | "auth_failed"
  /**
   * Graph answered 403. The app registration has consent but no grant on the
   * folder, or the grant was removed - runbook.md. Never "this employee lacks
   * access"; employee authorization happens before Graph is reached.
   */
  | "folder_forbidden"
  /** The folder or the note is gone. A person archives notes by moving them. */
  | "not_found"
  /**
   * The id names something that is not a review note: not a child of the
   * folder, not named `NEEDS REVIEW - … .txt`, or too large to be one. Refused
   * before any content is read.
   */
  | "not_a_note"
  /** Graph throttled us. Already retried once. */
  | "throttled"
  /** The request never got an answer. */
  | "network"
  | "unexpected";

const USER_MESSAGES: Record<ReviewErrorKind, string> = {
  not_configured:
    "Needs Review is not connected yet. The folder is still readable in SharePoint; contact IT about the platform's access.",
  auth_failed:
    "The platform could not sign in to read the review folder. Contact IT.",
  folder_forbidden:
    "The platform is not permitted to read the review folder. Contact IT.",
  not_found: "That note is no longer in the review folder.",
  not_a_note: "That is not a review note.",
  throttled: "SharePoint is busy. Try again in a moment.",
  network: "SharePoint could not be reached. Try again in a moment.",
  unexpected: "Something went wrong reading the review folder. Try again.",
};

export class ReviewError extends Error {
  readonly kind: ReviewErrorKind;
  /** Server-side diagnostics. Never returned to a browser. */
  readonly detail: string | null;

  constructor(
    kind: ReviewErrorKind,
    options: { detail?: string; cause?: unknown } = {},
  ) {
    // The Error message is the user-facing one, so an accidental
    // `String(error)` anywhere leaks nothing.
    super(USER_MESSAGES[kind], { cause: options.cause });
    this.name = "ReviewError";
    this.kind = kind;
    this.detail = options.detail ?? null;
  }

  get userMessage(): string {
    return this.message;
  }
}

export function isReviewError(error: unknown): error is ReviewError {
  return error instanceof ReviewError;
}

/**
 * The mail module's Graph mapping, translated.
 *
 * `mapGraphError` already knows how the SDK wraps a failure, which status is
 * throttling, and which Graph codes mean "not there" whatever status they
 * arrive with. Reusing it means a Graph behaviour learned against the mailbox
 * is learned once. Only the names change: a 403 here is the folder grant, not
 * the mailbox policy.
 */
const KIND_FROM_MAIL: Record<MailErrorKind, ReviewErrorKind> = {
  not_configured: "not_configured",
  auth_failed: "auth_failed",
  mailbox_forbidden: "folder_forbidden",
  not_found: "not_found",
  throttled: "throttled",
  network: "network",
  send_not_allowed: "unexpected",
  write_not_allowed: "unexpected",
  not_draft: "unexpected",
  conflict: "unexpected",
  locked: "unexpected",
  attachment_too_large: "unexpected",
  attachment_rejected: "unexpected",
  not_permitted: "unexpected",
  unexpected: "unexpected",
};

export function toReviewError(error: unknown, operation: string): ReviewError {
  if (isReviewError(error)) return error;

  const mapped = mapGraphError(error, operation);
  return new ReviewError(KIND_FROM_MAIL[mapped.kind], {
    detail: mapped.detail ?? undefined,
    cause: isMailError(error) ? error : mapped.cause,
  });
}
