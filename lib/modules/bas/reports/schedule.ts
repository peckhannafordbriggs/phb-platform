/**
 * Report schedules: what "every Monday at 06:00 in the building's zone"
 * means as an instant, and how it is said on screen.
 *
 * PURE. No database, no Prisma, no Node-only API - the editor imports this in
 * the browser to show the next run beside the form, and the service imports
 * it on the server to store `next_run_at`. One function decides both, so the
 * preview and the stored value cannot disagree.
 *
 * TIME ZONES, STATED ONCE. A schedule is stored as a local wall-clock time
 * (`time_of_day`, HH:MM) plus the building's IANA zone (`bas_sites.timezone`);
 * `next_run_at` is the UTC instant computed from those, and it is recomputed
 * from them on every advance. The instant is never the thing stored and
 * advanced by adding 24 hours: across a clock change that lands a 06:00 report
 * at 05:00 or 07:00, which is the DST bug docs/08 says cannot be unwound
 * afterwards. The arithmetic is done on the local calendar and converted at
 * the end, with the whole of the conversion in `zonedDateTimeToUtc`.
 *
 * No library. The platform has no date-time dependency and this needs one
 * conversion each way, which `Intl.DateTimeFormat` provides on Node 20 and in
 * every browser the platform supports. The two edge cases a conversion has to
 * decide are decided explicitly and tested
 * (tests/bas-reports-schedule.test.ts):
 *
 *   - a local time that happens TWICE (the autumn change, 01:00-02:00 on the
 *     first Sunday of November in America/New_York) resolves to the FIRST
 *     occurrence, the earlier instant;
 *   - a local time that never happens (the spring change, 02:00-03:00 on the
 *     second Sunday of March) resolves to the instant just after the gap -
 *     02:30 on that morning runs at 03:30, not 01:30.
 */

export const ANALYSIS_WINDOWS = ["24h", "3d", "7d", "14d", "30d"] as const;
export type AnalysisWindow = (typeof ANALYSIS_WINDOWS)[number];

export const WINDOW_LABELS: Record<AnalysisWindow, string> = {
  "24h": "last 24 hours",
  "3d": "last 3 days",
  "7d": "last 7 days",
  "14d": "last 14 days",
  "30d": "last 30 days",
};

export function isAnalysisWindow(value: string): value is AnalysisWindow {
  return (ANALYSIS_WINDOWS as readonly string[]).includes(value);
}

export const SCHEDULE_KINDS = ["daily", "every_n_days", "weekly", "monthly"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

/**
 * The schedule, minus the time of day, which travels beside it.
 *
 * `every_n_days` carries an anchor date (a local calendar date, YYYY-MM-DD)
 * so that "every 3 days" means the same three days after a pause as before
 * it; without one, every recomputation would restart the count from today.
 * `weekly` weekdays are ISO: 1 is Monday, 7 is Sunday. `monthly` is clamped to
 * the month's length, so "day 31" runs on the 30th in June and the 28th in a
 * February with 28 days.
 */
export type ScheduleSpec =
  | { kind: "daily" }
  | { kind: "every_n_days"; intervalDays: number; anchorDate: string }
  | { kind: "weekly"; weekdays: number[] }
  | { kind: "monthly"; dayOfMonth: number };

export const MAX_INTERVAL_DAYS = 365;

export interface LocalParts {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  hour: number; // 0..23
  minute: number; // 0..59
  second: number; // 0..59
  /** ISO weekday, 1 = Monday .. 7 = Sunday. */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (f === undefined) {
    // Throws RangeError on a zone Intl does not know, which is the right
    // failure: a schedule in a zone nobody can resolve is not a schedule.
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timezone, f);
  }
  return f;
}

