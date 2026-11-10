import {
  MIN_READINGS,
  STATE_DATA_TYPES,
  STATE_MEASUREMENTS,
  thresholdFor,
} from "../../../plausibility";
import { unitSymbol } from "../../../units";
import {
  HOUR_MS,
  MINUTE_MS,
  busiestWindow,
  describeDuration,
  holdMsFor,
  hourOfDayProfile,
  persistence,
  segments,
  totalMs,
  whereTrue,
} from "../series";
import type { Interval, PointSeries, RawFinding } from "../types";

/**
 * Question 20, Data Health (Reports, Phase 2): "Which points went offline,
 * stopped trending, flat-lined, or read out of physical range?"
 *
 * The spec's rule that shapes everything here: "A flat-lined, stuck, or out
 * of range reading is a data problem. Report it only under Data Health, never
 * as an equipment failure." So this runs FIRST, and every point it flags is
 * handed back as `excluded` - the equipment questions never see a reading
 * from a point this file has called a data problem. A dead sensor at -40
 * becomes one Data Health row, not a comfort complaint about a freezing room.
 *
 * Four problems, each judged over the report period only:
 *
 *   offline        an interval trend with no reading in the period
 *   stale          an interval trend whose last reading is well before the
 *                  period's end (six intervals or two hours, whichever is more)
 *   flat           a measured quantity holding one value longer than the
 *                  plausibility threshold for its kind - the same table
 *                  Collection Health judges with, over this period's readings
 *   out_of_range   a reading outside what the quantity can physically be,
 *                  for at least 30 minutes or on two days
 *
 * A change-of-value trend is never offline or stale for having no readings -
 * no change is its normal week - and is judged flat only through the
 * plausibility rules it already answers to. Every finding here is Watch:
 * "go and look", never a confirmed fault, the same stance as Collection
 * Health's card.
 */

export const DATA_HEALTH_QUESTION = "q20_data_health";

interface PhysicalRange {
  roles: readonly string[] | ((role: string) => boolean);
  min: number;
  max: number;
  /** Only applied when the unit is this kind, read from the unit string. */
  unit: "fahrenheit" | "percent" | "inwc" | "ppm";
  label: string;
}

/**
 * What a quantity can physically read. Deliberately wide: this catches a
 * sensor reporting open-circuit (-40 on a room thermostat), not a hot room.
 * Temperatures apply only to points whose unit reads as Fahrenheit, which is
 * every temperature on the live estate; a Celsius point is not judged rather
 * than judged on the wrong scale.
 */
export const PHYSICAL_RANGES: readonly PhysicalRange[] = [
  { roles: ["zone_temp", "return_air_temp"], min: 35, max: 110, unit: "fahrenheit", label: "a room or return air temperature" },
  {
    roles: ["supply_air_temp", "discharge_air_temp", "mixed_air_temp", "preheat_air_temp"],
    min: 20,
    max: 160,
    unit: "fahrenheit",
    label: "an air temperature",
  },
  { roles: ["outside_air_temp"], min: -50, max: 130, unit: "fahrenheit", label: "an outdoor temperature" },
  { roles: (r) => /^(chw|hw|cw)_/.test(r) && r.endsWith("_temp"), min: 20, max: 250, unit: "fahrenheit", label: "a water temperature" },
  { roles: (r) => r.includes("humidity"), min: 0, max: 100, unit: "percent", label: "a relative humidity" },
  {
    roles: (r) => r.endsWith("_damper_cmd") || r.endsWith("_valve_cmd") || r.endsWith("_speed"),
    min: 0,
    max: 100,
    unit: "percent",
    label: "a position or speed",
  },
  { roles: ["duct_static_pressure"], min: -5, max: 10, unit: "inwc", label: "a duct static pressure" },
  { roles: ["space_co2"], min: 0, max: 5000, unit: "ppm", label: "a CO2 concentration" },
];

function unitIs(unit: string | null, kind: PhysicalRange["unit"]): boolean {
  if (unit === null) return false;
  const u = unit.toLowerCase();
  switch (kind) {
    case "fahrenheit":
      return /fahr|degf|°f|\bf\b/.test(u);
    case "percent":
      return /percent|%/.test(u);
    case "inwc":
      return /inch|inwc|in_?h2o|inh₂o|water/.test(u);
    case "ppm":
      return /ppm/.test(u);
  }
}

export function physicalRangeFor(role: string | null, unit: string | null): PhysicalRange | null {
  if (role === null) return null;
  for (const r of PHYSICAL_RANGES) {
    const matches = typeof r.roles === "function" ? r.roles(role) : r.roles.includes(role);
    if (matches && unitIs(unit, r.unit)) return r;
  }
  return null;
}

function fmt(value: number, unit: string | null): string {
  const symbol = unitSymbol(unit);
  const text = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return symbol === null ? text : `${text} ${symbol}`;
}

function localTime(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
}

/** Is this a measured quantity the flat-line rule may judge? The same gates as plausibility.ts. */
function flatJudged(p: PointSeries): boolean {
  if (p.role === null || p.isSetpoint) return false;
  if (p.measurement === null || STATE_MEASUREMENTS.includes(p.measurement)) return false;
  if (STATE_DATA_TYPES.includes(p.dataType)) return false;
  return thresholdFor(p.measurement) !== null;
}

export interface DataHealthResult {
  findings: RawFinding[];
  /** Point ids the equipment questions must not use. */
  excluded: Set<string>;
  judged: number;
}

