import { createDbClient } from "../scripts/db";
import { assertLocalDatabase } from "../scripts/local-only";

/**
 * Development seed - fake employees only.
 *
 * Search, filtering and pagination bugs only appear at volume, so this creates
 * more than a hundred rows with a realistic spread: a handful granted, some
 * disabled, some with an incomplete profile, some with a free-text position.
 *
 * Every address is under a .invalid domain (reserved by RFC 2606), so a seeded
 * row can never be confused with a real employee and could never sign in.
 */

const FAKE_DOMAIN = "seed.invalid";
const EMPLOYEE_COUNT = 130;

const FIRST_NAMES = [
  "James", "Maria", "Robert", "Linda", "Michael", "Patricia", "David", "Jennifer",
  "William", "Elizabeth", "Richard", "Barbara", "Joseph", "Susan", "Thomas",
  "Jessica", "Charles", "Sarah", "Daniel", "Karen", "Matthew", "Nancy", "Anthony",
  "Lisa", "Mark", "Betty", "Donald", "Margaret", "Steven", "Sandra", "Andrew",
  "Ashley", "Kenneth", "Kimberly", "Joshua", "Emily", "Kevin", "Donna", "Brian",
  "Michelle", "George", "Carol", "Timothy", "Amanda", "Ronald", "Dorothy",
];

const LAST_NAMES = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
  "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson",
  "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee", "Perez", "Thompson",
  "White", "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson", "Walker",
  "Young", "Allen", "King", "Wright", "Scott", "Torres", "Nguyen", "Hill",
  "Flores", "Green", "Adams", "Nelson", "Baker", "Hall", "Rivera", "Campbell",
];

const FREE_TEXT_POSITIONS = [
  "Warehouse Lead",
  "Fleet Coordinator",
  "Safety Officer",
  "BIM Technician",
];

