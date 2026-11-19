import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { describeAuditEvent } from "@/lib/admin/audit-describe";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { runAutoAssignPass } from "@/lib/modules/bas/auto-assign";
import { equipmentKey } from "@/lib/modules/bas/name-prefix";
import type { BasSettingsTree, StationAssignment, StationPointsList } from "@/lib/modules/bas/types";
import { renderReportHtml } from "@/lib/modules/bas/reports/engine/html";
import { unroledLine } from "@/lib/modules/bas/reports/engine/render";
import { describeAssignmentCounts, describeAssignmentResult } from "@/app/(modules)/bas/health-client";
import { seedBasVocabularies } from "../prisma/bas-vocabularies";
import { GET as settingsRoute } from "@/app/api/modules/bas/settings/route";
import { GET as pointsRoute } from "@/app/api/modules/bas/settings/stations/[stationId]/points/route";
import { POST as runNowRoute } from "@/app/api/modules/bas/settings/stations/[stationId]/auto-assign/route";
import { PATCH as pointRoute } from "@/app/api/modules/bas/settings/points/[pointId]/route";
import { reportDocument } from "./fixtures/bas-report-document";
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
 * The automatic assignment pass (2026-11-19, lib/modules/bas/auto-assign.ts)
 * on CEI_JCI_N2 as a station: its 334 real names from
 * docs/fixtures/cei-point-names.txt, stored the way oBIX escapes a key (`/` as
 * `$2f`) with no display name, no unit and the column's default data type -
 * what discovery leaves before anyone has looked. Names and nothing else.
 *
 * The pass runs as the scheduler runs it (runAutoAssignPass) and as the
 * Settings button does (the route), and the person's side goes through the
 * real PATCH route, so "manual beats auto" is a statement about the requests
 * the UI makes.
 */

const NAMES = readFileSync(path.join(process.cwd(), "docs/fixtures/cei-point-names.txt"), "utf8")
  .split(/\r?\n/)
  .filter((n) => n.length > 0);
const escape = (name: string) => name.replace(/\//g, "$2f").replace(/-/g, "$2d");
const unescape = (key: string) => key.replace(/\$2f/g, "/").replace(/\$2d/g, "-");

/** The seven names the vocabulary cannot settle from the name alone. */
const NEEDS_DECISION = [
  "AHU_7/OA_Enth",
  "AHU_7/RA_Enth",
  "AHU_8/RA_Enth",
  "XTM_109/AHU_7_FinalFilter",
  "XTM_109/AHU_7_PreFilter",
  "XTM_109/AHU_8_FinalFilter",
  "XTM_109/AHU_8_PreFilter",
];

const AHU_ROLES: Record<string, { role: string | null; equipment: string }> = {
  "AHU_7/DA_SAP": { role: "duct_static_pressure", equipment: "AHU_7" },
  "AHU_7/DA_T": { role: "supply_air_temp", equipment: "AHU_7" },
  "AHU_7/MA_T": { role: "mixed_air_temp", equipment: "AHU_7" },
  "AHU_7/OA_Enth": { role: null, equipment: "AHU_7" },
  "AHU_7/OA_H": { role: "outside_air_humidity", equipment: "AHU_7" },
  "AHU_7/OA_T": { role: "outside_air_temp", equipment: "AHU_7" },
  "AHU_7/RA_Enth": { role: null, equipment: "AHU_7" },
  "AHU_7/RA_HUM": { role: "return_air_humidity", equipment: "AHU_7" },
  "AHU_7/RA_T": { role: "return_air_temp", equipment: "AHU_7" },
  "AHU_7/RF_S": { role: "return_fan_status", equipment: "AHU_7" },
  "AHU_7/SF_S": { role: "supply_fan_status", equipment: "AHU_7" },
  "AHU_8/OA_H": { role: "outside_air_humidity", equipment: "AHU_8" },
  "AHU_8/RA_Enth": { role: null, equipment: "AHU_8" },
  "AHU_8/RA_HUM": { role: "return_air_humidity", equipment: "AHU_8" },
  // The XTM expansion module is looked past: the filters belong to the AHU
  // their name carries.
  "XTM_109/AHU_7_FinalFilter": { role: null, equipment: "AHU_7" },
  "XTM_109/AHU_7_PreFilter": { role: null, equipment: "AHU_7" },
  "XTM_109/AHU_8_FinalFilter": { role: null, equipment: "AHU_8" },
  "XTM_109/AHU_8_PreFilter": { role: null, equipment: "AHU_8" },
};

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
let employeeId: string;
const ids = new Map<string, string>();

async function data<T>(pending: Promise<Response>): Promise<T> {
  const response = await pending;
  const body = (await response.json()) as { data?: T; error?: { code: string; message: string } };
  if (body.error !== undefined) throw new Error(`${response.status} ${body.error.code}: ${body.error.message}`);
  return body.data as T;
}
const stationParams = (id: bigint = stationId) => ({ params: Promise.resolve({ stationId: id.toString() }) });
const runNow = (id: bigint = stationId) =>
  data<StationAssignment>(runNowRoute(new Request("http://localhost", { method: "POST" }), stationParams(id)));
const patchPoint = (name: string, body: unknown) =>
  data<unknown>(
    pointRoute(
      new Request("http://localhost", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ pointId: ids.get(name)! }) },
    ),
  );