export function dataHealth(points: PointSeries[], range: Interval, timezone: string): DataHealthResult {
  const findings: RawFinding[] = [];
  const excluded = new Set<string>();
  let judged = 0;

  const base = (p: PointSeries) => ({
    questionKey: DATA_HEALTH_QUESTION,
    section: "data_health" as const,
    subjectKey: `point:${p.pointId}`,
    equipmentId: p.equipmentId,
    subjectName: p.name,
    priority: "watch" as const,
  });

  for (const p of points) {
    judged += 1;
    const interval = p.intervalS !== null;

    // Offline and stale: interval trends only.
    if (interval && p.readingCount === 0) {
      excluded.add(p.pointId);
      findings.push({
        ...base(p),
        issueCode: "offline",
        issue: "No readings",
        evidence: {
          actual: "no readings in the period",
          expected: `a reading every ${Math.round(p.intervalS! / 60)} min`,
          duration: describeDuration(range.end - range.start),
          durationMs: range.end - range.start,
          when: p.carryInAt === null ? "never reported" : `last reading ${localTime(p.carryInAt, timezone)}`,
        },
      });
      continue;
    }

    if (interval && p.samples.length > 0) {
      const last = p.samples[p.samples.length - 1]!.t;
      const staleAfter = Math.max(6 * p.intervalS! * 1000, 2 * HOUR_MS);
      if (range.end - last > staleAfter) {
        excluded.add(p.pointId);
        findings.push({
          ...base(p),
          issueCode: "stale",
          issue: "Stopped trending",
          evidence: {
            actual: `no readings for the last ${describeDuration(range.end - last)} of the period`,
            expected: `a reading every ${Math.round(p.intervalS! / 60)} min`,
            duration: describeDuration(range.end - last),
            durationMs: range.end - last,
            when: `since ${localTime(last, timezone)}`,
          },
        });
        continue;
      }
    }

    // Out of physical range, judged on the held value.
    const physical = physicalRangeFor(p.role, p.unit);
    if (physical !== null && p.samples.length > 0) {
      const segs = segments(p, range, holdMsFor(p));
      const outside = whereTrue(segs, (v) => v < physical.min || v > physical.max);
      const persisted = persistence(outside, timezone);
      if (outside.length > 0 && persisted.qualifies) {
        const worst = p.samples.reduce(
          (acc, s) => {
            const dist = s.v < physical.min ? physical.min - s.v : s.v > physical.max ? s.v - physical.max : 0;
            return dist > acc.dist ? { dist, v: s.v } : acc;
          },
          { dist: 0, v: p.samples[0]!.v },
        );
        const known = totalMs(segs.map((s) => ({ start: s.start, end: s.end })));
        const percent = known > 0 ? Math.round((persisted.totalMs / known) * 100) : 0;
        excluded.add(p.pointId);
        findings.push({
          ...base(p),
          issueCode: "out_of_range",
          issue: "Out of physical range",
          evidence: {
            actual: `read ${fmt(worst.v, p.unit)}`,
            expected: `${physical.label} between ${fmt(physical.min, p.unit)} and ${fmt(physical.max, p.unit)}`,
            duration: describeDuration(persisted.totalMs),
            durationMs: persisted.totalMs,
            percent,
            when: busiestWindow(hourOfDayProfile(outside, timezone)) ?? `on ${persisted.days} day${persisted.days === 1 ? "" : "s"}`,
          },
        });
        // A point that is out of range may also be flat (a dead sensor is
        // both); the flat row would say the same thing twice.
        continue;
      }
    }

    // Flat: the longest run of one value in the period, against the kind's threshold.
    if (flatJudged(p) && p.samples.length >= MIN_READINGS) {
      const threshold = thresholdFor(p.measurement)!;
      let runStart = 0;
      let best = { readings: 0, start: 0, end: 0, v: 0 };
      for (let i = 1; i <= p.samples.length; i += 1) {
        const ended = i === p.samples.length || p.samples[i]!.v !== p.samples[runStart]!.v;
        if (ended) {
          const readings = i - runStart;
          const start = p.samples[runStart]!.t;
          // The run holds until the first different reading, or the period's end
          // for a run still going - the value is known unchanged that far.
          const end = i === p.samples.length ? Math.min(range.end, p.samples[i - 1]!.t + holdMsFor(p)) : p.samples[i]!.t;
          if (end - start > best.end - best.start) best = { readings, start, end, v: p.samples[runStart]!.v };
          runStart = i;
        }
      }
      const spanMs = best.end - best.start;
      if (best.readings >= MIN_READINGS && spanMs >= threshold.hours * HOUR_MS) {
        excluded.add(p.pointId);
        findings.push({
          ...base(p),
          issueCode: "flat",
          issue: "Flat-lined",
          evidence: {
            actual: `exactly ${fmt(best.v, p.unit)} for ${describeDuration(spanMs)} (${best.readings} readings)`,
            expected: `a value that moves; the threshold for ${threshold.measurement} is ${threshold.hours} h`,
            duration: describeDuration(spanMs),
            durationMs: spanMs,
            percent: Math.round((spanMs / (range.end - range.start)) * 100),
            when: `since ${localTime(best.start, timezone)}`,
          },
        });
      }
    }
  }

  // Stable order: by name, so two runs list the same problems the same way.
  findings.sort((a, b) => a.subjectName.localeCompare(b.subjectName));
  return { findings, excluded, judged };
}

/** For a test: the hold a change-of-value point has in minutes. */
export const COV_HOLD_MINUTES = Number.POSITIVE_INFINITY;
export const SPIKE_MINUTES = 5 * MINUTE_MS;
