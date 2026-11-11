import { Prisma } from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/db";
import { isPresetKey, type PresetKey } from "../presets";
import { isAnalysisWindow, type AnalysisWindow } from "../schedule";
import { classify, type LibraryRowForEngine } from "./inventory";
import { occupiedFromSchedule, occupiedFromSeries } from "./series";
import type { EquipmentUnit, Interval, OccupancySource, PointSeries } from "./types";

/**
 * What a run reads (Reports, Phase 2): the definition, the building's
 * stations and points, their readings over the period, each point's trend
 * coverage, and the occupancy source per station. Everything the analysis
 * functions need, fetched here and nowhere else, so the functions stay pure.
 *
 * COVERAGE IS COMPUTED IN SQL, once per run, from bas_readings and
 * bas_data_gaps. For an interval trend: the period minus every stretch
 * between consecutive readings longer than the point's hold (three
 * intervals, at least fifteen minutes), minus the head before the first
 * reading and the tail after the last, each beyond the hold. For a
 * change-of-value trend "no readings" is the normal week, so coverage is the
 * period minus the gaps the collector RECORDED (the station destroyed data
 * before it was read), and zero when the point has never reported at all.
 * A point is change-of-value when it has no interval recorded, OR when it
 * recorded more readings in the period than its declared interval allows
 * (COV_LIKE_FACTOR times): the office's damper and static points declare
 * 900 s and log on change, 1,454 times a week with one 47-hour silence
 * while the damper did not move, and reading that silence as a hole put
 * them under 80% on the first live run (2026-11-10). Such a point is
 * carried as change-of-value everywhere downstream: its value holds
 * without bound and it is never offline or stale for keeping quiet.
 *
 * SERIES ARE DOWNSAMPLED only past DOWNSAMPLE_ABOVE readings, by averaging
 * into equal buckets, and the series says so (`bucketMs`); a week of a
 * 15-minute trend is 672 readings and is read raw. The value at the period
 * start is carried in from the last reading before it, because a
 * change-of-value point's state at the start IS that reading.
 */

export const DOWNSAMPLE_ABOVE = 20_000;
/** More readings than the declared interval allows, by this factor, means the point logs on change. */
export const COV_LIKE_FACTOR = 1.5;

export const WINDOW_MS: Record<AnalysisWindow, number> = {
  "24h": 86_400_000,
  "3d": 3 * 86_400_000,
  "7d": 7 * 86_400_000,
  "14d": 14 * 86_400_000,
  "30d": 30 * 86_400_000,
};

export interface DefinitionForRun {
  reportId: bigint;
  name: string;
  presetKey: PresetKey | null;
  presetLabel: string | null;
  analysisWindow: AnalysisWindow;
  budgetUsd: number;
  /** The wall-clock cap on one run, in minutes (Phase 3). */
  maxMinutes: number;
  site: { siteId: bigint; name: string; timezone: string };
  stationIds: bigint[];
  questions: Array<{
    questionId: bigint;
    position: number;
    kind: "library" | "personal" | "inline";
    text: string;
    library: LibraryRowForEngine | null;
  }>;
}

export async function loadDefinition(reportId: bigint): Promise<DefinitionForRun | null> {
  const row = await prisma.basReportDefinition.findUnique({
    where: { reportId },
    include: {
      site: { select: { siteId: true, name: true, timezone: true } },
      questions: {
        orderBy: { position: "asc" },
        include: { libraryQuestion: true, personalQuestion: { select: { text: true } } },
      },
    },
  });
  if (row === null) return null;
  const { REPORT_PRESETS } = await import("../presets");
  return {
    reportId: row.reportId,
    name: row.name,
    presetKey: isPresetKey(row.presetKey) ? row.presetKey : null,
    presetLabel: isPresetKey(row.presetKey) ? REPORT_PRESETS[row.presetKey].label : null,
    analysisWindow: isAnalysisWindow(row.analysisWindow) ? row.analysisWindow : "7d",
    budgetUsd: Number(row.budgetUsd),
    maxMinutes: row.maxMinutes,
    site: row.site,
    stationIds: row.stationIds,
    questions: row.questions.map((q) => {
      const lib = q.libraryQuestion;
      return {
        questionId: q.questionId,
        position: q.position,
        kind: q.kind === "library" || q.kind === "personal" ? q.kind : "inline",
        text: lib?.text ?? q.personalQuestion?.text ?? q.inlineText ?? "",
        library:
          lib === null
            ? null
            : {
                key: lib.key,
                position: lib.position,
                section: lib.section,
                text: lib.text,
                kind: lib.kind,
                appliesToLabel: lib.appliesToLabel,
                appliesToEquipment: lib.appliesToEquipment,
                requiredRoles: lib.requiredRoles,
                minCoverage: Number(lib.minCoverage),
              },
      };
    }),
  };
}

