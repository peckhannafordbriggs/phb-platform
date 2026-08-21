import { readdir } from "node:fs/promises";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { Client } from "pg";

/**
 * Runs ONCE for the whole suite, before any test file.
 *
 * It exists because of a specific, expensive failure: B1 added twelve `bas_*`
 * tables in a migration, `npm test` reported 416/416 green, and the test
 * database had none of those tables. No B1 test read one, so nothing noticed.
 * The next phase to touch them got a `500` where it expected a `200` and the
 * cause looked like a code defect.
 *
 * `prisma migrate deploy` applies migrations to DATABASE_URL - the development
 * database. Only `npm run db:test:setup` migrates TEST_DATABASE_URL. Nothing
 * forced that to be run. This does.
 *
 * Deliberately its own thing rather than part of tests/setup.ts: setup.ts runs
 * per file, and twenty-three identical connections asking the same question is
 * waste. Deliberately not a test either - a test that fails is one red line
 * among many, and this needs to stop the run.
 *
 * It checks only that every migration on disk is recorded as applied. Checksum
 * drift is Prisma's job and it reports it far better than this could.
 */

const MIGRATIONS_DIR = path.resolve(process.cwd(), "prisma/migrations");

function fail(message: string): never {
  // Framed so the first line is the diagnosis and the last is the command.
  throw new Error(
    `\n\n=== The test database is not up to date ===\n\n${message}\n\n` +
      `Fix it:\n\n  npm run db:test:setup\n\n` +
      `Why this is a hard stop: a suite running against a database that is ` +
      `missing tables reports green for every test that does not read them. ` +
      `See docs/runbook.md, "The test database is a separate database, and ` +
      `migrations do not reach it".\n`,
  );
}

/** Directory names under prisma/migrations, which are the migration names. */
async function migrationsOnDisk(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function setup(): Promise<void> {
  loadEnv({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });
  loadEnv({ path: path.resolve(process.cwd(), ".env"), quiet: true });

  const url = process.env.TEST_DATABASE_URL?.trim();

  // tests/setup.ts raises the same complaint per file. Raising it here too means
  // the run stops on one clear message instead of twenty-three.
  if (url === undefined || url.length === 0) {
    fail(
      "TEST_DATABASE_URL is not set. The suite truncates every table and refuses\n" +
        "to run without a database of its own. See .env.example.",
    );
  }

  const expected = await migrationsOnDisk();
  if (expected.length === 0) {
    fail(`No migrations found in ${MIGRATIONS_DIR}. That cannot be right.`);
  }

  const client = new Client({ connectionString: url });

  try {
    await client.connect();
  } catch (error) {
    fail(
      `Could not connect to the test database.\n` +
        `  ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    // A database that has never had a migration applied has no such table, and
    // to_regclass answers that without raising.
    const present = await client.query<{ present: boolean }>(
      "SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS present",
    );

    if (present.rows[0]?.present !== true) {
      fail(
        `The test database has no _prisma_migrations table, so no migration has\n` +
          `ever been applied to it. Expected ${expected.length}:\n` +
          expected.map((m) => `  ${m}`).join("\n"),
      );
    }

    const applied = await client.query<{
      migration_name: string;
      finished: boolean;
    }>(
      `SELECT migration_name, (finished_at IS NOT NULL AND rolled_back_at IS NULL) AS finished
         FROM _prisma_migrations`,
    );

    const finished = new Set(
      applied.rows.filter((r) => r.finished).map((r) => r.migration_name),
    );
    const unfinished = applied.rows
      .filter((r) => !r.finished)
      .map((r) => r.migration_name);

    const missing = expected.filter((name) => !finished.has(name));

    if (missing.length > 0) {
      const detail = missing
        .map(
          (name) =>
            `  ${name}${unfinished.includes(name) ? "   (started but not finished, or rolled back)" : ""}`,
        )
        .join("\n");

      fail(
        `${missing.length} of ${expected.length} migrations are not applied to the test\n` +
          `database:\n\n${detail}`,
      );
    }

    // Count what was actually compared and say so. A guard that silently
    // verified nothing is the failure mode this whole file is a reaction to -
    // see the RESTORE VERIFIED note in docs/runbook.md.
    console.log(
      `[test-db] ${expected.length}/${expected.length} migrations applied; ` +
        `latest ${expected[expected.length - 1]}`,
    );
  } finally {
    await client.end();
  }
}
