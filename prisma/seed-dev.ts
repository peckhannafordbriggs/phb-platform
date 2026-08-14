import { createDbClient } from "../scripts/db";

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
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "seed:dev creates fake employees and must never run against production.",
    );
  }

  const prisma = createDbClient();

  try {
    const [positions, departments, modules] = await Promise.all([
      prisma.position.findMany({ select: { id: true } }),
      prisma.department.findMany({ select: { id: true } }),
      prisma.module.findMany({ select: { key: true } }),
    ]);

    if (positions.length === 0 || departments.length === 0) {
      throw new Error("Run `npm run seed` before `npm run seed:dev`.");
    }

    const rng = mulberry32(20260814);
    const createdIds: string[] = [];
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

      const employee = await prisma.employee.upsert({
        where: { email },
        update: {},
        create: {
          email,
          firstName,
          lastName,
          // A seeded row has no Entra object ID: nobody has signed in as it.
          entraOid: null,
          profileCompleted: !isIncomplete,
          status: isDisabled ? "disabled" : "active",
          positionId: usesFreeText ? null : pick(rng, positions).id,
          positionOther: usesFreeText ? pick(rng, FREE_TEXT_POSITIONS) : null,
          departmentId: isIncomplete ? null : pick(rng, departments).id,
          lastLoginAt: isIncomplete
            ? null
            : new Date(Date.UTC(2026, 6, 1 + Math.floor(rng() * 40))),
        },
        select: { id: true, status: true, profileCompleted: true },
      });

      if (employee.status === "active" && employee.profileCompleted) {
        createdIds.push(employee.id);
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
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
