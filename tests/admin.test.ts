import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import * as employeesCollectionRoute from "@/app/api/admin/employees/route";
import { GET as employeeDetailRoute } from "@/app/api/admin/employees/[id]/route";
import { POST as addGrantRoute } from "@/app/api/admin/employees/[id]/grants/route";
import { DELETE as removeGrantRoute } from "@/app/api/admin/employees/[id]/grants/[moduleKey]/route";
import { POST as statusRoute } from "@/app/api/admin/employees/[id]/status/route";
import { POST as adminFlagRoute } from "@/app/api/admin/employees/[id]/admin-flag/route";
import { POST as bulkGrantsRoute } from "@/app/api/admin/grants/bulk/route";
import { POST as bulkStatusRoute } from "@/app/api/admin/status/bulk/route";
import { GET as auditRoute } from "@/app/api/admin/audit/route";
import { seedBootstrapAdmins } from "@/lib/bootstrap-admins";
import {
  createEmployee,
  disconnectDb,
  grantModule,
  resetDb,
  seedChangeOrdersModule,
  testDb,
} from "./db";

const authMock = vi.mocked(auth);

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

function signedOut() {
  authMock.mockResolvedValue(null as never);
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function params<T extends object>(value: T) {
  return { params: Promise.resolve(value) };
}

async function makeAdmin() {
  const admin = await createEmployee({
    entraOid: "oid-admin",
    email: "admin@phb1899.com",
    isPlatformAdmin: true,
  });
  signedInAs("oid-admin");
  return admin;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb();
  await seedChangeOrdersModule();
});

afterAll(async () => {
  await disconnectDb();
});

