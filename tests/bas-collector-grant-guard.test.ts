import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  basObjectsFromMigrations,
  readMigrations,
  scriptList,
  scriptPairs,
  stripComments,
  type Created,
  type Migration,
} from "./bas-migration-objects";

/**
 * scripts/setup-bas-collector-role.sql held to the migrations, source text
 * only - no database, no psql - so it runs everywhere CI runs and fails on the
 * commit that adds the migration, not on the collector's first refused write.
 *
 * Why it exists (2026-11-19). From 6 to 19 November the collector's role on
 * the Azure database had no USAGE on bas_data_gaps_gap_id_seq: the script
 * withheld it on the belief that the collector never inserted a gap, revoked it
 * on every run, and its proof failed if it was there. record_gap does insert,
 * and the first new loss stopped every pass for thirteen days. That was the
 * script, not a migration - but a migration that drops and recreates a table
 * the collector writes does the same thing a different way: the new table and
 * its new sequence carry none of the role's grants until the script is re-run.
 *
 * So, for the six tables the collector writes:
 *
 *   - the script names exactly those six (collector_writes), and grants each
 *     read-write (collector_rw);
 *   - each carries the migration that created the table AS IT STANDS, and that
 *     must match what replaying the migrations says. A later drop-and-create,
 *     or a rename onto the name, fails here until the line is updated - and the
 *     message says the update is half the job: the script must then be re-run
 *     on production (runbook.md -> "The collector stops on "permission denied"
 *     for a bas_* table or sequence" -> "Re-run after a migration");
 *   - every sequence owned by a granted table is in collector_seq, and nothing
 *     else is, so an INSERT the collector makes always has its sequence.
 *
 * And for every bas_* object: classified in collector_rw, collector_ro or
 * collector_none, as the script's own gate demands at run time.
 *
 * tests/bas-migration-scripts.test.ts runs the real script through psql on a
 * fresh cluster; this file holds its lists to the migrations. Neither can do
 * the production re-run, which is a person's step.
 */

const SCRIPT_PATH = path.join(process.cwd(), "scripts/setup-bas-collector-role.sql");

/**
 * The tables phb-bas collector/db.py writes, read off its SQL. The collector
 * holds the same six in Repository.REQUIRED_PRIVILEGES and checks them at the
 * start of every pass; no CI can see both repositories, so this copy and that
 * one are kept equal by hand and say so in both places.
 */
const COLLECTOR_WRITES = [
  "bas_data_gaps",
  "bas_ingest_runs",
  "bas_points",
  "bas_readings",
  "bas_stations",
  "bas_sync_checkpoints",
];

// --- serial sequences, replayed --------------------------------------------

const SERIAL = String.raw`(?:SMALLSERIAL|BIGSERIAL|SERIAL[248]?)`;
const IDENTITY = String.raw`GENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY`;
const COLUMN_SERIAL = new RegExp(String.raw`(?:^|[(,])\s*"?([a-z0-9_]+)"?\s+(?:${SERIAL}\b|[a-z]+[^,]*?${IDENTITY})`, "gi");
const CREATE_TABLE = /\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?(bas_[a-z0-9_]+)"?\s*\(/gi;
const DROP_TABLE = /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"?public"?\.)?"?(bas_[a-z0-9_]+)"?/gi;
const RENAME_TABLE = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"?public"?\.)?"?(bas_[a-z0-9_]+)"?\s+RENAME\s+TO\s+"?(bas_[a-z0-9_]+)"?/gi;
const ADD_COLUMN = new RegExp(
  String.raw`\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:"?public"?\.)?"?(bas_[a-z0-9_]+)"?\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z0-9_]+)"?\s+(?:${SERIAL}\b|[a-z]+[^;,]*?${IDENTITY})`,
  "gi",
);

/** The body of `CREATE TABLE x ( ... )`, by paren depth from the opening one. */
function tableBody(sql: string, open: number): string {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")" && --depth === 0) return sql.slice(open + 1, i);
  }
  return sql.slice(open + 1);
}

/**
 * Table -> the sequences its serial and identity columns own, after every
 * migration in order. PostgreSQL names such a sequence <table>_<column>_seq
 * when the column is created and keeps that name through a table rename,
 * which is why a rename moves the entry without renaming it.
 */
