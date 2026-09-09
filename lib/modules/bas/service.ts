import { Prisma } from "@/lib/generated/prisma/client";
import type { Viewer } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { BasError } from "./errors";
import type {
  CollectionHealth,
  DataGapRow,
  IngestRunRow,
  PointExplorer,
  PointHealthRow,
  PointOption,
  RollRisk,
  RunGap,
  RunRecordPoint,
  SiteOption,
  TrendGap,
  TrendPoint,
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
 * ENTITLEMENT: which sites this employee may see at all.
 *
 * `null` means every site, which is the answer for everyone today. When per-site
 * scoping arrives this reads `bas_site_grant` and returns a list, `siteFilter`
 * turns it into a WHERE clause, and nothing else moves.
 *
 * Exported so the Settings service (B7.2) uses this exact function rather than
 * its own copy. Two entitlement functions is how one of them gets updated and
 * the other does not.
 *
 * Kept rigidly separate from SELECTION below. They look alike - both end up as a
 * list of site ids - and collapsing them is how a filter becomes an
 * authorization hole: a screen that asked for one building and got it would
 * work identically whether the employee was entitled to it or not.
 */
export async function basSiteScope(
  viewer: Viewer,
): Promise<{ employeeId: string; entitled: bigint[] | null }> {
  return { employeeId: viewer.id, entitled: null };
}

/**
 * SELECTION: what the employee asked to look at, narrowed by what they may see.
 *
 * The intersection is the whole job. `requested` arrives from a query string and
 * is never trusted on its own; the caller has already checked it against the
 * site list, which is itself built from the entitlement, so this is the second
 * of two independent narrowings rather than the only one.
 */
function effectiveSiteIds(
  entitled: bigint[] | null,
  requested: bigint | null,
): bigint[] | null {
  if (requested === null) return entitled;
  if (entitled === null) return [requested];
  return entitled.includes(requested) ? [requested] : [];
}

/**
 * The scope as a SQL fragment, so every query composes it the same way.
 *
 * `TRUE` rather than an empty fragment on purpose: a fragment that disappears
 * turns the surrounding `WHERE ... AND` into a syntax error, and an employee
 * entitled to no sites has to produce `FALSE` rather than the empty string that
 * would quietly show them everything.
 *
 * Every panel on the screen composes one of these into its own query. Filtering
 * in SQL rather than by fetching everything and hiding rows is not a
 * performance preference: at ten buildings the hidden rows would still be in the
 * response, and a filter that ships the data it claims to exclude is a lie.
 */
function siteFilter(siteIds: bigint[] | null, column: Prisma.Sql): Prisma.Sql {
  if (siteIds === null) return Prisma.sql`TRUE`;
  if (siteIds.length === 0) return Prisma.sql`FALSE`;
  return Prisma.sql`${column} IN (${Prisma.join(siteIds)})`;
}

interface SiteRow {
  site_id: bigint;
  name: string;
  org_name: string;
}

/**
 * SELECTION, three levels deep (B7.6).
 *
 * Project -> Building -> JACE. Each narrows the next, each defaults to All, and
 * all three are intersected with the ENTITLEMENT before any query is built.
 *
 * The separation between the two is the same one `basSiteScope` documents and
 * it matters more now, not less: three controls that a person can set is three
 * more ways to ask for something they may not have. `entitled` decides what
 * exists as far as this request is concerned; the selection can only ever
 * narrow within it, never widen.
 *
 * An id that is not in its own option list is `site_not_found`, which the route
 * renders as 404 - the same answer as a building that does not exist, for the
 * same reason as the module guard. That includes a coherent-looking but stale
 * combination: `?project=1&site=5` where building 5 has since moved to another
 * project produces a building list that does not contain 5, and 5 is refused.
 * Showing the data anyway would render something the URL did not ask for.
 */
export interface BasSelectionRequest {
  projectId?: bigint | null;
  siteId?: bigint | null;
  stationId?: bigint | null;
}

interface ProjectRow {
  project_id: bigint;
  name: string;
  org_name: string;
}

interface StationRow {
  station_id: bigint;
  name: string;
  site_name: string;
}

export interface ResolvedSelection {
  /** Option lists, each narrowed by the level above it. */
  projects: ProjectRow[];
  sites: SiteRow[];
  stations: StationRow[];

  selectedProject: ProjectRow | null;
  selectedSite: SiteRow | null;
  selectedStation: StationRow | null;

  /**
   * The site ids every query is built from: the entitlement, narrowed by
   * whichever of project/building was chosen. `null` means "every entitled
   * site" and an empty array means "none", which `siteFilter` renders as FALSE
   * rather than as an empty IN list.
   */
  siteIds: bigint[] | null;

  /** `null` unless a JACE was chosen. Applied on top of siteIds. */
  stationId: bigint | null;

  /** Whether anything narrower than "all" was asked for. */
  filtered: boolean;
}

/**
 * Resolve all three levels inside the caller's transaction.
 *
 * `tx` rather than `prisma` so the option lists are read at the same instant as
 * the figures beside them - a dropdown listing a building that had already been
 * deleted when the tiles were counted is a screen that disagrees with itself.
 */
async function resolveSelection(
  tx: Prisma.TransactionClient,
  entitled: bigint[] | null,
  request: BasSelectionRequest,
): Promise<ResolvedSelection> {
  const requestedProject = request.projectId ?? null;
  const requestedSite = request.siteId ?? null;
  const requestedStation = request.stationId ?? null;

  // --- projects: every one the employee may see, never narrowed by the
  // selection. A dropdown that lost its other options the moment you picked
  // one could not be used to pick again.
  const projects = await tx.$queryRaw<ProjectRow[]>`
    SELECT DISTINCT pr.project_id, pr.name, o.name AS org_name
    FROM bas_projects pr
    JOIN bas_orgs o ON o.org_id = pr.org_id
    JOIN bas_sites s ON s.project_id = pr.project_id
    WHERE ${siteFilter(entitled, Prisma.sql`s.site_id`)}
    ORDER BY o.name, pr.name
  `;

  const selectedProject =
    requestedProject === null
      ? null
      : (projects.find((row) => row.project_id === requestedProject) ?? null);

  if (requestedProject !== null && selectedProject === null) {
    throw new BasError("site_not_found", "That project is not available.");
  }

  // --- buildings: narrowed by the chosen project, because that is what makes
  // the cascade honest. A building list that still offered every building
  // would let someone pick one outside the project and see an empty screen
  // with nothing saying why.
  const projectScope =
    selectedProject === null
      ? Prisma.sql`TRUE`
      : Prisma.sql`s.project_id = ${selectedProject.project_id}`;

  const sites = await tx.$queryRaw<SiteRow[]>`
    SELECT s.site_id, s.name, o.name AS org_name
    FROM bas_sites s
    JOIN bas_orgs o USING (org_id)
    WHERE ${siteFilter(entitled, Prisma.sql`s.site_id`)} AND ${projectScope}
    ORDER BY o.name, s.name
  `;

  const selectedSite =
    requestedSite === null
      ? null
      : (sites.find((row) => row.site_id === requestedSite) ?? null);

  if (requestedSite !== null && selectedSite === null) {
    throw new BasError("site_not_found", "That building is not available.");
  }

  // The site ids the rest of the request is built from. Narrowed by the
  // building if one was chosen, otherwise by the project's buildings, otherwise
  // the whole entitlement.
  const siteIds: bigint[] | null =
    selectedSite !== null
      ? effectiveSiteIds(entitled, selectedSite.site_id)
      : selectedProject !== null
        ? sites.map((row) => row.site_id)
        : entitled;

  // --- JACEs: narrowed by both levels above.
  const stationSiteScope = siteFilter(siteIds, Prisma.sql`st.site_id`);

  const stations = await tx.$queryRaw<StationRow[]>`
    SELECT st.station_id,
           COALESCE(st.display_name, st.niagara_station_name) AS name,
           s.name AS site_name
    FROM bas_stations st
    JOIN bas_sites s ON s.site_id = st.site_id
    WHERE ${stationSiteScope} AND st.is_active
    ORDER BY s.name, name
  `;

  const selectedStation =
    requestedStation === null
      ? null
      : (stations.find((row) => row.station_id === requestedStation) ?? null);

  if (requestedStation !== null && selectedStation === null) {
    throw new BasError("site_not_found", "That station is not available.");
  }

  return {
    projects,
    sites,
    stations,
    selectedProject,
    selectedSite,
    selectedStation,
    siteIds,
    stationId: selectedStation?.station_id ?? null,
    filtered:
      selectedProject !== null ||
      selectedSite !== null ||
      selectedStation !== null,
  };
}

/**
 * The chosen JACE as a SQL fragment, or TRUE.
 *
 * Separate from `siteFilter` rather than folded into it, because they are
 * applied to different columns in different queries and a single helper
 * guessing which one it was given is how a filter silently stops filtering.
 */
function stationFilter(
  stationId: bigint | null,
  column: Prisma.Sql,
): Prisma.Sql {
  return stationId === null ? Prisma.sql`TRUE` : Prisma.sql`${column} = ${stationId}`;
}

/**
 * A site id from a query string.
 *
 * `bigint` and not `number`: `bas_sites.site_id` is a PostgreSQL `bigint`, and
 * parsing it through a JS number would round silently past 2^53. It never has to
 * be valid - an unparseable one is simply not a site, and is refused the same
 * way a nonexistent one is.
 */
export function parseSiteId(value: string | null | undefined): bigint | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "all") return null;
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new BasError("site_not_found", "That building is not available.");
  }
  return BigInt(trimmed);
}

