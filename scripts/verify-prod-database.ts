import path from "node:path";
import { config as loadEnv } from "dotenv";
import { Client } from "pg";

/**
 * Verifies a freshly-created production database before anything is loaded into
 * it. READ-ONLY: it runs four SELECTs and writes nothing.
 *
 *   DATABASE_URL="postgresql://..." npx tsx scripts/verify-prod-database.ts
 *   npm run db:verify:prod
 *
 * WHY THIS EXISTS AS A SCRIPT rather than a line in the runbook: the collation
 * cannot be corrected after the database has data in it without a dump and
 * restore, and the window in which the cheap fix (drop and recreate) is
 * available is the few minutes between `az deployment group create` and
 * `prisma migrate deploy`. A check that has to be remembered and typed during
 * that window is a check that gets skipped.
 *
 * IT ASSERTS ON ACTUAL VALUES, NOT ON THE COLLATION NAME. Reading back
 * `en_US.utf8` proves the name was accepted, not that the comparison behaves
 * the way five ORDER BY name ASC clauses in this application need it to. A
 * server can report a locale-aware name and still sort bytewise - the ICU and
 * libc providers disagree, and Azure's default provider has changed before. The
 * only honest test is to ask the database to sort the two values whose order
 * differs between the two behaviours and look at what comes back.
 *
 * See the collation section of runbook.md.
 */

loadEnv({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });
loadEnv({ path: path.resolve(process.cwd(), ".env"), quiet: true });

/** Host and database only. A connection string carries a password. */
function describe(connectionString: string): string {
  const url = new URL(connectionString);
  return `${url.host}${url.pathname}`;
}

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

/**
 * The emptiness check is a warning rather than a verdict, so it has to be
 * identifiable without indexing into the results array - a positional index
 * silently means something else the moment a check is inserted above it.
 */
const EMPTINESS_CHECK = "Database is still empty (the cheap collation fix is available)";

/**
 * The decisive test. `AI` and `Administrative` are real department names, and
 * they are the pair whose order differs between a locale-aware collation and a
 * bytewise one: `C` and `POSIX` sort every uppercase letter before every
 * lowercase one, putting `AI` first.
 */
async function checkOrdering(client: Client): Promise<Check> {
  const { rows } = await client.query<{ name: string }>(
    "SELECT name FROM (VALUES ('Administrative'), ('AI')) AS t(name) ORDER BY name",
  );
  const order = rows.map((row) => row.name);
  const passed = order[0] === "Administrative";

  return {
    name: "Ordering is locale-aware (Administrative before AI)",
    passed,
    detail: passed
      ? order.join(", ")
      : `got ${order.join(", ")} - this is bytewise ordering. The database was ` +
        `created with a C or POSIX collation, or with a provider that compares ` +
        `bytes. FIX IT NOW, BEFORE MIGRATING: see runbook.md.`,
  };
}

/**
 * A wider sample, because the two-value test above passes under any collation
 * that happens to case-fold and would not notice a collation that is
 * locale-aware but wrong for English. These are the real department names that
 * the admin lists render.
 */
async function checkDepartmentSample(client: Client): Promise<Check> {
  const { rows } = await client.query<{ name: string }>(
    `SELECT name FROM (VALUES ('VDC'), ('Administrative'), ('AI'), ('Controls'), ('Service'))
       AS t(name) ORDER BY name`,
  );
  const order = rows.map((row) => row.name);
  const expected = ["Administrative", "AI", "Controls", "Service", "VDC"];
  const passed = order.join("|") === expected.join("|");

  return {
    name: "Five-name department sample sorts as a person expects",
    passed,
    detail: passed ? order.join(", ") : `got ${order.join(", ")}, expected ${expected.join(", ")}`,
  };
}

/** Reported for the record. NOT the thing being asserted on - see the header. */
async function reportCollationName(client: Client): Promise<Check> {
  const { rows } = await client.query<{
    datcollate: string;
    datctype: string;
  }>("SELECT datcollate, datctype FROM pg_database WHERE datname = current_database()");

  const row = rows[0];
  const bytewise = row !== undefined && ["C", "POSIX"].includes(row.datcollate);

  return {
    name: "Reported collation name is not C or POSIX",
    passed: !bytewise,
    detail: `datcollate=${row?.datcollate ?? "?"} datctype=${row?.datctype ?? "?"}`,
  };
}

/**
 * The database must be empty. If migrations have already run, the cheap fix for
 * a wrong collation is gone and the expensive one is a dump and restore - so
 * knowing which situation you are in changes what you do next.
 */
async function checkEmpty(client: Client): Promise<Check> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM information_schema.tables
      WHERE table_schema = 'public'`,
  );
  const count = Number.parseInt(rows[0]?.count ?? "0", 10);

  return {
    name: EMPTINESS_CHECK,
    passed: count === 0,
    detail:
      count === 0
        ? "no tables in public"
        : `${count} table(s) in public - migrations have already run. A wrong ` +
          `collation is now a pg_dump/pg_restore, not a drop and recreate.`,
  };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim();
  if (url === undefined || url.length === 0) {
    throw new Error("DATABASE_URL is not set.");
  }

  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    console.log(`Verifying ${describe(url)}\n`);

    const checks = [
      await checkOrdering(client),
      await checkDepartmentSample(client),
      await reportCollationName(client),
      await checkEmpty(client),
    ];

    for (const check of checks) {
      console.log(`${check.passed ? "PASS" : "FAIL"}  ${check.name}`);
      console.log(`      ${check.detail}`);
    }

    const failed = checks.filter((check) => !check.passed);
    console.log("");

    // The emptiness check failing is a warning, not a verdict: it says the
    // cheap fix is gone, which only matters if a collation check also failed.
    const collationFailed = failed.some((check) => check.name !== EMPTINESS_CHECK);

    if (collationFailed) {
      console.log("COLLATION IS WRONG. Do not migrate. See runbook.md.");
      process.exitCode = 1;
      return;
    }

    if (failed.length > 0) {
      console.log("Collation is correct. The warning above is about timing only.");
      return;
    }

    console.log("All checks passed. Safe to run `prisma migrate deploy`.");
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
