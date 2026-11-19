import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { describeAuditEvent } from "@/lib/admin/audit-describe";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import type {
  ApplySuggestionsResult,
  EquipmentFromNamesResult,
  StationPointsList,
} from "@/lib/modules/bas/types";
import { seedBasVocabularies } from "../prisma/bas-vocabularies";
import { GET as pointsRoute } from "@/app/api/modules/bas/settings/stations/[stationId]/points/route";
import { POST as fromNamesRoute } from "@/app/api/modules/bas/settings/stations/[stationId]/equipment-from-names/route";
import { POST as applyRoute } from "@/app/api/modules/bas/settings/stations/[stationId]/suggestions/apply/route";
import { expectBasTablesEmpty } from "./bas-fixture";
import {
  createEmployee,
  disconnectDb,
  grantModule,
  grantModuleAdmin,
  resetDb,
  seedBasModule,
  seedChangeOrdersModule,
  testDb,
} from "./db";

/**
 * The two name-derived actions on Settings -> Points (2026-11-19), driven
 * through the routes the UI calls, against a station seeded with CEI-shaped
 * names: the six the request quoted, the collision between `AHU_7` and
 * `AHU-7`, an XTM module with a point for AHU_7 and one for nothing, a point
 * already attached to equipment, an uncollected one, one already given a
 * role, a bare `SpaceTemp` and the lab's `Temp1`.
 *
 * The keys are stored the way oBIX escapes them - `/` as `$2f` - and the
 * display name is left NULL, so every name here reaches the parsers through
 * decodeNiagaraName, as a discovered station's would.
 */

interface SeedPoint {
  name: string;
  unit: string | null;
  dataType?: string;
  isActive?: boolean;
  role?: string;
  equipment?: string;
}

const POINTS: SeedPoint[] = [
  { name: "V4_22/SpaceTemp", unit: "fahrenheit" },
  { name: "V4_22/DaTemp", unit: "fahrenheit" },
  { name: "V4_23/SpaceTemp", unit: "fahrenheit" },
  { name: "V4_23/CO2", unit: "parts per million" },
  { name: "AHU_7/DA_T", unit: "fahrenheit" },
  { name: "AHU_7/OA_Enth", unit: "btu per pound" },
  { name: "AHU_7/SAP", unit: "inches of water" },
  { name: "AHU_7/RA_T", unit: "fahrenheit", role: "return_air_temp" },
  { name: "AHU-7/MA_T", unit: "fahrenheit" },
  { name: "XTM_109/AHU_7_FinalFilter", unit: null, dataType: "bool" },
  { name: "XTM_109/Spare_AI_3", unit: null },
  { name: "VAV_10_ZoneTemperature", unit: "fahrenheit" },
  { name: "V9_1/SpaceTemp", unit: "fahrenheit", equipment: "Lobby" },
  { name: "V9_2/SpaceTemp", unit: "fahrenheit", isActive: false },
  { name: "SpaceTemp", unit: "fahrenheit" },
  { name: "Temp1", unit: null },
];

