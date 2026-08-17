import { execSync } from "node:child_process";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { createDbClient } from "./db";

/**
 * Creates the test database and brings it up to the current schema.
 *
 * Run once on a clean clone, and again after any migration:
 *
 *   npm run db:test:setup
 *
 * Idempotent. Creates the database only if it is missing, then applies every
 * migration. It deliberately does NOT seed: tests/setup.ts truncates every table
 * between test files, so seeded rows would be gone before the first assertion.
 * Each test builds the fixtures it needs.
 */

loadEnv({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });
loadEnv({ path: path.resolve(process.cwd(), ".env"), quiet: true });

/** The database every PostgreSQL server has, used only to issue CREATE DATABASE. */
const MAINTENANCE_DATABASE = "postgres";

interface Target {
  url: string;
  database: string;
  server: string;
}

function parseTarget(raw: string, variable: string): Target {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${variable} is not a valid connection URL.`);
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (database.length === 0) {
    throw new Error(`${variable} does not name a database: ${url.host}/`);
  }

  return { url: raw, database, server: url.host };
}

function maintenanceUrl(target: string): string {
  const url = new URL(target);
  url.pathname = `/${MAINTENANCE_DATABASE}`;
  // The test database may not exist yet, so no schema parameter is carried over.
  url.search = "";
  return url.toString();
}

async function main(): Promise<void> {
  const rawTest = process.env.TEST_DATABASE_URL?.trim();
  const rawDev = process.env.DATABASE_URL?.trim();

  if (rawTest === undefined || rawTest.length === 0) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Copy .env.example to .env.local and fill it " +
        "in. The test suite truncates every table, so it needs a database of its own.",
    );
  }

  const test = parseTarget(rawTest, "TEST_DATABASE_URL");

  // The same guard tests/setup.ts applies at run time, applied here at setup
  // time. Compared on server and database name rather than on the raw string, so
  // a trailing slash or a different parameter order cannot slip past it.
  if (rawDev !== undefined && rawDev.length > 0) {
    const dev = parseTarget(rawDev, "DATABASE_URL");
    if (dev.server === test.server && dev.database === test.database) {
      throw new Error(
        `TEST_DATABASE_URL and DATABASE_URL both point at ${test.server}/${test.database}. ` +
          "Running the tests would destroy your development data. Give the test " +
          "database a different name.",
      );
    }
  }

  console.log(`Test database: ${test.server}/${test.database}`);

  const admin = createDbClient(maintenanceUrl(rawTest));
  let created = false;
  try {
    const existing = await admin.$queryRaw<
      Array<{ datname: string }>
    >`SELECT datname FROM pg_database WHERE datname = ${test.database}`;

    if (existing.length === 0) {
      // CREATE DATABASE cannot run inside a transaction, hence raw execution
      // rather than anything Prisma wraps. The name comes from a URL the
      // developer controls, and is quoted.
      await admin.$executeRawUnsafe(
        `CREATE DATABASE "${test.database.replace(/"/g, '""')}"`,
      );
      created = true;
      console.log("  created");
    } else {
      console.log("  already exists");
    }
  } finally {
    await admin.$disconnect();
  }

  console.log("Applying migrations...");
  // DATABASE_URL is what prisma.config.ts reads. dotenv does not overwrite a
  // variable that is already set, so this override survives .env.local being
  // loaded again in the child process.
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: rawTest },
  });

  console.log(
    created
      ? "Test database created and migrated. Run `npm test`."
      : "Test database migrated. Run `npm test`.",
  );
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
