import { localParts, zonedDateTimeToUtc } from "./reports/schedule";

/**
 * The x-axis of a BAS time chart (2026-11-23): which instants carry a tick,
 * and what each tick says.
 *
 * Recharts places ticks on a time scale wherever its arithmetic lands, and
 * the old formatter printed every one of them as a bare date. Over seven
 * days five to ten ticks fall on seven days, so two would land on one day
 * and the axis read "Nov 17 Nov 17" - a date printed twice, and nothing to
 * say what the second one meant. Now the ticks are chosen here, on the
 * building's own clock, and handed to Recharts whole:
 *
 *   - a tick at local midnight says its DATE ("Nov 17"), and is the only
 *     tick that does, so each day's date is printed once;
 *   - a tick between midnights says only its TIME ("12:00") - drawn only
 *     where the chart is wide enough for them;
 *   - the first tick of a day the axis enters after its midnight says both
 *     ("Nov 17 06:00"), so a partial first day is still dated once;
 *   - over about a year and more, ticks are month starts and say "Aug 2026".
 *
 * The density is the chart's measured width divided by TICK_SPACING_PX, and
 * the step is the finest on a fixed ladder that fits, so no label overlaps
 * and Recharts never has to drop one - it is told to draw them all. Each
 * tick has one label, and each date appears on the axis once; a time such
 * as "12:00" recurs once a day, which is what marks it as a time. The tests
 * hold both.
 */

export type AxisTickKind = "date" | "time" | "date-time" | "month";

