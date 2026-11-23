import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import type { Viewer } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import {
  TOO_MANY_LINES_MESSAGE,
  describeUnavailableLines,
  getCollectionHealth,
  getDashboard,
  getPointExplorer,
} from "@/lib/modules/bas/service";
import { exportPointReadings } from "@/lib/modules/bas/readings";
import { refreshMeasuredIntervals } from "@/lib/modules/bas/measured-interval";
import { basFigure } from "@/lib/home/bas-figure";
import { describeHistoryLine } from "@/app/(modules)/bas/point-explorer-parts";
import { GET as explorerRoute } from "@/app/api/modules/bas/point-explorer/route";
import { GET as csvRoute } from "@/app/api/modules/bas/point-readings/csv/route";
import { createEmployee, disconnectDb, grantModule, resetDb, seedBasModule, seedChangeOrdersModule, testDb } from "./db";
import { HALF_HOUR_MS, createCeiFixture, spaceTempAt, type CeiFixture } from "./bas-cei-fixture";

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

describe("the chart's other lines", () => {
  const lines = (ids: bigint[], extra: Record<string, unknown> = {}) =>
    explore(fx.spaceTemp, { comparePointIds: ids, ...extra });

  /** A point with the fixture's 30-minute readings, on either station. */
  const addPoint = async (stationId: bigint, name: string, unit: string, value: number) => {
    const { pointId } = await testDb.basPoint.create({
      data: { stationId, niagaraHistoryName: name, unit, dataType: "real", fullPolicy: "roll" },
    });
    const stamps = Array.from({ length: 7 * 48 }, (_, i) => fx.newestMs - i * HALF_HOUR_MS);
    await testDb.basReading.createMany({ data: stamps.map((ms) => ({ pointId, ts: new Date(ms), valueNum: value })) });
    return pointId;
  };

  it("draws a point of another unit on the right axis, over the same range, through the same loader", async () => {
    const page = await lines([fx.damper]);
    expect(page.comparisonNotes).toEqual([]);
    expect(page.comparisons).toHaveLength(1);
    expect(page.comparisons[0]).toMatchObject({
      point: { pointId: fx.damper.toString(), unit: "percent", stationId: fx.stationId.toString(), equipmentName: "V4_22" },
      axis: "right",
      expectedInterval: { seconds: 1800, source: "measured" },
    });
    expect(page.comparisons[0]!.trend.length).toBeGreaterThan(300);
    expect(page.comparisons[0]!.trend.every((s) => s.tsMs >= Date.parse(page.range.from) && s.tsMs < Date.parse(page.range.to))).toBe(true);
  });

  it("shares the left axis only with the same unit", async () => {
    const page = await lines([fx.spaceTempSp, fx.damper]);
    expect(page.comparisons.map((c) => c.axis)).toEqual(["left", "right"]);
  });

  it("takes a line from another JACE, and names its station", async () => {
    const page = await lines([fx.otherOat]);
    expect(page.comparisonNotes).toEqual([]);
    expect(page.comparisons[0]).toMatchObject({
      point: { pointId: fx.otherOat.toString(), stationId: fx.otherStationId.toString(), stationName: "ZZTEST_CEI_OTHER" },
      axis: "left",
    });
  });

  it("leaves off a line that would need a third axis, by name, and draws the rest", async () => {
    const page = await lines([fx.damper, fx.occ, fx.spaceTempSp]);
    expect(page.comparisons.map((c) => c.point.pointId)).toEqual([fx.damper.toString(), fx.spaceTempSp.toString()]);
    expect(page.comparisonNotes).toEqual([
      "V4_22/Occ is not drawn: the chart already has two axes (°F and %) and it reads True / False. Remove a line to make room for it.",
    ]);
  });

  it("says why, and still draws the point, when a line is hidden, gone, or not one the viewer may see", async () => {
    await testDb.basPoint.update({ where: { pointId: fx.damper }, data: { isVisible: false } });
    const page = await lines([fx.damper, 999_999_999n, fx.otherOat]);
    expect(page.comparisonNotes).toEqual([describeUnavailableLines(2)]);
    expect(page.comparisons.map((c) => c.point.pointId)).toEqual([fx.otherOat.toString()]);
    expect(page.trend.length).toBeGreaterThan(300);
  });

  it("draws six lines on one chart, each on its share of the draw budget, and leaves a seventh off", async () => {
    const supply = await addPoint(fx.otherStationId, "Other/SAT", "fahrenheit", 55);
    const valve = await addPoint(fx.otherStationId, "Other/Valve", "percent", 40);
    const extra = await addPoint(fx.stationId, "V4_22/Extra", "fahrenheit", 70);
    // 330-odd readings a line: raw alone under a cap of 1,000, bucketed as one of six.
    const alone = await explore(fx.spaceTemp, { maxRawTrendPoints: 1000 });
    expect(alone.sampling.kind).toBe("raw");

    const page = await lines([fx.spaceTempSp, fx.damper, fx.otherOat, supply, valve, extra], { maxRawTrendPoints: 1000 });
    expect(page.comparisons).toHaveLength(5);
    expect(page.comparisonNotes).toEqual([TOO_MANY_LINES_MESSAGE]);
    expect(page.comparisons.map((c) => c.axis)).toEqual(["left", "right", "left", "left", "right"]);
    expect(page.sampling).toMatchObject({ kind: "bucketed", maxRaw: 166 });
    for (const line of page.comparisons) expect(line.sampling).toMatchObject({ kind: "bucketed", maxRaw: 166 });
  });

  it("carries the set in the URL the route reads, free slots and all", async () => {
    const response = await explorerRoute(
      new Request(`http://localhost/api/modules/bas/point-explorer?point=${fx.spaceTemp}&compare=${fx.damper},,${fx.otherOat}&days=7`),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { comparisons: Array<{ point: { pointId: string } }> } };
    expect(body.data.comparisons.map((c) => c.point.pointId)).toEqual([fx.damper.toString(), fx.otherOat.toString()]);

    const bad = await explorerRoute(new Request(`http://localhost/api/modules/bas/point-explorer?point=${fx.spaceTemp}&compare=abc`));
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: { message: string } }).error.message).toBe(
      "compare must be point ids separated by commas.",
    );
  });

  it("gives the picker each point's station and equipment type", async () => {
    await testDb.basEquipmentType.upsert({
      where: { equipType: "zztest_vav" },
      create: { equipType: "zztest_vav", displayName: "ZZTEST VAV Box", description: "Fixture type.", category: "terminal" },
      update: {},
    });
    try {
      await testDb.basEquipment.update({ where: { equipmentId: fx.equipmentId }, data: { equipType: "zztest_vav" } });
      const page = await explore(fx.spaceTemp);
      expect(page.points.find((p) => p.pointId === fx.spaceTemp.toString())).toMatchObject({
        stationName: "ZZTEST_CEI_JCI_N2",
        equipmentName: "V4_22",
        equipmentType: "ZZTEST VAV Box",
      });
      expect(page.points.find((p) => p.pointId === fx.otherOat.toString())).toMatchObject({ equipmentId: null, equipmentType: null });
    } finally {
      await testDb.basEquipment.update({ where: { equipmentId: fx.equipmentId }, data: { equipType: null } });
      await testDb.basEquipmentType.deleteMany({ where: { equipType: "zztest_vav" } });
    }
  });
});

