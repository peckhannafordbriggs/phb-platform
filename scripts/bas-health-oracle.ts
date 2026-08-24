import path from "node:path";
import { config as loadEnv } from "dotenv";
import { Client } from "pg";

/**
 * Compares the Collection Health screen against Grafana, number by number.
 *
 * `docs/08-bas-and-niagara.md` makes Grafana the oracle for B3 and B4: it reads
 * the same data and its queries have already been run against it. This runs the
 * dashboard's own SQL - copied out of
 * `C:\dev\bas-grafana\dashboards\bas-collection-health.json` - against the same
 * database the screen reads, and prints both answers side by side.
 *
 *   npm run bas:oracle                    # the screen vs Grafana's SQL, 7 days
 *   npm run bas:oracle -- --days 30       # a different window
 *   npm run bas:oracle -- --site 5        # one building
 *   npm run bas:oracle -- --source        # platform db vs standalone db
 *
 * The default run answers B3's acceptance criterion: it calls
 * `getCollectionHealth` - the real service the route calls - and compares what
 * it returns against Grafana's SQL executed on the same database, in the same
 * moment, for the same window and the same building. Any difference is the
 * screen being wrong. Exit code 1 on any disagreement.
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

/**
 * How a query names things on one side of the comparison.
 *
 * The standalone database calls these `bas.reading` and
 * `bas.v_collection_health`; the platform calls them `public.bas_readings` and
 * `public.bas_v_collection_health`. That rename is the ONLY edit made to any
 * Grafana query below, apart from panel 8, which says why in its own comment.
 */
interface Ctx {
  view: string;
  table: (name: string) => string;
  windowDays: number;
  /** Grafana's `$site` variable, as a SQL fragment. `TRUE` for "All". */
  site: (column: string) => string;
}

interface Panel {
  id: string;
  title: string;
  sql: (c: Ctx) => string;
}

const PANELS: Panel[] = [
  {
    id: "1",
    title: "Active points",
    sql: (c) =>
      `SELECT count(*)::text AS v FROM ${c.view}
        WHERE is_active AND ${c.site("site_id")}`,
  },
  {
    id: "2",
    title: "Total readings",
    sql: (c) =>
      `SELECT count(*)::text AS v FROM ${c.table("reading")} r
         JOIN ${c.table("point")} p USING (point_id)
         JOIN ${c.table("station")} st USING (station_id)
        WHERE ${c.site("st.site_id")}`,
  },
  {
    id: "3",
    title: "Unclassified points",
    sql: (c) =>
      `SELECT count(*)::text AS v FROM ${c.view}
        WHERE is_active AND point_role IS NULL AND ${c.site("site_id")}`,
  },
  {
    id: "4",
    title: "Points at risk of data loss",
    sql: (c) =>
      `SELECT count(*)::text AS v FROM ${c.view}
        WHERE is_active AND ${c.site("site_id")}
          AND roll_risk IN ('data_lost','at_risk','roll_horizon_unknown','never_collected')`,
  },
  {
    id: "5",
    title: "Minutes since newest reading",
    sql: (c) =>
      `SELECT round(EXTRACT(EPOCH FROM (now() - max(r.ts))) / 60)::text AS v
         FROM ${c.table("reading")} r
         JOIN ${c.table("point")} p USING (point_id)
         JOIN ${c.table("station")} st USING (station_id)
        WHERE ${c.site("st.site_id")}`,
  },
  {
    id: "6",
    title: "Per-point rows",
    sql: (c) =>
      `SELECT count(*)::text AS v FROM ${c.view}
        WHERE is_active AND ${c.site("site_id")}`,
  },
  {
    id: "7",
    title: "Records written per run, in window (bars)",
    sql: (c) =>
      `SELECT count(*)::text AS v FROM ${c.table("ingest_run")} ir
         LEFT JOIN ${c.table("station")} st USING (station_id)
        WHERE ir.started_at >= now() - make_interval(days => ${c.windowDays})
          AND (${c.site("st.site_id")} OR st.site_id IS NULL)`,
  },
  {
    id: "7.1",
    title: "  ...their total records written",
    sql: (c) =>
      `SELECT COALESCE(sum(ir.records_written), 0)::text AS v
         FROM ${c.table("ingest_run")} ir
         LEFT JOIN ${c.table("station")} st USING (station_id)
        WHERE ir.started_at >= now() - make_interval(days => ${c.windowDays})
          AND (${c.site("st.site_id")} OR st.site_id IS NULL)`,
  },
  {
    id: "8",
    title: "Recent collector runs (window, LIMIT 30)",
    /**
     * The one panel this file does not reproduce literally, and the divergence
     * is deliberate.
     *
     * Grafana's panel 8 carries no `$__timeFilter`, so with a 24-hour range
     * selected on the dashboard it still lists runs from last week. That is a
     * wart rather than a decision: the run list and the run chart sit side by
     * side and would disagree about which runs exist. The platform windows both,
     * so the window is applied here too - this compares the screen against what
     * the query MEANS, not against a known bug in it.
     *
     * Removing the window clause would make this panel report a difference on
     * every run, real and expected, which is exactly the kind of noise that
     * teaches people to ignore a verification tool.
     */
    sql: (c) =>
      `SELECT count(*)::text AS v FROM (
         SELECT ir.run_id FROM ${c.table("ingest_run")} ir
           LEFT JOIN ${c.table("station")} st USING (station_id)
          WHERE ir.started_at >= now() - make_interval(days => ${c.windowDays})
            AND (${c.site("st.site_id")} OR st.site_id IS NULL)
          ORDER BY ir.started_at DESC LIMIT 30) x`,
  },
  {
    id: "8.1",
    title: "  ...newest run started, ignoring the window",
    sql: (c) =>
      `SELECT max(ir.started_at)::text AS v
         FROM ${c.table("ingest_run")} ir
         LEFT JOIN ${c.table("station")} st USING (station_id)
        WHERE (${c.site("st.site_id")} OR st.site_id IS NULL)`,
  },
  {
    id: "9",
    title: "Recorded data gaps",
    sql: (c) =>
      `SELECT count(*)::text AS v FROM ${c.table("data_gap")} g
         JOIN ${c.table("point")} p USING (point_id)
         JOIN ${c.view} h USING (point_id)
        WHERE ${c.site("h.site_id")}`,
  },
  {
    id: "9.1",
    title: "  ...of which roll_overwrite",
    sql: (c) =>
      `SELECT count(*)::text AS v FROM ${c.table("data_gap")} g
         JOIN ${c.view} h USING (point_id)
        WHERE g.cause = 'roll_overwrite' AND ${c.site("h.site_id")}`,
  },
  {
    id: "S",
    title: "Buildings offered by the filter",
    /**
     * Grafana's `$site` template variable query. Deliberately NOT scoped by the
     * current selection on either side: it is the dropdown's option list, and a
     * dropdown that narrowed to its own selection could not be used to pick
     * again.
     */
    sql: (c) =>
      `SELECT string_agg(name, ', ' ORDER BY name)::text AS v
         FROM ${c.table("site")}`,
  },
];

