import { DEFAULT_MIN_COVERAGE, type LibrarySection } from "../../library";
import { unitSymbol } from "../../../units";
import {
  HOUR_MS,
  busiestWindow,
  describeDuration,
  holdMsFor,
  hourOfDayProfile,
  normalise,
  persistence,
  segments,
  totalMs,
  whereTrue,
  type Persistence,
  type Segment,
} from "../series";
import type { EquipmentUnit, Interval, PointSeries, Priority, RawFinding } from "../types";

/**
 * What questions 6-18 share (Reports, Phase 5): the context a question is
 * run in, the shape it returns, and the small readings every one of them
 * needs - which point on a unit plays a role, whether a valve is open,
 * how a finding is worded.
 *
 * The questions are pure functions over the units `decideQuestion` already
 * qualified (every required role present at the coverage floor, none of
 * them a point Data Health excluded). Each one STILL skips excluded points
 * itself, so a function called on its own can never judge a dead sensor.
 */

export interface AnalysisContext {
  range: Interval;
  timezone: string;
  /** Point ids Data Health flagged; never read. */
  excluded: ReadonlySet<string>;
  /** The occupied hours of the unit's station, or null when the station has no occupancy source. */
  occupiedFor(unit: EquipmentUnit): Interval[] | null;
  /** The points on the unit's station, for a building-level role (outside air temperature). */
  stationPointsFor(unit: EquipmentUnit): PointSeries[];
}

/**
 * What a question returns. `metrics` always carries `judged` (units the
 * question actually ran over) and the headline figures its one-line answer
 * prints when it raised nothing - so "ran and found nothing" is a fact
 * about this period (wording.ts `positiveAnswer`).
 */
export interface QuestionAnalysis {
  findings: RawFinding[];
  skipped: Array<{ name: string; reason: string }>;
  metrics: Record<string, unknown> & { judged: number };
}

export type QuestionFn = (units: EquipmentUnit[], ctx: AnalysisContext) => QuestionAnalysis;

/** The first point on the unit carrying any of `roles` (in that order), not excluded; or, for a building-level role, one on the station. */
export function pick(
  unit: EquipmentUnit,
  roles: readonly string[],
  ctx: AnalysisContext,
  options: { station?: boolean } = {},
): PointSeries | null {
  // Two passes: first a point at the spec's coverage floor, in role order,
  // then any. So "RAT or MAT" takes a covered RAT over a half-trended MAT,
  // the same alternative the inventory's Step 2 accepted.
  for (const floor of [DEFAULT_MIN_COVERAGE, 0]) {
    const usable = (p: PointSeries, role: string) => p.role === role && !ctx.excluded.has(p.pointId) && p.coverage >= floor;
    for (const role of roles) {
      const own = best(unit.points.filter((p) => usable(p, role)));
      if (own !== null) return own;
    }
    if (options.station === true) {
      for (const role of roles) {
        const shared = best(ctx.stationPointsFor(unit).filter((p) => usable(p, role)));
        if (shared !== null) return shared;
      }
    }
  }
  return null;
}

/** Every point on the unit carrying any of `roles`, not excluded. */
export function pickAll(unit: EquipmentUnit, roles: readonly string[], ctx: AnalysisContext): PointSeries[] {
  return unit.points.filter((p) => p.role !== null && roles.includes(p.role) && !ctx.excluded.has(p.pointId));
}

/** Of several points with one role, the best covered; ties by id, so the choice is stable. */
function best(points: PointSeries[]): PointSeries | null {
  if (points.length === 0) return null;
  return [...points].sort((a, b) => b.coverage - a.coverage || a.pointId.localeCompare(b.pointId))[0]!;
}

/** The point's held segments over the period. */
export function held(p: PointSeries, range: Interval): Segment[] {
  return segments(p, range, holdMsFor(p));
}

/**
 * A command or position as percent. A boolean point (on/off relay) reads
 * 1 as 100%; anything else is taken as already in percent, which is how
 * every valve and damper on the live estate is trended. A point trended
 * as a 0-1 fraction would read as never open - the safe direction.
 */
export function percentSegments(p: PointSeries, range: Interval): Segment[] {
  const scale = p.dataType === "bool" ? 100 : 1;
  return held(p, range).map((s) => ({ ...s, v: s.v * scale }));
}

