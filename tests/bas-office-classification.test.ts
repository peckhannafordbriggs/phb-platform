import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import type { Viewer } from "@/lib/authz";
import { requireModuleAdmin } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { getCollectionHealth } from "@/lib/modules/bas/service";
import { planSuggestionBatches } from "@/lib/modules/bas/suggestions";
import type { SettingsPoint, StationPointsList } from "@/lib/modules/bas/types";
import { NO_POINT_FILTERS, shownPoints } from "@/app/(modules)/bas/settings-points";
import { seedBasVocabularies } from "../prisma/bas-vocabularies";
import { PATCH as patchPoint } from "@/app/api/modules/bas/settings/points/[pointId]/route";
import { POST as bulkRoute } from "@/app/api/modules/bas/settings/points/bulk/route";
import { GET as pointsRoute } from "@/app/api/modules/bas/settings/stations/[stationId]/points/route";
import { POST as createEquipmentRoute } from "@/app/api/modules/bas/settings/equipment/route";
import { PATCH as patchEquipmentRoute } from "@/app/api/modules/bas/settings/equipment/[equipmentId]/route";
import { GET as equipmentListRoute } from "@/app/api/modules/bas/settings/buildings/[siteId]/equipment/route";
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
 * THE ACCEPTANCE TEST FOR B8.5.
 *
 * On 17 September 2026 the office JACE - 26 active points - was classified by
 * hand in SQL, so that this feature would have a known-correct answer to be
 * measured against. `tests/fixtures/bas-office-classification.json` is that
 * answer, read from the live database on 1 October 2026: every point's role,
 * equipment, label, and every piece of equipment's type, parent and notes.
 *
 * This test seeds a station with the office's real 32 point names (26 active,
 * 6 deliberately not collected), all unclassified, and performs the whole
 * classification THROUGH THE ROUTES THE UI CALLS - no service call, no SQL:
 *
 *   1. read the list, which carries the name-pattern suggestions, and prove
 *      the read wrote nothing;
 *   2. accept every suggestion the way the "Apply all" button does - the same
 *      plan (planSuggestionBatches), executed through the same routes - which
 *      creates the ten VAVs and classifies 17 points;
 *   3. create the RTU, then put every VAV under it with its rooms in notes -
 *      the edit-after-creation the prompt said must be possible;
 *   4. select every collected point with no equipment the way the filters
 *      do, and attach the selection to the RTU in ONE bulk request;
 *   5. assign the three roles no pattern was confident about, one PATCH each;
 *   6. set the two labels through the B8.4 PATCH.
 *
 * Then it asserts the end state equals the fixture, row for row. If the
 * routes cannot reproduce something that was done in SQL, that is a missing
 * feature, and the test is not the thing to relax.
 *
 * The lab station rides along for the canon: `Temp1`-`Temp3` carry no
 * suggestion, and "Apply all" over the lab changes nothing. A suggestion
 * engine that guessed, or a read that applied what it computed, fails here.
 */

interface FixturePoint {
  niagaraHistoryName: string;
  niagaraDisplayName: string | null;
  unit: string | null;
  dataType: string;
  isActive: boolean;
  inactiveReason: string | null;
  role: string | null;
  equipment: string | null;
  label: string | null;
}
interface FixtureEquipment {
  name: string;
  equipType: string;
  parent: string | null;
  notes: string | null;
}
interface Fixture {
  office: { equipment: FixtureEquipment[]; points: FixturePoint[] };
  lab: { points: FixturePoint[] };
}

const authMock = vi.mocked(auth);

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

let fixture: Fixture;
let viewer: Viewer;
let orgId: bigint;
let projectId: bigint;
let officeSiteId: bigint;
let officeStationId: bigint;
let labSiteId: bigint;
let labStationId: bigint;

