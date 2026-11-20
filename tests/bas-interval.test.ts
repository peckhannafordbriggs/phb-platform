import { describe, expect, it } from "vitest";
import {
  BREAKS_LISTED_LIMIT,
  NO_INTERVAL_BREAK_S,
  breakThresholdS,
  classifySpacing,
  describeBreaks,
  describeExpectedInterval,
  expectedInterval,
  formatInterval,
  gapsBetween,
  longestBreaks,
  storedIntervalFor,
  summariseBreaks,
  summariseGaps,
} from "@/lib/modules/bas/interval";
import { buildTrend } from "@/lib/modules/bas/service";
import { OP_STATE, ROOM_T } from "./bas-live-fixture";

/**
 * How often a point is expected to report, and what a break is (2026-11-20).
 *
 * Regular and change-of-value spacing are judged on REAL readings - the lab's
 * points_RoomT (five-minute interval, 7,831 rows) and the office's OpState
 * (change-of-value, 301 records over two and a half years) - and the mixed
 * shapes, which the estate does not happen to hold, on synthetic ones.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const NONE = { gaps: 0, medianS: null, withinTolerance: 0 };

/** Timestamps from a start, one per gap given in seconds. */
function series(startMs: number, gapsS: number[]): number[] {
  const out = [startMs];
  for (const g of gapsS) out.push(out[out.length - 1]! + g * 1000);
  return out;
}

const repeat = (value: number, times: number) => Array.from({ length: times }, () => value);

describe("interval inference", () => {
  it("measures a regular trend's interval from real readings: points_RoomT reports every 5 min", () => {
    const summary = summariseGaps(gapsBetween(ROOM_T.readings.map(([ms]) => ms)));
    expect(classifySpacing(summary)).toBe("even");
    expect(summary.medianS).toBeCloseTo(300, 0);

    const expected = expectedInterval({ enteredS: null, range: summary, storedMeasuredS: null });
    expect(expected).toMatchObject({ seconds: 300, source: "measured", spacing: "even", breakThresholdS: 600 });
    expect(describeExpectedInterval(expected)).toBe("Reports about every 5 min (measured)");
  });

  it("gives a change-of-value trend no expected interval at all: OpState's gaps are how the equipment behaved", () => {
    const summary = summariseGaps(gapsBetween(OP_STATE.readings.map(([ms]) => ms)));
    expect(summary.gaps).toBeGreaterThan(100);
    expect(classifySpacing(summary)).toBe("uneven");

    const expected = expectedInterval({ enteredS: null, range: summary, storedMeasuredS: 900 });
    // Not the median, and not even the stored value: uneven means none.
    expect(expected).toMatchObject({ seconds: null, source: null, spacing: "uneven", breakThresholdS: NO_INTERVAL_BREAK_S });
    expect(describeExpectedInterval(expected)).toBe("Logs on change — no fixed interval");
  });

  it("is robust to a mixed series: a 30-minute trend with outages, late polls and a duplicate is still 30 minutes", () => {
    const gaps = [
      ...repeat(1800, 100),
      3 * 3600, // an outage
      ...repeat(1800, 60),
      1740, 1860, 1800, 1830, // late and early polls, within a tenth
      0, // a duplicate timestamp: not a gap
      ...repeat(1800, 60),
      26 * 3600, // a day-long hole
      ...repeat(1800, 40),
    ];
    const summary = summariseGaps(gapsBetween(series(0, gaps)));
    expect(classifySpacing(summary)).toBe("even");
    expect(summary.medianS).toBe(1800);
    expect(expectedInterval({ enteredS: null, range: summary, storedMeasuredS: null }).seconds).toBe(1800);
  });

  it("refuses to guess for a trend that changed interval half way: no single interval, so none", () => {
    const summary = summariseGaps(gapsBetween(series(0, [...repeat(900, 50), ...repeat(1800, 50)])));
    expect(classifySpacing(summary)).toBe("uneven");
    expect(expectedInterval({ enteredS: null, range: summary, storedMeasuredS: 1800 }).seconds).toBeNull();
  });

  it("takes Workbench's interval first, whatever the readings say", () => {
    const summary = summariseGaps(gapsBetween(ROOM_T.readings.map(([ms]) => ms)));
    const expected = expectedInterval({ enteredS: 900, range: summary, storedMeasuredS: 300 });
    expect(expected).toMatchObject({ seconds: 900, source: "workbench", breakThresholdS: 1800 });
    expect(describeExpectedInterval(expected)).toBe("Reports about every 15 min (from Workbench)");
  });

  it("falls back to the scheduler's stored measurement when the range holds too few gaps", () => {
    const thin = summariseGaps([1800, 1800, 1800]);
    expect(classifySpacing(thin)).toBe("insufficient");
    expect(expectedInterval({ enteredS: null, range: thin, storedMeasuredS: 1800 })).toMatchObject({
      seconds: 1800,
      source: "measured",
      spacing: "insufficient",
    });
    expect(expectedInterval({ enteredS: null, range: thin, storedMeasuredS: null })).toMatchObject({
      seconds: null,
      breakThresholdS: NO_INTERVAL_BREAK_S,
    });
    expect(describeExpectedInterval(expectedInterval({ enteredS: null, range: NONE, storedMeasuredS: null }))).toBe(
      "Too few readings to measure an interval",
    );
  });

  it("is the collector's own spacing rule: ten gaps, four in five within a tenth of the median", () => {
    expect(classifySpacing({ gaps: 9, medianS: 60, withinTolerance: 9 })).toBe("insufficient");
    expect(classifySpacing({ gaps: 10, medianS: 60, withinTolerance: 8 })).toBe("even");
    expect(classifySpacing({ gaps: 10, medianS: 60, withinTolerance: 7 })).toBe("uneven");
  });

  it("stores the median for an even spacing, NULL for an uneven one, and leaves a thin week alone", () => {
    expect(storedIntervalFor({ gaps: 300, medianS: 1799.6, withinTolerance: 290 })).toBe(1800);
    expect(storedIntervalFor({ gaps: 300, medianS: 1800, withinTolerance: 100 })).toBeNull();
    expect(storedIntervalFor({ gaps: 4, medianS: 1800, withinTolerance: 4 })).toBeUndefined();
  });

  it("words intervals the way a person says them", () => {
    expect(formatInterval(45)).toBe("45 s");
    expect(formatInterval(60)).toBe("1 min");
    expect(formatInterval(1800)).toBe("30 min");
    expect(formatInterval(90)).toBe("1.5 min");
    expect(formatInterval(3600)).toBe("1 h");
    expect(formatInterval(5400)).toBe("1.5 h");
    expect(formatInterval(86_400)).toBe("1 day");
  });
});

