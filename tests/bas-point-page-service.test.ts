import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import type { Viewer } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { COMPARISON_NOT_AVAILABLE_MESSAGE, getCollectionHealth, getDashboard, getPointExplorer } from "@/lib/modules/bas/service";
import { refreshMeasuredIntervals } from "@/lib/modules/bas/measured-interval";
import { basFigure } from "@/lib/home/bas-figure";
import { describeHistoryLine } from "@/app/(modules)/bas/point-explorer-parts";
import { GET as explorerRoute } from "@/app/api/modules/bas/point-explorer/route";
import { createEmployee, disconnectDb, grantModule, resetDb, seedBasModule, seedChangeOrdersModule, testDb } from "./db";
import { createCeiFixture, type CeiFixture } from "./bas-cei-fixture";

/**
 * Point Explorer, Collection Health and the Projects card on a station shaped
 * like CEI_JCI_N2: 30-minute interval histories with nothing entered from
 * Workbench and no record count from the station (2026-11-20).
 */

const authMock = vi.mocked(auth);
let fx: CeiFixture;
let viewer: Viewer;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetBasAvailabilityCache();
  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();
  fx = await createCeiFixture();
  const employee = await createEmployee({ entraOid: "oid-cei" });
  await grantModule(employee.id, BAS_MODULE_KEY);
  authMock.mockResolvedValue({
    entraOid: "oid-cei",
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
  await fx.cleanup();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDb();
});

const explore = (pointId: bigint, extra: Record<string, unknown> = {}) =>
  getPointExplorer(viewer, { pointId, windowDays: 7, ...extra });
const card = async () => (await getDashboard(viewer)).projects.find((p) => p.projectId === fx.projectId.toString())!;

describe("the expected interval and the breaks", () => {
  it("measures 30 minutes with nothing entered, and finds the one real hole instead of 335 breaks", async () => {
    const page = await explore(fx.spaceTemp);
    expect(page.expectedInterval).toMatchObject({ seconds: 1800, source: "measured", spacing: "even", breakThresholdS: 3600 });
    expect(page.breaks.count).toBe(1);
    expect(page.breaks.breaks[0]).toMatchObject({ fromMs: fx.hole.fromMs, toMs: fx.hole.toMs });
    expect(page.breaks.longestHours).toBeCloseTo(3, 5);
    // Five readings missing: 2.5 h of the 3-hour gap. The half hour after the
    // last reading before it would have passed anyway.
    expect(page.breaks.missingShare).toBeCloseTo(2.5 / 168, 4);
    // The bands on the chart are the breaks, and the line breaks once, inside the hole.
    expect(page.trendGaps).toEqual(page.breaks.breaks);
    const lineBreaks = page.trend.filter((s) => s.isBreak);
    expect(lineBreaks).toHaveLength(1);
    expect(lineBreaks[0]!.tsMs).toBeGreaterThan(fx.hole.fromMs);
    expect(lineBreaks[0]!.tsMs).toBeLessThan(fx.hole.toMs);
  });

  it("takes an entered interval over the measured one: an entered 10 minutes makes every 30-minute gap a break", async () => {
    await testDb.basPoint.update({ where: { pointId: fx.spaceTemp }, data: { collectionIntervalS: 600 } });
    const page = await explore(fx.spaceTemp);
    expect(page.expectedInterval).toMatchObject({ seconds: 600, source: "workbench" });
    expect(page.breaks.count).toBeGreaterThan(300);
  });

  it("gives a change-of-value point no interval and breaks it only past four hours", async () => {
    const page = await explore(fx.occ);
    expect(page.expectedInterval).toMatchObject({ seconds: null, spacing: "uneven", breakThresholdS: 4 * 3600 });
    // The fixture's gaps over four hours: 5 h, 10 h, 14 h, 7 h, 8.5 h, 11.7 h.
    expect(page.breaks.count).toBeGreaterThanOrEqual(6);
    expect(page.breaks.breaks.every((b) => b.hours > 4)).toBe(true);
  });

  it("marks a hole running to the end of the range as ongoing", async () => {
    await testDb.basReading.deleteMany({ where: { pointId: fx.damper, ts: { gt: new Date(fx.newestMs - 6 * 3_600_000) } } });
    const page = await explore(fx.damper);
    const last = page.breaks.breaks.at(-1)!;
    expect(last.ongoing).toBe(true);
    expect(last.hours).toBeGreaterThan(6);
  });

  it("flags a reading out of physical range on the tile's facts", async () => {
    await testDb.basReading.create({ data: { pointId: fx.spaceTemp, ts: new Date(fx.newestMs - 3 * 3_600_000 + 60_000), valueNum: -40 } });
    const page = await explore(fx.spaceTemp);
    expect(page.outOfRange).toMatchObject({ label: "a room or return air temperature", min: 35, max: 110, lowest: -40 });
    // A percent point with no role has no physical range to be outside.
    expect((await explore(fx.damper)).outOfRange).toBeNull();
  });
});