const json = (body: unknown, method: string) =>
  new Request("http://localhost/api/modules/bas/settings", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function data<T>(pending: Response | Promise<Response>): Promise<T> {
  const response = await pending;
  const body = (await response.json()) as { data?: T; error?: { code: string; message: string } };
  if (body.error !== undefined) {
    throw new Error(`${response.status} ${body.error.code}: ${body.error.message}`);
  }
  return body.data as T;
}

const readPoints = (stationId: bigint) =>
  data<StationPointsList>(
    pointsRoute(new Request("http://localhost"), {
      params: Promise.resolve({ stationId: stationId.toString() }),
    }),
  );
const patch = (pointId: string, body: unknown) =>
  data<unknown>(patchPoint(json(body, "PATCH"), { params: Promise.resolve({ pointId }) }));
const bulk = (body: { pointIds: string[]; role?: string | null; equipmentId?: string | null }) =>
  data<{ points: number; roleChanged: number; equipmentChanged: number; unchanged: number }>(
    bulkRoute(json(body, "POST")),
  );
const createEquipment = (body: Record<string, unknown>) =>
  data<{ equipmentId: string }>(createEquipmentRoute(json(body, "POST")));
const patchEquipment = (equipmentId: string, body: Record<string, unknown>) =>
  data<{ changed: boolean }>(
    patchEquipmentRoute(json(body, "PATCH"), { params: Promise.resolve({ equipmentId }) }),
  );
const listEquipment = (siteId: bigint) =>
  data<{ equipment: Array<{ equipmentId: string; name: string }> }>(
    equipmentListRoute(new Request("http://localhost"), {
      params: Promise.resolve({ siteId: siteId.toString() }),
    }),
  );

/** The classification columns of every point on a station, by key. */
async function classificationOf(stationId: bigint) {
  const rows = await testDb.$queryRaw<
    Array<{
      niagara_history_name: string;
      point_role: string | null;
      equipment: string | null;
      equip_type: string | null;
      parent: string | null;
      notes: string | null;
      label: string | null;
      is_active: boolean;
      inactive_reason: string | null;
    }>
  >`
    SELECT p.niagara_history_name, p.point_role, e.name AS equipment, e.equip_type,
           pe.name AS parent, e.notes, p.label, p.is_active, p.inactive_reason
      FROM bas_points p
      LEFT JOIN bas_equipment e ON e.equipment_id = p.equipment_id
      LEFT JOIN bas_equipment pe ON pe.equipment_id = e.parent_equipment_id
     WHERE p.station_id = ${stationId}
     ORDER BY p.niagara_history_name`;
  return rows;
}

async function seedStation(siteId: bigint, name: string, points: FixturePoint[]): Promise<bigint> {
  const station = await testDb.basStation.create({
    data: { siteId, niagaraStationName: name },
  });
  for (const p of points) {
    await testDb.basPoint.create({
      data: {
        stationId: station.stationId,
        niagaraHistoryName: p.niagaraHistoryName,
        niagaraDisplayName: p.niagaraDisplayName,
        unit: p.unit,
        dataType: p.dataType,
        isActive: p.isActive,
        inactiveReason: p.inactiveReason,
        // Everything a person set is left unset: this is the "before".
        pointRole: null,
        equipmentId: null,
        label: null,
      },
    });
  }
  return station.stationId;
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetBasAvailabilityCache();

  fixture = JSON.parse(
    await readFile(path.join(process.cwd(), "tests/fixtures/bas-office-classification.json"), "utf8"),
  ) as Fixture;

  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();
  await expectBasTablesEmpty();
  // The REAL vocabulary, as the seed installs it: the classification uses
  // real role keys and real equipment types, so it has to be this one.
  await seedBasVocabularies(testDb);

  const org = await testDb.basOrg.create({ data: { name: "ZZTEST_ORG" } });
  orgId = org.orgId;
  const project = await testDb.basProject.create({ data: { orgId, name: "ZZTEST_PHB" } });
  projectId = project.projectId;
  officeSiteId = (
    await testDb.basSite.create({
      data: { orgId, projectId, name: "ZZTEST Steel Place", timezone: "America/New_York" },
    })
  ).siteId;
  labSiteId = (
    await testDb.basSite.create({
      data: { orgId, projectId, name: "ZZTEST Spring Grove", timezone: "America/New_York" },
    })
  ).siteId;
  officeStationId = await seedStation(officeSiteId, "PHBoffice", fixture.office.points);
  labStationId = await seedStation(labSiteId, "SpringGroveLabComputer", fixture.lab.points);

  const employee = await createEmployee();
  await grantModule(employee.id, BAS_MODULE_KEY);
  await grantModuleAdmin(employee.id, BAS_MODULE_KEY);
  signedInAs(employee.entraOid!);
  const access = await requireModuleAdmin(BAS_MODULE_KEY);
  if (!access.ok) throw new Error(`expected access, got ${access.denial}`);
  viewer = access.viewer;
});

