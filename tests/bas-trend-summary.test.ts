import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
// No test may reach the model service. The route builds its narrator from
// this module; the service tests inject theirs.
vi.mock("@/lib/modules/bas/trend-summary/narrator", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/modules/bas/trend-summary/narrator")>();
  return { ...real, createAnthropicTrendNarrator: () => real.createFixedTrendNarrator({ replies: [["Route summary."]] }) };
});

import { auth } from "@/auth";
import type { Viewer } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { QuestionRateLimiter } from "@/lib/modules/bas/analyze/rate-limit";
import { computeTrendStats, longestRuns, type TrendSample, type TrendStats } from "@/lib/modules/bas/trend-summary/stats";
import {
  allowedNumbers,
  createFixedTrendNarrator,
  inventedNumbers,
  numbersIn,
  trendUserMessage,
  TREND_SUMMARY_SYSTEM,
} from "@/lib/modules/bas/trend-summary/narrator";
import { summariseTrend, rangeKeyOf } from "@/lib/modules/bas/trend-summary/service";
import { trendSummaryUsage } from "@/lib/modules/bas/trend-summary/usage";
import { getReportsUsage } from "@/lib/modules/bas/reports/usage";
import { expectedInterval, summariseBreaks } from "@/lib/modules/bas/interval";
import { POST as summaryRoute } from "@/app/api/modules/bas/point-explorer/summary/route";
import { createEmployee, disconnectDb, grantModule, resetDb, seedBasModule, seedChangeOrdersModule, testDb } from "./db";
import { createCeiFixture, type CeiFixture } from "./bas-cei-fixture";
import { ROOM_T } from "./bas-live-fixture";

/**
 * The trend summary (2026-11-20): code computes, the model narrates, and the
 * model may not invent a number. Every call is metered; a cached summary
 * costs nothing; the module's safety ceiling and a per-person limit come
 * before any token is spent.
 */

const NY = "America/New_York";

// ------------------------------------------------------------------ stats

