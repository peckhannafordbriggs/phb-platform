import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ANALYZE_ALLOWLIST,
  ANALYZE_WITHHELD,
  PLATFORM_TABLES,
  ROLE_STATEMENT_TIMEOUT,
} from "@/lib/modules/bas/analyze/role";
import { testDb } from "./db";

/**
 * scripts/setup-bas-analyze-role.sql is the psql form of the bas_analyze
 * role, for the Azure database reached from a Cloud Shell. Its lists are a
 * COPY of lib/modules/bas/analyze/role.ts, so this file holds the two to each
 * other: an object added to one and not the other fails the build, which is
 * cheaper than a "permission denied" answer in production.
 *
 * Then the real file is run through the real psql against the test database,
 * under a throwaway role name (roles are cluster-wide, and the development
 * database's real bas_analyze may share the server), and the boundary is read
 * back from the catalog. Skips where psql is not installed, as the migration
 * script test does.
 */

const SQL_PATH = path.join(process.cwd(), "scripts/setup-bas-analyze-role.sql");
const THROWAWAY = "zz_analyze_sql_test";

/** The quoted names inside one `INSERT INTO <table> ... VALUES` block, comments stripped. */
function namesIn(sql: string, table: string): string[] {
  const start = sql.indexOf(`INSERT INTO ${table} `);
  expect(start, `INSERT INTO ${table}`).toBeGreaterThan(-1);
  const end = sql.indexOf(";", start);
  const block = sql.slice(start, end).replace(/--.*$/gm, "");
  return [...block.matchAll(/\('([a-z_]+)'/g)].map((m) => m[1]!);
}

describe("the psql script copies role.ts exactly", () => {
  let sql = "";
  beforeAll(async () => {
    sql = await readFile(SQL_PATH, "utf8");
  });

  it("allows the same objects, withholds the same, revokes the same platform tables", () => {
    expect([...namesIn(sql, "analyze_ro")].sort()).toEqual([...ANALYZE_ALLOWLIST].sort());
    expect([...namesIn(sql, "analyze_hold")].sort()).toEqual(
      ANALYZE_WITHHELD.map((w) => w.name).sort(),
    );
    expect([...namesIn(sql, "analyze_platform")].sort()).toEqual([...PLATFORM_TABLES].sort());
  });

  it("carries the same role defaults and grants nothing by pattern", () => {
    expect(sql).toContain(`statement_timeout = %L', role, '${ROLE_STATEMENT_TIMEOUT}'`);
    expect(sql).toContain("default_transaction_read_only = on");
    // Never a pattern grant, never a write grant, never a default-privilege rule.
    expect(sql).not.toMatch(/GRANT\s+(ALL|SELECT)\s+ON\s+ALL\s+TABLES/i);
    expect(sql).not.toMatch(/GRANT\s+[^\n]*\b(INSERT|UPDATE|DELETE)\b/i);
    expect(sql).not.toMatch(/ALTER DEFAULT PRIVILEGES/i);
    // The password is a psql variable, quoted as a literal; never a value in the file.
    expect(sql).toContain(":'pw'");
    expect(sql).not.toMatch(/PASSWORD\s+'[^']+'/);
    expect(sql).toContain("\\set ON_ERROR_STOP on");
  });

  it("tells the operator how to run it in production, from a Cloud Shell too", () => {
    expect(sql).toContain("read -s -p");
    expect(sql).toContain("-f scripts/setup-bas-analyze-role.sql");
    expect(sql).toContain("sslmode=require");
    expect(sql).toContain("Cloud Shell");
    expect(sql).toContain("firewall-rule create");
    expect(sql).toContain("BAS-ASK-DATABASE-URL");
  });
});

// --- end to end, through psql -----------------------------------------------

const psql = spawnSync("psql", ["--version"], { encoding: "utf8" });
const havePsql = psql.status === 0;

/** tests/setup.ts has redirected DATABASE_URL to the test database. */
function adminUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.length === 0) throw new Error("DATABASE_URL unset");
  return url;
}

async function dropThrowaway(): Promise<void> {
  await testDb.$executeRawUnsafe(
    `DO $d$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${THROWAWAY}') THEN
       EXECUTE 'DROP OWNED BY ${THROWAWAY}'; EXECUTE 'DROP ROLE ${THROWAWAY}'; END IF; END $d$;`,
  );
}

describe.skipIf(!havePsql)("the script builds the role through the real psql", () => {
  beforeAll(dropThrowaway);
  afterAll(async () => {
    await dropThrowaway();
    await testDb.$disconnect();
  });

  it("creates the role, passes its own proof, and leaves exactly the boundary role.ts describes", async () => {
    const run = spawnSync(
      "psql",
      [adminUrl(), "-X", "-v", `role=${THROWAWAY}`, "-v", "pw=throwaway-password-never-reused", "-f", SQL_PATH],
      { encoding: "utf8" },
    );
    expect(run.status, run.stderr + run.stdout).toBe(0);
    expect(run.stderr).toContain("Gate passed");
    expect(run.stderr).toContain(`${THROWAWAY}: reads the allowlist, refused everywhere else. OK.`);
    // The password is printed nowhere.
    expect(run.stdout + run.stderr).not.toContain("throwaway-password-never-reused");

    const priv = async (relation: string, privilege: string) =>
      (
        await testDb.$queryRawUnsafe<Array<{ ok: boolean }>>(
          `SELECT has_table_privilege($1, $2, $3) AS ok`,
          THROWAWAY,
          `public.${relation}`,
          privilege,
        )
      )[0]!.ok;

    for (const name of ANALYZE_ALLOWLIST) {
      expect(await priv(name, "SELECT"), `SELECT ${name}`).toBe(true);
      expect(await priv(name, "INSERT"), `INSERT ${name}`).toBe(false);
    }
    for (const { name } of ANALYZE_WITHHELD) {
      expect(await priv(name, "SELECT"), `SELECT ${name}`).toBe(false);
    }
    for (const name of PLATFORM_TABLES) {
      expect(await priv(name, "SELECT"), `SELECT ${name}`).toBe(false);
    }
    const [role] = await testDb.$queryRawUnsafe<
      Array<{ rolconfig: string[] | null; rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolinherit: boolean }>
    >(`SELECT rolconfig, rolsuper, rolcreatedb, rolcreaterole, rolinherit FROM pg_roles WHERE rolname = $1`, THROWAWAY);
    expect(role!.rolconfig).toEqual(
      expect.arrayContaining([`statement_timeout=${ROLE_STATEMENT_TIMEOUT}`, "default_transaction_read_only=on"]),
    );
    expect([role!.rolsuper, role!.rolcreatedb, role!.rolcreaterole, role!.rolinherit]).toEqual([false, false, false, false]);
  });

  it("re-runs cleanly: a second run rotates the password and changes nothing else", async () => {
    const again = spawnSync(
      "psql",
      [adminUrl(), "-X", "-v", `role=${THROWAWAY}`, "-v", "pw=second-throwaway-password", "-f", SQL_PATH],
      { encoding: "utf8" },
    );
    expect(again.status, again.stderr + again.stdout).toBe(0);
    expect(again.stderr).toContain("refused everywhere else. OK.");
  });
});