afterEach(async () => {
  await testDb.basPoint.deleteMany({ where: { stationId: { in: [officeStationId, labStationId] } } });
  await testDb.basEquipment.updateMany({
    where: { siteId: { in: [officeSiteId, labSiteId] } },
    data: { parentEquipmentId: null },
  });
  await testDb.basEquipment.deleteMany({ where: { siteId: { in: [officeSiteId, labSiteId] } } });
  await testDb.basStation.deleteMany({ where: { stationId: { in: [officeStationId, labStationId] } } });
  await testDb.basSite.deleteMany({ where: { siteId: { in: [officeSiteId, labSiteId] } } });
  await testDb.basProject.delete({ where: { projectId } });
  await testDb.basOrg.delete({ where: { orgId } });
  // The vocabulary is reference data; the test database starts without it.
  await testDb.$executeRaw`UPDATE bas_point_roles SET setpoint_for = NULL, status_of = NULL`;
  await testDb.basPointRole.deleteMany();
  await testDb.basEquipmentType.deleteMany();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDb();
});

/** The office points a name pattern is expected to be confident about. */
const SUGGESTED_OFFICE_NAMES = [
  "VAV$2d1$20130$2d132_ZoneTemperature",
  "VAV$2d10$20107_ZoneTemperature",
  "VAV$2d2$20122$2d125_ZoneTemperature",
  "VAV$2d3$20120$2d121_ZoneTemperature",
  "VAV$2d4$20114$2d115_ZoneTemperature",
  "VAV$2d5$20117$2d118_ZoneTemperature",
  "VAV$2d6$20113_ZoneTemperature",
  "VAV$2d7$20111$2d112_ZoneTemperature",
  "VAV$2d8$20104$2d105_ZoneTemperature",
  "VAV$2d9$20106_ZoneTemperature",
  "Outside_Air_Temp_Analog_Input1",
  "Outside_Air_Damper_Analog_Output1",
  "Return$20Air$20Damper",
  "RV_Supply_Fan_Speed_Analog_Output",
  "Supply_Duct_Static_Pressure_Analog_Input",
  "Supply_Duct_Static_Pressure_Setpoint",
  "OccupancyCommand",
].sort();

/**
 * What "Apply all N suggestions" does, as the component does it: create each
 * named piece of equipment once, then one bulk request per batch.
 */
