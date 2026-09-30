import { describe, expect, it } from "vitest";
import {
  BUCKET_LADDER_S,
  MAX_RAW_TREND_POINTS,
  MAX_TREND_BUCKETS,
  bucketLabel,
  chooseBucketSeconds,
  compareCalendarDates,
  isCalendarBucket,
  isCalendarDate,
  yearRange,
  yearsBetween,
} from "@/lib/modules/bas/range";
import {
  FROM_PARAM,
  TO_PARAM,
  DAYS_PARAM,
  readFilters,
  withRange,
} from "@/app/(modules)/bas/filters";
import {
  describeClockOffset,
  describeExtentNotices,
  describeNoReadings,
  describeRange,
  describeSampling,
  formatCalendarDate,
  formatChartTick,
} from "@/app/(modules)/bas/health-client";
import { describeDraftProblem } from "@/app/(modules)/bas/range-picker";
import type { TrendRange } from "@/lib/modules/bas/types";

/**
 * The pure half of the custom range: the rules that need no database.
 *
 * The other half - the bounds PostgreSQL resolves in the building's zone, the
 * downsampler, the spike - is tests/bas-custom-range.test.ts, over real
 * readings.
 */

const DAY = 86_400_000;

describe("the raw cap and the bucket ladder", () => {
  it("is the measured value, not a round guess", () => {
    // The table in range.ts: 10,000 was the last count under 400 ms for both
    // draw and zoom in every run; 12,000 disagreed with itself; 18,000 did not.
    expect(MAX_RAW_TREND_POINTS).toBe(10_000);
    expect(MAX_TREND_BUCKETS).toBeLessThan(MAX_RAW_TREND_POINTS);
  });

  it("is ascending, human, and ends at a day", () => {
    for (let i = 1; i < BUCKET_LADDER_S.length; i++) {
      expect(BUCKET_LADDER_S[i]!).toBeGreaterThan(BUCKET_LADDER_S[i - 1]!);
    }
    expect(BUCKET_LADDER_S[BUCKET_LADDER_S.length - 1]).toBe(86_400);
  });

  it("picks the finest bucket that keeps the range under the cap", () => {
    // 35 days of a 5-minute point is 10,080 readings. 30-minute buckets are
    // the first rung under 3,000 (1,680); 15-minute would be 3,360.
    expect(chooseBucketSeconds(35 * DAY)).toBe(30 * 60);
    // Two years of anything: 6-hour buckets are 2,920; 3-hour would be 5,840.
    expect(chooseBucketSeconds(730 * DAY)).toBe(6 * 3600);
    // A range short enough for the finest rung.
    expect(chooseBucketSeconds(3 * DAY)).toBe(5 * 60);
  });

  it("falls to the coarsest rung rather than refusing a very long range", () => {
    expect(chooseBucketSeconds(50 * 365 * DAY)).toBe(86_400);
  });

  it("takes a smaller cap, which is how a test drives the downsampler", () => {
    // 71 hours in at most 3 buckets: 12-hour gives 6, a day gives 3.
    expect(chooseBucketSeconds(71 * 3_600_000, 3)).toBe(86_400);
  });

  it("knows which widths are calendar days and must be cut on local midnight", () => {
    expect(isCalendarBucket(86_400)).toBe(true);
    expect(isCalendarBucket(12 * 3600)).toBe(false);
    expect(isCalendarBucket(30 * 60)).toBe(false);
  });

  it("names a bucket the way the notice will say it", () => {
    expect(bucketLabel(3600)).toBe("hour");
    expect(bucketLabel(6 * 3600)).toBe("6 hours");
    expect(bucketLabel(1800)).toBe("30 minutes");
    expect(bucketLabel(86_400)).toBe("day");
  });
});

