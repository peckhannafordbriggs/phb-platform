import { localParts } from "../schedule";
import type { Interval, PointSeries } from "./types";

/**
 * Time arithmetic over sample-and-hold series (Reports, Phase 2). Pure.
 *
 * A trend is a list of instants with values; what a question needs is "for
 * how long was the value above X", which is an integral. Every series here is
 * read sample-and-hold: a value holds from its reading until the next one.
 * That is exactly right for a change-of-value trend (the station logs only
 * on change) and the honest reading of an interval trend (the station logs
 * what it saw at each tick). The hold is bounded: past `maxHoldMs` the value
 * is unknown rather than assumed, which is what stops a 15-minute trend
 * asserting a reading across a three-day hole. A change-of-value trend holds
 * without bound, and only a recorded gap breaks it.
 *
 * Intervals are half-open [start, end) in UTC milliseconds, kept sorted and
 * non-overlapping by every function that returns them.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Merge overlapping or touching intervals. */
export function normalise(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && i.start <= last.end) {
      last.end = Math.max(last.end, i.end);
    } else {
      out.push({ start: i.start, end: i.end });
    }
  }
  return out;
}

export function clip(intervals: Interval[], range: Interval): Interval[] {
  return normalise(
    intervals.map((i) => ({ start: Math.max(i.start, range.start), end: Math.min(i.end, range.end) })),
  );
}

export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  const left = normalise(a);
  const right = normalise(b);
  while (i < left.length && j < right.length) {
    const x = left[i]!;
    const y = right[j]!;
    const start = Math.max(x.start, y.start);
    const end = Math.min(x.end, y.end);
    if (end > start) out.push({ start, end });
    if (x.end < y.end) i += 1;
    else j += 1;
  }
  return out;
}

export function subtract(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  const holes = normalise(b);
  for (const i of normalise(a)) {
    let cursor = i.start;
    for (const h of holes) {
      if (h.end <= cursor) continue;
      if (h.start >= i.end) break;
      if (h.start > cursor) out.push({ start: cursor, end: Math.min(h.start, i.end) });
      cursor = Math.max(cursor, h.end);
      if (cursor >= i.end) break;
    }
    if (cursor < i.end) out.push({ start: cursor, end: i.end });
  }
  return out;
}

export function totalMs(intervals: Interval[]): number {
  return intervals.reduce((sum, i) => sum + (i.end - i.start), 0);
}

export function longestMs(intervals: Interval[]): number {
  return intervals.reduce((best, i) => Math.max(best, i.end - i.start), 0);
}

/** One held value over one stretch of time. */
export interface Segment {
  start: number;
  end: number;
  v: number;
}

/**
 * The series as held segments inside `range`. The carry-in value holds from
 * the range start until the first sample; each sample holds until the next
 * sample, the range end, or `maxHoldMs` after it, whichever is first; recorded
 * gaps are cut out. Where nothing is known there is no segment.
 */
export function segments(series: PointSeries, range: Interval, maxHoldMs: number): Segment[] {
  const out: Segment[] = [];
  const samples = series.samples;

  const push = (start: number, end: number, v: number) => {
    const s = Math.max(start, range.start);
    const e = Math.min(end, range.end);
    if (e > s) out.push({ start: s, end: e, v });
  };

  if (series.carryIn !== null && series.carryInAt !== null) {
    const until = samples.length > 0 ? samples[0]!.t : range.end;
    // A carry-in holds only as far as its own hold allows, measured from when
    // it was read: a 15-minute trend whose last reading was last Tuesday
    // tells us nothing about Monday morning.
    push(range.start, Math.min(until, series.carryInAt + maxHoldMs), series.carryIn);
  }

  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i]!;
    const next = i + 1 < samples.length ? samples[i + 1]!.t : range.end;
    push(s.t, Math.min(next, s.t + maxHoldMs), s.v);
  }

  if (series.gaps.length === 0) return out;

  // Cut the recorded gaps out of every segment.
  const cut: Segment[] = [];
  for (const seg of out) {
    for (const kept of subtract([{ start: seg.start, end: seg.end }], series.gaps)) {
      cut.push({ start: kept.start, end: kept.end, v: seg.v });
    }
  }
  return cut;
}

/** How long a point may hold between readings before the value is unknown. */
export function holdMsFor(series: PointSeries): number {
  if (series.intervalS === null) return Number.POSITIVE_INFINITY;
  return Math.max(3 * series.intervalS * 1000, 15 * MINUTE_MS);
}

/** The intervals over which the held value satisfies `test`. */
export function whereTrue(segs: Segment[], test: (v: number) => boolean): Interval[] {
  return normalise(segs.filter((s) => test(s.v)).map((s) => ({ start: s.start, end: s.end })));
}

/** The intervals over which the value is known at all. */
export function known(segs: Segment[]): Interval[] {
  return normalise(segs.map((s) => ({ start: s.start, end: s.end })));
}

