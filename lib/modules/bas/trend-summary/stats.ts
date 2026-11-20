import { localParts } from "../reports/schedule";
import type { BreaksSummary, ExpectedInterval } from "../interval";
import { describeExpectedInterval, formatInterval } from "../interval";
import { unitSymbol } from "../units";
import type { OutOfRange } from "../types";
import type { BooleanStates, ValueKind } from "../value-kind";

/**
 * The numbers behind a trend summary (2026-11-20). Pure, so a fixture series
 * proves every figure without a database or a model.
 *
 * CODE COMPUTES, THE MODEL NARRATES - the Reports rule (engine/narrative.ts),
 * here for one point over one range. Everything the model may say is in the
 * object this returns, already rounded and already formatted the way the
 * page shows it; the narrator checks the model's sentences against it and
 * refuses a number that is not here (narrator.ts, `inventedNumbers`).
 *
 * What it computes, from the same samples the chart draws (every reading, or
 * one per bucket with the bucket's reading count as its weight):
 *
 *   the lowest and highest reading, and when
 *   the average
 *   the daily pattern: the average for each local hour of the day, in the
 *     building's zone, with the hour that runs highest and lowest
 *   occupied against unoccupied averages, where occupancy is known
 *   the breaks: how many, the longest, the share of the period missing,
 *     against the expected interval and where it came from
 *   the flags: a stuck value, a reading out of physical range, records
 *     logged with no value
 *   the longest rise and the longest fall: the sustained climb or drop with
 *     the largest total change, over a series smoothed to about a hundred
 *     steps so one noisy reading cannot cut a real ramp in two
 *
 * A boolean point is described as shares: the share of readings "on" overall,
 * by hour, and occupied against unoccupied, in its own state words. It has no
 * rise or fall. A string point has no summary (the service refuses it).
 */

export interface TrendSample {
  tsMs: number;
  value: number | null;
  /** A bucket's lowest and highest, when the trend is bucketed. */
  min?: number | null;
  max?: number | null;
  /** How many readings the sample stands for: 1 raw, the bucket's count bucketed. */
  readings?: number;
}

export interface OccupiedInterval {
  start: number;
  end: number;
}

export interface TrendStatsInput {
  pointName: string;
  unit: string | null;
  valueKind: ValueKind;
  states: BooleanStates | null;
  timezone: string;
  range: { fromMs: number; toMs: number };
  samples: readonly TrendSample[];
  /** The bucket width in words when the trend is bucketed ("15 min"), else null. */
  bucketLabel: string | null;
  stats: {
    readings: number;
    nullRecords: number;
    distinctValues: number;
    average: number | null;
    minimum: number | null;
    maximum: number | null;
  };
  /** The page's stuck-sensor verdict, from the distinct-values rule. */
  stuck: boolean;
  expected: ExpectedInterval;
  breaks: BreaksSummary;
  outOfRange: OutOfRange | null;
  /** Occupied intervals and where they came from; null when occupancy is not known. */
  occupancy: { source: string; intervals: readonly OccupiedInterval[] } | null;
}

export interface TrendExtreme {
  value: number;
  at: string;
}

export interface TrendRun {
  from: string;
  to: string;
  startValue: number;
  endValue: number;
  change: number;
  hours: number;
}

/** Everything the model is given, and nothing else. Every value is final. */
export interface TrendStats {
  point: string;
  unit: string | null;
  kind: "numeric" | "boolean";
  /** For a boolean point: the words a 1 and a 0 are said as. */
  states: { on: string; off: string } | null;
  period: { from: string; to: string; days: number; hours: number; timezone: string };
  readings: number;
  /** "every reading" or "15 min averages". */
  drawnFrom: string;
  lowest: TrendExtreme | null;
  highest: TrendExtreme | null;
  /** Numeric: the average. Boolean: the percent of readings on. */
  average: number | null;
  dailyPattern: {
    /** Local hours with data, "06:00" .. "23:00", and the average (or percent on) in each. */
    byHour: Array<{ hour: string; average: number }>;
    highestHour: { hour: string; average: number } | null;
    lowestHour: { hour: string; average: number } | null;
  } | null;
  occupancy: {
    source: string;
    occupiedAverage: number | null;
    unoccupiedAverage: number | null;
    occupiedPercentOfReadings: number;
  } | null;
  breaks: {
    expected: string;
    count: number;
    longestHours: number | null;
    missingPercent: number;
  };
  flags: {
    stuck: { distinctValues: number; readings: number } | null;
    outOfRange: { label: string; physicalMin: number; physicalMax: number; lowest: number | null; highest: number | null } | null;
    recordsWithNoValue: number;
  };
  longestRise: TrendRun | null;
  longestFall: TrendRun | null;
}

const HOUR_MS = 3_600_000;
const SMOOTHING_STEPS = 100;