export interface StationInScope {
  stationId: string;
  name: string;
}

export interface Scope {
  stations: StationInScope[];
  points: PointSeries[];
  pointsByStation: Map<string, PointSeries[]>;
  units: EquipmentUnit[];
  stationOfUnit: Map<string, string>;
  occupancyByStation: Map<string, OccupancySource>;
  outdoor: { avgF: number; highF: number; lowF: number; pointName: string } | null;
}

interface PointRow {
  point_id: bigint;
  station_id: bigint;
  equipment_id: bigint | null;
  name: string;
  point_role: string | null;
  unit: string | null;
  data_type: string;
  collection_interval_s: number | null;
  equipment_name: string | null;
  measurement: string | null;
  is_setpoint: boolean | null;
  is_status: boolean | null;
  is_command: boolean | null;
}

export async function resolveScope(def: DefinitionForRun, range: Interval): Promise<Scope> {
  const stationRows = await prisma.basStation.findMany({
    where: {
      siteId: def.site.siteId,
      ...(def.stationIds.length > 0 ? { stationId: { in: def.stationIds } } : {}),
    },
    select: { stationId: true, displayName: true, niagaraStationName: true },
    orderBy: { stationId: "asc" },
  });
  const stations = stationRows.map((s) => ({ stationId: s.stationId.toString(), name: s.displayName ?? s.niagaraStationName }));
  const stationIds = stationRows.map((s) => s.stationId);
  if (stationIds.length === 0) {
    return { stations, points: [], pointsByStation: new Map(), units: [], stationOfUnit: new Map(), occupancyByStation: new Map(), outdoor: null };
  }

  const pointRows = await prisma.$queryRaw<PointRow[]>`
    SELECT p.point_id, p.station_id, p.equipment_id,
           COALESCE(p.label, p.display_name, p.niagara_history_name) AS name,
           p.point_role, p.unit, p.data_type, p.collection_interval_s,
           e.name AS equipment_name,
           r.measurement, r.is_setpoint, r.is_status, r.is_command
      FROM bas_points p
      LEFT JOIN bas_equipment e ON e.equipment_id = p.equipment_id
      LEFT JOIN bas_point_roles r ON r.point_role = p.point_role
     WHERE p.station_id IN (${Prisma.join(stationIds)})
       AND p.is_active
     ORDER BY p.point_id`;

  const ids = pointRows.map((p) => p.point_id);
  const [series, gaps] = await Promise.all([loadSeries(ids, range), loadGaps(ids, range)]);
  const periodS = (range.end - range.start) / 1000;
  const covLike = (p: PointRow): boolean => {
    if (p.collection_interval_s === null) return false;
    const n = series.get(p.point_id.toString())?.readingCount ?? 0;
    return n > COV_LIKE_FACTOR * (periodS / p.collection_interval_s);
  };
  const covLikeIds = pointRows.filter(covLike).map((p) => p.point_id);
  const coverage = await computeCoverage(ids, range, covLikeIds);

  const points: PointSeries[] = pointRows.map((p) => {
    const id = p.point_id.toString();
    const s = series.get(id);
    return {
      pointId: id,
      name: p.name,
      role: p.point_role,
      measurement: p.measurement,
      isSetpoint: p.is_setpoint === true,
      isStatus: p.is_status === true,
      isCommand: p.is_command === true,
      unit: p.unit,
      dataType: p.data_type,
      equipmentId: p.equipment_id?.toString() ?? null,
      equipmentName: p.equipment_name,
      stationId: p.station_id.toString(),
      // Null for a change-of-value point, declared or detected: see the file comment.
      intervalS: covLike(p) ? null : p.collection_interval_s,
      coverage: coverage.get(id) ?? 0,
      carryIn: s?.carryIn ?? null,
      carryInAt: s?.carryInAt ?? null,
      samples: s?.samples ?? [],
      readingCount: s?.readingCount ?? 0,
      gaps: gaps.get(id) ?? [],
      bucketMs: s?.bucketMs ?? null,
    };
  });

  const pointsByStation = new Map<string, PointSeries[]>();
  for (const p of points) {
    const list = pointsByStation.get(p.stationId) ?? [];
    list.push(p);
    pointsByStation.set(p.stationId, list);
  }

  const equipmentRows = await prisma.basEquipment.findMany({
    where: { siteId: def.site.siteId },
    select: { equipmentId: true, name: true, equipType: true, parentEquipmentId: true },
    orderBy: { name: "asc" },
  });
  const units: EquipmentUnit[] = [];
  const stationOfUnit = new Map<string, string>();
  for (const e of equipmentRows) {
    const id = e.equipmentId.toString();
    const unitPoints = points.filter((p) => p.equipmentId === id);
    if (unitPoints.length === 0) continue;
    units.push({
      equipmentId: id,
      name: e.name,
      equipType: e.equipType,
      parentEquipmentId: e.parentEquipmentId?.toString() ?? null,
      points: unitPoints,
      ...classify(unitPoints),
    });
    stationOfUnit.set(id, unitPoints[0]!.stationId);
  }

  const occupancyByStation = await resolveOccupancy(def, stations, pointsByStation, range);

  const oat = points.find((p) => p.role === "outside_air_temp" && p.samples.length > 0);
  const outdoor =
    oat === undefined
      ? null
      : {
          avgF: round1(oat.samples.reduce((s, x) => s + x.v, 0) / oat.samples.length),
          highF: round1(Math.max(...oat.samples.map((x) => x.v))),
          lowF: round1(Math.min(...oat.samples.map((x) => x.v))),
          pointName: oat.name,
        };

  return { stations, points, pointsByStation, units, stationOfUnit, occupancyByStation, outdoor };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

interface SeriesData {
  carryIn: number | null;
  carryInAt: number | null;
  samples: Array<{ t: number; v: number }>;
  readingCount: number;
  bucketMs: number | null;
}

function numeric(num: number | null, bool: boolean | null): number | null {
  if (num !== null) return num;
  if (bool !== null) return bool ? 1 : 0;
  return null;
}

async function loadSeries(ids: bigint[], range: Interval): Promise<Map<string, SeriesData>> {
  const out = new Map<string, SeriesData>();
  if (ids.length === 0) return out;
  const start = new Date(range.start);
  const end = new Date(range.end);

  const counts = await prisma.$queryRaw<Array<{ point_id: bigint; n: number }>>`
    SELECT point_id, count(*)::int AS n FROM bas_readings
     WHERE point_id IN (${Prisma.join(ids)}) AND ts >= ${start} AND ts < ${end}
     GROUP BY point_id`;
  const countOf = new Map(counts.map((c) => [c.point_id.toString(), c.n]));

  const carry = await prisma.$queryRaw<Array<{ point_id: bigint; ts: Date; value_num: number | null; value_bool: boolean | null }>>`
    SELECT DISTINCT ON (point_id) point_id, ts, value_num, value_bool FROM bas_readings
     WHERE point_id IN (${Prisma.join(ids)}) AND ts < ${start}
     ORDER BY point_id, ts DESC`;
  const carryOf = new Map(carry.map((c) => [c.point_id.toString(), c]));

  const raw = ids.filter((id) => (countOf.get(id.toString()) ?? 0) <= DOWNSAMPLE_ABOVE);
  const bucketed = ids.filter((id) => (countOf.get(id.toString()) ?? 0) > DOWNSAMPLE_ABOVE);

  const samplesOf = new Map<string, Array<{ t: number; v: number }>>();
  if (raw.length > 0) {
    const rows = await prisma.$queryRaw<Array<{ point_id: bigint; ts: Date; value_num: number | null; value_bool: boolean | null }>>`
      SELECT point_id, ts, value_num, value_bool FROM bas_readings
       WHERE point_id IN (${Prisma.join(raw)}) AND ts >= ${start} AND ts < ${end}
       ORDER BY point_id, ts`;
    for (const r of rows) {
      const v = numeric(r.value_num, r.value_bool);
      if (v === null) continue;
      const key = r.point_id.toString();
      const list = samplesOf.get(key) ?? [];
      list.push({ t: r.ts.getTime(), v });
      samplesOf.set(key, list);
    }
  }

  const bucketMsOf = new Map<string, number>();
  if (bucketed.length > 0) {
    const bucketS = Math.ceil((range.end - range.start) / 1000 / DOWNSAMPLE_ABOVE);
    const rows = await prisma.$queryRaw<Array<{ point_id: bigint; b: Date; v: number | null }>>`
      SELECT point_id,
             date_bin(make_interval(secs => ${bucketS}), ts, ${start}) AS b,
             avg(COALESCE(value_num, CASE WHEN value_bool THEN 1 WHEN value_bool = false THEN 0 END))::float8 AS v
        FROM bas_readings
       WHERE point_id IN (${Prisma.join(bucketed)}) AND ts >= ${start} AND ts < ${end}
       GROUP BY point_id, b ORDER BY point_id, b`;
    for (const r of rows) {
      if (r.v === null) continue;
      const key = r.point_id.toString();
      const list = samplesOf.get(key) ?? [];
      list.push({ t: r.b.getTime(), v: r.v });
      samplesOf.set(key, list);
      bucketMsOf.set(key, bucketS * 1000);
    }
  }

  for (const id of ids) {
    const key = id.toString();
    const c = carryOf.get(key);
    const carryValue = c === undefined ? null : numeric(c.value_num, c.value_bool);
    out.set(key, {
      carryIn: carryValue,
      carryInAt: c === undefined || carryValue === null ? null : c.ts.getTime(),
      samples: samplesOf.get(key) ?? [],
      readingCount: countOf.get(key) ?? 0,
      bucketMs: bucketMsOf.get(key) ?? null,
    });
  }
  return out;
}

/**
 * Fraction of the period each point covers, 0..1. See the file comment.
 * `covLikeIds` are interval points to judge by the change-of-value rule.
 */
export async function computeCoverage(ids: bigint[], range: Interval, covLikeIds: bigint[] = []): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const start = new Date(range.start);
  const end = new Date(range.end);
  const periodS = (range.end - range.start) / 1000;
  // A sentinel so `IN (...)` is never empty.
  const covLike = covLikeIds.length === 0 ? [BigInt(-1)] : covLikeIds;

  const interval = await prisma.$queryRaw<Array<{ point_id: bigint; coverage: number }>>`
    WITH pts AS (
      SELECT p.point_id, GREATEST(3 * p.collection_interval_s, 900)::float8 AS hold_s
        FROM bas_points p
       WHERE p.point_id IN (${Prisma.join(ids)}) AND p.collection_interval_s IS NOT NULL
         AND p.point_id NOT IN (${Prisma.join(covLike)})
    ), r AS (
      SELECT x.point_id, x.ts,
             lead(x.ts) OVER (PARTITION BY x.point_id ORDER BY x.ts) AS next_ts
        FROM bas_readings x
        JOIN pts ON pts.point_id = x.point_id
       WHERE x.ts >= ${start} AND x.ts < ${end}
    ), g AS (
      SELECT r.point_id,
             coalesce(sum(GREATEST(0, EXTRACT(EPOCH FROM (r.next_ts - r.ts)) - pts.hold_s)), 0)::float8 AS inner_s,
             count(*)::int AS n,
             min(r.ts) AS first_ts,
             max(r.ts) AS last_ts
        FROM r JOIN pts ON pts.point_id = r.point_id
       GROUP BY r.point_id
    )
    SELECT pts.point_id,
           CASE WHEN g.n IS NULL THEN 0::float8
                ELSE GREATEST(0::float8, 1 - (
                       g.inner_s
                       + GREATEST(0, EXTRACT(EPOCH FROM (g.first_ts - ${start}::timestamptz)) - pts.hold_s)
                       + GREATEST(0, EXTRACT(EPOCH FROM (${end}::timestamptz - g.last_ts)) - pts.hold_s)
                     ) / ${periodS}::float8)
           END AS coverage
      FROM pts LEFT JOIN g ON g.point_id = pts.point_id`;
  for (const row of interval) out.set(row.point_id.toString(), Math.min(1, row.coverage));

  const cov = await prisma.$queryRaw<Array<{ point_id: bigint; coverage: number }>>`
    WITH pts AS (
      SELECT p.point_id FROM bas_points p
       WHERE p.point_id IN (${Prisma.join(ids)})
         AND (p.collection_interval_s IS NULL OR p.point_id IN (${Prisma.join(covLike)}))
    ), gaps AS (
      SELECT g.point_id,
             sum(EXTRACT(EPOCH FROM (LEAST(g.gap_end, ${end}::timestamptz) - GREATEST(g.gap_start, ${start}::timestamptz))))::float8 AS gap_s
        FROM bas_data_gaps g JOIN pts ON pts.point_id = g.point_id
       WHERE g.gap_end > ${start} AND g.gap_start < ${end}
       GROUP BY g.point_id
    )
    SELECT pts.point_id,
           CASE WHEN NOT EXISTS (SELECT 1 FROM bas_readings x WHERE x.point_id = pts.point_id AND x.ts < ${end})
                THEN 0::float8
                ELSE GREATEST(0::float8, 1 - coalesce(gaps.gap_s, 0) / ${periodS}::float8)
           END AS coverage
      FROM pts LEFT JOIN gaps ON gaps.point_id = pts.point_id`;
  for (const row of cov) out.set(row.point_id.toString(), Math.min(1, row.coverage));

  return out;
}

