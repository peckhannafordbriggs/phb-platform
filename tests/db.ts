import { PrismaClient } from "@/lib/generated/prisma/client";
import { createPgAdapter } from "@/lib/db/adapter";

/**
 * A direct client for arranging test fixtures and asserting on rows.
 *
 * Tests run against a real PostgreSQL database rather than a mocked Prisma
 * client. A mocked client would only prove the mock agrees with the test - the
 * authorization suite has to prove the real query rejects the real row.
 */
export const testDb = new PrismaClient({
  // The same adapter the application uses, including the UTC session pin - a
  // fixture written on a differently configured connection would not be the row
  // the code under test would have written.
  // tests/setup.ts has already redirected this to TEST_DATABASE_URL.
  adapter: createPgAdapter(process.env.DATABASE_URL ?? ""),
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

/**
 * The Building Automation module. Separate from the change-orders helper so a
 * BAS test cannot accidentally pass because a change-orders grant was present.
 */
export async function seedBasModule(): Promise<void> {
  await testDb.module.upsert({
    where: { key: "bas" },
    update: {},
    create: {
      key: "bas",
      displayName: "Building Automation",
      sortOrder: 200,
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
  /** Sorting and search tests need real names, not Person1..Person130. */
  firstName?: string;
  lastName?: string;
  lastLoginAt?: Date | null;
  positionId?: string | null;
  positionOther?: string | null;
  departmentId?: string | null;
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
      firstName: fixture.firstName ?? "Test",
      lastName: fixture.lastName ?? `Person${n}`,
      profileCompleted: fixture.profileCompleted ?? true,
      status: fixture.status ?? "active",
      isPlatformAdmin: fixture.isPlatformAdmin ?? false,
      sessionsValidAfter: fixture.sessionsValidAfter ?? null,
      lastLoginAt: fixture.lastLoginAt ?? null,
      positionId: fixture.positionId ?? null,
      positionOther: fixture.positionOther ?? null,
      departmentId: fixture.departmentId ?? null,
    },
  });
}

/**
 * A realistic admin list: 130 employees, the volume the dev seed produces.
 *
 * PHASE-10 is explicit that this is the bar - "sorting and pagination bugs only
 * appear past a page", and four rows never cross one. Deterministic rather than
 * random, so a failure is reproducible: the shape below is fixed by index.
 *
 *   - every 7th is disabled
 *   - every 11th has never signed in
 *   - every 5th has no grant at all
 *   - every 13th has an incomplete profile
 *   - names cycle through a fixed list so ordering is checkable by hand
 *
 * Created with createMany for speed: 130 individual inserts is several seconds
 * per test file, and this fixture is used by more than one.
 */
const SURNAMES = [
  "Adams", "Bittner", "Carver", "Delgado", "Ellery", "Fanning", "Gearhart",
  "Horvath", "Ivers", "Jessup", "Knemeyer", "Lockhart", "Mercer",
];
const FORENAMES = ["Alex", "Brooke", "Casey", "Dana", "Erin", "Frank", "Gale"];

export interface VolumeFixtureOptions {
  count?: number;
  moduleKey?: string;
}

export async function createEmployeeVolume(
  options: VolumeFixtureOptions = {},
): Promise<{ ids: string[]; total: number; withoutGrant: number }> {
  const count = options.count ?? 130;
  const moduleKey = options.moduleKey ?? "change-orders";

  const base = fixtureCounter;
  fixtureCounter += count;

  const rows = Array.from({ length: count }, (_, i) => {
    const n = base + i + 1;
    return {
      email: `bulk${n}@phb1899.com`,
      entraOid: `oid-bulk-${n}`,
      firstName: FORENAMES[i % FORENAMES.length] ?? "Alex",
      lastName: `${SURNAMES[i % SURNAMES.length] ?? "Adams"}${i}`,
      profileCompleted: i % 13 !== 0,
      status: (i % 7 === 0 ? "disabled" : "active") as "active" | "disabled",
      isPlatformAdmin: false,
      lastLoginAt: i % 11 === 0 ? null : new Date(2026, 0, 1 + (i % 300)),
    };
  });

  await testDb.employee.createMany({ data: rows });

  const created = await testDb.employee.findMany({
    where: { email: { in: rows.map((r) => r.email) } },
    select: { id: true, email: true },
  });

  const byEmail = new Map(created.map((e) => [e.email, e.id]));
  const ids = rows.map((r) => byEmail.get(r.email)).filter((id): id is string => id !== undefined);

  // Every 5th gets no grant, which is what makes the "no grants" filter and the
  // default "has at least one grant" scope testable at volume.
  const granted = ids.filter((_, i) => i % 5 !== 0);
  await testDb.moduleGrant.createMany({
    data: granted.map((employeeId) => ({ employeeId, moduleKey })),
    skipDuplicates: true,
  });

  return { ids, total: count, withoutGrant: ids.length - granted.length };
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
