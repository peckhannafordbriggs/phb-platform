import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Same shape as tests/authz.test.ts: only the session is mocked. The guard, the
// Prisma client, the queries and the route handler are all real.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { GET as healthRoute } from "@/app/api/modules/change-orders/mailbox/health/route";
import {
  createEmployee,
  disconnectDb,
  grantModule,
  resetDb,
  seedChangeOrdersModule,
} from "./db";
import { TEST_GRAPH_CLIENT_ID, TEST_GRAPH_TENANT_ID } from "./constants";

const authMock = vi.mocked(auth);

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await resetDb();
  await seedChangeOrdersModule();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDb();
});

describe("mailbox health endpoint - authorization", () => {
  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null as never);

    expect((await healthRoute()).status).toBe(401);
  });

  it("returns 404 - not 403 - without a module grant", async () => {
    await createEmployee({ entraOid: "oid-health-nogrant" });
    signedInAs("oid-health-nogrant");

    const response = await healthRoute();

    // The platform does not confirm that the module exists.
    expect(response.status).toBe(404);
  });

  it("returns 403 when the profile is incomplete, even with a grant", async () => {
    const employee = await createEmployee({
      entraOid: "oid-health-incomplete",
      profileCompleted: false,
    });
    await grantModule(employee.id);
    signedInAs("oid-health-incomplete");

    expect((await healthRoute()).status).toBe(403);
  });

  it("reveals nothing about Graph configuration to an ungranted caller", async () => {
    await createEmployee({ entraOid: "oid-health-quiet" });
    signedInAs("oid-health-quiet");

    const body = (await (await healthRoute()).json()) as {
      error: { code: string; message: string };
      data?: unknown;
    };

    expect(body.data).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("GRAPH_");
    expect(JSON.stringify(body)).not.toContain("mailbox");
  });
});

describe("mailbox health endpoint - with no Graph credential", () => {
  it("reports not configured rather than crashing", async () => {
    // tests/setup.ts leaves the Graph credential unset, because that is the
    // state the app has to boot and serve in until IT creates the app
    // registration.
    const employee = await createEmployee({ entraOid: "oid-health-granted" });
    await grantModule(employee.id);
    signedInAs("oid-health-granted");

    const response = await healthRoute();

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      data: { configured: boolean; missing: string[]; folders: unknown[] };
    };

    expect(body.data.configured).toBe(false);
    expect(body.data.folders).toEqual([]);
    // Names the variables to set. Variable names are not secrets, and this is
    // the difference between a five-minute fix and an afternoon of guessing.
    expect(body.data.missing).toContain("GRAPH_CLIENT_ID");
    expect(body.data.missing).toContain("GRAPH_TENANT_ID");
  });

  it("reports the one missing variable when the rest are present", async () => {
    const employee = await createEmployee({ entraOid: "oid-health-partial" });
    await grantModule(employee.id);
    signedInAs("oid-health-partial");

    vi.stubEnv("GRAPH_CLIENT_ID", TEST_GRAPH_CLIENT_ID);
    // GRAPH_TENANT_ID deliberately left unset.

    const body = (await (await healthRoute()).json()) as {
      data: { configured: boolean; missing: string[] };
    };

    expect(body.data.configured).toBe(false);
    expect(body.data.missing).toEqual(["GRAPH_TENANT_ID"]);
  });

});

describe("mailboxConnectionStatus", () => {
  /**
   * Checked directly rather than through the route, because a configured
   * credential would make the route attempt a real token request against
   * Microsoft - and nothing in this suite reaches the network.
   */
  it("reports configured without ever exposing a credential value", async () => {
    const secret = "a-fake-client-secret-value-for-this-test";
    vi.stubEnv("GRAPH_CLIENT_ID", TEST_GRAPH_CLIENT_ID);
    vi.stubEnv("GRAPH_TENANT_ID", TEST_GRAPH_TENANT_ID);
    vi.stubEnv("GRAPH_CLIENT_SECRET", secret);

    const { mailboxConnectionStatus } = await import(
      "@/lib/modules/change-orders/mail/service"
    );

    const status = mailboxConnectionStatus();
    const raw = JSON.stringify(status);

    expect(status.configured).toBe(true);
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(TEST_GRAPH_CLIENT_ID);
    expect(raw).not.toContain(TEST_GRAPH_TENANT_ID);
    // The mailbox address is the only thing it reports, and it is not a secret.
    expect(Object.keys(status).sort()).toEqual(["configured", "mailbox"]);
  });
});
