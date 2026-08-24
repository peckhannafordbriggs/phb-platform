import path from "node:path";
import { config as loadEnv } from "dotenv";
import { Client } from "pg";

/**
 * Compares the Collection Health screen against Grafana, number by number.
 *
 * `docs/08-bas-and-niagara.md` makes Grafana the oracle for B3 and B4: it reads
 * the same data and its queries have already been run against it. This runs the
 * dashboard's own SQL - copied out of
 * `C:\dev\bas-grafana\dashboards\bas-collection-health.json`, unmodified except
 * for the schema prefix - against the same database the screen reads, and prints
 * both answers side by side.
 *
 *   npx tsx scripts/bas-health-oracle.ts            # the SCREEN vs Grafana's SQL
 *   npx tsx scripts/bas-health-oracle.ts --source   # platform db vs standalone db
 *
 * The default run is the one that answers B3's acceptance criterion: it calls
 * `getCollectionHealth` - the real service the route calls - and compares what
 * it returns against Grafana's SQL executed on the same database, in the same
 * moment. Any difference is the screen being wrong.
 *
 * Read-only on every connection it opens. It is a verification tool, not part of
 * the application, and nothing in the app imports it.
 *
 * The `--source` pass exists because Grafana is pointed at the STANDALONE `bas`
 * database (`bas.v_collection_health`), not at the platform's `public.bas_v_*`.
 * The two were verified byte-identical by `npm run bas:verify`, but the
 * standalone collector keeps running, so a difference there is drift and is
 * reported as such rather than as a failure.
 */

loadEnv({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });
loadEnv({ path: path.resolve(process.cwd(), ".env"), quiet: true });

/** Grafana's `$site` is "All" here - one building - so the filter is a no-op. */
const PANELS = [
  {
    id: 1,
    title: "Active points",
    sql: (v: string) => `SELECT count(*)::text AS v FROM ${v} WHERE is_active`,
  },
  {
    id: 2,
    title: "Total readings",
    sql: (_v: string, t: (n: string) => string) =>
      `SELECT count(*)::text AS v FROM ${t("reading")} r
         JOIN ${t("point")} p USING (point_id)
         JOIN ${t("station")} st USING (station_id)`,
  },
  {
    id: 3,
    title: "Unclassified points",
    sql: (v: string) =>
      `SELECT count(*)::text AS v FROM ${v} WHERE is_active AND point_role IS NULL`,
  },
  {
    id: 4,
    title: "Points at risk of data loss",
    sql: (v: string) =>
      `SELECT count(*)::text AS v FROM ${v}
        WHERE is_active
          AND roll_risk IN ('data_lost','at_risk','roll_horizon_unknown','never_collected')`,
  },
  {
    id: 5,
    title: "Minutes since newest reading",
    sql: (_v: string, t: (n: string) => string) =>
      `SELECT round(EXTRACT(EPOCH FROM (now() - max(r.ts))) / 60)::text AS v
         FROM ${t("reading")} r
         JOIN ${t("point")} p USING (point_id)
         JOIN ${t("station")} st USING (station_id)`,
  },
  {
    id: 6,
    title: "Per-point rows",
    sql: (v: string) => `SELECT count(*)::text AS v FROM ${v} WHERE is_active`,
  },
  {
    id: 7,
    title: "Records written per run, last 7 days (bars)",
    sql: (_v: string, t: (n: string) => string) =>
      `SELECT count(*)::text AS v FROM ${t("ingest_run")} ir
         LEFT JOIN ${t("station")} st USING (station_id)
        WHERE ir.started_at >= now() - interval '7 days'`,
  },
  {
    id: 7.1,
    title: "  ...their total records written",
    sql: (_v: string, t: (n: string) => string) =>
      `SELECT COALESCE(sum(ir.records_written), 0)::text AS v
         FROM ${t("ingest_run")} ir
         LEFT JOIN ${t("station")} st USING (station_id)
        WHERE ir.started_at >= now() - interval '7 days'`,
  },
  {
    id: 8,
    title: "Recent collector runs (LIMIT 30)",
    sql: (_v: string, t: (n: string) => string) =>
      `SELECT count(*)::text AS v FROM (
         SELECT ir.run_id FROM ${t("ingest_run")} ir
           LEFT JOIN ${t("station")} st USING (station_id)
          ORDER BY ir.started_at DESC LIMIT 30) x`,
  },
  {
    id: 8.1,
    title: "  ...newest run started",
    sql: (_v: string, t: (n: string) => string) =>
      `SELECT max(ir.started_at)::text AS v FROM ${t("ingest_run")} ir`,
  },
  {
    id: 9,
    title: "Recorded data gaps",
    sql: (v: string, t: (n: string) => string) =>
      `SELECT count(*)::text AS v FROM ${t("data_gap")} g
         JOIN ${t("point")} p USING (point_id)
         JOIN ${v} h USING (point_id)`,
  },
  {
    id: 9.1,
    title: "  ...of which roll_overwrite",
    sql: (_v: string, t: (n: string) => string) =>
      `SELECT count(*)::text AS v FROM ${t("data_gap")} g
        WHERE g.cause = 'roll_overwrite'`,
  },
];

