import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createEmployee,
  disconnectDb,
  resetDb,
  seedChangeOrdersModule,
  testDb,
} from "./db";

/**
 * AuditEvent is append-only. The application exposes no update or delete path,
 * but these tests assert the stronger property: the database refuses, so the
 * rule survives someone adding a route that tries.
 */

beforeEach(async () => {
  await resetDb();
  await seedChangeOrdersModule();
});

afterAll(async () => {
  await disconnectDb();
});

async function anEvent() {
  const employee = await createEmployee({ entraOid: "oid-audit" });
  return testDb.auditEvent.create({
    data: {
      action: "grant.added",
      actorEmployeeId: employee.id,
      targetEmployeeId: employee.id,
      moduleKey: "change-orders",
    },
  });
}

describe("audit append-only", () => {
  it("refuses an UPDATE", async () => {
    const event = await anEvent();

    await expect(
      testDb.auditEvent.update({
        where: { id: event.id },
        data: { action: "grant.removed" },
      }),
    ).rejects.toThrow(/append-only/i);

    const after = await testDb.auditEvent.findUnique({ where: { id: event.id } });
    expect(after?.action).toBe("grant.added");
  });

  it("refuses a DELETE", async () => {
    const event = await anEvent();

    await expect(
      testDb.auditEvent.delete({ where: { id: event.id } }),
    ).rejects.toThrow(/append-only/i);

    await expect(testDb.auditEvent.count()).resolves.toBe(1);
  });

  it("refuses a bulk deleteMany", async () => {
    await anEvent();

    await expect(testDb.auditEvent.deleteMany({})).rejects.toThrow(/append-only/i);
    await expect(testDb.auditEvent.count()).resolves.toBe(1);
  });

  it("refuses to delete an employee, because that would rewrite audit history", async () => {
    // The audit foreign keys are ON DELETE SET NULL, which fires the trigger as
    // an UPDATE. docs/04 says deactivate, never delete - this is the database
    // enforcing it rather than a convention.
    const event = await anEvent();

    await expect(
      testDb.employee.delete({ where: { id: event.actorEmployeeId ?? "" } }),
    ).rejects.toThrow();

    await expect(testDb.employee.count()).resolves.toBe(1);
  });

  it("records actor, target and timestamp on every event", async () => {
    const event = await anEvent();

    expect(event.actorEmployeeId).not.toBeNull();
    expect(event.targetEmployeeId).not.toBeNull();
    expect(event.occurredAt).toBeInstanceOf(Date);
  });
});
