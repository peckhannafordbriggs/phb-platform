import { Prisma } from "@/lib/generated/prisma/client";
import type { Viewer } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import type {
  CollectionHealth,
  DataGapRow,
  IngestRunRow,
  PointHealthRow,
  RollRisk,
  RunGap,
  RunRecordPoint,
} from "./types";

/**
 * The only thing in the platform that reads the `bas_*` tables.
 *
 * Route handlers call functions here. They never write SQL, never name a view,
 * never see a `bigint` and never see a `Date`. Every later BAS phase adds
 * functions to this file; if a caller ever needs to know a column name to use
 * one, the boundary has leaked and the fix belongs here.
 *
 * ---------------------------------------------------------------------------
 * Every function takes the employee, from day one.
 *
 * Nothing filters on it yet - one building, and everyone holding the module
 * grant sees all of it. It is a parameter anyway because docs/08 commits to
 * per-site scoping being "a change in one place rather than in every route". A
 * signature that does not take the viewer forces every call site to change on
 * the day a `bas_site_grant` table appears, and a route that forgot to pass it
 * would silently show a building the employee is not entitled to.
 *
 * `basSiteScope` below is the one place that changes.
 *
 * ---------------------------------------------------------------------------
 * Grafana is the oracle for this screen.
 *
 * Every query here is the Grafana panel's query with `bas.v_collection_health`
 * rewritten as `bas_v_collection_health` and so on - the standalone database put
 * these in a schema called `bas`, the platform puts them in `public` behind a
 * `bas_` prefix. Where a query looks odd it is odd in Grafana too, and matching
 * it is the point: those queries have been run against real data and this screen
 * has not. See docs/08, *B3*.
 */

/**
 * Which sites this employee may see.
 *
 * `null` means every site, which is the answer for everyone today. When per-site
 * scoping arrives this reads `bas_site_grant` and returns a list, `siteFilter`
 * turns it into a WHERE clause, and nothing else moves.
 */
async function basSiteScope(
  viewer: Viewer,
): Promise<{ employeeId: string; siteIds: bigint[] | null }> {
  return { employeeId: viewer.id, siteIds: null };
}

/**
 * The scope as a SQL fragment, so every query composes it the same way.
 *
 * `TRUE` rather than an empty fragment on purpose: a fragment that disappears
 * turns the surrounding `WHERE ... AND` into a syntax error, and an employee
 * entitled to no sites has to produce `FALSE` rather than the empty string that
 * would quietly show them everything.
 */
function siteFilter(siteIds: bigint[] | null, column: Prisma.Sql): Prisma.Sql {
  if (siteIds === null) return Prisma.sql`TRUE`;
  if (siteIds.length === 0) return Prisma.sql`FALSE`;
  return Prisma.sql`${column} IN (${Prisma.join(siteIds)})`;
}

/** Window bounds. The Grafana dashboard opens on `now-7d`. */
export const DEFAULT_WINDOW_DAYS = 7;
export const MIN_WINDOW_DAYS = 1;
export const MAX_WINDOW_DAYS = 90;

/** Grafana's "Recent collector runs" panel is `LIMIT 30`. */
const RECENT_RUNS_LIMIT = 30;
/** Grafana's "Recorded data gaps" panel is `LIMIT 100`. */
const DATA_GAPS_LIMIT = 100;

const RISK_VALUES: readonly RollRisk[] = [
  "ok",
  "at_risk",
  "data_lost",
  "roll_horizon_unknown",
  "never_collected",
];

/**
 * The view constrains this, but a row is data and data is not a type.
 *
 * An unrecognised value falls to `roll_horizon_unknown` rather than to `ok`. If
 * someone adds a sixth risk state to the view and forgets this list, the screen
 * must say "we cannot tell", never "fine".
 */
function toRollRisk(value: string): RollRisk {
  return (RISK_VALUES as readonly string[]).includes(value)
    ? (value as RollRisk)
    : "roll_horizon_unknown";
}

const RUN_STATUSES = ["running", "ok", "partial", "failed"] as const;

/** Same rule, same direction: an unknown status is not a successful one. */
function toRunStatus(value: string): IngestRunRow["status"] {
  return (RUN_STATUSES as readonly string[]).includes(value)
    ? (value as IngestRunRow["status"])
    : "failed";
}

/**
 * The single row an aggregate query always returns.
 *
 * `count(*)` with no GROUP BY produces exactly one row on any input, including
 * an empty table, so a missing one is not an empty database - it is a query that
 * stopped being an aggregate. Failing here is the difference between finding
 * that out and rendering a screen full of zeroes.
 */
