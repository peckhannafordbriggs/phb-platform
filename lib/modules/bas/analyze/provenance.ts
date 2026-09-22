import type { Pool } from "pg";
import { queryAsAnalyzeRole } from "./pool";
import type {
  GapOverlap,
  Provenance,
  ProvenancePoint,
  ScopeSource,
  TimeRange,
} from "./types";

/**
 * Provenance, computed by THIS CODE after the query has run.
 *
 * docs/BAS-B5.md: gap overlap and unknown-horizon "are computed by our code
 * after the query runs, from the time range and points involved. They are not
 * something the model is asked to remember." Every query here is ours, with
 * bound parameters, on the same read-only role. The planner's only inputs to
 * this file are a list of point ids and a time range, and both are treated as
 * declarations to check, not facts to repeat:
 *
 *   - a declared point id that does not exist is dropped and the scope says so
 *   - a query that reads readings with no declared points is widened to EVERY
 *     point, so the gap figure over-reports rather than under-reports
 *   - a query that reads readings with no declared time range gets `gaps:
 *     null`, which the screen renders in amber as "could not be computed" -
 *     never as "no gaps"
 *
 * Unclassified points: the SQL selected by `point_role`, so points with no
 * role were never candidates. That count is measured here from bas_points,
 * not taken from the plan.
 */

export interface ProvenanceInput {
  pointIds: string[];
  timeRange: TimeRange | null;
  readsReadings: boolean;
  filtersByRole: boolean;
  /** The SQL filters by time and `timeRange` is still null after a retry. */
  periodUndeclared: boolean;
}

const POINT_NAME_SQL =
  "COALESCE(p.label, p.display_name, p.niagara_history_name)";

export async function computeProvenance(
  pool: Pool,
  input: ProvenanceInput,
): Promise<Provenance> {
  const declared = uniqueBigintStrings(input.pointIds);

  let scope: ScopeSource;
  let points: ProvenancePoint[];

  // A declared TIME RANGE is reason enough to widen, not only a read of
  // bas_readings. Found live on 2026-09-21: "gap hours in the last 30 days,
  // by point" reads bas_data_gaps, the plan declared the range and no ids,
  // and the old rule - widen only when the SQL reads readings - produced
  // "Scope: none, Gaps: NOT COMPUTED" beside a resolved range. Anything
  // with a period is a claim about that period, and the overlap figure is
  // what checks it; the cost of computing it for a query that turns out not
  // to need it is one indexed query.
  const hasPeriod = input.timeRange !== null;

  if (declared.length > 0) {
    points = await lookupPoints(pool, declared);
    // Every declared id resolved: the declaration is at least about real
    // points. Some did not: the plan named ids that do not exist, and the
    // honest thing is to fall back to every point rather than trust the rest.
    scope = points.length === declared.length ? "declared" : "all_points";
    if (scope === "all_points") points = await lookupPoints(pool, null);
  } else if (input.readsReadings || hasPeriod) {
    scope = "all_points";
    points = await lookupPoints(pool, null);
  } else {
    scope = "none";
    points = [];
  }

  const ids = points.map((p) => p.id);
  const range = input.timeRange;

  const [gaps, unknownHorizon, coverage, unclassified] = await Promise.all([
    range !== null && ids.length > 0
      ? gapOverlap(pool, ids, range)
      : Promise.resolve(null),
    ids.length > 0 ? unknownHorizonPoints(pool, ids) : Promise.resolve({ count: 0, names: [] }),
    ids.length > 0 && input.readsReadings
      ? coverageOf(pool, ids, points)
      : Promise.resolve(null),
    input.filtersByRole ? unclassifiedCount(pool) : Promise.resolve(0),
  ]);

  return {
    timeRange: range,
    scope,
    points,
    gaps,
    unknownHorizon,
    coverage,
    unclassifiedExcluded: unclassified,
    periodUndeclared: input.periodUndeclared,
    coverageShortfall: describeCoverageShortfall(range, coverage),
  };
}

/**
 * Does the data held cover the period asked about? One sentence, or null.
 *
 * Used for every result, not only no-data: an answer of "72.73 °F over the
 * last 30 days" computed from ten days of readings is exactly as wrong as a
 * silent gap, and only the platform can say so reliably - the model happened
 * to mention it once, on 2026-09-21, and happening to is not a guarantee.
 * A recorded gap inside the covered span is the gap figure's job; this is
 * the span itself falling short of the question.
 */
