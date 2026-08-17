import { GraphClientError, GraphError } from "@microsoft/microsoft-graph-client";
import { MailError, type MailErrorKind } from "../mail/errors";

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
  const wrapper = new GraphClientError(error.message);
  wrapper.customError = error;
  throw wrapper;
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
 * Graph reports throttling with Retry-After, either as seconds or as an HTTP
 * date. Anything unparseable is treated as absent rather than as zero.
 */
export function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;

  const trimmed = header.trim();
  if (trimmed.length === 0) return null;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? Math.ceil(seconds) : null;
  }

  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return null;

  const delta = Math.ceil((asDate - Date.now()) / 1000);
  return delta > 0 ? delta : 0;
}

function kindForStatus(statusCode: number): MailErrorKind {
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
    const kind = kindForStatus(error.statusCode);
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
