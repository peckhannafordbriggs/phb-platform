import { parsePointName } from "./name-prefix";
import { decodeNiagaraName } from "./suggestions";
import type { HiddenSource } from "./types";

/**
 * Dead duplicate copies: the rules, and only the rules (2026-11-23).
 *
 * CEI_JCI_N2 holds `AHU_7/DA_SAP`, `AHU_7/MA_T`, `AHU_7/OA_H` ... - the JACE's
 * local histories of points on a controller it no longer reaches - and each
 * logs one value for ever. The same measurements arrive live through the
 * via-parent station CEI_AHU_7 as `DA_SAP`, `MA_T`, `OA_H`. A person should
 * never have to hide the dead half by hand; the scheduler's point pass does it
 * (lib/modules/bas/auto-hide.ts) from THIS file, which reads no database:
 *
 *   1. PAIRS, by name, within one building (`findCandidatePairs`):
 *        prefix - `AHU_7/DA_SAP` on one station and `DA_SAP` on another
 *                 station whose name ends with the prefix, separators and
 *                 case ignored, on a token boundary (`CEI_AHU_7` ends with
 *                 `AHU_7`; `CEI_AHU_17` does not). The prefix is the
 *                 equipment the name writes, as parsePointName finds it for
 *                 the assignment pass.
 *        exact  - the same name, separators and case ignored, on two
 *                 stations, WHEN THE NAME CARRIES ITS EQUIPMENT
 *                 (`V4_22/SpaceTemp`, `AHU_7/DA_T`). A bare name - `DA_SAP`,
 *                 `OA_H`, `OAT` - is shared by every unit: CEI_AHU_7 and
 *                 CEI_AHU_8 are sibling stations of one building and both
 *                 hold the same bare names, so an air handler that sits off
 *                 for a week would otherwise have its real, flat points
 *                 hidden as "copies" of the other one's. CHOSEN, narrower
 *                 than the request; the prefix rule covers the CEI case.
 *      A pair is unordered: which half is the copy is decided by the numbers.
 *
 *   2. THE DEAD-COPY TEST, numbers only, over the last seven days (`judgePair`):
 *      one half is FLAT - one distinct value, or 99% of its readings one
 *      value - and the other is LIVE - at least 10 readings, more than 3
 *      distinct values and a non-zero range. Then the flat half is a copy of
 *      the live one. Both flat, both varying, or either half short of
 *      readings: nothing. Two live trends with one name are a question for a
 *      person (Nathan), not a duplicate.
 *
 *   3. THE PLAN (`planDuplicateActions`): hide a flat half as a copy of its
 *      live partner; show a copy again when it varies (and, if its partner is
 *      now flat, hide that instead - the swap). Never a point a person set,
 *      hidden or shown (`hidden_source = 'manual'`), never an uncollected one,
 *      and never as a copy of a point that is not itself shown.
 *
 * Every threshold is below, with why. Change one here and the tests in
 * tests/bas-duplicate-copies.test.ts say what moved.
 */

// ---------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------

/** The window the test reads, ending at the pass. All of a point's data, when it has less. */
export const DUPLICATE_WINDOW_DAYS = 7;

/** A flat half: one value in at least this share of its readings (99%). */
export const FLAT_SHARE = 0.99;

/**
 * A flat half needs at least this many readings too. CHOSEN, not in the
 * request: one or two readings that agree are not evidence of anything, and
 * a CEI copy logs every 30 minutes - 336 a week - so a real copy clears it
 * by a mile. A change-of-value copy that never changes logs almost nothing
 * and is left for a person.
 */
export const FLAT_MIN_READINGS = 10;

