import type { NextResponse } from "next/server";
import { fail, notFound } from "@/lib/api/response";
import { logUnexpected } from "@/lib/logger";
import { isReviewError, type ReviewError, type ReviewErrorKind } from "./errors";

/**
 * The only place a review failure becomes a status code, mirroring
 * mail/http.ts. The same convention: integration failures are 500 with a
 * distinct machine-readable code, and a Graph 403 is NOT a 403 here - it is
 * the platform's own grant that is missing, not this employee's.
 */
const RESPONSE_FOR: Record<ReviewErrorKind, { status: number; code: string }> = {
  not_configured: { status: 500, code: "review_not_configured" },
  auth_failed: { status: 500, code: "review_auth_failed" },
  folder_forbidden: { status: 500, code: "review_access_denied" },
  not_found: { status: 404, code: "not_found" },
  // 404 rather than 422: the id was well-formed and names something, but not
  // a note in this folder, and "not there" is all a caller needs to know.
  not_a_note: { status: 404, code: "not_found" },
  throttled: { status: 500, code: "review_busy" },
  network: { status: 500, code: "review_unreachable" },
  unexpected: { status: 500, code: "review_error" },
};

export function reviewErrorResponse(error: ReviewError): NextResponse {
  const { status, code } = RESPONSE_FOR[error.kind];

  if (status === 404) return notFound(error.userMessage);

  return fail(status, code, error.userMessage);
}

export function reviewRouteError(route: string, error: unknown): NextResponse {
  if (isReviewError(error)) return reviewErrorResponse(error);

  logUnexpected("review.route_failed", error, { route });
  return fail(500, "server_error", "Something went wrong. Try again.");
}
