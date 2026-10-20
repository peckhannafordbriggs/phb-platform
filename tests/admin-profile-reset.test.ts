import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { POST as profileResetRoute } from "@/app/api/admin/employees/[id]/profile-reset/route";
import { applyLoginGate } from "@/lib/auth/signin";
import { describeAuditEvent } from "@/lib/admin/audit-describe";
import {
  createEmployee,
  disconnectDb,
  resetDb,
  seedChangeOrdersModule,
  testDb,
} from "./db";
import { TEST_ALLOWED_DOMAIN, TEST_TENANT_ID } from "./constants";

/**
 * "Ask to complete profile again" - the one correction for a profile holding
 * words nobody chose.
 *
 * The case that produced it: the first production admin was seeded as
 * "Platform Administrator" ahead of his first sign-in, the sign-in of the day
 * did not stamp the token's name, the onboarding form prefilled the
 * placeholder, and it was accepted. The stamping is fixed for anyone who has
 * not completed onboarding; for anyone who has, this is the way back.
 *
 * The last test is the whole point of the design: the reset must end the
 * session, because the name is stamped at sign-in and a form opened from a
 * live session would prefill the placeholder a second time.
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

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function post(): Request {
  return new Request("http://localhost/api/admin", { method: "POST" });
}

async function makeAdmin() {
  const admin = await createEmployee({
    entraOid: "oid-admin",
    email: "admin@phb1899.com",
    firstName: "Mahi",
    lastName: "Sheth",
    isPlatformAdmin: true,
  });
  signedInAs("oid-admin");
  return admin;
}

/** A row exactly as production had it: the seed's placeholder, confirmed at onboarding. */
async function placeholderAccepted() {
  return createEmployee({
    entraOid: "oid-joel",
    email: `jschriner@${TEST_ALLOWED_DOMAIN}`,
    firstName: "Platform",
    lastName: "Administrator",
    profileCompleted: true,
    isPlatformAdmin: true,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb();
  await seedChangeOrdersModule();
});

afterAll(async () => {
  await disconnectDb();
});

describe("POST /api/admin/employees/[id]/profile-reset", () => {
  it("clears the profile, ends the session, and writes employee.profile_reset naming the admin", async () => {
    const admin = await makeAdmin();
    const target = await placeholderAccepted();
    const before = new Date();

    const response = await profileResetRoute(post(), params(target.id));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { profileCompleted: false } });

    const after = await testDb.employee.findUnique({ where: { id: target.id } });
    expect(after?.profileCompleted).toBe(false);
    expect(after?.sessionsValidAfter?.getTime()).toBeGreaterThanOrEqual(before.getTime());
    // Nothing else about the row is touched: not the name, not the flags.
    expect(after).toMatchObject({
      firstName: "Platform",
      lastName: "Administrator",
      isPlatformAdmin: true,
      status: "active",
    });

    const events = await testDb.auditEvent.findMany({
      where: { action: "employee.profile_reset" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorEmployeeId: admin.id,
      targetEmployeeId: target.id,
      metadata: { wasCompleted: true },
    });
  });

  it("reads as a sentence in the audit log", async () => {
    await makeAdmin();
    const target = await placeholderAccepted();
    await profileResetRoute(post(), params(target.id));

    const event = await testDb.auditEvent.findFirstOrThrow({
      where: { action: "employee.profile_reset" },
      include: { actor: true, target: true },
    });
    const described = describeAuditEvent(event as never);
    expect(JSON.stringify(described)).toContain(
      "Mahi Sheth asked Platform Administrator to complete their profile again",
    );
  });

  it("refuses a disabled employee with 403 and changes nothing", async () => {
    await makeAdmin();
    const target = await createEmployee({ entraOid: "oid-off", status: "disabled" });

    const response = await profileResetRoute(post(), params(target.id));

    expect(response.status).toBe(403);
    const after = await testDb.employee.findUnique({ where: { id: target.id } });
    expect(after?.profileCompleted).toBe(true);
    expect(after?.sessionsValidAfter).toBeNull();
    await expect(
      testDb.auditEvent.count({ where: { action: "employee.profile_reset" } }),
    ).resolves.toBe(0);
  });

  it("returns 404 for an unknown employee", async () => {
    await makeAdmin();
    const response = await profileResetRoute(
      post(),
      params("00000000-0000-0000-0000-000000000000"),
    );
    expect(response.status).toBe(404);
  });

  it("refuses a non-admin with 403", async () => {
    await createEmployee({ entraOid: "oid-plain", email: "plain@phb1899.com" });
    signedInAs("oid-plain");
    const target = await placeholderAccepted();

    const response = await profileResetRoute(post(), params(target.id));

    expect(response.status).toBe(403);
    const after = await testDb.employee.findUnique({ where: { id: target.id } });
    expect(after?.profileCompleted).toBe(true);
  });

  it("is allowed on yourself - you are signed out and asked", async () => {
    const admin = await makeAdmin();

    const response = await profileResetRoute(post(), params(admin.id));

    expect(response.status).toBe(200);
    const after = await testDb.employee.findUnique({ where: { id: admin.id } });
    expect(after?.profileCompleted).toBe(false);
    expect(after?.sessionsValidAfter).toBeInstanceOf(Date);
  });

  it("records wasCompleted: false when the profile was already incomplete, and still ends the session", async () => {
    await makeAdmin();
    const target = await createEmployee({ entraOid: "oid-half", profileCompleted: false });

    const response = await profileResetRoute(post(), params(target.id));

    expect(response.status).toBe(200);
    const after = await testDb.employee.findUnique({ where: { id: target.id } });
    expect(after?.sessionsValidAfter).toBeInstanceOf(Date);
    const event = await testDb.auditEvent.findFirstOrThrow({
      where: { action: "employee.profile_reset" },
    });
    expect(event.metadata).toMatchObject({ wasCompleted: false });
  });

  it("the sign-in that follows stamps the name from the token, before the form could open", async () => {
    await makeAdmin();
    const target = await placeholderAccepted();
    await profileResetRoute(post(), params(target.id));

    // The session is gone, so the next thing that happens is a sign-in.
    const outcome = await applyLoginGate({
      tid: TEST_TENANT_ID,
      oid: "oid-joel",
      email: `jschriner@${TEST_ALLOWED_DOMAIN}`,
      preferred_username: `jschriner@${TEST_ALLOWED_DOMAIN}`,
      given_name: "Joel",
      family_name: "Schriner",
    });

    expect(outcome).toMatchObject({ ok: true, employeeId: target.id });
    const after = await testDb.employee.findUnique({ where: { id: target.id } });
    expect(after).toMatchObject({
      firstName: "Joel",
      lastName: "Schriner",
      profileCompleted: false,
      isPlatformAdmin: true,
    });
  });
});