async function applyAllSuggestions(list: StationPointsList) {
  const plan = planSuggestionBatches(list.points);
  const created = new Map<string, string>();
  if (list.siteId !== null) {
    for (const item of plan.create) {
      const { equipmentId } = await createEquipment({
        siteId: list.siteId,
        name: item.name,
        equipType: item.equipType,
      });
      created.set(item.name.toLowerCase(), equipmentId);
    }
  }
  const totals = { points: 0, roleChanged: 0, equipmentChanged: 0, unchanged: 0 };
  for (const batch of plan.batches) {
    const equipmentId =
      batch.equipmentId ??
      (batch.equipmentName === null ? null : (created.get(batch.equipmentName.toLowerCase()) ?? null));
    const body: { pointIds: string[]; role?: string | null; equipmentId?: string | null } = {
      pointIds: batch.pointIds,
    };
    if (batch.role !== null) body.role = batch.role;
    if (equipmentId !== null) body.equipmentId = equipmentId;
    if (body.role === undefined && body.equipmentId === undefined) continue;
    const result = await bulk(body);
    totals.points += result.points;
    totals.roleChanged += result.roleChanged;
    totals.equipmentChanged += result.equipmentChanged;
    totals.unchanged += result.unchanged;
  }
  return { plan, totals };
}