/** The per-point table, whole, so the columns are compared and not just a count. */
const PER_POINT = (v: string) => `
  SELECT point_name || ' | ' || COALESCE(point_role, '-') || ' | '
       || COALESCE(unit, '-') || ' | ' || roll_risk || ' | '
       || COALESCE(last_record_ts AT TIME ZONE 'UTC' || '', '-') || ' | '
       || COALESCE(round(seconds_since_last_record / 60.0)::text, '-') || ' | '
       || COALESCE(round((roll_horizon_s / 3600.0)::numeric, 2)::text, '-') AS v
    FROM ${v}
   WHERE is_active
   ORDER BY seconds_since_last_record DESC NULLS FIRST`;

interface Target {
  label: string;
  url: string;
  /** `bas_v_collection_health` here, `bas.v_collection_health` there. */
  view: string;
  table: (name: string) => string;
}

async function run(target: Target): Promise<Map<string, string>> {
  const client = new Client({ connectionString: target.url });
  await client.connect();
  // Same pin the application uses, so the two sides render timestamps alike.
  await client.query("SET TIME ZONE 'UTC'");
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

  const answers = new Map<string, string>();
  try {
    for (const panel of PANELS) {
      const { rows } = await client.query<{ v: string | null }>(
        panel.sql(target.view, target.table),
      );
      answers.set(`${panel.id} ${panel.title}`, rows[0]?.v ?? "(null)");
    }

    const { rows } = await client.query<{ v: string }>(PER_POINT(target.view));
    rows.forEach((row, i) => answers.set(`P${i + 1}`, row.v));
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }

  return answers;
}

/**
 * Timestamps are compared at millisecond resolution on both sides.
 *
 * NOT a fudge, and worth being precise about, because the runbook records a case
 * where exactly this truncation WAS a corruption. The screen carries a
 * `timestamptz` to the browser as a JavaScript `Date`, which holds milliseconds,
 * so `12:35:45.386223+00` arrives as `12:35:45.386+00`. In
 * `scripts/bas-import.ts` that mattered enormously - it was writing the value
 * back and losing the microseconds permanently, which is why that script reads
 * every lossy type as raw text. Here nothing is written, the screen renders to
 * the minute, and the alternative would be shipping strings the browser cannot
 * parse. The comparison is done at the resolution the screen actually claims.
 */
function toMillisecondResolution(value: string): string {
  return value.replace(
    /(\d{2}:\d{2}:\d{2}\.\d{3})\d+/g,
    (_match, kept: string) => kept,
  );
}

function report(
  left: Map<string, string>,
  leftLabel: string,
  right: Map<string, string>,
  rightLabel: string,
): number {
  const keys = [...new Set([...left.keys(), ...right.keys()])];
  const width = Math.max(...keys.map((k) => k.length));
  let mismatches = 0;

  console.log(`\n${leftLabel}  vs  ${rightLabel}\n`);
  for (const key of keys) {
    const a = left.get(key) ?? "(absent)";
    const b = right.get(key) ?? "(absent)";
    const same = toMillisecondResolution(a) === toMillisecondResolution(b);
    if (!same) mismatches += 1;
    console.log(
      `${same ? "  OK " : "DIFF "} ${key.padEnd(width)}  ${a}${same ? "" : `   !=   ${b}`}`,
    );
  }

  return mismatches;
}