function serialSequencesFromMigrations(migrations: Migration[]): Map<string, Set<string>> {
  const owned = new Map<string, Set<string>>();
  for (const m of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    const sql = stripComments(m.sql);
    const events: Array<{ at: number; apply: () => void }> = [];
    for (const x of sql.matchAll(CREATE_TABLE)) {
      const table = x[1]!.toLowerCase();
      const body = tableBody(sql, x.index! + x[0].length - 1);
      const seqs = [...body.matchAll(COLUMN_SERIAL)].map((c) => `${table}_${c[1]!.toLowerCase()}_seq`);
      events.push({ at: x.index!, apply: () => void (owned.has(table) ? undefined : owned.set(table, new Set(seqs))) });
    }
    for (const x of sql.matchAll(DROP_TABLE)) {
      const table = x[1]!.toLowerCase();
      events.push({ at: x.index!, apply: () => void owned.delete(table) });
    }
    for (const x of sql.matchAll(RENAME_TABLE)) {
      const from = x[1]!.toLowerCase();
      const to = x[2]!.toLowerCase();
      events.push({
        at: x.index!,
        apply: () => {
          const seqs = owned.get(from) ?? new Set<string>();
          owned.delete(from);
          owned.set(to, seqs);
        },
      });
    }
    for (const x of sql.matchAll(ADD_COLUMN)) {
      const table = x[1]!.toLowerCase();
      const seq = `${table}_${x[2]!.toLowerCase()}_seq`;
      events.push({
        at: x.index!,
        apply: () => void (owned.get(table) ?? owned.set(table, new Set()).get(table)!).add(seq),
      });
    }
    for (const e of events.sort((a, b) => a.at - b.at)) e.apply();
  }
  return owned;
}

// --- the guard --------------------------------------------------------------

interface ScriptLists {
  rw: string[];
  ro: string[];
  none: string[];
  seq: string[];
  writes: Array<[string, string]>;
}

function readScriptLists(sql: string): ScriptLists {
  return {
    rw: scriptList(sql, "collector_rw"),
    ro: scriptList(sql, "collector_ro"),
    none: scriptList(sql, "collector_none"),
    seq: scriptList(sql, "collector_seq"),
    writes: scriptPairs(sql, "collector_writes"),
  };
}

interface GuardResult {
  writesNotMatching: string[];
  writesNotGranted: string[];
  recreatedSince: Array<{ table: string; listed: string; actual: Created | undefined }>;
  sequencesMissing: string[];
  sequencesStale: string[];
  unclassified: Created[];
  listedButNeverCreated: string[];
}

function checkCollectorGrants(
  objects: Map<string, Created>,
  sequences: Map<string, Set<string>>,
  lists: ScriptLists,
  collectorWrites: string[],
): GuardResult {
  const listedWrites = lists.writes.map(([table]) => table).sort();
  const expectedSeq = new Set([...lists.rw].flatMap((t) => [...(sequences.get(t) ?? [])]));
  const classified = new Set([...lists.rw, ...lists.ro, ...lists.none]);
  return {
    writesNotMatching:
      JSON.stringify(listedWrites) === JSON.stringify([...collectorWrites].sort())
        ? []
        : [`script lists ${JSON.stringify(listedWrites)}, the collector writes ${JSON.stringify([...collectorWrites].sort())}`],
    writesNotGranted: listedWrites.filter((t) => !lists.rw.includes(t)),
    recreatedSince: lists.writes
      .filter(([table, listed]) => objects.get(table)?.migration !== listed)
      .map(([table, listed]) => ({ table, listed, actual: objects.get(table) })),
    sequencesMissing: [...expectedSeq].filter((s) => !lists.seq.includes(s)).sort(),
    sequencesStale: lists.seq.filter((s) => !expectedSeq.has(s)).sort(),
    unclassified: [...objects.values()].filter((o) => !classified.has(o.name)),
    listedButNeverCreated: [...classified].filter((n) => !objects.has(n)).sort(),
  };
}

const RERUN = 'runbook.md -> "The collector stops on "permission denied" for a bas_* table or sequence" -> "Re-run after a migration"';