describe("the office JACE, classified through the routes the UI calls", () => {
  it("starts from the fixture's 32 names, 26 collected, none classified", async () => {
    const rows = await classificationOf(officeStationId);
    expect(rows).toHaveLength(32);
    expect(rows.filter((r) => r.is_active)).toHaveLength(26);
    expect(rows.every((r) => r.point_role === null && r.equipment === null && r.label === null)).toBe(true);
    // And the fixture itself says what live holds: 20 roles, 26 attached, 11 equipment.
    expect(fixture.office.points.filter((p) => p.role !== null)).toHaveLength(20);
    expect(fixture.office.points.filter((p) => p.equipment !== null)).toHaveLength(26);
    expect(fixture.office.equipment).toHaveLength(11);
  });

  it("reproduces the live classification row for row", async () => {
    // 1. Read. The read carries suggestions and writes nothing.
    const before = await classificationOf(officeStationId);
    const list = await readPoints(officeStationId);
    expect(list.siteId).toBe(officeSiteId.toString());
    expect(list.pointsAccountedFor).toEqual({ rendered: 32, inDatabase: 32 });
    expect(await classificationOf(officeStationId)).toEqual(before);
    expect(await testDb.auditEvent.count({ where: { action: { startsWith: "bas." } } })).toBe(0);

    const suggested = list.points.filter((p) => p.suggestion !== null);
    expect(suggested.map((p) => p.niagaraHistoryName).sort()).toEqual(SUGGESTED_OFFICE_NAMES);
    for (const p of suggested) {
      const expected = fixture.office.points.find((f) => f.niagaraHistoryName === p.niagaraHistoryName)!;
      // A suggestion is only ever what a person later confirmed in SQL.
      expect(p.suggestion!.role, p.niagaraHistoryName).toBe(expected.role);
      if (p.suggestion!.equipmentName !== null) {
        expect(p.suggestion!.equipmentName).toBe(expected.equipment);
        expect(p.suggestion!.equipmentId).toBeNull(); // none exists yet
        expect(p.suggestion!.equipType).toBe("vav");
      }
    }
    // The six state points, the retired _cfg0 halves, the system logs and
    // Supply_Temp (no "Air" in its name) are left to a person.
    for (const name of ["OpState", "OperatingState", "OperatingStateOR", "System_Enable", "Unit$20Status", "Unit_Status_Mode", "Supply_Temp_Analog_Input", "Temperature_Setpoint", "Occupied", "RV_Supply_Fan_Speed_Analog_Output_cfg0", "AuditHistory", "Global_Alarm"]) {
      expect(list.points.find((p) => p.niagaraHistoryName === name)!.suggestion, name).toBeNull();
    }

    // 2. Apply all suggestions, as the button does.
    const { plan, totals } = await applyAllSuggestions(list);
    expect(plan.create.map((c) => c.name).sort()).toEqual(
      fixture.office.equipment.filter((e) => e.equipType === "vav").map((e) => e.name).sort(),
    );
    expect(totals).toEqual({ points: 17, roleChanged: 17, equipmentChanged: 10, unchanged: 0 });

    // 3. The RTU, then every VAV under it with its rooms in notes.
    const rtu = fixture.office.equipment.find((e) => e.parent === null)!;
    const { equipmentId: rtuId } = await createEquipment({
      siteId: officeSiteId.toString(),
      name: rtu.name,
      equipType: rtu.equipType,
      notes: rtu.notes,
    });
    const equipment = (await listEquipment(officeSiteId)).equipment;
    for (const vav of fixture.office.equipment.filter((e) => e.parent !== null)) {
      const row = equipment.find((e) => e.name === vav.name)!;
      expect(row, vav.name).toBeDefined();
      expect(await patchEquipment(row.equipmentId, { parentEquipmentId: rtuId, notes: vav.notes })).toEqual({ changed: true });
    }

    // 4. Everything collected and still unattached goes on the RTU, in one
    //    bulk request, selected the way the filters select.
    const afterSuggestions = await readPoints(officeStationId);
    const unattached = shownPoints(afterSuggestions.points, "", { ...NO_POINT_FILTERS, equipment: "none", collected: "yes" });
    expect(unattached).toHaveLength(16);
    expect(await bulk({ pointIds: unattached.map((p) => p.pointId), equipmentId: rtuId })).toEqual({
      points: 16, roleChanged: 0, equipmentChanged: 16, unchanged: 0,
    });

    // 5. The roles no pattern was confident about, one at a time.
    const byHand = fixture.office.points.filter(
      (f) => f.role !== null && !SUGGESTED_OFFICE_NAMES.includes(f.niagaraHistoryName),
    );
    expect(byHand.map((f) => f.niagaraHistoryName).sort()).toEqual(
      ["Occupied", "Supply_Temp_Analog_Input", "Temperature_Setpoint"].sort(),
    );
    for (const f of byHand) {
      const point = afterSuggestions.points.find((p) => p.niagaraHistoryName === f.niagaraHistoryName)!;
      await patch(point.pointId, { role: f.role });
    }

    // 6. The two labels (B8.4's route).
    for (const f of fixture.office.points.filter((p) => p.label !== null)) {
      const point = afterSuggestions.points.find((p) => p.niagaraHistoryName === f.niagaraHistoryName)!;
      await patch(point.pointId, { label: f.label });
    }

    // THE ASSERTION. Row for row against what live holds.
    const byName = <T extends { niagara_history_name: string }>(rows: T[]) =>
      [...rows].sort((a, b) => a.niagara_history_name.localeCompare(b.niagara_history_name));
    const end = byName(await classificationOf(officeStationId));
    const expected = fixture.office.points
      .map((f) => {
        const eq = f.equipment === null ? null : fixture.office.equipment.find((e) => e.name === f.equipment)!;
        return {
          niagara_history_name: f.niagaraHistoryName,
          point_role: f.role,
          equipment: f.equipment,
          equip_type: eq?.equipType ?? null,
          parent: eq?.parent ?? null,
          notes: eq?.notes ?? null,
          label: f.label,
          is_active: f.isActive,
          inactive_reason: f.inactiveReason,
        };
      })
      .sort((a, b) => a.niagara_history_name.localeCompare(b.niagara_history_name));
    expect(end).toEqual(expected);

    const equipmentEnd = await testDb.$queryRaw<FixtureEquipment[]>`
      SELECT e.name, e.equip_type AS "equipType", pe.name AS parent, e.notes
        FROM bas_equipment e LEFT JOIN bas_equipment pe ON pe.equipment_id = e.parent_equipment_id
       WHERE e.site_id = ${officeSiteId} ORDER BY e.name`;
    expect(equipmentEnd).toEqual([...fixture.office.equipment].sort((a, b) => a.name.localeCompare(b.name)));

    // What the rest of the module now sees, without anything restarting.
    const health = await getCollectionHealth(viewer, { siteId: officeSiteId });
    expect(health.totals.unclassifiedPoints).toBe(
      fixture.office.points.filter((p) => p.isActive && p.role === null).length,
    );
    expect(health.totals.unclassifiedPoints).toBe(6);
    const pairs = await testDb.$queryRaw<Array<{ measured_role: string; setpoint_role: string }>>`
      SELECT measured_role, setpoint_role FROM bas_v_setpoint_pair WHERE site_id = ${officeSiteId} ORDER BY 1`;
    expect(pairs).toEqual([
      { measured_role: "duct_static_pressure", setpoint_role: "duct_static_pressure_sp" },
      { measured_role: "supply_air_temp", setpoint_role: "supply_air_temp_sp" },
    ]);

    // Every change is a row with a previous and a new value.
    const audit = await testDb.auditEvent.groupBy({ by: ["action"], _count: { _all: true }, where: { action: { startsWith: "bas." } } });
    const counts = Object.fromEntries(audit.map((a) => [a.action, a._count._all]));
    expect(counts).toEqual({
      "bas.point_role_changed": 20,
      "bas.point_equipment_changed": 26,
      "bas.point_label_changed": 2,
      "bas.equipment_created": 11,
      "bas.equipment_updated": 10,
    });
    const bulkRows = await testDb.auditEvent.count({
      where: { action: "bas.point_equipment_changed", metadata: { path: ["viaBulk"], equals: true } },
    });
    expect(bulkRows).toBe(26); // 10 via suggestions, 16 via the RTU selection

    // Once more: a read after all this still writes nothing, and now has
    // nothing left to suggest.
    const final = await readPoints(officeStationId);
    expect(final.points.every((p) => p.suggestion === null)).toBe(true);
    expect(byName(await classificationOf(officeStationId))).toEqual(end);
  });
});

