/**
 * Moves the standalone BAS database into the platform's bas_* tables.
 *
 *   npx tsx scripts/bas-import.ts            # dry run - counts only, writes nothing
 *   npx tsx scripts/bas-import.ts --apply
 *
 * Source: BAS_SOURCE_DATABASE_URL, the `bas` schema of the standalone database
 *         built by C:\dev\bas-db. Read-only - this script never writes to it.
 * Target: DATABASE_URL, the platform database, bas_* tables in `public`.
 *
 * WHY THIS SCRIPT OUTLIVES ITS FIRST RUN
 *
 * The rows it moves today are worthless: four synthetic History Emulator
 * points. The script is not. The same move has to happen again when the
 * platform goes to Azure, and by then the data is irreplaceable - the JACE
 * overwrites its own history roughly every 42 hours, so once a row is in
 * Postgres this is the only copy of it in existence (decision D10). Debugging
 * that move against data nobody cares about is the entire point.
 *
 * POINT IDS ARE PRESERVED, AND THAT IS NOT COSMETIC
 *
 * bas_sync_checkpoints and bas_readings both key on point_id. If the ids
 * changed, every checkpoint would point at the wrong point and the collector
 * would either re-fetch everything or silently skip. So ids are inserted
 * explicitly and each sequence is then advanced past the highest value - which
 * works because Prisma emits these columns as SERIAL/IDENTITY BY DEFAULT rather
 * than GENERATED ALWAYS. If a future migration switches them to GENERATED
 * ALWAYS, this script needs OVERRIDING SYSTEM VALUE and will fail loudly until
 * it gets it.
 *
 * SAFETY PROPERTIES
 *
 *   - Dry run by default. --apply is required to write anything.
 *   - One transaction. A failure halfway leaves the target untouched rather
 *     than half-populated.
 *   - Refuses to run if any target bas_ table already has rows, unless
 *     --truncate-target is given. Re-running by accident must not double-insert
 *     or partially overwrite.
 *   - Verifies by CONTENT, not by row count, and inside the transaction. The
 *     first run of this script reported "12/12 tables reconciled, 3,481 rows"
 *     and had truncated every microsecond and turned a jsonb array into an
 *     object. Counts matched exactly. See scripts/bas-checksum.ts.
 *   - Counts what it verified - tables AND columns - and refuses to report
 *     success on a short count. A verification that skips its checks and still
 *     prints PASS is worse than no verification: that exact bug shipped in
 *     Test-BasRestore.ps1 and is recorded in the runbook.
 *   - Reads the source in one REPEATABLE READ snapshot, so the count, the copy
 *     and the verification all see the same rows even though the standalone
 *     collector keeps writing.
 *   - Never prints a connection string. Host and database name only.
 */

import path from "node:path";
import { config as loadEnv } from "dotenv";
import { Client, types } from "pg";
import { MOVES } from "./bas-tables";
import {
  columnTypes,
  compareTable,
  rowHashes,
  rowValues,
} from "./bas-checksum";

loadEnv({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });
loadEnv({ path: path.resolve(process.cwd(), ".env"), quiet: true });

/**
 * READ EVERY LOSSY TYPE AS RAW TEXT. This is not a preference, it is the fix for
 * a corruption this script shipped.
 *
 * node-postgres parses some types into JavaScript values that cannot represent
 * what PostgreSQL sent, and the script then wrote that JavaScript value back:
 *
 *   timestamptz  ->  JS Date, which has MILLISECOND resolution.
 *                    2026-08-20 12:31:32.995363 came back as .995 and was
 *                    written as .995000. Every timestamp in the first import
 *                    lost its microseconds: 107 of 107 values ended in .xxx000.
 *
 *   jsonb array  ->  JS Array, which node-postgres then serialises as a
 *                    POSTGRES ARRAY LITERAL rather than JSON. jsonb `[]` was
 *                    written back as jsonb `{}` - an array became an object.
 *                    Harmless only because every array was empty.
 *
 * Row counts saw none of it. Handing the raw text straight back to PostgreSQL
 * means the server does the parsing, exactly as it would for a dump and restore.
 * NULL is unaffected: a type parser is never called for NULL.
 */
