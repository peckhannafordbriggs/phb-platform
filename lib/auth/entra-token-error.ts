import { logger, type LogFields } from "@/lib/logger";

/**
 * Entra's AADSTS code, into the container log.
 *
 * When Entra refuses a token exchange it answers with a JSON body - `error`,
 * `error_description` (which starts with the AADSTS code), `error_codes`,
 * `trace_id`, `correlation_id`, `timestamp`. Auth.js reads that body, throws
 * `OAuthCallbackError("OAuth Provider returned an error: invalid_client")`,
 * and DISCARDS the body: it is passed to the Error constructor as its options
 * object, and `Error` reads only `options.cause` from that, so `error.cause`
 * is `undefined` (measured against @auth/core 0.41.3). No custom Auth.js
 * logger can print what is no longer there. Four production sign-in attempts
 * on 2026-09-28 logged `invalid_client` and nothing else, with the federated
 * identity credential in place and no way to tell whether Entra had rejected
 * the assertion or never received one.
 *
 * The one place in this platform that sees the body is the fetch wrapper that
 * adds the assertion, because Auth.js hands it the token endpoint's Response.
 * So the wrapper calls this on any non-2xx answer from that endpoint, reads a
 * CLONE of the body, and logs a whitelist of its fields. The whitelist is the
 * point: docs/07-conventions.md forbids tokens in the log, an Entra error body
 * carries none, and copying field by field keeps that true if the body ever
 * changes shape.
 */

/** The fields of Entra's error body that are copied, and nothing else. */
const ENTRA_STRING_FIELDS = {
  error: "entraError",
  error_description: "entraErrorDescription",
  trace_id: "entraTraceId",
  correlation_id: "entraCorrelationId",
  timestamp: "entraTimestamp",
} as const;

const AADSTS_CODE = /AADSTS\d+/;

export const ENTRA_TOKEN_ERROR_EVENT = "auth.entra_token_error";

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Pure: the fields to log for a token endpoint response. Exported so the test
 * asserts on the record rather than on console output.
 */
export function describeEntraTokenError(status: number, body: unknown): LogFields {
  const fields: LogFields = { status };
  if (body === null || typeof body !== "object") return fields;
  const source = body as Record<string, unknown>;

  for (const [entraKey, logKey] of Object.entries(ENTRA_STRING_FIELDS)) {
    const value = stringField(source, entraKey);
    if (value !== undefined) fields[logKey] = value;
  }

  // The code opens the description - "AADSTS70021: No matching federated
  // identity record..." - and is also a number in `error_codes`. The
  // description is preferred because it is what a person searches for; the
  // array is the fallback for a body with no description.
  const fromDescription = fields.entraErrorDescription?.match(AADSTS_CODE)?.[0];
  const codes = source.error_codes;
  const fromArray =
    Array.isArray(codes) && typeof codes[0] === "number" ? `AADSTS${codes[0]}` : undefined;
  const code = fromDescription ?? fromArray;
  if (code !== undefined) fields.entraErrorCode = code;

  return fields;
}

/**
 * Logs a failed token endpoint response without consuming it. Reads a clone,
 * so the caller's body is untouched; a body that is not JSON logs the status
 * alone. Never throws: a logging failure must not turn into a sign-in failure.
 */
export async function logEntraTokenError(response: Response): Promise<void> {
  let body: unknown = null;
  try {
    body = await response.clone().json();
  } catch {
    body = null;
  }
  logger.error(ENTRA_TOKEN_ERROR_EVENT, describeEntraTokenError(response.status, body));
}
