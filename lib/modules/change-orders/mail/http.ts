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
 * docs/07-conventions.md fixes the status codes: 401, 403, 404, 422, 500. So
 * every integration failure is a 500 with a distinct machine-readable `code`,
 * rather than a status outside that set.
 *
 * Note what is NOT here: nothing maps to 403. A Graph 403 means the platform's
 * own access policy is wrong, not that this employee lacks access - reporting it
 * as 403 would send an operator looking at module grants for a problem that is
 * in Exchange.
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
  unexpected: { status: 500, code: "mail_error" },
};

export function mailErrorResponse(error: MailError): NextResponse {
  const { status, code } = RESPONSE_FOR[error.kind];

  if (status === 404) return notFound(error.userMessage);

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
