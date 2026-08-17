import { expect } from "vitest";
import { IMMUTABLE_ID_PREFER } from "@/lib/modules/change-orders/graph/client";
import type { GraphTransport } from "@/lib/modules/change-orders/graph/client";

/**
 * A mocked Graph transport.
 *
 * The interception point is the HTTP layer, so everything above it is the real
 * thing: the real middleware chain, the real header handling, the real URL
 * construction, the real error mapping, the real service. Mocking the mail
 * service instead would only prove the mock agrees with the test.
 */

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

export interface GraphStub {
  transport: GraphTransport;
  requests: RecordedRequest[];
  /** Milliseconds passed to the retry middleware, in order. */
  sleeps: number[];
  /** Token provider invocations, for proving the token is cached. */
  tokenCalls: () => number;
}

/** Given the request, return the response Graph would have sent. */
export type Responder = (
  request: RecordedRequest,
  index: number,
) => Response | Promise<Response>;

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

/** The shape Graph actually returns on failure, so the SDK parses it for real. */
export function graphErrorResponse(
  status: number,
  code: string,
  message = "test failure",
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(
    {
      error: {
        code,
        message,
        innerError: { "request-id": "test-request-id", date: "2026-08-17T00:00:00Z" },
      },
    },
    { status, headers },
  );
}

/**
 * `responder` may be a single function, or an array used once each in order -
 * which is how a retry test asserts the first attempt failed and the second
 * succeeded.
 */
export function createGraphStub(
  responder: Responder | Responder[],
  options: { token?: string } = {},
): GraphStub {
  const requests: RecordedRequest[] = [];
  const sleeps: number[] = [];
  let tokenCalls = 0;

  const responders = Array.isArray(responder) ? responder : null;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    const body =
      typeof init?.body === "string" ? init.body : init?.body == null ? null : "<non-string>";

    const recorded: RecordedRequest = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers as HeadersInit | undefined),
      body,
    };

    const index = requests.length;
    requests.push(recorded);

    if (responders !== null) {
      const next = responders[index];
      if (next === undefined) {
        throw new Error(
          `Graph stub received ${index + 1} requests but only ${responders.length} responders were provided. Last URL: ${url}`,
        );
      }
      return next(recorded, index);
    }

    return (responder as Responder)(recorded, index);
  };

  return {
    transport: {
      tokenProvider: async () => {
        tokenCalls += 1;
        return options.token ?? "test-access-token";
      },
      fetchImpl,
      // Instant, and recorded - so a Retry-After of 30 seconds does not make the
      // suite take 30 seconds to prove it was honoured.
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    },
    requests,
    sleeps,
    tokenCalls: () => tokenCalls,
  };
}

/**
 * docs/03-exchange-and-graph.md: without this header a message ID silently goes
 * stale the moment Power Automate moves the message. Asserted on every recorded
 * request rather than on the first, because "every request, without exception"
 * is the actual requirement.
 */
export function expectImmutableIdOnEveryRequest(stub: GraphStub): void {
  expect(stub.requests.length).toBeGreaterThan(0);

  for (const request of stub.requests) {
    const prefer = request.headers.get("prefer");
    expect(prefer, `Prefer header missing on ${request.url}`).not.toBeNull();
    expect(prefer, `Prefer header on ${request.url}`).toContain(IMMUTABLE_ID_PREFER);
  }
}