describe("the scheduler's interval step", () => {
  it("stores the median for every even point, NULL for change of value, and is idempotent", async () => {
    await testDb.basPoint.update({ where: { pointId: fx.occ }, data: { measuredIntervalS: 900 } });
    const first = await refreshMeasuredIntervals();
    expect(first.changed).toBe(5);
    expect(first.cleared).toBe(1);
    const stored = await testDb.basPoint.findMany({
      where: { stationId: { in: [fx.stationId, fx.otherStationId] } },
      select: { niagaraHistoryName: true, measuredIntervalS: true, collectionIntervalS: true },
      orderBy: { niagaraHistoryName: "asc" },
    });
    expect(Object.fromEntries(stored.map((p) => [p.niagaraHistoryName, p.measuredIntervalS]))).toEqual({
      "Other/OAT": 1800,
      "V4_22/DamperPos": 1800,
      "V4_22/Occ": null,
      "V4_22/SpaceTemp": 1800,
      "V4_22/SpaceTempSp": 1800,
    });
    // Never written into the column Workbench owns.
    expect(stored.every((p) => p.collectionIntervalS === null)).toBe(true);

    const second = await refreshMeasuredIntervals();
    expect(second).toMatchObject({ changed: 0, cleared: 0 });
  });

  it("leaves a point alone when its week holds too few gaps to judge", async () => {
    await testDb.basPoint.update({ where: { pointId: fx.otherOat }, data: { measuredIntervalS: 900 } });
    const keep = await testDb.basReading.findMany({ where: { pointId: fx.otherOat }, orderBy: { ts: "desc" }, take: 5, select: { ts: true } });
    await testDb.basReading.deleteMany({ where: { pointId: fx.otherOat, ts: { lt: keep.at(-1)!.ts } } });
    await refreshMeasuredIntervals();
    const p = await testDb.basPoint.findUniqueOrThrow({ where: { pointId: fx.otherOat } });
    expect(p.measuredIntervalS).toBe(900);
  });
});

