import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// The guard reads the session through auth(). Everything else in the path -
// the Prisma client, the queries, the route handler - is real.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { GET as pingRoute } from "@/app/api/modules/change-orders/ping/route";
import {
  createEmployee,
  disconnectDb,
  grantModule,
  resetDb,
  revokeModule,
  seedChangeOrdersModule,
  testDb,
} from "./db";

const authMock = vi.mocked(auth);

/** A signed-in session for the given employee, issued now. */
function sessionFor(entraOid: string, issuedAt = Math.floor(Date.now() / 1000)) {
  return {
    entraOid,
    issuedAt,
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session;
}

function signedOut() {
  authMock.mockResolvedValue(null as never);
}

function signedInAs(entraOid: string, issuedAt?: number) {
  authMock.mockResolvedValue(sessionFor(entraOid, issuedAt) as never);
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb();
  await seedChangeOrdersModule();
});

afterAll(async () => {
  await disconnectDb();
});

describe("module route guard", () => {
  it("rejects an unauthenticated request with 401", async () => {
    signedOut();

    const response = await pingRoute();

    expect(response.status).toBe(401);
  });

  it("returns 404 - not 403 - when the employee has no grant", async () => {
    const employee = await createEmployee({ entraOid: "oid-nogrant" });
    signedInAs("oid-nogrant");

    const response = await pingRoute();

    // 404 so the platform does not confirm the module exists.
    expect(response.status).toBe(404);
    expect(employee.id).toBeDefined();
  });

  it("returns 200 when the grant is present", async () => {
    const employee = await createEmployee({ entraOid: "oid-granted" });
    await grantModule(employee.id);
    signedInAs("oid-granted");

    const response = await pingRoute();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { ok: true } });
  });

  it("revoking a grant takes effect on the next request, without signing out", async () => {
    const employee = await createEmployee({ entraOid: "oid-revoke" });
    await grantModule(employee.id);
    signedInAs("oid-revoke");

    await expect(pingRoute().then((r) => r.status)).resolves.toBe(200);

    await revokeModule(employee.id);

    // Same session, same token, no re-authentication.
    await expect(pingRoute().then((r) => r.status)).resolves.toBe(404);
  });

  it("disabling an employee takes effect on the next request, without signing out", async () => {
    const employee = await createEmployee({ entraOid: "oid-disable" });
    await grantModule(employee.id);
    signedInAs("oid-disable");

    await expect(pingRoute().then((r) => r.status)).resolves.toBe(200);

    await testDb.employee.update({
      where: { id: employee.id },
      data: { status: "disabled" },
    });

    await expect(pingRoute().then((r) => r.status)).resolves.toBe(401);
  });

  it("rejects a session issued before sessionsValidAfter", async () => {
    const employee = await createEmployee({ entraOid: "oid-stale" });
    await grantModule(employee.id);

    const issuedAt = Math.floor(Date.now() / 1000) - 600;
    signedInAs("oid-stale", issuedAt);

    await expect(pingRoute().then((r) => r.status)).resolves.toBe(200);

    await testDb.employee.update({
      where: { id: employee.id },
      data: { sessionsValidAfter: new Date() },
    });

    await expect(pingRoute().then((r) => r.status)).resolves.toBe(401);
  });

  it("accepts a session issued after sessionsValidAfter", async () => {
    const employee = await createEmployee({
      entraOid: "oid-fresh",
      sessionsValidAfter: new Date(Date.now() - 600_000),
    });
    await grantModule(employee.id);
    signedInAs("oid-fresh");

    await expect(pingRoute().then((r) => r.status)).resolves.toBe(200);
  });

  it("returns 403 when the profile is incomplete, even with a grant", async () => {
    const employee = await createEmployee({
      entraOid: "oid-incomplete",
      profileCompleted: false,
    });
    await grantModule(employee.id);
    signedInAs("oid-incomplete");

    const response = await pingRoute();

    expect(response.status).toBe(403);
  });

  it("returns 401 when the session names an employee that does not exist", async () => {
    signedInAs("oid-that-was-never-provisioned");

    const response = await pingRoute();

    expect(response.status).toBe(401);
  });

  it("returns 404 when the module itself is hidden, grant or not", async () => {
    const employee = await createEmployee({ entraOid: "oid-hidden" });
    await grantModule(employee.id);
    await testDb.module.update({
      where: { key: "change-orders" },
      data: { status: "hidden" },
    });
    signedInAs("oid-hidden");

    const response = await pingRoute();

    expect(response.status).toBe(404);
  });

  it("leaks nothing about the reason in the response body", async () => {
    const employee = await createEmployee({ entraOid: "oid-quiet" });
    signedInAs("oid-quiet");

    const body = (await (await pingRoute()).json()) as {
      error: { code: string; message: string };
    };

    expect(body.error.code).toBe("not_found");
    expect(body.error.message).not.toContain("grant");
    expect(body.error.message).not.toContain(employee.email);
  });
});