async function loadGaps(ids: bigint[], range: Interval): Promise<Map<string, Interval[]>> {
  const out = new Map<string, Interval[]>();
  if (ids.length === 0) return out;
  const rows = await prisma.basDataGap.findMany({
    where: { pointId: { in: ids }, gapEnd: { gt: new Date(range.start) }, gapStart: { lt: new Date(range.end) } },
    select: { pointId: true, gapStart: true, gapEnd: true },
  });
  for (const r of rows) {
    const key = r.pointId.toString();
    const list = out.get(key) ?? [];
    list.push({ start: r.gapStart.getTime(), end: r.gapEnd.getTime() });
    out.set(key, list);
  }
  return out;
}

const WEEKDAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function minuteText(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * Per station: a trended occupancy point if one exists (status first, the
 * command as a weaker second), else the building's manual hours, else none.
 * The report states which, per station.
 */
async function resolveOccupancy(
  def: DefinitionForRun,
  stations: StationInScope[],
  pointsByStation: Map<string, PointSeries[]>,
  range: Interval,
): Promise<Map<string, OccupancySource>> {
  const manualRows = await prisma.basSiteOccupancy.findMany({
    where: { siteId: def.site.siteId },
    orderBy: { weekday: "asc" },
  });
  const manual = manualRows.map((r) => ({ weekday: r.weekday, startMinute: r.startMinute, endMinute: r.endMinute }));
  const manualIntervals = manual.length === 0 ? null : occupiedFromSchedule(manual, range, def.site.timezone);
  const manualDetail = manual.map((r) => `${WEEKDAY_SHORT[r.weekday]} ${minuteText(r.startMinute)}-${minuteText(r.endMinute)}`).join(", ");

  const out = new Map<string, OccupancySource>();
  for (const station of stations) {
    const points = pointsByStation.get(station.stationId) ?? [];
    const point =
      points.find((p) => p.role === "occupancy_status" && (p.samples.length > 0 || p.carryIn !== null)) ??
      points.find((p) => p.role === "occupancy_cmd" && (p.samples.length > 0 || p.carryIn !== null));
    if (point !== undefined) {
      out.set(station.stationId, {
        stationId: station.stationId,
        stationName: station.name,
        kind: "point",
        intervals: occupiedFromSeries(point, range),
        detail: `${point.name} (${point.role === "occupancy_status" ? "occupancy status" : "occupancy command"} point)`,
      });
    } else if (manualIntervals !== null) {
      out.set(station.stationId, {
        stationId: station.stationId,
        stationName: station.name,
        kind: "manual",
        intervals: manualIntervals,
        detail: `the building's occupied hours: ${manualDetail}`,
      });
    } else {
      out.set(station.stationId, {
        stationId: station.stationId,
        stationName: station.name,
        kind: "none",
        intervals: null,
        detail: "no occupancy point trended and no occupied hours entered for the building",
      });
    }
  }
  return out;
}
