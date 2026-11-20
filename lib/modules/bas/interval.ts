/**
 * How often a point is EXPECTED to report, and what counts as a break in its
 * readings (2026-11-20). Pure: the page, the scheduler pass and the tests all
 * read this file, and nothing here touches a database.
 *
 * Why it exists. CEI_JCI_N2's 334 histories report about every 30 minutes and
 * nobody has entered an interval for them from Workbench. The trend's break
 * threshold fell back to a 15-minute floor, so every ordinary 30-minute gap
 * was a "break": about 280 a week per point, one line each. The expectation
 * was wrong, not the data.
 *
 * THE PRECEDENCE, one rule for every point on every station:
 *
 *   1. collection_interval_s, entered from Workbench           "from Workbench"
 *   2. the spacing measured over the range on screen, when it
 *      is EVEN - the median gap between consecutive readings     "measured"
 *   3. the stored measured_interval_s (the scheduler's seven-
 *      day measurement), when the range holds too few gaps to
 *      judge                                                      "measured"
 *   4. none: the gaps are uneven (a change-of-value trend has
 *      no interval), or there is nothing to measure
 *
 * EVEN is the collector's own spacing rule (phb-bas, sync.py, spacing_kind):
 * at least 10 gaps, and four in five of them within a tenth of the median.
 * The median, not the mean, so a week with three outages and a few late polls
 * still measures 30 minutes. A change-of-value trend fails it - its gaps are
 * how hard the equipment cycles - and gets NO expected interval, never a
 * guess. That is the 2026-09-18 rule (add_bas_shortest_full_span) and this
 * file keeps it: the measured value lives in its own column and is never
 * written into collection_interval_s.
 *
 * A BREAK is a gap longer than twice the expected interval; with no expected
 * interval, a gap longer than four hours.
 */

/** The collector's spacing rule, mirrored exactly (phb-bas, collector/sync.py). */
export const SPACING_MIN_GAPS = 10;
export const SPACING_EVEN_SHARE = 0.8;
export const SPACING_TOLERANCE = 0.1;

/** A break is a gap longer than this many expected intervals. */
export const BREAK_INTERVAL_MULTIPLE = 2;
/** With no expected interval, a break is a gap longer than this. */
export const NO_INTERVAL_BREAK_S = 4 * 3600;

/** How far back the scheduler measures the stored interval. */
export const MEASURED_INTERVAL_WINDOW_DAYS = 7;

export type SpacingKind = "even" | "uneven" | "insufficient";

/** What the gaps between one point's readings look like, summarised in SQL or here. */
export interface SpacingSummary {
  /** Gaps between consecutive readings, zero-length gaps excluded. */
  gaps: number;
  /** The median gap in seconds, or null when there are no gaps. */
  medianS: number | null;
  /** How many gaps sit within SPACING_TOLERANCE of the median. */
  withinTolerance: number;
}

/** The classification, from a summary. The one place the rule is applied. */
export function classifySpacing(summary: SpacingSummary): SpacingKind {
  if (summary.gaps < SPACING_MIN_GAPS || summary.medianS === null || summary.medianS <= 0) {
    return "insufficient";
  }
  return summary.withinTolerance / summary.gaps >= SPACING_EVEN_SHARE ? "even" : "uneven";
}

/**
 * The summary of a list of gaps, in seconds. The SQL in the service computes
 * the same three numbers in the database; this is what the tests and any
 * caller holding the readings use. Lower median, as `percentile_disc(0.5)`.
 */
export function summariseGaps(gapsS: readonly number[]): SpacingSummary {
  const gaps = gapsS.filter((g) => Number.isFinite(g) && g > 0).sort((a, b) => a - b);
  if (gaps.length === 0) return { gaps: 0, medianS: null, withinTolerance: 0 };
  const medianS = gaps[Math.ceil(gaps.length / 2) - 1]!;
  const withinTolerance = gaps.filter((g) => Math.abs(g - medianS) <= SPACING_TOLERANCE * medianS).length;
  return { gaps: gaps.length, medianS, withinTolerance };
}

/** The gaps between ordered timestamps, in seconds. */
export function gapsBetween(timestampsMs: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < timestampsMs.length; i++) out.push((timestampsMs[i]! - timestampsMs[i - 1]!) / 1000);
  return out;
}