/** The local calendar day (YYYY-MM-DD in `timezone`) an instant falls on. */
export function localDay(ms: number, timezone: string): string {
  const p = localParts(new Date(ms), timezone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Distinct local days an interval list touches. */
export function daysTouched(intervals: Interval[], timezone: string): Set<string> {
  const days = new Set<string>();
  for (const i of intervals) {
    // Walk by local day from the start; an interval rarely spans more than a few.
    let t = i.start;
    while (t < i.end) {
      days.add(localDay(t, timezone));
      t += DAY_MS;
    }
    days.add(localDay(i.end - 1, timezone));
  }
  return days;
}

export interface Persistence {
  /** True when the spec's rule is met: one stretch of at least `minMs`, or recurrence on at least `minDays` days. */
  qualifies: boolean;
  longestMs: number;
  totalMs: number;
  days: number;
}

/**
 * The spec's persistence filter: "only flag conditions lasting at least 30
 * minutes during occupied hours, or recurring on 2 or more days. Ignore
 * single spikes." `intervals` are already restricted to the hours that
 * count (occupied, or the whole period for a question that is not about
 * comfort).
 */
export function persistence(
  intervals: Interval[],
  timezone: string,
  minMs: number = 30 * MINUTE_MS,
  minDays = 2,
): Persistence {
  const merged = normalise(intervals);
  const longest = longestMs(merged);
  // Recurrence counts only stretches that are more than a spike themselves.
  const notSpikes = merged.filter((i) => i.end - i.start >= 5 * MINUTE_MS);
  const days = daysTouched(notSpikes, timezone).size;
  return {
    qualifies: longest >= minMs || days >= minDays,
    longestMs: longest,
    totalMs: totalMs(merged),
    days,
  };
}

/** Occupied intervals from a boolean series: true (1) is occupied. */
export function occupiedFromSeries(series: PointSeries, range: Interval): Interval[] {
  return whereTrue(segments(series, range, holdMsFor(series)), (v) => v >= 0.5);
}

export interface OccupancyRow {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

/**
 * Occupied intervals from the building's manual schedule, in its zone. Walks
 * each local day the range touches, converting the day's start and end
 * minutes through the zone, so a clock change makes the day 23 or 25 hours
 * long rather than shifting the hours.
 */
export function occupiedFromSchedule(rows: OccupancyRow[], range: Interval, timezone: string): Interval[] {
  if (rows.length === 0) return [];
  const byWeekday = new Map(rows.map((r) => [r.weekday, r]));
  const out: Interval[] = [];
  // Start a day early so a range beginning mid-day sees that day's hours.
  let t = range.start - DAY_MS;
  const seen = new Set<string>();
  while (t < range.end + DAY_MS) {
    const p = localParts(new Date(t), timezone);
    const key = `${p.year}-${p.month}-${p.day}`;
    if (!seen.has(key)) {
      seen.add(key);
      const row = byWeekday.get(p.weekday);
      if (row !== undefined) {
        const start = localMinuteToUtc(p.year, p.month, p.day, row.startMinute, timezone);
        const end = localMinuteToUtc(p.year, p.month, p.day, row.endMinute, timezone);
        out.push({ start, end });
      }
    }
    t += DAY_MS;
  }
  return clip(out, range);
}

/** Minutes after local midnight on a local date, as a UTC instant. */
function localMinuteToUtc(year: number, month: number, day: number, minute: number, timezone: string): number {
  // 1440 is the end of the day: midnight of the next day.
  if (minute >= 1440) {
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    return zoned(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timezone);
  }
  return zoned(year, month, day, Math.floor(minute / 60), minute % 60, timezone);
}

function zoned(year: number, month: number, day: number, hour: number, minute: number, timezone: string): number {
  // Inline rather than importing zonedDateTimeToUtc, to keep this module's
  // dependency on schedule.ts to localParts alone - but the arithmetic is the
  // same two-offset approach.
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetAt = (instant: number) => {
    const p = localParts(new Date(instant), timezone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instant / 1000) * 1000;
  };
  const first = offsetAt(guess);
  const candidates = new Set([first, offsetAt(guess - first)]);
  const instants = [...candidates].map((o) => guess - o);
  const matches = instants.filter((i) => {
    const p = localParts(new Date(i), timezone);
    return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
  });
  return matches.length > 0 ? Math.min(...matches) : Math.max(...instants);
}

/** Minutes per local hour of day (0..23) that the intervals cover. */
export function hourOfDayProfile(intervals: Interval[], timezone: string): number[] {
  const minutes = new Array<number>(24).fill(0);
  for (const i of normalise(intervals)) {
    let t = i.start;
    while (t < i.end) {
      const p = localParts(new Date(t), timezone);
      const hourEnd = t + (60 - p.minute) * MINUTE_MS - p.second * 1000;
      const end = Math.min(hourEnd, i.end);
      minutes[p.hour] = (minutes[p.hour] ?? 0) + (end - t) / MINUTE_MS;
      t = end;
    }
  }
  return minutes;
}

/** "14:00-16:00" - the two-hour window with the most minutes, or null. */
export function busiestWindow(profile: number[]): string | null {
  let best = -1;
  let bestAt = -1;
  for (let h = 0; h < 24; h += 1) {
    const sum = (profile[h] ?? 0) + (profile[(h + 1) % 24] ?? 0);
    if (sum > best) {
      best = sum;
      bestAt = h;
    }
  }
  if (best <= 0) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(bestAt)}:00-${pad((bestAt + 2) % 24)}:00`;
}

/** "2 h 15 min", "45 min", "3.5 days". */
export function describeDuration(ms: number): string {
  if (ms >= 2 * DAY_MS) return `${(ms / DAY_MS).toFixed(1)} days`;
  const minutes = Math.round(ms / MINUTE_MS);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** The period with the hold applied: when, inside the range, a value was known. */
export function knownIntervals(series: PointSeries, range: Interval): Interval[] {
  return known(segments(series, range, holdMsFor(series)));
}
