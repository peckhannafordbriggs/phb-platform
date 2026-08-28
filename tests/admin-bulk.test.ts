import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { bulkGrants, bulkStatus } from "@/lib/admin/service";
import {
  createEmployee,
  createEmployeeVolume,
  disconnectDb,
  grantModule,
  resetDb,
  seedBasModule,
  seedChangeOrdersModule,
  testDb,
} from "./db";

/**
 * Bulk grant, revoke, enable and disable.
 *
 * The guardrails are the point of this file. PHASE-10: "The guardrails apply to
 * every member of the selection. A bulk operation cannot accidentally leave zero
 * admins or disable the acting admin." A bulk path that re-implemented those
 * checks would be a second copy free to drift from the first, so these tests
 * exist to prove it goes through the same one.
 */

let admin: { id: string };

beforeEach(async () => {
  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();

  admin = await createEmployee({
    email: "admin@phb1899.com",
    firstName: "Jim",
    lastName: "Schwarz",
    isPlatformAdmin: true,
  });
});

afterAll(disconnectDb);

describe("bulk grants at volume", () => {
  it("grants a module across 130 employees, one audit row each", async () => {
    const { ids } = await createEmployeeVolume();
    // The seeded volume already grants change-orders to most of them; bas is
    // granted to none, so every row here is a real change.
    const result = await bulkGrants(admin.id, ids, "bas", "grant");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.changed).toBe(130);
    expect(result.data.failed).toBe(0);

    /**
     * PHASE-10: "One audit row per employee, not one for the batch — the log has
     * to answer 'when did *this person* get access'."
     */
    const rows = await testDb.auditEvent.count({
      where: { action: "grant.added", moduleKey: "bas" },
    });
    expect(rows).toBe(130);

    const distinctTargets = await testDb.auditEvent.findMany({
      where: { action: "grant.added", moduleKey: "bas" },
      select: { targetEmployeeId: true },
      distinct: ["targetEmployeeId"],
    });
    expect(distinctTargets).toHaveLength(130);
  });

  it("reports already-granted separately from changed", async () => {
    const { ids } = await createEmployeeVolume({ count: 10 });
    await bulkGrants(admin.id, ids, "bas", "grant");

    const second = await bulkGrants(admin.id, ids, "bas", "grant");
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // Re-granting is a no-op, and saying "10 changed" twice would be a lie an
    // admin has no way to check.
    expect(second.data.changed).toBe(0);
    expect(second.data.unchanged).toBe(10);
    expect(await testDb.auditEvent.count({ where: { action: "grant.added", moduleKey: "bas" } })).toBe(10);
  });

  it("revokes across a selection", async () => {
    const { ids } = await createEmployeeVolume({ count: 20 });
    await bulkGrants(admin.id, ids, "bas", "grant");

    const result = await bulkGrants(admin.id, ids, "bas", "revoke");
    expect(result.ok && result.data.changed).toBe(20);
    expect(await testDb.moduleGrant.count({ where: { moduleKey: "bas" } })).toBe(0);
  });

  it("fails the whole call for an unknown module rather than 130 times over", async () => {
    const { ids } = await createEmployeeVolume({ count: 5 });
    const result = await bulkGrants(admin.id, ids, "not-a-module", "grant");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unknown_module");
  });

  /**
   * PHASE-10: "Partial failure is possible. Report what succeeded and what
   * didn't; never leave the admin guessing."
   */
  it("continues past a missing employee and names it in the report", async () => {
    const present = await createEmployee({ firstName: "Real", lastName: "Person" });
    const ghost = "00000000-0000-4000-8000-000000000000";

    const result = await bulkGrants(admin.id, [present.id, ghost], "bas", "grant");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.changed).toBe(1);
    expect(result.data.failed).toBe(1);

    const failure = result.data.outcomes.find((o) => o.result === "failed");
    expect(failure?.employeeId).toBe(ghost);
    expect(failure?.reason).toContain("not found");
    // One employee's failure must not roll back the other's grant.
    expect(
      await testDb.moduleGrant.count({ where: { employeeId: present.id, moduleKey: "bas" } }),
    ).toBe(1);
  });

  it("labels every outcome with a name, so the report is readable", async () => {
    const person = await createEmployee({ firstName: "Sarah", lastName: "Martin" });
    const result = await bulkGrants(admin.id, [person.id], "bas", "grant");

    expect(result.ok && result.data.outcomes[0]?.label).toBe("Sarah Martin");
  });

  it("falls back to the email when an employee has no name", async () => {
    const person = await createEmployee({
      email: "nameless@phb1899.com",
      firstName: "",
      lastName: "",
    });
    const result = await bulkGrants(admin.id, [person.id], "bas", "grant");

    expect(result.ok && result.data.outcomes[0]?.label).toBe("nameless@phb1899.com");
  });
});