/** A live half: at least this many readings... */
export const LIVE_MIN_READINGS = 10;
/** ...more than this many distinct values (so at least 4), and a range above zero (isLive). */
export const LIVE_MORE_THAN_DISTINCT = 3;

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Case and every separator ignored: `AHU_7`, `ahu-7`, `AHU 7` and `AHU7` are one key. */
export function nameKey(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Whether a station's name ends with an equipment prefix, separators and case
 * ignored, on a token boundary. `CEI_AHU_7` ends with `AHU_7` and `AHU7`;
 * `CEI_AHU_17` and `CEIAHU_7` do not end with `AHU_7` (the first is another
 * unit; in the second `AHU` is not a token of its own). A prefix with no
 * letter in it (`7`) names no equipment and matches nothing.
 */
export function stationEndsWithPrefix(stationName: string, prefix: string): boolean {
  const want = nameKey(prefix);
  if (want.length === 0 || !/[A-Z]/.test(want)) return false;
  const tokens = stationName.toUpperCase().split(/[^A-Z0-9]+/).filter((t) => t.length > 0);
  for (let start = tokens.length - 1; start >= 0; start -= 1) {
    const suffix = tokens.slice(start).join("");
    if (suffix === want) return true;
    if (suffix.length > want.length) return false;
  }
  return false;
}

/**
 * Whether a prefix names one unit: letters and a number (`AHU_7`, `V4_22`).
 * `Points/OAT` names a folder, not a unit - the assignment's prefix table
 * draws the same line (name-prefix.ts, *Letters alone are a word*).
 */
export function namesUnit(prefix: string | null): boolean {
  return prefix !== null && /[A-Za-z]/.test(prefix) && /\d/.test(prefix);
}

// ---------------------------------------------------------------------------
// Pairs
// ---------------------------------------------------------------------------

export interface DuplicateStation {
  stationId: string;
  /** Niagara's name for the station: what a via-parent folder is called. */
  niagaraStationName: string;
}

export interface DuplicatePoint {
  pointId: string;
  stationId: string;
  /** bas_points.niagara_history_name, as stored (oBIX-escaped). */
  niagaraHistoryName: string;
}

export type PairRule = "prefix" | "exact";

/** Two points on two stations of one building that name the same measurement. `a.pointId < b.pointId`. */
export interface CandidatePair {
  a: string;
  b: string;
  rule: PairRule;
}

const byId = (x: string, y: string) => {
  const dx = BigInt(x);
  const dy = BigInt(y);
  return dx < dy ? -1 : dx > dy ? 1 : 0;
};

function ordered(x: string, y: string, rule: PairRule): CandidatePair {
  return byId(x, y) <= 0 ? { a: x, b: y, rule } : { a: y, b: x, rule };
}

/**
 * Every candidate pair among the points of ONE building's stations. A pair
 * found by both rules is reported once, as `prefix` - the stronger evidence,
 * because the station is named for the unit. Deterministic: sorted by the
 * lower point id, then the higher.
 */
export function findCandidatePairs(
  stations: readonly DuplicateStation[],
  points: readonly DuplicatePoint[],
): CandidatePair[] {
  const pairs = new Map<string, CandidatePair>();
  const add = (x: string, y: string, rule: PairRule) => {
    const pair = ordered(x, y, rule);
    const key = `${pair.a}:${pair.b}`;
    const existing = pairs.get(key);
    if (existing === undefined || (existing.rule === "exact" && rule === "prefix")) pairs.set(key, pair);
  };

  // Each point's whole name, by key, per station; and, for the exact rule,
  // only the names that carry their equipment.
  const byStationAndKey = new Map<string, Map<string, string[]>>();
  const byKey = new Map<string, DuplicatePoint[]>();
  for (const point of points) {
    const decoded = decodeNiagaraName(point.niagaraHistoryName);
    const key = nameKey(decoded);
    if (key.length === 0) continue;
    let station = byStationAndKey.get(point.stationId);
    if (station === undefined) byStationAndKey.set(point.stationId, (station = new Map()));
    station.set(key, [...(station.get(key) ?? []), point.pointId]);
    if (namesUnit(parsePointName(decoded).prefix)) byKey.set(key, [...(byKey.get(key) ?? []), point]);
  }

  // Exact: one key, naming its equipment, on two stations.
  for (const group of byKey.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        if (group[i]!.stationId !== group[j]!.stationId) add(group[i]!.pointId, group[j]!.pointId, "exact");
      }
    }
  }

  // Prefix: `<prefix>/<tail>` here, `<tail>` on a station named for the prefix.
  for (const point of points) {
    const parsed = parsePointName(decodeNiagaraName(point.niagaraHistoryName));
    if (parsed.prefix === null || !namesUnit(parsed.prefix)) continue;
    const tail = nameKey(parsed.tail);
    if (tail.length === 0) continue;
    for (const station of stations) {
      if (station.stationId === point.stationId) continue;
      if (!stationEndsWithPrefix(station.niagaraStationName, parsed.prefix)) continue;
      for (const other of byStationAndKey.get(station.stationId)?.get(tail) ?? []) add(point.pointId, other, "prefix");
    }
  }

  return [...pairs.values()].sort((x, y) => byId(x.a, y.a) || byId(x.b, y.b));
}

