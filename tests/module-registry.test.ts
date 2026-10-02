import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnectDb, resetDb, testDb } from "./db";

/**
 * A module row reaches production by migration, never by seed.
 *
 * Cost Intelligence and Knowledge Base shipped their pages on 23 September 2026
 * with rows in prisma/seed.ts only. Every developer database, the test
 * database and CI run the seed, so everything was green; production never
 * runs it, so the deployed platform had the pages and no rows - nothing to
 * grant, nothing in anyone's sidebar. Spotted by querying the production
 * modules table on 24 September; fixed by the migration this file drives.
 *
 * No ordinary test can catch that class of miss, because every test database
 * runs the seed. So this file does two things instead:
 *
 *   1. It drives the REAL migration file through the real psql protocol,
 *      against a database the REAL seed populated (no duplicate, no changed
 *      value) and against one without the rows (both appear, with the seed's
 *      values). The seed runs as a child process, exactly as `npm run seed`
 *      does, so the rows under test are the ones the seed writes and not a
 *      copy of them.
 *
 *   2. It holds every module that has a page under app/(modules)/ to the rule:
 *      its key is in the seed AND in a migration, or it is one of the two
 *      modules seeded on production by hand on 9 September 2026. The next
 *      module that ships pages without a migration fails here, with a message
 *      that says where the rule is written down.
 *
 * docs/10-adding-a-module.md is the walkthrough; runbook.md has the symptom
 * under "A module works locally but is missing from production".
 */

const ROOT = process.cwd();
const MIGRATIONS_DIR = path.join(ROOT, "prisma/migrations");
const MODULE_PAGES_DIR = path.join(ROOT, "app/(modules)");
const DOC = "docs/10-adding-a-module.md";

const REGISTER_MIGRATION =
  "20261001120000_register_cost_intelligence_and_knowledge_base";
const REGISTERED_KEYS = ["cost-intelligence", "knowledge-base"] as const;

/**
 * The two modules that exist on production without a migration: the seed ran
 * there once, by hand, on 9 September 2026, when these were the only rows it
 * declared. Nothing may be added to this list - a third entry is a module that
 * will be missing from production, which is the fault this file exists to
 * stop.
 */
const SEEDED_ON_PRODUCTION_BY_HAND = ["change-orders", "bas"] as const;

const migrationSql = readFileSync(
  path.join(MIGRATIONS_DIR, REGISTER_MIGRATION, "migration.sql"),
  "utf8",
);
const seedSource = readFileSync(path.join(ROOT, "prisma/seed.ts"), "utf8");

interface ModuleRow {
  key: string;
  display_name: string;
  description: string | null;
  icon: string | null;
  sort_order: number;
  status: string;
}

async function readModules(): Promise<ModuleRow[]> {
  return testDb.$queryRawUnsafe<ModuleRow[]>(
    `SELECT key, display_name, description, icon, sort_order, status::text AS status
       FROM modules ORDER BY key`,
  );
}

/**
 * The migration file, verbatim, over the simple query protocol - which is what
 * `prisma migrate deploy` effectively does with it. Comments and all; nothing
 * is parsed out of the file first, so what runs here is what runs on deploy.
 */
async function applyMigration(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(migrationSql);
  } finally {
    await client.end();
  }
}

/**
 * The real seed, as a child process, against the test database. tests/setup.ts
 * has already pointed DATABASE_URL at TEST_DATABASE_URL and set
 * BOOTSTRAP_ADMIN_EMAIL; dotenv in the child never overrides a variable that is
 * already set, so the child cannot wander back to the development database.
 */
function runSeed(): string {
  return execFileSync("npx", ["tsx", "prisma/seed.ts"], {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
    stdio: "pipe",
    shell: true,
  });
}

/** What the seed wrote, captured once and compared against in both states. */
let seeded: ModuleRow[] = [];

beforeAll(async () => {
  await resetDb();
  const output = runSeed();
  expect(output).toContain("Seeded 4 module(s)");
  seeded = await readModules();
});

afterAll(async () => {
  // The seed also installs the BAS vocabularies, which resetDb does not touch
  // and which the BAS tests build for themselves. Removed the way
  // tests/bas-office-classification.test.ts removes them.
  await testDb.$executeRaw`UPDATE bas_point_roles SET setpoint_for = NULL, status_of = NULL`;
  await testDb.basPointRole.deleteMany();
  await testDb.basEquipmentType.deleteMany();
  await resetDb();
  await disconnectDb();
});

describe("the seed, which is the reference", () => {
  it("still declares both rows - a fresh database needs them from the seed", () => {
    for (const key of REGISTERED_KEYS) {
      expect(seedSource).toContain(`key: "${key}"`);
    }
    expect(seeded.map((m) => m.key)).toEqual(
      [...REGISTERED_KEYS, ...SEEDED_ON_PRODUCTION_BY_HAND].sort(),
    );
  });
});

