import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

/**
 * A direct client for arranging test fixtures and asserting on rows.
 *
 * Tests run against a real PostgreSQL database rather than a mocked Prisma
 * client. A mocked client would only prove the mock agrees with the test - the
 * authorization suite has to prove the real query rejects the real row.
 */
export const testDb = new PrismaClient({
  adapter: new PrismaPg({
    // tests/setup.ts has already redirected this to TEST_DATABASE_URL.
    connectionString: process.env.DATABASE_URL ?? "",
  }),
});

// Order matters only for readability - CASCADE handles the foreign keys.
// TRUNCATE does not fire row-level triggers, so the audit append-only trigger
// does not block cleanup.
const TABLES = [
  "audit_events",
  "module_grants",
  "employees",
  "modules",
  "positions",
  "departments",
];

export async function resetDb(): Promise<void> {
  await testDb.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
}

export async function disconnectDb(): Promise<void> {
  await testDb.$disconnect();
}

/** The module every authorization test keys on. */
export async function seedChangeOrdersModule(): Promise<void> {
  await testDb.module.upsert({
    where: { key: "change-orders" },
    update: {},
    create: {
      key: "change-orders",
      displayName: "Change Orders",
      sortOrder: 100,
    },
  });
}

export interface EmployeeFixture {
  email?: string;
  entraOid?: string | null;
  profileCompleted?: boolean;
  status?: "active" | "disabled";
  isPlatformAdmin?: boolean;
  sessionsValidAfter?: Date | null;
}

let fixtureCounter = 0;

export async function createEmployee(fixture: EmployeeFixture = {}) {
  fixtureCounter += 1;
  const n = fixtureCounter;

  return testDb.employee.create({
    data: {
      email: fixture.email ?? `person${n}@phb1899.com`,
      entraOid:
        fixture.entraOid === undefined ? `oid-${n}` : fixture.entraOid,
      firstName: "Test",
      lastName: `Person${n}`,
      profileCompleted: fixture.profileCompleted ?? true,
      status: fixture.status ?? "active",
      isPlatformAdmin: fixture.isPlatformAdmin ?? false,
      sessionsValidAfter: fixture.sessionsValidAfter ?? null,
    },
  });
}

export async function grantModule(
  employeeId: string,
  moduleKey = "change-orders",
): Promise<void> {
  await testDb.moduleGrant.upsert({
    where: { employeeId_moduleKey: { employeeId, moduleKey } },
    update: {},
    create: { employeeId, moduleKey },
  });
}

export async function revokeModule(
  employeeId: string,
  moduleKey = "change-orders",
): Promise<void> {
  await testDb.moduleGrant.deleteMany({ where: { employeeId, moduleKey } });
}