/** One decimal for most values, two below one, whole numbers past a thousand. */
export function roundValue(value: number): number {
  const magnitude = Math.abs(value);
  if (magnitude >= 1000) return Math.round(value);
  if (magnitude < 1) return Math.round(value * 100) / 100;
  return Math.round(value * 10) / 10;
}

function percent(share: number): number {
  return Math.round(share * 1000) / 10;
}

/** "Nov 13, 14:05" in the building's zone - the page's own format, 24-hour. */
export function formatLocal(ms: number, timezone: string): string {
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone,
  });
}

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function weightOf(sample: TrendSample): number {
  return Math.max(1, sample.readings ?? 1);
}

function inIntervals(ms: number, intervals: readonly OccupiedInterval[]): boolean {
  for (const i of intervals) if (ms >= i.start && ms < i.end) return true;
  return false;
}

/** The weighted mean, or null over nothing. */
function mean(entries: Array<{ value: number; weight: number }>): number | null {
  let sum = 0;
  let weight = 0;
  for (const e of entries) {
    sum += e.value * e.weight;
    weight += e.weight;
  }
  return weight === 0 ? null : sum / weight;
}

/**
 * The series smoothed to about SMOOTHING_STEPS equal-time steps, each the
 * weighted mean of the samples in it; an empty step is a gap, which ends a
 * run. Then the monotonic run with the largest total change in each
 * direction.
 */
export function longestRuns(
  samples: readonly TrendSample[],
  range: { fromMs: number; toMs: number },
  timezone: string,
): { rise: TrendRun | null; fall: TrendRun | null } {
  const span = range.toMs - range.fromMs;
  if (span <= 0) return { rise: null, fall: null };
  const step = span / SMOOTHING_STEPS;
  const bins: Array<{ tsMs: number; value: number } | null> = [];
  for (let i = 0; i < SMOOTHING_STEPS; i++) bins.push(null);
  const acc = Array.from({ length: SMOOTHING_STEPS }, () => ({ sum: 0, weight: 0, firstMs: Number.POSITIVE_INFINITY }));
  for (const s of samples) {
    if (s.value === null || s.tsMs < range.fromMs || s.tsMs >= range.toMs) continue;
    const i = Math.min(SMOOTHING_STEPS - 1, Math.floor((s.tsMs - range.fromMs) / step));
    const w = weightOf(s);
    acc[i]!.sum += s.value * w;
    acc[i]!.weight += w;
    acc[i]!.firstMs = Math.min(acc[i]!.firstMs, s.tsMs);
  }
  for (let i = 0; i < SMOOTHING_STEPS; i++) {
    const a = acc[i]!;
    if (a.weight > 0) bins[i] = { tsMs: range.fromMs + (i + 0.5) * step, value: a.sum / a.weight };
  }

  type Bin = { tsMs: number; value: number };
  const at = (k: number): Bin | null => bins[k] ?? null;
  const best = (direction: 1 | -1): TrendRun | null => {
    let bestRun: { start: Bin; end: Bin } | null = null;
    // One monotonic stretch, bins from..to. Leading and trailing flat steps
    // are trimmed: a fall starts at the last bin before it first moves and
    // ends at the bin where it last moved, so a sensor that drops and then
    // sits at -40 for three days is a fall of an hour, not of three days.
    const consider = (from: number, to: number) => {
      let first = -1;
      let last = -1;
      for (let k = from + 1; k <= to; k++) {
        if ((at(k)!.value - at(k - 1)!.value) * direction > 0) {
          if (first === -1) first = k;
          last = k;
        }
      }
      if (first === -1) return;
      const start = at(first - 1)!;
      const end = at(last)!;
      const change = (end.value - start.value) * direction;
      if (bestRun === null || change > (bestRun.end.value - bestRun.start.value) * direction) bestRun = { start, end };
    };
    let i = 0;
    while (i < SMOOTHING_STEPS) {
      if (at(i) === null) {
        i += 1;
        continue;
      }
      let j = i;
      while (j + 1 < SMOOTHING_STEPS && at(j + 1) !== null && (at(j + 1)!.value - at(j)!.value) * direction >= 0) j += 1;
      consider(i, j);
      // The turning point starts the next stretch.
      i = j === i ? i + 1 : j;
    }
    if (bestRun === null) return null;
    const run: { start: Bin; end: Bin } = bestRun;
    return {
      from: formatLocal(run.start.tsMs, timezone),
      to: formatLocal(run.end.tsMs, timezone),
      startValue: roundValue(run.start.value),
      endValue: roundValue(run.end.value),
      change: roundValue(run.end.value - run.start.value),
      hours: Math.round(((run.end.tsMs - run.start.tsMs) / HOUR_MS) * 10) / 10,
    };
  };

  return { rise: best(1), fall: best(-1) };
}

