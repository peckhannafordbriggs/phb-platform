import { GraphClientError, GraphError } from "@microsoft/microsoft-graph-client";
import { passThroughError } from "@/lib/mail/graph-client";
import { parseRetryAfter } from "@/lib/mail/retry-after";
import { MailError, type MailErrorKind } from "../mail/errors";

/** Shared with the BAS report sender since 2026-11-17; re-exported under its old path. */
export { parseRetryAfter };

/**
 * The one place a Graph failure becomes a MailError.
 *
 * Everything above this file reasons in MailErrorKind. Nothing above this file
 * imports GraphError, reads `.statusCode`, or matches on a Graph error code.
 */

/**
 * The Graph SDK wraps anything thrown from a middleware into a GraphError,
 * which would flatten a MailError from the token provider into an opaque
 * "statusCode -1" - except for GraphClientError, which it rethrows untouched.
 * The auth middleware uses that as the escape hatch; this carries the original
 * through it.
 */
export function passThroughMailError(error: MailError): never {
  return passThroughError(error);
}

function unwrap(error: unknown): MailError | null {
  if (error instanceof MailError) return error;

  if (error instanceof GraphClientError) {
    const inner: unknown = error.customError;
    if (inner instanceof MailError) return inner;
  }

  return null;
}

/**
 * Graph error codes that mean "that item is not there", whatever status they
 * arrive with.
 *
 * A malformed or stale ID is a 400, not a 404 - verified against the real
 * mailbox. Reporting it as `unexpected` sends an operator looking for a bug in
 * the platform, when the honest answer is the one a 404 gives: the thing you
 * asked for is not there. Power Automate moves messages constantly, so a client
 * holding an ID from a previous listing is ordinary, not exceptional.
 */
const NOT_FOUND_CODES = new Set([
  "ErrorInvalidIdMalformed",
  "ErrorItemNotFound",
  "ErrorFolderNotFound",
  "itemNotFound",
]);

function kindForStatus(statusCode: number, code: string | null): MailErrorKind {
  if (code !== null && NOT_FOUND_CODES.has(code)) return "not_found";

  if (statusCode === 401) return "auth_failed";
  if (statusCode === 403) return "mailbox_forbidden";
  if (statusCode === 404) return "not_found";
  if (statusCode === 429) return "throttled";
  // 503/504 are Graph being unavailable rather than us being wrong. They are
  // already retried once by the throttle middleware, so reaching here means the
  // retry failed too.
  if (statusCode === 503 || statusCode === 504) return "throttled";
  // -1 is the SDK's marker for "no response at all", i.e. the fetch rejected.
  if (statusCode === -1 || statusCode === 0) return "network";
  return "unexpected";
}

/**
 * `detail` carries only the fields Microsoft support asks for: status, error
 * code, request id. Never the response body - docs/07-conventions.md forbids
 * logging message content, and a Graph error body is not worth the risk of
 * one day carrying some.
 */
function detailFor(error: GraphError, operation: string): string {
  const parts = [
    `operation=${operation}`,
    `status=${error.statusCode}`,
    `code=${error.code ?? "none"}`,
  ];
  if (error.requestId !== null) parts.push(`requestId=${error.requestId}`);
  return parts.join(" ");
}

export function mapGraphError(error: unknown, operation: string): MailError {
  const passedThrough = unwrap(error);
  if (passedThrough !== null) return passedThrough;

  if (error instanceof GraphError) {
    const kind = kindForStatus(error.statusCode, error.code);
    const retryAfter =
      kind === "throttled"
        ? parseRetryAfter(error.headers?.get("retry-after") ?? null)
        : null;

    return new MailError(kind, {
      detail: detailFor(error, operation),
      ...(retryAfter !== null ? { retryAfterSeconds: retryAfter } : {}),
      cause: error,
    });
  }

  // A rejected fetch that never reached the SDK's error handler, or a genuine
  // bug in our own code. Both are unexpected; neither should be swallowed.
  return new MailError("unexpected", {
    detail: `operation=${operation} nonGraphError=${
      error instanceof Error ? error.name : typeof error
    }`,
    cause: error,
  });
}
