import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { POST as onboardingRoute } from "@/app/api/onboarding/route";
import { GET as meRoute } from "@/app/api/me/route";
import { applyLoginGate } from "@/lib/auth/signin";
import {
  createEmployee,
  disconnectDb,
  resetDb,
  seedChangeOrdersModule,
  testDb,
} from "./db";
import { TEST_ALLOWED_DOMAIN, TEST_TENANT_ID } from "./constants";

const authMock = vi.mocked(auth);

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/onboarding", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedLists() {
  const position = await testDb.position.create({ data: { name: "Estimator" } });
  const department = await testDb.department.create({
    data: { name: "Estimating" },
  });
  return { position, department };
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb();
  await seedChangeOrdersModule();
});

afterAll(async () => {
  await disconnectDb();
});

describe("self-provisioning", () => {
  const claims = {
    tid: TEST_TENANT_ID,
    oid: "oid-newcomer",
    email: `newcomer@${TEST_ALLOWED_DOMAIN}`,
    preferred_username: `newcomer@${TEST_ALLOWED_DOMAIN}`,
    given_name: "New",
    family_name: "Comer",
  };

  it("creates an employee with zero grants and an incomplete profile", async () => {
    const outcome = await applyLoginGate(claims);

    expect(outcome.ok).toBe(true);
    const employee = await testDb.employee.findUnique({
      where: { entraOid: "oid-newcomer" },
      include: { grants: true },
    });

    expect(employee).not.toBeNull();
    expect(employee?.profileCompleted).toBe(false);
    expect(employee?.grants).toHaveLength(0);
    expect(employee?.isPlatformAdmin).toBe(false);
    expect(employee?.lastLoginAt).toBeInstanceOf(Date);
  });

  it("writes employee.provisioned once, and not again on the second sign-in", async () => {
    await applyLoginGate(claims);
    await applyLoginGate(claims);

    await expect(
      testDb.auditEvent.count({ where: { action: "employee.provisioned" } }),
    ).resolves.toBe(1);
    await expect(testDb.employee.count()).resolves.toBe(1);
  });

  it("stamps entraOid onto a row seeded ahead of first sign-in, keeping the row", async () => {
    const seeded = await createEmployee({
      email: `bootstrap@${TEST_ALLOWED_DOMAIN}`,
      entraOid: null,
      isPlatformAdmin: true,
      profileCompleted: false,
    });

    const outcome = await applyLoginGate({
      ...claims,
      oid: "oid-bootstrap",
      email: `bootstrap@${TEST_ALLOWED_DOMAIN}`,
      preferred_username: `bootstrap@${TEST_ALLOWED_DOMAIN}`,
    });

    expect(outcome).toMatchObject({ ok: true, employeeId: seeded.id });
    const after = await testDb.employee.findUnique({ where: { id: seeded.id } });
    expect(after?.entraOid).toBe("oid-bootstrap");
    // The seeded admin flag survives.
    expect(after?.isPlatformAdmin).toBe(true);
    await expect(testDb.employee.count()).resolves.toBe(1);
  });

  it("rejects a disabled employee and creates nothing", async () => {
    await createEmployee({
      email: `gone@${TEST_ALLOWED_DOMAIN}`,
      entraOid: "oid-gone",
      status: "disabled",
    });

    const outcome = await applyLoginGate({
      ...claims,
      oid: "oid-gone",
      email: `gone@${TEST_ALLOWED_DOMAIN}`,
      preferred_username: `gone@${TEST_ALLOWED_DOMAIN}`,
    });

    expect(outcome).toMatchObject({ ok: false, reason: "employee_disabled" });
    const denial = await testDb.auditEvent.findFirst({
      where: { action: "login.denied" },
    });
    expect(denial).not.toBeNull();
  });

  it("writes login.denied and creates NO employee row for a rejected sign-in", async () => {
    const outcome = await applyLoginGate({
      ...claims,
      tid: "99999999-9999-9999-9999-999999999999",
    });

    expect(outcome).toMatchObject({ ok: false, reason: "tenant_mismatch" });
    await expect(testDb.employee.count()).resolves.toBe(0);

    const denial = await testDb.auditEvent.findFirst({
      where: { action: "login.denied" },
    });
    expect(denial).not.toBeNull();
    expect(denial?.targetEmployeeId).toBeNull();
    expect(denial?.metadata).toMatchObject({ reason: "tenant_mismatch" });
  });

  it("rejects a guest and creates no employee row", async () => {
    const outcome = await applyLoginGate({
      ...claims,
      preferred_username: `vendor_outside.com#EXT#@${TEST_ALLOWED_DOMAIN}`,
    });

    expect(outcome).toMatchObject({ ok: false, reason: "guest_account" });
    await expect(testDb.employee.count()).resolves.toBe(0);
  });
});

