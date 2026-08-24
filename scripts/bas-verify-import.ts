import path from "node:path";
import { config as loadEnv } from "dotenv";
import { Client } from "pg";
import { MOVES } from "./bas-tables";
import {
  columnTypes,
  compareTable,
  rowHashes,
  rowValues,
  type TableComparison,
} from "./bas-checksum";

/**
 * Compares the standalone BAS database against the platform's bas_* tables by
 * CONTENT, and writes nothing to either.
 *
 *   BAS_SOURCE_DATABASE_URL=... npx tsx scripts/bas-verify-import.ts
 *   npx tsx scripts/bas-verify-import.ts --examples 20
 *
 * scripts/bas-import.ts verifies itself before committing. This is the same
 * comparison run after the fact, against an import that already happened - which
 * is the only way to check one that was verified by row count alone. Run it
 * while the standalone database still exists. Once that box is gone there is
 * nothing to compare against, and bas_readings beyond the JACE's ~42-hour roll
 * horizon is the only copy of that data in existence.
 *
 * THE SOURCE IS LIVE. The standalone collector keeps writing to it, so the
 * source legitimately has rows the target does not - everything collected since
 * the import ran. That is why a mismatch is classified rather than just
 * reported: rows present on both sides with different content are corruption,
 * rows only in the source are almost always growth, and rows only in the target
 * should not exist at all.
 */

loadEnv({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });
loadEnv({ path: path.resolve(process.cwd(), ".env"), quiet: true });

