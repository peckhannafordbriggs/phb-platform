import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Only the session is mocked. The service, the SQL, the range resolution and
// the downsampler are real, over real readings.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import type { Viewer } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { BasError } from "@/lib/modules/bas/errors";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { getPointExplorer } from "@/lib/modules/bas/service";
import { MAX_RAW_TREND_POINTS } from "@/lib/modules/bas/range";
import { GET as pointExplorerRoute } from "@/app/api/modules/bas/point-explorer/route";
import {
  describeClockOffset,
  describeExtentNotices,
  describeNoReadings,
  describeSampling,
} from "@/app/(modules)/bas/health-client";
import {
  OFFICE_CLOCK_OFFSET_S,
  OP_STATE,
  ROOM_T,
  createLiveFixture,
  readingsBetween,
  type LiveFixture,
} from "./bas-live-fixture";
import {
  createEmployee,
  disconnectDb,
  grantModule,
  resetDb,
  seedBasModule,
  seedChangeOrdersModule,
} from "./db";

/**
 * Custom date ranges, over REAL readings.
 *
 * Every reading here was collected from a building - see bas-live-fixture.ts
 * for which and when. The assertions are against instants worked out by hand
 * from the America/New_York rules, written as ISO strings with their offsets,
 * so that a wrong hour anywhere in the chain (the SQL, the driver, a Date)
 * fails against a number rather than against another computation.
 *
 * MUTATION RECORD, 2026-09-22. Each was applied by hand and the named test
 * failed; then reverted.
 *   - buildBucketedTrend: min/max dropped from the sample
 *       -> "an extreme in the source data survives into what is drawn" fails
 *          (min is undefined).
 *   - service: bucket SQL without min()/max() columns -> same test fails.
 *   - service: `(date + 1)` end made `date + interval '24 hours'` from the
 *     start -> "a single day is that whole day, even the 23-hour one" fails
 *     (24 h, not 23 h).
 *   - service: date_bin for every width (isCalendarBucket ignored)
 *       -> "day buckets are cut on local midnight across the change" fails
 *          (third bucket at 05:00Z).
 *   - service: `to` made inclusive (`ts <= to`) -> NOTHING FAILED. Every
 *     reading in these files sits a few milliseconds past its minute, so no
 *     row lands exactly on a midnight boundary and the two bounds agree on
 *     every count. The exclusive end is asserted only by reading the
 *     `range.to` instants above, not by a row that would be miscounted.
 *     Recorded in docs/testing-blind-spots.md.
 */

const authMock = vi.mocked(auth);

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

const request = (query = "") =>
  new Request(`http://localhost/api/modules/bas/point-explorer${query}`);

const at = (iso: string): number => Date.parse(iso);
const HOUR = 3_600_000;

let fixture: LiveFixture;
let viewer: Viewer;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetBasAvailabilityCache();

  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();
  fixture = await createLiveFixture();

  const employee = await createEmployee({ entraOid: "oid-range" });
  await grantModule(employee.id, BAS_MODULE_KEY);
  signedInAs("oid-range");

  viewer = {
    id: employee.id,
    email: employee.email,
    firstName: employee.firstName,
    lastName: employee.lastName,
    profileCompleted: true,
    isPlatformAdmin: false,
  };
});

afterEach(async () => {
  await fixture.cleanup();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDb();
});

const roomT = (from: string, to: string, extra: Record<string, unknown> = {}) =>
  getPointExplorer(viewer, { pointId: fixture.roomT, range: { from, to }, ...extra });

const opState = (from: string, to: string, extra: Record<string, unknown> = {}) =>
  getPointExplorer(viewer, { pointId: fixture.opState, range: { from, to }, ...extra });

// -------------------------------------------------------------------------