describe("the break definition", () => {
  it("is twice the expected interval, and four hours with none", () => {
    expect(breakThresholdS(1800)).toBe(3600);
    expect(breakThresholdS(300)).toBe(600);
    expect(breakThresholdS(null)).toBe(4 * 3600);
  });

  it("does not break CEI's shape: a 30-minute trend with nothing entered draws one unbroken week", () => {
    // 336 readings 30 minutes apart. Under the old rule (three entered
    // intervals, a 15-minute floor with none) every one of the 335 gaps was a
    // break. Now the expected interval is measured and nothing breaks.
    const rows = series(Date.UTC(2026, 10, 13), repeat(1800, 335)).map((ms) => ({ ts: new Date(ms), value_num: 70 }));
    const summary = summariseGaps(gapsBetween(rows.map((r) => r.ts.getTime())));
    const expected = expectedInterval({ enteredS: null, range: summary, storedMeasuredS: null });
    expect(expected.seconds).toBe(1800);
    expect(buildTrend(rows, expected.seconds).gaps).toHaveLength(0);
    expect(buildTrend(rows, null).gaps).toHaveLength(0);
    // And the real hole in it is still found: three missed readings.
    const holed = [...rows.slice(0, 100), ...rows.slice(104)];
    const found = buildTrend(holed, expected.seconds).gaps;
    expect(found).toHaveLength(1);
    expect(found[0]!.hours).toBeCloseTo(2.5, 5);
  });

  it("breaks a gap over the line and not one at it", () => {
    const at = (m: number) => ({ ts: new Date(Date.UTC(2026, 10, 13) + m * MIN), value_num: 1 });
    expect(buildTrend([at(0), at(60)], 1800).gaps).toHaveLength(0); // exactly 2 x 30 min
    expect(buildTrend([at(0), at(61)], 1800).gaps).toHaveLength(1);
  });
});

