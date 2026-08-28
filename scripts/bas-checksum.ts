import type { Client } from "pg";

/**
 * Content checksums for comparing two BAS databases.
 *
 * WHY THIS EXISTS
 *
 * scripts/bas-import.ts used to verify itself by comparing row counts. On
 * 21 August 2026 a separate port of the same vocabulary data had matching counts
 * on both sides and one corrupted value - a description whose text had been
 * broken across a line at a hyphen and rejoined with a space. A count says a row
 * exists. It says nothing about whether it is the same row.
 *
 * Applied to the import itself, this module immediately found microsecond
 * timestamps truncated to milliseconds, on every timestamptz column, in an
 * import that had reported IMPORT VERIFIED. See runbook.md.
 *
 * THE THREE RULES THIS MODULE IS BUILT ON
 *
 * 1. COERCE NOTHING. Every value becomes text through an expression chosen for
 *    its type and documented below. Floats go through float8send, so what is
 *    compared is the IEEE 754 bytes rather than a decimal rendering. Timestamps
 *    go through to_char at microsecond precision after AT TIME ZONE 'UTC', so a
 *    lost microsecond and a shifted offset both change the string.
 *
 * 2. A TYPE WITH NO RULE IS AN ERROR, never a skip and never a ::text fallback.
 *    A fallback is how a comparison quietly stops comparing.
 *
 * 3. COUNT WHAT WAS COMPARED. Same reasoning as the table count in
 *    bas-import.ts, one level down: a checksum computed over zero columns is a
 *    checksum of nothing, and md5 of nothing is a perfectly stable value that
 *    matches on both sides forever.
 */

/**
 * The exact-text expression per PostgreSQL type.
 *
 * `%s` is the quoted column reference. Every expression yields text or NULL, and
 * NULL is preserved rather than coalesced - the difference between NULL and the
 * empty string is exactly the kind of thing this module exists to catch.
 */
const EXACT_TEXT: Array<{ match: RegExp; expr: string; why: string }> = [
  {
    match: /^(smallint|integer|bigint)$/,
    expr: "(%s)::text",
    why: "exact for every integer width",
  },
  {
    match: /^boolean$/,
    expr: "(%s)::text",
    why: "true / false, no locale involved",
  },
  {
    match: /^numeric(\(\d+,\s*\d+\))?$/,
    expr: "(%s)::text",
    why: "numeric text output is exact and carries its own scale",
  },
  {
    // NOT ::text. A float rendered as decimal depends on extra_float_digits, and
    // matching two renderings does not prove the bits match. float8send is the
    // IEEE 754 big-endian bytes, so this compares the actual value.
    match: /^double precision$/,
    expr: "encode(float8send(%s), 'hex')",
    why: "IEEE 754 bytes, not a decimal rendering",
  },
  {
    match: /^real$/,
    expr: "encode(float4send(%s), 'hex')",
    why: "IEEE 754 bytes, not a decimal rendering",
  },
  {
    match: /^(text|character varying(\(\d+\))?|character\(\d+\))$/,
    expr: "(%s)::text",
    why: "the bytes as stored, including $-hex escapes and the string 'null'",
  },
  {
    match: /^uuid$/,
    expr: "(%s)::text",
    why: "canonical lowercase form",
  },
  {
    match: /^bytea$/,
    expr: "encode(%s, 'hex')",
    why: "bytes, independent of bytea_output",
  },
  {
    match: /^jsonb$/,
    expr: "(%s)::text",
    why: "jsonb text output is canonical - keys sorted, whitespace normalised",
  },
  {
    // Deliberately different from jsonb: json keeps the input text verbatim, so
    // two semantically equal documents can differ here. That is reported rather
    // than smoothed over, because a column that changed json -> jsonb between
    // the two databases is worth knowing about.
    match: /^json$/,
    expr: "(%s)::text",
    why: "raw text as stored; json is not canonicalised",
  },
  {
    // Microseconds, and normalised to UTC first. A truncated microsecond and a
    // shifted offset both change this string. ::text would depend on the
    // session TimeZone on each side.
    match: /^timestamp with time zone$/,
    expr: "to_char((%s) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')",
    why: "microsecond precision, UTC-normalised, session-independent",
  },
  {
    match: /^timestamp without time zone$/,
    expr: "to_char(%s, 'YYYY-MM-DD HH24:MI:SS.US')",
    why: "microsecond precision",
  },
  {
    match: /^date$/,
    expr: "to_char(%s, 'YYYY-MM-DD')",
    why: "ISO, independent of DateStyle",
  },
  {
    match: /^interval$/,
    expr: "(%s)::text",
    why: "exact; independent of IntervalStyle only if both sides agree",
  },
];