// ---------------------------------------------------------------------------
// The dead-copy test
// ---------------------------------------------------------------------------

/**
 * One point's readings over the window, from ONE aggregate query per building
 * (auto-hide.ts). `distinct` and `modeCount` count values as stored - a number,
 * a boolean or a string - and `min` / `max` are numeric (a boolean as 0/1, a
 * string as nothing).
 */
export interface SeriesStats {
  readings: number;
  distinct: number;
  /** How many readings hold the commonest value. */
  modeCount: number;
  /** The commonest value, as text (`0`, `70.5`, `false`). */
  modeValue: string | null;
  min: number | null;
  max: number | null;
}

export const NO_READINGS: SeriesStats = { readings: 0, distinct: 0, modeCount: 0, modeValue: null, min: null, max: null };

/** One value, or 99% one value, over at least FLAT_MIN_READINGS readings. */
export function isFlat(s: SeriesStats): boolean {
  if (s.readings < FLAT_MIN_READINGS) return false;
  return s.distinct === 1 || s.modeCount / s.readings >= FLAT_SHARE;
}

/** At least 10 readings, more than 3 distinct values and a non-zero range. */
export function isLive(s: SeriesStats): boolean {
  return (
    s.readings >= LIVE_MIN_READINGS &&
    s.distinct > LIVE_MORE_THAN_DISTINCT &&
    s.min !== null &&
    s.max !== null &&
    s.max - s.min > 0
  );
}

export type PairVerdict =
  | { kind: "copy"; copy: string; live: string }
  | { kind: "none"; why: "both_flat" | "both_vary" | "not_clear" };

