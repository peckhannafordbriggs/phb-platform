import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  ANALYZE_ALLOWLIST,
  ANALYZE_WITHHELD,
  PLATFORM_TABLES,
  analyzeRoleProofs,
} from "@/lib/modules/bas/analyze/role";
import {
  QueryFailure,
  runGuardedSelect,
} from "@/lib/modules/bas/analyze/pool";
import { testDb } from "./db";
import {
  createTestRole,
  dropTestRole,
  testRolePool,
} from "./bas-analyze-role-fixture";

/**
 * The boundary, proved against a real database rather than described.
 *
 * docs/BAS-B5.md: "verified by testing the refusals rather than the grants".
 * A grant that lets the right thing through proves nothing on its own, so
 * every write below is attempted with the role's read-only DEFAULT TURNED
 * OFF - the layer a client controls - so that the grant is the layer being
 * tested. Then the READ ONLY transaction and the cursor are tested on their
 * own, with the guard bypassed on purpose, because each barrier has to hold
 * without the others.
 */

let ro: Pool;
let rw: Pool;

beforeAll(async () => {
  await createTestRole();
  ro = testRolePool(true);
  rw = testRolePool(false);
});

afterAll(async () => {
  await ro.end().catch(() => undefined);
  await rw.end().catch(() => undefined);
  await dropTestRole();
  await testDb.$disconnect();
});

