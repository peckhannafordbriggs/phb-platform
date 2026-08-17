import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessToken, TokenCredential } from "@azure/identity";
import { createGraphClient } from "@/lib/modules/change-orders/graph/client";
import {
  createCachedTokenProvider,
  createGraphCredential,
} from "@/lib/modules/change-orders/graph/credential";
import { parseRetryAfter } from "@/lib/modules/change-orders/graph/errors";
import { MailError } from "@/lib/modules/change-orders/mail/errors";
import { createMailService } from "@/lib/modules/change-orders/mail/service";
import {
  createGraphStub,
  expectImmutableIdOnEveryRequest,
  graphErrorResponse,
  jsonResponse,
} from "./graph-stub";
import { TEST_GRAPH_CLIENT_ID, TEST_GRAPH_TENANT_ID } from "./constants";

/**
 * The Graph transport layer. No database, no session - these tests exercise the
 * client, the middleware chain and the error mapping against a stubbed HTTP
 * layer.
 */

const FOLDER_PAGE = {
  value: [
    {
      id: "folder-inbox",
      displayName: "Inbox",
      wellKnownName: "inbox",
      totalItemCount: 12,
      unreadItemCount: 3,
      childFolderCount: 0,
      parentFolderId: "root",
    },
  ],
};

describe("Prefer: IdType=\"ImmutableId\"", () => {
  it("is present on every outgoing request", async () => {
    const stub = createGraphStub(() => jsonResponse(FOLDER_PAGE));
    const service = createMailService(stub.transport);

    await service.listFolders();
    await service.getFolder("folder-inbox");
    await service.listMessages("folder-inbox");
    await service.listAttachments("message-1");

    expect(stub.requests.length).toBeGreaterThanOrEqual(4);
    expectImmutableIdOnEveryRequest(stub);
  });

  it("survives a caller that sets its own Prefer header", async () => {
    const stub = createGraphStub(() => jsonResponse(FOLDER_PAGE));
    const client = createGraphClient(stub.transport);

    await client
      .api("/users/someone@example.invalid/mailFolders")
      .header("Prefer", 'outlook.timezone="UTC"')
      .get();

    const prefer = stub.requests[0]?.headers.get("prefer");
    expect(prefer).toContain('outlook.timezone="UTC"');
    expect(prefer).toContain('IdType="ImmutableId"');
  });

  it("is added on the retry as well as the first attempt", async () => {
    const stub = createGraphStub([
      () => graphErrorResponse(429, "TooManyRequests", "slow down", { "retry-after": "2" }),
      () => jsonResponse(FOLDER_PAGE),
    ]);

    await createMailService(stub.transport).getFolder("folder-inbox");

    expect(stub.requests).toHaveLength(2);
    expectImmutableIdOnEveryRequest(stub);
  });
});

describe("token caching", () => {
  function credentialReturning(expiresInMs: number): {
    credential: TokenCredential;
    calls: () => number;
  } {
    let calls = 0;
    return {
      credential: {
        getToken: async (): Promise<AccessToken> => {
          calls += 1;
          return {
            token: `token-${calls}`,
            expiresOnTimestamp: Date.now() + expiresInMs,
          };
        },
      },
      calls: () => calls,
    };
  }

  it("fetches once and reuses the token across many calls", async () => {
    const { credential, calls } = credentialReturning(60 * 60 * 1000);
    const getToken = createCachedTokenProvider(credential);

    const tokens = [await getToken(), await getToken(), await getToken()];

    expect(calls()).toBe(1);
    expect(tokens).toEqual(["token-1", "token-1", "token-1"]);
  });

  it("collapses concurrent callers onto one fetch", async () => {
    const { credential, calls } = credentialReturning(60 * 60 * 1000);
    const getToken = createCachedTokenProvider(credential);

    await Promise.all([getToken(), getToken(), getToken(), getToken()]);

    expect(calls()).toBe(1);
  });

  it("refreshes before expiry rather than after it", async () => {
    // Expires in two minutes, inside the five-minute refresh margin, so it must
    // not be handed out even though it has not technically expired.
    const { credential, calls } = credentialReturning(2 * 60 * 1000);
    const getToken = createCachedTokenProvider(credential);

    await getToken();
    await getToken();

    expect(calls()).toBe(2);
  });

  it("reports a credential failure as auth_failed, not as unexpected", async () => {
    const credential: TokenCredential = {
      getToken: async () => {
        throw new Error("AADSTS7000215: Invalid client secret provided");
      },
    };

    await expect(createCachedTokenProvider(credential)()).rejects.toMatchObject({
      kind: "auth_failed",
    });
  });

  it("surfaces an auth failure through a Graph call as auth_failed", async () => {
    // The Graph SDK flattens anything thrown from middleware into an opaque
    // GraphError. This proves the real reason survives that.
    const service = createMailService({
      tokenProvider: async () => {
        throw new MailError("auth_failed", { detail: "no credential" });
      },
      fetchImpl: async () => {
        throw new Error("fetch must not be reached without a token");
      },
      sleep: async () => {},
    });

    await expect(service.getFolder("folder-inbox")).rejects.toMatchObject({
      kind: "auth_failed",
    });
  });
});