/** Each point by its decoded name: role, equipment and source. */
async function state(id: bigint = stationId) {
  const rows = await testDb.$queryRaw<
    Array<{ niagara_history_name: string; point_role: string | null; equipment: string | null; equip_type: string | null; assignment_source: string | null }>
  >`
    SELECT p.niagara_history_name, p.point_role, e.name AS equipment, e.equip_type, p.assignment_source
      FROM bas_points p LEFT JOIN bas_equipment e ON e.equipment_id = p.equipment_id
     WHERE p.station_id = ${id}`;
  return new Map(
    rows.map((r) => [
      unescape(r.niagara_history_name),
      { role: r.point_role, equipment: r.equipment, equipType: r.equip_type, source: r.assignment_source },
    ]),
  );
}
const audits = (action: string) => testDb.auditEvent.findMany({ where: { action }, orderBy: { occurredAt: "asc" } });
const needingDecision = async () =>
  [...(await state()).entries()].filter(([, s]) => s.role === null).map(([name]) => name).sort();

async function stationOnTree(id: bigint = stationId) {
  const tree = await data<BasSettingsTree>(settingsRoute(new Request("http://localhost/api/modules/bas/settings")));
  for (const project of tree.projects)
    for (const building of project.buildings)
      for (const station of building.stations) if (station.stationId === id.toString()) return station;
  throw new Error("station not on the tree");
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
  siteId = (
    await testDb.basSite.create({ data: { orgId, projectId, name: "ZZTEST CEI", timezone: "America/New_York" } })
  ).siteId;
  stationId = (await testDb.basStation.create({ data: { siteId, niagaraStationName: "CEI_JCI_N2" } })).stationId;

  // Names only: no unit, the column's default data type, no display name.
  await testDb.basPoint.createMany({
    data: NAMES.map((name) => ({ stationId, niagaraHistoryName: escape(name), niagaraDisplayName: null })),
  });
  ids.clear();
  for (const p of await testDb.basPoint.findMany({ where: { stationId }, select: { pointId: true, niagaraHistoryName: true } })) {
    ids.set(unescape(p.niagaraHistoryName), p.pointId.toString());
  }

  const employee = await createEmployee();
  employeeId = employee.id;
  await grantModule(employee.id, BAS_MODULE_KEY);
  await grantModuleAdmin(employee.id, BAS_MODULE_KEY);
  signedInAs(employee.entraOid!);
});