describe("the range is resolved in the building's zone, by the database", () => {
  it("11 to 14 September is four whole EDT days, end exclusive", async () => {
    const result = await roomT("2026-09-11", "2026-09-14");

    expect(result.range).toEqual({
      kind: "custom",
      days: null,
      from: "2026-09-11T04:00:00.000Z",
      to: "2026-09-15T04:00:00.000Z",
      fromDate: "2026-09-11",
      toDate: "2026-09-14",
      timezone: "America/New_York",
    });
  });

  it("a single day is that whole day, even the 23-hour one", async () => {
    // 9 March 2025: New York went from EST to EDT at 02:00. The day is 23
    // hours long, and OpState has six real readings on it.
    const dst = await opState("2025-03-09", "2025-03-09");
    expect(dst.range.from).toBe("2025-03-09T05:00:00.000Z");
    expect(dst.range.to).toBe("2025-03-10T04:00:00.000Z");
    expect(at(dst.range.to) - at(dst.range.from)).toBe(23 * HOUR);
    expect(dst.stats.readings).toBe(6);
    expect(dst.trend.filter((p) => !p.isBreak)).toHaveLength(6);

    // An ordinary day is 24 hours, and holds what the file says it holds.
    const plain = await roomT("2026-08-24", "2026-08-24");
    expect(at(plain.range.to) - at(plain.range.from)).toBe(24 * HOUR);
    expect(plain.stats.readings).toBe(
      readingsBetween(ROOM_T, at("2026-08-24T00:00:00-04:00"), at("2026-08-25T00:00:00-04:00")).length,
    );
    expect(plain.stats.readings).toBeGreaterThan(280);
  });

  it("a range across the spring change is 71 hours, and across the autumn one 73", async () => {
    const spring = await opState("2025-03-08", "2025-03-10");
    expect(at(spring.range.to) - at(spring.range.from)).toBe(71 * HOUR);
    expect(spring.stats.readings).toBe(10);

    const autumn = await opState("2025-11-01", "2025-11-03");
    expect(autumn.range.from).toBe("2025-11-01T04:00:00.000Z");
    expect(autumn.range.to).toBe("2025-11-04T05:00:00.000Z");
    expect(at(autumn.range.to) - at(autumn.range.from)).toBe(73 * HOUR);
  });

  it("day buckets are cut on local midnight across the change", async () => {
    // Force the downsampler over ten readings: a cap of 5, at most 3 buckets,
    // so the ladder lands on a day. The three buckets must start on the three
    // local midnights - 05:00Z, 05:00Z, then 04:00Z once the clocks moved.
    const result = await opState("2025-03-08", "2025-03-10", {
      maxRawTrendPoints: 5,
      maxTrendBuckets: 3,
    });

    expect(result.sampling.kind).toBe("bucketed");
    if (result.sampling.kind !== "bucketed") throw new Error("unreachable");
    expect(result.sampling.bucketSeconds).toBe(86_400);
    expect(result.sampling.bucketLabel).toBe("day");

    const starts = result.trend.filter((p) => !p.isBreak).map((p) => new Date(p.tsMs).toISOString());
    expect(starts).toEqual([
      "2025-03-08T05:00:00.000Z",
      "2025-03-09T05:00:00.000Z",
      "2025-03-10T04:00:00.000Z",
    ]);
    // And the 23-hour day's bucket holds its six readings.
    expect(result.trend.filter((p) => !p.isBreak)[1]!.readings).toBe(6);
  });

  it("a preset is unchanged: trailing days from the same now()", async () => {
    const result = await getPointExplorer(viewer, { pointId: fixture.roomT, windowDays: 7 });
    expect(result.range.kind).toBe("preset");
    expect(result.range.days).toBe(7);
    expect(result.range.to).toBe(result.observedAt);
    expect(at(result.range.to) - at(result.range.from)).toBe(7 * 24 * HOUR);
    expect(result.range.timezone).toBe("America/New_York");
    expect(result.sampling).toEqual({ kind: "raw", readings: result.stats.readings });
  });
});

describe("the 11-14 September 2026 outage", () => {
  it("counts exactly the readings in the range, breaks the line, and carries the recorded gap", async () => {
    const result = await roomT("2026-09-11", "2026-09-14");
    const expected = readingsBetween(
      ROOM_T,
      at("2026-09-11T00:00:00-04:00"),
      at("2026-09-15T00:00:00-04:00"),
    );
    expect(result.stats.readings).toBe(expected.length);
    expect(result.sampling).toEqual({ kind: "raw", readings: expected.length });

    // The hole in the readings: the last before it and the first after it are
    // real rows in the file.
    const hole = result.trendGaps.find((gap) => gap.hours > 20);
    expect(hole).toBeDefined();
    expect(new Date(hole!.fromMs).toISOString()).toBe("2026-09-11T20:05:00.011Z");
    expect(new Date(hole!.toMs).toISOString()).toBe("2026-09-12T18:45:00.009Z");
    expect(hole!.hours).toBeCloseTo(22.67, 1);

    // The line is broken there: a synthetic null between the two.
    const breaks = result.trend.filter((p) => p.isBreak);
    expect(breaks.some((b) => b.tsMs > hole!.fromMs && b.tsMs < hole!.toMs)).toBe(true);

    // And the collector's own record of it, which the chart outlines.
    const recorded = result.dataGaps.find((g) => g.gapStart === "2026-09-11T20:05:00.011Z");
    expect(recorded).toBeDefined();
    expect(recorded!.cause).toBe("roll_overwrite");
    expect(recorded!.gapEnd).toBe("2026-09-12T18:40:45.911Z");
  });
});