/** What the screen itself answers, reduced to the same shape as the panels. */
async function screenAnswers(): Promise<Map<string, string>> {
  // Imported lazily: loading the service pulls in the Prisma client, which
  // insists on DATABASE_URL, and dotenv has to have run first.
  const { getCollectionHealth } = await import("../lib/modules/bas/service");

  const health = await getCollectionHealth({
    id: "bas-health-oracle",
    email: "oracle@localhost",
    firstName: "Oracle",
    lastName: "Script",
    profileCompleted: true,
    isPlatformAdmin: false,
  });

  const answers = new Map<string, string>();
  answers.set("1 Active points", String(health.totals.activePoints));
  answers.set("2 Total readings", String(health.totals.totalReadings));
  answers.set("3 Unclassified points", String(health.totals.unclassifiedPoints));
  answers.set("4 Points at risk of data loss", String(health.totals.pointsAtRisk));
  answers.set(
    "5 Minutes since newest reading",
    health.totals.minutesSinceNewestReading === null
      ? "(null)"
      : String(Math.round(health.totals.minutesSinceNewestReading)),
  );
  answers.set("6 Per-point rows", String(health.points.length));
  answers.set(
    "7 Records written per run, last 7 days (bars)",
    String(health.runRecords.length),
  );
  answers.set(
    "7.1   ...their total records written",
    String(health.runRecords.reduce((sum, r) => sum + r.recordsWritten, 0)),
  );
  answers.set("8 Recent collector runs (LIMIT 30)", String(health.runs.length));
  answers.set(
    "8.1   ...newest run started",
    health.runs[0] === undefined
      ? "(null)"
      : new Date(health.runs[0].startedAt)
          .toISOString()
          .replace("T", " ")
          .replace("Z", "+00"),
  );
  answers.set("9 Recorded data gaps", String(health.dataGaps.length));
  answers.set(
    "9.1   ...of which roll_overwrite",
    String(health.dataGaps.filter((g) => g.cause === "roll_overwrite").length),
  );

  health.points.forEach((point, i) => {
    answers.set(
      `P${i + 1}`,
      [
        point.pointName,
        point.pointRole ?? "-",
        point.unit ?? "-",
        point.risk,
        point.lastReadingAt === null
          ? "-"
          : point.lastReadingAt.replace("T", " ").replace("Z", ""),
        point.minutesAgo === null ? "-" : String(point.minutesAgo),
        point.rollHorizonHours === null
          ? "-"
          : point.rollHorizonHours.toFixed(2),
      ].join(" | "),
    );
  });

  return answers;
}

async function main(): Promise<void> {
  const platformUrl = process.env.DATABASE_URL;
  if (platformUrl === undefined || platformUrl.trim().length === 0) {
    throw new Error("DATABASE_URL is not set.");
  }

  // The standalone database calls these bas.reading, bas.point and so on; the
  // platform calls them public.bas_readings, public.bas_points. That rename is
  // the ONLY edit made to any Grafana query in this file.
  const PLATFORM_TABLES: Record<string, string> = {
    reading: "bas_readings",
    point: "bas_points",
    station: "bas_stations",
    ingest_run: "bas_ingest_runs",
    data_gap: "bas_data_gaps",
  };

  const platform: Target = {
    label: "platform public.bas_*",
    url: platformUrl,
    view: "bas_v_collection_health",
    table: (name) => PLATFORM_TABLES[name] ?? `bas_${name}`,
  };

  if (process.argv.includes("--source")) {
    const sourceUrl =
      process.env.BAS_SOURCE_DATABASE_URL ??
      "postgresql://bas_readonly:bas_readonly_local@localhost:5432/bas";

    const source: Target = {
      label: "standalone bas.* (what Grafana reads)",
      url: sourceUrl,
      view: "bas.v_collection_health",
      table: (name) => `bas.${name}`,
    };

    const mismatches = report(
      await run(platform),
      "platform public.bas_*",
      await run(source),
      "standalone bas.* (Grafana's datasource)",
    );

    console.log(
      mismatches === 0
        ? "\nEvery panel agrees.\n"
        : `\n${mismatches} panel(s) differ. The standalone collector keeps running ` +
            "after an import, so check whether the difference is drift before " +
            "calling it a defect.\n",
    );
    return;
  }

  // The screen first, then the panels - the smaller window between the two
  // reads, the less chance a collector run lands in the middle of the
  // comparison and reports itself as a defect.
  const screen = await screenAnswers();
  const panels = await run(platform);

  const mismatches = report(
    screen,
    "the Collection Health screen",
    panels,
    "Grafana's panel SQL, same database",
  );

  if (mismatches > 0) process.exitCode = 1;
  console.log(
    mismatches === 0
      ? "\nEvery number matches the Grafana panel.\n"
      : `\n${mismatches} number(s) disagree with Grafana. Grafana's queries are ` +
          "already validated, so the screen is wrong.\n",
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