describe("calendar dates", () => {
  it("accepts a real day and refuses one that does not exist", () => {
    expect(isCalendarDate("2026-08-14")).toBe(true);
    expect(isCalendarDate("2024-02-29")).toBe(true);
    expect(isCalendarDate("2026-02-30")).toBe(false);
    expect(isCalendarDate("2025-02-29")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("14/08/2026")).toBe(false);
    expect(isCalendarDate("2026-8-14")).toBe(false);
  });

  it("orders lexically, which for this format is chronologically", () => {
    expect(compareCalendarDates("2026-08-14", "2026-09-01")).toBeLessThan(0);
    expect(compareCalendarDates("2026-09-01", "2026-09-01")).toBe(0);
  });

  it("lists every year between two, inclusive, and none for nothing", () => {
    expect(yearsBetween(2024, 2026)).toEqual([2024, 2025, 2026]);
    expect(yearsBetween(2026, 2026)).toEqual([2026]);
    expect(yearsBetween(null, 2026)).toEqual([]);
  });

  it("ends the current year's shortcut today, and a past year on 31 December", () => {
    expect(yearRange(2026, "2026-09-22")).toEqual({ from: "2026-01-01", to: "2026-09-22" });
    expect(yearRange(2024, "2026-09-22")).toEqual({ from: "2024-01-01", to: "2024-12-31" });
  });

  it("formats a date as a date, in no time zone at all", () => {
    expect(formatCalendarDate("2026-08-14", "en-GB")).toBe("14 Aug 2026");
    expect(formatCalendarDate("2026-08-14", "en-US")).toBe("Aug 14, 2026");
  });
});

describe("the URL carries either a preset or two dates, never both", () => {
  const read = (query: string) => readFilters(new URLSearchParams(query));

  it("reads a well-formed pair as a custom range", () => {
    expect(read("from=2026-08-01&to=2026-08-14").range).toEqual({
      from: "2026-08-01",
      to: "2026-08-14",
    });
  });

  it("reads half a pair, or a malformed one, as no custom range", () => {
    expect(read("from=2026-08-01").range).toBeNull();
    expect(read("from=2026-08-01&to=yesterday").range).toBeNull();
    expect(read("days=30").range).toBeNull();
  });

  it("switching to dates drops days, and to a preset drops the dates", () => {
    const custom = withRange(
      new URLSearchParams("days=30&point=44"),
      { from: "2026-08-01", to: "2026-08-14" },
    );
    const params = new URLSearchParams(custom.replace(/^\?/, ""));
    expect(params.get(DAYS_PARAM)).toBeNull();
    expect(params.get(FROM_PARAM)).toBe("2026-08-01");
    expect(params.get(TO_PARAM)).toBe("2026-08-14");
    // The point survives a range change.
    expect(params.get("point")).toBe("44");

    const preset = withRange(params, { days: 30 });
    const back = new URLSearchParams(preset.replace(/^\?/, ""));
    expect(back.get(FROM_PARAM)).toBeNull();
    expect(back.get(TO_PARAM)).toBeNull();
    expect(back.get(DAYS_PARAM)).toBe("30");
    expect(back.get("point")).toBe("44");
  });

  it("drops the default preset from the URL, as before", () => {
    expect(withRange(new URLSearchParams("from=2026-08-01&to=2026-08-14"), { days: 7 })).toBe("");
  });
});

const custom = (from: string, to: string, timezone: string | null = "America/New_York"): TrendRange => ({
  kind: "custom",
  days: null,
  from: `${from}T04:00:00.000Z`,
  to: `${to}T04:00:00.000Z`,
  fromDate: from,
  toDate: to,
  timezone,
});