describe("the stats, on a real week: points_RoomT, 20-27 August 2026, with the -40 fault", () => {
  const from = Date.parse("2026-08-20T04:00:00Z");
  const to = Date.parse("2026-08-27T04:00:00Z");
  const readings = ROOM_T.readings.filter(([ms]) => ms >= from && ms < to) as Array<[number, number]>;
  const samples: TrendSample[] = readings.map(([ms, v]) => ({ tsMs: ms, value: v }));
  const values = readings.map(([, v]) => v);
  const breaks = summariseBreaks({ breaks: [], rangeFromMs: from, rangeToMs: to, earliestMs: from });
  const stats = computeTrendStats({
    pointName: "points_RoomT",
    unit: "fahrenheit",
    valueKind: "numeric",
    states: null,
    timezone: NY,
    range: { fromMs: from, toMs: to },
    samples,
    bucketLabel: null,
    stats: {
      readings: readings.length,
      nullRecords: 0,
      distinctValues: new Set(values).size,
      average: values.reduce((a, b) => a + b, 0) / values.length,
      minimum: Math.min(...values),
      maximum: Math.max(...values),
    },
    stuck: false,
    expected: expectedInterval({ enteredS: null, range: { gaps: 2000, medianS: 300, withinTolerance: 1990 }, storedMeasuredS: null }),
    breaks,
    outOfRange: { label: "a room or return air temperature", min: 35, max: 110, lowest: -40, highest: null },
    occupancy: {
      source: "the building's occupied hours in Settings",
      // Weekdays 08:00-17:00 New York, the week of 24 August.
      intervals: [24, 25, 26].map((d) => ({ start: Date.parse(`2026-08-${d}T12:00:00Z`), end: Date.parse(`2026-08-${d}T21:00:00Z`) })),
    },
  });

  it("finds the lowest reading and when, in the building's zone, and the highest", () => {
    expect(stats.lowest).toEqual({ value: -40, at: "Aug 24, 09:05" });
    expect(stats.highest!.value).toBeCloseTo(Math.max(...values), 1);
    expect(stats.unit).toBe("°F");
    expect(stats.period).toMatchObject({ from: "Aug 20, 00:00", to: "Aug 27, 00:00", days: 7, hours: 168 });
    expect(stats.drawnFrom).toBe("every reading");
  });

  it("gives the daily pattern by local hour, with the highest and lowest hour", () => {
    expect(stats.dailyPattern!.byHour).toHaveLength(24);
    expect(stats.dailyPattern!.byHour[0]!.hour).toBe("00:00");
    const avgs = stats.dailyPattern!.byHour.map((h) => h.average);
    expect(stats.dailyPattern!.highestHour!.average).toBe(Math.max(...avgs));
    expect(stats.dailyPattern!.lowestHour!.average).toBe(Math.min(...avgs));
  });

  it("splits occupied from unoccupied where occupancy is known", () => {
    expect(stats.occupancy?.source).toBe("the building's occupied hours in Settings");
    expect(stats.occupancy!.occupiedPercentOfReadings).toBeGreaterThan(5);
    expect(stats.occupancy!.occupiedPercentOfReadings).toBeLessThan(30);
    // Computed here from the readings, independently: the occupied hours are
    // mostly after the 09:05 fault on the 24th, so they average far below the
    // unoccupied ones.
    const occupied = readings.filter(([ms]) =>
      [24, 25, 26].some((d) => ms >= Date.parse(`2026-08-${d}T12:00:00Z`) && ms < Date.parse(`2026-08-${d}T21:00:00Z`)),
    );
    const mean = occupied.reduce((a, [, v]) => a + v, 0) / occupied.length;
    expect(stats.occupancy!.occupiedAverage).toBeCloseTo(mean, 1);
    expect(stats.occupancy!.occupiedAverage!).toBeLessThan(stats.occupancy!.unoccupiedAverage!);
  });

  it("finds the fall to -40 as the longest fall, and carries the flags and the breaks", () => {
    expect(stats.longestFall).not.toBeNull();
    expect(stats.longestFall!.change).toBeLessThan(-50);
    // It ends where the fall stopped, on the 24th - not three days later
    // after the sensor sat at -40 (the trailing flat is trimmed). It begins
    // with the room's overnight cool-down, which runs straight into the drop.
    expect(stats.longestFall!.to.startsWith("Aug 24")).toBe(true);
    expect(stats.longestFall!.hours).toBeLessThan(24);
    expect(stats.flags.outOfRange).toMatchObject({ lowest: -40, physicalMin: 35 });
    expect(stats.flags.stuck).toBeNull();
    expect(stats.breaks).toEqual({ expected: "Reports about every 5 min (measured)", count: 0, longestHours: null, missingPercent: 0 });
  });

  it("finds a sustained rise on a smoothed series, so one noisy reading cannot cut it in two", () => {
    const t0 = Date.UTC(2026, 10, 13);
    const ramp: TrendSample[] = Array.from({ length: 200 }, (_, i) => ({
      tsMs: t0 + i * 30 * 60_000,
      // A rise from 60 to 80 over the first half, with a 0.3-degree wobble, then flat.
      value: i < 100 ? 60 + (i / 100) * 20 + (i % 2 === 0 ? 0.3 : -0.3) : 80,
    }));
    const runs = longestRuns(ramp, { fromMs: t0, toMs: t0 + 200 * 30 * 60_000 }, "UTC");
    expect(runs.rise!.change).toBeGreaterThan(18);
    expect(runs.rise!.hours).toBeGreaterThan(40);
    expect(runs.fall === null || Math.abs(runs.fall.change) < 1).toBe(true);
  });
});

// --------------------------------------------------------- the number check

describe("the model may not invent a number", () => {
  const stats = { point: "X", average: 72.43, lowest: { value: -40, at: "Aug 24, 09:05" }, readings: 1440 } as unknown as TrendStats;

  it("reads numbers the way they are written", () => {
    expect(numbersIn("72.4°F, -40 °F, 1,440 readings at 09:05")).toEqual(["72.4", "40", "1440", "9", "5"]);
  });

  it("allows every number in the stats, and each one rounded", () => {
    const allowed = allowedNumbers(stats);
    for (const n of ["72.43", "72.4", "72", "40", "1440", "24", "9", "5"]) expect(allowed.has(n), n).toBe(true);
    expect(inventedNumbers("It averaged 72.4 °F and fell to -40 °F at 09:05 on Aug 24 over 1,440 readings.", stats)).toEqual([]);
  });

  it("names a number that is not there", () => {
    expect(inventedNumbers("It peaked at 83.2 °F, 11 degrees above the average.", stats)).toEqual(["83.2", "11"]);
  });

  it("is in the prompt the model is given, with the stats as data", () => {
    expect(TREND_SUMMARY_SYSTEM).toMatch(/Use ONLY numbers that appear in the data/);
    expect(TREND_SUMMARY_SYSTEM).toMatch(/3 to 5 sentences/);
    expect(TREND_SUMMARY_SYSTEM).toMatch(/never as a diagnosis/);
    expect(trendUserMessage(stats)).toContain("<data>");
    expect(trendUserMessage(stats)).toContain('"average": 72.43');
  });
});

// ----------------------------------------------------------- the service

const authMock = vi.mocked(auth);
let fx: CeiFixture;
let viewer: Viewer;
let employeeId: string;

