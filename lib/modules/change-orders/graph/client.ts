import type { Client } from "@microsoft/microsoft-graph-client";
import {
  IMMUTABLE_ID_PREFER,
  createSharedGraphClient,
} from "@/lib/mail/graph-client";
import { MailError } from "../mail/errors";
import { graphTokenProvider, type TokenProvider } from "./credential";
import { noteThrottleRetry } from "./retry-notice";

/**
 * The Change Orders Graph client. Nothing outside lib/modules/change-orders/graph
 * constructs one for the mail module, and nothing outside the mail service
 * holds one.
 *
 * The middleware chain itself - the ImmutableId header that cannot be
 * forgotten, the one throttle retry, the token, the transport - is
 * lib/mail/graph-client.ts since 2026-11-17, shared with the BAS report
 * sender. What is this module's is wired here: a MailError from the token
 * provider keeps its kind through the SDK, and a throttle retry is noted for
 * the route that is waiting on it (retry-notice.ts).
 */

export { IMMUTABLE_ID_PREFER };

export interface GraphTransport {
  tokenProvider: TokenProvider;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const isMailError = (error: unknown): error is MailError => error instanceof MailError;

export function createGraphClient(transport: GraphTransport): Client {
  return createSharedGraphClient({
    ...transport,
    passThrough: isMailError,
    onThrottleRetry: noteThrottleRetry,
  });
}

let memoisedClient: Client | null = null;

/**
 * The process-wide client, built from configuration. Memoised so the token
 * cache behind it survives between requests.
 *
 * Throws MailError("not_configured") when there is no credential - callers
 * check first rather than catching, see mailboxConnectionStatus().
 */
export function graphClient(): Client {
  if (memoisedClient !== null) return memoisedClient;

  memoisedClient = createGraphClient({ tokenProvider: graphTokenProvider() });
  return memoisedClient;
}