/** Where the expected interval came from. Said on the page beside it. */
export type IntervalSource = "workbench" | "measured";

export interface ExpectedInterval {
  /** Seconds between readings expected; null when there is none. */
  seconds: number | null;
  /** Where `seconds` came from; null when there is none. */
  source: IntervalSource | null;
  /** What the readings in the range looked like, whatever decided `seconds`. */
  spacing: SpacingKind;
  /** A gap longer than this is a break, in seconds. */
  breakThresholdS: number;
}

/** The precedence above, applied. */
export function expectedInterval(input: {
  /** bas_points.collection_interval_s */
  enteredS: number | null;
  /** The spacing of the readings in the range on screen. */
  range: SpacingSummary;
  /** bas_points.measured_interval_s, the scheduler's measurement. */
  storedMeasuredS: number | null;
}): ExpectedInterval {
  const spacing = classifySpacing(input.range);
  let seconds: number | null = null;
  let source: IntervalSource | null = null;

  if (input.enteredS !== null && input.enteredS > 0) {
    seconds = input.enteredS;
    source = "workbench";
  } else if (spacing === "even") {
    seconds = Math.round(input.range.medianS!);
    source = "measured";
  } else if (spacing === "insufficient" && input.storedMeasuredS !== null && input.storedMeasuredS > 0) {
    seconds = input.storedMeasuredS;
    source = "measured";
  }

  return { seconds, source, spacing, breakThresholdS: breakThresholdS(seconds) };
}

/** A gap longer than this is a break: twice the expected interval, or four hours with none. */
export function breakThresholdS(expectedS: number | null): number {
  return expectedS === null || expectedS <= 0 ? NO_INTERVAL_BREAK_S : BREAK_INTERVAL_MULTIPLE * expectedS;
}

/**
 * The value the scheduler stores: the median for an even spacing, null for an
 * uneven one, and `undefined` - leave the stored value alone - when there are
 * too few gaps to judge. A point that went quiet for a week keeps the interval
 * it had; a point that turned out to be change-of-value loses it.
 */
export function storedIntervalFor(summary: SpacingSummary): number | null | undefined {
  switch (classifySpacing(summary)) {
    case "even":
      return Math.max(1, Math.round(summary.medianS!));
    case "uneven":
      return null;
    case "insufficient":
      return undefined;
  }
}

// ------------------------------------------------------------------ words

/** "30 min", "1 min", "45 s", "2 h", "1.5 h", "1 day". */
export function formatInterval(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) {
    const minutes = seconds / 60;
    return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1).replace(/\.0$/, "")} min`;
  }
  if (seconds < 86_400) {
    const hours = seconds / 3600;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1).replace(/\.0$/, "")} h`;
  }
  const days = seconds / 86_400;
  const d = Number.isInteger(days) ? String(days) : days.toFixed(1).replace(/\.0$/, "");
  return `${d} day${d === "1" ? "" : "s"}`;
}

/**
 * The one line the page shows for the expectation:
 *   "Reports about every 30 min (measured)"
 *   "Reports about every 15 min (from Workbench)"
 *   "Logs on change - no fixed interval"
 *   "Too few readings to measure an interval"
 */
export function describeExpectedInterval(expected: ExpectedInterval): string {
  if (expected.seconds !== null && expected.source !== null) {
    return `Reports about every ${formatInterval(expected.seconds)} (${expected.source === "workbench" ? "from Workbench" : "measured"})`;
  }
  return expected.spacing === "uneven" ? "Logs on change — no fixed interval" : "Too few readings to measure an interval";
}

/** What a break means for this point, in one clause: "a gap over 1 h" / "a gap over 4 h". */
export function describeBreakRule(expected: ExpectedInterval): string {
  return `a gap over ${formatInterval(expected.breakThresholdS)}`;
}

// ----------------------------------------------------------------- breaks

/** One break: no readings from `fromMs` to `toMs`. `ongoing` when nothing has arrived since. */
export interface TrendBreak {
  fromMs: number;
  toMs: number;
  hours: number;
  ongoing?: boolean;
}

/** How many breaks the payload lists. The counts and the share are over all of them. */
export const BREAKS_LISTED_LIMIT = 1000;
/** How many the page lists before "Show all". */
export const BREAKS_SHOWN_FIRST = 5;