describe("production never accepts a client secret", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("refuses to build a credential from a secret in production", async () => {
    // isProduction is read from the boot-time env object, so this test drives
    // createGraphCredential through a module reload with NODE_ENV=production.
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();

    const { createGraphCredential: freshFactory } = await import(
      "@/lib/modules/change-orders/graph/credential"
    );

    expect(() =>
      freshFactory({
        clientId: TEST_GRAPH_CLIENT_ID,
        tenantId: TEST_GRAPH_TENANT_ID,
        clientSecret: "a-secret-that-must-not-be-used-in-production",
        managedIdentityClientId: null,
      }),
    ).toThrowError(
      expect.objectContaining({ kind: "not_configured" }) as unknown as Error,
    );
  });

  it("outside production, requires a secret rather than silently using none", () => {
    expect(() =>
      createGraphCredential({
        clientId: TEST_GRAPH_CLIENT_ID,
        tenantId: TEST_GRAPH_TENANT_ID,
        clientSecret: null,
        managedIdentityClientId: null,
      }),
    ).toThrowError(
      expect.objectContaining({ kind: "not_configured" }) as unknown as Error,
    );
  });
});

describe("Graph error mapping", () => {
  const cases: Array<{ status: number; code: string; kind: string }> = [
    { status: 401, code: "InvalidAuthenticationToken", kind: "auth_failed" },
    { status: 403, code: "ErrorAccessDenied", kind: "mailbox_forbidden" },
    { status: 404, code: "ErrorItemNotFound", kind: "not_found" },
    { status: 400, code: "ErrorInvalidIdMalformed", kind: "unexpected" },
    { status: 500, code: "InternalServerError", kind: "unexpected" },
  ];

  for (const { status, code, kind } of cases) {
    it(`maps ${status} ${code} to ${kind}`, async () => {
      const stub = createGraphStub(() => graphErrorResponse(status, code));
      const service = createMailService(stub.transport);

      await expect(service.getFolder("folder-inbox")).rejects.toMatchObject({
        kind,
      });
    });
  }

  it("maps a rejected fetch to network", async () => {
    const service = createMailService({
      tokenProvider: async () => "test-access-token",
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
      sleep: async () => {},
    });

    await expect(service.getFolder("folder-inbox")).rejects.toMatchObject({
      kind: "network",
    });
  });

  it("gives callers a non-technical message and keeps the detail off it", async () => {
    const stub = createGraphStub(() =>
      graphErrorResponse(403, "ErrorAccessDenied", "ApplicationAccessPolicy blocked"),
    );

    const error: MailError = await createMailService(stub.transport)
      .getFolder("folder-inbox")
      .then(() => {
        throw new Error("expected getFolder to reject");
      })
      .catch((caught: unknown) => caught as MailError);

    expect(error.userMessage).not.toContain("403");
    expect(error.userMessage).not.toContain("ApplicationAccessPolicy");
    // The diagnostic half exists, separately, for the server log.
    expect(error.detail).toContain("status=403");
  });
});

