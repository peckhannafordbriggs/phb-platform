import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Only the session is mocked. The guards, the schemas, the service, the Prisma
// queries and the route handlers are all the real ones.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { PATCH as selfPosition } from "@/app/api/me/position/route";
import { PATCH as adminPosition } from "@/app/api/admin/employees/[id]/position/route";
import { PATCH as adminDepartment } from "@/app/api/admin/employees/[id]/department/route";
import { createEmployee, disconnectDb, resetDb, testDb } from "./db";

const authMock = vi.mocked(auth);

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

function patch(url: string, body: unknown): Request {
  return new Request(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Matches the { params: Promise<{ id }> } signature Next passes to a route. */
function routeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function seedLists() {
  const [estimator, foreman, hidden] = await Promise.all([
    testDb.position.create({ data: { name: "Estimator" } }),
    testDb.position.create({ data: { name: "Foreman" } }),
    testDb.position.create({ data: { name: "Retired Role", status: "hidden" } }),
  ]);
  const [engineering, ai] = await Promise.all([
    testDb.department.create({ data: { name: "Engineer" } }),
    testDb.department.create({ data: { name: "AI" } }),
  ]);
  return { estimator, foreman, hiddenPosition: hidden, engineering, ai };
}

async function employeeRow(id: string) {
  const row = await testDb.employee.findUniqueOrThrow({
    where: { id },
    select: {
      email: true,
      firstName: true,
      lastName: true,
      positionId: true,
      positionOther: true,
      departmentId: true,
      status: true,
      isPlatformAdmin: true,
    },
  });
  return row;
}

function auditFor(targetId: string, action: string) {
  return testDb.auditEvent.findMany({
    where: { targetEmployeeId: targetId, action },
    select: { actorEmployeeId: true, metadata: true },
    orderBy: { occurredAt: "desc" },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb();
});

afterAll(async () => {
  await disconnectDb();
});

describe("the screens render", () => {
  /**
   * Smoke tests. `npm run build` proves these pages compile; it does not run their
   * queries. Calling the server component exercises the real Prisma reads and the
   * real null handling, which is where a profile page with no department set, or a
   * position on a hidden value, would actually fall over.
   */
  it("the employee profile page renders, including with nothing set", async () => {
    await seedLists();
    await createEmployee({ entraOid: "oid-render-profile" });
    signedInAs("oid-render-profile");

    const { default: ProfilePage } = await import("@/app/(platform)/profile/page");

    await expect(ProfilePage()).resolves.toBeDefined();
  });

  it("the employee profile page renders with a hidden position", async () => {
    const lists = await seedLists();
    const employee = await createEmployee({ entraOid: "oid-render-hidden" });
    await testDb.employee.update({
      where: { id: employee.id },
      data: { positionId: lists.hiddenPosition.id },
    });
    signedInAs("oid-render-hidden");

    const { default: ProfilePage } = await import("@/app/(platform)/profile/page");

    await expect(ProfilePage()).resolves.toBeDefined();
  });

  it("the admin employee detail page renders", async () => {
    const lists = await seedLists();
    const target = await createEmployee({ entraOid: "oid-render-target" });
    await testDb.employee.update({
      where: { id: target.id },
      data: {
        departmentId: lists.engineering.id,
        positionId: lists.estimator.id,
      },
    });
    await createEmployee({ entraOid: "oid-render-admin", isPlatformAdmin: true });
    signedInAs("oid-render-admin");

    const { default: AdminEmployeePage } = await import(
      "@/app/(platform)/admin/[id]/page"
    );

    await expect(
      AdminEmployeePage({ params: Promise.resolve({ id: target.id }) }),
    ).resolves.toBeDefined();
  });
});

describe("an employee changing their own position", () => {
  it("succeeds with a value from the list, and records who did it", async () => {
    const lists = await seedLists();
    const employee = await createEmployee({ entraOid: "oid-self-position" });
    signedInAs("oid-self-position");

    const response = await selfPosition(
      patch("http://localhost/api/me/position", {
        positionId: lists.estimator.id,
        positionOther: null,
      }),
    );

    expect(response.status).toBe(200);

    const row = await employeeRow(employee.id);
    expect(row.positionId).toBe(lists.estimator.id);
    expect(row.positionOther).toBeNull();

    const events = await auditFor(employee.id, "employee.position_changed");
    expect(events).toHaveLength(1);
    // The actor is the employee, from the session - never from the body.
    expect(events[0]?.actorEmployeeId).toBe(employee.id);
    expect(events[0]?.metadata).toMatchObject({ self: true });
  });

  it("succeeds with the free-text Other option", async () => {
    await seedLists();
    const employee = await createEmployee({ entraOid: "oid-self-other" });
    signedInAs("oid-self-other");

    const response = await selfPosition(
      patch("http://localhost/api/me/position", {
        positionId: null,
        positionOther: "Warehouse Lead",
      }),
    );

    expect(response.status).toBe(200);

    const row = await employeeRow(employee.id);
    expect(row.positionId).toBeNull();
    expect(row.positionOther).toBe("Warehouse Lead");

    const events = await auditFor(employee.id, "employee.position_changed");
    expect(events[0]?.metadata).toMatchObject({ usedFreeTextPosition: true });
  });

  it("clears the previous free text when a listed value is chosen", async () => {
    const lists = await seedLists();
    const employee = await createEmployee({ entraOid: "oid-self-swap" });
    await testDb.employee.update({
      where: { id: employee.id },
      data: { positionId: null, positionOther: "Warehouse Lead" },
    });
    signedInAs("oid-self-swap");

    await selfPosition(
      patch("http://localhost/api/me/position", {
        positionId: lists.foreman.id,
      }),
    );

    const row = await employeeRow(employee.id);
    expect(row.positionId).toBe(lists.foreman.id);
    // Both columns must never be populated at once.
    expect(row.positionOther).toBeNull();
  });

  it("refuses a hidden position", async () => {
    const lists = await seedLists();
    await createEmployee({ entraOid: "oid-self-hidden" });
    signedInAs("oid-self-hidden");

    const response = await selfPosition(
      patch("http://localhost/api/me/position", {
        positionId: lists.hiddenPosition.id,
      }),
    );

    expect(response.status).toBe(422);
  });

  it("refuses an empty position", async () => {
    await seedLists();
    await createEmployee({ entraOid: "oid-self-empty" });
    signedInAs("oid-self-empty");

    const response = await selfPosition(
      patch("http://localhost/api/me/position", {
        positionId: null,
        positionOther: null,
      }),
    );

    expect(response.status).toBe(422);
  });

  it("refuses both a listed value and free text at once", async () => {
    const lists = await seedLists();
    await createEmployee({ entraOid: "oid-self-both" });
    signedInAs("oid-self-both");

    const response = await selfPosition(
      patch("http://localhost/api/me/position", {
        positionId: lists.estimator.id,
        positionOther: "Something else",
      }),
    );

    expect(response.status).toBe(422);
  });

  it("rejects an unauthenticated request with 401", async () => {
    await seedLists();
    authMock.mockResolvedValue(null as never);

    const response = await selfPosition(
      patch("http://localhost/api/me/position", { positionOther: "Anything" }),
    );

    expect(response.status).toBe(401);
  });

  it("returns 403 before onboarding is finished", async () => {
    const lists = await seedLists();
    await createEmployee({
      entraOid: "oid-self-incomplete",
      profileCompleted: false,
    });
    signedInAs("oid-self-incomplete");

    const response = await selfPosition(
      patch("http://localhost/api/me/position", {
        positionId: lists.estimator.id,
      }),
    );

    // Onboarding sets the whole profile at once; this route is not that path.
    expect(response.status).toBe(403);
  });
});

describe("fields an employee must not be able to change about themselves", () => {
  /**
   * The requirement is stronger than "ignored". positionBodySchema is a strict
   * object and does not declare these fields, so the request is REJECTED - an
   * employee never gets a 200 that quietly dropped half of what they sent.
   */
  const forbidden: Array<[string, Record<string, unknown>]> = [
    ["department", { departmentId: "11111111-1111-4111-8111-111111111111" }],
    ["email", { email: "someone.else@phb1899.com" }],
    ["admin flag", { isPlatformAdmin: true }],
    ["status", { status: "disabled" }],
    ["their own name", { firstName: "Renamed", lastName: "Person" }],
  ];

  for (const [label, extra] of forbidden) {
    it(`refuses to change ${label}`, async () => {
      const lists = await seedLists();
      const employee = await createEmployee({
        entraOid: `oid-forbid-${label.replace(/\s+/g, "-")}`,
        isPlatformAdmin: false,
      });
      await testDb.employee.update({
        where: { id: employee.id },
        data: { departmentId: lists.engineering.id },
      });
      const before = await employeeRow(employee.id);
      signedInAs(`oid-forbid-${label.replace(/\s+/g, "-")}`);

      const response = await selfPosition(
        patch("http://localhost/api/me/position", {
          positionId: lists.estimator.id,
          ...extra,
        }),
      );

      expect(response.status).toBe(422);

      const body = (await response.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("validation_failed");
      expect(body.error.message).toContain("your position");

      // Nothing changed at all - not the forbidden field, and not the position
      // that was sent alongside it.
      expect(await employeeRow(employee.id)).toEqual(before);
    });
  }

  it("has no self-service department route on disk at all", async () => {
    // The absence is the enforcement: department is admin-only because there is
    // no employee-facing endpoint for it, not because a flag says so. If someone
    // adds one, this fails and says why.
    const { existsSync } = await import("node:fs");
    const path = await import("node:path");

    const candidates = [
      "app/api/me/department/route.ts",
      "app/api/me/profile/route.ts",
    ];

    for (const candidate of candidates) {
      expect(
        existsSync(path.resolve(process.cwd(), candidate)),
        `${candidate} exists. Department is admin-only - an employee-facing route ` +
          `must not be able to set it.`,
      ).toBe(false);
    }
  });
});

describe("an employee editing someone else's profile", () => {
  it("cannot target another employee through the self route", async () => {
    const lists = await seedLists();
    const victim = await createEmployee({ entraOid: "oid-victim" });
    const actor = await createEmployee({ entraOid: "oid-actor" });
    signedInAs("oid-actor");

    // There is no id in the path or the body, so the only way to try is to smuggle
    // one in - which a strict schema rejects outright.
    const response = await selfPosition(
      patch("http://localhost/api/me/position", {
        positionId: lists.estimator.id,
        employeeId: victim.id,
        id: victim.id,
      }),
    );

    expect(response.status).toBe(422);
    expect((await employeeRow(victim.id)).positionId).toBeNull();
    expect((await employeeRow(actor.id)).positionId).toBeNull();
  });

  it("is refused by the admin position route when not an admin", async () => {
    const lists = await seedLists();
    const victim = await createEmployee({ entraOid: "oid-victim-2" });
    await createEmployee({ entraOid: "oid-nonadmin", isPlatformAdmin: false });
    signedInAs("oid-nonadmin");

    const response = await adminPosition(
      patch("http://localhost/api/admin/employees/x/position", {
        positionId: lists.estimator.id,
      }),
      routeParams(victim.id),
    );

    expect(response.status).toBe(403);
    expect((await employeeRow(victim.id)).positionId).toBeNull();
  });

  it("is refused by the admin department route when not an admin", async () => {
    const lists = await seedLists();
    const victim = await createEmployee({ entraOid: "oid-victim-3" });
    await createEmployee({ entraOid: "oid-nonadmin-2", isPlatformAdmin: false });
    signedInAs("oid-nonadmin-2");

    const response = await adminDepartment(
      patch("http://localhost/api/admin/employees/x/department", {
        departmentId: lists.ai.id,
      }),
      routeParams(victim.id),
    );

    expect(response.status).toBe(403);
    expect((await employeeRow(victim.id)).departmentId).toBeNull();
  });
});

describe("an admin changing an employee's department", () => {
  it("succeeds and records the admin as the actor", async () => {
    const lists = await seedLists();
    const target = await createEmployee({ entraOid: "oid-target-dept" });
    await testDb.employee.update({
      where: { id: target.id },
      data: { departmentId: lists.engineering.id },
    });
    const admin = await createEmployee({
      entraOid: "oid-admin-dept",
      isPlatformAdmin: true,
    });
    signedInAs("oid-admin-dept");

    const response = await adminDepartment(
      patch("http://localhost/api/admin/employees/x/department", {
        departmentId: lists.ai.id,
      }),
      routeParams(target.id),
    );

    expect(response.status).toBe(200);
    expect((await employeeRow(target.id)).departmentId).toBe(lists.ai.id);

    const events = await auditFor(target.id, "employee.department_changed");
    expect(events).toHaveLength(1);
    expect(events[0]?.actorEmployeeId).toBe(admin.id);
    expect(events[0]?.metadata).toMatchObject({ from: "Engineer", to: "AI" });
  });

  it("refuses a hidden department", async () => {
    const lists = await seedLists();
    const hidden = await testDb.department.create({
      data: { name: "Dissolved", status: "hidden" },
    });
    const target = await createEmployee({ entraOid: "oid-target-hidden-dept" });
    await createEmployee({ entraOid: "oid-admin-hidden", isPlatformAdmin: true });
    signedInAs("oid-admin-hidden");

    const response = await adminDepartment(
      patch("http://localhost/api/admin/employees/x/department", {
        departmentId: hidden.id,
      }),
      routeParams(target.id),
    );

    expect(response.status).toBe(422);
    expect((await employeeRow(target.id)).departmentId).toBeNull();
    expect(lists.ai.id).toBeDefined();
  });

  it("returns 404 for an employee that does not exist", async () => {
    const lists = await seedLists();
    await createEmployee({ entraOid: "oid-admin-404", isPlatformAdmin: true });
    signedInAs("oid-admin-404");

    const response = await adminDepartment(
      patch("http://localhost/api/admin/employees/x/department", {
        departmentId: lists.ai.id,
      }),
      routeParams("6f5c1d2e-0000-4000-8000-000000000000"),
    );

    expect(response.status).toBe(404);
  });

  it("rejects a body that also tries to change something else", async () => {
    const lists = await seedLists();
    const target = await createEmployee({ entraOid: "oid-target-extra" });
    await createEmployee({ entraOid: "oid-admin-extra", isPlatformAdmin: true });
    signedInAs("oid-admin-extra");

    const response = await adminDepartment(
      patch("http://localhost/api/admin/employees/x/department", {
        departmentId: lists.ai.id,
        isPlatformAdmin: true,
        status: "disabled",
      }),
      routeParams(target.id),
    );

    // Status and the admin flag have their own routes and their own guardrails;
    // they must not be reachable through this one.
    expect(response.status).toBe(422);

    const row = await employeeRow(target.id);
    expect(row.isPlatformAdmin).toBe(false);
    expect(row.status).toBe("active");
    expect(row.departmentId).toBeNull();
  });

  it("is a no-op when the department is unchanged, with no second audit row", async () => {
    const lists = await seedLists();
    const target = await createEmployee({ entraOid: "oid-target-noop" });
    await createEmployee({ entraOid: "oid-admin-noop", isPlatformAdmin: true });
    signedInAs("oid-admin-noop");

    const request = () =>
      adminDepartment(
        patch("http://localhost/api/admin/employees/x/department", {
          departmentId: lists.ai.id,
        }),
        routeParams(target.id),
      );

    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);

    expect(await auditFor(target.id, "employee.department_changed")).toHaveLength(1);
  });
});

describe("the two position paths coexist", () => {
  it("an admin can change an employee's position, attributed to the admin", async () => {
    const lists = await seedLists();
    const target = await createEmployee({ entraOid: "oid-target-pos" });
    const admin = await createEmployee({
      entraOid: "oid-admin-pos",
      isPlatformAdmin: true,
    });
    signedInAs("oid-admin-pos");

    const response = await adminPosition(
      patch("http://localhost/api/admin/employees/x/position", {
        positionId: lists.foreman.id,
      }),
      routeParams(target.id),
    );

    expect(response.status).toBe(200);
    expect((await employeeRow(target.id)).positionId).toBe(lists.foreman.id);

    const events = await auditFor(target.id, "employee.position_changed");
    expect(events[0]?.actorEmployeeId).toBe(admin.id);
    // Distinguishable from the employee's own change at a glance.
    expect(events[0]?.metadata).toMatchObject({ self: false });
  });

  it("last write wins, and the audit trail shows both actors in order", async () => {
    const lists = await seedLists();
    const target = await createEmployee({ entraOid: "oid-both-paths" });
    const admin = await createEmployee({
      entraOid: "oid-admin-both",
      isPlatformAdmin: true,
    });

    // The admin sets it to Estimator...
    signedInAs("oid-admin-both");
    await adminPosition(
      patch("http://localhost/api/admin/employees/x/position", {
        positionId: lists.estimator.id,
      }),
      routeParams(target.id),
    );

    // ...then the employee changes their own to free text.
    signedInAs("oid-both-paths");
    await selfPosition(
      patch("http://localhost/api/me/position", {
        positionOther: "Warehouse Lead",
      }),
    );

    const row = await employeeRow(target.id);
    expect(row.positionId).toBeNull();
    expect(row.positionOther).toBe("Warehouse Lead");

    const events = await auditFor(target.id, "employee.position_changed");
    expect(events).toHaveLength(2);
    // Newest first.
    expect(events[0]?.actorEmployeeId).toBe(target.id);
    expect(events[1]?.actorEmployeeId).toBe(admin.id);
    expect(events[0]?.metadata).toMatchObject({ from: "Estimator" });
  });

  it("an admin editing their own position is attributed to themselves", async () => {
    const lists = await seedLists();
    const admin = await createEmployee({
      entraOid: "oid-admin-self-pos",
      isPlatformAdmin: true,
    });
    signedInAs("oid-admin-self-pos");

    const response = await adminPosition(
      patch("http://localhost/api/admin/employees/x/position", {
        positionId: lists.estimator.id,
      }),
      routeParams(admin.id),
    );

    expect(response.status).toBe(200);

    const events = await auditFor(admin.id, "employee.position_changed");
    expect(events[0]?.actorEmployeeId).toBe(admin.id);
    expect(events[0]?.metadata).toMatchObject({ self: true });
  });
});