/** Deterministic PRNG - the same seed run always produces the same rows. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error("cannot pick from an empty list");
  return item;
}

async function main(): Promise<void> {
  // Two independent guards, both before any connection is opened.
  //
  // NODE_ENV is the declared intent, and it is the weaker of the two: it is a
  // variable a developer sets on their own machine, so it says nothing about
  // which database DATABASE_URL actually names. `NODE_ENV=development` with a
  // production URL in the environment is the realistic accident, and the first
  // check alone would wave it through.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "seed:dev creates fake employees and must never run against production.",
    );
  }

  // So the second guard checks the destination rather than the intent.
  assertLocalDatabase(process.env.DATABASE_URL, "seed:dev");

  const prisma = createDbClient();

  try {
    // Ordered, so a re-run picks the same rows. An unordered findMany makes the
    // whole seed non-deterministic however carefully the PRNG is seeded.
    const [positions, departments, modules] = await Promise.all([
      prisma.position.findMany({
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      prisma.department.findMany({
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      prisma.module.findMany({ select: { key: true }, orderBy: { key: "asc" } }),
    ]);

    if (positions.length === 0 || departments.length === 0) {
      throw new Error("Run `npm run seed` before `npm run seed:dev`.");
    }

    const rng = mulberry32(20260814);
    const createdIds: string[] = [];
    const perDepartment = new Map<string, number>();
    const generatedEmails = new Set<string>();
    let disabled = 0;
    let incomplete = 0;
    let freeText = 0;

    for (let i = 0; i < EMPLOYEE_COUNT; i += 1) {
      const firstName = pick(rng, FIRST_NAMES);
      const lastName = pick(rng, LAST_NAMES);
      // The index keeps the address unique when a name repeats.
      const email =
        `${firstName}.${lastName}${i}@${FAKE_DOMAIN}`.toLowerCase();

      const roll = rng();
      const isDisabled = roll < 0.08;
      const isIncomplete = !isDisabled && roll < 0.2;
      const usesFreeText = !isIncomplete && rng() < 0.06;

      if (isDisabled) disabled += 1;
      if (isIncomplete) incomplete += 1;
      if (usesFreeText) freeText += 1;

      generatedEmails.add(email);

      // One draw per row, exactly as before, even though the value is used
      // differently now.
      //
      // That matters more than it looks. The email address is built from PRNG
      // draws, so adding or removing an rng() call shifts every later draw and
      // renames every subsequent row. The old rows then no longer match by email,
      // this script can no longer address them, and they survive as orphans -
      // permanently, once audit_events references them. Keep the number of draws
      // per row stable, or accept that the fake rows have to be rebuilt.
      const department = isIncomplete ? null : pick(rng, departments);
      if (department !== null) {
        perDepartment.set(
          department.name,
          (perDepartment.get(department.name) ?? 0) + 1,
        );
      }

      const profile = {
        firstName,
        lastName,
        // A seeded row has no Entra object ID: nobody has signed in as it.
        entraOid: null,
        profileCompleted: !isIncomplete,
        status: isDisabled ? ("disabled" as const) : ("active" as const),
        positionId: usesFreeText ? null : pick(rng, positions).id,
        positionOther: usesFreeText ? pick(rng, FREE_TEXT_POSITIONS) : null,
        departmentId: department?.id ?? null,
        lastLoginAt: isIncomplete
          ? null
          : new Date(Date.UTC(2026, 6, 1 + Math.floor(rng() * 40))),
      };

      const employee = await prisma.employee.upsert({
        where: { email },
        // The same values on update as on create, so this is genuinely
        // regenerable. It used to be `update: {}`, which meant a run after the
        // department list changed left every existing fake row pointing at
        // nothing. Grants are untouched - they are keyed separately below.
        update: profile,
        create: { email, ...profile },
        select: { id: true, status: true, profileCompleted: true },
      });

      if (employee.status === "active" && employee.profileCompleted) {
        createdIds.push(employee.id);
      }
    }

    // Remove fake rows this script no longer generates.
    //
    // Without this, changing the generation logic silently leaves the previous
    // rows behind - and because the department list changed under them, they sit
    // in the admin screens as employees with no department, looking like a bug in
    // the filter rather than seed drift.
    //
    // Only @seed.invalid addresses are ever considered. A real employee is never
    // in scope, whatever else is in the database.
    const stale = await prisma.employee.findMany({
      where: {
        email: { endsWith: `@${FAKE_DOMAIN}` },
        NOT: { email: { in: [...generatedEmails] } },
      },
      select: { id: true, email: true },
    });

    let pruned = 0;
    const keptForAudit: string[] = [];

    if (stale.length > 0) {
      const staleIds = stale.map((row) => row.id);

      // audit_events is append-only, enforced by a database trigger. The foreign
      // keys are ON DELETE SET NULL, which fires that trigger as an UPDATE, so an
      // employee with audit history cannot be deleted at all - see
      // docs/runbook.md. Check first rather than letting the delete blow up.
      const references = await prisma.auditEvent.findMany({
        where: {
          OR: [
            { targetEmployeeId: { in: staleIds } },
            { actorEmployeeId: { in: staleIds } },
          ],
        },
        select: { targetEmployeeId: true, actorEmployeeId: true },
      });

      const referenced = new Set(
        references
          .flatMap((event) => [event.targetEmployeeId, event.actorEmployeeId])
          .filter((id): id is string => id !== null),
      );

      const deletable = stale.filter((row) => !referenced.has(row.id));
      keptForAudit.push(
        ...stale.filter((row) => referenced.has(row.id)).map((row) => row.email),
      );

      if (deletable.length > 0) {
        // Grants cascade. Nothing else references an employee.
        const result = await prisma.employee.deleteMany({
          where: { id: { in: deletable.map((row) => row.id) } },
        });
        pruned = result.count;
      }
    }

    // Only a handful are granted - the default admin-list filter shows exactly
    // these, and everyone else only when the toggle is switched on.
    let grants = 0;
    for (const moduleRow of modules) {
      for (const employeeId of createdIds.slice(0, 6)) {
        await prisma.moduleGrant.upsert({
          where: {
            employeeId_moduleKey: { employeeId, moduleKey: moduleRow.key },
          },
          update: {},
          // grantedById stays null: the system issued this, not an admin.
          create: { employeeId, moduleKey: moduleRow.key },
        });
        grants += 1;
      }
    }

    console.log(
      `Seeded ${EMPLOYEE_COUNT} fake employees ` +
        `(${disabled} disabled, ${incomplete} incomplete, ${freeText} free-text position), ` +
        `${grants} grants.`,
    );
    if (pruned > 0) {
      console.log(`Pruned ${pruned} stale fake employee(s) from an earlier seed.`);
    }
    if (keptForAudit.length > 0) {
      console.warn(
        `${keptForAudit.length} stale fake employee(s) could NOT be removed: they are ` +
          `referenced by audit_events, which is append-only. They will keep appearing ` +
          `in the admin screens. Run \`npx prisma migrate reset\` for a clean database.`,
      );
    }

    console.log("Department spread:");
    for (const { name } of departments) {
      console.log(`  ${name}: ${perDepartment.get(name) ?? 0}`);
    }
    const emptyDepartments = departments.filter(
      (d) => (perDepartment.get(d.name) ?? 0) === 0,
    );
    if (emptyDepartments.length > 0) {
      console.warn(
        `No fake employee landed in: ${emptyDepartments.map((d) => d.name).join(", ")}. ` +
          `Raise EMPLOYEE_COUNT or change the seed if a filter needs every department populated.`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