describe("a range that reaches past the data", () => {
  it("starting before the earliest reading draws from the earliest and says so", async () => {
    const result = await roomT("2026-08-01", "2026-08-20");

    expect(result.pointExtent.earliestAt).toBe("2026-08-18T19:10:00.015Z");
    expect(at(result.range.from)).toBeLessThan(at(result.pointExtent.earliestAt!));
    expect(result.stats.readings).toBe(
      readingsBetween(ROOM_T, at("2026-08-01T00:00:00-04:00"), at("2026-08-21T00:00:00-04:00")).length,
    );
    // The first sample drawn IS the first reading held - nothing invented before it.
    expect(result.trend[0]!.tsMs).toBe(at("2026-08-18T19:10:00.015Z"));

    const notices = describeExtentNotices(result.range, result.pointExtent, result.stats.readings, 900_000);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^Data for this point begins /);
    expect(notices[0]).toContain("not because the equipment was off");
  });

  it("a range with no readings draws nothing and names the nearest data", async () => {
    const result = await roomT("2025-12-01", "2025-12-31");

    expect(result.stats.readings).toBe(0);
    expect(result.trend).toEqual([]);
    expect(result.trendGaps).toEqual([]);
    expect(result.sampling).toEqual({ kind: "raw", readings: 0 });
    expect(result.pointExtent).toEqual({
      earliestAt: "2026-08-18T19:10:00.015Z",
      latestAt: new Date(ROOM_T.readings[ROOM_T.readings.length - 1]![0]).toISOString(),
    });

    const text = describeNoReadings(result.selectedPoint!.pointName, result.range, result.pointExtent);
    expect(text).toMatch(/^No readings for points_RoomT between /);
    expect(text).toContain("(America/New_York)");
    expect(text).toContain("earliest reading held for this point is");
    // The latest value tile is still the latest value: a window with nothing
    // in it does not make the last known reading untrue.
    expect(result.stats.latest).not.toBeNull();
  });

  it("a range of several years works, and the years offered are the years with data", async () => {
    const result = await opState("2024-01-01", "2026-09-08");

    expect(at(result.range.to) - at(result.range.from)).toBeGreaterThan(2 * 365 * 24 * HOUR);
    expect(result.stats.readings).toBe(OP_STATE.readings.length);
    expect(result.sampling.kind).toBe("raw");

    expect(result.calendar).not.toBeNull();
    expect(result.calendar!.timezone).toBe("America/New_York");
    expect(result.calendar!.years).toEqual([2024, 2025, 2026]);
    expect(result.calendar!.earliestDate).toBe("2024-02-21");
    expect(result.calendar!.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("downsampling", () => {
  // points_RoomT from 18 August to 21 September 2026 is about 7,600 readings,
  // under the measured cap. The cap is lowered to 2,000 so the real SQL
  // downsampler runs over real readings; the ladder then picks 30-minute
  // buckets (35 days / 3,000 buckets is 16.8 minutes, so 15-minute is too
  // fine and 30-minute is the first rung under).
  const RANGE = ["2026-08-18", "2026-09-21"] as const;

  it("is announced, with the bucket, the counts and the cap", async () => {
    const result = await roomT(RANGE[0], RANGE[1], { maxRawTrendPoints: 2000 });

    expect(result.sampling.kind).toBe("bucketed");
    if (result.sampling.kind !== "bucketed") throw new Error("unreachable");
    expect(result.sampling.bucketSeconds).toBe(1800);
    expect(result.sampling.bucketLabel).toBe("30 minutes");
    expect(result.sampling.maxRaw).toBe(2000);
    expect(result.sampling.readings).toBe(result.stats.readings);
    expect(result.sampling.buckets).toBe(result.trend.filter((p) => !p.isBreak).length);
    expect(result.sampling.buckets).toBeLessThan(result.stats.readings);

    const notice = describeSampling(result.sampling);
    expect(notice).toContain("Averaged to one point per 30 minutes");
    expect(notice).toContain("lowest and highest reading");
  });

  it("is not applied under the cap - the default cap is the measured one", async () => {
    const result = await roomT(RANGE[0], RANGE[1]);
    expect(result.sampling.kind).toBe("raw");
    expect(result.stats.readings).toBeLessThan(MAX_RAW_TREND_POINTS);
    expect(result.trend.filter((p) => !p.isBreak)).toHaveLength(result.stats.readings);
  });

  it("an extreme in the source data survives into what is drawn", async () => {
    // On 24 August 2026 at 09:05 EDT the lab's zone sensor went from 76.1 to
    // -40 and stayed there - a disconnected sensor. Raw, it is a reading.
    const raw = await roomT("2026-08-24", "2026-08-24");
    expect(raw.sampling.kind).toBe("raw");
    const spike = raw.trend.find((p) => p.tsMs === at("2026-08-24T09:05:00.017-04:00"));
    expect(spike?.value).toBe(-40);

    // Bucketed, the average alone could hide it. The bucket that holds it must
    // carry -40 as its minimum, and its average must NOT be -40 - otherwise
    // this test would pass on a downsampler that plotted minima as the line.
    const bucketed = await roomT(RANGE[0], RANGE[1], { maxRawTrendPoints: 2000 });
    const holding = bucketed.trend.filter(
      (p) => !p.isBreak && p.tsMs <= at("2026-08-24T09:05:00-04:00") && p.tsMs + 1800_000 > at("2026-08-24T09:05:00-04:00"),
    );
    expect(holding).toHaveLength(1);
    const bucket = holding[0]!;
    expect(bucket.min).toBe(-40);
    expect(bucket.max).toBeGreaterThan(70);
    expect(bucket.value).not.toBe(-40);
    expect(bucket.value!).toBeGreaterThan(-40);
    expect(bucket.readings).toBeGreaterThanOrEqual(2);

    // And nowhere in the bucketed series is the minimum missing while the
    // average is present. Drop min/max from buildBucketedTrend and this fails.
    for (const point of bucketed.trend.filter((p) => !p.isBreak)) {
      expect(point.min).toBeDefined();
      expect(point.max).toBeDefined();
      expect(point.min!).toBeLessThanOrEqual(point.value!);
      expect(point.max!).toBeGreaterThanOrEqual(point.value!);
    }
  });

  it("breaks the bucketed line at an empty bucket, where the readings stop", async () => {
    const result = await roomT(RANGE[0], RANGE[1], { maxRawTrendPoints: 2000 });
    // The 11-12 September hole is 22.7 hours, which is 45 empty half-hours.
    const hole = result.trendGaps.find((g) => g.hours > 20 && g.hours < 24 && g.fromMs > at("2026-09-11T00:00:00Z"));
    expect(hole).toBeDefined();
    // From the END of the last populated bucket (16:00 + 30 min) to the start
    // of the next populated one (14:30).
    expect(new Date(hole!.fromMs).toISOString()).toBe("2026-09-11T20:30:00.000Z");
    expect(new Date(hole!.toMs).toISOString()).toBe("2026-09-12T18:30:00.000Z");
  });
});

describe("validation", () => {
  it("refuses an end before the start", async () => {
    await expect(roomT("2026-09-14", "2026-09-11")).rejects.toMatchObject({
      code: "invalid_range",
      message: expect.stringContaining("is before the start date"),
    });
  });

  it("refuses an end in the future, naming today in the building's zone", async () => {
    const error = await roomT("2026-09-01", "2999-01-01").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BasError);
    expect((error as BasError).code).toBe("invalid_range");
    expect((error as BasError).message).toMatch(/in the future\. Today in America\/New_York is \d{4}-\d{2}-\d{2}\./);
  });

  it("refuses a day that does not exist", async () => {
    await expect(roomT("2026-02-30", "2026-03-01")).rejects.toMatchObject({
      code: "invalid_range",
      message: expect.stringContaining("not a calendar date"),
    });
  });

  it("answers 422 through the route for each, and for half a pair", async () => {
    const point = `&point=${fixture.roomT}`;
    for (const query of [
      `?from=2026-09-14&to=2026-09-11${point}`,
      `?from=2026-09-01&to=2999-01-01${point}`,
      `?from=2026-02-30&to=2026-03-01${point}`,
      `?from=2026-09-01${point}`,
      `?from=yesterday&to=today${point}`,
    ]) {
      const response = await pointExplorerRoute(request(query));
      expect(response.status, query).toBe(422);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("validation_failed");
      expect(body.error.message.length).toBeGreaterThan(10);
    }
  });

  it("accepts a valid range through the route, with the zone in the payload", async () => {
    const response = await pointExplorerRoute(
      request(`?from=2026-09-11&to=2026-09-14&point=${fixture.roomT}`),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { range: { timezone: string; from: string } } };
    expect(body.data.range.timezone).toBe("America/New_York");
    expect(body.data.range.from).toBe("2026-09-11T04:00:00.000Z");
  });
});

describe("the station's clock", () => {
  it("is reported as measured and never applied to the range", async () => {
    const office = await opState("2026-09-01", "2026-09-08");
    expect(office.stationClockOffsetS).toBe(OFFICE_CLOCK_OFFSET_S);
    expect(describeClockOffset(office.stationClockOffsetS, office.stationClockMeasuredAt))
      .toContain("22 min ahead");
    // The bounds are the calendar's, not the station's: midnight is midnight.
    expect(office.range.from).toBe("2026-09-01T04:00:00.000Z");

    const lab = await roomT("2026-09-01", "2026-09-08");
    expect(lab.stationClockOffsetS).toBe(0);
    expect(describeClockOffset(lab.stationClockOffsetS, lab.stationClockMeasuredAt)).toBeNull();
  });
});
