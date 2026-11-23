import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { runAutoAssignPass } from "@/lib/modules/bas/auto-assign";
import {
  planStationPieces,
  plantSide,
  pointBelongsToStation,
  stationUnit,
  unitKey,
} from "@/lib/modules/bas/station-equipment";
import { SETPOINT_WORD, TAIL_PATTERNS, stripPlantQualifier, suggestClassification, type RoleFacts } from "@/lib/modules/bas/suggestions";
import { pointNeedsDecision, type SettingsPoint } from "@/lib/modules/bas/types";
import { needsDecisionFileName, needsDecisionNamesText } from "@/app/(modules)/bas/settings-points";
import { PATCH as pointRoute } from "@/app/api/modules/bas/settings/points/[pointId]/route";
import { seedBasVocabularies } from "../prisma/bas-vocabularies";
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
 * When the station is the equipment (2026-11-23,
 * lib/modules/bas/station-equipment.ts, step 0 of the assignment pass), and
 * the third round of suffix tokens, on CEI's controllers as production holds
 * them: docs/fixtures/cei-controller-point-names.txt, read 2026-11-23 -
 * station, name, unit, data type - beside the JACE's 334 names
 * (docs/fixtures/cei-point-names.txt).
 */

const JACE_NAMES = readFileSync(path.join(process.cwd(), "docs/fixtures/cei-point-names.txt"), "utf8")
  .split(/\r?\n/)
  .filter((n) => n.length > 0);
const CONTROLLER_ROWS = readFileSync(path.join(process.cwd(), "docs/fixtures/cei-controller-point-names.txt"), "utf8")
  .split(/\r?\n/)
  .filter((n) => n.length > 0)
  .map((line) => {
    const [station, name, unit, dataType] = line.split("\t");
    return { station: station!, name: name!, unit: unit === "" ? null : unit!, dataType: dataType! };
  });