/** The per-point table, whole, so the columns are compared and not just a count. */
const PER_POINT = (c: Ctx) => `
  SELECT point_name || ' | ' || COALESCE(point_role, '-') || ' | '
       || COALESCE(unit, '-') || ' | ' || roll_risk || ' | '
       || COALESCE(last_record_ts AT TIME ZONE 'UTC' || '', '-') || ' | '
       || COALESCE(round(seconds_since_last_record / 60.0)::text, '-') || ' | '
       || COALESCE(round((roll_horizon_s / 3600.0)::numeric, 2)::text, '-') AS v
    FROM ${c.view}
   WHERE is_active AND ${c.site("site_id")}
   -- Same tie-break as the service. Without it both sides sort tied rows
   -- arbitrarily and this comparison reports a difference that is only ever
   -- PostgreSQL returning equal rows in a different order.
   ORDER BY seconds_since_last_record DESC NULLS FIRST, point_name, point_id`;

const PLATFORM_TABLES: Record<string, string> = {
  reading: "bas_readings",
  point: "bas_points",
  station: "bas_stations",
  site: "bas_sites",
  ingest_run: "bas_ingest_runs",
  data_gap: "bas_data_gaps",
};

interface Options {
  windowDays: number;
  /** Digits only, already validated. `null` is Grafana's "All". */
  siteId: string | null;
}

function contextFor(side: "platform" | "source", options: Options): Ctx {
  const site = (column: string) =>
    options.siteId === null ? "TRUE" : `${column} = ${options.siteId}`;

  return side === "platform"
    ? {
        view: "bas_v_collection_health",
        table: (name) => PLATFORM_TABLES[name] ?? `bas_${name}`,
        windowDays: options.windowDays,
        site,
      }
    : {
        view: "bas.v_collection_health",
        table: (name) => `bas.${name}`,
        windowDays: options.windowDays,
        site,
      };
}