describe("throttling", () => {
  it("honours Retry-After and retries exactly once", async () => {
    const stub = createGraphStub([
      () =>
        graphErrorResponse(429, "TooManyRequests", "slow down", {
          "retry-after": "7",
        }),
      () => jsonResponse(FOLDER_PAGE.value[0]!),
    ]);

    const folder = await createMailService(stub.transport).getFolder("folder-inbox");

    expect(stub.requests).toHaveLength(2);
    expect(stub.sleeps).toEqual([7000]);
    expect(folder.displayName).toBe("Inbox");
  });

  it("surfaces the failure rather than retrying twice", async () => {
    const stub = createGraphStub([
      () => graphErrorResponse(429, "TooManyRequests", "slow", { "retry-after": "1" }),
      () => graphErrorResponse(429, "TooManyRequests", "slow", { "retry-after": "3" }),
    ]);

    await expect(
      createMailService(stub.transport).getFolder("folder-inbox"),
    ).rejects.toMatchObject({ kind: "throttled", retryAfterSeconds: 3 });

    // Two attempts total. Retrying harder against one mailbox through one app
    // identity makes the throttle worse.
    expect(stub.requests).toHaveLength(2);
    expect(stub.sleeps).toEqual([1000]);
  });

  it("marks the retry so Graph can see it is not a new request", async () => {
    const stub = createGraphStub([
      () => graphErrorResponse(503, "ServiceUnavailable"),
      () => jsonResponse(FOLDER_PAGE.value[0]!),
    ]);

    await createMailService(stub.transport).getFolder("folder-inbox");

    expect(stub.requests[0]?.headers.get("retry-attempt")).toBeNull();
    expect(stub.requests[1]?.headers.get("retry-attempt")).toBe("1");
  });

  it("falls back to a default wait when Graph sends no Retry-After", async () => {
    const stub = createGraphStub([
      () => graphErrorResponse(429, "TooManyRequests"),
      () => jsonResponse(FOLDER_PAGE.value[0]!),
    ]);

    await createMailService(stub.transport).getFolder("folder-inbox");

    expect(stub.sleeps).toEqual([5000]);
  });

  it("caps an unreasonable Retry-After instead of holding the request open", async () => {
    const stub = createGraphStub([
      () =>
        graphErrorResponse(429, "TooManyRequests", "slow", {
          "retry-after": "3600",
        }),
      () => jsonResponse(FOLDER_PAGE.value[0]!),
    ]);

    await createMailService(stub.transport).getFolder("folder-inbox");

    expect(stub.sleeps).toEqual([30_000]);
  });
});

describe("parseRetryAfter", () => {
  it("reads a seconds value", () => {
    expect(parseRetryAfter("12")).toBe(12);
  });

  it("reads an HTTP date", () => {
    const twentySecondsOut = new Date(Date.now() + 20_000).toUTCString();
    expect(parseRetryAfter(twentySecondsOut)).toBeGreaterThan(15);
  });

  it("treats a past date as no wait rather than a negative one", () => {
    expect(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
  });

  it("treats nonsense as absent", () => {
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe("logging", () => {
  let logLines: string[];

  beforeEach(() => {
    logLines = [];
    const capture = (...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    };
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never writes the access token, on success or on failure", async () => {
    const secretToken = "eyJ0-a-token-that-must-never-be-logged";

    const ok = createGraphStub(() => jsonResponse(FOLDER_PAGE), {
      token: secretToken,
    });
    await createMailService(ok.transport).listFolders();

    const failing = createGraphStub(
      () => graphErrorResponse(403, "ErrorAccessDenied"),
      { token: secretToken },
    );
    await createMailService(failing.transport)
      .listFolders()
      .catch(() => undefined);

    const throttled = createGraphStub(
      [
        () => graphErrorResponse(429, "TooManyRequests"),
        () => jsonResponse(FOLDER_PAGE),
      ],
      { token: secretToken },
    );
    await createMailService(throttled.transport).getFolder("folder-inbox");

    const combined = logLines.join("\n");
    expect(combined.length).toBeGreaterThan(0);
    expect(combined).not.toContain(secretToken);
    expect(combined).not.toContain("Bearer");
  });

  it("logs the request id on a Graph failure, because support asks for it", async () => {
    const stub = createGraphStub(() => graphErrorResponse(403, "ErrorAccessDenied"));

    await createMailService(stub.transport)
      .getFolder("folder-inbox")
      .catch(() => undefined);

    expect(logLines.join("\n")).toContain("test-request-id");
  });
});