/** The wall clock in `timezone` at `instant`. */
export function localParts(instant: Date, timezone: string): LocalParts {
  const parts = formatterFor(timezone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(get("hour"));
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    // Some ICU builds print 24 for midnight under h23; normalise.
    hour: hour === 24 ? 0 : hour,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
}

/** `timezone`'s offset from UTC at `instant`, in milliseconds (positive east of UTC). */
function offsetAt(instant: Date, timezone: string): number {
  const p = localParts(instant, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // The instant's own milliseconds are not in the parts; compare whole seconds.
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

export interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * The instant at which the wall clock in `timezone` reads `local`.
 *
 * Try the zone's offset at the naive guess, then the offset at the instant
 * that produces; the candidates that read back as the requested wall time are
 * the answers. Two answers is the autumn overlap - take the earlier. None is
 * the spring gap - take the later candidate, which is the first instant after
 * the gap on that clock.
 */
export function zonedDateTimeToUtc(local: LocalDateTime, timezone: string): Date {
  const guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0);
  const offsets = new Set<number>();
  const first = offsetAt(new Date(guess), timezone);
  offsets.add(first);
  offsets.add(offsetAt(new Date(guess - first), timezone));
  // One more round catches a zone whose two candidates straddle a third
  // offset, which does not occur in any real zone but costs nothing.
  for (const o of [...offsets]) offsets.add(offsetAt(new Date(guess - o), timezone));

  const candidates = [...offsets].map((o) => new Date(guess - o));
  const matches = candidates.filter((c) => {
    const p = localParts(c, timezone);
    return (
      p.year === local.year &&
      p.month === local.month &&
      p.day === local.day &&
      p.hour === local.hour &&
      p.minute === local.minute
    );
  });

  if (matches.length > 0) {
    return new Date(Math.min(...matches.map((m) => m.getTime())));
  }
  return new Date(Math.max(...candidates.map((c) => c.getTime())));
}

export function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const m = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(value);
  if (m === null) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

export function parseCalendarDate(value: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m === null) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Whole calendar days from one local date to another, DST-free. */
function calendarDaysBetween(
  from: { year: number; month: number; day: number },
  to: { year: number; month: number; day: number },
): number {
  const a = Date.UTC(from.year, from.month - 1, from.day);
  const b = Date.UTC(to.year, to.month - 1, to.day);
  return Math.round((b - a) / 86_400_000);
}

function addCalendarDays(
  date: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number; weekday: number } {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  // getUTCDay: 0 = Sunday. ISO: 7 = Sunday.
  const iso = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: iso };
}

/**
 * Does the schedule fire on this local date?
 */
function firesOn(
  spec: ScheduleSpec,
  date: { year: number; month: number; day: number; weekday: number },
): boolean {
  switch (spec.kind) {
    case "daily":
      return true;
    case "weekly":
      return spec.weekdays.includes(date.weekday);
    case "every_n_days": {
      const anchor = parseCalendarDate(spec.anchorDate);
      if (anchor === null) return false;
      const gap = calendarDaysBetween(anchor, date);
      return gap >= 0 && gap % spec.intervalDays === 0;
    }
    case "monthly":
      return date.day === Math.min(spec.dayOfMonth, daysInMonth(date.year, date.month));
  }
}

/**
 * A spec that cannot fire, or carries a value outside its range, as a
 * sentence; null when it is sound. Shape is checked by Zod before this is
 * reached; this is the arithmetic the shape cannot express.
 */
export function scheduleProblem(spec: ScheduleSpec): string | null {
  switch (spec.kind) {
    case "daily":
      return null;
    case "weekly":
      if (spec.weekdays.length === 0) return "Choose at least one weekday.";
      if (spec.weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
        return "Weekdays are 1 (Monday) to 7 (Sunday).";
      }
      if (new Set(spec.weekdays).size !== spec.weekdays.length) return "A weekday is listed twice.";
      return null;
    case "every_n_days":
      if (!Number.isInteger(spec.intervalDays) || spec.intervalDays < 2 || spec.intervalDays > MAX_INTERVAL_DAYS) {
        return `Every N days needs N between 2 and ${MAX_INTERVAL_DAYS}. For every day, choose Daily.`;
      }
      if (parseCalendarDate(spec.anchorDate) === null) return "The start date is not a calendar date.";
      return null;
    case "monthly":
      if (!Number.isInteger(spec.dayOfMonth) || spec.dayOfMonth < 1 || spec.dayOfMonth > 31) {
        return "The day of the month is 1 to 31.";
      }
      return null;
  }
}

/**
 * The first instant strictly after `after` at which the schedule fires, in
 * `timezone`.
 *
 * Walks the local calendar forward one day at a time from `after`'s local
 * date and converts the first matching date-plus-time; a schedule that cannot
 * fire within a year is refused rather than looped on forever, which can
 * only happen with a spec `scheduleProblem` would have rejected.
 */
export function computeNextRun(
  spec: ScheduleSpec,
  timeOfDay: string,
  timezone: string,
  after: Date,
): Date {
  const time = parseTimeOfDay(timeOfDay);
  if (time === null) throw new Error(`Not a time of day: ${timeOfDay}`);
  const problem = scheduleProblem(spec);
  if (problem !== null) throw new Error(problem);

  const start = localParts(after, timezone);
  for (let offset = 0; offset <= MAX_INTERVAL_DAYS + 31; offset += 1) {
    const date = addCalendarDays(start, offset);
    if (!firesOn(spec, date)) continue;
    const instant = zonedDateTimeToUtc({ ...date, hour: time.hour, minute: time.minute }, timezone);
    if (instant.getTime() > after.getTime()) return instant;
  }
  throw new Error("The schedule never fires within a year.");
}

const WEEKDAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** "Every Monday and Thursday at 06:00" - the cadence and the local time, no zone. */
export function describeCadence(spec: ScheduleSpec, timeOfDay: string): string {
  switch (spec.kind) {
    case "daily":
      return `Every day at ${timeOfDay}`;
    case "every_n_days":
      return `Every ${spec.intervalDays} days at ${timeOfDay}`;
    case "weekly": {
      const days = [...spec.weekdays].sort((a, b) => a - b).map((d) => WEEKDAY_NAMES[d] ?? String(d));
      return `Every ${joinWords(days)} at ${timeOfDay}`;
    }
    case "monthly":
      return `Monthly on the ${ordinal(spec.dayOfMonth)} at ${timeOfDay}`;
  }
}

/**
 * The schedule in plain words for the list: "Every Monday at 06:00 (New
 * York time) · last 7 days". The zone is named because two buildings can be
 * in two zones and the row has to say which clock 06:00 is on.
 */
export function describeSchedule(
  spec: ScheduleSpec,
  timeOfDay: string,
  timezone: string,
  window: AnalysisWindow,
): string {
  return `${describeCadence(spec, timeOfDay)} (${timezone}) · ${WINDOW_LABELS[window]}`;
}

/**
 * An instant, as the wall clock in a zone: "Mon, 16 Nov 2026, 06:00". For the
 * "next run" line beside its UTC equivalent.
 */
export function formatInZone(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hourCycle: "h23",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(instant);
}

/**
 * Read a stored `schedule_params` row back into a spec, or null when the
 * stored JSON is not the shape the kind needs. The service refuses to
 * activate such a report rather than guessing.
 */
export function readScheduleSpec(kind: string, params: unknown): ScheduleSpec | null {
  const p = params !== null && typeof params === "object" ? (params as Record<string, unknown>) : {};
  switch (kind) {
    case "daily":
      return { kind: "daily" };
    case "weekly": {
      const weekdays = p.weekdays;
      if (!Array.isArray(weekdays) || !weekdays.every((d) => typeof d === "number")) return null;
      return { kind: "weekly", weekdays: weekdays as number[] };
    }
    case "every_n_days": {
      if (typeof p.intervalDays !== "number" || typeof p.anchorDate !== "string") return null;
      return { kind: "every_n_days", intervalDays: p.intervalDays, anchorDate: p.anchorDate };
    }
    case "monthly": {
      if (typeof p.dayOfMonth !== "number") return null;
      return { kind: "monthly", dayOfMonth: p.dayOfMonth };
    }
    default:
      return null;
  }
}

/** The JSON stored in `schedule_params` for a spec: everything but the kind. */
export function scheduleParamsOf(spec: ScheduleSpec): Record<string, unknown> {
  switch (spec.kind) {
    case "daily":
      return {};
    case "weekly":
      return { weekdays: [...spec.weekdays].sort((a, b) => a - b) };
    case "every_n_days":
      return { intervalDays: spec.intervalDays, anchorDate: spec.anchorDate };
    case "monthly":
      return { dayOfMonth: spec.dayOfMonth };
  }
}

/** Today's date in a zone as YYYY-MM-DD - the default anchor for every-N-days. */
export function todayIn(timezone: string, now: Date = new Date()): string {
  const p = localParts(now, timezone);
  const mm = String(p.month).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  return `${p.year}-${mm}-${dd}`;
}
