import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

/**
 * The Point Explorer service reads the column a point's readings actually
 * live in. Before 2026-10-06 it read `value_num` for every point, so a
 * boolean point - `Occupied`, 421 rows of value_bool on live - came back as
 * 421 null samples, "Latest —", "Distinct values 0".
 *
 * Through the real database, with the fixture's two boolean points
 * (`fanStatus`, `fanCmd`: data_type `bool`, status and command roles) and
 * points created here for the string and undeclared cases.
 */

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import type { Viewer } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { getPointExplorer } from "@/lib/modules/bas/service";
import { GET as pointExplorerRoute } from "@/app/api/modules/bas/point-explorer/route";
import {
  createHealthFixture,
  expectBasTablesEmpty,
  type HealthFixture,
} from "./bas-fixture";
import {
  createEmployee,
  disconnectDb,
  grantModule,
  resetDb,
  seedBasModule,
  seedChangeOrdersModule,
  testDb,
} from "./db";

const authMock = vi.mocked(auth);

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

let fixture: HealthFixture;
let viewer: Viewer;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetBasAvailabilityCache();

  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();
  await expectBasTablesEmpty();
  fixture = await createHealthFixture();

  const employee = await createEmployee({ entraOid: "oid-kinds" });
  await grantModule(employee.id, BAS_MODULE_KEY);
  signedInAs("oid-kinds");

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

const MINUTE = 60_000;
const ago = (minutes: number) => new Date(fixture.now.getTime() - minutes * MINUTE);

/** Off, then on for two readings, then off: four boolean rows inside the window. */
async function seedFanStatus(pointId: bigint = fixture.fanStatus) {
  await testDb.basReading.createMany({
    data: [
      { pointId, ts: ago(50), valueBool: false },
      { pointId, ts: ago(35), valueBool: true },
      { pointId, ts: ago(20), valueBool: true },
      { pointId, ts: ago(5), valueBool: false },
    ],
  });
}

const explore = (pointId: bigint, extra: Record<string, unknown> = {}) =>
  getPointExplorer(viewer, { windowDays: 7, pointId, ...extra });

describe("a boolean point", () => {
  it("is known to be one, with its state words, from the point's declared type", async () => {
    await seedFanStatus();
    const result = await explore(fixture.fanStatus);

    expect(result.selectedPoint?.valueKind).toBe("boolean");
    // A status role with no occupancy, alarm or enable in its name: On / Off.
    expect(result.selectedPoint?.states).toEqual({ on: "On", off: "Off" });
  });

  it("is drawn from value_bool: 1 and 0 in time order, nothing null", async () => {
    await seedFanStatus();
    const result = await explore(fixture.fanStatus);

    expect(result.trend.map((point) => point.value)).toEqual([0, 1, 1, 0]);
    expect(result.trend.every((point) => !point.isBreak)).toBe(true);
    expect(result.sampling).toEqual({ kind: "raw", readings: 4 });
  });

  it("gives the tiles a state, a count of states and the states seen", async () => {
    await seedFanStatus();
    const { stats } = await explore(fixture.fanStatus);

    // Latest is the newest non-null reading: Off, as 0.
    expect(stats.latest).toBe(0);
    expect(stats.readings).toBe(4);
    expect(stats.nullRecords).toBe(0);
    expect(stats.distinctValues).toBe(2);
    expect(stats.minimum).toBe(0);
    expect(stats.maximum).toBe(1);
  });

  it("buckets as a share of readings with both states in the band", async () => {
    await seedFanStatus();
    // A cap of two forces bucketing; four buckets over seven days puts the
    // ladder at a calendar day, so the four readings, 45 minutes apart, land
    // in one bucket or straddle midnight into two. Either way the sequence
    // 0, 1, 1, 0 cannot be split into contiguous runs of one state.
    const result = await explore(fixture.fanStatus, {
      maxRawTrendPoints: 2,
      maxTrendBuckets: 4,
    });

    expect(result.sampling.kind).toBe("bucketed");
    expect(result.trend.length).toBeGreaterThan(0);
    for (const point of result.trend) {
      if (point.value === null) continue;
      expect(point.value).toBeGreaterThanOrEqual(0);
      expect(point.value).toBeLessThanOrEqual(1);
      expect([0, 1]).toContain(point.min);
      expect([0, 1]).toContain(point.max);
    }
    // Four readings, two of each state, 45 minutes apart in total: every
    // bucket width the ladder offers for a 7-day range holds them in one or
    // two buckets, so at least one bucket saw both states.
    expect(result.trend.some((point) => point.min === 0 && point.max === 1)).toBe(true);
  });

  it("reaches the browser as JSON with the kind and the words", async () => {
    await seedFanStatus();
    const response = await pointExplorerRoute(
      new Request(`http://localhost/api/modules/bas/point-explorer?point=${fixture.fanStatus}&days=7`),
    );
    const body = (await response.json()) as {
      data: { selectedPoint: { valueKind: string; states: unknown } | null };
    };

    expect(response.status).toBe(200);
    expect(body.data.selectedPoint?.valueKind).toBe("boolean");
    expect(body.data.selectedPoint?.states).toEqual({ on: "On", off: "Off" });
  });

  it("is listed in the picker with its kind, before anybody selects it", async () => {
    const result = await explore(fixture.sat);
    const byId = new Map(result.points.map((point) => [point.pointId, point]));

    expect(byId.get(fixture.fanStatus.toString())?.valueKind).toBe("boolean");
    expect(byId.get(fixture.fanCmd.toString())?.valueKind).toBe("boolean");
    expect(byId.get(fixture.fanCmd.toString())?.states).toEqual({ on: "On", off: "Off" });
    expect(byId.get(fixture.sat.toString())?.valueKind).toBe("numeric");
    expect(byId.get(fixture.sat.toString())?.states).toBeNull();
  });
});