async function run(
  connectionString: string,
  ctx: Ctx,
): Promise<Map<string, string>> {
  const client = new Client({ connectionString });
  await client.connect();
  // The same pin the application uses, so the two sides render timestamps alike.
  await client.query("SET TIME ZONE 'UTC'");
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

  const answers = new Map<string, string>();
  try {
    for (const panel of PANELS) {
      const { rows } = await client.query<{ v: string | null }>(panel.sql(ctx));
      answers.set(`${panel.id} ${panel.title}`, rows[0]?.v ?? "(null)");
    }

    const { rows } = await client.query<{ v: string }>(PER_POINT(ctx));
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
async function screenAnswers(options: Options): Promise<Map<string, string>> {
  // Imported lazily: loading the service pulls in the Prisma client, which
  // insists on DATABASE_URL, and dotenv has to have run first.
  const { getCollectionHealth } = await import("../lib/modules/bas/service");

  const health = await getCollectionHealth(
    {
      id: "bas-health-oracle",
      email: "oracle@localhost",
      firstName: "Oracle",
      lastName: "Script",
      profileCompleted: true,
      isPlatformAdmin: false,
    },
    {
      windowDays: options.windowDays,
      siteId: options.siteId === null ? null : BigInt(options.siteId),
    },
  );

  const answers = new Map<string, string>();
  const titleOf = (id: string) => {
    const panel = PANELS.find((p) => p.id === id);
    if (panel === undefined) throw new Error(`No panel ${id}`);
    return `${panel.id} ${panel.title}`;
  };
  const set = (id: string, value: string) => answers.set(titleOf(id), value);

  set("1", String(health.totals.activePoints));
  set("2", String(health.totals.totalReadings));
  set("3", String(health.totals.unclassifiedPoints));
  set("4", String(health.totals.pointsAtRisk));
  set(
    "5",
    health.totals.minutesSinceNewestReading === null
      ? "(null)"
      : String(Math.round(health.totals.minutesSinceNewestReading)),
  );
  set("6", String(health.points.length));
  set("7", String(health.runRecords.length));
  set(
    "7.1",
    String(health.runRecords.reduce((sum, r) => sum + r.recordsWritten, 0)),
  );
  set("8", String(health.runs.length));
  set(
    "8.1",
    health.newestRunAt === null
      ? "(null)"
      : health.newestRunAt.replace("T", " ").replace("Z", "+00"),
  );
  set("9", String(health.dataGaps.length));
  set(
    "9.1",
    String(health.dataGaps.filter((g) => g.cause === "roll_overwrite").length),
  );
  set(
    "S",
    health.sites.length === 0
      ? "(null)"
      : health.sites
          .map((site) => site.name)
          .sort((a, b) => a.localeCompare(b))
          .join(", "),
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

function readOptions(): Options {
  const argv = process.argv;
  const flag = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? null : (argv[i + 1] ?? null);
  };

  const days = flag("days");
  const site = flag("site");

  // Both are interpolated into SQL below, so they are checked rather than
  // trusted. The application parameterises instead; this is a script and the
  // value comes from the operator's own command line, but "it is only me" is how
  // that argument always starts.
  if (site !== null && !/^[0-9]+$/.test(site)) {
    throw new Error(`--site must be a number, got ${JSON.stringify(site)}`);
  }
  if (days !== null && !/^[0-9]+$/.test(days)) {
    throw new Error(`--days must be a number, got ${JSON.stringify(days)}`);
  }

  return { windowDays: days === null ? 7 : Number(days), siteId: site };
}

async function main(): Promise<void> {
  const platformUrl = process.env.DATABASE_URL;
  if (platformUrl === undefined || platformUrl.trim().length === 0) {
    throw new Error("DATABASE_URL is not set.");
  }

  const options = readOptions();
  console.log(`window=${options.windowDays}d site=${options.siteId ?? "all"}`);

  if (process.argv.includes("--source")) {
    const sourceUrl =
      process.env.BAS_SOURCE_DATABASE_URL ??
      "postgresql://bas_readonly:bas_readonly_local@localhost:5432/bas";

    const mismatches = report(
      await run(platformUrl, contextFor("platform", options)),
      "platform public.bas_*",
      await run(sourceUrl, contextFor("source", options)),
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

  // The screen first, then the panels - the smaller the window between the two
  // reads, the less chance a collector run lands in the middle of the
  // comparison and reports itself as a defect.
  const screen = await screenAnswers(options);
  const panels = await run(platformUrl, contextFor("platform", options));

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