export interface AxisTick {
  ms: number;
  label: string;
  kind: AxisTickKind;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The room one tick needs: the widest common label ("Nov 17", "12:00", "Aug 2026") plus a clear gap. */
export const TICK_SPACING_PX = 64;

/** How many ticks fit in `widthPx` of plot. Never fewer than two. */
export function maxTicksFor(widthPx: number): number {
  return Math.max(2, Math.floor(widthPx / TICK_SPACING_PX));
}

type Step =
  | { unit: "minute"; n: number }
  | { unit: "day"; n: number }
  | { unit: "month"; n: number };

/** Finest first. Sub-day steps divide the day, so every day's ticks include its midnight. */
const LADDER: readonly Step[] = [
  ...[1, 2, 5, 10, 15, 30].map((n) => ({ unit: "minute" as const, n })),
  ...[1, 2, 3, 4, 6, 12].map((h) => ({ unit: "minute" as const, n: h * 60 })),
  ...[1, 2, 3, 5, 7, 14].map((n) => ({ unit: "day" as const, n })),
  ...[1, 2, 3, 6, 12].map((n) => ({ unit: "month" as const, n })),
];

const stepMs = (s: Step): number => (s.unit === "minute" ? s.n * MINUTE : s.unit === "day" ? s.n * DAY : s.n * 30.44 * DAY);

/** The zone a label is read in: the one given, or the browser's own. */
function resolveZone(timeZone: string | undefined): string {
  return timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
}

/** Day number of a calendar date, for stepping and alignment; 1970-01-01 is 0. */
const dayNumber = (y: number, m: number, d: number) => Math.round(Date.UTC(y, m - 1, d) / DAY);

function* localDays(fromMs: number, toMs: number, zone: string): Generator<{ y: number; m: number; d: number; n: number }> {
  const a = localParts(new Date(fromMs), zone);
  const b = localParts(new Date(toMs), zone);
  const first = dayNumber(a.year, a.month, a.day);
  const last = dayNumber(b.year, b.month, b.day);
  for (let n = first; n <= last; n += 1) {
    const date = new Date(n * DAY);
    yield { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate(), n };
  }
}

function candidates(step: Step, fromMs: number, toMs: number, zone: string): number[] {
  const out = new Set<number>();
  if (step.unit === "minute") {
    for (const day of localDays(fromMs, toMs, zone)) {
      for (let minuteOfDay = 0; minuteOfDay < 24 * 60; minuteOfDay += step.n) {
        const at = zonedDateTimeToUtc({ year: day.y, month: day.m, day: day.d, hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60 }, zone).getTime();
        // A wall time that does not exist (the spring gap) lands on the next
        // real instant, which is the next step's instant too; the set keeps one.
        out.add(at);
      }
    }
  } else if (step.unit === "day") {
    for (const day of localDays(fromMs, toMs, zone)) {
      // Weekly steps on Mondays (day 0 was a Thursday); the rest on the day number.
      const aligned = step.n === 7 || step.n === 14 ? (day.n + 3) % step.n === 0 : day.n % step.n === 0;
      if (aligned) out.add(zonedDateTimeToUtc({ year: day.y, month: day.m, day: day.d, hour: 0, minute: 0 }, zone).getTime());
    }
  } else {
    const a = localParts(new Date(fromMs), zone);
    const b = localParts(new Date(toMs), zone);
    for (let i = a.year * 12 + (a.month - 1); i <= b.year * 12 + (b.month - 1); i += 1) {
      if (i % step.n !== 0) continue;
      out.add(zonedDateTimeToUtc({ year: Math.floor(i / 12), month: (i % 12) + 1, day: 1, hour: 0, minute: 0 }, zone).getTime());
    }
  }
  return [...out].filter((ms) => ms >= fromMs && ms <= toMs).sort((x, y) => x - y);
}

/**
 * The ticks for an axis from `fromMs` to `toMs`: the finest step on the
 * ladder whose ticks fit `maxTicks`, labelled as the module comment says.
 * Null when no step yields two ticks (a span of a minute or two), which the
 * chart takes as "let Recharts place them".
 */
export function timeAxisTicks(
  fromMs: number,
  toMs: number,
  options: { maxTicks: number; timeZone?: string; locale?: string },
): AxisTick[] | null {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return null;
  const zone = resolveZone(options.timeZone);
  const span = toMs - fromMs;
  let chosen: { step: Step; ticks: number[] } | null = null;
  for (const step of LADDER) {
    // Far too fine to fit: skip without generating thousands of candidates.
    if (span / stepMs(step) > options.maxTicks * 2 + 2) continue;
    const ticks = candidates(step, fromMs, toMs, zone);
    if (ticks.length >= 2 && ticks.length <= options.maxTicks) {
      chosen = { step, ticks };
      break;
    }
  }
  if (chosen === null) return null;
  return labelTicks(chosen.ticks, chosen.step, zone, options.locale);
}

function labelTicks(ticks: number[], step: Step, zone: string, locale: string | undefined): AxisTick[] {
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: zone });
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: zone });
  const month = new Intl.DateTimeFormat(locale, { month: "short", year: "numeric", timeZone: zone });
  if (step.unit === "month") return ticks.map((ms) => ({ ms, label: month.format(ms), kind: "month" }));
  if (step.unit === "day") return ticks.map((ms) => ({ ms, label: date.format(ms), kind: "date" }));

  // Sub-day: the date once per day - on its midnight, or on its first tick
  // when the axis enters the day after midnight - and the time otherwise.
  const dayKey = (ms: number) => {
    const p = localParts(new Date(ms), zone);
    return `${p.year}-${p.month}-${p.day}`;
  };
  const isMidnight = (ms: number) => {
    const p = localParts(new Date(ms), zone);
    return p.hour === 0 && p.minute === 0;
  };
  const dated = new Set<string>();
  for (const ms of ticks) if (isMidnight(ms)) dated.add(dayKey(ms));
  return ticks.map((ms) => {
    const key = dayKey(ms);
    if (isMidnight(ms)) return { ms, label: date.format(ms), kind: "date" as const };
    if (!dated.has(key)) {
      dated.add(key);
      return { ms, label: `${date.format(ms)} ${time.format(ms)}`, kind: "date-time" as const };
    }
    return { ms, label: time.format(ms), kind: "time" as const };
  });
}