describe("the breaks summary", () => {
  const from = Date.UTC(2026, 10, 13, 0, 0);
  const to = from + 7 * 24 * HOUR;

  it("counts every break, finds the longest, and says how much of the period is missing", () => {
    const breaks = [
      { fromMs: from + 10 * HOUR, toMs: from + 13.2 * HOUR }, // 3.2 h
      { fromMs: from + 30 * HOUR, toMs: from + 31 * HOUR },
      { fromMs: from + 50 * HOUR, toMs: from + 52 * HOUR },
    ];
    const summary = summariseBreaks({ breaks, rangeFromMs: from, rangeToMs: to, earliestMs: from - 30 * 24 * HOUR });
    expect(summary.count).toBe(3);
    expect(summary.longestHours).toBeCloseTo(3.2, 5);
    expect(summary.missingShare).toBeCloseTo(6.2 / 168, 5);
    expect(describeBreaks(summary, expectedInterval({ enteredS: 1800, range: NONE, storedMeasuredS: null }))).toBe(
      "3 breaks, longest 3.2 h, 3.7% of the period missing",
    );
  });

  it("clips a break that straddles the range, and measures the period from the point's first reading", () => {
    const summary = summariseBreaks({
      breaks: [{ fromMs: from - 5 * HOUR, toMs: from + 1 * HOUR }],
      rangeFromMs: from,
      rangeToMs: to,
      earliestMs: from - 24 * HOUR,
    });
    // Six hours long, one of it inside the range.
    expect(summary.longestHours).toBeCloseTo(6, 5);
    expect(summary.missingShare).toBeCloseTo(1 / 168, 5);

    // A point added on day 3: the share is of the four days it existed.
    const late = summariseBreaks({
      breaks: [{ fromMs: from + 100 * HOUR, toMs: from + 104 * HOUR }],
      rangeFromMs: from,
      rangeToMs: to,
      earliestMs: from + 72 * HOUR,
    });
    expect(late.periodHours).toBeCloseTo(96, 5);
    expect(late.missingShare).toBeCloseTo(4 / 96, 5);
  });

  it("counts a break's missing time as its length less one expected interval", () => {
    // Every 30 minutes, three readings missing: a 2-hour gap, 1.5 h missing.
    const breaks = [{ fromMs: from, toMs: from + 2 * HOUR }];
    const withInterval = summariseBreaks({ breaks, rangeFromMs: from, rangeToMs: to, earliestMs: from, expectedS: 1800 });
    expect(withInterval.longestHours).toBeCloseTo(2, 5);
    expect(withInterval.missingShare).toBeCloseTo(1.5 / 168, 6);
    // With no expected interval the whole gap is missing.
    expect(summariseBreaks({ breaks, rangeFromMs: from, rangeToMs: to, earliestMs: from, expectedS: null }).missingShare).toBeCloseTo(2 / 168, 6);
  });

  it("keeps an ongoing break marked, and says so in words when there is none", () => {
    const summary = summariseBreaks({
      breaks: [{ fromMs: to - 6 * HOUR, toMs: to, ongoing: true }],
      rangeFromMs: from,
      rangeToMs: to,
      earliestMs: from,
    });
    expect(summary.breaks[0]).toMatchObject({ ongoing: true, hours: 6 });
    const none = summariseBreaks({ breaks: [], rangeFromMs: from, rangeToMs: to, earliestMs: from });
    expect(describeBreaks(none, expectedInterval({ enteredS: 1800, range: NONE, storedMeasuredS: null }))).toBe(
      "No breaks — every gap is within 1 h",
    );
  });

  it("lists the five longest, longest first, and caps the list but never the count", () => {
    const breaks = Array.from({ length: BREAKS_LISTED_LIMIT + 50 }, (_, i) => ({
      fromMs: from + i * 2 * HOUR,
      toMs: from + i * 2 * HOUR + (1 + (i % 7)) * 10 * MIN,
    }));
    const summary = summariseBreaks({ breaks, rangeFromMs: from, rangeToMs: from + 3000 * HOUR, earliestMs: from });
    expect(summary.count).toBe(BREAKS_LISTED_LIMIT + 50);
    expect(summary.breaks).toHaveLength(BREAKS_LISTED_LIMIT);
    const five = longestBreaks(summary.breaks);
    expect(five).toHaveLength(5);
    expect(five.map((b) => b.hours)).toEqual([...five.map((b) => b.hours)].sort((a, b) => b - a));
    expect(five[0]!.hours).toBeCloseTo(70 / 60, 5);
  });
});
