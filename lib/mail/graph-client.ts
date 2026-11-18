import {
  Client,
  GraphClientError,
  type Context,
  type Middleware,
} from "@microsoft/microsoft-graph-client";
import { logger } from "@/lib/logger";
import { getHeader, setHeader } from "./headers";
import { parseRetryAfter } from "./retry-after";

/**
 * The Graph client factory, shared since 2026-11-17 by the two places the
 * platform talks to Exchange as an application: the Change Orders mail
 * service (lib/modules/change-orders/graph/client.ts, which wraps this with
 * its own error vocabulary and its throttle notice) and the BAS report
 * sender (lib/modules/bas/reports/email/mailer.ts, the worker job only).
 *
 * The middleware chain is written out rather than taken from the SDK's default
 * factory, because two of its properties are requirements rather than defaults:
 * the ImmutableId header must be unforgettable, and a throttled request must be
 * retried exactly once.
 *
 * Nothing here reads the environment, and nothing here knows which app
 * registration or mailbox it is talking to: the token provider decides the
 * first and the caller's URL the second. That is what lets the Reports worker,
 * whose import graph must never reach lib/env.ts, use the same chain.
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

/** Returns a bearer token. The only thing the Graph client needs to know. */
export type TokenProvider = () => Promise<string>;

/**
 * The Graph SDK wraps anything thrown from a middleware into a GraphError,
 * which would flatten a caller's own error from the token provider into an
 * opaque "statusCode -1" - except for GraphClientError, which it rethrows
 * untouched. The auth middleware uses that as the escape hatch; this carries
 * the original through it, as `customError`.
 */
export function passThroughError(error: Error): never {
  const wrapper = new GraphClientError(error.message);
  wrapper.customError = error;
  throw wrapper;
}

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

  constructor(
    private readonly tokenProvider: TokenProvider,
    private readonly passThrough: (error: unknown) => error is Error,
  ) {}

  async execute(context: Context): Promise<void> {
    let token: string;
    try {
      token = await this.tokenProvider();
    } catch (error) {
      // The SDK flattens anything thrown here into an opaque GraphError.
      // An error the caller recognises keeps its real reason intact.
      if (this.passThrough(error)) passThroughError(error);
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

  constructor(
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly onRetry: (waitSeconds: number) => void,
  ) {}

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
    // still gets its error, and a caller that reports the delay wants to say
    // that the delay it just sat through was a throttle rather than a slow
    // mailbox.
    this.onRetry(waitSeconds);

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

export interface SharedGraphTransport {
  tokenProvider: TokenProvider;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Which errors from the token provider keep their identity through the
   * SDK. Change Orders passes its MailError; anything else is wrapped by the
   * SDK as it always was.
   */
  passThrough?: (error: unknown) => error is Error;
  /** Told the seconds of each throttle wait, before the wait. */
  onThrottleRetry?: (waitSeconds: number) => void;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const passNothing = (error: unknown): error is Error => {
  void error;
  return false;
};

export function createSharedGraphClient(transport: SharedGraphTransport): Client {
  const fetchImpl = transport.fetchImpl ?? globalThis.fetch;
  const sleep = transport.sleep ?? realSleep;

  return Client.initWithMiddleware({
    baseUrl: GRAPH_BASE_URL,
    defaultVersion: GRAPH_VERSION,
    middleware: [
      new ImmutableIdMiddleware(),
      new ThrottleRetryMiddleware(sleep, transport.onThrottleRetry ?? (() => {})),
      new AuthMiddleware(transport.tokenProvider, transport.passThrough ?? passNothing),
      new FetchMiddleware(fetchImpl),
    ],
  });
}