describe("against a database the seed already populated", () => {
  it("changes nothing: no duplicate row and no changed value", async () => {
    expect(seeded).toHaveLength(4);

    await applyMigration();

    const after = await readModules();
    expect(after).toHaveLength(4);
    expect(after).toEqual(seeded);
  });

  it("leaves a status an admin set alone", async () => {
    // The seed's upsert never writes status on re-run, for the same reason:
    // an admin who hid a module must not have it un-hidden by a deploy.
    await testDb.module.update({
      where: { key: "cost-intelligence" },
      data: { status: "hidden" },
    });

    await applyMigration();

    const row = await testDb.module.findUniqueOrThrow({
      where: { key: "cost-intelligence" },
      select: { status: true },
    });
    expect(row.status).toBe("hidden");

    await testDb.module.update({
      where: { key: "cost-intelligence" },
      data: { status: "active" },
    });
  });
});

describe("against a database without the rows", () => {
  beforeAll(async () => {
    await resetDb();
    expect(await readModules()).toEqual([]);
  });

  it("adds both rows, and only those", async () => {
    await applyMigration();

    const rows = await readModules();
    expect(rows.map((m) => m.key)).toEqual([...REGISTERED_KEYS]);
  });

  it("with exactly the values the seed uses, status active included", async () => {
    const rows = await readModules();

    for (const key of REGISTERED_KEYS) {
      const fromMigration = rows.find((m) => m.key === key);
      const fromSeed = seeded.find((m) => m.key === key);
      expect(fromSeed, key).toBeDefined();
      expect(fromMigration, key).toEqual(fromSeed);
      expect(fromMigration?.status, key).toBe("active");
    }
  });

  it("applied twice is still two rows", async () => {
    await applyMigration();

    expect(await readModules()).toHaveLength(2);
  });
});

/**
 * The guard for the NEXT module.
 *
 * Every directory under app/(modules)/ is a module's UI namespace, and the
 * page inside it guards on a key that has to be a row in `modules` - in every
 * database, production included. Cheap to check from the file tree and the
 * migration text, so it is checked.
 */
describe("every module with a page is registered by migration", () => {
  const moduleKeysWithPages = readdirSync(MODULE_PAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const migrationTexts = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      sql: readFileSync(path.join(MIGRATIONS_DIR, entry.name, "migration.sql"), "utf8"),
    }));

  /** A migration that inserts into modules and names this key. */
  function migrationRegistering(key: string): string | undefined {
    return migrationTexts.find(
      ({ sql }) => /INSERT INTO\s+"?modules"?/i.test(sql) && sql.includes(`'${key}'`),
    )?.name;
  }

  it("finds the module pages", () => {
    expect(moduleKeysWithPages).toEqual(
      expect.arrayContaining([...REGISTERED_KEYS, ...SEEDED_ON_PRODUCTION_BY_HAND]),
    );
  });

  it("each key is in the seed, so a fresh database gets the row", () => {
    for (const key of moduleKeysWithPages) {
      expect(
        seedSource,
        `app/(modules)/${key}/ has no row in prisma/seed.ts. See ${DOC}.`,
      ).toContain(`key: "${key}"`);
    }
  });

  it("each key is in a migration, so PRODUCTION gets the row", () => {
    for (const key of moduleKeysWithPages) {
      if ((SEEDED_ON_PRODUCTION_BY_HAND as readonly string[]).includes(key)) continue;

      expect(
        migrationRegistering(key),
        `app/(modules)/${key}/ has pages but no migration inserts its row into ` +
          `modules, so production will never show it. The seed does not run on ` +
          `production. Add a migration with ON CONFLICT (key) DO NOTHING - ` +
          `${REGISTER_MIGRATION} is the pattern. See ${DOC}.`,
      ).toBeDefined();
    }
  });

  it("the hand-seeded allowlist is exactly the two original modules", () => {
    // A third entry here would be a module exempted from the rule rather than
    // a module that is on production, and the list is not where that gets
    // decided. If it ever changes, the docs and this comment change with it.
    expect([...SEEDED_ON_PRODUCTION_BY_HAND].sort()).toEqual(["bas", "change-orders"]);
    for (const key of SEEDED_ON_PRODUCTION_BY_HAND) {
      expect(seedSource).toContain(`key: "${key}"`);
      expect(migrationRegistering(key)).toBeUndefined();
    }
  });

  it("the registering migration names both keys and nothing else", () => {
    // The first value of each VALUES tuple is the key.
    const keysInMigration = [...migrationSql.matchAll(/\(\s*\n\s*'([a-z-]+)',/g)].map(
      (m) => m[1],
    );
    expect(keysInMigration).toEqual([...REGISTERED_KEYS]);
  });
});