describe("the CSV of several lines", () => {
  const range = () => ({
    from: new Date(fx.newestMs - 3 * 86_400_000).toISOString(),
    to: new Date(fx.newestMs + 60_000).toISOString(),
  });
  const read = async (job: { chunks: () => AsyncGenerator<string, void, undefined> }) => {
    let text = "";
    for await (const chunk of job.chunks()) text += chunk;
    return text.split("\r\n").filter((line) => line.length > 0);
  };

  it("is a column per plotted point, aligned on the exact timestamp, newest first", async () => {
    const job = await exportPointReadings(viewer, { pointId: fx.spaceTemp, ...range(), comparePointIds: [fx.damper, fx.otherOat] });
    expect(job.unit).toBe("timestamps");
    const rows = await read(job);
    expect(rows[0]).toBe(
      `timestamp,V4_22/SpaceTemp (fahrenheit; ZZTEST_CEI_JCI_N2; point ${fx.spaceTemp}),` +
        `V4_22/DamperPos (percent; ZZTEST_CEI_JCI_N2; point ${fx.damper}),` +
        `Other/OAT (fahrenheit; ZZTEST_CEI_OTHER; point ${fx.otherOat})`,
    );
    // Three days of half hours, one row each: all three points log on the same instants.
    expect(job.total).toBe(3 * 48 + 1);
    expect(rows).toHaveLength(1 + job.total);
    const newest = rows[1]!.split(",");
    expect(newest[0]).toBe(`${new Date(fx.newestMs).toISOString().replace(/\.\d+Z$/, "")}.000000Z`);
    expect(Number(newest[1])).toBe(spaceTempAt(fx.newestMs));
    expect(newest[3]).toBe("40");
    // Inside the hole: the space temperature has no reading and its cell is empty; the others are not.
    const inHole = new Date(fx.hole.fromMs + HALF_HOUR_MS).toISOString().replace(/\.\d+Z$/, ".000000Z");
    const holeRow = rows.find((row) => row.startsWith(inHole))!.split(",");
    expect(holeRow[1]).toBe("");
    expect(holeRow[2]).not.toBe("");
    expect(holeRow[3]).toBe("40");
    expect(job.filename).toMatch(/^readings-V4_22_SpaceTemp-and-2-more-\d{8}T\d{4}Z-\d{8}T\d{4}Z\.csv$/);
  });

  it("gives a point logged at other instants rows of its own, never moved onto a neighbour's", async () => {
    // The occupancy point's change-of-value readings sit three to seven days back.
    const week = { from: new Date(fx.newestMs - 7.5 * 86_400_000).toISOString(), to: range().to };
    const job = await exportPointReadings(viewer, { pointId: fx.spaceTemp, ...week, comparePointIds: [fx.occ] });
    const rows = (await read(job)).slice(1).map((row) => row.split(","));
    const occRows = rows.filter((row) => row[2] === "true" || row[2] === "false");
    expect(occRows.length).toBeGreaterThan(0);
    expect(occRows.every((row) => row[1] === "")).toBe(true);
    expect(rows.filter((row) => row[1] !== "").every((row) => row[2] === "")).toBe(true);
    expect(job.total).toBe(rows.length);
  });

  it("keeps the newest rows when the cap bites, and says rows, not readings", async () => {
    const job = await exportPointReadings(viewer, { pointId: fx.spaceTemp, ...range(), comparePointIds: [fx.damper], maxRows: 10, chunkRows: 4 });
    const rows = await read(job);
    expect(job).toMatchObject({ exported: 10, cap: 10 });
    expect(rows).toHaveLength(11);
    expect(rows[1]!.startsWith(new Date(fx.newestMs).toISOString().slice(0, 19))).toBe(true);
    const stamps = rows.slice(1).map((row) => row.split(",")[0]!);
    expect([...stamps].sort().reverse()).toEqual(stamps);
    expect(new Set(stamps).size).toBe(10);
  });

  it("is what the route sends for compare=, with the unit in a header; one point is the file it always was", async () => {
    const q = new URLSearchParams({ point: fx.spaceTemp.toString(), ...range(), compare: `${fx.damper}` });
    const response = await csvRoute(new Request(`http://localhost/api/modules/bas/point-readings/csv?${q}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("X-PHB-Readings-Unit")).toBe("timestamps");
    expect((await response.text()).split("\r\n")[0]).toContain("V4_22/DamperPos (percent;");

    const single = new URLSearchParams({ point: fx.spaceTemp.toString(), ...range() });
    const one = await csvRoute(new Request(`http://localhost/api/modules/bas/point-readings/csv?${single}`));
    expect(one.headers.get("X-PHB-Readings-Unit")).toBe("readings");
    expect((await one.text()).split("\r\n")[0]).toBe("timestamp,value,unit,point_name,niagara_history_name,point_id,station,station_id,status");

    await testDb.basPoint.update({ where: { pointId: fx.damper }, data: { isVisible: false } });
    const hidden = await csvRoute(new Request(`http://localhost/api/modules/bas/point-readings/csv?${q}`));
    expect(hidden.status).toBe(404);
  });
});