/**
 * A project or station id from a query string.
 *
 * Same contract as `parseSiteId`: bigint because these are PostgreSQL bigints
 * and a JS number rounds silently past 2^53, and an unparseable value is simply
 * not a project rather than a 500. `resolveSelection` then refuses it the same
 * way it refuses one that exists but is not this employee's.
 */
export function parseProjectId(value: string | null | undefined): bigint | null {
  return parseBigIntParam(value, "That project is not available.");
}

export function parseStationId(value: string | null | undefined): bigint | null {
  return parseBigIntParam(value, "That station is not available.");
}

function parseBigIntParam(
  value: string | null | undefined,
  message: string,
): bigint | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "all") return null;
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new BasError("site_not_found", message);
  }
  return BigInt(trimmed);
}

/**
 * The active selection in words, or null when nothing is selected.
 *
 * Built here rather than in the component so the scope line, the per-tile
 * qualifiers and the "outside this filter" warning cannot describe the
 * selection three slightly different ways.
 */
function describeSelection(selection: ResolvedSelection): string | null {
  const parts = [
    selection.selectedProject?.name,
    selection.selectedSite?.name,
    selection.selectedStation?.name,
  ].filter((part): part is string => part !== undefined && part !== null);

  return parts.length === 0 ? null : parts.join(" \u2192 ");
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
  detected_at: Date;
  hours_lost: number;
  cause: string;
  notes: string | null;
}