const escape = (name: string) => name.replace(/\//g, "$2f").replace(/-/g, "$2d");

const authMock = vi.mocked(auth);
function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

let orgId: bigint;
let projectId: bigint;
let siteId: bigint;
let stationId: bigint;
const pointIds = new Map<string, string>();
const equipmentIds = new Map<string, bigint>();

const json = (body: unknown) =>
  new Request("http://localhost/api/modules/bas/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const params = (id: bigint | string = stationId) => ({ params: Promise.resolve({ stationId: id.toString() }) });

async function data<T>(pending: Promise<Response>): Promise<T> {
  const response = await pending;
  const body = (await response.json()) as { data?: T; error?: { code: string; message: string } };
  if (body.error !== undefined) throw new Error(`${response.status} ${body.error.code}: ${body.error.message}`);
  return body.data as T;
}
async function refusal(pending: Promise<Response>): Promise<{ status: number; code: string; message: string }> {
  const response = await pending;
  const body = (await response.json()) as { error?: { code: string; message: string } };
  return { status: response.status, code: body.error?.code ?? "", message: body.error?.message ?? "" };
}

const readPoints = () => data<StationPointsList>(pointsRoute(new Request("http://localhost"), params()));
const fromNames = (rows: unknown) => fromNamesRoute(json({ rows }), params());
const apply = (ids: string[]) => applyRoute(json({ pointIds: ids }), params());
const id = (name: string) => pointIds.get(name)!;

/** Each point's role and equipment, by its decoded name. */
async function state() {
  const rows = await testDb.$queryRaw<Array<{ niagara_history_name: string; point_role: string | null; equipment: string | null; equip_type: string | null }>>`
    SELECT p.niagara_history_name, p.point_role, e.name AS equipment, e.equip_type
      FROM bas_points p LEFT JOIN bas_equipment e ON e.equipment_id = p.equipment_id
     WHERE p.station_id = ${stationId}`;
  return new Map(
    rows.map((r) => [
      r.niagara_history_name.replace(/\$2f/g, "/").replace(/\$2d/g, "-"),
      { role: r.point_role, equipment: r.equipment, equipType: r.equip_type },
    ]),
  );
}
const auditCount = (action?: string) =>
  testDb.auditEvent.count({ where: action === undefined ? { action: { startsWith: "bas." } } : { action } });

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetBasAvailabilityCache();

  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();
  await expectBasTablesEmpty();
  await seedBasVocabularies(testDb);

  orgId = (await testDb.basOrg.create({ data: { name: "ZZTEST_ORG" } })).orgId;
  projectId = (await testDb.basProject.create({ data: { orgId, name: "ZZTEST_CEI" } })).projectId;
  siteId = (
    await testDb.basSite.create({ data: { orgId, projectId, name: "ZZTEST CEI", timezone: "America/New_York" } })
  ).siteId;
  stationId = (await testDb.basStation.create({ data: { siteId, niagaraStationName: "CEI_JCI_N2" } })).stationId;

  equipmentIds.clear();
  for (const [name, equipType] of [["Lobby", "zone"], ["V4-23", "vav"]] as const) {
    const e = await testDb.basEquipment.create({ data: { siteId, name, equipType } });
    equipmentIds.set(name, e.equipmentId);
  }

  pointIds.clear();
  for (const p of POINTS) {
    const created = await testDb.basPoint.create({
      data: {
        stationId,
        niagaraHistoryName: escape(p.name),
        niagaraDisplayName: null,
        unit: p.unit,
        dataType: p.dataType ?? "real",
        isActive: p.isActive ?? true,
        inactiveReason: p.isActive === false ? "manual" : null,
        pointRole: p.role ?? null,
        equipmentId: p.equipment === undefined ? null : equipmentIds.get(p.equipment)!,
      },
    });
    pointIds.set(p.name, created.pointId.toString());
  }

  const employee = await createEmployee();
  await grantModule(employee.id, BAS_MODULE_KEY);
  await grantModuleAdmin(employee.id, BAS_MODULE_KEY);
  signedInAs(employee.entraOid!);
});

afterEach(async () => {
  await testDb.basPoint.deleteMany({ where: { stationId } });
  await testDb.basEquipment.deleteMany({ where: { siteId } });
  await testDb.basStation.deleteMany({ where: { stationId } });
  await testDb.basSite.deleteMany({ where: { siteId } });
  await testDb.basProject.delete({ where: { projectId } });
  await testDb.basOrg.delete({ where: { orgId } });
  await testDb.$executeRaw`UPDATE bas_point_roles SET setpoint_for = NULL, status_of = NULL`;
  await testDb.basPointRole.deleteMany();
  await testDb.basEquipmentType.deleteMany();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDb();
});

// ---------------------------------------------------------------------------