function explain(r: GuardResult): string {
  const lines: string[] = [];
  for (const m of r.writesNotMatching) {
    lines.push(`collector_writes is not the collector's write set: ${m}. Change both together (phb-bas collector/db.py REQUIRED_PRIVILEGES).`);
  }
  for (const t of r.writesNotGranted) lines.push(`${t} is in collector_writes but not in collector_rw: the collector could not write it.`);
  for (const x of r.recreatedSince) {
    lines.push(
      x.actual === undefined
        ? `${x.table} is in collector_writes but no migration leaves it in place.`
        : `${x.table} was (re)created in prisma/migrations/${x.actual.migration}, not ${x.listed}. A recreated table and its new ` +
            `sequence carry NONE of bas_collector's grants until the script is re-run. Update created_by for ${x.table} in ` +
            `scripts/setup-bas-collector-role.sql, and re-run it on production once the migration has deployed (${RERUN}).`,
    );
  }
  for (const s of r.sequencesMissing) {
    lines.push(`${s} is owned by a table in collector_rw but is not in collector_seq: an INSERT into that table would be refused. Add it.`);
  }
  for (const s of r.sequencesStale) lines.push(`${s} is in collector_seq but no collector_rw table owns it; the script's gate refuses to run.`);
  for (const o of r.unclassified) {
    lines.push(
      `${o.name} (${o.kind}, created in prisma/migrations/${o.migration}) is in none of collector_rw, collector_ro, collector_none. ` +
        `The script refuses to run until it is classified.`,
    );
  }
  for (const n of r.listedButNeverCreated) lines.push(`${n} is classified in the script but no migration creates it.`);
  return lines.join("\n");
}

describe("setup-bas-collector-role.sql agrees with the migrations", () => {
  const migrations = readMigrations();
  const objects = basObjectsFromMigrations(migrations);
  const sequences = serialSequencesFromMigrations(migrations);
  const script = readFileSync(SCRIPT_PATH, "utf8");
  const lists = readScriptLists(script);

  it("reads the migrations and the script, not nothing", () => {
    // A parser that matched nothing would pass every check below vacuously.
    expect(objects.size).toBeGreaterThanOrEqual(29);
    for (const t of COLLECTOR_WRITES) expect(objects.has(t), t).toBe(true);
    expect(sequences.get("bas_data_gaps")).toEqual(new Set(["bas_data_gaps_gap_id_seq"]));
    expect(sequences.get("bas_readings")).toEqual(new Set());
    expect(lists.rw.length).toBeGreaterThanOrEqual(13);
    expect(lists.writes.length).toBe(COLLECTOR_WRITES.length);
    expect(lists.seq.length).toBeGreaterThanOrEqual(8);
  });

  it("lists every table the collector writes, with the migration that created it as it stands, every owned sequence, and classifies every bas_* object", () => {
    expect(explain(checkCollectorGrants(objects, sequences, lists, COLLECTOR_WRITES))).toBe("");
  });

  it("grants the gaps sequence - the one whose absence stopped collection from 6 November 2026", () => {
    expect(lists.seq).toContain("bas_data_gaps_gap_id_seq");
    // The old proof refused the grant. Nothing may assert its absence again.
    expect(script).not.toMatch(/IF\s+has_sequence_privilege\('bas_collector',\s*'public\.bas_data_gaps_gap_id_seq',\s*'USAGE'\)\s+THEN/);
  });

  it("grants sequences by default and tables never by default", () => {
    const code = stripComments(script);
    expect(code).toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES\s+IN\s+SCHEMA\s+public\s+GRANT\s+USAGE,\s*SELECT\s+ON\s+SEQUENCES\s+TO\s+bas_collector/i);
    expect(code).not.toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES[^;]*\bON\s+TABLES\b/i);
    expect(code).not.toMatch(/\bON\s+ALL\s+TABLES\b/i);
  });

  it("refuses with RAISE, never \\quit, which exits 0", () => {
    expect(stripComments(script)).not.toMatch(/\\q(?:uit)?\b/);
  });

  it("tells the operator the az firewall-rule flags az accepts (-s server, -n rule)", () => {
    expect(script).not.toContain("--rule-name");
    expect(script).toMatch(/firewall-rule create[^\n]*-s <server> -n /);
  });
});

