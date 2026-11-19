import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The bas_* tables and views the migrations leave behind, replayed from the
 * SQL on disk - source text only, no database, so a guard built on it runs
 * everywhere CI runs and fails on the commit that adds the migration.
 *
 * Shared by the two role guards: tests/bas-analyze-grant-guard.test.ts (every
 * object classified for bas_analyze) and tests/bas-collector-grant-guard.test.ts
 * (every table the collector writes, and the migration that last created it).
 * One parser, so a fix to how a RENAME is read reaches both.
 */

export interface Created {
  name: string;
  kind: "table" | "view";
  /** The migration that created the object AS IT STANDS: a drop-and-create,
   *  or a rename onto the name, moves this to the later migration. */
  migration: string;
}

export interface Migration {
  name: string;
  sql: string;
}

const MIGRATIONS = path.join(process.cwd(), "prisma/migrations");

export function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

const NAME = String.raw`(?:"?public"?\.)?"?(bas_[a-z0-9_]+)"?`;
const CREATE = new RegExp(
  String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:UNLOGGED\s+)?(?:MATERIALIZED\s+)?(TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?${NAME}`,
  "gi",
);
const DROP = new RegExp(String.raw`\bDROP\s+(?:MATERIALIZED\s+)?(?:TABLE|VIEW)\s+(?:IF\s+EXISTS\s+)?${NAME}`, "gi");
const RENAME = new RegExp(
  String.raw`\bALTER\s+(?:TABLE|VIEW)\s+(?:IF\s+EXISTS\s+)?${NAME}\s+RENAME\s+TO\s+"?(bas_[a-z0-9_]+)"?`,
  "gi",
);

/**
 * The bas_* objects that exist after applying the migrations in order: each
 * CREATE adds, a DROP removes, a RENAME moves. Migration directories sort by
 * their timestamp prefix, which is the order Prisma applies them in.
 */
export function basObjectsFromMigrations(migrations: Migration[]): Map<string, Created> {
  const live = new Map<string, Created>();
  for (const m of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    const sql = stripComments(m.sql);
    const events: Array<{ at: number; apply: () => void }> = [];
    for (const x of sql.matchAll(CREATE)) {
      const name = x[2]!.toLowerCase();
      const kind = x[1]!.toLowerCase() as "table" | "view";
      events.push({ at: x.index!, apply: () => void (live.has(name) ? undefined : live.set(name, { name, kind, migration: m.name })) });
    }
    for (const x of sql.matchAll(DROP)) {
      const name = x[1]!.toLowerCase();
      events.push({ at: x.index!, apply: () => void live.delete(name) });
    }
    for (const x of sql.matchAll(RENAME)) {
      const from = x[1]!.toLowerCase();
      const to = x[2]!.toLowerCase();
      events.push({
        at: x.index!,
        apply: () => {
          const was = live.get(from);
          live.delete(from);
          live.set(to, { name: to, kind: was?.kind ?? "table", migration: m.name });
        },
      });
    }
    for (const e of events.sort((a, b) => a.at - b.at)) e.apply();
  }
  return live;
}

export function readMigrations(): Migration[] {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, sql: readFileSync(path.join(MIGRATIONS, d.name, "migration.sql"), "utf8") }));
}

/**
 * The first quoted name of every tuple in one `INSERT INTO <table> ... VALUES`
 * block of a role script, comments between entries ignored. A role script's
 * allowlists are temp tables filled this way.
 */
export function scriptList(sql: string, table: string): string[] {
  return [...insertBlock(sql, table).matchAll(/\(\s*'([a-z0-9_]+)'/g)].map((m) => m[1]!);
}

/**
 * `(name, value)` pairs from a two-column block whose second column is a
 * plain identifier - collector_writes' (relname, created_by).
 */
export function scriptPairs(sql: string, table: string): Array<[string, string]> {
  return [...insertBlock(sql, table).matchAll(/\(\s*'([a-z0-9_]+)'\s*,\s*'([a-z0-9_]+)'\s*\)/g)].map(
    (m) => [m[1]!, m[2]!] as [string, string],
  );
}

/**
 * The statement from `INSERT INTO <table>` to its terminating semicolon - the
 * first one outside a quoted string or a comment. A reason such as
 * 'view; healthcheck.py reads it' holds a semicolon, and ending at the first
 * one cut the collector's lists short (found writing the collector guard).
 */
function insertBlock(sql: string, table: string): string {
  const start = sql.indexOf(`INSERT INTO ${table} `);
  if (start < 0) throw new Error(`the script has no INSERT INTO ${table}`);
  let i = start;
  let quoted = false;
  while (i < sql.length) {
    const c = sql[i]!;
    if (quoted) {
      if (c === "'") quoted = sql[i + 1] === "'" ? (i++, true) : false;
    } else if (c === "'") {
      quoted = true;
    } else if (c === "-" && sql[i + 1] === "-") {
      const eol = sql.indexOf("\n", i);
      i = eol < 0 ? sql.length : eol;
      continue;
    } else if (c === ";") {
      break;
    }
    i++;
  }
  return stripComments(sql.slice(start, i));
}
