import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmployee, disconnectDb, resetDb, testDb } from "./db";

/**
 * scripts/bas-migrate-to-azure: the one-shot move of the BAS tables from the
 * office PC to the Azure database.
 *
 * Two layers. The static checks read the three SQL files and hold them to the
 * table list in common.sql: the export writes every table, the import writes
 * every table in the same order, and the import writes NOTHING outside bas_*.
 * The catalog checks hold that list to the real schema: every bas_* table is
 * listed, and the order respects every foreign key - a table added by a later
 * migration fails here rather than being silently left behind.
 *
 * The end-to-end run drives the real files through the real psql against the
 * test database: export, truncate, decline the prompt (nothing written),
 * import, check, then import AGAIN and expect the refusal. It needs psql on
 * PATH and skips - visibly - without it.
 *
 * The procedure and the failure modes are in runbook.md, "Moving the BAS data
 * to the Azure database". The manual run on 2026-09-29 against a throwaway
 * cluster with a non-superuser administrator is recorded there too; this test
 * runs as whatever TEST_DATABASE_URL is, which locally is a superuser.
 */

const SCRIPTS = path.resolve(process.cwd(), "scripts/bas-migrate-to-azure");
const common = readFileSync(path.join(SCRIPTS, "common.sql"), "utf8");
const exportSql = readFileSync(path.join(SCRIPTS, "export.sql"), "utf8");
const importSql = readFileSync(path.join(SCRIPTS, "import.sql"), "utf8");
const checkSql = readFileSync(path.join(SCRIPTS, "check.sql"), "utf8");