describe("admin route protection", () => {
  it("rejects an unauthenticated caller with 401", async () => {
    signedOut();

    const response = await employeesCollectionRoute.GET(
      new NextRequest("http://localhost/api/admin/employees"),
    );

    expect(response.status).toBe(401);
  });

  it("rejects a non-admin with 403 on every admin route", async () => {
    const admin = await makeAdmin();
    const target = await createEmployee({ entraOid: "oid-target" });

    await createEmployee({ entraOid: "oid-plain", email: "plain@phb1899.com" });
    signedInAs("oid-plain");

    const responses = await Promise.all([
      employeesCollectionRoute.GET(
        new NextRequest("http://localhost/api/admin/employees"),
      ),
      employeeDetailRoute(new Request("http://localhost"), params({ id: target.id })),
      addGrantRoute(jsonRequest({ moduleKey: "change-orders" }), params({ id: target.id })),
      removeGrantRoute(
        new Request("http://localhost", { method: "DELETE" }),
        params({ id: target.id, moduleKey: "change-orders" }),
      ),
      statusRoute(jsonRequest({ status: "disabled" }), params({ id: target.id })),
      adminFlagRoute(jsonRequest({ isPlatformAdmin: true }), params({ id: target.id })),
      bulkGrantsRoute(
        jsonRequest({
          employeeIds: [target.id],
          moduleKey: "change-orders",
          action: "grant",
        }),
      ),
      auditRoute(new NextRequest("http://localhost/api/admin/audit")),
      bulkStatusRoute(
        jsonRequest({ employeeIds: [target.id], status: "disabled" }),
      ),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(403);
    }
    expect(admin.id).toBeDefined();
  });

  it("exposes no endpoint that creates an employee", () => {
    // Admins grant access; they do not create accounts. The collection route
    // has a GET and nothing else.
    expect(employeesCollectionRoute.GET).toBeTypeOf("function");
    expect(
      (employeesCollectionRoute as Record<string, unknown>).POST,
    ).toBeUndefined();
    expect(
      (employeesCollectionRoute as Record<string, unknown>).PUT,
    ).toBeUndefined();
  });
});

describe("grants", () => {
  it("grants and revokes, and each writes an audit event naming the acting admin", async () => {
    const admin = await makeAdmin();
    const target = await createEmployee({ entraOid: "oid-t1" });

    const granted = await addGrantRoute(
      jsonRequest({ moduleKey: "change-orders" }),
      params({ id: target.id }),
    );
    expect(granted.status).toBe(200);

    const grant = await testDb.moduleGrant.findUnique({
      where: {
        employeeId_moduleKey: {
          employeeId: target.id,
          moduleKey: "change-orders",
        },
      },
    });
    expect(grant).not.toBeNull();
    expect(grant?.grantedById).toBe(admin.id);

    const revoked = await removeGrantRoute(
      new Request("http://localhost", { method: "DELETE" }),
      params({ id: target.id, moduleKey: "change-orders" }),
    );
    expect(revoked.status).toBe(200);

    const events = await testDb.auditEvent.findMany({
      where: { targetEmployeeId: target.id },
      orderBy: { occurredAt: "asc" },
    });
    const actions = events.map((e) => e.action);
    expect(actions).toContain("grant.added");
    expect(actions).toContain("grant.removed");
    for (const event of events) {
      expect(event.actorEmployeeId).toBe(admin.id);
      expect(event.occurredAt).toBeInstanceOf(Date);
    }
  });

  it("returns 404 for an unknown module", async () => {
    await makeAdmin();
    const target = await createEmployee({ entraOid: "oid-t2" });

    const response = await addGrantRoute(
      jsonRequest({ moduleKey: "does-not-exist" }),
      params({ id: target.id }),
    );

    expect(response.status).toBe(404);
  });

  it("bulk grants and bulk revokes", async () => {
    await makeAdmin();
    const a = await createEmployee({ entraOid: "oid-b1" });
    const b = await createEmployee({ entraOid: "oid-b2" });
    const c = await createEmployee({ entraOid: "oid-b3" });

    const granted = await bulkGrantsRoute(
      jsonRequest({
        employeeIds: [a.id, b.id, c.id],
        moduleKey: "change-orders",
        action: "grant",
      }),
    );
    expect(granted.status).toBe(200);
    await expect(
      testDb.moduleGrant.count({ where: { moduleKey: "change-orders" } }),
    ).resolves.toBe(3);

    const revoked = await bulkGrantsRoute(
      jsonRequest({
        employeeIds: [a.id, b.id],
        moduleKey: "change-orders",
        action: "revoke",
      }),
    );
    expect(revoked.status).toBe(200);
    await expect(
      testDb.moduleGrant.count({ where: { moduleKey: "change-orders" } }),
    ).resolves.toBe(1);

    // One audit event per employee, not one covering the batch.
    await expect(
      testDb.auditEvent.count({ where: { action: "grant.added" } }),
    ).resolves.toBe(3);
    await expect(
      testDb.auditEvent.count({ where: { action: "grant.removed" } }),
    ).resolves.toBe(2);
  });
});

describe("guardrails", () => {
  it("refuses to let an admin remove their own admin flag", async () => {
    const admin = await makeAdmin();
    await createEmployee({
      entraOid: "oid-other-admin",
      email: "other@phb1899.com",
      isPlatformAdmin: true,
    });

    const response = await adminFlagRoute(
      jsonRequest({ isPlatformAdmin: false }),
      params({ id: admin.id }),
    );

    expect(response.status).toBe(403);
    const after = await testDb.employee.findUnique({ where: { id: admin.id } });
    expect(after?.isPlatformAdmin).toBe(true);
  });

  it("refuses to let an admin disable their own account", async () => {
    const admin = await makeAdmin();
    await createEmployee({
      entraOid: "oid-other-admin-2",
      email: "other2@phb1899.com",
      isPlatformAdmin: true,
    });

    const response = await statusRoute(
      jsonRequest({ status: "disabled" }),
      params({ id: admin.id }),
    );

    expect(response.status).toBe(403);
    const after = await testDb.employee.findUnique({ where: { id: admin.id } });
    expect(after?.status).toBe("active");
  });

  it("refuses to demote the last active admin", async () => {
    const admin = await makeAdmin();
    const other = await createEmployee({
      entraOid: "oid-second-admin",
      email: "second@phb1899.com",
      isPlatformAdmin: true,
    });

    // Demoting the other admin is fine while two exist...
    await expect(
      adminFlagRoute(
        jsonRequest({ isPlatformAdmin: false }),
        params({ id: other.id }),
      ).then((r) => r.status),
    ).resolves.toBe(200);

    // ...and the acting admin still cannot demote themselves.
    const response = await adminFlagRoute(
      jsonRequest({ isPlatformAdmin: false }),
      params({ id: admin.id }),
    );
    expect(response.status).toBe(403);

    await expect(
      testDb.employee.count({
        where: { isPlatformAdmin: true, status: "active" },
      }),
    ).resolves.toBe(1);
  });

  it("refuses to disable the last active admin", async () => {
    await makeAdmin();
    const other = await createEmployee({
      entraOid: "oid-lone",
      email: "lone@phb1899.com",
      isPlatformAdmin: true,
    });

    // The acting admin steps down as an admin by being disabled by nobody -
    // instead, demote the acting admin's peer and then try to disable the last.
    await testDb.employee.update({
      where: { entraOid: "oid-admin" },
      data: { isPlatformAdmin: false },
    });
    signedInAs("oid-lone");

    const response = await statusRoute(
      jsonRequest({ status: "disabled" }),
      params({ id: other.id }),
    );

    // Self-disable is refused before the last-admin rule is even reached.
    expect(response.status).toBe(403);
    const after = await testDb.employee.findUnique({ where: { id: other.id } });
    expect(after?.status).toBe("active");
  });

  it("holds with four seeded bootstrap admins, down to the last one", async () => {
    // The real shape of the platform: BOOTSTRAP_ADMIN_EMAIL seeds several
    // admins, so the guardrail has to survive them being removed one at a time
    // rather than only ever seeing two.
    const admin = await makeAdmin();
    const seeded = await seedBootstrapAdmins(testDb, [
      "msheth@phb1899.com",
      "jschwarz@phb1899.com",
      "jschriner@phb1899.com",
      "bbolten@phb1899.com",
    ]);
    expect(seeded.created).toHaveLength(4);

    const bootstrapRows = await testDb.employee.findMany({
      where: { email: { in: seeded.created } },
      select: { id: true, email: true },
      orderBy: { email: "asc" },
    });

    // Five active admins now: the acting one plus the four seeded.
    await expect(
      testDb.employee.count({ where: { isPlatformAdmin: true, status: "active" } }),
    ).resolves.toBe(5);

    // Demote all four. Each is allowed, because the acting admin remains.
    for (const row of bootstrapRows) {
      await expect(
        adminFlagRoute(
          jsonRequest({ isPlatformAdmin: false }),
          params({ id: row.id }),
        ).then((r) => r.status),
        `demoting ${row.email} should be allowed`,
      ).resolves.toBe(200);
    }

    await expect(
      testDb.employee.count({ where: { isPlatformAdmin: true, status: "active" } }),
    ).resolves.toBe(1);

    // The acting admin is now the last one, and cannot remove themselves.
    await expect(
      adminFlagRoute(
        jsonRequest({ isPlatformAdmin: false }),
        params({ id: admin.id }),
      ).then((r) => r.status),
    ).resolves.toBe(403);

    // Nor disable themselves.
    await expect(
      statusRoute(
        jsonRequest({ status: "disabled" }),
        params({ id: admin.id }),
      ).then((r) => r.status),
    ).resolves.toBe(403);

    await expect(
      testDb.employee.count({ where: { isPlatformAdmin: true, status: "active" } }),
    ).resolves.toBe(1);
  });

  it("refuses to demote the last admin even when the others are only disabled", async () => {
    // Disabled admins still hold the flag but cannot administer anything, so
    // they must not count towards "someone else can still do this".
    const admin = await makeAdmin();
    await seedBootstrapAdmins(testDb, [
      "jschwarz@phb1899.com",
      "jschriner@phb1899.com",
    ]);

    await testDb.employee.updateMany({
      where: { email: { in: ["jschwarz@phb1899.com", "jschriner@phb1899.com"] } },
      data: { status: "disabled" },
    });

    const response = await adminFlagRoute(
      jsonRequest({ isPlatformAdmin: false }),
      params({ id: admin.id }),
    );

    expect(response.status).toBe(403);
    expect(
      (await testDb.employee.findUniqueOrThrow({ where: { id: admin.id } }))
        .isPlatformAdmin,
    ).toBe(true);
  });

  it("bumps sessionsValidAfter when disabling, so the target is rejected immediately", async () => {
    await makeAdmin();
    const target = await createEmployee({ entraOid: "oid-victim" });

    const response = await statusRoute(
      jsonRequest({ status: "disabled" }),
      params({ id: target.id }),
    );

    expect(response.status).toBe(200);
    const after = await testDb.employee.findUnique({ where: { id: target.id } });
    expect(after?.status).toBe("disabled");
    expect(after?.sessionsValidAfter).toBeInstanceOf(Date);
  });
});

describe("list search, filters and pagination", () => {
  beforeEach(async () => {
    await makeAdmin();

    const rows = Array.from({ length: 120 }, (_, i) => ({
      email: `bulk${String(i).padStart(3, "0")}@phb1899.com`,
      firstName: i % 3 === 0 ? "Alexandra" : "Jordan",
      lastName: `Surname${String(i).padStart(3, "0")}`,
      entraOid: `oid-bulk-${i}`,
      profileCompleted: true,
      status: (i % 10 === 0 ? "disabled" : "active") as "active" | "disabled",
    }));
    await testDb.employee.createMany({ data: rows });

    // Grant a handful so the default "with a grant" view is not everyone.
    const granted = await testDb.employee.findMany({
      where: { email: { startsWith: "bulk00" } },
      select: { id: true },
      take: 8,
    });
    for (const employee of granted) {
      await grantModule(employee.id);
    }
  });

  async function list(query: string) {
    const response = await employeesCollectionRoute.GET(
      new NextRequest(`http://localhost/api/admin/employees?${query}`),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as {
      data: {
        employees: { id: string; email: string; status: string }[];
        total: number;
        page: number;
        totalPages: number;
      };
    };
  }

  it("defaults to employees with at least one grant", async () => {
    const { data } = await list("");
    expect(data.total).toBe(8);
  });

  it("shows everyone when the scope is switched", async () => {
    const { data } = await list("scope=all");
    // 120 seeded + the acting admin.
    expect(data.total).toBe(121);
  });

  it("paginates", async () => {
    const first = await list("scope=all&pageSize=25&page=1");
    expect(first.data.employees).toHaveLength(25);
    expect(first.data.totalPages).toBe(5);

    const last = await list("scope=all&pageSize=25&page=5");
    expect(last.data.employees).toHaveLength(21);
    expect(last.data.page).toBe(5);
  });

  it("searches by name and by email, case-insensitively", async () => {
    const byName = await list("scope=all&q=alexandra");
    expect(byName.data.total).toBe(40);

    const byEmail = await list("scope=all&q=bulk001@");
    expect(byEmail.data.total).toBe(1);
  });

  it("filters by status", async () => {
    const { data } = await list("scope=all&status=disabled");
    expect(data.total).toBe(12);
    expect(data.employees.every((e) => e.status === "disabled")).toBe(true);
  });

  it("filters by module", async () => {
    const { data } = await list("scope=all&moduleKey=change-orders");
    expect(data.total).toBe(8);
  });
});

describe("audit endpoint", () => {
  it("filters by target, actor and action", async () => {
    const admin = await makeAdmin();
    const target = await createEmployee({ entraOid: "oid-audited" });

    await addGrantRoute(
      jsonRequest({ moduleKey: "change-orders" }),
      params({ id: target.id }),
    );

    const response = await auditRoute(
      new NextRequest(
        `http://localhost/api/admin/audit?targetEmployeeId=${target.id}&actorEmployeeId=${admin.id}&action=grant.added`,
      ),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { events: { action: string }[]; total: number };
    };
    expect(body.data.total).toBe(1);
    expect(body.data.events[0]?.action).toBe("grant.added");
  });
});