export function describeCoverageShortfall(
  range: TimeRange | null,
  coverage: Provenance["coverage"],
): string | null {
  if (range === null || coverage === null) return null;
  if (coverage.readings === 0 || coverage.earliest === null || coverage.latest === null) {
    return null; // "never collected" is its own sentence, in explainNoData.
  }

  const askedStart = Date.parse(range.start);
  const askedEnd = Date.parse(range.end);
  const haveStart = Date.parse(coverage.earliest);
  const haveEnd = Date.parse(coverage.latest);

  if (askedEnd <= haveStart) {
    return `The period asked about ends before collection began. Readings for these points start ${coverage.earliest}.`;
  }
  if (askedStart >= haveEnd) {
    return `The period asked about begins after the last reading held, ${coverage.latest}.`;
  }

  const missingStartH = Math.max(0, (haveStart - askedStart) / 3_600_000);
  const missingEndH = Math.max(0, (askedEnd - haveEnd) / 3_600_000);
  // Under an hour at either edge is the collector's cadence, not a shortfall.
  if (missingStartH < 1 && missingEndH < 1) return null;

  const askedH = (askedEnd - askedStart) / 3_600_000;
  const coveredH = Math.max(0, askedH - missingStartH - missingEndH);
  const parts: string[] = [];
  if (missingStartH >= 1) parts.push(`the first ${formatSpan(missingStartH)}`);
  if (missingEndH >= 1) parts.push(`the last ${formatSpan(missingEndH)}`);

  return (
    `The period asked about is only partly covered: readings for these points run from ` +
    `${coverage.earliest} to ${coverage.latest}, so ${parts.join(" and ")} of the period ` +
    `${parts.length === 1 ? "has" : "have"} no readings at all. Any figure above describes ` +
    `${formatSpan(coveredH)} of the ${formatSpan(askedH)} asked about.`
  );
}

function formatSpan(hours: number): string {
  if (hours >= 48) return `${Math.round(hours / 24)} days`;
  if (hours >= 1) return `${Math.round(hours)} hours`;
  return `${Math.round(hours * 60)} minutes`;
}

/** Only well-formed integers reach the database. Anything else is dropped. */
function uniqueBigintStrings(values: string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = String(value).trim();
    if (/^\d{1,18}$/.test(trimmed)) seen.add(trimmed);
  }
  return [...seen];
}

interface PointRow {
  point_id: string;
  name: string;
  site: string;
  station: string;
  is_active: boolean;
}

async function lookupPoints(
  pool: Pool,
  ids: string[] | null,
): Promise<ProvenancePoint[]> {
  const rows = await queryAsAnalyzeRole<PointRow>(
    pool,
    `SELECT p.point_id::text AS point_id,
            ${POINT_NAME_SQL} AS name,
            s.name AS site,
            COALESCE(st.display_name, st.niagara_station_name) AS station,
            p.is_active
       FROM bas_points p
       JOIN bas_stations st ON st.station_id = p.station_id
       JOIN bas_sites s ON s.site_id = st.site_id
      WHERE ($1::bigint[] IS NULL OR p.point_id = ANY ($1::bigint[]))
      ORDER BY s.name, st.niagara_station_name, ${POINT_NAME_SQL}, p.point_id`,
    [ids],
  );

  return rows.map((row) => ({
    id: row.point_id,
    name: row.name,
    site: row.site,
    station: row.station,
    collected: row.is_active,
  }));
}

interface GapRow {
  point_id: string;
  point_name: string;
  ov_start: Date;
  ov_end: Date;
  hours: string;
  cause: string;
}

/**
 * Recorded gaps intersecting the queried range, clipped to it.
 *
 * `gap_start < end AND gap_end > start` is the interval-overlap test; the
 * greatest/least pair clips each gap to the range so the hours are hours
 * INSIDE the question, not the whole outage.
 */
async function gapOverlap(
  pool: Pool,
  ids: string[],
  range: TimeRange,
): Promise<Provenance["gaps"]> {
  const rows = await queryAsAnalyzeRole<GapRow>(
    pool,
    `SELECT g.point_id::text AS point_id,
            ${POINT_NAME_SQL} AS point_name,
            GREATEST(g.gap_start, $2::timestamptz) AS ov_start,
            LEAST(g.gap_end, $3::timestamptz)      AS ov_end,
            EXTRACT(EPOCH FROM (LEAST(g.gap_end, $3::timestamptz)
                                - GREATEST(g.gap_start, $2::timestamptz))) / 3600.0 AS hours,
            g.cause
       FROM bas_data_gaps g
       JOIN bas_points p ON p.point_id = g.point_id
      WHERE g.point_id = ANY ($1::bigint[])
        AND g.gap_start < $3::timestamptz
        AND g.gap_end   > $2::timestamptz
      ORDER BY ov_start, g.point_id`,
    [ids, range.start, range.end],
  );

  const clipped: GapOverlap[] = rows.map((row) => ({
    pointId: row.point_id,
    pointName: row.point_name,
    start: row.ov_start.toISOString(),
    end: row.ov_end.toISOString(),
    hours: round(Number(row.hours), 2),
    cause: row.cause,
  }));

  const { items, mergedRows } = mergeOverlapping(clipped);

  return {
    totalHours: round(items.reduce((sum, g) => sum + g.hours, 0), 2),
    items,
    mergedRows,
  };
}