const RAW = (value: string): string => value;
types.setTypeParser(types.builtins.TIMESTAMPTZ, RAW);
types.setTypeParser(types.builtins.TIMESTAMP, RAW);
types.setTypeParser(types.builtins.DATE, RAW);
types.setTypeParser(types.builtins.JSONB, RAW);
types.setTypeParser(types.builtins.JSON, RAW);
// float8 round-tripped exactly through a JS number - both are IEEE 754 doubles,
// and the bytes were verified identical. Read as text anyway: relying on that
// is relying on node-postgres using a shortest-round-trip formatter forever.
types.setTypeParser(types.builtins.FLOAT8, RAW);
types.setTypeParser(types.builtins.FLOAT4, RAW);

/**
 * Source types this script knows it can copy without losing information.
 *
 * Checked against the live schema before anything is written. A column whose
 * type is not here stops the import - the alternative is discovering the next
 * timestamptz-shaped bug after the standalone database is gone.
 */
const LOSSLESS_TYPES = new Set([
  "smallint",
  "integer",
  "bigint",
  "boolean",
  "text",
  "double precision",
  "real",
  "jsonb",
  "json",
  "timestamp with time zone",
  "timestamp without time zone",
  "date",
  "uuid",
]);

const APPLY = process.argv.includes("--apply");
const TRUNCATE_TARGET = process.argv.includes("--truncate-target");

/**
 * Rows per INSERT for the readings table.
 *
 * Everything else is metadata and fits in one statement. Readings do not: this
 * is four synthetic points today, but the Azure run could be millions of rows,
 * and a single statement with millions of bound parameters exceeds what the
 * protocol allows.
 */
const READING_BATCH = 1000;


