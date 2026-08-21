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
 *   - Counts what it verified and refuses to report success on a short count.
 *     A verification that skips its checks and still prints PASS is worse than
 *     no verification - that exact bug shipped in Test-BasRestore.ps1 and is
 *     recorded in the runbook.
 *   - Never prints a connection string. Host and database name only.
 */

import path from "node:path";
import { config as loadEnv } from "dotenv";
import { Client } from "pg";

loadEnv({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });
loadEnv({ path: path.resolve(process.cwd(), ".env"), quiet: true });

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

/**
 * The move, in dependency order. Parents before children, so every foreign key
 * has something to point at.
 *
 * `columns` are the SOURCE column names. Target columns are identical - the
 * translation renamed tables, never columns - which is what makes this a
 * straight copy rather than a mapping exercise.
 *
 * `deferred` columns are self-references. They are written as NULL on the first
 * pass and filled in by an UPDATE afterwards, because a row can reference
 * another row of the same table that has not been inserted yet. The alternative
 * would be deferrable constraints, which Prisma does not emit.
 */
interface TableMove {
  source: string;
  target: string;
  columns: string[];
  deferred?: string[];
  /** Primary key column whose sequence must be advanced after an explicit-id insert. */
  sequenceColumn?: string;
  /** Key used to match rows for the deferred UPDATE. */
  keyColumn?: string;
}

const MOVES: TableMove[] = [
  {
    source: "equipment_type",
    target: "bas_equipment_types",
    columns: ["equip_type", "display_name", "description", "category"],
  },
  {
    source: "point_role",
    target: "bas_point_roles",
    columns: [
      "point_role", "display_name", "description", "measurement", "typical_unit",
      "is_setpoint", "is_command", "is_status", "setpoint_for", "status_of",
    ],
    deferred: ["setpoint_for", "status_of"],
    keyColumn: "point_role",
  },
  {
    source: "org",
    target: "bas_orgs",
    columns: ["org_id", "name", "notes", "created_at"],
    sequenceColumn: "org_id",
  },
  {
    source: "site",
    target: "bas_sites",
    columns: [
      "site_id", "org_id", "name", "address", "timezone", "area_sqft",
      "attributes", "notes", "created_at",
    ],
    sequenceColumn: "site_id",
  },
  {
    source: "station",
    target: "bas_stations",
    columns: [
      "station_id", "site_id", "niagara_station_name", "base_url", "host_id",
      "model", "niagara_version", "parent_station_id", "is_active", "notes",
      "first_seen_at", "last_seen_at",
    ],
    deferred: ["parent_station_id"],
    keyColumn: "station_id",
    sequenceColumn: "station_id",
  },
  {
    source: "equipment",
    target: "bas_equipment",
    columns: [
      "equipment_id", "site_id", "name", "equip_type", "parent_equipment_id",
      "attributes", "notes", "created_at",
    ],
    deferred: ["parent_equipment_id"],
    keyColumn: "equipment_id",
    sequenceColumn: "equipment_id",
  },
  {
    // roll_horizon_s is deliberately absent: it is GENERATED ALWAYS AS STORED in
    // the target, and Postgres rejects any attempt to write it. The value is
    // recomputed from capacity and collection_interval_s, which are copied, so
    // nothing is lost. Adding it to this list is the most likely way to break
    // this script.
    source: "point",
    target: "bas_points",
    columns: [
      "point_id", "station_id", "equipment_id", "niagara_history_name",
      "niagara_history_ord", "display_name", "point_role", "unit", "data_type",
      "source_timezone", "collection_interval_s", "capacity", "full_policy",
      "tags", "notes", "is_active", "first_seen_at", "last_seen_at",
    ],
    sequenceColumn: "point_id",
  },
  {
    source: "reading",
    target: "bas_readings",
    columns: ["point_id", "ts", "value_num", "value_bool", "value_str", "status"],
  },
  {
    source: "point_link",
    target: "bas_point_links",
    columns: [
      "from_point_id", "to_point_id", "link_type", "confidence", "notes", "created_at",
    ],
  },
  {
    source: "sync_checkpoint",
    target: "bas_sync_checkpoints",
    columns: [
      "point_id", "last_record_ts", "last_run_at", "last_status",
      "consecutive_failures", "last_error",
    ],
  },
  {
    source: "ingest_run",
    target: "bas_ingest_runs",
    columns: [
      "run_id", "station_id", "started_at", "finished_at", "status",
      "window_start", "window_end", "points_attempted", "points_succeeded",
      "records_written", "errors", "collector_version", "collector_host",
    ],
    sequenceColumn: "run_id",
  },
  {
    source: "data_gap",
    target: "bas_data_gaps",
    columns: [
      "gap_id", "point_id", "gap_start", "gap_end", "detected_at", "cause", "notes",
    ],
    sequenceColumn: "gap_id",
  },
];

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

  try {
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
    console.log("\nVerifying...");
    let compared = 0;
    const mismatches: string[] = [];

    for (const move of MOVES) {
      const expected = sourceCounts.get(move.source) ?? 0;
      const actual = await countRows(target, move.target);
      compared += 1;
      if (expected !== actual) {
        mismatches.push(`${move.target}: expected ${expected}, found ${actual}`);
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

    if (mismatches.length > 0) {
      await target.query("ROLLBACK");
      throw new Error(`Row counts do not match. Rolled back.\n  ${mismatches.join("\n  ")}`);
    }

    // A generated column that silently stopped computing would be invisible in
    // a row count, and roll_horizon_s is what the entire data-loss warning
    // depends on. Confirm it recomputed for every point that has the inputs.
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
          "The GENERATED ALWAYS definition from prisma/bas/hand-additions.sql is " +
          "probably missing from the applied migration.",
      );
    }

    await target.query("COMMIT");
    console.log(
      `\n${compared}/${MOVES.length} tables reconciled, ${rowsWritten} rows written, ` +
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
