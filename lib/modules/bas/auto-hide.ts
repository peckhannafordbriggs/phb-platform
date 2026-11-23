import { Prisma } from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/db";
import { writeAuditEvents, type AuditEventInput } from "@/lib/audit";
import { BAS_MODULE_KEY } from "./constants";
import { decodeNiagaraName } from "./suggestions";
import {
  DUPLICATE_WINDOW_DAYS,
  NO_READINGS,
  findCandidatePairs,
  isAutoCopy,
  planDuplicateActions,
  type CandidatePair,
  type DuplicateAction,
  type HiddenSource,
  type PointVisibility,
  type SeriesStats,
} from "./duplicate-copies";
import type { AutoAssignTrigger } from "./auto-assign";

/**
 * Hiding dead duplicate copies: the database half (2026-11-23).
 *
 * The rules - which names pair, what "a dead copy" means in numbers, what the
 * plan may change - are in lib/modules/bas/duplicate-copies.ts and read no
 * database. This file reads one building, asks those rules, and writes.
 *
 * WHEN IT RUNS. The BAS Reports scheduler job (every fifteen minutes) runs it
 * for every building with more than one station, after the assignment pass
 * (runDuplicatePass, called from runAutoAssignPass); "Run assignment now" on
 * a station runs it for that station's pairs (hideDuplicateCopies with a
 * station). Same function, same rules.
 *
 * CHEAP. Per building: one query for the stations, one for the points' names
 * and state, and - only when some name pairs - ONE aggregate over the pairs'
 * readings for the last seven days. Never a query per point. A building where
 * nothing changes writes nothing: no transaction, no lock, no audit row.
 *
 * WHAT IT NEVER DOES, enforced in the UPDATE and not only in the plan, so a
 * person's change between the read and the write wins:
 *
 *   - write a point whose hidden_source is 'manual' (a person showed or hid
 *     it; manual beats auto, hidden or shown);
 *   - hide an uncollected point, or hide one as a copy of a point that is
 *     not collected and shown;
 *   - touch is_active. A hidden copy is still collected and still counted in
 *     every data-loss figure (B8.3's rule, 2026-11-20's amendment).
 *
 * ENVIRONMENT-FREE, like auto-assign.ts: the scheduler job imports it, and
 * nothing a job runs may reach lib/env.ts (tests/bas-reports-jobs-env.test.ts).
 */

const TRANSACTION = { timeout: 60_000, maxWait: 10_000 } as const;
const DAY_MS = 86_400_000;

type Db = Prisma.TransactionClient | typeof prisma;

/** One point the step hid or showed, with its partner, for the log and the result. */
export interface DuplicateChange {
  kind: "hidden" | "shown";
  pointId: string;
  stationId: string;
  stationName: string;
  pointName: string;
  /** Hidden: the live point. Shown: the point it had been hidden as a copy of. */
  partner: { pointId: string; stationId: string; stationName: string; pointName: string } | null;
  /** Hidden in a swap, or shown because its partner is now the flat one. */
  swap: boolean;
}

export interface DuplicatePass {
  buildings: number;
  changes: DuplicateChange[];
  failed: Array<{ siteId: string; siteName: string; error: string }>;
}

// ---------------------------------------------------------------------------
// The facts
// ---------------------------------------------------------------------------

interface StationRow {
  station_id: bigint;
  niagara_station_name: string;
  station_name: string;
}

interface PointRow {
  point_id: bigint;
  station_id: bigint;
  niagara_history_name: string;
  label: string | null;
  is_active: boolean;
  is_visible: boolean;
  hidden_source: string | null;
  hidden_reason: string | null;
  duplicate_of: bigint | null;
}

interface BuildingFacts {
  siteId: bigint;
  stations: Map<string, StationRow>;
  points: Map<string, PointRow>;
  pairs: CandidatePair[];
  state: Map<string, PointVisibility>;
}

const toHiddenSource = (v: string | null): HiddenSource | null => (v === "auto" || v === "manual" ? v : null);