describe("the lab station - Temp1 to Temp3 are the canon", () => {
  it("offers no suggestion for any lab point, and 'Apply all' changes nothing", async () => {
    const before = await classificationOf(labStationId);
    const list = await readPoints(labStationId);
    expect(list.points).toHaveLength(7);
    for (const p of list.points) {
      expect(p.suggestion, p.niagaraHistoryName).toBeNull();
      expect(p.pointRole, p.niagaraHistoryName).toBeNull();
    }

    const { plan, totals } = await applyAllSuggestions(list);
    expect(plan.create).toEqual([]);
    expect(plan.batches).toEqual([]);
    expect(totals).toEqual({ points: 0, roleChanged: 0, equipmentChanged: 0, unchanged: 0 });

    // Exactly as unclassified as they started. A suggestion engine that
    // guessed at "Temp", or a read that applied what it computed, fails here.
    const after = await classificationOf(labStationId);
    expect(after).toEqual(before);
    for (const name of ["Temp1", "Temp2", "Temp3"]) {
      const row = after.find((r) => r.niagara_history_name === name)!;
      expect(row.point_role).toBeNull();
      expect(row.equipment).toBeNull();
    }
    expect(await testDb.auditEvent.count({ where: { action: { startsWith: "bas." } } })).toBe(0);
  });

  it("still lets a person classify points_RoomT by hand, which is what live did", async () => {
    const list = await readPoints(labStationId);
    const roomT = list.points.find((p) => p.niagaraHistoryName === "points_RoomT")!;
    const live = fixture.lab.points.find((p) => p.niagaraHistoryName === "points_RoomT")!;
    expect(live.role).toBe("zone_temp");
    await patch(roomT.pointId, { role: live.role });
    const after = await classificationOf(labStationId);
    expect(after.find((r) => r.niagara_history_name === "points_RoomT")!.point_role).toBe("zone_temp");
    for (const name of ["Temp1", "Temp2", "Temp3"]) {
      expect(after.find((r) => r.niagara_history_name === name)!.point_role).toBeNull();
    }
  });
});

// Keeps the SettingsPoint import honest for the type-level claim below.
const _typeCheck: (p: SettingsPoint) => string | null = (p) => p.suggestion?.role ?? null;
void _typeCheck;