describe("the service: cache, refresh, metering and the gates", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    resetBasAvailabilityCache();
    await resetDb();
    await seedChangeOrdersModule();
    await seedBasModule();
    fx = await createCeiFixture();
    const employee = await createEmployee({ entraOid: "oid-summary" });
    employeeId = employee.id;
    await grantModule(employee.id, BAS_MODULE_KEY);
    authMock.mockResolvedValue({
      entraOid: "oid-summary",
      issuedAt: Math.floor(Date.now() / 1000),
      user: {},
      expires: new Date(Date.now() + 3_600_000).toISOString(),
    } as unknown as Session as never);
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
    await testDb.basReportSettings.deleteMany({});
    await fx.cleanup();
    vi.restoreAllMocks();
  });

  const ask = (narrator: ReturnType<typeof createFixedTrendNarrator>, extra: Partial<Parameters<typeof summariseTrend>[1]> = {}, limiter?: QuestionRateLimiter) =>
    summariseTrend(
      viewer,
      { pointId: fx.spaceTemp, windowDays: 7, range: null, refresh: false, ...extra },
      { narrator, limiter: limiter ?? new QuestionRateLimiter({ limit: 100, windowMs: 60_000 }) },
    );

  it("writes once, meters the call, then serves the same data from the cache for nothing", async () => {
    const narrator = createFixedTrendNarrator({ replies: [["The space held a daily swing around 71 °F.", "One break of 3 h."]] });
    const first = await ask(narrator);
    expect(first).toMatchObject({ state: "written", cached: false, costUsd: 0.01 });
    expect(first.summary).toBe("The space held a daily swing around 71 °F. One break of 3 h.");
    expect(narrator.calls).toHaveLength(1);
    // What the model was given: the page's own numbers.
    expect(narrator.calls[0]!.breaks).toMatchObject({ count: 1, longestHours: 3, expected: "Reports about every 30 min (measured)" });
    expect(narrator.calls[0]!.unit).toBe("°F");

    const rows = await testDb.basTrendSummary.findMany({ where: { pointId: fx.spaceTemp } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rangeKey: "days:7", model: "fixed", inputTokens: 1000, outputTokens: 100, requestedById: employeeId });
    expect(Number(rows[0]!.costUsd)).toBeCloseTo(0.01, 4);
    expect(rows[0]!.newestReadingAt?.getTime()).toBe(fx.newestMs);

    const second = await ask(narrator);
    expect(second).toMatchObject({ state: "written", cached: true, costUsd: 0, summary: first.summary });
    expect(narrator.calls).toHaveLength(1);
    expect(await testDb.basTrendSummary.count()).toBe(1);
  });

  it("writes a new one on Refresh, and when a newer reading arrives", async () => {
    const narrator = createFixedTrendNarrator();
    await ask(narrator);
    await ask(narrator, { refresh: true });
    expect(narrator.calls).toHaveLength(2);
    await testDb.basReading.create({ data: { pointId: fx.spaceTemp, ts: new Date(fx.newestMs + 60_000), valueNum: 71 } });
    const fresh = await ask(narrator);
    expect(fresh.cached).toBe(false);
    expect(narrator.calls).toHaveLength(3);
    expect(await testDb.basTrendSummary.count()).toBe(3);
  });

  it("keys a custom range by its two dates", () => {
    expect(rangeKeyOf({ windowDays: 7, range: null })).toBe("days:7");
    expect(rangeKeyOf({ windowDays: 7, range: { from: "2026-11-01", to: "2026-11-07" } })).toBe("dates:2026-11-01..2026-11-07");
  });

  it("sends a reply with an invented number back once, and withholds it the second time - metered both times", async () => {
    const narrator = createFixedTrendNarrator({ replies: [["It peaked at 99.9 °F."], ["It peaked at 88.8 °F."]] });
    const result = await ask(narrator);
    expect(result.state).toBe("withheld");
    expect(result.summary).toBeNull();
    expect(result.message).toContain("88.8");
    expect(result.costUsd).toBeCloseTo(0.02, 6);
    const row = await testDb.basTrendSummary.findFirstOrThrow({ where: { pointId: fx.spaceTemp } });
    expect(row.summary).toBeNull();
    expect(row.declined).toContain("not in the data");
    // A withheld summary is never served from the cache.
    const narrator2 = createFixedTrendNarrator();
    expect((await ask(narrator2)).cached).toBe(false);
  });

  it("accepts the retry when it keeps to the data", async () => {
    const narrator = createFixedTrendNarrator({ replies: [["It peaked at 99.9 °F."], ["It held a daily swing."]] });
    const result = await ask(narrator);
    expect(result).toMatchObject({ state: "written", summary: "It held a daily swing." });
    expect(result.costUsd).toBeCloseTo(0.02, 6);
  });

  it("respects the module's safety ceiling: an estimate over it is not asked, and nothing is written", async () => {
    await testDb.basReportSettings.upsert({
      where: { settingsId: 1 },
      update: { ceilingUsd: 0.01 },
      create: { settingsId: 1, ceilingUsd: 0.01, ceilingMinutes: 25 },
    });
    const narrator = createFixedTrendNarrator({ costPerCall: 0.05 });
    const result = await ask(narrator);
    expect(result.state).toBe("over_ceiling");
    expect(result.message).toMatch(/safety ceiling of \$0\.01 and 25 minutes per run/);
    expect(narrator.calls).toHaveLength(0);
    expect(await testDb.basTrendSummary.count()).toBe(0);
  });

  it("limits each person, and a cache hit does not count", async () => {
    const limiter = new QuestionRateLimiter({ limit: 1, windowMs: 60_000 });
    const narrator = createFixedTrendNarrator();
    await ask(narrator, {}, limiter);
    expect((await ask(narrator, {}, limiter)).cached).toBe(true);
    const limited = await ask(narrator, { refresh: true }, limiter);
    expect(limited.state).toBe("rate_limited");
    expect(narrator.calls).toHaveLength(1);
  });

  it("says not configured when the BAS key is missing, and asks nothing", async () => {
    const result = await summariseTrend(viewer, { pointId: fx.spaceTemp, windowDays: 7, range: null, refresh: false }, { apiKey: null });
    expect(result.state).toBe("not_configured");
    expect(await testDb.basTrendSummary.count()).toBe(0);
  });

  it("takes occupancy from the building's hours when no occupancy point is trended", async () => {
    await testDb.basSiteOccupancy.createMany({
      data: [1, 2, 3, 4, 5].map((weekday) => ({ siteId: fx.siteId, weekday, startMinute: 8 * 60, endMinute: 17 * 60 })),
    });
    const narrator = createFixedTrendNarrator();
    await ask(narrator);
    expect(narrator.calls[0]!.occupancy).toMatchObject({ source: "the building's occupied hours in Settings" });
    await testDb.basSiteOccupancy.deleteMany({ where: { siteId: fx.siteId } });
  });

  it("refuses a text point, and a range with no readings, without asking", async () => {
    await testDb.basPoint.update({ where: { pointId: fx.occ }, data: { dataType: "str" } });
    const narrator = createFixedTrendNarrator();
    expect((await summariseTrend(viewer, { pointId: fx.occ, windowDays: 7, range: null, refresh: false }, { narrator })).state).toBe(
      "not_summarisable",
    );
    await testDb.basReading.deleteMany({ where: { pointId: fx.damper, ts: { gt: new Date(fx.newestMs - 2 * 86_400_000) } } });
    expect((await summariseTrend(viewer, { pointId: fx.damper, windowDays: 1, range: null, refresh: false }, { narrator })).state).toBe("no_data");
    expect(narrator.calls).toHaveLength(0);
  });

  it("puts every call on the Usage page under its own line, written and withheld", async () => {
    await ask(createFixedTrendNarrator());
    await ask(createFixedTrendNarrator({ replies: [["99.9"], ["88.8"]] }), { refresh: true });
    const usage = await trendSummaryUsage(new Date(Date.now() - 86_400_000), new Date(Date.now() + 1000));
    expect(usage).toMatchObject({ written: 1, withheld: 1, tokens: 3300 });
    expect(usage.spend).toBeCloseTo(0.03, 4);
    const page = await getReportsUsage(viewer, "7d", new Date(Date.now() + 1000));
    expect(page.trendSummaries).toMatchObject({ written: 1, withheld: 1 });
    // Not in the run figures, which are report runs.
    expect(page.totals.spend).toBe(0);
  });

  it("answers through the route for anyone with the module, and 404 for anyone without", async () => {
    const post = (body: unknown) =>
      summaryRoute(new Request("http://localhost/api/modules/bas/point-explorer/summary", { method: "POST", body: JSON.stringify(body) }));

    const ok = await post({ point: fx.spaceTemp.toString(), days: 7 });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { data: { state: string; summary: string } };
    expect(body.data).toMatchObject({ state: "written", summary: "Route summary." });

    expect((await post({ point: fx.spaceTemp.toString(), days: 7, model: "x" })).status).toBe(422);
    expect((await post({ point: fx.spaceTemp.toString(), from: "2026-11-01" })).status).toBe(422);

    await testDb.moduleGrant.deleteMany({ where: { employeeId } });
    expect((await post({ point: fx.spaceTemp.toString(), days: 7 })).status).toBe(404);
  });
});

afterAll(async () => {
  await disconnectDb();
});