describe("the read: preview rows and suggestion levels, and nothing written", () => {
  it("derives one row per unit from the names, never offering an attached or uncollected point", async () => {
    const list = await readPoints();
    const groups = new Map((list.equipmentFromNames ?? []).map((g) => [g.key, g]));
    expect([...groups.keys()].sort()).toEqual(["AHU7", "V4-22", "V4-23", "VAV10", "XTM109"]);

    expect(groups.get("AHU7")).toMatchObject({
      name: "AHU_7",
      equipType: "ahu",
      ioModule: false,
      existing: null,
    });
    expect(new Set(groups.get("AHU7")!.pointIds)).toEqual(
      new Set(["AHU_7/DA_T", "AHU_7/OA_Enth", "AHU_7/SAP", "AHU_7/RA_T", "AHU-7/MA_T", "XTM_109/AHU_7_FinalFilter"].map(id)),
    );
    expect(new Set(groups.get("AHU7")!.spellings)).toEqual(new Set(["AHU_7", "AHU-7"]));
    expect(groups.get("V4-22")).toMatchObject({ name: "V4_22", equipType: "vav", existing: null });
    expect(new Set(groups.get("V4-22")!.pointIds)).toEqual(new Set([id("V4_22/SpaceTemp"), id("V4_22/DaTemp")]));
    expect(groups.get("V4-23")).toMatchObject({
      name: "V4-23",
      equipType: "vav",
      existing: { name: "V4-23", equipType: "vav" },
    });
    expect(groups.get("VAV10")).toMatchObject({ name: "VAV_10", equipType: "vav", pointIds: [id("VAV_10_ZoneTemperature")] });
    expect(groups.get("XTM109")).toMatchObject({ equipType: null, ioModule: true, pointIds: [id("XTM_109/Spare_AI_3")] });

    // Never offered: attached to Lobby, not collected, or no prefix at all.
    const offered = new Set([...groups.values()].flatMap((g) => g.pointIds));
    for (const name of ["V9_1/SpaceTemp", "V9_2/SpaceTemp", "SpaceTemp", "Temp1"]) {
      expect(offered.has(id(name)), name).toBe(false);
    }
  });

  it("carries a level on every suggestion, deciding discharge air by the unit's type", async () => {
    const list = await readPoints();
    const by = new Map(list.points.map((p) => [p.pointId, p.suggestion]));
    const expectations: Array<[string, string | null, "high" | "medium" | null]> = [
      ["V4_22/SpaceTemp", "zone_temp", "high"],
      ["V4_22/DaTemp", "discharge_air_temp", "high"],
      ["V4_23/SpaceTemp", "zone_temp", "high"],
      ["V4_23/CO2", "space_co2", "high"],
      ["AHU_7/DA_T", "supply_air_temp", "high"],
      ["AHU_7/OA_Enth", null, null],
      ["AHU_7/SAP", "duct_static_pressure", "medium"],
      ["AHU_7/RA_T", null, null], // has its role; the tail names no equipment
      ["AHU-7/MA_T", "mixed_air_temp", "high"],
      ["XTM_109/AHU_7_FinalFilter", "filter_status", "high"],
      ["XTM_109/Spare_AI_3", null, null],
      ["VAV_10_ZoneTemperature", "zone_temp", "high"],
      ["V9_1/SpaceTemp", "zone_temp", "high"],
      ["V9_2/SpaceTemp", null, null],
      ["SpaceTemp", "zone_temp", "high"],
      ["Temp1", null, null],
    ];
    for (const [name, role, level] of expectations) {
      const s = by.get(id(name)) ?? null;
      expect(s?.role ?? null, name).toBe(role);
      expect(s?.level ?? null, name).toBe(level);
    }
    expect(by.get(id("VAV_10_ZoneTemperature"))).toMatchObject({ equipmentName: "VAV_10", equipType: "vav", equipmentId: null });
    expect(await auditCount()).toBe(0);
  });
});

