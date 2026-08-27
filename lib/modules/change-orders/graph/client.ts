import {
  Client,
  type Context,
  type Middleware,
} from "@microsoft/microsoft-graph-client";
import { logger } from "@/lib/logger";
import { MailError } from "../mail/errors";
import { graphTokenProvider, type TokenProvider } from "./credential";
import { passThroughMailError, parseRetryAfter } from "./errors";
import { getHeader, setHeader } from "./headers";
import { noteThrottleRetry } from "./retry-notice";

/**
 * The Graph client factory. Nothing outside lib/modules/change-orders/graph
 * constructs a Client, and nothing outside the mail service holds one.
 *
 * The middleware chain is written out rather than taken from the SDK's default
 * factory, because two of its properties are requirements rather than defaults:
 * the ImmutableId header must be unforgettable, and a throttled request must be
 * retried exactly once.
 */

export const IMMUTABLE_ID_PREFER = 'IdType="ImmutableId"';

const GRAPH_BASE_URL = "https://graph.microsoft.com";
const GRAPH_VERSION = "v1.0";

/** Graph statuses worth one more attempt. */
const RETRYABLE_STATUSES = new Set([429, 503, 504]);

/** Used when Graph throttles without saying for how long. */
const DEFAULT_RETRY_AFTER_SECONDS = 5;

/**
 * A Retry-After longer than this is not worth holding a request open for; the
 * caller gets a "mailbox is busy" and can try again.
 */
const MAX_RETRY_AFTER_SECONDS = 30;

/**
 * Sets `Prefer: IdType="ImmutableId"` on every outgoing request.
 *
 * docs/03-exchange-and-graph.md: without this header a message ID changes when
 * the message moves folders, and Power Automate moves messages constantly. An ID
 * captured without it goes stale silently - the worst kind of bug to find later.
 *
 * It lives in the chain rather than at the call sites so that forgetting it is
 * not something a call site is able to do. First in the chain, so a test that
 * observes requests at the transport boundary proves the whole chain preserves
 * it.
 */
class ImmutableIdMiddleware implements Middleware {
  private next: Middleware | undefined;

  async execute(context: Context): Promise<void> {
    const existing = getHeader(context.options, "Prefer");

    if (existing === null) {
      setHeader(context.options, "Prefer", IMMUTABLE_ID_PREFER);
    } else if (!existing.includes("IdType=")) {
      // Prefer is a comma-separated list; a caller asking for something else
      // must not cost us immutable IDs.
      setHeader(context.options, "Prefer", `${existing}, ${IMMUTABLE_ID_PREFER}`);
    }

    await this.next?.execute(context);
  }

  setNext(next: Middleware): void {
    this.next = next;
  }
}

/**
 * Attaches the bearer token.
 *
 * Inside the retry middleware rather than outside it, so a retry after a long
 * Retry-After wait re-reads the token cache instead of resending an older one.
 */
class AuthMiddleware implements Middleware {
  private next: Middleware | undefined;

  constructor(private readonly tokenProvider: TokenProvider) {}

  async execute(context: Context): Promise<void> {
    let token: string;
    try {
      token = await this.tokenProvider();
    } catch (error) {
      // The SDK flattens anything thrown here into an opaque GraphError.
      // passThroughMailError keeps the real reason intact.
      if (error instanceof MailError) passThroughMailError(error);
      throw error;
    }

    setHeader(context.options, "Authorization", `Bearer ${token}`);
    await this.next?.execute(context);
  }

  setNext(next: Middleware): void {
    this.next = next;
  }
}

/**
 * Retries a throttled request once, honouring Retry-After.
 *
 * Once, deliberately. Graph concentrates throttling on a single mailbox through
 * a single app identity, so retrying harder makes the throttle worse rather than
 * better. A second failure is surfaced to the caller.
 */
class ThrottleRetryMiddleware implements Middleware {
  private next: Middleware | undefined;

  constructor(private readonly sleep: (ms: number) => Promise<void>) {}

  async execute(context: Context): Promise<void> {
    await this.next?.execute(context);

    const response = context.response;
    if (response === undefined || !RETRYABLE_STATUSES.has(response.status)) {
      return;
    }

    const requested = parseRetryAfter(response.headers.get("retry-after"));
    const waitSeconds = Math.min(
      requested ?? DEFAULT_RETRY_AFTER_SECONDS,
      MAX_RETRY_AFTER_SECONDS,
    );

    logger.warn("graph.throttled", {
      status: response.status,
      reason: `retryAfterSeconds=${waitSeconds}`,
      outcome: "retrying_once",
    });

    setHeader(context.options, "Retry-Attempt", "1");

    // Recorded before the wait, not after: if the retry itself fails the caller
    // still gets a MailError, and the route still wants to say that the delay
    // it just sat through was a throttle rather than a slow mailbox.
    noteThrottleRetry(waitSeconds);

    await this.sleep(waitSeconds * 1000);
    await this.next?.execute(context);

    if (context.response !== undefined && !context.response.ok) {
      logger.warn("graph.throttle_retry_failed", {
        status: context.response.status,
        outcome: "surfaced",
      });
    }
  }

  setNext(next: Middleware): void {
    this.next = next;
  }
}

/**
 * The transport. Last in the chain, and the only place a request leaves the
 * process.
 *
 * `fetchImpl` is injectable so tests can intercept at the HTTP layer with
 * recorded fixtures - which means the middleware chain, the URL construction,
 * the headers and the error mapping under test are all the real ones.
 */
class FetchMiddleware implements Middleware {
  constructor(private readonly fetchImpl: typeof fetch) {}

  async execute(context: Context): Promise<void> {
    context.response = await this.fetchImpl(
      context.request as RequestInfo,
      context.options as RequestInit,
    );
  }
}

export interface GraphTransport {
  tokenProvider: TokenProvider;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function createGraphClient(transport: GraphTransport): Client {
  const fetchImpl = transport.fetchImpl ?? globalThis.fetch;
  const sleep = transport.sleep ?? realSleep;

  return Client.initWithMiddleware({
    baseUrl: GRAPH_BASE_URL,
    defaultVersion: GRAPH_VERSION,
    middleware: [
      new ImmutableIdMiddleware(),
      new ThrottleRetryMiddleware(sleep),
      new AuthMiddleware(transport.tokenProvider),
      new FetchMiddleware(fetchImpl),
    ],
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