async function refusedBy(pool: Pool, sql: string): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query(sql);
    throw new Error(`expected refusal for: ${sql}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("expected refusal")) throw error;
    return (error as { code?: string }).code ?? "";
  } finally {
    client.release();
  }
}

describe("the allowlist and nothing else", () => {
  it("reads every allowlisted object", async () => {
    for (const name of ANALYZE_ALLOWLIST) {
      const client = await ro.connect();
      try {
        await expect(client.query(`SELECT * FROM public."${name}" LIMIT 1`)).resolves.toBeDefined();
      } finally {
        client.release();
      }
    }
  });

  it("is refused the credentials table, by grant", async () => {
    // 42501 insufficient_privilege. Not a read-only error: the GRANT is what
    // says no, with read-only off.
    for (const { name } of ANALYZE_WITHHELD) {
      expect(await refusedBy(rw, `SELECT count(*) FROM public."${name}"`)).toBe("42501");
    }
  });

  it("is refused employees, audit_events and every platform table", async () => {
    for (const name of PLATFORM_TABLES) {
      expect(await refusedBy(rw, `SELECT count(*) FROM public."${name}"`)).toBe("42501");
    }
  });

  it("cannot write, even with read-only turned off", async () => {
    const before = await testDb.basOrg.count();

    expect(await refusedBy(rw, "INSERT INTO bas_orgs (name) VALUES ('bas_analyze_test_write')")).toBe("42501");
    expect(await refusedBy(rw, "UPDATE bas_points SET is_active = false")).toBe("42501");
    expect(await refusedBy(rw, "DELETE FROM bas_data_gaps")).toBe("42501");
    expect(await refusedBy(rw, "TRUNCATE bas_readings")).toBe("42501");
    expect(await refusedBy(rw, "CREATE TABLE bas_analyze_test_t (x int)")).toBe("42501");
    expect(await refusedBy(rw, "SELECT nextval('bas_orgs_org_id_seq')")).toBe("42501");

    expect(await testDb.basOrg.count()).toBe(before);
  });

  it("can create a temp table with read-only off - and the READ ONLY transaction refuses it", async () => {
    // TEMP is a PUBLIC grant on the database and is deliberately not revoked
    // (role.ts says why). This test pins BOTH halves so the decision stays
    // visible: the grant layer lets it through, the transaction layer does
    // not, and that is the layer every Analyze query runs inside.
    const loose = await rw.connect();
    try {
      await expect(loose.query("CREATE TEMP TABLE bas_analyze_test_tmp (x int)")).resolves.toBeDefined();
      await loose.query("DROP TABLE bas_analyze_test_tmp");
    } finally {
      loose.release();
    }

    const strict = await rw.connect();
    try {
      await strict.query("BEGIN READ ONLY");
      let code = "";
      try {
        await strict.query("CREATE TEMP TABLE bas_analyze_test_tmp2 (x int)");
      } catch (error) {
        code = (error as { code?: string }).code ?? "";
      }
      // 25006 read_only_sql_transaction.
      expect(code).toBe("25006");
      await strict.query("ROLLBACK");
    } finally {
      strict.release();
    }
  });

  it("passes every proof the setup script runs", async () => {
    for (const proof of analyzeRoleProofs()) {
      const client = await rw.connect();
      let succeeded: boolean;
      try {
        await client.query(proof.sql);
        succeeded = true;
      } catch {
        succeeded = false;
      } finally {
        client.release();
      }
      expect(succeeded, `${proof.sql} - ${proof.why}`).toBe(proof.mustSucceed);
    }
  });

  it("carries the role-level defaults", async () => {
    const client = await ro.connect();
    try {
      // SHOW names its one column after the setting.
      const timeout = await client.query<Record<string, string>>("SHOW statement_timeout");
      const readOnly = await client.query<Record<string, string>>("SHOW default_transaction_read_only");
      expect(Object.values(timeout.rows[0]!)[0]).toBe("30s");
      expect(Object.values(readOnly.rows[0]!)[0]).toBe("on");
    } finally {
      client.release();
    }
  });
});

describe("runGuardedSelect holds without the guard", () => {
  // Every call here bypasses sql-guard.ts on purpose.

  it("enforces the statement timeout", async () => {
    const started = Date.now();
    await expect(
      runGuardedSelect(rw, "SELECT pg_sleep(5)", { statementTimeoutMs: 300, rowCap: 10 }),
    ).rejects.toMatchObject({ name: "QueryFailure", timedOut: true, code: "57014" });
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("enforces the row cap and reports truncation", async () => {
    const result = await runGuardedSelect(rw, "SELECT generate_series(1, 1000) AS n", {
      statementTimeoutMs: 5_000,
      rowCap: 200,
    });
    expect(result.rowCount).toBe(200);
    expect(result.rows.length).toBe(200);
    expect(result.truncated).toBe(true);
    expect(result.rowCap).toBe(200);
    expect(result.columns).toEqual(["n"]);
  });

  it("does not report truncation at exactly the cap", async () => {
    const result = await runGuardedSelect(rw, "SELECT generate_series(1, 200) AS n", {
      statementTimeoutMs: 5_000,
      rowCap: 200,
    });
    expect(result.rowCount).toBe(200);
    expect(result.truncated).toBe(false);
  });

  it("refuses two statements at the protocol level", async () => {
    // The extended protocol rejects a string holding two commands; the cursor
    // would reject it too. Either way it never runs.
    await expect(
      runGuardedSelect(rw, "SELECT 1; SELECT 2", { statementTimeoutMs: 5_000, rowCap: 10 }),
    ).rejects.toBeInstanceOf(QueryFailure);
  });

  it("refuses a write as a cursor body, and a writing CTE inside READ ONLY", async () => {
    const before = await testDb.basOrg.count();

    // DECLARE CURSOR FOR INSERT is a syntax error before any privilege check.
    await expect(
      runGuardedSelect(rw, "INSERT INTO bas_orgs (name) VALUES ('x')", {
        statementTimeoutMs: 5_000,
        rowCap: 10,
      }),
    ).rejects.toBeInstanceOf(QueryFailure);

    // A CTE that writes is refused by one of THREE layers, and which one
    // answers first is PostgreSQL's business: the cursor itself (0A000,
    // "DECLARE CURSOR must not contain data-modifying statements in WITH" -
    // measured, this is the one that fires), the READ ONLY transaction
    // (25006), or the grant (42501). What matters is that it is refused and
    // nothing changed.
    let code = "";
    try {
      await runGuardedSelect(
        rw,
        "WITH d AS (DELETE FROM bas_orgs RETURNING 1) SELECT count(*) FROM d",
        { statementTimeoutMs: 5_000, rowCap: 10 },
      );
    } catch (error) {
      code = (error as QueryFailure).code ?? "";
    }
    expect(["0A000", "25006", "42501"]).toContain(code);

    expect(await testDb.basOrg.count()).toBe(before);
  });

  it("returns a permission error for a platform table as QueryFailure 42501", async () => {
    await expect(
      runGuardedSelect(rw, "SELECT count(*) FROM employees", { statementTimeoutMs: 5_000, rowCap: 10 }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("flattens cells: bigint and numeric stay strings, dates become ISO UTC", async () => {
    const result = await runGuardedSelect(
      rw,
      "SELECT 9007199254740993::bigint AS big, 1.10::numeric AS n, '2026-09-21T12:00:00Z'::timestamptz AS ts, NULL::text AS nothing, true AS b",
      { statementTimeoutMs: 5_000, rowCap: 10 },
    );
    expect(result.rows[0]).toEqual([
      "9007199254740993",
      "1.10",
      "2026-09-21T12:00:00.000Z",
      null,
      true,
    ]);
  });
});
