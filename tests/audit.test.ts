import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@/lib/generated/prisma/client";
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

/**
 * Asserts the operation was refused by the append-only trigger itself, not by
 * anything else. The trigger raises SQLSTATE 23001 (`restrict_violation`).
 * Since Prisma 7.10 the pg adapter reports that code as P2003, whose message
 * reads "Foreign key constraint violated", and the trigger's own text moved to
 * `meta.driverAdapterError.cause.originalMessage`. So the check reads the
 * SQLSTATE and the trigger's text from there, not from `message`.
 */
async function expectAppendOnlyRefusal(operation: Promise<unknown>, op: string) {
  const error = await operation.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  const meta = (error as Prisma.PrismaClientKnownRequestError).meta as
    | { driverAdapterError?: { cause?: { originalCode?: string; originalMessage?: string } } }
    | undefined;
  const cause = meta?.driverAdapterError?.cause;
  expect(cause?.originalCode).toBe("23001");
  expect(cause?.originalMessage).toBe(`audit_events is append-only; ${op} is not permitted`);
}

describe("audit append-only", () => {
  it("refuses an UPDATE", async () => {
    const event = await anEvent();

    await expectAppendOnlyRefusal(
      testDb.auditEvent.update({
        where: { id: event.id },
        data: { action: "grant.removed" },
      }),
      "UPDATE",
    );

    const after = await testDb.auditEvent.findUnique({ where: { id: event.id } });
    expect(after?.action).toBe("grant.added");
  });

  it("refuses a DELETE", async () => {
    const event = await anEvent();

    await expectAppendOnlyRefusal(testDb.auditEvent.delete({ where: { id: event.id } }), "DELETE");

    await expect(testDb.auditEvent.count()).resolves.toBe(1);
  });

  it("refuses a bulk deleteMany", async () => {
    await anEvent();

    await expectAppendOnlyRefusal(testDb.auditEvent.deleteMany({}), "DELETE");
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