export interface ColumnType {
  name: string;
  /** `format_type` output, e.g. "timestamp with time zone". */
  type: string;
}

/** Column names and types for one table, in attribute order. */
export async function columnTypes(
  client: Client,
  schema: string,
  table: string,
): Promise<ColumnType[]> {
  const result = await client.query<{ name: string; type: string }>(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = $1 AND c.relname = $2
      ORDER BY a.attnum`,
    [schema, table],
  );

  if (result.rows.length === 0) {
    throw new Error(`${schema}.${table} has no columns, or does not exist.`);
  }

  return result.rows;
}

/** Double-quoted, so a column called `ts` or `end` is safe. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * The exact-text expression for one column, or a thrown error.
 *
 * Rule 2: an unrecognised type stops the comparison. Adding a `::text` default
 * here would make every future type silently comparable-ish, which is how a
 * verification stops verifying.
 */
export function exactTextExpression(column: ColumnType): string {
  const rule = EXACT_TEXT.find((candidate) => candidate.match.test(column.type));

  if (rule === undefined) {
    throw new Error(
      `No exact-text rule for ${column.name} (${column.type}). ` +
        "Add one to EXACT_TEXT in scripts/bas-checksum.ts, chosen so that two " +
        "equal values always render identically and two different values never " +
        "do. Do not fall back to ::text without deciding that is true.",
    );
  }

  return rule.expr.replace("%s", quoteIdent(column.name));
}

/** True for types whose ordering depends on the database collation. */
function isCollatable(type: string): boolean {
  return /^(text|character varying(\(\d+\))?|character\(\d+\))$/.test(type);
}

export interface TableChecksum {
  rows: number;
  /** md5 over every row hash, in key order. */
  checksum: string;
  /** Columns that went into the hash. Compared, not assumed - see rule 3. */
  columnsCompared: string[];
}

/**
 * One deterministic checksum for a whole table.
 *
 * Rows are ordered explicitly by `keyColumns`, with COLLATE "C" on text keys so
 * the result does not depend on the database collation. Today both databases are
 * English_United States.1252; Azure Database for PostgreSQL will not be, and an
 * ordering that changed with the locale would produce a mismatch that looks like
 * corruption.
 *
 * The per-row payload is a JSON array of the exact-text values, which is what
 * keeps NULL distinguishable from the empty string: `[null]` and `[""]` are
 * different strings.
 */
export async function tableChecksum(
  client: Client,
  schema: string,
  table: string,
  keyColumns: string[],
  /** Restrict to these columns. Omit to use every column in the table. */
  onlyColumns?: string[],
): Promise<TableChecksum> {
  const all = await columnTypes(client, schema, table);
  const columns =
    onlyColumns === undefined
      ? all
      : onlyColumns.map((name) => {
          const found = all.find((c) => c.name === name);
          if (found === undefined) {
            throw new Error(`${schema}.${table} has no column ${name}.`);
          }
          return found;
        });

  if (columns.length === 0) {
    throw new Error(
      `INCONCLUSIVE: ${schema}.${table} would be checksummed over zero columns. ` +
        "md5 of nothing is stable and matches on both sides forever.",
    );
  }

  for (const key of keyColumns) {
    if (!all.some((c) => c.name === key)) {
      throw new Error(`${schema}.${table} has no key column ${key}.`);
    }
  }

  const payload = `to_jsonb(ARRAY[${columns
    .map((c) => exactTextExpression(c))
    .join(", ")}]::text[])::text`;

  // The COLLATE goes in the inner SELECT, on the expression itself. Collation is
  // part of an expression's type and propagates through the subquery, so the
  // outer ORDER BY on the alias sorts in C order without repeating it. Verified
  // against both databases rather than assumed - see tests/bas-checksum.test.ts.
  const orderKeys = keyColumns.map((key, index) => {
    const column = all.find((c) => c.name === key);
    const ident = quoteIdent(key);
    const collated = isCollatable(column?.type ?? "")
      ? `${ident} COLLATE "C"`
      : ident;
    return { select: `${collated} AS k${index}`, order: `k${index}` };
  });

  const relation = `${quoteIdent(schema)}.${quoteIdent(table)}`;
  const sql =
    `SELECT count(*)::text AS rows,\n` +
    `       md5(coalesce(string_agg(h, '' ORDER BY ${orderKeys
      .map((k) => k.order)
      .join(", ")}), '')) AS checksum\n` +
    `  FROM (SELECT md5(${payload}) AS h,\n` +
    `               ${orderKeys.map((k) => k.select).join(",\n               ")}\n` +
    `          FROM ${relation}) s`;

  let result;
  try {
    result = await client.query<{ rows: string; checksum: string }>(sql);
  } catch (error) {
    // string_agg builds one text value of 32 bytes per row, and PostgreSQL caps a
    // single value at 1GB - so this construct runs out somewhere around 33
    // million rows. Today bas_readings is thousands. The Azure run could be
    // millions, and "invalid memory alloc request size" is not a message that
    // tells anyone what to do about it.
    const message = error instanceof Error ? error.message : String(error);
    if (/invalid memory alloc|out of memory/i.test(message)) {
      throw new Error(
        `${schema}.${table} is too large to checksum in one string_agg ` +
          `(${message}). The aggregate holds 32 bytes per row against a 1GB ` +
          "limit, so this bites around 33 million rows. Split the comparison by " +
          "key range - and do NOT fall back to comparing counts.",
      );
    }
    throw error;
  }

  const row = result.rows[0];
  if (row === undefined) {
    // An aggregate always returns one row, so this is unreachable - and an
    // unreachable branch that returns a plausible value is how a check stops
    // checking. See countRows in scripts/bas-import.ts.
    throw new Error(
      `Checksumming ${schema}.${table} returned no rows, which should be impossible.`,
    );
  }

  return {
    rows: Number(row.rows),
    checksum: row.checksum,
    columnsCompared: columns.map((c) => c.name),
  };
}

/** Per-key row hashes, for locating which rows differ once a table mismatches. */
export async function rowHashes(
  client: Client,
  schema: string,
  table: string,
  keyColumns: string[],
  onlyColumns?: string[],
): Promise<Map<string, string>> {
  const all = await columnTypes(client, schema, table);
  const columns =
    onlyColumns === undefined
      ? all
      : all.filter((c) => onlyColumns.includes(c.name));

  const payload = `to_jsonb(ARRAY[${columns
    .map((c) => exactTextExpression(c))
    .join(", ")}]::text[])::text`;

  const keyExpr = keyColumns
    .map((key) => {
      const column = all.find((c) => c.name === key);
      if (column === undefined) {
        throw new Error(`${schema}.${table} has no key column ${key}.`);
      }
      return `coalesce(${exactTextExpression(column)}, '<null>')`;
    })
    .join(" || '/' || ");

  const relation = `${quoteIdent(schema)}.${quoteIdent(table)}`;
  const result = await client.query<{ k: string; h: string }>(
    `SELECT ${keyExpr} AS k, md5(${payload}) AS h FROM ${relation}`,
  );

  const map = new Map<string, string>();
  for (const row of result.rows) map.set(row.k, row.h);
  return map;
}

/**
 * Per-column values for one key, so a mismatch can be reported as "this column,
 * this value, that value" rather than "the hashes differ".
 */
export async function rowValues(
  client: Client,
  schema: string,
  table: string,
  keyColumns: string[],
  key: string,
  onlyColumns?: string[],
): Promise<Record<string, string | null>> {
  const all = await columnTypes(client, schema, table);
  const columns =
    onlyColumns === undefined
      ? all
      : all.filter((c) => onlyColumns.includes(c.name));

  const keyExpr = keyColumns
    .map((name) => {
      const column = all.find((c) => c.name === name);
      if (column === undefined) {
        throw new Error(`${schema}.${table} has no key column ${name}.`);
      }
      return `coalesce(${exactTextExpression(column)}, '<null>')`;
    })
    .join(" || '/' || ");

  const relation = `${quoteIdent(schema)}.${quoteIdent(table)}`;
  const result = await client.query<Record<string, string | null>>(
    `SELECT ${columns
      .map((c) => `${exactTextExpression(c)} AS ${quoteIdent(c.name)}`)
      .join(", ")}
       FROM ${relation} WHERE ${keyExpr} = $1`,
    [key],
  );

  return result.rows[0] ?? {};
}

export interface TableComparison {
  table: string;
  match: boolean;
  source: TableChecksum;
  target: TableChecksum;
  /** Columns present on one side and not the other, or with a different type. */
  schemaDifferences: string[];
}

/**
 * Compares one table across two databases and reports whether it matches.
 *
 * The column lists and types are compared first. A column that exists on one
 * side only, or whose type differs, is reported explicitly - checksumming the
 * intersection and calling it a match would hide exactly the schema drift this
 * is supposed to surface.
 */
export async function compareTable(options: {
  source: Client;
  sourceSchema: string;
  sourceTable: string;
  target: Client;
  targetSchema: string;
  targetTable: string;
  keyColumns: string[];
  /** Columns to compare. Omit to compare every column on both sides. */
  columns?: string[];
  label?: string;
}): Promise<TableComparison> {
  const sourceColumns = await columnTypes(
    options.source,
    options.sourceSchema,
    options.sourceTable,
  );
  const targetColumns = await columnTypes(
    options.target,
    options.targetSchema,
    options.targetTable,
  );

  const wanted =
    options.columns ??
    sourceColumns
      .map((c) => c.name)
      .filter((name) => targetColumns.some((t) => t.name === name));

  const schemaDifferences: string[] = [];
  for (const name of wanted) {
    const from = sourceColumns.find((c) => c.name === name);
    const to = targetColumns.find((c) => c.name === name);
    if (from === undefined) {
      schemaDifferences.push(`${name}: missing from source`);
    } else if (to === undefined) {
      schemaDifferences.push(`${name}: missing from target`);
    } else if (from.type !== to.type) {
      schemaDifferences.push(`${name}: source ${from.type}, target ${to.type}`);
    }
  }

  const source = await tableChecksum(
    options.source,
    options.sourceSchema,
    options.sourceTable,
    options.keyColumns,
    wanted,
  );
  const target = await tableChecksum(
    options.target,
    options.targetSchema,
    options.targetTable,
    options.keyColumns,
    wanted,
  );

  // Both halves have to hold. Equal checksums over different column sets is not
  // a match, it is two different questions with the same answer.
  const sameColumns =
    source.columnsCompared.length === target.columnsCompared.length &&
    source.columnsCompared.every((c, i) => c === target.columnsCompared[i]);

  return {
    table: options.label ?? options.targetTable,
    match:
      sameColumns &&
      schemaDifferences.length === 0 &&
      source.rows === target.rows &&
      source.checksum === target.checksum,
    source,
    target,
    schemaDifferences,
  };
}