async function loadBuilding(db: Db, siteId: bigint): Promise<BuildingFacts> {
  const [stations, points] = await Promise.all([
    db.$queryRaw<StationRow[]>`
      SELECT station_id, niagara_station_name,
             COALESCE(display_name, niagara_station_name) AS station_name
        FROM bas_stations WHERE site_id = ${siteId}
       ORDER BY station_id`,
    db.$queryRaw<PointRow[]>`
      SELECT p.point_id, p.station_id, p.niagara_history_name, p.label, p.is_active,
             p.is_visible, p.hidden_source, p.hidden_reason, p.duplicate_of
        FROM bas_points p
        JOIN bas_stations st ON st.station_id = p.station_id
       WHERE st.site_id = ${siteId}
       ORDER BY p.point_id`,
  ]);

  const collected = points.filter((p) => p.is_active);
  const pairs = findCandidatePairs(
    stations.map((s) => ({ stationId: s.station_id.toString(), niagaraStationName: s.niagara_station_name })),
    collected.map((p) => ({
      pointId: p.point_id.toString(),
      stationId: p.station_id.toString(),
      niagaraHistoryName: p.niagara_history_name,
    })),
  );
  const state = new Map<string, PointVisibility>(
    points.map((p) => [
      p.point_id.toString(),
      {
        pointId: p.point_id.toString(),
        collected: p.is_active,
        visible: p.is_visible,
        hiddenSource: toHiddenSource(p.hidden_source),
        hiddenReason: p.hidden_reason === "duplicate_copy" ? "duplicate_copy" : null,
        duplicateOf: p.duplicate_of?.toString() ?? null,
      },
    ]),
  );
  return {
    siteId,
    stations: new Map(stations.map((s) => [s.station_id.toString(), s])),
    points: new Map(points.map((p) => [p.point_id.toString(), p])),
    pairs,
    state,
  };
}

interface StatsRow {
  point_id: bigint;
  readings: number;
  distinct_values: number;
  mode_count: number;
  mode_value: string | null;
  min_value: number | null;
  max_value: number | null;
}

/**
 * ONE aggregate over the given points' readings in the window: count, distinct
 * values, the commonest value and how often, and the numeric range. A value is
 * whichever column the row filled - number, boolean or string - compared as
 * stored; a boolean counts 0/1 toward the range, a string toward nothing.
 * Rows with no value at all are not readings.
 */
export async function loadSeriesStats(db: Db, pointIds: readonly bigint[], now: Date): Promise<Map<string, SeriesStats>> {
  if (pointIds.length === 0) return new Map();
  const since = new Date(now.getTime() - DUPLICATE_WINDOW_DAYS * DAY_MS);
  const rows = await db.$queryRaw<StatsRow[]>`
    WITH v AS (
      SELECT r.point_id,
             COALESCE(r.value_num::text, r.value_bool::text, r.value_str) AS k,
             COALESCE(r.value_num, CASE WHEN r.value_bool THEN 1 WHEN NOT r.value_bool THEN 0 END)::float8 AS x
        FROM bas_readings r
       WHERE r.point_id IN (${Prisma.join(pointIds)})
         AND r.ts > ${since}
    ), c AS (
      SELECT point_id, k, count(*)::int AS n, min(x) AS x
        FROM v WHERE k IS NOT NULL
       GROUP BY point_id, k
    )
    SELECT point_id,
           sum(n)::int                           AS readings,
           count(*)::int                         AS distinct_values,
           max(n)::int                           AS mode_count,
           (array_agg(k ORDER BY n DESC, k))[1]  AS mode_value,
           min(x)::float8                        AS min_value,
           max(x)::float8                        AS max_value
      FROM c
     GROUP BY point_id`;
  return new Map(
    rows.map((r) => [
      r.point_id.toString(),
      {
        readings: r.readings,
        distinct: r.distinct_values,
        modeCount: r.mode_count,
        modeValue: r.mode_value,
        min: r.min_value,
        max: r.max_value,
      },
    ]),
  );
}

/** The points the plan needs numbers for: every paired point, and every former copy. */
function pointsToMeasure(facts: BuildingFacts): bigint[] {
  const ids = new Set<string>();
  for (const pair of facts.pairs) {
    ids.add(pair.a);
    ids.add(pair.b);
  }
  for (const point of facts.state.values()) if (isAutoCopy(point) && point.collected) ids.add(point.pointId);
  return [...ids].map((id) => BigInt(id));
}