export interface CollectionHealthOptions extends BasSelectionRequest {
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
 * has rolled past it (runbook.md, *BAS irreplaceability*).
 */
export async function getCollectionHealth(
  viewer: Viewer,
  options: CollectionHealthOptions = {},
): Promise<CollectionHealth> {
  const windowDays = clampWindowDays(options.windowDays);
  const scope = await basSiteScope(viewer);
  const entitled = scope.entitled;

  const result = await prisma.$transaction(async (tx) => {
    const observedAt = firstRow(
      await tx.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`,
      "now()",
    ).now;

    // --- the building filter, before anything reads a row ------------------

    // Project -> Building -> JACE, each narrowed by the one above and all three
    // intersected with the entitlement. See resolveSelection.
    const selection = await resolveSelection(tx, entitled, options);
    const { siteIds, stationId } = selection;

    // bas_v_collection_health exposes site_id AND station_id directly;
    // bas_readings and bas_ingest_runs reach both through bas_stations, exactly
    // as Grafana does.
    const healthSites = Prisma.sql`${siteFilter(siteIds, Prisma.sql`site_id`)}
      AND ${stationFilter(stationId, Prisma.sql`station_id`)}`;
    const stationSites = Prisma.sql`${siteFilter(siteIds, Prisma.sql`st.site_id`)}
      AND ${stationFilter(stationId, Prisma.sql`st.station_id`)}`;

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
      --
      -- The tie-break is NOT Grafana's, and it is a fix rather than a
      -- divergence. seconds_since_last_record is whole seconds, and a collector
      -- that writes every point in the same poll gives them all the same value -
      -- four points collected 9 ms apart tie exactly. PostgreSQL returns tied
      -- rows in whatever order it likes, and it does not pick the same one
      -- twice, so the table reshuffled itself on every one-minute refresh.
      -- Caught by scripts/bas-health-oracle.ts, which compared two runs of the
      -- same query and got two orders.
      ORDER BY seconds_since_last_record DESC NULLS FIRST, point_name, point_id
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
      WHERE ir.started_at >= now() - make_interval(days => ${windowDays}::int)
        AND (${stationSites} OR st.site_id IS NULL)
      ORDER BY ir.started_at DESC
      LIMIT ${RECENT_RUNS_LIMIT}
    `;

    // Deliberately NOT windowed and NOT limited. It exists for the case where
    // `runs` above came back empty: a short window over a collector that stopped
    // days ago produces an empty list, and an empty list reads as "nothing to
    // report" when it means the opposite. This lets the empty state say when it
    // last ran instead of saying nothing.
    const newestRun = firstRow(
      await tx.$queryRaw<Array<{ newest_run_at: Date | null }>>`
        SELECT max(ir.started_at) AS newest_run_at
        FROM bas_ingest_runs ir
        LEFT JOIN bas_stations st USING (station_id)
        WHERE (${stationSites} OR st.site_id IS NULL)
      `,
      "newest run",
    ).newest_run_at;

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
        g.detected_at,
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

    /**
     * THE SAME TILES, WITHOUT THE FILTER.
     *
     * Every tile on this screen counts only what the filter selected, which is
     * correct and is also how somebody reads "0 points at risk" in one building
     * and concludes nothing anywhere is at risk. This project has lost about
     * 117 hours per point across three outages and one of them sat unnoticed in
     * the database for eight days; a reassuring number that is only true of a
     * subset is exactly that failure.
     *
     * So when a filter is active the screen is also told what the answer would
     * have been without it, and says so when the unfiltered answer is worse.
     *
     * Scoped to the ENTITLEMENT, not to the whole table - "outside your filter"
     * must never mean "outside your permissions".
     *
     * Skipped entirely when nothing is filtered, where it would be the same
     * scan for the same numbers.
     */
    const unfiltered = selection.filtered
      ? firstRow(
          await tx.$queryRaw<Array<{ active_points: number; points_at_risk: number }>>`
            SELECT
              count(*) FILTER (WHERE is_active)::int AS active_points,
              count(*) FILTER (WHERE is_active AND roll_risk <> 'ok')::int
                AS points_at_risk
            FROM bas_v_collection_health
            WHERE ${siteFilter(entitled, Prisma.sql`site_id`)}
          `,
          "unfiltered totals",
        )
      : null;

    return {
      observedAt,
      selection,
      unfiltered,
      totals,
      readingTotals,
      points,
      runs,
      newestRun,
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

  const { selection } = result;

  const health: CollectionHealth = {
    windowDays,

    projects: selection.projects.map((row) => ({
      projectId: row.project_id.toString(),
      name: row.name,
      orgName: row.org_name,
    })),
    sites: selection.sites.map(toSiteOption),
    stations: selection.stations.map((row) => ({
      stationId: row.station_id.toString(),
      name: row.name,
      siteName: row.site_name,
    })),

    selectedProjectId: selection.selectedProject?.project_id.toString() ?? null,
    selectedProjectName: selection.selectedProject?.name ?? null,
    selectedSiteId: selection.selectedSite?.site_id.toString() ?? null,
    selectedSiteName: selection.selectedSite?.name ?? null,
    selectedStationId: selection.selectedStation?.station_id.toString() ?? null,
    selectedStationName: selection.selectedStation?.name ?? null,

    scope: {
      filtered: selection.filtered,
      label: describeSelection(selection),
    },
    unfiltered:
      result.unfiltered === null
        ? null
        : {
            activePoints: result.unfiltered.active_points,
            pointsAtRisk: result.unfiltered.points_at_risk,
          },

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
    newestRunAt: iso(result.newestRun),
    runRecords: result.runRecords.map(toRunRecordPoint),
    longestRunGap,
    dataGaps: result.dataGaps.map(toDataGapRow),
  };

  logger.info("bas.collection_health", {
    employeeId: scope.employeeId,
    moduleKey: "bas",
    count: health.totals.activePoints,
    outcome: health.totals.pointsAtRisk > 0 ? "at_risk" : "ok",
    // Which window and which building this answer was for. Without it a support
    // question about a wrong number cannot be reproduced from the log.
    reason: `window=${windowDays}d site=${health.selectedSiteId ?? "all"}`,
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

function toSiteOption(row: SiteRow): SiteOption {
  return {
    siteId: row.site_id.toString(),
    name: row.name,
    orgName: row.org_name,
  };
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
    detectedAt: row.detected_at.toISOString(),
    hoursLost: row.hours_lost,
    cause: row.cause,
    notes: row.notes,
  };
}

// ---------------------------------------------------------------------------
// B4 - Point Explorer
// ---------------------------------------------------------------------------

/** Grafana's point picker is single-select, and so is this. See `getPointExplorer`. */
export function parsePointId(value: string | null | undefined): bigint | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new BasError("point_not_found", "That point is not available.");
  }
  return BigInt(trimmed);
}

/**
 * How far apart two readings have to be before the trend line breaks.
 *
 * A multiple of the point's own collection interval, so it scales with how
 * often the point is actually logged rather than assuming five minutes. Three
 * intervals is wide enough that one late poll does not fragment the line and
 * narrow enough that a real outage is unmistakable.
 *
 * The floor exists for points whose interval is not known - capacity has not
 * been filled in from Workbench - where the alternative is either never breaking
 * or breaking constantly.
 */
const BREAK_INTERVAL_MULTIPLE = 3;
const MIN_BREAK_SECONDS = 900;

function breakThresholdMs(collectionIntervalS: number | null): number {
  const fromInterval =
    collectionIntervalS === null ? 0 : collectionIntervalS * BREAK_INTERVAL_MULTIPLE;
  return Math.max(fromInterval, MIN_BREAK_SECONDS) * 1000;
}

/**
 * The most samples the payload will carry.
 *
 * 90 days at one record per five minutes is about 26,000 rows, which is more
 * than a chart 800 pixels wide can express and more than is pleasant to ship.
 * Past this the MOST RECENT slice is returned and `trendTruncated` says so.
 *
 * Truncation rather than downsampling, deliberately. Averaging buckets together
 * would smooth over exactly the thing this chart exists to show: a hole where
 * the station overwrote data before anyone collected it. A shorter window that
 * is complete beats a long one that has been quietly averaged.
 */
const MAX_TREND_POINTS = 12_000;

interface PointOptionRow {
  point_id: bigint;
  point_name: string;
  point_role: string | null;
  unit: string | null;
  site_name: string;
  collection_interval_s: number | null;
}

interface PointStatsRow {
  readings: number;
  null_records: number;
  distinct_values: number;
  average: number | null;
  minimum: number | null;
  maximum: number | null;
}

interface LatestRow {
  value_num: number | null;
  ts: Date | null;
}

interface TrendRow {
  ts: Date;
  value_num: number | null;
}

export interface PointExplorerOptions extends BasSelectionRequest {
  windowDays?: number;
  /** Absent means "the first point the picker would offer". */
  pointId?: bigint | null;
}

/**
 * Everything the Point Explorer screen shows, for ONE point.
 *
 * One point at a time, which is the same choice Grafana's dashboard makes
 * (`$point` is `multi: false`) and it is load-bearing rather than incidental.
 * `points_RoomT` is in fahrenheit and `Temp1`..`Temp3` carry no unit at all, so
 * plotting two of them on one axis would put 55 degF and 12.8 degC on the same
 * line with nothing on screen saying they are different quantities. A
 * single-point chart cannot express that mistake. If this ever grows a compare
 * mode, it needs one axis per unit and an explicit refusal for unitless points -
 * see runbook.md, *Two points on one axis*.
 *
 * Same transaction discipline as `getCollectionHealth`: one `now()` for the
 * window, the stats and the trend, so the tiles cannot disagree with the chart
 * they sit above.
 */
export async function getPointExplorer(
  viewer: Viewer,
  options: PointExplorerOptions = {},
): Promise<PointExplorer> {
  const windowDays = clampWindowDays(options.windowDays);
  const requestedPointId = options.pointId ?? null;
  const scope = await basSiteScope(viewer);
  const entitled = scope.entitled;

  const result = await prisma.$transaction(async (tx) => {
    const observedAt = firstRow(
      await tx.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`,
      "now()",
    ).now;

    // The same three-level cascade as Collection Health, and it narrows WHICH
    // POINTS ARE SELECTABLE - the picker below is built from healthSites, so a
    // JACE filter reduces the list rather than merely greying out the chart.
    const selection = await resolveSelection(tx, entitled, options);
    const { siteIds, stationId } = selection;
    const healthSites = Prisma.sql`${siteFilter(siteIds, Prisma.sql`site_id`)}
      AND ${stationFilter(stationId, Prisma.sql`station_id`)}`;

    // Grafana's $point variable query, plus the two columns the screen needs
    // that a dropdown does not: the unit, and the interval the break threshold
    // is derived from.
    //
    // ORDER BY carries point_id as a tie-break. Two points in one building can
    // share a display name - display_name is not unique, only
    // (station_id, niagara_history_name) is - and without it the picker would
    // reorder between refreshes.
    const pointRows = await tx.$queryRaw<PointOptionRow[]>`
      SELECT point_id, point_name, point_role, unit, site_name,
             collection_interval_s
      FROM bas_v_point
      WHERE is_active AND ${healthSites}
      ORDER BY site_name, point_name, point_id
    `;

    const selectedPoint =
      requestedPointId === null
        ? (pointRows[0] ?? null)
        : (pointRows.find((row) => row.point_id === requestedPointId) ?? null);

    // A point outside the picker's list is refused rather than silently swapped
    // for the first one. Silently swapping would show one point's data under
    // another point's name in the URL, which is the worst of both.
    if (requestedPointId !== null && selectedPoint === null) {
      throw new BasError("point_not_found", "That point is not available.");
    }

    if (selectedPoint === null) {
      return {
        observedAt,
        selection,
        pointRows,
        selectedPoint: null,
        stats: null,
        latest: null,
        trend: [] as TrendRow[],
        trendTruncated: false,
        dataGaps: [] as GapRow[],
      };
    }

    const pointId = selectedPoint.point_id;
    const since = Prisma.sql`now() - make_interval(days => ${windowDays}::int)`;

    // Grafana runs panels 2, 3, 4 and 5 as four queries over the same rows.
    // One pass, the same five numbers.
    const stats = firstRow(
      await tx.$queryRaw<PointStatsRow[]>`
        SELECT
          count(*)::int AS readings,
          count(*) FILTER (
            WHERE value_num IS NULL AND value_bool IS NULL AND value_str IS NULL
          )::int AS null_records,
          count(DISTINCT value_num)::int AS distinct_values,
          round(avg(value_num)::numeric, 2)::float8 AS average,
          round(min(value_num)::numeric, 2)::float8 AS minimum,
          round(max(value_num)::numeric, 2)::float8 AS maximum
        FROM bas_readings
        WHERE point_id = ${pointId} AND ts >= ${since}
      `,
      "point stats",
    );

    // Grafana's panel 1. Deliberately NOT windowed and deliberately NOT null:
    // "latest" answers "what is it reading now", and a window with no data in it
    // does not make the last known value untrue.
    const latest =
      (
        await tx.$queryRaw<LatestRow[]>`
          SELECT value_num, ts
          FROM bas_readings
          WHERE point_id = ${pointId} AND value_num IS NOT NULL
          ORDER BY ts DESC
          LIMIT 1
        `
      )[0] ?? null;

    // One extra row so truncation can be detected without a second count.
    const trendRows = await tx.$queryRaw<TrendRow[]>`
      SELECT ts, value_num
      FROM bas_readings
      WHERE point_id = ${pointId} AND ts >= ${since}
      ORDER BY ts DESC
      LIMIT ${MAX_TREND_POINTS + 1}
    `;

    const trendTruncated = trendRows.length > MAX_TREND_POINTS;
    // Newest-first above so that truncation keeps the RECENT end; flipped here
    // because a chart reads left to right.
    const trend = trendRows.slice(0, MAX_TREND_POINTS).reverse();

    const dataGaps = await tx.$queryRaw<GapRow[]>`
      SELECT
        g.gap_id,
        h.point_name,
        h.site_name,
        g.gap_start,
        g.gap_end,
        g.detected_at,
        round((EXTRACT(EPOCH FROM (g.gap_end - g.gap_start)) / 3600.0)::numeric, 1)::float8
          AS hours_lost,
        g.cause,
        g.notes
      FROM bas_data_gaps g
      JOIN bas_v_collection_health h USING (point_id)
      WHERE g.point_id = ${pointId}
      ORDER BY g.gap_start DESC, g.gap_id DESC
      LIMIT ${DATA_GAPS_LIMIT}
    `;

    return {
      observedAt,
      selection,
      pointRows,
      selectedPoint,
      stats,
      latest,
      trend,
      trendTruncated,
      dataGaps,
    };
  });

  const { trend, gaps } = buildTrend(
    result.trend,
    result.selectedPoint?.collection_interval_s ?? null,
  );

  const explorer: PointExplorer = {
    windowDays,
    observedAt: result.observedAt.toISOString(),
    projects: result.selection.projects.map((row) => ({
      projectId: row.project_id.toString(),
      name: row.name,
      orgName: row.org_name,
    })),
    sites: result.selection.sites.map(toSiteOption),
    stations: result.selection.stations.map((row) => ({
      stationId: row.station_id.toString(),
      name: row.name,
      siteName: row.site_name,
    })),
    selectedProjectId:
      result.selection.selectedProject?.project_id.toString() ?? null,
    selectedProjectName: result.selection.selectedProject?.name ?? null,
    selectedSiteId: result.selection.selectedSite?.site_id.toString() ?? null,
    selectedSiteName: result.selection.selectedSite?.name ?? null,
    selectedStationId:
      result.selection.selectedStation?.station_id.toString() ?? null,
    selectedStationName: result.selection.selectedStation?.name ?? null,
    scope: {
      filtered: result.selection.filtered,
      label: describeSelection(result.selection),
    },
    points: result.pointRows.map(toPointOption),
    selectedPoint:
      result.selectedPoint === null ? null : toPointOption(result.selectedPoint),
    collectionIntervalS: result.selectedPoint?.collection_interval_s ?? null,
    stats: {
      readings: result.stats?.readings ?? 0,
      nullRecords: result.stats?.null_records ?? 0,
      distinctValues: result.stats?.distinct_values ?? 0,
      latest: result.latest?.value_num ?? null,
      latestAt: iso(result.latest?.ts ?? null),
      average: result.stats?.average ?? null,
      minimum: result.stats?.minimum ?? null,
      maximum: result.stats?.maximum ?? null,
    },
    trend,
    trendGaps: gaps,
    trendTruncated: result.trendTruncated,
    dataGaps: result.dataGaps.map(toDataGapRow),
  };

  logger.info("bas.point_explorer", {
    employeeId: scope.employeeId,
    moduleKey: "bas",
    count: explorer.stats.readings,
    reason:
      `window=${windowDays}d site=${explorer.selectedSiteId ?? "all"} ` +
      `point=${explorer.selectedPoint?.pointId ?? "none"} ` +
      `gaps=${gaps.length}`,
  });

  return explorer;
}

/**
 * Turns ordered readings into a series the chart can draw, inserting an explicit
 * break wherever there is no data rather than letting the line cross the hole.
 *
 * A straight segment across a gap asserts values that were never recorded, and
 * in this database that is not hypothetical: the station destroyed 22.7 hours of
 * every point on 21-22 August 2026 and a line drawn across it reads as a steady
 * temperature. See runbook.md, *The trend chart must break across gaps*.
 *
 * Exported so a test can drive it with a synthetic series and so the rule is
 * checkable without a database.
 */
export function buildTrend(
  rows: Array<{ ts: Date; value_num: number | null }>,
  collectionIntervalS: number | null,
): { trend: TrendPoint[]; gaps: TrendGap[] } {
  const threshold = breakThresholdMs(collectionIntervalS);
  const trend: TrendPoint[] = [];
  const gaps: TrendGap[] = [];

  let previousMs: number | null = null;

  for (const row of rows) {
    const tsMs = row.ts.getTime();

    if (previousMs !== null && tsMs - previousMs > threshold) {
      // One synthetic null between the two real samples. Recharts breaks a line
      // at a null y-value, so this is what stops the segment being drawn - and
      // it sits at the midpoint so neither real reading is displaced.
      trend.push({
        tsMs: previousMs + Math.floor((tsMs - previousMs) / 2),
        value: null,
        isBreak: true,
      });
      gaps.push({
        fromMs: previousMs,
        toMs: tsMs,
        hours: (tsMs - previousMs) / 3_600_000,
      });
    }

    // A row whose value columns are all null is a RECORD with no value. It is
    // pushed with value null - the line cannot cross it either - but isBreak is
    // false, because something was collected here and the tiles count it.
    trend.push({ tsMs, value: row.value_num, isBreak: false });
    previousMs = tsMs;
  }

  return { trend, gaps };
}

function toPointOption(row: PointOptionRow): PointOption {
  return {
    pointId: row.point_id.toString(),
    pointName: row.point_name,
    pointRole: row.point_role,
    unit: row.unit,
    siteName: row.site_name,
  };
}