export function computeTrendStats(input: TrendStatsInput): TrendStats {
  const boolean = input.valueKind === "boolean";
  const scale = (value: number) => (boolean ? percent(value) : roundValue(value));
  const samples = input.samples.filter((s) => s.value !== null && s.tsMs >= input.range.fromMs && s.tsMs < input.range.toMs);

  // Extremes: the exact figure from the database, the instant from the sample
  // that holds it (the bucket's own min or max when bucketed).
  const findAt = (target: number | null, pick: (s: TrendSample) => number | null): string | null => {
    if (target === null) return null;
    let found: TrendSample | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const s of samples) {
      const v = pick(s);
      if (v === null) continue;
      const d = Math.abs(v - target);
      if (d < bestDistance) {
        bestDistance = d;
        found = s;
      }
    }
    return found === null ? null : formatLocal(found.tsMs, input.timezone);
  };
  const lowestAt = boolean ? null : findAt(input.stats.minimum, (s) => s.min ?? s.value);
  const highestAt = boolean ? null : findAt(input.stats.maximum, (s) => s.max ?? s.value);

  // The daily pattern, in the building's zone.
  const byHourAcc = new Map<number, Array<{ value: number; weight: number }>>();
  for (const s of samples) {
    const hour = localParts(new Date(s.tsMs), input.timezone).hour;
    const list = byHourAcc.get(hour) ?? [];
    list.push({ value: s.value!, weight: weightOf(s) });
    byHourAcc.set(hour, list);
  }
  const byHour = [...byHourAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, list]) => ({ hour: hourLabel(hour), average: scale(mean(list) ?? 0) }));
  const highestHour = byHour.length < 2 ? null : byHour.reduce((a, b) => (b.average > a.average ? b : a));
  const lowestHour = byHour.length < 2 ? null : byHour.reduce((a, b) => (b.average < a.average ? b : a));

  // Occupied against unoccupied, when occupancy is known.
  let occupancy: TrendStats["occupancy"] = null;
  if (input.occupancy !== null && samples.length > 0) {
    const occupied: Array<{ value: number; weight: number }> = [];
    const unoccupied: Array<{ value: number; weight: number }> = [];
    for (const s of samples) {
      (inIntervals(s.tsMs, input.occupancy.intervals) ? occupied : unoccupied).push({ value: s.value!, weight: weightOf(s) });
    }
    const occupiedWeight = occupied.reduce((a, e) => a + e.weight, 0);
    const totalWeight = occupiedWeight + unoccupied.reduce((a, e) => a + e.weight, 0);
    const occ = mean(occupied);
    const unocc = mean(unoccupied);
    occupancy = {
      source: input.occupancy.source,
      occupiedAverage: occ === null ? null : scale(occ),
      unoccupiedAverage: unocc === null ? null : scale(unocc),
      occupiedPercentOfReadings: totalWeight === 0 ? 0 : percent(occupiedWeight / totalWeight),
    };
  }

  const runs = boolean ? { rise: null, fall: null } : longestRuns(samples, input.range, input.timezone);
  const hours = (input.range.toMs - input.range.fromMs) / HOUR_MS;

  return {
    point: input.pointName,
    unit: boolean ? null : unitSymbol(input.unit),
    kind: boolean ? "boolean" : "numeric",
    states: boolean && input.states !== null ? { on: input.states.on, off: input.states.off } : null,
    period: {
      from: formatLocal(input.range.fromMs, input.timezone),
      to: formatLocal(input.range.toMs, input.timezone),
      days: Math.round((hours / 24) * 10) / 10,
      hours: Math.round(hours * 10) / 10,
      timezone: input.timezone,
    },
    readings: input.stats.readings,
    drawnFrom: input.bucketLabel === null ? "every reading" : `${input.bucketLabel} averages`,
    lowest: input.stats.minimum === null || boolean ? null : { value: roundValue(input.stats.minimum), at: lowestAt ?? "" },
    highest: input.stats.maximum === null || boolean ? null : { value: roundValue(input.stats.maximum), at: highestAt ?? "" },
    average: input.stats.average === null ? null : scale(input.stats.average),
    dailyPattern: byHour.length === 0 ? null : { byHour, highestHour, lowestHour },
    occupancy,
    breaks: {
      expected:
        describeExpectedInterval(input.expected) +
        (input.expected.seconds === null ? `; a break is a gap over ${formatInterval(input.expected.breakThresholdS)}` : ""),
      count: input.breaks.count,
      longestHours: input.breaks.longestHours === null ? null : Math.round(input.breaks.longestHours * 10) / 10,
      missingPercent: percent(input.breaks.missingShare),
    },
    flags: {
      stuck: input.stuck ? { distinctValues: input.stats.distinctValues, readings: input.stats.readings } : null,
      outOfRange:
        input.outOfRange === null
          ? null
          : {
              label: input.outOfRange.label,
              physicalMin: input.outOfRange.min,
              physicalMax: input.outOfRange.max,
              lowest: input.outOfRange.lowest,
              highest: input.outOfRange.highest,
            },
      recordsWithNoValue: input.stats.nullRecords,
    },
    longestRise: runs.rise,
    longestFall: runs.fall,
  };
}
