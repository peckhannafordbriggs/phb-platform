import { NextResponse } from "next/server";

/**
 * The two response shapes from docs/07-conventions.md. Every route uses these
 * so the frontend never has to special-case a handler.
 */

export type ApiError = {
  error: { code: string; message: string };
};

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ data }, { status });
}

export function fail(
  status: number,
  code: string,
  message: string,
): NextResponse<ApiError> {
  return NextResponse.json({ error: { code, message } }, { status });
}

/**
 * Status codes are fixed by convention, not chosen per route:
 *   401 unauthenticated  403 forbidden  404 missing grant or resource
 *   422 validation       500 unexpected
 *
 * Messages here are deliberately free of detail. A caller who is not authorized
 * learns nothing about why, or about what exists.
 */
export const unauthenticated = () =>
  fail(401, "unauthenticated", "Sign in to continue.");

export const forbidden = (message = "You do not have access to this action.") =>
  fail(403, "forbidden", message);

export const notFound = (message = "Not found.") =>
  fail(404, "not_found", message);

export const validationFailed = (
  message = "The submitted values are not valid.",
) => fail(422, "validation_failed", message);

export const serverError = () =>
  fail(500, "server_error", "Something went wrong. Try again.");