describe("the history size, and the split on the card and the hero", () => {
  it("reads unknown before anything is measured: muted, beside the figure, never in it", async () => {
    const page = await explore(fx.spaceTemp);
    expect(page.history?.risk).toBe("roll_horizon_unknown");
    expect(describeHistoryLine(page.history!).text).toBe("History size unknown");

    const c = await card();
    expect(c.health?.pointsAtRisk).toBe(0);
    expect(c.health?.pointsHistoryUnknown).toBe(5);
    expect(basFigure(c.health!)).toMatchObject({ state: "none", value: "No points at risk" });

    const health = await getCollectionHealth(viewer, { projectId: fx.projectId });
    expect(health.totals.pointsAtRisk).toBe(0);
    expect(health.totals.pointsHistoryUnknown).toBe(5);
  });

  it("estimates the horizon from the assumed 500 and the measured 30 minutes once the step has run, and says so", async () => {
    await refreshMeasuredIntervals();
    const page = await explore(fx.spaceTemp);
    expect(page.history).toMatchObject({
      risk: "ok",
      horizon: { state: "estimated", capacity: 500, capacitySource: "assumed", intervalS: 1800, intervalSource: "measured" },
    });
    expect(page.history!.horizon.hours).toBeCloseTo(250, 5);
    expect(describeHistoryLine(page.history!).text).toBe(
      "Station keeps about 10.4 days of history (assumed 500 records × measured 30 min)",
    );
    // Only the change-of-value point is still unknown - no count, no interval.
    expect((await card()).health?.pointsHistoryUnknown).toBe(1);
  });

  it("counts a horizon under four polls as a real risk, in the alert colour, and nothing else", async () => {
    await refreshMeasuredIntervals();
    // An assumed capacity of one record: 1 x 1800 s, half an hour. Collected
    // just now, so the collector is not behind half of it - that would be
    // at_risk, which outranks short_horizon and is in the figure too.
    await testDb.basStation.update({ where: { stationId: fx.stationId }, data: { assumedCapacity: 1 } });
    await testDb.basSyncCheckpoint.updateMany({
      where: { pointId: { in: [fx.spaceTemp, fx.spaceTempSp, fx.damper] } },
      data: { lastRecordTs: new Date() },
    });
    const c = await card();
    expect(c.health?.riskCounts.short_horizon).toBe(3);
    expect(c.health?.pointsAtRisk).toBe(3);
    expect(basFigure(c.health!)).toMatchObject({ value: "3 points at risk of data loss", alarm: true });
    const page = await explore(fx.spaceTemp);
    expect(page.history?.risk).toBe("short_horizon");
    expect(describeHistoryLine(page.history!)).toMatchObject({ tone: "bad" });
  });
});

describe("compare mode", () => {
  it("draws a point of another unit on its own axis, over the same range, through the same loader", async () => {
    const page = await explore(fx.spaceTemp, { comparePointId: fx.damper });
    expect(page.comparisonNote).toBeNull();
    expect(page.comparison).toMatchObject({
      point: { pointId: fx.damper.toString(), unit: "percent", stationId: fx.stationId.toString(), equipmentName: "V4_22" },
      sharedAxis: false,
      expectedInterval: { seconds: 1800, source: "measured" },
    });
    expect(page.comparison!.trend.length).toBeGreaterThan(300);
    expect(page.comparison!.trend.every((s) => s.tsMs >= Date.parse(page.range.from) && s.tsMs < Date.parse(page.range.to))).toBe(true);
  });

  it("shares the axis only when both points carry the same unit", async () => {
    const page = await explore(fx.spaceTemp, { comparePointId: fx.spaceTempSp });
    expect(page.comparison?.sharedAxis).toBe(true);
  });

  it("says why, and still draws the point, when the comparison is on another JACE or hidden", async () => {
    const other = await explore(fx.spaceTemp, { comparePointId: fx.otherOat });
    expect(other.comparison).toBeNull();
    expect(other.comparisonNote).toBe(COMPARISON_NOT_AVAILABLE_MESSAGE);
    expect(other.trend.length).toBeGreaterThan(300);

    await testDb.basPoint.update({ where: { pointId: fx.damper }, data: { isVisible: false } });
    const hidden = await explore(fx.spaceTemp, { comparePointId: fx.damper });
    expect(hidden.comparisonNote).toBe(COMPARISON_NOT_AVAILABLE_MESSAGE);
  });

  it("carries the comparison in the URL the route reads", async () => {
    const response = await explorerRoute(
      new Request(`http://localhost/api/modules/bas/point-explorer?point=${fx.spaceTemp}&compare=${fx.damper}&days=7`),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { comparison: { point: { pointId: string } } | null } };
    expect(body.data.comparison?.point.pointId).toBe(fx.damper.toString());
  });
});