describe("the words beside the range", () => {
  it("names the zone on a custom range and not on a preset", () => {
    expect(describeRange({ kind: "preset", days: 7, from: "", to: "", fromDate: null, toDate: null, timezone: null }))
      .toBe("last 7 days");
    expect(describeRange(custom("2026-08-01", "2026-08-14"))).toMatch(/2026 – .*2026 \(America\/New_York\)$/);
  });

  it("says a single day once", () => {
    const text = describeRange(custom("2026-08-14", "2026-08-14"));
    expect(text).not.toContain("–");
    expect(text).toContain("(America/New_York)");
  });

  it("the sampling notice names the bucket, the counts and the band - and not the cap (2026-09-30)", () => {
    const text = describeSampling({
      kind: "bucketed",
      bucketSeconds: 3600,
      bucketLabel: "hour",
      buckets: 840,
      readings: 10_080,
      maxRaw: 10_000,
    });
    expect(text).toContain("Averaged to one point per hour");
    expect(text).toContain("10,080 readings");
    expect(text).toContain("840 averages");
    // Why the chart averages is the chart's business, not the reader's: the
    // cap is not named, only what was kept.
    expect(text).not.toContain("10,000");
    expect(text).not.toContain("unusable");
    expect(text).toContain("lowest and highest reading");
    expect(describeSampling({ kind: "raw", readings: 12 })).toBeNull();
  });

  it("an empty range names the range and the nearest data", () => {
    const text = describeNoReadings("points_RoomT", custom("2025-12-01", "2025-12-31"), {
      earliestAt: "2026-08-18T19:10:00.015Z",
      latestAt: "2026-09-22T18:20:00.020Z",
    });
    expect(text).toMatch(/^No readings for points_RoomT between .*2025 and .*2025 \(America\/New_York\)/);
    expect(text).toContain("earliest reading held for this point is");
    expect(text).toContain("latest is");
  });

  it("a point that never produced a reading is said to be that", () => {
    const text = describeNoReadings("Temp9", custom("2025-12-01", "2025-12-31"), {
      earliestAt: null,
      latestAt: null,
    });
    expect(text).toContain("has never produced a reading");
  });

  it("a range that starts before the data, or ends after it, says so", () => {
    const extent = { earliestAt: "2026-08-18T19:10:00.015Z", latestAt: "2026-09-08T10:35:49.326Z" };
    const notices = describeExtentNotices(custom("2026-08-01", "2026-09-21"), extent, 500, 900_000);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatch(/^Data for this point begins /);
    expect(notices[0]).toContain("not because the equipment was off");
    expect(notices[1]).toMatch(/^Data for this point ends /);
  });

  it("says nothing about the extent when the range is inside the data, or holds none", () => {
    const extent = { earliestAt: "2026-08-18T19:10:00.015Z", latestAt: "2026-09-22T18:20:00.020Z" };
    expect(describeExtentNotices(custom("2026-09-01", "2026-09-14"), extent, 500, 900_000)).toEqual([]);
    expect(describeExtentNotices(custom("2025-12-01", "2025-12-31"), extent, 0, 900_000)).toEqual([]);
  });

  it("the clock note appears past a minute and says nothing is corrected", () => {
    expect(describeClockOffset(0, null)).toBeNull();
    expect(describeClockOffset(45, null)).toBeNull();
    const text = describeClockOffset(1342, "2026-09-22T18:20:50.160Z");
    expect(text).toContain("22 min ahead of the collector");
    expect(text).toContain("not corrected");
    expect(describeClockOffset(-600, null)).toContain("10 min behind");
  });

  it("the picker refuses an end before the start and an end in the future, in words", () => {
    expect(describeDraftProblem("2026-08-14", "2026-08-01", "2026-09-22")).toContain("is before the start date");
    expect(describeDraftProblem("2026-08-14", "2026-12-31", "2026-09-22")).toContain("is in the future");
    expect(describeDraftProblem("2026-08-14", "2026-08-14", "2026-09-22")).toBeNull();
    expect(describeDraftProblem("", "2026-08-14", "2026-09-22")).toBeNull();
  });

  it("the axis tick carries the year over a long span and the time over a short one", () => {
    const ms = Date.parse("2026-08-14T15:00:00Z");
    expect(formatChartTick(ms, "en-US", "UTC", 3 * 365 * DAY)).toBe("Aug 2026");
    expect(formatChartTick(ms, "en-US", "UTC", DAY)).toMatch(/Aug 14, 15:00/);
    expect(formatChartTick(ms, "en-US", "UTC", 30 * DAY)).toBe("Aug 14");
    expect(formatChartTick(ms, "en-US", "UTC")).toBe("Aug 14");
  });
});