const escape = (name: string) => name.replace(/\//g, "$2f").replace(/-/g, "$2d");
const unescape = (key: string) => key.replace(/\$2f/g, "/").replace(/\$2d/g, "-");

// ---------------------------------------------------------------------------
// The rule, pure
// ---------------------------------------------------------------------------

describe("which stations are equipment", () => {
  it("a station named for a unit is that unit", () => {
    expect(stationUnit("CEI_AHU_7")).toMatchObject({ token: "AHU_7", kind: "unit", equipType: "ahu" });
    expect(stationUnit("CEI_AHU_8")).toMatchObject({ token: "AHU_8", equipType: "ahu" });
    expect(stationUnit("Bldg-RTU-3")).toMatchObject({ token: "RTU-3", equipType: "rtu" });
    expect(stationUnit("RTU_3")).toMatchObject({ token: "RTU_3", equipType: "rtu" });
    expect(stationUnit("CEI_AHU7")).toMatchObject({ token: "AHU7", equipType: "ahu" });
  });

  it("a station named for a plant is a plant; its points decide a bare PLANT's type", () => {
    expect(stationUnit("CEI_PLANT")).toMatchObject({ token: "PLANT", kind: "plant", equipType: null });
    expect(stationUnit("CEI_CHW_PLANT")).toMatchObject({ token: "CHW_PLANT", equipType: "plant_chw" });
    expect(stationUnit("CEI_HW_PLANT")).toMatchObject({ token: "HW_PLANT", equipType: "plant_hw" });
    expect(stationUnit("CEI_CHW")).toMatchObject({ token: "CHW", equipType: "plant_chw" });
    expect(stationUnit("CEI_HW")).toMatchObject({ token: "HW", equipType: "plant_hw" });
    expect(stationUnit("CEI_BOILER")).toMatchObject({ token: "BOILER", equipType: "boiler" });
    expect(stationUnit("CEI_CHILLER")).toMatchObject({ token: "CHILLER", equipType: "chiller" });
  });

  it("a JACE, and anything else, is not", () => {
    expect(stationUnit("CEI_JCI_N2")).toBeNull();
    expect(stationUnit("PHBoffice")).toBeNull();
    expect(stationUnit("SpringGroveLabComputer")).toBeNull();
    // The token must END the name, and a VAV is never a station.
    expect(stationUnit("CEI_AHU_7_SPARE")).toBeNull();
    expect(stationUnit("CEI_V4_22")).toBeNull();
    expect(stationUnit("CEI_VAV_3")).toBeNull();
  });

  it("a point belongs to the station's unit when it names none, or names the same unit", () => {
    const ahu7 = stationUnit("CEI_AHU_7")!;
    expect(pointBelongsToStation(ahu7, "DA_T")).toBe(true);
    expect(pointBelongsToStation(ahu7, "AHU_7_Da_Temp")).toBe(true);
    // Leading zeros are not another unit.
    expect(pointBelongsToStation(ahu7, "AHU_07_Oa_Temp")).toBe(true);
    expect(unitKey("AHU_07")).toBe(unitKey("AHU_7"));
    expect(unitKey("AHU_10")).not.toBe(unitKey("AHU_1"));
    expect(pointBelongsToStation(ahu7, "AHU_8_Da_Temp")).toBe(false);
    expect(pointBelongsToStation(ahu7, "V4_22/SpaceTemp")).toBe(false);
  });
});

describe("a plant's side, and the split", () => {
  it("reads each name for cooling or heating", () => {
    expect(plantSide("Clg_Plant_Chws_Temp")).toBe("cooling");
    expect(plantSide("Clg_Plant_Oa_Temp")).toBe("cooling");
    expect(plantSide("CHWS_Temp")).toBe("cooling");
    expect(plantSide("Ch_1_Sts")).toBe("cooling");
    expect(plantSide("HWS_Temp")).toBe("heating");
    expect(plantSide("Blr_1_Sts")).toBe("heating");
    expect(plantSide("Oa_Temp")).toBeNull();
    expect(plantSide("Chw_Hw_Changeover")).toBeNull();
  });

  const plant = stationUnit("CEI_PLANT")!;
  const pts = (...names: string[]) => names.map((name, i) => ({ pointId: String(i + 1), name }));

  it("a cooling-only plant is one chilled water plant, and every point is its own", () => {
    const names = CONTROLLER_ROWS.filter((r) => r.station === "CEI_PLANT").map((r) => r.name);
    const pieces = planStationPieces(plant, names.map((name) => ({ name })), pts(...names));
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toMatchObject({ name: "PLANT", equipType: "plant_chw" });
    expect(pieces[0]!.pointIds).toHaveLength(names.length);
  });

  it("a plant that mixes both sides is split, and a point that names neither is left for a person", () => {
    const names = ["CHWS_Temp", "Ch_1_Sts", "HWS_Temp", "Blr_1_Sts", "Oa_Temp", "Plant_Enab"];
    const pieces = planStationPieces(plant, names.map((name) => ({ name })), pts(...names));
    expect(pieces.map((p) => ({ name: p.name, equipType: p.equipType, pointIds: p.pointIds }))).toEqual([
      { name: "PLANT_CHW", equipType: "plant_chw", pointIds: ["1", "2"] },
      { name: "PLANT_HW", equipType: "plant_hw", pointIds: ["3", "4"] },
    ]);
  });

  it("a plant whose names name neither side gets nothing", () => {
    expect(planStationPieces(plant, [{ name: "Oa_Temp" }], pts("Oa_Temp"))).toEqual([]);
  });

  it("decides a plant's type over every point, not only the ones still to attach", () => {
    // Only a cooling point is left to attach, but the station also has a hot
    // water point already attached by a person: still split.
    const pieces = planStationPieces(plant, [{ name: "CHWS_Temp" }, { name: "HWS_Temp" }], pts("CHWS_Temp"));
    expect(pieces).toEqual([expect.objectContaining({ name: "PLANT_CHW", pointIds: ["1"] })]);
  });
});

describe("the third round of tokens", () => {
  const roles = new Map<string, RoleFacts>(
    [
      ["supply_air_temp", "degF"], ["supply_air_temp_sp", "degF"], ["duct_static_pressure", "inH2O"], ["duct_static_pressure_sp", "inH2O"],
      ["supply_fan_status", null], ["supply_fan_speed", "percent"], ["oa_damper_cmd", "percent"], ["chw_supply_temp", "degF"],
      ["chw_supply_temp_sp", "degF"], ["cooling_valve_cmd", "percent"], ["building_static_pressure", "inH2O"], ["pump_status", null],
    ].map(([role, unit]) => [role!, { pointRole: role!, displayName: role!, typicalUnit: unit ?? null }]),
  );
  const suggest = (name: string, equipmentType: string | null, opts: { unit?: string | null; dataType?: string } = {}) =>
    suggestClassification(
      {
        niagaraHistoryName: name,
        niagaraDisplayName: null,
        unit: opts.unit ?? null,
        pointRole: null,
        equipmentId: equipmentType === null ? null : "planned",
        equipmentType,
        collected: true,
        dataType: opts.dataType ?? "real",
      },
      roles,
      [],
    );

  it("reads CEI's air handler names, with the air handler deciding supply over discharge", () => {
    expect(suggest("AHU_7_Da_Temp", "ahu")).toMatchObject({ role: "supply_air_temp", level: "high" });
    expect(suggest("DA_T", "ahu")).toMatchObject({ role: "supply_air_temp", level: "high" });
    expect(suggest("AHU_7_Da_Temp_Spt", "ahu")).toMatchObject({ role: "supply_air_temp_sp", level: "high" });
    expect(suggest("AHU_7_Da_Press", "ahu", { unit: "inches of water" })).toMatchObject({ role: "duct_static_pressure", level: "high" });
    expect(suggest("AHU_7_Da_Press_Spt", "ahu", { unit: "inches of water" })).toMatchObject({ role: "duct_static_pressure_sp" });
    expect(suggest("AHU_7_Sa_Fan_Sts", "ahu", { dataType: "bool" })).toMatchObject({ role: "supply_fan_status", level: "high" });
    expect(suggest("AHU_7_Sa_Fan_Sig", "ahu", { unit: "percent" })).toMatchObject({ role: "supply_fan_speed" });
    expect(suggest("AHU_7_Oa_Dmpr_Sig", "ahu", { unit: "percent" })).toMatchObject({ role: "oa_damper_cmd" });
    expect(suggest("AHU_7_Clg_Sig", "ahu", { unit: "percent" })).toMatchObject({ role: "cooling_valve_cmd", level: "high" });
    expect(suggest("AHU_7_Zn_Press", "ahu", { unit: "inches of water" })).toMatchObject({ role: "building_static_pressure" });
  });

  it("stays silent on members, limits, aggregates and an open/close damper command", () => {
    expect(suggest("AHU_7_Sa_Fan_1_Sts", "ahu", { dataType: "bool" })).toBeNull();
    expect(suggest("AHU_7_Da_Temp_Spt_Max", "ahu")).toBeNull();
    expect(suggest("AHU_7_Zn_Temp_Avg", "ahu")).toBeNull();
    expect(suggest("AHU_7_Clg_Sig_Lower", "ahu")).toBeNull();
    // A boolean "open" command cannot be a damper POSITION (rule 3).
    expect(suggest("AHU_7_Oa_Dmpr_Cmd", "ahu", { dataType: "bool" })).toBeNull();
    expect(suggest("Clg_Plant_Sec_Chwp_1_Sts", "plant_chw", { dataType: "bool" })).toBeNull();
  });

  it("strips a plant's own name before the measurement", () => {
    expect(stripPlantQualifier("Clg_Plant_Chws_Temp")).toBe("Chws_Temp");
    expect(stripPlantQualifier("Plant_Chws_Temp")).toBe("Chws_Temp");
    expect(stripPlantQualifier("Chws_Temp")).toBeNull();
    expect(stripPlantQualifier("Clg_Plant")).toBeNull();
    expect(stripPlantQualifier("Zone_Plant_Temp")).toBeNull();
    expect(suggest("Clg_Plant_Chws_Temp", "plant_chw", { unit: "fahrenheit" })).toMatchObject({ role: "chw_supply_temp", level: "high" });
    expect(suggest("Clg_Plant_Chws_Temp_Spt", "plant_chw", { unit: "fahrenheit" })).toMatchObject({ role: "chw_supply_temp_sp" });
  });

  it("Spt is a setpoint word, and every token sits on the right side of rule 1", () => {
    expect(SETPOINT_WORD.test("AHU_7_Da_Temp_Spt")).toBe(true);
    expect(SETPOINT_WORD.test("AHU_7_Da_Temp_Spt_Max")).toBe(true);
    expect(SETPOINT_WORD.test("AHU_7_Sa_Fan_Sts")).toBe(false);
    expect(SETPOINT_WORD.test("AHU_7_Safety_Tripped")).toBe(false);
    const seen = new Map<string, string>();
    for (const pattern of TAIL_PATTERNS) {
      for (const token of pattern.tokens) {
        expect(seen.get(token), `${token} is in ${seen.get(token)} and ${pattern.id}`).toBeUndefined();
        seen.set(token, pattern.id);
      }
    }
  });
});

describe("Download names", () => {
  const row = (name: string, role: string | null, collected = true) =>
    ({ niagaraHistoryName: escape(name), pointRole: role, collected }) as unknown as SettingsPoint;

  it("writes one decoded Niagara name per line, needs-a-decision points only", () => {
    const text = needsDecisionNamesText([row("AHU_7/OA_Enth", null), row("AHU_7/DA_T", "supply_air_temp"), row("V4-22/X", null), row("Gone", null, false)]);
    expect(text).toBe("AHU_7/OA_Enth\nV4-22/X\n");
    expect(needsDecisionNamesText([])).toBe("");
    expect(needsDecisionFileName("CEI_AHU_7", "9")).toBe("CEI_AHU_7-needs-a-decision.txt");
    expect(needsDecisionFileName(null, "9")).toBe("station-9-needs-a-decision.txt");
    expect(pointNeedsDecision({ collected: true, pointRole: null })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// On the database: CEI, through the scheduler's pass
// ---------------------------------------------------------------------------

const authMock = vi.mocked(auth);
let orgId: bigint;
let projectId: bigint;
let siteId: bigint;
const stations = new Map<string, bigint>();

async function station(name: string, via: bigint | null = null): Promise<bigint> {
  const id = (
    await testDb.basStation.create({
      data: {
        siteId,
        niagaraStationName: name,
        connectionMode: via === null ? "direct" : "via_parent",
        parentStationId: via,
        baseUrl: via === null ? "https://198.51.100.40" : null,
      },
    })
  ).stationId;
  stations.set(name, id);
  return id;
}

/** The JACE as production holds it after the 2026-11-19 pass, then its three controllers, names, units and types. */
async function buildCei(): Promise<void> {
  const jace = await station("CEI_JCI_N2");
  await testDb.basPoint.createMany({ data: JACE_NAMES.map((name) => ({ stationId: jace, niagaraHistoryName: escape(name) })) });
  await runAutoAssignPass();
  for (const name of ["CEI_AHU_7", "CEI_AHU_8", "CEI_PLANT"]) {
    const id = await station(name, jace);
    await testDb.basPoint.createMany({
      data: CONTROLLER_ROWS.filter((r) => r.station === name).map((r) => ({
        stationId: id,
        niagaraHistoryName: escape(r.name),
        unit: r.unit,
        dataType: r.dataType,
      })),
    });
  }
}

/** Each point on a station, by decoded name. */
async function stateOn(stationName: string) {
  const rows = await testDb.$queryRaw<
    Array<{ niagara_history_name: string; point_role: string | null; equipment: string | null; equip_type: string | null; assignment_source: string | null }>
  >`
    SELECT p.niagara_history_name, p.point_role, e.name AS equipment, e.equip_type, p.assignment_source
      FROM bas_points p LEFT JOIN bas_equipment e ON e.equipment_id = p.equipment_id
     WHERE p.station_id = ${stations.get(stationName)!}`;
  return new Map(rows.map((r) => [unescape(r.niagara_history_name), { role: r.point_role, equipment: r.equipment, equipType: r.equip_type, source: r.assignment_source }]));
}

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
  siteId = (await testDb.basSite.create({ data: { orgId, projectId, name: "ZZTEST CEI", timezone: "America/New_York" } })).siteId;
  stations.clear();

  const employee = await createEmployee({ entraOid: "oid-station-equipment" });
  await grantModule(employee.id, BAS_MODULE_KEY);
  await grantModuleAdmin(employee.id, BAS_MODULE_KEY);
  authMock.mockResolvedValue({
    entraOid: "oid-station-equipment",
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
});

afterEach(async () => {
  const ids = [...stations.values()];
  await testDb.basPoint.deleteMany({ where: { stationId: { in: ids } } });
  await testDb.basEquipment.deleteMany({ where: { siteId } });
  await testDb.basStation.deleteMany({ where: { stationId: { in: ids }, parentStationId: { not: null } } });
  await testDb.basStation.deleteMany({ where: { stationId: { in: ids } } });
  await testDb.basSite.deleteMany({ where: { orgId } });
  await testDb.basProject.deleteMany({ where: { orgId } });
  await testDb.basOrg.delete({ where: { orgId } });
  await testDb.$executeRaw`UPDATE bas_point_roles SET setpoint_for = NULL, status_of = NULL`;
  await testDb.basPointRole.deleteMany();
  await testDb.basEquipmentType.deleteMany();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDb();
});

/** What still needs a decision after the pass, by station: pinned, and printed in the PR. */
const STILL_NEEDS_A_DECISION: Record<string, string[]> = {};

describe("CEI's controllers through the scheduler's pass", () => {
  it("attaches each controller's points to the unit or plant its station is named for, and gives the roles the names settle", async () => {
    await buildCei();
    const equipmentBefore = await testDb.basEquipment.findMany({ where: { siteId }, select: { equipmentId: true, name: true } });
    const ahu7 = equipmentBefore.find((e) => e.name === "AHU_7")!;
    expect(ahu7).toBeDefined();

    const pass = await runAutoAssignPass();
    expect(pass.failed).toEqual([]);

    // CEI_AHU_7 IS the JACE's AHU_7: the same row, not a second unit, and
    // no "AHU_07" for the eight points written with a leading zero.
    const equipment = await testDb.basEquipment.findMany({ where: { siteId }, select: { equipmentId: true, name: true, equipType: true } });
    expect(equipment.filter((e) => e.name === "AHU_7")).toEqual([{ equipmentId: ahu7.equipmentId, name: "AHU_7", equipType: "ahu" }]);
    expect(equipment.some((e) => e.name === "AHU_07")).toBe(false);
    expect(equipment.find((e) => e.name === "PLANT")).toMatchObject({ equipType: "plant_chw" });
    expect(equipment.some((e) => /JCI|N2/.test(e.name))).toBe(false);

    for (const [name, unit] of [["CEI_AHU_7", "AHU_7"], ["CEI_AHU_8", "AHU_8"], ["CEI_PLANT", "PLANT"]] as const) {
      const now = await stateOn(name);
      for (const [point, s] of now) expect(s.equipment, `${name}:${point}`).toBe(unit);
    }

    const ahu = await stateOn("CEI_AHU_7");
    expect(ahu.get("AHU_7_Da_Temp")).toMatchObject({ role: "supply_air_temp", source: "auto" });
    expect(ahu.get("AHU_7_Da_Temp_Spt")).toMatchObject({ role: "supply_air_temp_sp" });
    expect(ahu.get("AHU_7_Da_Press")).toMatchObject({ role: "duct_static_pressure" });
    expect(ahu.get("AHU_7_Sa_Fan_Sts")).toMatchObject({ role: "supply_fan_status" });
    expect(ahu.get("AHU_07_Oa_Temp")).toMatchObject({ role: "outside_air_temp", equipment: "AHU_7" });
    expect(ahu.get("AHU_7_Sa_Fan_1_Sts")).toMatchObject({ role: null, equipment: "AHU_7" });
    const plant = await stateOn("CEI_PLANT");
    expect(plant.get("Clg_Plant_Chws_Temp")).toMatchObject({ role: "chw_supply_temp", equipType: "plant_chw" });
    expect(plant.get("Clg_Plant_Chwr_Temp")).toMatchObject({ role: "chw_return_temp" });
    expect(plant.get("Clg_Plant_Chws_Temp_Spt")).toMatchObject({ role: "chw_supply_temp_sp" });

    // What still needs a decision, station by station.
    for (const name of ["CEI_AHU_7", "CEI_AHU_8", "CEI_PLANT"]) {
      STILL_NEEDS_A_DECISION[name] = [...(await stateOn(name)).entries()].filter(([, s]) => s.role === null).map(([n]) => n).sort();
    }
    const jaceFixture = CONTROLLER_ROWS.filter((r) => r.station === "CEI_JCI_N2").map((r) => r.name);
    const jace = await stateOn("CEI_JCI_N2");
    STILL_NEEDS_A_DECISION.CEI_JCI_N2 = jaceFixture.filter((n) => jace.get(n)?.role === null).sort();
    expect(STILL_NEEDS_A_DECISION).toEqual(EXPECTED_NEEDS_A_DECISION);

    // Idempotent: nothing more on a second pass.
    const audit = await testDb.auditEvent.count();
    const again = await runAutoAssignPass();
    expect(again.stations.filter((s) => s.outcome === "assigned")).toEqual([]);
    expect(await testDb.auditEvent.count()).toBe(audit);
  }, 240_000);
});

describe("the station rule on other names", () => {
  it("RTU_3: a station of unprefixed names becomes the rooftop unit, and DA_T its supply air", async () => {
    const id = await station("SITE_RTU_3");
    await testDb.basPoint.createMany({
      data: [
        { stationId: id, niagaraHistoryName: "DA_T" },
        { stationId: id, niagaraHistoryName: "SF_S", dataType: "bool" },
        { stationId: id, niagaraHistoryName: "Mystery_1" },
      ],
    });
    await runAutoAssignPass();
    const now = await stateOn("SITE_RTU_3");
    expect(now.get("DA_T")).toMatchObject({ role: "supply_air_temp", equipment: "RTU_3", equipType: "rtu", source: "auto" });
    expect(now.get("SF_S")).toMatchObject({ role: "supply_fan_status", equipment: "RTU_3" });
    // Equipment, and no role: a person decides what it is.
    expect(now.get("Mystery_1")).toMatchObject({ role: null, equipment: "RTU_3" });
  }, 120_000);

  it("a split plant: chilled and hot water halves, and a point naming neither gets no equipment", async () => {
    const id = await station("SITE_PLANT");
    await testDb.basPoint.createMany({
      data: ["CHWS_Temp", "CHWR_Temp", "HWS_Temp", "HWR_Temp", "Oa_Temp"].map((n) => ({ stationId: id, niagaraHistoryName: n, unit: "fahrenheit", dataType: "real" })),
    });
    await runAutoAssignPass();
    const now = await stateOn("SITE_PLANT");
    expect(now.get("CHWS_Temp")).toMatchObject({ role: "chw_supply_temp", equipment: "PLANT_CHW", equipType: "plant_chw" });
    expect(now.get("CHWR_Temp")).toMatchObject({ role: "chw_return_temp", equipment: "PLANT_CHW" });
    expect(now.get("HWS_Temp")).toMatchObject({ role: "hw_supply_temp", equipment: "PLANT_HW", equipType: "plant_hw" });
    expect(now.get("HWR_Temp")).toMatchObject({ role: "hw_return_temp", equipment: "PLANT_HW" });
    expect(now.get("Oa_Temp")).toMatchObject({ role: "outside_air_temp", equipment: null });
  }, 120_000);

  it("CEI_JCI_N2 does not become equipment", async () => {
    const id = await station("CEI_JCI_N2");
    await testDb.basPoint.createMany({ data: [{ stationId: id, niagaraHistoryName: "DA_T" }, { stationId: id, niagaraHistoryName: "OA_Enth" }] });
    await runAutoAssignPass();
    expect(await testDb.basEquipment.count({ where: { siteId } })).toBe(0);
    expect((await stateOn("CEI_JCI_N2")).get("DA_T")).toMatchObject({ equipment: null });
  }, 120_000);
});

describe("the no-overwrite rules hold for the station rule", () => {
  it("never writes a point a person set, never moves one off its equipment, and fills only the empty half", async () => {
    const id = await station("CEI_AHU_7");
    await testDb.basPoint.createMany({
      data: [
        { stationId: id, niagaraHistoryName: "AHU_7_Da_Temp", unit: "fahrenheit", dataType: "real" },
        { stationId: id, niagaraHistoryName: "AHU_7_Ma_Temp", unit: "fahrenheit", dataType: "real" },
        { stationId: id, niagaraHistoryName: "AHU_7_Ra_Temp", unit: "fahrenheit", dataType: "real" },
        { stationId: id, niagaraHistoryName: "AHU_7_Oa_Temp", unit: "fahrenheit", dataType: "real" },
      ],
    });
    const other = await testDb.basEquipment.create({ data: { siteId, name: "Somewhere_else", equipType: "ahu" } });
    const pointId = async (name: string) =>
      (await testDb.basPoint.findFirstOrThrow({ where: { stationId: id, niagaraHistoryName: name }, select: { pointId: true } })).pointId.toString();
    const patch = async (name: string, body: unknown) => {
      const response = await pointRoute(
        new Request("http://localhost", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        { params: Promise.resolve({ pointId: await pointId(name) }) },
      );
      expect(response.status, name).toBe(200);
    };
    // A person chose "unclassified" for Ma_Temp, and Somewhere_else for Ra_Temp.
    await patch("AHU_7_Ma_Temp", { role: "unclassified" });
    await patch("AHU_7_Ra_Temp", { equipmentId: other.equipmentId.toString() });
    // The platform's earlier pass gave Oa_Temp a role and no equipment.
    await testDb.basPoint.updateMany({ where: { stationId: id, niagaraHistoryName: "AHU_7_Oa_Temp" }, data: { pointRole: "return_air_temp", assignmentSource: "auto" } });

    await runAutoAssignPass();
    const now = await stateOn("CEI_AHU_7");
    expect(now.get("AHU_7_Da_Temp")).toMatchObject({ role: "supply_air_temp", equipment: "AHU_7", source: "auto" });
    expect(now.get("AHU_7_Ma_Temp")).toMatchObject({ role: "unclassified", equipment: null, source: "manual" });
    expect(now.get("AHU_7_Ra_Temp")).toMatchObject({ role: null, equipment: "Somewhere_else", source: "manual" });
    // Equipment filled; the role it had is never overwritten, even a wrong one.
    expect(now.get("AHU_7_Oa_Temp")).toMatchObject({ role: "return_air_temp", equipment: "AHU_7", source: "auto" });
  }, 120_000);
});

/**
 * Still needing a decision after the pass, from the real names: pinned. Every
 * one is a vocabulary gap, a numbered member of an array (six supply fans,
 * two chillers, two pumps - one role per unit, see suggestions.ts), a limit,
 * an aggregate, a feedback, or (Sched_Mode) a medium suggestion a person
 * confirms. The PR lists them by reason.
 */
const EXPECTED_NEEDS_A_DECISION: Record<string, string[]> = {
  CEI_AHU_7: [
    "AHU_07_Ra_Fan_DP_1",
    "AHU_07_Ra_Fan_DP_2",
    "AHU_07_Ra_Fan_DP_3",
    "AHU_07_Ra_Fan_DP_4",
    "AHU_07_Ra_Fan_DP_5",
    "AHU_07_Ra_Press_Lo_Alm",
    "AHU_7_Clg_Available",
    "AHU_7_Clg_Req_Scaled",
    "AHU_7_Clg_Sig_Lower",
    "AHU_7_Clg_Sig_Upper",
    "AHU_7_Clv_Vlv_Lower_Fbk",
    "AHU_7_Clv_Vlv_Upper_Fbk",
    "AHU_7_Da_Temp_Spt_Max",
    "AHU_7_Da_Temp_Spt_Min",
    "AHU_7_Dehum_State",
    "AHU_7_Ea_Dmpr_Fbk",
    "AHU_7_Ea_Press",
    "AHU_7_Econ_State",
    "AHU_7_Fire_Alm",
    "AHU_7_Hi_Lo_Press_Alm",
    "AHU_7_Htg_Available",
    "AHU_7_Htg_Vlv_Fbk",
    "AHU_7_NOT_USED_Trim_Respond_Pressure_I",
    "AHU_7_NOT_USED_Trim_Respond_Pressure_SP_Active",
    "AHU_7_NOT_USED_Trim_Respond_Temp_I",
    "AHU_7_Oa_Dmpr_Cmd",
    "AHU_7_Oa_Dmpr_Fbk",
    "AHU_7_Oa_Dmpr_Min_Pos_Spt_Sa_Fan_Sig",
    "AHU_7_Oa_Dmpr_Sa_Fan_Max_Spt",
    "AHU_7_Oa_Dmpr_Sa_Fan_Min_Spt",
    "AHU_7_R_Clg",
    "AHU_7_R_Press",
    "AHU_7_Ra_Dmpr_Fbk",
    "AHU_7_Ra_Fan_1_Sts",
    "AHU_7_Ra_Fan_1_Sts_DP",
    "AHU_7_Ra_Fan_2_Sts",
    "AHU_7_Ra_Fan_2_Sts_DP",
    "AHU_7_Ra_Fan_3_Sts",
    "AHU_7_Ra_Fan_3_Sts_DP",
    "AHU_7_Ra_Fan_4_Sts",
    "AHU_7_Ra_Fan_4_Sts_DP",
    "AHU_7_Ra_Fan_5_Sts",
    "AHU_7_Ra_Fan_5_Sts_DP",
    "AHU_7_Ra_Fan_DP_1",
    "AHU_7_Ra_Fan_DP_2",
    "AHU_7_Ra_Fan_DP_3",
    "AHU_7_Ra_Fan_DP_4",
    "AHU_7_Ra_Fan_DP_5",
    "AHU_7_Ra_Fan_DP_6",
    "AHU_7_Ra_Press_Spt",
    "AHU_7_Ra_Rh_Spt",
    "AHU_7_Sa_Fan_1_Sts",
    "AHU_7_Sa_Fan_2_Sts",
    "AHU_7_Sa_Fan_3_Sts",
    "AHU_7_Sa_Fan_4_Sts",
    "AHU_7_Sa_Fan_5_Sts",
    "AHU_7_Sa_Fan_6_Sts",
    "AHU_7_Safety_Latched",
    "AHU_7_Safety_Reset_Cmd",
    "AHU_7_Safety_Tripped",
    "AHU_7_Sched_Mode",
    "AHU_7_Software_Frz_Alm",
    "AHU_7_State",
    "AHU_7_Zn_A_Press",
    "AHU_7_Zn_Rh_Avg",
    "AHU_7_Zn_Rh_Max",
    "AHU_7_Zn_Rh_Min",
    "AHU_7_Zn_Temp_Avg",
    "AHU_7_Zn_Temp_Max",
    "AHU_7_Zn_Temp_Min",
  ],
  CEI_AHU_8: [
    "AHU_8_Clg_Available",
    "AHU_8_Clg_Req_Scaled",
    "AHU_8_Clg_Sig_Lower",
    "AHU_8_Clg_Sig_Upper",
    "AHU_8_Clv_Vlv_Lower_Fbk",
    "AHU_8_Clv_Vlv_Upper_Fbk",
    "AHU_8_Da_Press_Hi_Alm",
    "AHU_8_Da_Temp_Spt_Max",
    "AHU_8_Da_Temp_Spt_Min",
    "AHU_8_Dehum_State",
    "AHU_8_Ea_Dmpr_Fbk",
    "AHU_8_Ea_Press",
    "AHU_8_Econ_State",
    "AHU_8_Fire_Alm",
    "AHU_8_Hi_Lo_Press_Alm",
    "AHU_8_Htg_Available",
    "AHU_8_Htg_Vlv_Fbk",
    "AHU_8_Humidifier_Sig",
    "AHU_8_NOT_USED_Trim_Respond_Pressure_I",
    "AHU_8_NOT_USED_Trim_Respond_Pressure_SP_Active",
    "AHU_8_NOT_USED_Trim_Respond_Temp_I",
    "AHU_8_Oa_Dmpr_Cmd",
    "AHU_8_Oa_Dmpr_Fbk",
    "AHU_8_Oa_Dmpr_Min_Pos_Spt_Sa_Fan_Sig",
    "AHU_8_Oa_Dmpr_Sa_Fan_Max_Spt",
    "AHU_8_Oa_Dmpr_Sa_Fan_Min_Spt",
    "AHU_8_Oa_Temp_Backup",
    "AHU_8_R_Clg",
    "AHU_8_R_Press",
    "AHU_8_Ra_Dmpr_Fbk",
    "AHU_8_Ra_Fan_1_Sts",
    "AHU_8_Ra_Fan_2_Sts",
    "AHU_8_Ra_Fan_3_Sts",
    "AHU_8_Ra_Fan_4_Sts",
    "AHU_8_Ra_Fan_DP_1",
    "AHU_8_Ra_Fan_DP_2",
    "AHU_8_Ra_Fan_DP_3",
    "AHU_8_Ra_Fan_DP_4",
    "AHU_8_Ra_Press_Lo_Alm",
    "AHU_8_Ra_Press_Spt",
    "AHU_8_Ra_Rh_Spt",
    "AHU_8_Sa_Fan_1_Sts",
    "AHU_8_Sa_Fan_2_Sts",
    "AHU_8_Sa_Fan_3_Sts",
    "AHU_8_Sa_Fan_4_Sts",
    "AHU_8_Sa_Fan_5_Sts",
    "AHU_8_Sa_Fan_6_Sts",
    "AHU_8_Safety_Latched",
    "AHU_8_Safety_Reset_Cmd",
    "AHU_8_Safety_Tripped",
    "AHU_8_Sched_Mode",
    "AHU_8_Software_Frz_Alm",
    "AHU_8_State",
    "AHU_8_Zn_A_Press",
    "AHU_8_Zn_Rh_Avg",
    "AHU_8_Zn_Rh_Max",
    "AHU_8_Zn_Rh_Min",
    "AHU_8_Zn_Temp_Avg",
    "AHU_8_Zn_Temp_Max",
    "AHU_8_Zn_Temp_Min",
  ],
  CEI_PLANT: [
    "Clg_Plant_Ch_1_Alarm",
    "Clg_Plant_Ch_1_Cmd",
    "Clg_Plant_Ch_1_Enab",
    "Clg_Plant_Ch_1_Flt_Alm",
    "Clg_Plant_Ch_1_Iso_Vlv_Fbk",
    "Clg_Plant_Ch_1_Iso_Vlv_Sig",
    "Clg_Plant_Ch_1_Lvg_Temp",
    "Clg_Plant_Ch_1_Mode",
    "Clg_Plant_Ch_1_State",
    "Clg_Plant_Ch_1_Sts",
    "Clg_Plant_Ch_1_Sts_Bacnet",
    "Clg_Plant_Ch_2_Alarm",
    "Clg_Plant_Ch_2_Cmd",
    "Clg_Plant_Ch_2_Enab",
    "Clg_Plant_Ch_2_Flt_Alm",
    "Clg_Plant_Ch_2_Iso_Vlv_Fbk",
    "Clg_Plant_Ch_2_Iso_Vlv_Sig",
    "Clg_Plant_Ch_2_Lvg_Temp",
    "Clg_Plant_Ch_2_Mode",
    "Clg_Plant_Ch_2_State",
    "Clg_Plant_Ch_2_Sts",
    "Clg_Plant_Ch_2_Sts_Bacnet",
    "Clg_Plant_Ch_Min_On_Spt",
    "Clg_Plant_Ch_On_Delay_Spt",
    "Clg_Plant_Chw_Diff_Press_Spt",
    "Clg_Plant_Chw_Press",
    "Clg_Plant_Chwp_A_Binary_Sts",
    "Clg_Plant_Chwp_B_Binary_Sts",
    "Clg_Plant_Clg_Oa_Temp_Spt",
    "Clg_Plant_Clg_Plant_Enab",
    "Clg_Plant_Freeze_Protection_Mode",
    "Clg_Plant_Frz_Protection_Mode",
    "Clg_Plant_Iso_Vlv_Cmd",
    "Clg_Plant_Lead_Current",
    "Clg_Plant_Reset_Chws_Temp_Spt_Max_Ahu_Ra_Rh",
    "Clg_Plant_Sched_Mode",
    "Clg_Plant_Sec_Chwp_1_Cmd",
    "Clg_Plant_Sec_Chwp_1_Current",
    "Clg_Plant_Sec_Chwp_1_Fbk",
    "Clg_Plant_Sec_Chwp_1_Sig",
    "Clg_Plant_Sec_Chwp_1_Sts",
    "Clg_Plant_Sec_Chwp_2_Cmd",
    "Clg_Plant_Sec_Chwp_2_Current",
    "Clg_Plant_Sec_Chwp_2_Fbk",
    "Clg_Plant_Sec_Chwp_2_Sig",
    "Clg_Plant_Sec_Chwp_2_Sts",
    "Clg_Plant_Sec_Chwp_Spt_TAB",
    "Clg_Plant_Sys_A_Cmd",
    "Clg_Plant_Sys_B_Cmd",
    "Clg_Plant_Unit_A_Pump_Cmd",
    "Clg_Plant_Unit_A_Sts",
    "Clg_Plant_Unit_B_Pump_Cmd",
    "Clg_Plant_Unit_B_Sts",
  ],
  CEI_JCI_N2: [
    "AHU_7/OA_Enth",
    "AHU_7/RA_Enth",
    "AHU_8/RA_Enth",
  ],
};