/** The numbers decide which half is the copy, or that neither is. */
export function judgePair(pair: CandidatePair, stats: ReadonlyMap<string, SeriesStats>): PairVerdict {
  const a = stats.get(pair.a) ?? NO_READINGS;
  const b = stats.get(pair.b) ?? NO_READINGS;
  const [flatA, flatB, liveA, liveB] = [isFlat(a), isFlat(b), isLive(a), isLive(b)];
  if (flatA && liveB) return { kind: "copy", copy: pair.a, live: pair.b };
  if (flatB && liveA) return { kind: "copy", copy: pair.b, live: pair.a };
  if (flatA && flatB) return { kind: "none", why: "both_flat" };
  if (liveA && liveB) return { kind: "none", why: "both_vary" };
  return { kind: "none", why: "not_clear" };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export type { HiddenSource };

/** A point's state as the pass reads it. */
export interface PointVisibility {
  pointId: string;
  collected: boolean;
  visible: boolean;
  hiddenSource: HiddenSource | null;
  hiddenReason: "duplicate_copy" | null;
  duplicateOf: string | null;
}

export type DuplicateAction =
  | {
      kind: "hide";
      pointId: string;
      duplicateOf: string;
      rule: PairRule;
      /** True when the live partner is a former copy shown again in the same plan. */
      swap: boolean;
    }
  | {
      kind: "show";
      pointId: string;
      /** The point it was hidden as a copy of. */
      previousDuplicateOf: string | null;
      /** `swap`: its partner is now the flat one. `readings_vary`: it varies again. */
      reason: "swap" | "readings_vary";
    };

/** The platform hid it as a copy, and may undo that. */
export const isAutoCopy = (p: PointVisibility): boolean =>
  p.hiddenSource === "auto" && p.hiddenReason === "duplicate_copy" && !p.visible;

/** May the platform hide it now? Collected, not a person's, and shown. */
const mayHide = (p: PointVisibility | undefined): p is PointVisibility =>
  p !== undefined && p.collected && p.hiddenSource !== "manual" && p.visible;

/**
 * What to change, from the pairs, the numbers and the current state.
 *
 *   - A former copy that varies again is shown ("its reason is gone"): a
 *     hidden point whose note says it reads a constant must not be varying.
 *     If its partner is now flat and may be hidden, that partner is hidden as
 *     a copy of it in the same plan: the swap.
 *   - A flat half is hidden as a copy of its live partner when the copy may
 *     be hidden and the partner is shown (or is being shown by this plan). A
 *     flat point with several live partners takes the first by rule (prefix
 *     before exact), then by point id.
 *   - A point already hidden as a copy, still flat, stays as it is - even if
 *     a different live partner turns up. One decision, kept.
 *
 * Each point is in at most one action. Sorted: shows first (so a swap's
 * partner is visible before its copy is hidden), then by point id.
 */
export function planDuplicateActions(
  pairs: readonly CandidatePair[],
  stats: ReadonlyMap<string, SeriesStats>,
  state: ReadonlyMap<string, PointVisibility>,
): DuplicateAction[] {
  const shows = new Map<string, DuplicateAction & { kind: "show" }>();
  const hides = new Map<string, DuplicateAction & { kind: "hide" }>();

  // 1. Former copies whose own readings vary again.
  for (const point of state.values()) {
    if (!isAutoCopy(point) || !point.collected) continue;
    if (!isLive(stats.get(point.pointId) ?? NO_READINGS)) continue;
    shows.set(point.pointId, {
      kind: "show",
      pointId: point.pointId,
      previousDuplicateOf: point.duplicateOf,
      reason: "readings_vary",
    });
  }

  // 2. Each flat half, against its live partners, strongest first.
  const rank = (rule: PairRule) => (rule === "prefix" ? 0 : 1);
  const verdicts = pairs
    .map((pair) => ({ pair, verdict: judgePair(pair, stats) }))
    .filter((v): v is { pair: CandidatePair; verdict: PairVerdict & { kind: "copy" } } => v.verdict.kind === "copy")
    .sort(
      (x, y) =>
        byId(x.verdict.copy, y.verdict.copy) ||
        rank(x.pair.rule) - rank(y.pair.rule) ||
        byId(x.verdict.live, y.verdict.live),
    );

  for (const { pair, verdict } of verdicts) {
    if (hides.has(verdict.copy) || shows.has(verdict.copy)) continue;
    const copy = state.get(verdict.copy);
    const live = state.get(verdict.live);
    if (!mayHide(copy) || live === undefined || !live.collected) continue;
    // A live partner is shown, or is a former copy this plan shows again.
    const liveShown = live.visible || shows.has(live.pointId);
    if (!liveShown || hides.has(live.pointId)) continue;
    const swap = shows.has(live.pointId);
    if (swap) shows.get(live.pointId)!.reason = "swap";
    hides.set(verdict.copy, { kind: "hide", pointId: verdict.copy, duplicateOf: verdict.live, rule: pair.rule, swap });
  }

  return [
    ...[...shows.values()].sort((x, y) => byId(x.pointId, y.pointId)),
    ...[...hides.values()].sort((x, y) => byId(x.pointId, y.pointId)),
  ];
}