const EXAMPLES = (() => {
  const index = process.argv.indexOf("--examples");
  if (index === -1) return 5;
  const parsed = Number.parseInt(process.argv[index + 1] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
})();

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is not set.`);
  }
  return value;
}

/** Host and database only. A connection string carries a password. */
function describe(connectionString: string): string {
  const url = new URL(connectionString);
  return `${url.host}${url.pathname}`;
}

interface Classified {
  corrupted: string[];
  sourceOnly: string[];
  targetOnly: string[];
}

/** Splits a mismatch into the three things it can actually mean. */
async function classify(
  source: Client,
  target: Client,
  move: (typeof MOVES)[number],
): Promise<Classified> {
  const from = await rowHashes(source, "bas", move.source, move.verifyKey, move.columns);
  const to = await rowHashes(target, "public", move.target, move.verifyKey, move.columns);

  const corrupted: string[] = [];
  const sourceOnly: string[] = [];
  const targetOnly: string[] = [];

  for (const [key, hash] of from) {
    const other = to.get(key);
    if (other === undefined) sourceOnly.push(key);
    else if (other !== hash) corrupted.push(key);
  }
  for (const key of to.keys()) {
    if (!from.has(key)) targetOnly.push(key);
  }

  corrupted.sort();
  sourceOnly.sort();
  targetOnly.sort();
  return { corrupted, sourceOnly, targetOnly };
}

/** The columns that differ for one key, with both values. */
async function columnDiff(
  source: Client,
  target: Client,
  move: (typeof MOVES)[number],
  key: string,
): Promise<string[]> {
  const from = await rowValues(source, "bas", move.source, move.verifyKey, key, move.columns);
  const to = await rowValues(target, "public", move.target, move.verifyKey, key, move.columns);

  const differences: string[] = [];
  for (const column of move.columns) {
    const a = from[column];
    const b = to[column];
    if (a !== b) {
      differences.push(
        `${column}: source ${a === null ? "NULL" : JSON.stringify(a)} ` +
          `!= target ${b === null ? "NULL" : JSON.stringify(b)}`,
      );
    }
  }
  return differences;
}

async function main(): Promise<void> {
  const sourceUrl = requireEnv("BAS_SOURCE_DATABASE_URL");
  const targetUrl = requireEnv("DATABASE_URL");

  if (sourceUrl === targetUrl) {
    throw new Error("BAS_SOURCE_DATABASE_URL and DATABASE_URL are the same database.");
  }

  console.log(`Source  ${describe(sourceUrl)}  (schema bas, read-only)`);
  console.log(`Target  ${describe(targetUrl)}  (bas_* tables)`);
  console.log("Mode    CONTENT COMPARISON - nothing is written to either side\n");

  const source = new Client({ connectionString: sourceUrl });
  const target = new Client({ connectionString: targetUrl });
  await source.connect();
  await target.connect();

  try {
    // One snapshot per side. Without this the source can grow between the
    // checksum and the row-hash pass, and the classification below would blame
    // a collector write on the import.
    await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await target.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

    const collations = await Promise.all(
      [source, target].map((client) =>
        client.query<{ collate: string }>(
          "SELECT datcollate AS collate FROM pg_database WHERE datname = current_database()",
        ),
      ),
    );
    console.log(
      `Collation  source ${collations[0]?.rows[0]?.collate}  ` +
        `target ${collations[1]?.rows[0]?.collate}` +
        (collations[0]?.rows[0]?.collate === collations[1]?.rows[0]?.collate
          ? ""
          : "   (differ - ordering is forced to COLLATE \"C\", so this is fine)"),
    );
    console.log();

    const results: Array<{ move: (typeof MOVES)[number]; comparison: TableComparison }> = [];
    let compared = 0;

    console.log(
      "table                       rows src   rows tgt  cols  content",
    );
    for (const move of MOVES) {
      const comparison = await compareTable({
        source,
        sourceSchema: "bas",
        sourceTable: move.source,
        target,
        targetSchema: "public",
        targetTable: move.target,
        keyColumns: move.verifyKey,
        // Exactly the columns the import copies. Comparing "every column" would
        // flag bas_points.roll_horizon_s, which the target computes and the
        // source does not have.
        columns: move.columns,
      });
      compared += 1;
      results.push({ move, comparison });

      console.log(
        `${move.target.padEnd(24)} ${String(comparison.source.rows).padStart(9)} ` +
          `${String(comparison.target.rows).padStart(10)} ` +
          `${String(comparison.source.columnsCompared.length).padStart(5)}  ` +
          (comparison.match ? "match" : "DIFFERS"),
      );
    }

    // The same check bas-import.ts makes, for the same reason: a comparison that
    // covered fewer tables than it should must not report success.
    if (compared !== MOVES.length) {
      throw new Error(
        `INCONCLUSIVE: compared ${compared} of ${MOVES.length} tables. ` +
          "A verification that checked fewer tables than it should must not pass.",
      );
    }

    // Columns the target has and the comparison therefore did not look at. Named
    // rather than left implicit: an uncompared column is a gap, even a
    // deliberate one.
    console.log("\nColumns present in the target and NOT compared:");
    let uncompared = 0;
    for (const move of MOVES) {
      const targetColumns = await columnTypes(target, "public", move.target);
      const extra = targetColumns
        .map((c) => c.name)
        .filter((name) => !move.columns.includes(name));
      if (extra.length > 0) {
        console.log(`  ${move.target}: ${extra.join(", ")}`);
        uncompared += extra.length;
      }
    }
    if (uncompared === 0) console.log("  none");

    const failed = results.filter((r) => !r.comparison.match);

    if (failed.length === 0) {
      console.log(
        `\n${compared}/${MOVES.length} tables compared by content. ` +
          "Every table matches. CONTENT VERIFIED.",
      );
      return;
    }

    console.log(`\n${failed.length} table(s) differ. Detail:\n`);

    let corruptedTotal = 0;
    for (const { move, comparison } of failed) {
      console.log(`--- ${move.target}`);
      if (comparison.schemaDifferences.length > 0) {
        console.log("  schema:");
        for (const difference of comparison.schemaDifferences) {
          console.log(`    ${difference}`);
        }
      }
      console.log(
        `  source ${comparison.source.rows} rows / ${comparison.source.checksum}`,
      );
      console.log(
        `  target ${comparison.target.rows} rows / ${comparison.target.checksum}`,
      );

      const { corrupted, sourceOnly, targetOnly } = await classify(source, target, move);
      corruptedTotal += corrupted.length;

      console.log(
        `  present on both sides but DIFFERENT: ${corrupted.length}` +
          `   only in source: ${sourceOnly.length}` +
          `   only in target: ${targetOnly.length}`,
      );

      if (sourceOnly.length > 0) {
        console.log(
          `  only in source (the collector kept running; not an import fault):`,
        );
        for (const key of sourceOnly.slice(0, EXAMPLES)) console.log(`    ${key}`);
        if (sourceOnly.length > EXAMPLES) {
          console.log(`    ... and ${sourceOnly.length - EXAMPLES} more`);
        }
      }

      if (targetOnly.length > 0) {
        console.log(`  ONLY IN TARGET - these should not exist:`);
        for (const key of targetOnly.slice(0, EXAMPLES)) console.log(`    ${key}`);
      }

      if (corrupted.length > 0) {
        console.log(`  CORRUPTED - same key, different content:`);
        for (const key of corrupted.slice(0, EXAMPLES)) {
          const differences = await columnDiff(source, target, move, key);
          console.log(`    ${key}`);
          for (const difference of differences) console.log(`      ${difference}`);
        }
        if (corrupted.length > EXAMPLES) {
          console.log(`    ... and ${corrupted.length - EXAMPLES} more`);
        }
      }
      console.log();
    }

    if (corruptedTotal > 0) {
      throw new Error(
        `CONTENT MISMATCH: ${corruptedTotal} row(s) exist on both sides with ` +
          "different content. The import did not copy this data faithfully. Row " +
          "counts would not have shown this.",
      );
    }

    console.log(
      "No row present on both sides differs. Every difference is a row the " +
        "source has and the target does not, which is the live collector.",
    );
  } finally {
    await source.query("ROLLBACK").catch(() => undefined);
    await target.query("ROLLBACK").catch(() => undefined);
    await source.end();
    await target.end();
  }
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