afterEach(async () => {
  const sites = await testDb.basSite.findMany({ where: { orgId }, select: { siteId: true } });
  const stations = await testDb.basStation.findMany({ where: { siteId: { in: sites.map((s) => s.siteId) } }, select: { stationId: true } });
  await testDb.basPoint.deleteMany({ where: { stationId: { in: stations.map((s) => s.stationId) } } });
  await testDb.basEquipment.deleteMany({ where: { siteId: { in: sites.map((s) => s.siteId) } } });
  await testDb.basStation.deleteMany({ where: { stationId: { in: stations.map((s) => s.stationId) } } });
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

// ---------------------------------------------------------------------------

describe("CEI_JCI_N2 through one scheduler pass, names only", () => {
  it("creates the 155 VAVs and two AHUs as written, assigns the 310 temperatures, and leaves exactly seven names", async () => {
    const pass = await runAutoAssignPass();
    expect(pass.failed).toEqual([]);
    const result = pass.stations.find((s) => s.stationId === stationId.toString())!;
    expect(result).toMatchObject({
      outcome: "assigned",
      candidates: 334,
      pointsAssigned: 334,
      equipmentAttached: 334,
      roleAssigned: 327,
      needDecision: 7,
    });

    // Equipment: one per prefix, named exactly as the integrator wrote it.
    const equipment = await testDb.basEquipment.findMany({ where: { siteId }, select: { name: true, equipType: true } });
    const prefixes = new Set(NAMES.filter((n) => /^V\d/.test(n)).map((n) => n.split("/")[0]!));
    expect(prefixes.size).toBe(155);
    expect(equipment.filter((e) => e.equipType === "vav").map((e) => e.name).sort()).toEqual([...prefixes].sort());
    expect(equipment.filter((e) => e.equipType === "ahu").map((e) => e.name).sort()).toEqual(["AHU_7", "AHU_8"]);
    expect(equipment).toHaveLength(157);
    expect(equipment.some((e) => e.name.startsWith("XTM"))).toBe(false);
    expect(result.equipmentCreated).toHaveLength(157);

    const now = await state();
    // The 310 zone and discharge temperatures, each on its own box.
    let temps = 0;
    for (const name of NAMES.filter((n) => /^V\d.*\/(SpaceTemp|DaTemp)$/.test(n))) {
      const [prefix, tail] = name.split("/");
      expect(now.get(name), name).toMatchObject({
        role: tail === "SpaceTemp" ? "zone_temp" : "discharge_air_temp",
        equipment: prefix,
        equipType: "vav",
        source: "auto",
      });
      temps += 1;
    }
    expect(temps).toBe(310);
    for (const name of NAMES.filter((n) => n.endsWith("/Humidity"))) {
      expect(now.get(name), name).toMatchObject({ role: "space_humidity", equipment: name.split("/")[0] });
    }
    // The AHUs, with the XTM filters attached to theirs.
    for (const [name, expected] of Object.entries(AHU_ROLES)) {
      expect(now.get(name), name).toMatchObject({ ...expected, equipType: "ahu", source: "auto" });
    }

    // What is left for a person: exactly these, and printed for the record.
    const left = await needingDecision();
    console.info(`CEI names left needing a decision (${left.length}):\n  ${left.join("\n  ")}`);
    expect(left).toEqual(NEEDS_DECISION);
    expect([...now.values()].every((s) => s.source === "auto")).toBe(true);
  }, 120_000);

  it("writes one audit row per point saying what and why, with the platform as actor", async () => {
    await runAutoAssignPass();

    const rows = await audits("bas.point_auto_assigned");
    expect(rows).toHaveLength(334);
    expect(rows.every((r) => r.actorEmployeeId === null)).toBe(true);
    const daTemp = rows.find((r) => (r.metadata as { pointName: string }).pointName === "V4_22/DaTemp")!;
    expect(daTemp.metadata).toMatchObject({
      trigger: "scheduler",
      stationId: stationId.toString(),
      role: { role: "discharge_air_temp", level: "high", pattern: "tail_discharge_air_temp" },
      equipment: { name: "V4_22", equipType: "vav", created: true },
    });
    expect((daTemp.metadata as { role: { reason: string } }).role.reason).toMatch(/terminal unit's discharge air/);
    const enth = rows.find((r) => (r.metadata as { pointName: string }).pointName === "AHU_7/OA_Enth")!;
    expect(enth.metadata).toMatchObject({ role: null, equipment: { name: "AHU_7", created: true } });

    expect(await audits("bas.equipment_created")).toHaveLength(157);
    expect((await audits("bas.equipment_created")).every((r) => (r.metadata as { source: string }).source === "auto")).toBe(true);
    const summary = await audits("bas.auto_assignment_ran");
    expect(summary).toHaveLength(1);
    expect(summary[0]!.metadata).toMatchObject({ trigger: "scheduler", roleAssigned: 327, equipmentAttached: 334, needDecision: 7 });

    const sentence = (row: (typeof rows)[number]) =>
      describeAuditEvent({ action: row.action, moduleKey: row.moduleKey, metadata: row.metadata as never, actor: null, target: null }).sentence;
    expect(sentence(daTemp)).toBe(
      "The platform gave the point V4_22/DaTemp the role discharge_air_temp and attached it to the equipment V4_22, automatically from its name",
    );
    expect(sentence(summary[0]!)).toBe(
      "The platform assigned points automatically on station CEI_JCI_N2: a role on 327 points, equipment on 334, 157 pieces of equipment created; 7 points need a decision",
    );
  }, 120_000);

  it("is idempotent: a second pass writes nothing and opens no transaction's worth of rows", async () => {
    await runAutoAssignPass();
    const before = { audit: await testDb.auditEvent.count(), equipment: await testDb.basEquipment.count(), state: await state() };

    const again = await runAutoAssignPass();
    const result = again.stations.find((s) => s.stationId === stationId.toString())!;
    // The seven are still candidates; nothing high-confidence exists for them.
    expect(result).toMatchObject({ outcome: "no_change", candidates: 7, pointsAssigned: 0, needDecision: 7 });
    expect(await testDb.auditEvent.count()).toBe(before.audit);
    expect(await testDb.basEquipment.count()).toBe(before.equipment);
    expect(await state()).toEqual(before.state);
  }, 120_000);

  it("skips a station with no candidate without reading its points", async () => {
    await testDb.basPoint.updateMany({ where: { stationId }, data: { assignmentSource: "manual" } });
    const pass = await runAutoAssignPass();
    expect(pass.stations.find((s) => s.stationId === stationId.toString())).toMatchObject({
      outcome: "nothing_to_assign",
      candidates: 0,
      needDecision: 334,
    });
    expect(await testDb.auditEvent.count({ where: { action: { startsWith: "bas." } } })).toBe(0);
  });
});

describe("manual beats auto", () => {
  it("never writes a point a person set, not even its empty half", async () => {
    // A person decides V4_22/SpaceTemp is not mappable before the pass runs.
    await patchPoint("V4_22/SpaceTemp", { role: "unclassified" });
    expect((await state()).get("V4_22/SpaceTemp")).toMatchObject({ role: "unclassified", equipment: null, source: "manual" });

    await runAutoAssignPass();
    const after = await state();
    // Left exactly as the person left it - its equipment half too.
    expect(after.get("V4_22/SpaceTemp")).toMatchObject({ role: "unclassified", equipment: null, source: "manual" });
    // Its box still came from the other point with that prefix.
    expect(after.get("V4_22/DaTemp")).toMatchObject({ role: "discharge_air_temp", equipment: "V4_22", source: "auto" });
    const rows = await audits("bas.point_auto_assigned");
    expect(rows.some((r) => (r.metadata as { pointName: string }).pointName === "V4_22/SpaceTemp")).toBe(false);
  }, 120_000);

  it("does not put back a role a person cleared, or equipment a person detached", async () => {
    await runAutoAssignPass();

    await patchPoint("V4_23/SpaceTemp", { role: null });
    await patchPoint("V4_23/DaTemp", { equipmentId: null });
    const edited = await state();
    expect(edited.get("V4_23/SpaceTemp")).toMatchObject({ role: null, equipment: "V4_23", source: "manual" });
    expect(edited.get("V4_23/DaTemp")).toMatchObject({ role: "discharge_air_temp", equipment: null, source: "manual" });

    const again = await runAutoAssignPass();
    const after = await state();
    expect(after.get("V4_23/SpaceTemp")).toEqual(edited.get("V4_23/SpaceTemp"));
    expect(after.get("V4_23/DaTemp")).toEqual(edited.get("V4_23/DaTemp"));
    // The cleared role waits for a person, with its suggestion as the choice.
    expect(await needingDecision()).toEqual([...NEEDS_DECISION, "V4_23/SpaceTemp"].sort());
    expect(again.stations.find((s) => s.stationId === stationId.toString())!.pointsAssigned).toBe(0);

    const list = await data<StationPointsList>(pointsRoute(new Request("http://localhost"), stationParams()));
    const cleared = list.points.find((p) => p.pointId === ids.get("V4_23/SpaceTemp"))!;
    expect(cleared).toMatchObject({ needsDecision: true, assignmentSource: "manual", suggestion: { role: "zone_temp", level: "high" } });
  }, 120_000);

  it("leaves a point with both halves empty alone once a person has touched it", async () => {
    await testDb.basPoint.update({ where: { pointId: BigInt(ids.get("AHU_7/SF_S")!) }, data: { assignmentSource: "manual" } });
    await runAutoAssignPass();
    expect((await state()).get("AHU_7/SF_S")).toMatchObject({ role: null, equipment: null, source: "manual" });
  }, 120_000);
});

describe("medium stays unassigned", () => {
  it("leaves a medium suggestion on the row as a one-click choice, and writes nothing for it", async () => {
    // A damper on a unit whose type the name does not give: a box damper,
    // probably, and a person should look first.
    const medium = await testDb.basPoint.create({ data: { stationId, niagaraHistoryName: escape("Points/DMPR") } });
    await runAutoAssignPass();
    expect((await state()).get("Points/DMPR")).toMatchObject({ role: null, equipment: null, source: null });

    const list = await data<StationPointsList>(pointsRoute(new Request("http://localhost"), stationParams()));
    expect(list.points.find((p) => p.pointId === medium.pointId.toString())).toMatchObject({
      needsDecision: true,
      assignmentSource: null,
      suggestion: { role: "vav_damper_cmd", level: "medium" },
    });
    const rows = await audits("bas.point_auto_assigned");
    expect(rows.some((r) => (r.metadata as { pointName: string }).pointName === "Points/DMPR")).toBe(false);
  }, 120_000);
});

describe("a prefix of no known type, and an I/O module, are left for a person", () => {
  it("creates no equipment for them, and still gives a role the name settles on any unit", async () => {
    await testDb.basPoint.createMany({
      data: [
        { stationId, niagaraHistoryName: escape("FCU_3/SpaceTemp") },
        { stationId, niagaraHistoryName: escape("XTM_109/Spare_AI_3") },
      ],
    });
    await runAutoAssignPass();
    const now = await state();
    // FCU is not in the prefix table: the preview asks a person for a type.
    expect(now.get("FCU_3/SpaceTemp")).toMatchObject({ role: "zone_temp", equipment: null, source: "auto" });
    // A spare input on the expansion module names nothing.
    expect(now.get("XTM_109/Spare_AI_3")).toMatchObject({ role: null, equipment: null, source: null });
    const names = (await testDb.basEquipment.findMany({ where: { siteId }, select: { name: true } })).map((e) => e.name);
    expect(names).not.toContain("FCU_3");
    expect(names).not.toContain("XTM_109");
  }, 120_000);
});

describe("the office and lab canon: the pass never contradicts the classification done by hand", () => {
  interface CanonPoint {
    niagaraHistoryName: string;
    niagaraDisplayName: string | null;
    unit: string | null;
    dataType: string;
    isActive: boolean;
    inactiveReason: string | null;
    role: string | null;
    equipment: string | null;
  }
  const canon = JSON.parse(
    readFileSync(path.join(process.cwd(), "tests/fixtures/bas-office-classification.json"), "utf8"),
  ) as { office: { points: CanonPoint[] }; lab: { points: CanonPoint[] } };

  it("writes only what 17 September agrees with, and leaves Temp1-Temp3 exactly as they were", async () => {
    const stations: Record<"office" | "lab", bigint> = { office: 0n, lab: 0n };
    for (const which of ["office", "lab"] as const) {
      const site = await testDb.basSite.create({ data: { orgId, projectId, name: `ZZTEST ${which}`, timezone: "America/New_York" } });
      stations[which] = (await testDb.basStation.create({ data: { siteId: site.siteId, niagaraStationName: `ZZTEST_${which}` } })).stationId;
      // As discovery leaves them: every name, unit and type, nothing classified.
      await testDb.basPoint.createMany({
        data: canon[which].points.map((p) => ({
          stationId: stations[which],
          niagaraHistoryName: p.niagaraHistoryName,
          niagaraDisplayName: p.niagaraDisplayName,
          unit: p.unit,
          dataType: p.dataType,
          isActive: p.isActive,
          inactiveReason: p.inactiveReason,
        })),
      });
    }
    await runAutoAssignPass();

    let roles = 0;
    for (const which of ["office", "lab"] as const) {
      const now = new Map(
        [...(await state(stations[which])).entries()].map(([k, v]) => [k.replace(/\$20/g, " "), v]),
      );
      for (const point of canon[which].points) {
        const got = now.get(point.niagaraHistoryName.replace(/\$2d/g, "-").replace(/\$20/g, " "))!;
        expect(got, point.niagaraHistoryName).toBeDefined();
        if (!point.isActive) {
          expect(got, point.niagaraHistoryName).toMatchObject({ role: null, equipment: null, source: null });
          continue;
        }
        // Never a different answer from the person's; silence is allowed.
        if (got.role !== null) {
          expect(got.role, point.niagaraHistoryName).toBe(point.role);
          roles += 1;
        }
        if (got.equipment !== null) {
          expect(equipmentKey(got.equipment), point.niagaraHistoryName).toBe(equipmentKey(point.equipment!));
        }
      }
    }
    // The lab's canon: nobody knows what Temp1-Temp3 measure, and the pass
    // says nothing about them; points_RoomT's bare RoomT is silence too.
    const lab = await state(stations.lab);
    for (const name of ["Temp1", "Temp2", "Temp3", "points_RoomT"]) {
      expect(lab.get(name), name).toMatchObject({ role: null, equipment: null, source: null });
    }
    // The office: the ten zone temperatures on their boxes and seven RTU
    // points by phrase - the same seventeen "Apply all" applied by hand.
    expect(roles).toBe(17);
  }, 120_000);
});

describe("Run assignment now", () => {
  it("is the same pass, audited with the person who pressed it, every press", async () => {
    const first = await runNow();
    expect(first).toMatchObject({ outcome: "assigned", pointsAssigned: 334, roleAssigned: 327, needDecision: 7 });
    expect(describeAssignmentResult(first)).toBe(
      "Gave a role to 327 points, attached 334 points to equipment, created 157 pieces of equipment. 7 points need a decision.",
    );
    const rows = await audits("bas.point_auto_assigned");
    expect(rows).toHaveLength(334);
    expect(rows.every((r) => r.actorEmployeeId === employeeId && (r.metadata as { trigger: string }).trigger === "run_now")).toBe(true);

    // Pressed again with nothing new: still one row saying so.
    const second = await runNow();
    expect(second).toMatchObject({ outcome: "no_change", pointsAssigned: 0, needDecision: 7 });
    expect(describeAssignmentResult(second)).toBe(
      "Nothing new to assign: no high-confidence suggestion for the 7 points left. 7 points need a decision.",
    );
    const summaries = await audits("bas.auto_assignment_ran");
    expect(summaries.map((r) => [(r.metadata as { outcome: string }).outcome, r.actorEmployeeId])).toEqual([
      ["assigned", employeeId],
      ["no_change", employeeId],
    ]);
    expect(await audits("bas.point_auto_assigned")).toHaveLength(334);
  }, 120_000);

  it("shows the counts on Settings -> General", async () => {
    expect(await stationOnTree()).toMatchObject({ autoAssigned: 0, needDecision: 334 });
    await runNow();
    const station = await stationOnTree();
    expect(station).toMatchObject({ autoAssigned: 334, needDecision: 7 });
    expect(describeAssignmentCounts(station)).toBe("334 auto-assigned · 7 need a decision");
  }, 120_000);

  it("refuses a station outside the viewer's reach, and anyone who is not a module admin, as not found", async () => {
    const response = await runNowRoute(new Request("http://localhost", { method: "POST" }), stationParams(987654321n));
    expect(response.status).toBe(404);

    const reader = await createEmployee();
    await grantModule(reader.id, BAS_MODULE_KEY);
    signedInAs(reader.entraOid!);
    const refused = await runNowRoute(new Request("http://localhost", { method: "POST" }), stationParams());
    // Settings routes answer a non-admin as not found, like every other one.
    expect(refused.status).toBe(404);
    expect(await testDb.basEquipment.count()).toBe(0);
    expect(await testDb.auditEvent.count({ where: { action: { startsWith: "bas." } } })).toBe(0);
  });
});

describe("a unit another station's points are on is left for a person", () => {
  it("assigns the role but does not attach to the other JACE's V4_22", async () => {
    await runAutoAssignPass();
    const second = (await testDb.basStation.create({ data: { siteId, niagaraStationName: "CEI_SECOND_JACE" } })).stationId;
    await testDb.basPoint.create({ data: { stationId: second, niagaraHistoryName: escape("V4_22/SpaceTemp") } });

    await runAutoAssignPass();
    expect((await state(second)).get("V4_22/SpaceTemp")).toMatchObject({ role: "zone_temp", equipment: null, source: "auto" });
  }, 120_000);
});

describe("the report's Point Inventory names the role-less points", () => {
  it("says how many, on which station, and what was still checked", () => {
    expect(unroledLine({ stationName: "CEI_JCI_N2", count: 7 })).toBe(
      "7 points on CEI_JCI_N2 have no role, so their values were not judged; Data Health still checked that they were reporting.",
    );
    expect(unroledLine({ stationName: "PHBoffice", count: 1 })).toBe(
      "1 point on PHBoffice has no role, so its value was not judged; Data Health still checked that it was reporting.",
    );
    const doc = reportDocument();
    const html = renderReportHtml({ ...doc, inventory: { ...doc.inventory, unroled: [{ stationName: "CEI_JCI_N2", count: 7 }] } });
    expect(html).toContain("7 points on CEI_JCI_N2 have no role");
    // A document stored before the line existed renders without it.
    expect(renderReportHtml(doc)).not.toContain("have no role");
  });
});