/**
 * Keep the actions that concern one station: its own points, and the
 * partner of each. A swap's two halves always travel together, because each
 * names the other.
 */
function onStation(actions: DuplicateAction[], facts: BuildingFacts, stationId: string): DuplicateAction[] {
  const stationOf = (id: string | null) => (id === null ? null : (facts.points.get(id)?.station_id.toString() ?? null));
  return actions.filter((a) => {
    if (stationOf(a.pointId) === stationId) return true;
    const partner = a.kind === "hide" ? a.duplicateOf : a.previousDuplicateOf;
    return stationOf(partner) === stationId;
  });
}

async function plan(
  db: Db,
  siteId: bigint,
  stationId: string | null,
  now: Date,
): Promise<{ facts: BuildingFacts; stats: Map<string, SeriesStats>; actions: DuplicateAction[] }> {
  const facts = await loadBuilding(db, siteId);
  const ids = pointsToMeasure(facts);
  const stats = await loadSeriesStats(db, ids, now);
  const all = ids.length === 0 ? [] : planDuplicateActions(facts.pairs, stats, facts.state);
  return { facts, stats, actions: stationId === null ? all : onStation(all, facts, stationId) };
}

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

function describePoint(facts: BuildingFacts, id: string) {
  const row = facts.points.get(id)!;
  const station = facts.stations.get(row.station_id.toString());
  return {
    pointId: id,
    stationId: row.station_id.toString(),
    stationName: station?.station_name ?? row.station_id.toString(),
    niagaraHistoryName: row.niagara_history_name,
    pointName: decodeNiagaraName(row.niagara_history_name),
    label: row.label,
  };
}

function evidence(stats: Map<string, SeriesStats>, id: string) {
  const s = stats.get(id) ?? NO_READINGS;
  return {
    readings: s.readings,
    distinct: s.distinct,
    modeValue: s.modeValue,
    modeShare: s.readings === 0 ? null : Math.round((s.modeCount / s.readings) * 10_000) / 10_000,
    min: s.min,
    max: s.max,
  };
}

async function write(
  tx: Prisma.TransactionClient,
  facts: BuildingFacts,
  stats: Map<string, SeriesStats>,
  actions: DuplicateAction[],
  trigger: AutoAssignTrigger,
): Promise<DuplicateChange[]> {
  const actorEmployeeId = trigger.kind === "run_now" ? trigger.actorEmployeeId : null;
  const changes: DuplicateChange[] = [];
  const audits: AuditEventInput[] = [];
  const shownInSwap = new Set(actions.filter((a) => a.kind === "show" && a.reason === "swap").map((a) => a.pointId));

  for (const action of actions) {
    const point = describePoint(facts, action.pointId);
    if (action.kind === "show") {
      const done = await tx.$queryRaw<Array<{ point_id: bigint }>>`
        UPDATE bas_points
           SET is_visible = true, hidden_source = 'auto', hidden_reason = NULL, duplicate_of = NULL
         WHERE point_id = ${BigInt(action.pointId)}
           AND hidden_source = 'auto' AND hidden_reason = 'duplicate_copy' AND NOT is_visible
        RETURNING point_id`;
      if (done.length === 0) continue;
      const previous =
        action.previousDuplicateOf !== null && facts.points.has(action.previousDuplicateOf)
          ? describePoint(facts, action.previousDuplicateOf)
          : null;
      changes.push({
        kind: "shown",
        pointId: point.pointId,
        stationId: point.stationId,
        stationName: point.stationName,
        pointName: point.pointName,
        partner: previous,
        swap: action.reason === "swap",
      });
      audits.push({
        action: "bas.point_auto_shown",
        actorEmployeeId,
        moduleKey: BAS_MODULE_KEY,
        metadata: {
          ...point,
          trigger: trigger.kind,
          reason: action.reason,
          windowDays: DUPLICATE_WINDOW_DAYS,
          readings: evidence(stats, action.pointId),
          previousDuplicateOf: previous === null ? null : { ...previous, readings: evidence(stats, previous.pointId) },
        },
      });
      continue;
    }

    const live = describePoint(facts, action.duplicateOf);
    const done = await tx.$queryRaw<Array<{ point_id: bigint }>>`
      UPDATE bas_points p
         SET is_visible = false, hidden_source = 'auto', hidden_reason = 'duplicate_copy',
             duplicate_of = ${BigInt(action.duplicateOf)}
       WHERE p.point_id = ${BigInt(action.pointId)}
         AND p.is_active AND p.is_visible
         AND p.hidden_source IS DISTINCT FROM 'manual'
         AND EXISTS (SELECT 1 FROM bas_points l
                      WHERE l.point_id = ${BigInt(action.duplicateOf)} AND l.is_active AND l.is_visible)
      RETURNING p.point_id`;
    if (done.length === 0) continue;
    const swap = action.swap && shownInSwap.has(action.duplicateOf);
    changes.push({
      kind: "hidden",
      pointId: point.pointId,
      stationId: point.stationId,
      stationName: point.stationName,
      pointName: point.pointName,
      partner: live,
      swap,
    });
    audits.push({
      action: "bas.point_auto_hidden",
      actorEmployeeId,
      moduleKey: BAS_MODULE_KEY,
      metadata: {
        ...point,
        trigger: trigger.kind,
        reason: "duplicate_copy",
        rule: action.rule,
        swap,
        windowDays: DUPLICATE_WINDOW_DAYS,
        readings: evidence(stats, action.pointId),
        duplicateOf: { ...live, readings: evidence(stats, live.pointId) },
        // So the row can never be read as "and stopped collecting it".
        collected: true,
      },
    });
  }
  await writeAuditEvents(tx, audits);
  return changes;
}