describe("Create N pieces of equipment from name prefixes", () => {
  it("creates, matches and attaches the kept rows in one action, and the next read offers only the rest", async () => {
    await readPoints();
    const before = await state();

    const result = await data<EquipmentFromNamesResult>(
      fromNames([
        { key: "AHU7", name: "AHU-7", equipType: "ahu" },
        { key: "V4-22", name: "VAV 4-22", equipType: "vav" },
        { key: "V4-23", name: "V4-23" }, // existing: no type sent
        // VAV10 and XTM109 left unticked.
      ]),
    );
    expect(result).toEqual({ created: 2, matched: 1, pointsAttached: 10, pointsUnchanged: 0 });

    const after = await state();
    for (const name of ["AHU_7/DA_T", "AHU_7/OA_Enth", "AHU_7/SAP", "AHU_7/RA_T", "AHU-7/MA_T", "XTM_109/AHU_7_FinalFilter"]) {
      expect(after.get(name), name).toMatchObject({ equipment: "AHU-7", equipType: "ahu" });
    }
    expect(after.get("V4_22/SpaceTemp")).toMatchObject({ equipment: "VAV 4-22", equipType: "vav" });
    expect(after.get("V4_23/CO2")).toMatchObject({ equipment: "V4-23" });
    // The equipment half only: a role that was there stays, and none is added.
    expect(after.get("AHU_7/RA_T")!.role).toBe("return_air_temp");
    expect([...after.values()].filter((v) => v.role !== null)).toHaveLength(1);
    // Untouched: attached elsewhere, uncollected, unticked, no prefix.
    for (const name of ["V9_1/SpaceTemp", "V9_2/SpaceTemp", "VAV_10_ZoneTemperature", "XTM_109/Spare_AI_3", "SpaceTemp", "Temp1"]) {
      expect(after.get(name), name).toEqual(before.get(name));
    }
    expect(after.get("V9_1/SpaceTemp")!.equipment).toBe("Lobby");

    // Audited: one summary, one row per new piece of equipment, one per point.
    expect(await auditCount("bas.equipment_from_names")).toBe(1);
    const createdRows = await testDb.auditEvent.findMany({ where: { action: "bas.equipment_created" } });
    expect(createdRows.map((r) => (r.metadata as Record<string, unknown>).name).sort()).toEqual(["AHU-7", "VAV 4-22"]);
    for (const row of createdRows) expect((row.metadata as Record<string, unknown>).source).toBe("name_prefixes");
    const ahu = createdRows.find((r) => (r.metadata as Record<string, unknown>).name === "AHU-7")!;
    expect(new Set((ahu.metadata as { spellings: string[] }).spellings)).toEqual(new Set(["AHU_7", "AHU-7"]));
    const attachedRows = await testDb.auditEvent.findMany({ where: { action: "bas.point_equipment_changed" } });
    expect(attachedRows).toHaveLength(10);
    for (const row of attachedRows) {
      expect(row.metadata).toMatchObject({ source: "name_prefixes", viaBulk: true, selectionSize: 10, previousEquipmentId: null });
    }
    expect(await auditCount()).toBe(13);

    const summary = (await testDb.auditEvent.findFirst({ where: { action: "bas.equipment_from_names" } }))!;
    expect(
      describeAuditEvent({ action: summary.action, moduleKey: summary.moduleKey, metadata: summary.metadata as never, actor: { id: "a", firstName: "Mahi", lastName: "S", email: "m@example.invalid" }, target: null }).sentence,
    ).toBe(
      `Mahi S added 2 pieces of equipment and used 1 that already existed from the point name prefixes on station ${stationId}, attaching 10 points`,
    );

    const next = await readPoints();
    expect((next.equipmentFromNames ?? []).map((g) => g.key).sort()).toEqual(["VAV10", "XTM109"]);

    // The same rows again: the preview they came from is gone.
    const again = await refusal(fromNames([{ key: "AHU7", name: "AHU-7", equipType: "ahu" }]));
    expect(again).toMatchObject({ status: 409, code: "preview_stale" });
    expect(await auditCount()).toBe(13);
  });

  it("refuses a request it cannot apply whole, before writing anything", async () => {
    const equipmentBefore = await testDb.basEquipment.count();
    const cases: Array<[unknown, number, string]> = [
      // Two rows that would be one piece of equipment.
      [[{ key: "V4-22", name: "AHU_7", equipType: "vav" }, { key: "AHU7", name: "ahu-7", equipType: "ahu" }], 409, "name_taken"],
      // A new row with no type.
      [[{ key: "V4-22", name: "V4_22" }], 422, "equipment_type_not_found"],
      // A type the vocabulary does not hold.
      [[{ key: "V4-22", name: "V4_22", equipType: "spaceship" }], 422, "equipment_type_not_found"],
      // A row this station's names do not derive.
      [[{ key: "NOPE1", name: "Nope", equipType: "vav" }], 409, "preview_stale"],
      // Point ids are not accepted: the rows are by key only.
      [[{ key: "V4-22", name: "V4_22", equipType: "vav", pointIds: [id("Temp1")] }], 422, "validation_failed"],
      [[], 422, "validation_failed"],
      [[{ key: "V4-22", name: "V4_22", equipType: "vav" }, { key: "V4-22", name: "Other", equipType: "vav" }], 422, "validation_failed"],
    ];
    for (const [rows, status, code] of cases) {
      const r = await refusal(fromNames(rows));
      expect(r.status, JSON.stringify(rows)).toBe(status);
      if (code !== "validation_failed") expect(r.code, JSON.stringify(rows)).toBe(code);
    }
    expect(await testDb.basEquipment.count()).toBe(equipmentBefore);
    expect(await auditCount()).toBe(0);
    expect([...(await state()).values()].filter((v) => v.equipment !== null)).toHaveLength(1); // Lobby's one
  });

  it("leaves a point that was given equipment after the preview where it is", async () => {
    const preview = await readPoints();
    expect(preview.equipmentFromNames!.find((g) => g.key === "V4-22")!.pointIds).toHaveLength(2);
    // Somebody attaches one of the two by hand in the meantime.
    await testDb.basPoint.update({ where: { pointId: BigInt(id("V4_22/DaTemp")) }, data: { equipmentId: equipmentIds.get("Lobby")! } });

    const result = await data<EquipmentFromNamesResult>(fromNames([{ key: "V4-22", name: "V4_22", equipType: "vav" }]));
    expect(result).toMatchObject({ created: 1, pointsAttached: 1 });
    const after = await state();
    expect(after.get("V4_22/DaTemp")!.equipment).toBe("Lobby");
    expect(after.get("V4_22/SpaceTemp")!.equipment).toBe("V4_22");
  });

  it("is a module admin's action, like every settings route", async () => {
    const user = await createEmployee();
    await grantModule(user.id, BAS_MODULE_KEY);
    signedInAs(user.entraOid!);
    expect((await refusal(fromNames([{ key: "V4-22", name: "V4_22", equipType: "vav" }]))).status).toBe(404);
    expect((await refusal(apply([id("SpaceTemp")]))).status).toBe(404);
    expect(await auditCount()).toBe(0);
  });
});

