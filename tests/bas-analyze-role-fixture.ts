import { Client, Pool } from "pg";
import {
  analyzeRoleGateSql,
  analyzeRoleGrantStatements,
} from "@/lib/modules/bas/analyze/role";

/**
 * A throwaway `bas_analyze_test` role on the TEST database, built from the
 * exact statements the real one is built from.
 *
 * Roles are cluster-wide, so the name is distinct from the real `bas_analyze`
 * that may exist on the same PostgreSQL server for the development database.
 * It is dropped at the end of every file that uses it, and dropped at the
 * start in case a previous run died with it in place.
 *
 * Needs a superuser or CREATEROLE on TEST_DATABASE_URL, which the local
 * `postgres` user and the CI service container both are.
 */

export const TEST_ROLE = "bas_analyze_test";
const TEST_PASSWORD = "bas_analyze_test_only_never_reused";

/** tests/setup.ts has already redirected DATABASE_URL to the test database. */
function adminUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.length === 0) throw new Error("DATABASE_URL unset");
  return url;
}

export function testRoleUrl(): string {
  const url = new URL(adminUrl());
  url.username = TEST_ROLE;
  url.password = TEST_PASSWORD;
  url.search = "";
  return url.toString();
}

export async function createTestRole(): Promise<void> {
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await dropWith(admin);
    await admin.query(analyzeRoleGateSql());
    const built = await admin.query<{ stmt: string }>(
      `SELECT format('CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L', $1::text, $2::text) AS stmt`,
      [TEST_ROLE, TEST_PASSWORD],
    );
    await admin.query(built.rows[0]!.stmt);
    for (const statement of analyzeRoleGrantStatements(TEST_ROLE)) {
      await admin.query(statement);
    }
  } finally {
    await admin.end();
  }
}

export async function dropTestRole(): Promise<void> {
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await dropWith(admin);
  } finally {
    await admin.end();
  }
}

async function dropWith(admin: Client): Promise<void> {
  const exists = await admin.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM pg_roles WHERE rolname = $1",
    [TEST_ROLE],
  );
  if (exists.rows[0]?.n === "0") return;
  // Grants are "owned" privileges in this database; DROP ROLE refuses while
  // any remain. Sessions from an earlier failed run are ended first.
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()`,
    [TEST_ROLE],
  );
  await admin.query(`DROP OWNED BY "${TEST_ROLE}"`);
  await admin.query(`DROP ROLE "${TEST_ROLE}"`);
}

/**
 * A pool AS the test role. `readOnly: false` turns the role default off so
 * that the GRANTS are what refuse a write - runbook.md, *Two independent
 * layers stop writes, and only one of them holds*.
 */
export function testRolePool(readOnly = true): Pool {
  return new Pool({
    connectionString: testRoleUrl(),
    max: 2,
    options: `-c timezone=UTC -c default_transaction_read_only=${readOnly ? "on" : "off"}`,
  });
}