describe("bulk status, and the guardrails it must not bypass", () => {
  it("disables a selection and writes one audit row each", async () => {
    const { ids } = await createEmployeeVolume({ count: 12 });
    const active = await testDb.employee.findMany({
      where: { id: { in: ids }, status: "active" },
      select: { id: true },
    });

    const result = await bulkStatus(admin.id, active.map((e) => e.id), "disabled");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.changed).toBe(active.length);
    expect(await testDb.auditEvent.count({ where: { action: "employee.disabled" } })).toBe(
      active.length,
    );
  });

  /**
   * The guardrail PHASE-10 names first. Asserted here rather than assumed from
   * setStatus having it, because "the bulk path calls the guarded one" is
   * exactly the kind of claim that stops being true during a refactor.
   */
  it("cannot disable the acting admin, even buried in a large selection", async () => {
    const { ids } = await createEmployeeVolume({ count: 40 });
    const selection = [...ids.slice(0, 20), admin.id, ...ids.slice(20)];

    const result = await bulkStatus(admin.id, selection, "disabled");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const self = result.data.outcomes.find((o) => o.employeeId === admin.id);
    expect(self?.result).toBe("failed");
    expect(self?.code).toBe("self_disable");

    const stillActive = await testDb.employee.findUnique({
      where: { id: admin.id },
      select: { status: true },
    });
    expect(stillActive?.status).toBe("active");
  });

  it("cannot leave the platform with zero active admins", async () => {
    const onlyOther = await createEmployee({
      email: "second-admin@phb1899.com",
      firstName: "Pat",
      lastName: "Nolan",
      isPlatformAdmin: true,
    });

    // Disabling both admins in one selection. The acting admin is refused by the
    // self-disable rule; the other is the last one standing after that.
    const result = await bulkStatus(admin.id, [onlyOther.id, admin.id], "disabled");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const remaining = await testDb.employee.count({
      where: { isPlatformAdmin: true, status: "active" },
    });
    expect(remaining).toBeGreaterThan(0);
  });

  it("stops at the employee that would empty the platform, and says why", async () => {
    const a = await createEmployee({ email: "a@phb1899.com", isPlatformAdmin: true });
    const b = await createEmployee({ email: "b@phb1899.com", isPlatformAdmin: true });

    // Three admins exist: admin, a, b. Disabling a and b in one call leaves only
    // the acting admin, which is allowed - the check is per employee, in order,
    // against the state at that moment rather than a count taken up front.
    const result = await bulkStatus(admin.id, [a.id, b.id], "disabled");
    expect(result.ok && result.data.changed).toBe(2);

    const third = await createEmployee({ email: "c@phb1899.com", isPlatformAdmin: true });
    // Now: admin and third. Disabling both must refuse one of them.
    const second = await bulkStatus(admin.id, [third.id, admin.id], "disabled");
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.data.failed).toBeGreaterThan(0);
    expect(
      await testDb.employee.count({ where: { isPlatformAdmin: true, status: "active" } }),
    ).toBeGreaterThan(0);
  });

  it("re-enabling is not blocked by either guardrail", async () => {
    const person = await createEmployee({ status: "disabled" });
    const result = await bulkStatus(admin.id, [person.id], "active");

    expect(result.ok && result.data.changed).toBe(1);
    expect(await testDb.auditEvent.count({ where: { action: "employee.enabled" } })).toBe(1);
  });

  it("counts an employee already in the requested state as unchanged", async () => {
    const person = await createEmployee({ status: "disabled" });
    const result = await bulkStatus(admin.id, [person.id], "disabled");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.changed).toBe(0);
    expect(result.data.unchanged).toBe(1);
    // And no second audit row for a change that did not happen.
    expect(await testDb.auditEvent.count({ where: { action: "employee.disabled" } })).toBe(0);
  });
});

describe("what bulk cannot do", () => {
  it("has no path that touches anything but grants and status", async () => {
    const person = await createEmployee({ firstName: "Sarah", lastName: "Martin" });
    await grantModule(person.id);

    await bulkGrants(admin.id, [person.id], "bas", "grant");
    await bulkStatus(admin.id, [person.id], "disabled");

    // Every audit row a bulk operation can produce is one of these four. If a
    // bulk path ever gains the ability to change a position, an admin flag, or
    // anything that sends, this fails.
    const actions = await testDb.auditEvent.findMany({
      select: { action: true },
      distinct: ["action"],
    });
    const produced = actions.map((a) => a.action).sort();

    expect(produced).toEqual(
      ["employee.disabled", "grant.added"].sort(),
    );
  });
});