/** Where an on/off (or staged) point is on: at least stage 1. */
export function onIntervals(p: PointSeries, range: Interval): Interval[] {
  return whereTrue(held(p, range), (v) => v >= 0.5);
}

/** Where a valve or damper is open: above `pct` percent. */
export function openIntervals(p: PointSeries, range: Interval, pct: number): Interval[] {
  return whereTrue(percentSegments(p, range), (v) => v > pct);
}

/** Where ANY of the points is on (stages, compressors) or open (valves), as one interval list. */
export function anyActive(points: PointSeries[], range: Interval, valvePct: number): Interval[] {
  const all: Interval[] = [];
  for (const p of points) {
    const isPosition = p.role !== null && (p.role.endsWith("_valve_cmd") || p.role.endsWith("_damper_cmd"));
    all.push(...(isPosition ? openIntervals(p, range, valvePct) : onIntervals(p, range)));
  }
  return normalise(all);
}

/** A temperature point trended in Celsius is not judged on Fahrenheit bands. Null is taken as Fahrenheit, as Space Comfort does. */
export function isCelsius(p: PointSeries): boolean {
  return p.unit !== null && /celsius|°c|degc/i.test(p.unit);
}

/** Celsius temperature points among `points`, by name, for the skipped line. */
export function celsiusIn(points: Array<PointSeries | null>): string | null {
  const c = points.filter((p): p is PointSeries => p !== null && isCelsius(p));
  return c.length === 0 ? null : `${c.map((p) => p.name).join(", ")} trended in °C; judged in °F only`;
}

export function fmtF(value: number): string {
  return `${value.toFixed(1)} ${unitSymbol("fahrenheit") ?? "°F"}`;
}

export function fmtDeltaF(value: number): string {
  return `${value.toFixed(1)} ${unitSymbol("fahrenheit") ?? "°F"}`;
}

export function fmtNumber(value: number, unit: string | null): string {
  const symbol = unitSymbol(unit);
  const text = Math.abs(value) >= 100 ? String(Math.round(value)) : value.toFixed(Math.abs(value) >= 10 ? 0 : 2).replace(/\.?0+$/, "");
  return symbol === null ? text : `${text} ${symbol}`;
}

/** Hours to one decimal, for metrics. */
export function hoursOf(ms: number): number {
  return Math.round((ms / HOUR_MS) * 10) / 10;
}

/** Whole percent of `part` in `whole`; 0 when whole is empty. */
export function percentOf(part: number, whole: number): number {
  return whole <= 0 ? 0 : Math.round((part / whole) * 100);
}

export interface FindingSpec {
  questionKey: string;
  section: LibrarySection;
  unit: EquipmentUnit;
  issueCode: string;
  issue: string;
  priority: Priority;
  actual: string;
  expected: string;
  /** The intervals the condition held, which give the duration and the time of day. */
  intervals: Interval[];
  timezone: string;
  percent?: number;
  extra?: Record<string, unknown>;
}

/** A finding on a unit, its duration and time of day from the intervals the condition held. */
export function unitFinding(spec: FindingSpec): RawFinding {
  const ms = totalMs(spec.intervals);
  return {
    questionKey: spec.questionKey,
    section: spec.section,
    subjectKey: `equipment:${spec.unit.equipmentId}`,
    equipmentId: spec.unit.equipmentId,
    subjectName: spec.unit.name,
    issueCode: spec.issueCode,
    issue: spec.issue,
    priority: spec.priority,
    evidence: {
      actual: spec.actual,
      expected: spec.expected,
      duration: describeDuration(ms),
      durationMs: ms,
      ...(spec.percent === undefined ? {} : { percent: spec.percent }),
      when: busiestWindow(hourOfDayProfile(spec.intervals, spec.timezone)) ?? "across the day",
      hours: hoursOf(ms),
      ...spec.extra,
    },
  };
}

/** The spec's persistence filter over the condition's intervals. */
export function persists(intervals: Interval[], timezone: string): Persistence {
  return persistence(intervals, timezone);
}

/** "on 3 days" / "on 1 day". */
export function onDays(days: number): string {
  return `on ${days} day${days === 1 ? "" : "s"}`;
}

/** The unit with the largest value of `by`, for a headline; ties by name. Null when there are none. */
export function worstOf<T extends { name: string }>(rows: T[], by: (row: T) => number): T | null {
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => by(b) - by(a) || a.name.localeCompare(b.name))[0]!;
}
