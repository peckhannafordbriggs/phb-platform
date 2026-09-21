import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Only the session is mocked. The guard, the wrapper, the Zod body schema, the
// env reader and the rate limiter are the real ones.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { questionRateLimiter, QUESTIONS_PER_MINUTE } from "@/lib/modules/bas/analyze/rate-limit";
import { GET, POST } from "@/app/api/modules/bas/analyze/route";
import {
  createEmployee,
  disconnectDb,
  grantModule,
  resetDb,
  seedBasModule,
  seedChangeOrdersModule,
} from "./db";

/**
 * The HTTP surface of the Analyze tab.
 *
 * What is proved here and nowhere else: the status codes. 401 with no
 * session, 404 - not 403 - without the grant, 422 for a malformed body, 200
 * with `not_configured` when a variable is missing, and 429 from the limiter.
 * The 429 is reachable without a model because the service checks the limit
 * BEFORE constructing a pool or calling the planner; a fake key and a fake URL
 * are enough to get past the configuration check to it.
 *
 * Everything past the limiter is tests/bas-analyze-service.test.ts.
 */

const authMock = vi.mocked(auth);

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/modules/bas/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

async function granted(): Promise<string> {
  const employee = await createEmployee();
  await grantModule(employee.id, BAS_MODULE_KEY);
  signedInAs(employee.entraOid!);
  return employee.id;
}

const saved = {
  key: process.env.ANTHROPIC_API_KEY,
  url: process.env.BAS_ASK_DATABASE_URL,
};

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetBasAvailabilityCache();
  questionRateLimiter.reset();
  // The default the suite runs in: Analyze is NOT configured.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.BAS_ASK_DATABASE_URL;
  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
  if (saved.url !== undefined) process.env.BAS_ASK_DATABASE_URL = saved.url;
  await disconnectDb();
});

describe("authorization", () => {
  it("GET and POST return 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null as never);
    expect((await GET()).status).toBe(401);
    expect((await post({ question: "anything at all" })).status).toBe(401);
  });

  it("GET and POST return 404 - not 403 - without the BAS grant", async () => {
    await createEmployee({ entraOid: "oid-b5-nogrant" });
    signedInAs("oid-b5-nogrant");

    const status = await GET();
    expect(status.status).toBe(404);
    const ask = await post({ question: "anything at all" });
    expect(ask.status).toBe(404);
    await expect(ask.json()).resolves.toEqual({
      error: { code: "not_found", message: "Not found." },
    });
  });
});

describe("configuration", () => {
  it("GET names the missing variables and never their values", async () => {
    await granted();
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { configured: false, missing: ["ANTHROPIC_API_KEY", "BAS_ASK_DATABASE_URL"] },
    });
  });

  it("GET reports configured when both are set", async () => {
    await granted();
    process.env.ANTHROPIC_API_KEY = "fake";
    process.env.BAS_ASK_DATABASE_URL = "postgresql://x:y@localhost:5432/nope";
    await expect((await GET()).json()).resolves.toEqual({
      data: { configured: true, missing: [] },
    });
  });

  it("POST answers not_configured as a 200 result, not a crash", async () => {
    await granted();
    const response = await post({ question: "What was the average room temperature last week?" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { kind: "not_configured", missing: ["ANTHROPIC_API_KEY", "BAS_ASK_DATABASE_URL"] },
    });
  });
});

describe("validation", () => {
  it("returns 422 for a missing, short, long or non-JSON body", async () => {
    await granted();
    expect((await post({})).status).toBe(422);
    expect((await post({ question: "hi" })).status).toBe(422);
    expect((await post({ question: "x".repeat(1_001) })).status).toBe(422);
    expect((await post("not json")).status).toBe(422);
    expect((await post({ question: 42 })).status).toBe(422);
  });
});

describe("rate limiting", () => {
  it("returns 429 once the per-employee window is full, before any model call", async () => {
    const employeeId = await granted();
    process.env.ANTHROPIC_API_KEY = "fake-key-never-sent";
    // A URL that would fail to connect if anything reached it. Nothing does:
    // the limit is checked first.
    process.env.BAS_ASK_DATABASE_URL = "postgresql://nobody:nothing@localhost:1/none";

    for (let i = 0; i < QUESTIONS_PER_MINUTE; i += 1) {
      questionRateLimiter.check(employeeId);
    }

    const response = await post({ question: "What was the average room temperature last week?" });
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "rate_limited",
        message: "Too many questions in a short time. Wait a moment and ask again.",
      },
    });
  });
});
