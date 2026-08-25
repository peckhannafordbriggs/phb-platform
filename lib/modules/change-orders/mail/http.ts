import type { NextResponse } from "next/server";
import { fail, notFound } from "@/lib/api/response";
import { logUnexpected } from "@/lib/logger";
import { isMailError, type MailError, type MailErrorKind } from "./errors";

/**
 * The only place a mail failure becomes a status code, mirroring
 * lib/authz/http.ts.
 *
 * Route handlers call this rather than mapping kinds themselves, so a new kind
 * cannot be introduced without a decision about how it is reported.
 */

/**
 * docs/07-conventions.md fixes the status codes for the platform's own failures:
 * 401, 403, 404, 422, 500. Integration failures are 500 with a distinct
 * machine-readable `code` rather than a status outside that set.
 *
 * Two Phase 6 kinds use 409, which is outside that list on purpose. A conflict
 * and a held lock are neither a fault nor a permission problem - they are "the
 * world moved, ask again", and the browser has to tell them apart from a 500 to
 * offer a reload rather than a retry.
 *
 * Note what a Graph 403 does NOT map to: a 403 response. It means the platform's
 * own access policy is wrong, not that this employee lacks access - reporting it
 * as 403 would send an operator looking at module grants for a problem that is
 * in Exchange. `not_draft` is the one true 403: understood, and refused on the
 * state of the message.
 */
const RESPONSE_FOR: Record<MailErrorKind, { status: number; code: string }> = {
  not_configured: { status: 500, code: "mail_not_configured" },
  auth_failed: { status: 500, code: "mail_auth_failed" },
  mailbox_forbidden: { status: 500, code: "mail_access_denied" },
  not_found: { status: 404, code: "not_found" },
  throttled: { status: 500, code: "mail_busy" },
  network: { status: 500, code: "mail_unreachable" },
  send_not_allowed: { status: 500, code: "mail_send_disabled" },
  write_not_allowed: { status: 500, code: "mail_write_disabled" },
  // 403 rather than 500: the request was understood and refused on the state of
  // the message, which is the caller's problem to resolve rather than a fault.
  not_draft: { status: 403, code: "mail_not_draft" },
  conflict: { status: 409, code: "mail_conflict" },
  locked: { status: 409, code: "mail_locked" },
  // 422 rather than 500: the request was well-formed and the value in it was
  // not acceptable, which is what 422 is for. The browser shows the reason
  // beside the file picker rather than a failure pane.
  attachment_too_large: { status: 422, code: "mail_attachment_too_large" },
  attachment_rejected: { status: 422, code: "mail_attachment_rejected" },
  // 403, for the same reason not_draft is: understood, and refused on the state
  // of the message rather than on who is asking.
  not_permitted: { status: 403, code: "mail_not_permitted" },
  unexpected: { status: 500, code: "mail_error" },
};

export function mailErrorResponse(error: MailError): NextResponse {
  const { status, code } = RESPONSE_FOR[error.kind];

  if (error.kind === "not_found") return notFound(error.userMessage);

  // Only the user-facing half of the error crosses the wire. `detail` was
  // already logged by the service.
  return fail(status, code, error.userMessage);
}

/**
 * For a route that has no more specific handling: a MailError becomes its mapped
 * response, anything else is a genuine bug and becomes a 500 with the detail in
 * the log.
 */
export function mailRouteError(route: string, error: unknown): NextResponse {
  if (isMailError(error)) return mailErrorResponse(error);

  logUnexpected("mail.route_failed", error, { route });
  return fail(500, "server_error", "Something went wrong. Try again.");
}