describe("onboarding", () => {
  it("rejects an incomplete profile server-side", async () => {
    await createEmployee({ entraOid: "oid-onb1", profileCompleted: false });
    signedInAs("oid-onb1");
    const { position } = await seedLists();

    // No department.
    const response = await onboardingRoute(
      post({ firstName: "Ann", lastName: "Lee", positionId: position.id }) as never,
    );

    expect(response.status).toBe(422);
    const after = await testDb.employee.findUnique({
      where: { entraOid: "oid-onb1" },
    });
    expect(after?.profileCompleted).toBe(false);
  });

  it("rejects a blank first name", async () => {
    await createEmployee({ entraOid: "oid-onb2", profileCompleted: false });
    signedInAs("oid-onb2");
    const { position, department } = await seedLists();

    const response = await onboardingRoute(
      post({
        firstName: "   ",
        lastName: "Lee",
        positionId: position.id,
        departmentId: department.id,
      }) as never,
    );

    expect(response.status).toBe(422);
  });

  it("rejects a position that is neither chosen nor described", async () => {
    await createEmployee({ entraOid: "oid-onb3", profileCompleted: false });
    signedInAs("oid-onb3");
    const { department } = await seedLists();

    const response = await onboardingRoute(
      post({
        firstName: "Ann",
        lastName: "Lee",
        departmentId: department.id,
      }) as never,
    );

    expect(response.status).toBe(422);
  });

  it("ignores an email in the request body", async () => {
    const employee = await createEmployee({
      email: `real@${TEST_ALLOWED_DOMAIN}`,
      entraOid: "oid-onb4",
      profileCompleted: false,
    });
    signedInAs("oid-onb4");
    const { position, department } = await seedLists();

    const response = await onboardingRoute(
      post({
        firstName: "Ann",
        lastName: "Lee",
        positionId: position.id,
        departmentId: department.id,
        // All three of these must be ignored.
        email: "attacker@evil.example",
        status: "disabled",
        isPlatformAdmin: true,
      }) as never,
    );

    expect(response.status).toBe(200);
    const after = await testDb.employee.findUnique({ where: { id: employee.id } });
    expect(after?.email).toBe(`real@${TEST_ALLOWED_DOMAIN}`);
    expect(after?.status).toBe("active");
    expect(after?.isPlatformAdmin).toBe(false);
    expect(after?.profileCompleted).toBe(true);
  });

  it("refuses a hidden department", async () => {
    await createEmployee({ entraOid: "oid-onb5", profileCompleted: false });
    signedInAs("oid-onb5");
    const { position } = await seedLists();
    const hidden = await testDb.department.create({
      data: { name: "Retired Dept", status: "hidden" },
    });

    const response = await onboardingRoute(
      post({
        firstName: "Ann",
        lastName: "Lee",
        positionId: position.id,
        departmentId: hidden.id,
      }) as never,
    );

    expect(response.status).toBe(422);
  });

  it("accepts a free-text position and records it for admin cleanup", async () => {
    await createEmployee({ entraOid: "oid-onb6", profileCompleted: false });
    signedInAs("oid-onb6");
    const { department } = await seedLists();

    const response = await onboardingRoute(
      post({
        firstName: "Ann",
        lastName: "Lee",
        positionOther: "Warehouse Lead",
        departmentId: department.id,
      }) as never,
    );

    expect(response.status).toBe(200);
    const after = await testDb.employee.findUnique({
      where: { entraOid: "oid-onb6" },
    });
    expect(after?.positionOther).toBe("Warehouse Lead");
    expect(after?.positionId).toBeNull();
  });

  it("writes employee.profile_completed", async () => {
    const employee = await createEmployee({
      entraOid: "oid-onb7",
      profileCompleted: false,
    });
    signedInAs("oid-onb7");
    const { position, department } = await seedLists();

    await onboardingRoute(
      post({
        firstName: "Ann",
        lastName: "Lee",
        positionId: position.id,
        departmentId: department.id,
      }) as never,
    );

    const event = await testDb.auditEvent.findFirst({
      where: { action: "employee.profile_completed" },
    });
    expect(event?.targetEmployeeId).toBe(employee.id);
    expect(event?.actorEmployeeId).toBe(employee.id);
  });
});

describe("/api/me", () => {
  it("works before the profile is complete, and reports it", async () => {
    await createEmployee({ entraOid: "oid-me1", profileCompleted: false });
    signedInAs("oid-me1");

    const response = await meRoute();
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      data: { profileCompleted: boolean; modules: unknown[] };
    };
    expect(body.data.profileCompleted).toBe(false);
  });

  it("shows no systems for a newly onboarded employee", async () => {
    await createEmployee({ entraOid: "oid-me2", profileCompleted: true });
    signedInAs("oid-me2");

    const body = (await (await meRoute()).json()) as {
      data: { modules: unknown[]; grantedModuleKeys: string[] };
    };

    expect(body.data.modules).toHaveLength(0);
    expect(body.data.grantedModuleKeys).toHaveLength(0);
  });

  it("never includes anything that authorizes on its own", async () => {
    await createEmployee({ entraOid: "oid-me3" });
    signedInAs("oid-me3");

    const body = (await (await meRoute()).json()) as { data: Record<string, unknown> };

    // The payload describes what the sidebar renders. It is not a capability
    // token: the guard re-reads grants from the database on every request.
    expect(Object.keys(body.data).sort()).toEqual([
      "employee",
      "grantedModuleKeys",
      "isPlatformAdmin",
      "modules",
      "profileCompleted",
    ]);
  });
});
