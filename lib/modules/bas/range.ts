/**
 * Custom date ranges and downsampling for the Point Explorer trend.
 *
 * Pure. Nothing here touches the database or the DOM, so every rule is
 * testable on its own, and the SQL in service.ts is built from the values
 * chosen here rather than deciding anything itself.
 *
 * TIME ZONE. A person picking "14 August" means that calendar day where the
 * building is, not where their laptop is and not UTC. So a calendar date is
 * carried as `YYYY-MM-DD` text all the way to PostgreSQL, which turns it into
 * an instant against `bas_sites.timezone` - see `getPointExplorer`. This module
 * never converts a date to an instant, because JavaScript's Date cannot do it
 * in an arbitrary zone without a library, and the database already can.
 */

/**
 * The most raw readings the trend will carry before it is downsampled.
 *
 * MEASURED, not guessed - on 2026-09-22, in headless Chrome (GPU disabled) over
 * the DevTools protocol on the platform owner's laptop, rendering the real
 * `TrendChart` 900 px wide with real points_RoomT readings, the 7,828 the
 * database held tiled forward in time for the larger counts. Two runs per
 * count; the smaller taken. Three things were timed: the first paint of the
 * curve, a drag-to-zoom (a domain change, which recomputes the path), and the
 * tooltip's response to a mousemove.
 *
 *   samples   draw     zoom    hover
 *     1,000   115 ms    64 ms   19 ms
 *     4,000   150 ms   131 ms   16 ms
 *     7,828   251 ms   180 ms   13 ms
 *    10,000   366 ms   266 ms   17 ms
 *    12,000   377-695  288-505  14-29   (the two runs disagreed)
 *    16,000   492 ms   408 ms   15 ms
 *    18,000   842 ms   548 ms   27 ms
 *    20,000  1250 ms   596 ms   26 ms
 *    35,000  1575 ms   910 ms   33 ms
 *    70,000  2685 ms  1925 ms   39 ms   (3.3 MB of SVG path)
 *
 * Hover stays cheap at every count because Recharts memoises the path and only
 * moves the cursor. Drawing and zooming do not: past about 12,000 samples a
 * drag to zoom takes half a second per step and the chart is no longer being
 * used, it is being waited on. At 70,000 - two years of a 15-minute point -
 * it is a 2.7 second hang followed by a 2 second hang per drag. 10,000 is the
 * last count that stayed under 400 ms for both draw and zoom in every run,
 * with margin for a slower machine and for the tiles and gap table that share
 * the page. The measurement is in the branch's report and in runbook.md.
 */
export const MAX_RAW_TREND_POINTS = 10_000;

/**
 * How many buckets a downsampled trend aims for, at most.
 *
 * A bucketed trend draws two series - the average line and the min-max band -
 * so 3,000 buckets is about 6,000 path points, which the table above puts at
 * roughly a quarter of a second. The chart is about 900 px wide, so anything
 * finer than this is already several buckets per pixel.
 */
export const MAX_TREND_BUCKETS = 3_000;

/**
 * The bucket widths the downsampler may choose from, seconds, ascending.
 *
 * Human widths rather than "range / N": "averaged to one point per hour" is a
 * sentence a person can act on, "one point per 47 minutes" is not. The largest
 * is a day; at 3,000 day-buckets that is eight years, longer than any history
 * this database will hold before the schema changes for other reasons.
 */
export const BUCKET_LADDER_S: readonly number[] = [
  5 * 60,
  10 * 60,
  15 * 60,
  30 * 60,
  60 * 60,
  2 * 60 * 60,
  3 * 60 * 60,
  6 * 60 * 60,
  12 * 60 * 60,
  24 * 60 * 60,
];

const DAY_S = 24 * 60 * 60;

/**
 * The smallest bucket on the ladder that keeps the range under the bucket cap.
 *
 * Decided from the RANGE, not from the readings: a range that held readings
 * only in its last month would otherwise be bucketed as if it were a month
 * long, and then its empty first year would have no buckets to be empty.
 * Falls to the largest rung rather than refusing - a range too long even for
 * day-buckets is drawn coarsely and honestly labelled, not rejected.
 */
export function chooseBucketSeconds(
  rangeMs: number,
  maxBuckets: number = MAX_TREND_BUCKETS,
): number {
  const rangeS = Math.max(0, rangeMs) / 1000;
  for (const width of BUCKET_LADDER_S) {
    if (rangeS / width <= maxBuckets) return width;
  }
  return BUCKET_LADDER_S[BUCKET_LADDER_S.length - 1]!;
}

/**
 * Whether a bucket width is a whole number of days, and so has to be cut on
 * LOCAL midnights rather than on fixed-length intervals from the range start.
 *
 * A day bucket cut every 86,400 seconds would drift an hour off the calendar
 * at every clock change and never come back. `date_bin` cannot know that;
 * `date_trunc('day', ts AT TIME ZONE zone)` can, and the service uses it for
 * exactly these widths.
 */
export function isCalendarBucket(bucketSeconds: number): boolean {
  return bucketSeconds >= DAY_S && bucketSeconds % DAY_S === 0;
}

/** "hour", "6 hours", "day" - the noun for the notice on the chart. */
export function bucketLabel(bucketSeconds: number): string {
  if (bucketSeconds % DAY_S === 0) {
    const days = bucketSeconds / DAY_S;
    return days === 1 ? "day" : `${days} days`;
  }
  if (bucketSeconds % 3600 === 0) {
    const hours = bucketSeconds / 3600;
    return hours === 1 ? "hour" : `${hours} hours`;
  }
  const minutes = Math.round(bucketSeconds / 60);
  return minutes === 1 ? "minute" : `${minutes} minutes`;
}

/**
 * A calendar date as the picker sends it: `YYYY-MM-DD`, and a real day.
 *
 * `2026-02-30` is refused here rather than by PostgreSQL, because the message
 * a person gets back should name the date, and a 22 from the database would
 * name the whole request. Proleptic Gregorian, which is what both JavaScript
 * and PostgreSQL use.
 */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || month < 1 || month > 12 || day < 1) return false;
  // Day 0 of the next month is the last day of this one. UTC so the local
  // zone cannot shift the answer.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

/**
 * Compare two `YYYY-MM-DD` strings. Lexical order IS chronological order for
 * this format, which is the reason the format is used.
 */
export function compareCalendarDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every whole calendar year from `first` to `last`, ascending. */
export function yearsBetween(first: number | null, last: number | null): number[] {
  if (first === null || last === null || !Number.isFinite(first) || !Number.isFinite(last)) {
    return [];
  }
  const years: number[] = [];
  for (let year = Math.min(first, last); year <= Math.max(first, last); year++) {
    years.push(year);
  }
  return years;
}

/**
 * The dates a year shortcut asks for. The current year ends TODAY, not on 31
 * December: an end date in the future is refused, and a shortcut that
 * produced a refused request would be a broken button.
 */
export function yearRange(
  year: number,
  today: string,
): { from: string; to: string } {
  const from = `${year}-01-01`;
  const lastDay = `${year}-12-31`;
  return { from, to: compareCalendarDates(lastDay, today) > 0 ? today : lastDay };
}