describe("a numeric point is exactly as before", () => {
  it("keeps its unit, its kind and no state words", async () => {
    const result = await explore(fixture.sat);

    expect(result.selectedPoint?.valueKind).toBe("numeric");
    expect(result.selectedPoint?.states).toBeNull();
    expect(result.selectedPoint?.unit).toBe("fahrenheit");
    // The fixture's three readings, raw.
    expect(result.trend.filter((point) => point.value !== null)).toHaveLength(3);
  });
});

describe("a string point is recognised and otherwise left alone", () => {
  it("has kind string, null samples and no diagnosis to misread", async () => {
    const point = await testDb.basPoint.create({
      data: {
        stationId: fixture.stationId,
        niagaraHistoryName: "ZZTEST_OpState",
        dataType: "enum",
        collectionIntervalS: 900,
        capacity: 500,
      },
    });
    await testDb.basReading.createMany({
      data: [
        { pointId: point.pointId, ts: ago(20), valueStr: "3" },
        { pointId: point.pointId, ts: ago(5), valueStr: "4" },
      ],
    });

    const result = await explore(point.pointId);

    expect(result.selectedPoint?.valueKind).toBe("string");
    expect(result.selectedPoint?.states).toBeNull();
    // Nothing is built for strings yet: the chart gets the records with no
    // value, as it always has, and the tiles get the counts.
    expect(result.trend.map((p) => p.value)).toEqual([null, null]);
    expect(result.stats.readings).toBe(2);
    expect(result.stats.nullRecords).toBe(0);
    expect(result.stats.latest).toBeNull();
    expect(result.stats.distinctValues).toBe(0);
  });
});

describe("an undeclared type falls back to the column the readings populate", () => {
  it("reads a bool-populated 'unknown' point as boolean", async () => {
    const point = await testDb.basPoint.create({
      data: {
        stationId: fixture.stationId,
        niagaraHistoryName: "ZZTEST_Undeclared_Enable",
        dataType: "unknown",
        collectionIntervalS: 900,
        capacity: 500,
      },
    });
    await seedFanStatus(point.pointId);

    const result = await explore(point.pointId);

    expect(result.selectedPoint?.valueKind).toBe("boolean");
    // No role; "Enable" in the history name.
    expect(result.selectedPoint?.states).toEqual({ on: "Enabled", off: "Disabled" });
    expect(result.trend.map((point) => point.value)).toEqual([0, 1, 1, 0]);
  });

  it("stays numeric with nothing in the window - what the chart always drew", async () => {
    const point = await testDb.basPoint.create({
      data: {
        stationId: fixture.stationId,
        niagaraHistoryName: "ZZTEST_Undeclared_Empty",
        dataType: "unknown",
      },
    });

    const result = await explore(point.pointId);

    expect(result.selectedPoint?.valueKind).toBe("numeric");
    expect(result.selectedPoint?.states).toBeNull();
  });
});
