import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { basObjectsFromMigrations, readMigrations, scriptList, type Created } from "./bas-migration-objects";

/**
 * Every bas_* table or view a migration creates must be CLASSIFIED in
 * scripts/setup-bas-analyze-role.sql: granted to bas_analyze (analyze_ro) or
 * withheld from it by name (analyze_hold). Source text only - no database, no
 * psql - so it runs everywhere CI runs and fails on the commit that adds the
 * migration, not on the first production question.
 *
 * Why it exists (2026-11-17): Reports Phase 1 added bas_site_occupancy, the
 * Analyze schema context counts every table the role is allowed, and a role
 * that predates a grant fails EVERY question with "permission denied for table
 * bas_site_occupancy". This test makes the script's half impossible to forget.
 * It cannot see the other half - the script re-run against production - which
 * is a person's step: runbook.md -> *Analyze answers "permission denied" for
 * every question* -> *Re-run after a migration*.
 *
 * tests/bas-analyze-role-sql.test.ts holds the script's lists to role.ts and
 * runs the script through psql; this one holds the lists to the migrations.
 */

const SCRIPT = path.join(process.cwd(), "scripts/setup-bas-analyze-role.sql");

/** Report tables are platform configuration and documents, never building data. */
const REPORT_TABLE = /^bas_(report|library|personal)_/;

// The migration replay and the script-list reader live in
// tests/bas-migration-objects.ts, shared with the collector role's guard.

interface GuardResult {
  unclassified: Created[];
  reportTablesGranted: string[];
  reportTablesNotWithheld: Created[];
  grantedButNeverCreated: string[];
}

function checkAnalyzeGrants(objects: Map<string, Created>, granted: string[], withheld: string[]): GuardResult {
  const ro = new Set(granted);
  const hold = new Set(withheld);
  const all = [...objects.values()];
  return {
    unclassified: all.filter((o) => !ro.has(o.name) && !hold.has(o.name)),
    reportTablesGranted: granted.filter((n) => REPORT_TABLE.test(n)),
    reportTablesNotWithheld: all.filter((o) => REPORT_TABLE.test(o.name) && !hold.has(o.name)),
    grantedButNeverCreated: granted.filter((n) => !objects.has(n)),
  };
}

function explain(r: GuardResult): string {
  const lines: string[] = [];
  for (const o of r.unclassified) {
    lines.push(
      `${o.name} (${o.kind}, created in prisma/migrations/${o.migration}) is in neither analyze_ro nor analyze_hold. ` +
        `Classify it in lib/modules/bas/analyze/role.ts and scripts/setup-bas-analyze-role.sql, ` +
        `then re-run the script on production (runbook.md -> Re-run after a migration).`,
    );
  }
  for (const n of r.reportTablesGranted) lines.push(`${n} is a report table and must never be granted to bas_analyze.`);
  for (const o of r.reportTablesNotWithheld) lines.push(`${o.name} is a report table and must be listed in analyze_hold.`);
  for (const n of r.grantedButNeverCreated)
    lines.push(`${n} is in analyze_ro but no migration creates it; the script's gate refuses to run on a database without it.`);
  return lines.join("\n");
}

describe("every bas_* object a migration creates is classified for bas_analyze", () => {
  const objects = basObjectsFromMigrations(readMigrations());
  const script = readFileSync(SCRIPT, "utf8");
  const granted = scriptList(script, "analyze_ro");
  const withheld = scriptList(script, "analyze_hold");

  it("reads the migrations and the script, not nothing", () => {
    // A parser that matched nothing would pass every check below vacuously.
    expect(objects.size).toBeGreaterThanOrEqual(29);
    for (const name of ["bas_readings", "bas_site_occupancy", "bas_station_credentials", "bas_report_runs", "bas_v_data_dictionary"]) {
      expect(objects.has(name), name).toBe(true);
    }
    expect(granted).toContain("bas_site_occupancy");
    expect(withheld).toContain("bas_station_credentials");
  });

  it("finds every one in the grant list or the withheld list, and nothing granted that no migration creates", () => {
    const result = checkAnalyzeGrants(objects, granted, withheld);
    expect(explain(result)).toBe("");
  });

  it("withholds every report table by name and grants none of them", () => {
    const reportTables = [...objects.keys()].filter((n) => REPORT_TABLE.test(n));
    expect(reportTables.length).toBeGreaterThanOrEqual(8);
    for (const n of reportTables) {
      expect(withheld, n).toContain(n);
      expect(granted, n).not.toContain(n);
    }
  });

  it("tells the operator the az firewall-rule flags az accepts (-s server, -n rule)", () => {
    expect(script).not.toContain("--rule-name");
    expect(script).toMatch(/firewall-rule create[^\n]*-s <server> -n /);
  });
});

describe("the guard itself", () => {
  const base = [
    { name: "20260101000000_init", sql: 'CREATE TABLE "bas_orgs" (id int);\nCREATE VIEW bas_v_point AS SELECT 1;' },
  ];

  it("fails on a new bas_* table the script does not mention, naming the migration", () => {
    const objects = basObjectsFromMigrations([
      ...base,
      { name: "20261201000000_add_bas_alarms", sql: 'CREATE TABLE "public"."bas_alarms" (id int);' },
    ]);
    const r = checkAnalyzeGrants(objects, ["bas_orgs", "bas_v_point"], []);
    expect(r.unclassified.map((o) => [o.name, o.migration])).toEqual([["bas_alarms", "20261201000000_add_bas_alarms"]]);
  });

  it("fails on a report table that is granted, or merely not withheld", () => {
    const objects = basObjectsFromMigrations([
      ...base,
      { name: "20261201000000_reports", sql: "CREATE TABLE IF NOT EXISTS bas_report_deliveries (id int);" },
    ]);
    expect(checkAnalyzeGrants(objects, ["bas_orgs", "bas_v_point", "bas_report_deliveries"], []).reportTablesGranted).toEqual([
      "bas_report_deliveries",
    ]);
    expect(checkAnalyzeGrants(objects, ["bas_orgs", "bas_v_point"], []).reportTablesNotWithheld.map((o) => o.name)).toEqual([
      "bas_report_deliveries",
    ]);
  });

  it("ignores commented-out SQL, follows a drop and a rename", () => {
    const objects = basObjectsFromMigrations([
      ...base,
      {
        name: "20261201000000_churn",
        sql: '-- CREATE TABLE "bas_ghost" (id int);\nCREATE TABLE "bas_tmp" (id int);\nDROP TABLE "bas_tmp";\nALTER TABLE "bas_orgs" RENAME TO "bas_organisations";',
      },
    ]);
    expect([...objects.keys()].sort()).toEqual(["bas_organisations", "bas_v_point"]);
  });

  it("reads the script's lists without the comments between entries", () => {
    const sql = "INSERT INTO analyze_ro (relname) VALUES\n  -- ('bas_commented'),\n  ('bas_a'),\n  ('bas_b');\nINSERT INTO analyze_hold (relname, reason) VALUES ('bas_c', 'why');";
    expect(scriptList(sql, "analyze_ro")).toEqual(["bas_a", "bas_b"]);
    expect(scriptList(sql, "analyze_hold")).toEqual(["bas_c"]);
  });
});