export interface BreaksSummary {
  /** Every break by the definition above, whatever the list holds. */
  count: number;
  longestHours: number | null;
  /** The share of the period with no readings, 0 to 1, clipped to the range. */
  missingShare: number;
  /** The period the share is of: the range, from the point's first reading if that is later. */
  periodHours: number;
  /** Chronological, at most BREAKS_LISTED_LIMIT. */
  breaks: TrendBreak[];
}

/**
 * Counts, the longest, and the share of the period missing.
 *
 * The share is of the part of the range the point existed in - from the later
 * of the range start and its first reading - so a point added on Wednesday is
 * not "60% missing" over a week; the extent notice on the chart says when its
 * data begins. Each break is clipped to the range: a break that began before
 * it counts only from the range start.
 *
 * What is MISSING in a break is its length less one expected interval: a
 * 2-hour gap on a 30-minute point is three readings, an hour and a half, not
 * two hours - the half hour after the last reading would have passed anyway.
 * With no expected interval the whole gap counts. The break's own length, the
 * one the list and "longest" show, is the gap between the two readings.
 */
export function summariseBreaks(input: {
  breaks: ReadonlyArray<{ fromMs: number; toMs: number; ongoing?: boolean }>;
  rangeFromMs: number;
  rangeToMs: number;
  /** The point's first reading ever, or null when it has none. */
  earliestMs: number | null;
  /** The expected interval in seconds; one of it is not missing time. Null: none. */
  expectedS?: number | null;
}): BreaksSummary {
  const expectedMs = (input.expectedS ?? 0) * 1000;
  const periodFrom = input.earliestMs === null ? input.rangeFromMs : Math.max(input.rangeFromMs, input.earliestMs);
  const periodMs = Math.max(0, input.rangeToMs - periodFrom);
  const ordered = [...input.breaks].sort((a, b) => a.fromMs - b.fromMs);

  let missingMs = 0;
  let longestMs = 0;
  for (const b of ordered) {
    longestMs = Math.max(longestMs, b.toMs - b.fromMs);
    const from = Math.max(b.fromMs, periodFrom);
    const to = Math.min(b.toMs, input.rangeToMs);
    if (to > from) missingMs += Math.max(0, to - from - expectedMs);
  }

  return {
    count: ordered.length,
    longestHours: ordered.length === 0 ? null : longestMs / 3_600_000,
    missingShare: periodMs === 0 ? 0 : Math.min(1, missingMs / periodMs),
    periodHours: periodMs / 3_600_000,
    breaks: ordered.slice(0, BREAKS_LISTED_LIMIT).map((b) => ({
      fromMs: b.fromMs,
      toMs: b.toMs,
      hours: (b.toMs - b.fromMs) / 3_600_000,
      ...(b.ongoing === true ? { ongoing: true } : {}),
    })),
  };
}

/** The longest `n`, longest first, ties by time. */
export function longestBreaks(breaks: readonly TrendBreak[], n = BREAKS_SHOWN_FIRST): TrendBreak[] {
  return [...breaks].sort((a, b) => b.hours - a.hours || a.fromMs - b.fromMs).slice(0, n);
}

/** "4%", "0.3%", "under 0.1%", "none". */
export function formatShare(share: number): string {
  if (share <= 0) return "none";
  const pct = share * 100;
  if (pct < 0.1) return "under 0.1%";
  if (pct < 10) return `${pct.toFixed(1).replace(/\.0$/, "")}%`;
  return `${Math.round(pct)}%`;
}

/**
 * The summary line: "12 breaks, longest 3.2 h, 4% of the period missing".
 * No breaks: "No breaks — every gap is within 1 h".
 */
export function describeBreaks(summary: BreaksSummary, expected: ExpectedInterval): string {
  if (summary.count === 0) return `No breaks — every gap is within ${formatInterval(expected.breakThresholdS)}`;
  const longest = summary.longestHours === null ? "" : `, longest ${formatBreakHours(summary.longestHours)}`;
  const share = formatShare(summary.missingShare);
  return `${summary.count.toLocaleString("en-US")} break${summary.count === 1 ? "" : "s"}${longest}, ${share === "none" ? "nothing" : share} of the period missing`;
}

/** Hours as the chart's header always wrote them: "3.2 h", "45 min" under an hour. */
export function formatBreakHours(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}