describe("Apply all high-confidence suggestions", () => {
  it("applies every high-confidence suggestion in one action, filling only what is empty", async () => {
    const list = await readPoints();
    const high = list.points.filter((p) => p.suggestion?.level === "high").map((p) => p.pointId);
    expect(high).toHaveLength(10);

    const result = await data<ApplySuggestionsResult>(apply(high));
    expect(result).toEqual({ points: 10, roleChanged: 10, equipmentChanged: 1, unchanged: 0, equipmentCreated: 1 });

    const after = await state();
    expect(after.get("V4_22/DaTemp")!.role).toBe("discharge_air_temp");
    expect(after.get("AHU_7/DA_T")!.role).toBe("supply_air_temp");
    expect(after.get("XTM_109/AHU_7_FinalFilter")!.role).toBe("filter_status");
    expect(after.get("VAV_10_ZoneTemperature")).toEqual({ role: "zone_temp", equipment: "VAV_10", equipType: "vav" });
    expect(after.get("V9_1/SpaceTemp")).toEqual({ role: "zone_temp", equipment: "Lobby", equipType: "zone" });
    // Medium is not applied; a role that was there is not touched.
    expect(after.get("AHU_7/SAP")!.role).toBeNull();
    expect(after.get("AHU_7/RA_T")!.role).toBe("return_air_temp");
    expect(after.get("Temp1")!.role).toBeNull();

    expect(await auditCount("bas.suggestions_applied")).toBe(1);
    const summary = (await testDb.auditEvent.findFirst({ where: { action: "bas.suggestions_applied" } }))!;
    expect(summary.metadata).toMatchObject({
      level: "high",
      selected: 10,
      roleChanged: 10,
      equipmentChanged: 1,
      equipmentCreated: ["VAV_10"],
      byRole: { zone_temp: 5, discharge_air_temp: 1, space_co2: 1, supply_air_temp: 1, mixed_air_temp: 1, filter_status: 1 },
    });
    const roleRows = await testDb.auditEvent.findMany({ where: { action: "bas.point_role_changed" } });
    expect(roleRows).toHaveLength(10);
    for (const row of roleRows) expect(row.metadata).toMatchObject({ source: "suggestions", viaBulk: true, selectionSize: 10, previousRole: null });
    expect(await auditCount("bas.equipment_created")).toBe(1);
    expect(await auditCount("bas.point_equipment_changed")).toBe(1);
    expect(
      describeAuditEvent({ action: roleRows[0]!.action, moduleKey: roleRows[0]!.moduleKey, metadata: roleRows[0]!.metadata as never, actor: null, target: null }).sentence,
    ).toMatch(/\(one of 10 high-confidence suggestions applied together\)$/);

    // The same selection again: nothing is high-confidence any more.
    const again = await refusal(apply(high));
    expect(again).toMatchObject({ status: 409, code: "preview_stale" });
    expect(await auditCount("bas.suggestions_applied")).toBe(1);
  });

  it("refuses a medium suggestion, a point with none, and a point not on the station, writing nothing", async () => {
    expect(await refusal(apply([id("AHU_7/SAP")]))).toMatchObject({ status: 409, code: "preview_stale" });
    expect(await refusal(apply([id("SpaceTemp"), id("Temp1")]))).toMatchObject({ status: 409, code: "preview_stale" });
    expect(await refusal(apply([id("SpaceTemp"), "999999999"]))).toMatchObject({ status: 404, code: "point_not_found" });
    expect((await refusal(applyRoute(json({ pointIds: [id("SpaceTemp")], role: "zone_temp" }), params()))).status).toBe(422);
    expect(await auditCount()).toBe(0);
    expect([...(await state()).values()].filter((v) => v.role !== null)).toHaveLength(1);
  });

  it("reaches the same roles whether the equipment came first, and lets a person's type decide", async () => {
    // A person says V4_22 is an air handler. Odd, but theirs to say - and
    // the discharge air token follows the equipment, not the name.
    await data(fromNames([{ key: "AHU7", name: "AHU_7", equipType: "ahu" }, { key: "V4-22", name: "V4_22", equipType: "ahu" }]));
    const list = await readPoints();
    const by = new Map(list.points.map((p) => [p.pointId, p.suggestion]));
    expect(by.get(id("AHU_7/DA_T"))).toMatchObject({ role: "supply_air_temp", level: "high" });
    expect(by.get(id("V4_22/DaTemp"))).toMatchObject({ role: "supply_air_temp", level: "high" });
  });
});
