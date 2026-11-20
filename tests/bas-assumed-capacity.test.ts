import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import type { Viewer } from "@/lib/authz";
import { BAS_MODULE_KEY, NIAGARA_DEFAULT_CAPACITY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { getBasSettingsTree, getStationPoints } from "@/lib/modules/bas/settings-service";
import { refreshMeasuredIntervals } from "@/lib/modules/bas/measured-interval";
import { updateStationSchema } from "@/lib/validation/bas-settings";
import { PATCH as patchStation } from "@/app/api/modules/bas/settings/stations/[stationId]/route";
import { NO_POINT_FILTERS, pointHistoryUnknown, shownPoints } from "@/app/(modules)/bas/settings-points";
import { HISTORY_UNKNOWN_SETTINGS_HREF } from "@/app/(modules)/bas/health-client";
import { readSettingsFilters } from "@/app/(modules)/bas/filters";
import { createEmployee, disconnectDb, grantModule, grantModuleAdmin, resetDb, seedBasModule, seedChangeOrdersModule, testDb } from "./db";
import { createCeiFixture, type CeiFixture } from "./bas-cei-fixture";

/**
 * A station's assumed history capacity, and the Settings link from "history
 * size unknown" (2026-11-20).
 */

const authMock = vi.mocked(auth);
let fx: CeiFixture;
let admin: Viewer;
let adminId: string;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetBasAvailabilityCache();
  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();
  fx = await createCeiFixture();
  const employee = await createEmployee({ entraOid: "oid-assumed" });
  adminId = employee.id;
  await grantModule(employee.id, BAS_MODULE_KEY);
  await grantModuleAdmin(employee.id, BAS_MODULE_KEY);
  authMock.mockResolvedValue({
    entraOid: "oid-assumed",
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
  admin = {
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

const patch = (stationId: bigint, body: unknown) =>
  patchStation(
    new Request(`http://localhost/api/modules/bas/settings/stations/${stationId}`, { method: "PATCH", body: JSON.stringify(body) }),
    { params: Promise.resolve({ stationId: stationId.toString() }) },
  );

const stationRow = async () => {
  const tree = await getBasSettingsTree(admin);
  return tree.projects.flatMap((p) => p.buildings).flatMap((b) => b.stations).find((s) => s.stationId === fx.stationId.toString())!;
};

describe("the assumed capacity", () => {
  it("defaults to Niagara's 500 on every station, and the tree carries it", async () => {
    expect(NIAGARA_DEFAULT_CAPACITY).toBe(500);
    const row = await stationRow();
    expect(row.assumedCapacity).toBe(500);
    // Five collected points with no count and nothing measured yet; four on this station.
    expect(row.historyUnknown).toBe(4);
  });

  it("is edited by a module admin, audited with the old value, and moves every horizon judged from it", async () => {
    await refreshMeasuredIntervals();
    const before = await testDb.$queryRaw<Array<{ horizon_s: number }>>`
      SELECT horizon_s FROM bas_v_collection_health WHERE point_id = ${fx.spaceTemp}`;
    expect(before[0]?.horizon_s).toBe(500 * 1800);

    const response = await patch(fx.stationId, { assumedCapacity: 1000 });
    expect(response.status).toBe(200);
    expect((await stationRow()).assumedCapacity).toBe(1000);

    const after = await testDb.$queryRaw<Array<{ horizon_s: number; capacity_source: string }>>`
      SELECT horizon_s, capacity_source FROM bas_v_collection_health WHERE point_id = ${fx.spaceTemp}`;
    expect(after[0]).toEqual({ horizon_s: 1000 * 1800, capacity_source: "assumed" });

    const audit = await testDb.auditEvent.findFirstOrThrow({ where: { action: "bas.station_updated", actorEmployeeId: adminId } });
    expect(audit.metadata).toMatchObject({ assumedCapacity: 1000, previousAssumedCapacity: 500 });

    // An entered capacity is untouched by it.
    await testDb.basPoint.update({ where: { pointId: fx.damper }, data: { capacity: 200 } });
    const damper = await testDb.$queryRaw<Array<{ effective_capacity: number; capacity_source: string }>>`
      SELECT effective_capacity, capacity_source FROM bas_v_collection_health WHERE point_id = ${fx.damper}`;
    expect(damper[0]).toEqual({ effective_capacity: 200, capacity_source: "entered" });
  });

  it("refuses a value the column would refuse, with a sentence", () => {
    for (const bad of [0, -5, 1.5, 2_000_000, "500"]) {
      const parsed = updateStationSchema.safeParse({ assumedCapacity: bad });
      expect(parsed.success, String(bad)).toBe(false);
    }
    expect(updateStationSchema.safeParse({ assumedCapacity: 1 }).success).toBe(true);
    expect(updateStationSchema.safeParse({ assumedCapacity: 1_000_000 }).success).toBe(true);
  });

  it("is refused by the database too, below one record", async () => {
    await expect(
      testDb.$executeRaw`UPDATE bas_stations SET assumed_capacity = 0 WHERE station_id = ${fx.stationId}`,
    ).rejects.toThrow(/bas_stations_assumed_capacity_range/);
  });

  it("is a module admin's to change, and 404 for anyone else", async () => {
    await testDb.moduleGrant.update({
      where: { employeeId_moduleKey: { employeeId: adminId, moduleKey: BAS_MODULE_KEY } },
      data: { isModuleAdmin: false },
    });
    expect((await patch(fx.stationId, { assumedCapacity: 800 })).status).toBe(404);
    expect((await testDb.basStation.findUniqueOrThrow({ where: { stationId: fx.stationId } })).assumedCapacity).toBe(500);
  });
});

describe("the history-unknown link lands on the points it counted", () => {
  it("carries roll_risk on every row, and the filter keeps exactly the card's points", async () => {
    const list = await getStationPoints(admin, fx.stationId.toString());
    const unknown = shownPoints(list.points, "", { ...NO_POINT_FILTERS, history: "unknown" });
    expect(unknown.map((p) => p.niagaraHistoryName).sort()).toEqual([
      "V4_22/DamperPos",
      "V4_22/Occ",
      "V4_22/SpaceTemp",
      "V4_22/SpaceTempSp",
    ]);
    expect(unknown.every((p) => p.rollRisk === "roll_horizon_unknown" && pointHistoryUnknown(p))).toBe(true);

    await refreshMeasuredIntervals();
    const after = await getStationPoints(admin, fx.stationId.toString());
    expect(shownPoints(after.points, "", { ...NO_POINT_FILTERS, history: "unknown" }).map((p) => p.niagaraHistoryName)).toEqual([
      "V4_22/Occ",
    ]);
    expect((await stationRow()).historyUnknown).toBe(1);
  });

  it("is a URL the Settings screen reads", () => {
    expect(HISTORY_UNKNOWN_SETTINGS_HREF).toBe("/bas/settings?history=unknown");
    expect(readSettingsFilters(new URLSearchParams("history=unknown")).history).toBe("unknown");
  });
});