// ---------------------------------------------------------------------------
// The entry points
// ---------------------------------------------------------------------------

/**
 * One building, or one station's pairs within it. Plans outside any
 * transaction; only when there is something to change does it lock the
 * building's stations (in id order), read again, plan again from what it read
 * and write. Two passes on one building - the scheduler and a press of the
 * button - run one after the other, and the second plans from the first.
 */
export async function hideDuplicateCopies(
  scope: { siteId: bigint; stationId?: bigint },
  trigger: AutoAssignTrigger,
  now: Date = new Date(),
): Promise<DuplicateChange[]> {
  const stationId = scope.stationId?.toString() ?? null;
  const first = await plan(prisma, scope.siteId, stationId, now);
  if (first.actions.length === 0) return [];

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT station_id FROM bas_stations WHERE site_id = ${scope.siteId}
       ORDER BY station_id FOR UPDATE`;
    const fresh = await plan(tx, scope.siteId, stationId, now);
    if (fresh.actions.length === 0) return [];
    return write(tx, fresh.facts, fresh.stats, fresh.actions, trigger);
  }, TRANSACTION);
}

/**
 * Every building with more than one station, once. A building that fails is
 * reported and the others still run; the scheduler exits non-zero if any did.
 */
export async function runDuplicatePass(now: Date = new Date()): Promise<DuplicatePass> {
  const buildings = await prisma.$queryRaw<Array<{ site_id: bigint; site_name: string }>>`
    SELECT st.site_id, s.name AS site_name
      FROM bas_stations st
      JOIN bas_sites s ON s.site_id = st.site_id
     GROUP BY st.site_id, s.name
    HAVING count(*) > 1
     ORDER BY st.site_id`;
  const pass: DuplicatePass = { buildings: buildings.length, changes: [], failed: [] };
  for (const building of buildings) {
    try {
      pass.changes.push(...(await hideDuplicateCopies({ siteId: building.site_id }, { kind: "scheduler" }, now)));
    } catch (error) {
      pass.failed.push({
        siteId: building.site_id.toString(),
        siteName: building.site_name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return pass;
}

/** Per station: how many it hid and showed, for the assignment result. */
export function countChangesByStation(changes: readonly DuplicateChange[]): Map<string, { hidden: number; shown: number }> {
  const counts = new Map<string, { hidden: number; shown: number }>();
  for (const change of changes) {
    const entry = counts.get(change.stationId) ?? { hidden: 0, shown: 0 };
    if (change.kind === "hidden") entry.hidden += 1;
    else entry.shown += 1;
    counts.set(change.stationId, entry);
  }
  return counts;
}