/** The table list as common.sql declares it: ordinal, name, kind. */
function declaredTables(): Array<{ ordinal: number; name: string; kind: string }> {
  const rows: Array<{ ordinal: number; name: string; kind: string }> = [];
  const re = /\(\s*(\d+),\s*'(bas_[a-z_]+)',\s*'(data|vocabulary|credentials)'/g;
  for (const m of common.matchAll(re)) {
    rows.push({ ordinal: Number(m[1]), name: m[2]!, kind: m[3]! });
  }
  return rows.sort((a, b) => a.ordinal - b.ordinal);
}

const declared = declaredTables();
const declaredNames = declared.map((t) => t.name);

describe("common.sql declares the tables", () => {
  it("lists fourteen bas_* tables with consecutive ordinals", () => {
    expect(declared.length).toBe(14);
    expect(declared.map((t) => t.ordinal)).toEqual(
      Array.from({ length: 14 }, (_, i) => i + 1),
    );
    expect(new Set(declaredNames).size).toBe(14);
  });

  it("names exactly the bas_* base tables in the database", async () => {
    const rows = await testDb.$queryRawUnsafe<Array<{ relname: string }>>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname LIKE 'bas\\_%'
        ORDER BY 1`,
    );
    expect([...declaredNames].sort()).toEqual(rows.map((r) => r.relname));
  });

  it("orders every foreign key's parent before its child", async () => {
    const fks = await testDb.$queryRawUnsafe<
      Array<{ child: string; parent: string; conname: string }>
    >(
      `SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent, conname
         FROM pg_constraint
        WHERE contype = 'f' AND conrelid::regclass::text LIKE 'bas\\_%'
          AND confrelid::regclass::text LIKE 'bas\\_%'
          AND conrelid <> confrelid`,
    );
    expect(fks.length).toBeGreaterThan(10);
    for (const fk of fks) {
      const child = declaredNames.indexOf(fk.child);
      const parent = declaredNames.indexOf(fk.parent);
      expect(parent, `${fk.conname}: ${fk.parent} must be listed before ${fk.child}`).toBeLessThan(child);
    }
  });

  it("names every sequence behind a bas_* id column", async () => {
    const rows = await testDb.$queryRawUnsafe<Array<{ seq: string; tbl: string }>>(
      `SELECT s.relname AS seq, t.relname AS tbl
         FROM pg_class s JOIN pg_depend d ON d.objid = s.oid AND d.deptype IN ('a', 'i')
         JOIN pg_class t ON t.oid = d.refobjid
        WHERE s.relkind = 'S' AND t.relname LIKE 'bas\\_%' ORDER BY 1`,
    );
    expect(rows.length).toBe(8);
    for (const row of rows) {
      expect(common, `${row.seq} (${row.tbl}) is missing from mig_tables`).toContain(`'${row.seq}'`);
    }
  });

  it("only the credentials table leaves the bas_* family, and it is fingerprinted without updated_by", async () => {
    const rows = await testDb.$queryRawUnsafe<Array<{ child: string; parent: string }>>(
      `SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent
         FROM pg_constraint
        WHERE contype = 'f' AND conrelid::regclass::text LIKE 'bas\\_%'
          AND confrelid::regclass::text NOT LIKE 'bas\\_%'`,
    );
    expect(rows).toEqual([{ child: "bas_station_credentials", parent: "employees" }]);
    expect(common).toMatch(
      /row_expr = '\(t\.station_id, t\.username, t\.password_ciphertext, t\.key_version, t\.updated_at\)::text'\s+WHERE table_name = 'bas_station_credentials'/,
    );
  });
});

describe("export.sql and import.sql follow the list", () => {
  it("export writes every table, in order, to a file named for it", () => {
    const written: string[] = [];
    for (const m of exportSql.matchAll(/\\copy \(SELECT \* FROM (bas_[a-z_]+)\s+ORDER BY [^)]+\)\s+TO 'bas-migration-data\/(bas_[a-z_]+)\.csv'/g)) {
      expect(m[1]).toBe(m[2]);
      written.push(m[1]!);
    }
    // The credentials table is the one written from a staging query.
    expect(exportSql).toMatch(/FROM mig_credentials_export ORDER BY station_id\) TO 'bas-migration-data\/bas_station_credentials\.csv'/);
    written.push("bas_station_credentials");
    expect(written).toEqual(declaredNames);
  });

  it("import writes every table, in order, and HEADER MATCH on every COPY", () => {
    const targets: string[] = [];
    const re = /(?:\\copy public\.(bas_[a-z_]+)\s+FROM 'bas-migration-data\/(bas_[a-z_]+)\.csv'\s+WITH \(FORMAT csv, HEADER MATCH\)|INSERT INTO public\.(bas_[a-z_]+))/g;
    for (const m of importSql.matchAll(re)) {
      if (m[1] !== undefined) {
        expect(m[1]).toBe(m[2]);
        targets.push(m[1]);
      } else {
        targets.push(m[3]!);
      }
    }
    expect(targets).toEqual(declaredNames);
    // Every \copy in the import, staging tables included, checks its header.
    for (const line of importSql.split("\n").filter((l) => l.startsWith("\\copy"))) {
      expect(line).toContain("HEADER MATCH");
    }
  });

  it("import writes nothing outside bas_* and the session's own temp tables", () => {
    // No \b before the alternation: a backslash is not a word character, so
    // \b would silently exclude every \copy line.
    const writes = /(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE(?: TABLE)?|\\copy)\s+(?:public\.)?([a-z_]+)/g;
    // Statements only: the header explains the grants in prose ("UPDATE on
    // their eight sequences") and prose is not a write.
    const statements = importSql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    const targets = [...statements.matchAll(writes)].map((m) => m[2]!);
    expect(targets.length).toBeGreaterThan(14);
    for (const target of targets) {
      expect(target, `import.sql writes ${target}`).toMatch(/^(bas_|mig_)/);
    }
    // The role that does the writing is granted exactly two columns of the
    // employee table, and nothing on any other platform table.
    expect(importSql).toContain("GRANT SELECT (id, email) ON public.employees TO bas_migrate_tmp");
    const grants = [...importSql.matchAll(/GRANT [^;]*ON (?:public\.)?([a-z_]+)/g)].map((m) => m[1]!);
    for (const target of grants) {
      expect(target, `import.sql grants on ${target}`).toMatch(/^(employees$|mig_|bas_|%I$|SCHEMA$|public$)/);
    }
    expect(importSql).not.toMatch(/GRANT [^;]*ON (?:public\.)?(modules|module_grants|positions|departments|audit_events|draft_locks|_prisma_migrations)\b/);
    // And it is dropped before the commit.
    expect(importSql.indexOf("DROP ROLE bas_migrate_tmp")).toBeLessThan(importSql.indexOf("\nCOMMIT;"));
  });

  it("check.sql compares the vocabularies by row against the files, not by fingerprint", () => {
    expect(checkSql).toContain("WHERE m.kind <> 'vocabulary'");
    expect(checkSql).toContain("exported rows missing or different");
  });
});

// --- end to end, through psql -----------------------------------------------

const psql = spawnSync("psql", ["--version"], { encoding: "utf8" });
const havePsql = psql.status === 0;

const BAS_TABLES = declaredNames;

async function truncateBas(): Promise<void> {
  await testDb.$executeRawUnsafe(
    `TRUNCATE TABLE ${BAS_TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
}

function runPsql(args: string[], cwd: string, input?: string) {
  return spawnSync("psql", [process.env.DATABASE_URL ?? "", "-X", ...args], {
    cwd,
    encoding: "utf8",
    input,
    env: { ...process.env, PGCLIENTENCODING: "UTF8" },
  });
}

describe.skipIf(!havePsql)("the migration, end to end through psql", () => {
  let work = "";
  let employeeId = "";

  beforeAll(async () => {
    await resetDb();
    await truncateBas();
    work = mkdtempSync(path.join(os.tmpdir(), "bas-migration-test-"));
    mkdirSync(path.join(work, "bas-migration-data"));

    const employee = await createEmployee({ email: "migration-fixture@phb1899.com" });
    employeeId = employee.id;

    // Explicit ids, well past 1, so "the sequence is past the highest id" is a
    // real claim after a TRUNCATE ... RESTART IDENTITY. Values chosen to give
    // CSV something to get wrong: a comma, a quote, a newline, a NULL, a
    // double with many digits, jsonb, a timestamp with milliseconds.
    await testDb.$executeRawUnsafe(`
      INSERT INTO bas_orgs (org_id, name) VALUES (7, 'ZZ Test Org');
      INSERT INTO bas_projects (project_id, org_id, name) VALUES (3, 7, 'ZZ Project');
      INSERT INTO bas_sites (site_id, org_id, project_id, name, timezone, attributes)
        VALUES (9, 7, 3, 'ZZ Site, "quoted"', 'America/New_York', '{"a": 1, "b": "two"}');
      INSERT INTO bas_equipment_types (equip_type, display_name, description, category)
        VALUES ('zztest_ahu', 'ZZ AHU', 'line one' || E'\\n' || 'line two', 'air');
      INSERT INTO bas_point_roles (point_role, display_name, description, is_setpoint, setpoint_for)
        VALUES ('zztest_temp', 'ZZ Temp', 'a temperature', false, NULL),
               ('zztest_temp_sp', 'ZZ Temp SP', 'its setpoint', true, 'zztest_temp');
      INSERT INTO bas_stations (station_id, site_id, niagara_station_name, connection_mode)
        VALUES (4, 9, 'ZZStation', 'direct');
      INSERT INTO bas_equipment (equipment_id, site_id, name, equip_type) VALUES (6, 9, 'ZZ AHU-1', 'zztest_ahu');
      INSERT INTO bas_points (point_id, station_id, equipment_id, niagara_history_name, point_role, data_type, capacity, collection_interval_s, tags)
        VALUES (101, 4, 6, 'ZZ/Temp', 'zztest_temp', 'real', 500, 300, '{"k": "v"}'),
               (102, 4, NULL, 'ZZ/TempSp', 'zztest_temp_sp', 'real', NULL, NULL, '{}');
      INSERT INTO bas_readings (point_id, ts, value_num, value_bool, value_str, status)
        VALUES (101, '2026-01-01T00:00:00.123Z', 72.123456789012345, NULL, NULL, NULL),
               (101, '2026-01-01T00:05:00.123Z', NULL, NULL, NULL, 'stale'),
               (102, '2026-01-01T00:00:00Z', NULL, NULL, 'a,b "c"', NULL);
      INSERT INTO bas_sync_checkpoints (point_id, last_status, completeness) VALUES (101, 'ok', 'complete');
      INSERT INTO bas_data_gaps (gap_id, point_id, gap_start, gap_end, cause)
        VALUES (12, 101, '2026-01-02T00:00:00Z', '2026-01-02T01:00:00Z', 'collector_down');
      INSERT INTO bas_ingest_runs (run_id, station_id, status, errors) VALUES (55, 4, 'ok', '[{"e": 1}]');
      INSERT INTO bas_station_credentials (station_id, username, password_ciphertext, key_version, updated_by)
        VALUES (4, 'bas_collector', 'not-real-ciphertext', 1, '${employeeId}');
    `);
  });

  afterAll(async () => {
    await truncateBas();
    await resetDb();
    await disconnectDb();
    if (work.length > 0) rmSync(work, { recursive: true, force: true });
  });

  it("exports, refuses without YES, imports, checks, and refuses a second run", async () => {
    // 1. Export from the fixture.
    const exported = runPsql(["-f", path.join(SCRIPTS, "export.sql")], work);
    expect(exported.status, exported.stderr + exported.stdout).toBe(0);
    expect(exported.stderr).toContain("gate: 14 bas_* table(s) present, all 14 listed");
    expect(readFileSync(path.join(work, "bas-migration-data/bas_readings.csv"), "utf8").split("\n").length).toBe(5);

    // 2. The target: the same database, emptied. Sequences back to 1, which is
    //    the collision the sequence step exists to prevent.
    await truncateBas();

    // 3. Anything but YES rolls back.
    const declined = runPsql(["-f", path.join(SCRIPTS, "import.sql")], work, "no\n");
    expect(declined.stdout).toContain("Not confirmed. Rolling back - nothing was written.");
    expect(await testDb.basOrg.count()).toBe(0);

    // 4. YES.
    const imported = runPsql(["-v", "confirm=YES", "-f", path.join(SCRIPTS, "import.sql")], work);
    expect(imported.status, imported.stderr + imported.stdout).toBe(0);
    expect(imported.stdout).toContain("Committed.");
    expect(imported.stderr).toContain("every table outside bas_* is unchanged");

    // 5. What landed.
    expect(await testDb.basReading.count()).toBe(3);
    expect(await testDb.basPoint.count()).toBe(2);
    expect(await testDb.basPointRole.count()).toBe(2);
    const credential = await testDb.basStationCredential.findUniqueOrThrow({ where: { stationId: 4n } });
    expect(credential.updatedById).toBe(employeeId);
    const readings = await testDb.$queryRawUnsafe<Array<{ value_num: number | null; value_str: string | null; status: string | null }>>(
      `SELECT value_num, value_str, status FROM bas_readings ORDER BY point_id, ts`,
    );
    expect(readings).toEqual([
      { value_num: 72.123456789012345, value_str: null, status: null },
      { value_num: null, value_str: null, status: "stale" },
      { value_num: null, value_str: 'a,b "c"', status: null },
    ]);

    // 6. The sequences are past the copied ids, and a plain insert proves it.
    const seq = await testDb.$queryRawUnsafe<Array<{ v: bigint | null }>>(
      `SELECT pg_sequence_last_value('bas_points_point_id_seq') AS v`,
    );
    expect(seq[0]?.v).toBe(102n);
    const next = await testDb.$queryRawUnsafe<Array<{ point_id: bigint }>>(
      `INSERT INTO bas_points (station_id, niagara_history_name) VALUES (4, 'ZZ/After') RETURNING point_id`,
    );
    expect(next[0]?.point_id).toBe(103n);
    await testDb.$executeRawUnsafe(
      `INSERT INTO bas_readings (point_id, ts, value_num) VALUES (103, now(), 1)`,
    );
    await testDb.$executeRawUnsafe(`DELETE FROM bas_points WHERE point_id = 103`);

    // 7. check.sql on its own, after the commit.
    const checked = runPsql(["-f", path.join(SCRIPTS, "check.sql")], work);
    expect(checked.status, checked.stderr + checked.stdout).toBe(0);
    expect(checked.stderr).toMatch(/all \d+ checks passed/);
    expect(checked.stdout).not.toContain("FAIL");

    // 8. A second run stops before writing, and leaves no role behind.
    const again = runPsql(["-v", "confirm=YES", "-f", path.join(SCRIPTS, "import.sql")], work);
    expect(again.status).not.toBe(0);
    expect(again.stderr).toContain("the target already holds BAS data");
    expect(again.stderr).toContain("Nothing has been written");
    expect(await testDb.basReading.count()).toBe(3);
    const role = await testDb.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM pg_roles WHERE rolname = 'bas_migrate_tmp'`,
    );
    expect(role[0]?.n).toBe(0n);
  });
});

// --- the collector role ------------------------------------------------------
//
// bas_collector is a CLUSTER-wide role, and on a developer's machine it is the
// one the live collector connects as; running the script here would rotate that
// password. So this runs only where the role does not exist yet - a fresh
// cluster, which is what CI has - and skips otherwise. The manual proof on a
// throwaway cluster is in runbook.md.

describe.skipIf(!havePsql)("setup-bas-collector-role.sql", () => {
  it("creates a role that writes bas_* and is refused everywhere else (fresh cluster only)", async () => {
    const exists = await testDb.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM pg_roles WHERE rolname = 'bas_collector'`,
    );
    if (exists[0]?.n !== 0n) {
      console.warn("bas_collector already exists on this cluster; not rotating its password. Skipped.");
      return;
    }
    const script = path.resolve(process.cwd(), "scripts/setup-bas-collector-role.sql");
    const created = runPsql(["-v", "pw=test-only-collector-password", "-f", script], process.cwd());
    expect(created.status, created.stderr + created.stdout).toBe(0);
    expect(created.stderr).toContain("refused everywhere else. OK.");
    // The password must not be echoed.
    expect(created.stdout).not.toContain("test-only-collector-password");
    expect(created.stderr).not.toContain("test-only-collector-password");

    const url = new URL(process.env.DATABASE_URL ?? "");
    url.username = "bas_collector";
    url.password = "test-only-collector-password";
    const asCollector = (sql: string) =>
      spawnSync("psql", [url.toString(), "-X", "-At", "-c", sql], { encoding: "utf8" });
    expect(asCollector("SELECT count(*) FROM bas_points").status).toBe(0);
    expect(asCollector("SELECT count(*) FROM employees").stderr).toContain("permission denied");
    expect(asCollector("CREATE TABLE zz_no (x int)").stderr).toContain("permission denied");
    expect(asCollector("UPDATE bas_station_credentials SET username = 'x'").stderr).toContain("permission denied");

    await testDb.$executeRawUnsafe(`DROP OWNED BY bas_collector; DROP ROLE bas_collector`);
  });
});