/**
 * Merges overlapping (or touching) intervals per point, so a duplicate record
 * can never inflate the total.
 *
 * Found on 2026-09-21: bas_data_gaps held the 3-8 September outage twice for
 * each Spring Grove point - same start, ends a day apart - because the
 * collector's pass on the 8th recorded the gap and then timed out before it
 * could advance the checkpoint, and the pass on the 9th recorded it again.
 * Summing rows counted 71.7 hours twice per point. The rows are the
 * collector's to fix; this is the platform refusing to be misled by them.
 *
 * Intervals are already clipped to the queried range, so merging here is
 * merging what will be summed. Causes that differ within one merged interval
 * are joined, so nothing is silently dropped.
 */
export function mergeOverlapping(
  gaps: GapOverlap[],
): { items: GapOverlap[]; mergedRows: number } {
  const byPoint = new Map<string, GapOverlap[]>();
  for (const gap of gaps) {
    const list = byPoint.get(gap.pointId) ?? [];
    list.push(gap);
    byPoint.set(gap.pointId, list);
  }

  const items: GapOverlap[] = [];
  let mergedRows = 0;

  for (const list of byPoint.values()) {
    list.sort(
      (a, b) =>
        Date.parse(a.start) - Date.parse(b.start) || Date.parse(a.end) - Date.parse(b.end),
    );
    let current: GapOverlap | null = null;
    for (const gap of list) {
      if (current !== null && Date.parse(gap.start) <= Date.parse(current.end)) {
        mergedRows += 1;
        if (Date.parse(gap.end) > Date.parse(current.end)) current.end = gap.end;
        if (!current.cause.split(" + ").includes(gap.cause)) {
          current.cause = `${current.cause} + ${gap.cause}`;
        }
        continue;
      }
      if (current !== null) items.push(current);
      current = { ...gap };
    }
    if (current !== null) items.push(current);
  }

  for (const item of items) {
    item.hours = round((Date.parse(item.end) - Date.parse(item.start)) / 3_600_000, 2);
  }
  items.sort(
    (a, b) => Date.parse(a.start) - Date.parse(b.start) || a.pointId.localeCompare(b.pointId),
  );
  return { items, mergedRows };
}

interface HorizonRow {
  point_name: string;
}

/**
 * `horizon_state = 'unknown'` from the view - the state the tiles say out
 * loud. Not `roll_risk`: that is the at-risk vocabulary, decided in one place
 * (lib/modules/bas/types.ts), and this is a different question - not "is data
 * about to be lost" but "do we know how long the station keeps it".
 */
async function unknownHorizonPoints(
  pool: Pool,
  ids: string[],
): Promise<Provenance["unknownHorizon"]> {
  const rows = await queryAsAnalyzeRole<HorizonRow>(
    pool,
    `SELECT ${POINT_NAME_SQL} AS point_name
       FROM bas_v_collection_health h
       JOIN bas_points p ON p.point_id = h.point_id
      WHERE h.point_id = ANY ($1::bigint[])
        AND h.horizon_state = 'unknown'
        -- Collected points only. An uncollected system log has no horizon to
        -- know, and Collection Health keeps the deliberate inactive reasons
        -- out of every figure; listing AuditHistory twice here (live,
        -- 2026-09-21) said nothing about the answer.
        AND p.is_active
      ORDER BY 1`,
    [ids],
  );
  return { count: rows.length, names: rows.map((r) => r.point_name) };
}

interface CoverageRow {
  earliest: Date | null;
  latest: Date | null;
  readings: string;
}

interface CountedRow {
  point_id: string;
}

async function coverageOf(
  pool: Pool,
  ids: string[],
  points: ProvenancePoint[],
): Promise<Provenance["coverage"]> {
  const [summary, withReadings] = await Promise.all([
    queryAsAnalyzeRole<CoverageRow>(
      pool,
      `SELECT min(ts) AS earliest, max(ts) AS latest, count(*)::text AS readings
         FROM bas_readings
        WHERE point_id = ANY ($1::bigint[])`,
      [ids],
    ),
    queryAsAnalyzeRole<CountedRow>(
      pool,
      `SELECT DISTINCT point_id::text AS point_id
         FROM bas_readings
        WHERE point_id = ANY ($1::bigint[])`,
      [ids],
    ),
  ]);

  const row = summary[0];
  const have = new Set(withReadings.map((r) => r.point_id));

  return {
    earliest: row?.earliest?.toISOString() ?? null,
    latest: row?.latest?.toISOString() ?? null,
    readings: Number(row?.readings ?? 0),
    neverCollected: points.filter((p) => !have.has(p.id)).map((p) => p.name),
  };
}

async function unclassifiedCount(pool: Pool): Promise<number> {
  const rows = await queryAsAnalyzeRole<{ n: string }>(
    pool,
    `SELECT count(*)::text AS n FROM bas_points WHERE point_role IS NULL AND is_active`,
    [],
  );
  return Number(rows[0]?.n ?? 0);
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