function firstRow<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Expected exactly one ${what} row and got none.`);
  }
  return row;
}

/** timestamptz out, ISO 8601 UTC in. Display timezone is the browser's. */
function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

interface TotalsRow {
  active_points: number;
  unclassified_points: number;
  risk_ok: number;
  risk_at_risk: number;
  risk_data_lost: number;
  risk_roll_horizon_unknown: number;
  risk_never_collected: number;
  min_roll_horizon_s: number | null;
}

interface ReadingTotalsRow {
  total_readings: bigint;
  minutes_since: number | null;
}

interface PointRow {
  point_id: bigint;
  point_name: string;
  site_name: string;
  point_role: string | null;
  unit: string | null;
  roll_risk: string;
  last_record_ts: Date | null;
  minutes_ago: number | null;
  roll_horizon_hours: number | null;
}

interface RunRow {
  run_id: bigint;
  started_at: Date;
  finished_at: Date | null;
  status: string;
  points_succeeded: number;
  points_attempted: number;
  records_written: number;
  collector_host: string | null;
  error_count: number;
}

interface RunRecordRow {
  started_at: Date;
  records_written: number;
}

interface RunGapRow {
  from_at: Date;
  to_at: Date;
  gap_hours: number;
}

interface GapRow {
  gap_id: bigint;
  point_name: string;
  site_name: string;
  gap_start: Date;
  gap_end: Date;
  hours_lost: number;
  cause: string;
  notes: string | null;
}

export interface CollectionHealthOptions {
  /** Days of run history. Clamped here as well as parsed at the route. */
  windowDays?: number;
}

/**
 * Everything the Collection Health screen shows, in one round trip.
 *
 * All of it runs inside one transaction, and that is a correctness requirement
 * rather than a performance one. `now()` is the transaction's start time in
 * PostgreSQL, so the "minutes since the newest reading" tile, the per-point
 * "minutes ago" column and the `roll_risk` the view computes are all measured
 * from the same instant. Run as separate statements they drift apart, and a
 * screen whose tiles disagree with its own table is one nobody trusts the rest
 * of.
 *
 * Read-only. Nothing in this module writes to `bas_*` - the collector owns those
 * rows, and `bas_readings` cannot be re-fetched from anywhere once the station
 * has rolled past it (docs/runbook.md, *BAS irreplaceability*).
 */
export async function getCollectionHealth(
  viewer: Viewer,
  options: CollectionHealthOptions = {},
): Promise<CollectionHealth> {
  const windowDays = clampWindowDays(options.windowDays);
  const scope = await basSiteScope(viewer);
  const { siteIds } = scope;

  // bas_v_collection_health exposes site_id directly; bas_readings and
  // bas_ingest_runs reach it through bas_stations, exactly as Grafana does.
  const healthSites = siteFilter(siteIds, Prisma.sql`site_id`);
  const stationSites = siteFilter(siteIds, Prisma.sql`st.site_id`);

  const result = await prisma.$transaction(async (tx) => {
    const observedAt = firstRow(
      await tx.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`,
      "now()",
    ).now;

    // --- the five tiles -----------------------------------------------------

    // One pass over the view for four of them. Grafana runs four separate stat
    // panels; FILTER produces the same numbers and also the breakdown, so a
    // "points at risk" of 3 can say which three states it is made of.
    const totals = firstRow(
      await tx.$queryRaw<TotalsRow[]>`
        SELECT
          count(*) FILTER (WHERE is_active)::int AS active_points,
          count(*) FILTER (WHERE is_active AND point_role IS NULL)::int
            AS unclassified_points,
          count(*) FILTER (WHERE is_active AND roll_risk = 'ok')::int
            AS risk_ok,
          count(*) FILTER (WHERE is_active AND roll_risk = 'at_risk')::int
            AS risk_at_risk,
          count(*) FILTER (WHERE is_active AND roll_risk = 'data_lost')::int
            AS risk_data_lost,
          count(*) FILTER (WHERE is_active AND roll_risk = 'roll_horizon_unknown')::int
            AS risk_roll_horizon_unknown,
          count(*) FILTER (WHERE is_active AND roll_risk = 'never_collected')::int
            AS risk_never_collected,
          -- The shortest horizon among the active points we can compute one for.
          -- A silence longer than this destroyed records on the station.
          min(roll_horizon_s) FILTER (WHERE is_active)::int AS min_roll_horizon_s
        FROM bas_v_collection_health
        WHERE ${healthSites}
      `,
      "collection health totals",
    );

    // Grafana runs "Total readings" and "Minutes since newest reading" as two
    // panels over the same join. One statement, the same two numbers.
    const readingTotals = firstRow(
      await tx.$queryRaw<ReadingTotalsRow[]>`
        SELECT
          count(*)::bigint AS total_readings,
          (EXTRACT(EPOCH FROM (now() - max(r.ts))) / 60.0)::float8 AS minutes_since
        FROM bas_readings r
        JOIN bas_points p USING (point_id)
        JOIN bas_stations st USING (station_id)
        WHERE ${stationSites}
      `,
      "reading totals",
    );

    // --- per-point table ----------------------------------------------------

    const points = await tx.$queryRaw<PointRow[]>`
      SELECT
        point_id,
        point_name,
        site_name,
        point_role,
        unit,
        roll_risk,
        last_record_ts,
        round(seconds_since_last_record / 60.0)::int AS minutes_ago,
        (roll_horizon_s / 3600.0)::float8 AS roll_horizon_hours
      FROM bas_v_collection_health
      WHERE is_active AND ${healthSites}
      -- Grafana's ordering, and it is the right one: NULLS FIRST puts a point
      -- that has never been collected above one that is merely stale.
      ORDER BY seconds_since_last_record DESC NULLS FIRST
    `;

    // --- collector runs -----------------------------------------------------

    // The LEFT JOIN and the `IS NULL` arm are Grafana's, and they matter: a run
    // that failed before it identified a station has a NULL station_id, so an
    // inner join hides exactly the runs worth seeing.
    const runs = await tx.$queryRaw<RunRow[]>`
      SELECT
        ir.run_id,
        ir.started_at,
        ir.finished_at,
        ir.status,
        ir.points_succeeded,
        ir.points_attempted,
        ir.records_written,
        ir.collector_host,
        jsonb_array_length(
          CASE WHEN jsonb_typeof(ir.errors) = 'array'
               THEN ir.errors ELSE '[]'::jsonb END
        )::int AS error_count
      FROM bas_ingest_runs ir
      LEFT JOIN bas_stations st USING (station_id)
      WHERE (${stationSites} OR st.site_id IS NULL)
      ORDER BY ir.started_at DESC
      LIMIT ${RECENT_RUNS_LIMIT}
    `;

    const runRecords = await tx.$queryRaw<RunRecordRow[]>`
      SELECT ir.started_at, ir.records_written
      FROM bas_ingest_runs ir
      LEFT JOIN bas_stations st USING (station_id)
      WHERE ir.started_at >= now() - make_interval(days => ${windowDays}::int)
        AND (${stationSites} OR st.site_id IS NULL)
      ORDER BY ir.started_at
    `;

    // The longest silence between two consecutive runs in the window. Not a
    // Grafana panel - Grafana shows it as a hole in a chart, which is only
    // visible to someone already looking for one.
    // `undefined` here is legitimate and common: fewer than two runs in the
    // window means there is no interval between runs to measure.
    const runGap: RunGapRow | undefined = (
      await tx.$queryRaw<RunGapRow[]>`
        SELECT
          prev_started_at AS from_at,
          started_at      AS to_at,
          (EXTRACT(EPOCH FROM (started_at - prev_started_at)) / 3600.0)::float8
            AS gap_hours
        FROM (
          SELECT
            ir.started_at,
            lag(ir.started_at) OVER (ORDER BY ir.started_at) AS prev_started_at
          FROM bas_ingest_runs ir
          LEFT JOIN bas_stations st USING (station_id)
          WHERE ir.started_at >= now() - make_interval(days => ${windowDays}::int)
            AND (${stationSites} OR st.site_id IS NULL)
        ) windowed
        WHERE prev_started_at IS NOT NULL
        ORDER BY started_at - prev_started_at DESC
        LIMIT 1
      `
    )[0];

    // --- recorded gaps ------------------------------------------------------

    const dataGaps = await tx.$queryRaw<GapRow[]>`
      SELECT
        g.gap_id,
        h.point_name,
        h.site_name,
        g.gap_start,
        g.gap_end,
        round((EXTRACT(EPOCH FROM (g.gap_end - g.gap_start)) / 3600.0)::numeric, 1)::float8
          AS hours_lost,
        g.cause,
        g.notes
      FROM bas_data_gaps g
      JOIN bas_v_collection_health h USING (point_id)
      WHERE ${healthSites}
      ORDER BY g.gap_start DESC
      LIMIT ${DATA_GAPS_LIMIT}
    `;

    return {
      observedAt,
      totals,
      readingTotals,
      points,
      runs,
      runRecords,
      runGap,
      dataGaps,
    };
  });

  const riskCounts: Record<RollRisk, number> = {
    ok: result.totals.risk_ok,
    at_risk: result.totals.risk_at_risk,
    data_lost: result.totals.risk_data_lost,
    roll_horizon_unknown: result.totals.risk_roll_horizon_unknown,
    never_collected: result.totals.risk_never_collected,
  };

  const pointsAtRisk =
    riskCounts.data_lost +
    riskCounts.at_risk +
    riskCounts.roll_horizon_unknown +
    riskCounts.never_collected;

  const rollHorizonHours =
    result.totals.min_roll_horizon_s === null
      ? null
      : result.totals.min_roll_horizon_s / 3600;

  const longestRunGap: RunGap | null =
    result.runGap === undefined
      ? null
      : {
          fromAt: result.runGap.from_at.toISOString(),
          toAt: result.runGap.to_at.toISOString(),
          hours: result.runGap.gap_hours,
          rollHorizonHours,
          // An unknown horizon is not "safe" here either. With no horizon we
          // cannot claim the silence destroyed data - and we must not claim it
          // did not, which is why this is only ever `true` on a proven overrun
          // and the unknown itself is carried by the risk tile.
          exceedsRollHorizon:
            rollHorizonHours !== null &&
            result.runGap.gap_hours > rollHorizonHours,
        };

  const health: CollectionHealth = {
    windowDays,
    observedAt: result.observedAt.toISOString(),
    totals: {
      activePoints: result.totals.active_points,
      totalReadings: Number(result.readingTotals.total_readings),
      unclassifiedPoints: result.totals.unclassified_points,
      pointsAtRisk,
      riskCounts,
      minutesSinceNewestReading: result.readingTotals.minutes_since,
    },
    points: result.points.map(toPointHealthRow),
    runs: result.runs.map(toIngestRunRow),
    runRecords: result.runRecords.map(toRunRecordPoint),
    longestRunGap,
    dataGaps: result.dataGaps.map(toDataGapRow),
  };

  logger.info("bas.collection_health", {
    employeeId: scope.employeeId,
    moduleKey: "bas",
    count: health.totals.activePoints,
    outcome: health.totals.pointsAtRisk > 0 ? "at_risk" : "ok",
  });

  return health;
}