/** Host and database only. A connection string carries a password. */
function describe(connectionString: string): string {
  const url = new URL(connectionString);
  return `${url.host}${url.pathname}`;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is not set.`);
  }
  return value;
}

async function countRows(client: Client, table: string): Promise<number> {
  const result = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  const row = result.rows[0];
  // count(*) always returns exactly one row, so this cannot happen - but the
  // whole point of this script is that a count it cannot vouch for must not be
  // reported as a number. Returning 0 here would look like an empty table.
  if (row === undefined) {
    throw new Error(`Counting ${table} returned no rows, which should be impossible.`);
  }
  return Number(row.n);
}

async function main(): Promise<void> {
  const sourceUrl = requireEnv("BAS_SOURCE_DATABASE_URL");
  const targetUrl = requireEnv("DATABASE_URL");

  if (sourceUrl === targetUrl) {
    throw new Error(
      "BAS_SOURCE_DATABASE_URL and DATABASE_URL are the same database. " +
        "The source is the standalone bas database; the target is the platform database.",
    );
  }

  console.log(`Source  ${describe(sourceUrl)}  (schema bas, read-only)`);
  console.log(`Target  ${describe(targetUrl)}  (bas_* tables)`);
  console.log(APPLY ? "Mode    APPLY\n" : "Mode    DRY RUN - nothing will be written\n");

  const source = new Client({ connectionString: sourceUrl });
  const target = new Client({ connectionString: targetUrl });
  await source.connect();
  await target.connect();

  // Belt and braces: the source is only ever read, and the connection says so.
  await source.query("SET default_transaction_read_only = on");

  // Raw timestamptz text carries its own offset, so the instant survives whatever
  // the target's timezone is. Forcing UTC makes the strings readable and keeps a
  // failed comparison legible.
  await source.query("SET TimeZone = 'UTC'");

  /**
   * ONE SNAPSHOT OF THE SOURCE, for the whole run.
   *
   * The standalone collector writes to the source every 15 minutes. Without this
   * the script counts the source, copies it, and then verifies against it as
   * three separate reads of a moving target - so a row written between the copy
   * and the verify reads as a failed import, and a row written between the count
   * and the copy reads as a count mismatch. Either way the operator is sent
   * looking for corruption that is not there.
   *
   * REPEATABLE READ holds one snapshot for every statement on this connection.
   * It costs the source a held snapshot for the duration, which is the right
   * trade for a comparison that means something.
   */
  await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

  try {
    // ---- refuse types this script cannot copy losslessly ------------------
    // Before anything is read, let alone written. A column type with no proven
    // round-trip is how the first import lost every microsecond.
    const unknownTypes: string[] = [];
    let typesChecked = 0;
    for (const move of MOVES) {
      const columns = await columnTypes(source, "bas", move.source);
      for (const name of move.columns) {
        const column = columns.find((c) => c.name === name);
        if (column === undefined) {
          throw new Error(`bas.${move.source} has no column ${name}.`);
        }
        typesChecked += 1;
        if (!LOSSLESS_TYPES.has(column.type)) {
          unknownTypes.push(`bas.${move.source}.${name} is ${column.type}`);
        }
      }
    }

    const expectedColumns = MOVES.reduce((n, m) => n + m.columns.length, 0);
    if (typesChecked !== expectedColumns) {
      throw new Error(
        `INCONCLUSIVE: checked ${typesChecked} of ${expectedColumns} column types.`,
      );
    }
    if (unknownTypes.length > 0) {
      throw new Error(
        "These source columns have types this script has not been proven to copy " +
          `losslessly:\n  ${unknownTypes.join("\n  ")}\n\n` +
          "Add the type to LOSSLESS_TYPES only after deciding how it is read - " +
          "see the type-parser block at the top of this file - and add a matching " +
          "rule to EXACT_TEXT in scripts/bas-checksum.ts so the verification can " +
          "actually compare it.",
      );
    }
    console.log(`${typesChecked} source columns, all of known lossless types.\n`);

    // ---- inspect both sides before touching anything ----------------------
    const sourceCounts = new Map<string, number>();
    const targetCounts = new Map<string, number>();
    for (const move of MOVES) {
      sourceCounts.set(move.source, await countRows(source, `bas.${move.source}`));
      targetCounts.set(move.target, await countRows(target, move.target));
    }

    console.log("table                      source    target");
    for (const move of MOVES) {
      console.log(
        `${move.target.padEnd(24)} ${String(sourceCounts.get(move.source)).padStart(7)} ` +
          `${String(targetCounts.get(move.target)).padStart(9)}`,
      );
    }
    console.log();

    const occupied = MOVES.filter((m) => (targetCounts.get(m.target) ?? 0) > 0);

    // A dry run is a read-only inspection and must always succeed, even when
    // the answer is "you cannot import onto this". It reports the blocker and
    // exits 0. Exiting non-zero for a condition the script was asked to look
    // for is how you train someone to ignore the exit code - the same mistake
    // the health check made by exiting 1 on a warning (see docs/runbook.md).
    if (occupied.length > 0) {
      const message =
        `The target already has rows in: ${occupied.map((m) => m.target).join(", ")}.\n\n` +
        "Importing on top of existing data would either duplicate rows or fail " +
        "halfway. --truncate-target replaces them, but read this first: beyond " +
        "the JACE's ~42-hour roll horizon, bas_readings is the only copy of that " +
        "data in existence. Take a backup first.";

      if (!TRUNCATE_TARGET) {
        if (!APPLY) {
          console.log(`BLOCKED: ${message}`);
          console.log("\nDry run complete. Nothing was written.");
          return;
        }
        throw new Error(message);
      }
    }

    if (!APPLY) {
      console.log("Dry run complete. Re-run with --apply to perform the import.");
      return;
    }

    // ---- one transaction --------------------------------------------------
    await target.query("BEGIN");

    if (TRUNCATE_TARGET) {
      const tables = [...MOVES].reverse().map((m) => m.target).join(", ");
      await target.query(`TRUNCATE TABLE ${tables} CASCADE`);
      console.log("Target bas_* tables truncated.\n");
    }

    let rowsWritten = 0;

    for (const move of MOVES) {
      const deferred = new Set(move.deferred ?? []);
      const rows = (await source.query(
        `SELECT ${move.columns.join(", ")} FROM bas.${move.source}`,
      )).rows as Array<Record<string, unknown>>;

      if (rows.length > 0) {
        const batchSize = move.source === "reading" ? READING_BATCH : rows.length;

        for (let start = 0; start < rows.length; start += batchSize) {
          const batch = rows.slice(start, start + batchSize);
          const params: unknown[] = [];
          const tuples = batch.map((row) => {
            const placeholders = move.columns.map((column) => {
              // Self-references go in as NULL now and are patched below.
              params.push(deferred.has(column) ? null : row[column]);
              return `$${params.length}`;
            });
            return `(${placeholders.join(", ")})`;
          });

          await target.query(
            `INSERT INTO ${move.target} (${move.columns.join(", ")}) VALUES ${tuples.join(", ")}`,
            params,
          );
        }
        rowsWritten += rows.length;
      }

      // Second pass for the self-references now that every row exists.
      if (deferred.size > 0 && move.keyColumn !== undefined) {
        for (const row of rows) {
          const setColumns = [...deferred].filter((c) => row[c] !== null);
          if (setColumns.length === 0) continue;

          const params: unknown[] = [];
          const assignments = setColumns.map((c) => {
            params.push(row[c]);
            return `${c} = $${params.length}`;
          });
          params.push(row[move.keyColumn]);

          await target.query(
            `UPDATE ${move.target} SET ${assignments.join(", ")} ` +
              `WHERE ${move.keyColumn} = $${params.length}`,
            params,
          );
        }
      }

      // Advance the sequence past the ids just inserted, or the next insert
      // collides with a preserved id. pg_get_serial_sequence returns null if
      // the column has no sequence, which would be a schema change worth
      // hearing about rather than skipping quietly.
      if (move.sequenceColumn !== undefined && rows.length > 0) {
        const seq = await target.query<{ seq: string | null }>(
          "SELECT pg_get_serial_sequence($1, $2) AS seq",
          [move.target, move.sequenceColumn],
        );
        const sequence = seq.rows[0]?.seq ?? null;
        if (sequence === null) {
          throw new Error(
            `${move.target}.${move.sequenceColumn} has no sequence. The column is ` +
              "probably GENERATED ALWAYS now, which needs OVERRIDING SYSTEM VALUE " +
              "on the inserts above.",
          );
        }
        await target.query(
          `SELECT setval($1, (SELECT max(${move.sequenceColumn}) FROM ${move.target}))`,
          [sequence],
        );
      }

      console.log(`  ${move.target.padEnd(24)} ${String(rows.length).padStart(7)} rows`);
    }

    // ---- verify inside the transaction, before committing -----------------
    //
    // BY CONTENT, not by row count. The first run of this script reported
    // "12/12 tables reconciled, 3,481 rows" and had silently truncated every
    // microsecond and turned a jsonb array into a jsonb object. Counts were
    // exact. See docs/runbook.md.
    //
    // Both sides are hashed with the same type-aware exact-text expressions -
    // float8 as IEEE 754 bytes, timestamps at microsecond precision normalised
    // to UTC, NULL kept distinct from the empty string. The source is read
    // inside the REPEATABLE READ snapshot opened above; the target is read on
    // the connection holding the uncommitted writes, so it sees them.
    console.log("\nVerifying by content...");
    let compared = 0;
    let columnsCompared = 0;
    const mismatches: string[] = [];

    for (const move of MOVES) {
      const comparison = await compareTable({
        source,
        sourceSchema: "bas",
        sourceTable: move.source,
        target,
        targetSchema: "public",
        targetTable: move.target,
        keyColumns: move.verifyKey,
        columns: move.columns,
      });

      compared += 1;
      columnsCompared += comparison.source.columnsCompared.length;

      if (!comparison.match) {
        mismatches.push(
          `${move.target}: source ${comparison.source.rows} rows / ` +
            `${comparison.source.checksum}, target ${comparison.target.rows} rows / ` +
            `${comparison.target.checksum}` +
            (comparison.schemaDifferences.length > 0
              ? `\n      schema: ${comparison.schemaDifferences.join("; ")}`
              : ""),
        );

        // Name the rows and the columns, not just the hashes. An operator who
        // has to diff two databases by hand to find out what went wrong will
        // not do it.
        const from = await rowHashes(source, "bas", move.source, move.verifyKey, move.columns);
        const to = await rowHashes(target, "public", move.target, move.verifyKey, move.columns);
        const differing = [...from.keys()].filter((k) => to.has(k) && to.get(k) !== from.get(k));

        for (const key of differing.slice(0, 3)) {
          const a = await rowValues(source, "bas", move.source, move.verifyKey, key, move.columns);
          const b = await rowValues(target, "public", move.target, move.verifyKey, key, move.columns);
          const columns = move.columns.filter((c) => a[c] !== b[c]);
          mismatches.push(
            `      ${move.verifyKey.join("/")}=${key}: ` +
              columns
                .map(
                  (c) =>
                    `${c} ${JSON.stringify(a[c] ?? null)} != ${JSON.stringify(b[c] ?? null)}`,
                )
                .join(", "),
          );
        }
        if (differing.length > 3) {
          mismatches.push(`      ... and ${differing.length - 3} more differing row(s)`);
        }
      }
    }

    // The check that makes the other checks trustworthy. If the loop above ever
    // throws partway, or the table list is edited down, this refuses to pass
    // rather than reporting success on a partial comparison.
    if (compared !== MOVES.length) {
      await target.query("ROLLBACK");
      throw new Error(
        `INCONCLUSIVE: compared ${compared} of ${MOVES.length} tables. Rolled back. ` +
          "A verification that checked fewer tables than it should must not pass.",
      );
    }

    // The same rule one level down, which is what makes the checksums mean
    // something. md5 over zero columns is a stable value that matches on both
    // sides forever, so a comparison that quietly narrowed its column list would
    // pass. Compared against the expected total rather than against zero: a
    // comparison that dropped ONE column would also pass a >0 check.
    if (columnsCompared !== expectedColumns) {
      await target.query("ROLLBACK");
      throw new Error(
        `INCONCLUSIVE: compared ${columnsCompared} of ${expectedColumns} columns ` +
          "across the twelve tables. Rolled back. A checksum over fewer columns " +
          "than it should have covered must not pass.",
      );
    }

    if (mismatches.length > 0) {
      await target.query("ROLLBACK");
      throw new Error(
        `Content does not match. Rolled back. Nothing was written.\n  ${mismatches.join("\n  ")}`,
      );
    }

    // roll_horizon_s is not copied, so no checksum covers it - it is computed on
    // the target by the bas_points_roll_horizon trigger. A trigger that stopped
    // firing would be invisible above, and roll_horizon_s is what every
    // data-loss warning in this module is computed from.
    const horizon = await target.query<{ wrong: string }>(
      `SELECT count(*)::text AS wrong FROM bas_points
        WHERE capacity IS NOT NULL AND collection_interval_s IS NOT NULL
          AND roll_horizon_s IS DISTINCT FROM capacity * collection_interval_s`,
    );
    const wrongHorizons = horizon.rows[0]?.wrong;
    if (wrongHorizons === undefined || Number(wrongHorizons) !== 0) {
      await target.query("ROLLBACK");
      throw new Error(
        `roll_horizon_s check ${wrongHorizons === undefined ? "returned nothing" : `failed on ${wrongHorizons} point(s)`}. Rolled back. ` +
          "The bas_points_roll_horizon trigger from the add_bas_tables migration " +
          "is probably missing.",
      );
    }

    await target.query("COMMIT");
    console.log(
      `\n${compared}/${MOVES.length} tables and ${columnsCompared}/${expectedColumns} ` +
        `columns compared by content, ${rowsWritten} rows written, ` +
        "roll_horizon_s recomputed. IMPORT VERIFIED.",
    );
  } catch (error) {
    await target.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