describe("the guard itself", () => {
  const base: Migration[] = [
    {
      name: "20260101000000_init",
      sql: 'CREATE TABLE "bas_data_gaps" (\n    "gap_id" BIGSERIAL NOT NULL,\n    "point_id" BIGINT NOT NULL,\n    CONSTRAINT "bas_data_gaps_pkey" PRIMARY KEY ("gap_id")\n);\nCREATE TABLE "bas_readings" ("point_id" BIGINT, "ts" TIMESTAMPTZ(3));',
    },
  ];
  const lists = (over: Partial<ScriptLists> = {}): ScriptLists => ({
    rw: ["bas_data_gaps", "bas_readings"],
    ro: [],
    none: [],
    seq: ["bas_data_gaps_gap_id_seq"],
    writes: [
      ["bas_data_gaps", "20260101000000_init"],
      ["bas_readings", "20260101000000_init"],
    ],
    ...over,
  });
  const check = (ms: Migration[], l: ScriptLists = lists()) =>
    checkCollectorGrants(basObjectsFromMigrations(ms), serialSequencesFromMigrations(ms), l, ["bas_data_gaps", "bas_readings"]);

  it("passes the baseline", () => {
    expect(explain(check(base))).toBe("");
  });

  it("fails when a later migration drops and recreates a written table, naming the migration and the re-run", () => {
    const r = check([
      ...base,
      {
        name: "20261201000000_rebuild_gaps",
        sql: 'DROP TABLE "bas_data_gaps";\nCREATE TABLE "bas_data_gaps" ("gap_id" BIGSERIAL NOT NULL, "point_id" BIGINT NOT NULL);',
      },
    ]);
    expect(r.recreatedSince.map((x) => [x.table, x.actual?.migration])).toEqual([["bas_data_gaps", "20261201000000_rebuild_gaps"]]);
    expect(explain(r)).toContain("Re-run after a migration");
  });

  it("fails on the rename-swap form of a recreate", () => {
    const r = check([
      ...base,
      {
        name: "20261201000000_swap",
        sql: 'CREATE TABLE "bas_readings_new" ("point_id" BIGINT);\nDROP TABLE "bas_readings";\nALTER TABLE "bas_readings_new" RENAME TO "bas_readings";',
      },
    ]);
    expect(r.recreatedSince.map((x) => x.table)).toEqual(["bas_readings"]);
  });

  it("fails when a serial column is added to a granted table, naming the sequence", () => {
    const r = check([...base, { name: "20261201000000_seq", sql: 'ALTER TABLE "bas_readings" ADD COLUMN "reading_id" BIGSERIAL;' }]);
    expect(r.sequencesMissing).toEqual(["bas_readings_reading_id_seq"]);
  });

  it("fails when the gaps sequence is withheld - the 2026-11-06 shape", () => {
    expect(check(base, lists({ seq: [] })).sequencesMissing).toEqual(["bas_data_gaps_gap_id_seq"]);
  });

  it("reads identity columns as owning a sequence too", () => {
    const ms: Migration[] = [{ name: "20260101000000_init", sql: 'CREATE TABLE "bas_x" ("id" BIGINT GENERATED BY DEFAULT AS IDENTITY, "v" TEXT);' }];
    expect(serialSequencesFromMigrations(ms).get("bas_x")).toEqual(new Set(["bas_x_id_seq"]));
  });

  it("fails when the script's write list and the collector's disagree, or a written table is not granted", () => {
    const r = checkCollectorGrants(basObjectsFromMigrations(base), serialSequencesFromMigrations(base), lists({ rw: ["bas_data_gaps"] }), [
      "bas_data_gaps",
      "bas_readings",
      "bas_points",
    ]);
    expect(r.writesNotMatching.length).toBe(1);
    expect(r.writesNotGranted).toEqual(["bas_readings"]);
  });

  it("ignores commented-out SQL", () => {
    const r = check([...base, { name: "20261201000000_c", sql: '-- DROP TABLE "bas_data_gaps";\n/* CREATE TABLE "bas_data_gaps" (x int); */' }]);
    expect(explain(r)).toBe("");
  });

  it("reads (relname, created_by) pairs without the comments between them", () => {
    const sql = "INSERT INTO collector_writes (relname, created_by) VALUES\n  -- ('bas_ghost', 'x'),\n  ('bas_a', '2026_a'),\n  ('bas_b',   '2026_b');";
    expect(scriptPairs(sql, "collector_writes")).toEqual([
      ["bas_a", "2026_a"],
      ["bas_b", "2026_b"],
    ]);
  });
});