export function clampWindowDays(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_WINDOW_DAYS;
  }
  const whole = Math.trunc(requested);
  if (whole < MIN_WINDOW_DAYS) return MIN_WINDOW_DAYS;
  if (whole > MAX_WINDOW_DAYS) return MAX_WINDOW_DAYS;
  return whole;
}

function toPointHealthRow(row: PointRow): PointHealthRow {
  return {
    pointId: row.point_id.toString(),
    pointName: row.point_name,
    siteName: row.site_name,
    pointRole: row.point_role,
    unit: row.unit,
    risk: toRollRisk(row.roll_risk),
    lastReadingAt: iso(row.last_record_ts),
    minutesAgo: row.minutes_ago,
    rollHorizonHours: row.roll_horizon_hours,
  };
}

function toIngestRunRow(row: RunRow): IngestRunRow {
  return {
    runId: row.run_id.toString(),
    startedAt: row.started_at.toISOString(),
    finishedAt: iso(row.finished_at),
    status: toRunStatus(row.status),
    pointsSucceeded: row.points_succeeded,
    pointsAttempted: row.points_attempted,
    recordsWritten: row.records_written,
    collectorHost: row.collector_host,
    errorCount: row.error_count,
  };
}

function toRunRecordPoint(row: RunRecordRow): RunRecordPoint {
  return {
    startedAtMs: row.started_at.getTime(),
    recordsWritten: row.records_written,
  };
}

function toDataGapRow(row: GapRow): DataGapRow {
  return {
    gapId: row.gap_id.toString(),
    pointName: row.point_name,
    siteName: row.site_name,
    gapStart: row.gap_start.toISOString(),
    gapEnd: row.gap_end.toISOString(),
    hoursLost: row.hours_lost,
    cause: row.cause,
    notes: row.notes,
  };
}
