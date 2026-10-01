import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Only the session is mocked, and the Analyze catalogue's cache reset is
// spied on. The guard, the wrapper, the Zod schemas, the services, the real
// SQL and the views all run against the test database: the claims below are
// about what the database holds after a request, and a mock would only agree
// with itself.
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/modules/bas/analyze/schema-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/modules/bas/analyze/schema-context")>();
  return { ...actual, resetSchemaContextCache: vi.fn(actual.resetSchemaContextCache) };
});
// settings-view.tsx is a client component whose top-level hooks need a router.
vi.mock("next/navigation", () => ({
  usePathname: () => "/bas/settings",
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
  useSearchParams: () => new URLSearchParams(""),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { auth } from "@/auth";
import type { Viewer } from "@/lib/authz";
import { requireModuleAdmin } from "@/lib/authz";
import { describeAuditEvent } from "@/lib/admin/audit-describe";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { resetSchemaContextCache } from "@/lib/modules/bas/analyze/schema-context";
import { getCollectionHealth, getDashboard } from "@/lib/modules/bas/service";
import { getStationPoints } from "@/lib/modules/bas/settings-service";
import {
  REVIEWED_UNMAPPABLE_ROLE,
  groupRoles,
  type PointRoleOption,
  type PointSuggestion,
  type SettingsPoint,
} from "@/lib/modules/bas/types";
import {
  SUGGESTION_PATTERNS,
  decodeNiagaraName,
  planSuggestionBatches,
  suggestClassification,
  type RoleFacts,
} from "@/lib/modules/bas/suggestions";
import {
  bulkClassifySchema,
  createEquipmentSchema,
  updateEquipmentSchema,
  updatePointSchema,
} from "@/lib/validation/bas-settings";
import { BAS_POINT_ROLES } from "../prisma/bas-vocabularies";
import { PointsTable } from "@/app/(modules)/bas/settings-view";
import {
  NO_POINT_FILTERS,
  describeBulkPlan,
  pointMatchesFilters,
  shownPoints,
} from "@/app/(modules)/bas/settings-points";
import {
  ROLE_RIPPLE_NOTE,
  describeBulkResult,
  describeSuggestion,
} from "@/app/(modules)/bas/health-client";
import { PATCH as patchPoint } from "@/app/api/modules/bas/settings/points/[pointId]/route";
import { POST as bulkRoute } from "@/app/api/modules/bas/settings/points/bulk/route";
import { POST as createEquipmentRoute } from "@/app/api/modules/bas/settings/equipment/route";
import {
  DELETE as deleteEquipmentRoute,
  PATCH as patchEquipmentRoute,
} from "@/app/api/modules/bas/settings/equipment/[equipmentId]/route";
import { GET as equipmentListRoute } from "@/app/api/modules/bas/settings/buildings/[siteId]/equipment/route";
import { GET as vocabulariesRoute } from "@/app/api/modules/bas/settings/vocabularies/route";
import {
  EQUIPMENT_NAME,
  ROLES,
  createHealthFixture,
  expectBasTablesEmpty,
  type HealthFixture,
} from "./bas-fixture";
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
 * Roles and equipment through the API (B8.5), and the three things the
 * prompt said must be mutation-checked:
 *
 *   - a suggestion is NEVER written by anything but a click: reading the
 *     list and rendering it changes no row and writes no audit row;
 *   - a bulk change writes inside the selection and nowhere else, and a
 *     selection with one bad id writes nothing at all;
 *   - the role PATCH is as strict as the label PATCH: an unknown key is 422.
 *
 * Plus the ripple the prompt said to check rather than assume: a role is
 * what the pairing views and the unclassified count judge a point by, so
 * assigning one brings a point INTO those verdicts and clearing it takes it
 * out - asserted against the real views, not a description of them.
 *
 * The health fixture is used because it carries two buildings (so "equipment
 * on another building" is a real refusal), four zztest roles with a
 * setpoint_for and a status_of link (so the pair views have something to
 * pair), and one unclassified point on each building.
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

let fixture: HealthFixture;
let viewer: Viewer;

async function adminViewer(): Promise<Viewer> {
  const employee = await createEmployee();
  await grantModule(employee.id, BAS_MODULE_KEY);
  await grantModuleAdmin(employee.id, BAS_MODULE_KEY);
  signedInAs(employee.entraOid!);
  const access = await requireModuleAdmin(BAS_MODULE_KEY);
  if (!access.ok) throw new Error(`expected access, got ${access.denial}`);
  return access.viewer;
}

async function signInAsPlainBasUser() {
  const employee = await createEmployee();
  await grantModule(employee.id, BAS_MODULE_KEY);
  signedInAs(employee.entraOid!);
}

const json = (body: unknown, method: string) =>
  new Request("http://localhost/api/modules/bas/settings", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const patch = (pointId: string, body: unknown) =>
  patchPoint(json(body, "PATCH"), { params: Promise.resolve({ pointId }) });
const bulk = (body: unknown) => bulkRoute(json(body, "POST"));
const createEquipment = (body: unknown) => createEquipmentRoute(json(body, "POST"));
const patchEquipment = (equipmentId: string, body: unknown) =>
  patchEquipmentRoute(json(body, "PATCH"), { params: Promise.resolve({ equipmentId }) });
const deleteEquipment = (equipmentId: string) =>
  deleteEquipmentRoute(new Request("http://localhost", { method: "DELETE" }), {
    params: Promise.resolve({ equipmentId }),
  });
const listEquipment = (siteId: string) =>
  equipmentListRoute(new Request("http://localhost"), { params: Promise.resolve({ siteId }) });

async function payload(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}
async function data<T>(response: Response): Promise<T> {
  return (await payload(response)).data as T;
}
async function errorCode(response: Response): Promise<string | undefined> {
  return ((await payload(response)).error as { code?: string } | undefined)?.code;
}

/** Every column a classification must and must not move. */
async function row(pointId: bigint) {
  return testDb.basPoint.findUniqueOrThrow({
    where: { pointId },
    select: {
      pointRole: true,
      equipmentId: true,
      label: true,
      niagaraHistoryName: true,
      niagaraDisplayName: true,
      isActive: true,
      isVisible: true,
      inactiveReason: true,
    },
  });
}

/** All classification columns on every point, for "nothing else moved". */
async function snapshot() {
  return testDb.basPoint.findMany({
    orderBy: { pointId: "asc" },
    select: { pointId: true, pointRole: true, equipmentId: true, label: true, isActive: true, isVisible: true },
  });
}

const classificationAudit = () =>
  testDb.auditEvent.findMany({
    where: { action: { in: ["bas.point_role_changed", "bas.point_equipment_changed"] } },
    orderBy: { occurredAt: "asc" },
  });

const setpointPairs = () =>
  testDb.$queryRaw<Array<{ measured_point_id: bigint; setpoint_point_id: bigint }>>`
    SELECT measured_point_id, setpoint_point_id FROM bas_v_setpoint_pair
     WHERE site_id IN (${fixture.siteId}, ${fixture.siteBId})`;
const commandStatusPairs = () =>
  testDb.$queryRaw<Array<{ command_point_id: bigint; status_point_id: bigint }>>`
    SELECT command_point_id, status_point_id FROM bas_v_command_status_pair
     WHERE site_id IN (${fixture.siteId}, ${fixture.siteBId})`;

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
  viewer = await adminViewer();
});

afterEach(async () => {
  // Equipment these tests created on either building, and any point moved
  // onto it: the fixture's own cleanup knows only its one AHU.
  const sites = [fixture.siteId, fixture.siteBId];
  await testDb.basPoint.updateMany({
    where: { station: { siteId: { in: sites } }, equipmentId: { not: fixture.equipmentId } },
    data: { equipmentId: fixture.equipmentId },
  });
  await testDb.basEquipment.updateMany({
    where: { siteId: { in: sites } },
    data: { parentEquipmentId: null },
  });
  await testDb.basEquipment.deleteMany({
    where: { siteId: { in: sites }, equipmentId: { not: fixture.equipmentId } },
  });
  await fixture.cleanup();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDb();
});

// ---------------------------------------------------------------------------
// 1. The payloads are closed.
// ---------------------------------------------------------------------------

describe("the single-point PATCH schema", () => {
  it("accepts exactly one of visible, label, role or equipmentId", () => {
    expect(updatePointSchema.safeParse({ role: "zone_temp" }).success).toBe(true);
    expect(updatePointSchema.safeParse({ role: null }).success).toBe(true);
    expect(updatePointSchema.safeParse({ equipmentId: "12" }).success).toBe(true);
    expect(updatePointSchema.safeParse({ equipmentId: null }).success).toBe(true);
    expect(updatePointSchema.safeParse({ role: "zone_temp", equipmentId: "12" }).success).toBe(false);
    expect(updatePointSchema.safeParse({ role: "zone_temp", visible: true }).success).toBe(false);
    expect(updatePointSchema.safeParse({}).success).toBe(false);
  });

  it("refuses an unknown key beside role - the mutation target", () => {
    // Dropping .strict() from the schema turns this green on the first line
    // and is the mutation the prompt asked for. The second line is the key
    // the strictness exists to keep out.
    expect(updatePointSchema.safeParse({ role: "zone_temp", foo: 1 }).success).toBe(false);
    expect(updatePointSchema.safeParse({ role: "zone_temp", isActive: false }).success).toBe(false);
    expect(updatePointSchema.safeParse({ isActive: false }).success).toBe(false);
    expect(updatePointSchema.safeParse({ niagaraHistoryName: "x" }).success).toBe(false);
  });

  it("takes a role key in the vocabulary's spelling only", () => {
    expect(updatePointSchema.safeParse({ role: "Zone Temp" }).success).toBe(false);
    expect(updatePointSchema.safeParse({ role: "" }).success).toBe(false);
    expect(updatePointSchema.safeParse({ equipmentId: "abc" }).success).toBe(false);
  });
});

describe("the bulk schema", () => {
  it("needs a selection and at least one field, and nothing else", () => {
    expect(bulkClassifySchema.safeParse({ pointIds: ["1", "2"], role: "zone_temp" }).success).toBe(true);
    expect(bulkClassifySchema.safeParse({ pointIds: ["1"], equipmentId: null }).success).toBe(true);
    expect(bulkClassifySchema.safeParse({ pointIds: ["1"], role: null, equipmentId: "3" }).success).toBe(true);
    expect(bulkClassifySchema.safeParse({ pointIds: ["1"] }).success).toBe(false);
    expect(bulkClassifySchema.safeParse({ pointIds: [], role: "zone_temp" }).success).toBe(false);
    expect(bulkClassifySchema.safeParse({ pointIds: ["1", "1"], role: "zone_temp" }).success).toBe(false);
    expect(bulkClassifySchema.safeParse({ pointIds: ["1"], visible: false }).success).toBe(false);
    expect(bulkClassifySchema.safeParse({ pointIds: ["1"], role: "zone_temp", isActive: false }).success).toBe(false);
    const many = Array.from({ length: 501 }, (_, i) => String(i + 1));
    expect(bulkClassifySchema.safeParse({ pointIds: many, role: "zone_temp" }).success).toBe(false);
  });
});

describe("the equipment schemas", () => {
  it("are strict, and the edit refuses an empty change", () => {
    expect(createEquipmentSchema.safeParse({ siteId: "1", name: "RTU-1", equipType: "rtu" }).success).toBe(true);
    expect(createEquipmentSchema.safeParse({ siteId: "1", name: " ", equipType: "rtu" }).success).toBe(false);
    expect(createEquipmentSchema.safeParse({ siteId: "1", name: "RTU-1", equipType: "rtu", extra: 1 }).success).toBe(false);
    expect(updateEquipmentSchema.safeParse({ parentEquipmentId: null }).success).toBe(true);
    expect(updateEquipmentSchema.safeParse({ notes: "Serves 130-132" }).success).toBe(true);
    expect(updateEquipmentSchema.safeParse({}).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. One point, one field, through the route.
// ---------------------------------------------------------------------------

describe("PATCH { role }", () => {
  it("answers 422 to an unknown key beside role, through the route", async () => {
    const response = await patch(fixture.unknown.toString(), { role: ROLES.sat, foo: 1 });
    expect(response.status).toBe(422);
    expect((await row(fixture.unknown)).pointRole).toBeNull();
  });

  it("sets, changes and clears the role, moving one column and writing one audit row each", async () => {
    const before = await row(fixture.unknown);
    expect(before.pointRole).toBeNull();

    const set = await patch(fixture.unknown.toString(), { role: ROLES.sat });
    expect(set.status).toBe(200);
    expect(await data(set)).toEqual({ changed: true, role: ROLES.sat, roleName: "Supply air temperature (test)" });

    const changed = await patch(fixture.unknown.toString(), { role: ROLES.fanCmd });
    expect((await data<{ changed: boolean }>(changed)).changed).toBe(true);

    const again = await patch(fixture.unknown.toString(), { role: ROLES.fanCmd });
    expect((await data<{ changed: boolean }>(again)).changed).toBe(false);

    const cleared = await patch(fixture.unknown.toString(), { role: null });
    expect(await data(cleared)).toEqual({ changed: true, role: null, roleName: null });

    const after = await row(fixture.unknown);
    expect(after).toEqual(before);

    const rows = await classificationAudit();
    expect(rows.map((r) => r.action)).toEqual([
      "bas.point_role_changed",
      "bas.point_role_changed",
      "bas.point_role_changed",
    ]);
    const metas = rows.map((r) => r.metadata as Record<string, unknown>);
    expect(metas[0]).toMatchObject({
      pointId: fixture.unknown.toString(),
      niagaraHistoryName: "AHU$2d1_Unknown",
      previousRole: null,
      role: ROLES.sat,
      viaBulk: false,
      selectionSize: 1,
    });
    expect(metas[1]).toMatchObject({ previousRole: ROLES.sat, role: ROLES.fanCmd });
    expect(metas[2]).toMatchObject({ previousRole: ROLES.fanCmd, role: null });
  });

  it("refuses a role that is not in the vocabulary with 422, and writes nothing", async () => {
    const response = await patch(fixture.unknown.toString(), { role: "no_such_role" });
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("role_not_found");
    expect((await row(fixture.unknown)).pointRole).toBeNull();
    expect(await classificationAudit()).toHaveLength(0);
  });

  it("is 404 for a plain BAS user, like every settings route", async () => {
    await signInAsPlainBasUser();
    const response = await patch(fixture.unknown.toString(), { role: ROLES.sat });
    expect(response.status).toBe(404);
    expect((await row(fixture.unknown)).pointRole).toBeNull();
  });
});

describe("PATCH { equipmentId }", () => {
  let other: bigint;

  beforeEach(async () => {
    other = (
      await testDb.basEquipment.create({
        data: { siteId: fixture.siteId, name: "AHU-ZZTEST-2", equipType: ROLES.equipType },
      })
    ).equipmentId;
  });

  it("moves a point between equipment and detaches it, one audit row each with both names", async () => {
    const moved = await patch(fixture.unknown.toString(), { equipmentId: other.toString() });
    expect(moved.status).toBe(200);
    expect(await data(moved)).toEqual({
      changed: true,
      equipmentId: other.toString(),
      equipmentName: "AHU-ZZTEST-2",
    });
    expect((await row(fixture.unknown)).equipmentId).toBe(other);

    const detached = await patch(fixture.unknown.toString(), { equipmentId: null });
    expect(await data(detached)).toEqual({ changed: true, equipmentId: null, equipmentName: null });
    expect((await row(fixture.unknown)).equipmentId).toBeNull();

    const metas = (await classificationAudit()).map((r) => r.metadata as Record<string, unknown>);
    expect(metas).toHaveLength(2);
    expect(metas[0]).toMatchObject({
      previousEquipmentId: fixture.equipmentId.toString(),
      previousEquipmentName: EQUIPMENT_NAME,
      equipmentId: other.toString(),
      equipmentName: "AHU-ZZTEST-2",
    });
    expect(metas[1]).toMatchObject({ previousEquipmentName: "AHU-ZZTEST-2", equipmentId: null, equipmentName: null });
  });

  it("refuses equipment on a different building with 409 and the equipment's name", async () => {
    const onB = await testDb.basEquipment.create({
      data: { siteId: fixture.siteBId, name: "AHU-B", equipType: ROLES.equipType },
    });
    const response = await patch(fixture.unknown.toString(), { equipmentId: onB.equipmentId.toString() });
    expect(response.status).toBe(409);
    const body = (await payload(response)).error as { code: string; message: string };
    expect(body.code).toBe("equipment_other_building");
    expect(body.message).toContain("AHU-B");
    expect((await row(fixture.unknown)).equipmentId).toBe(fixture.equipmentId);
  });

  it("refuses equipment that does not exist with 404", async () => {
    const response = await patch(fixture.unknown.toString(), { equipmentId: "999999999" });
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("equipment_not_found");
  });

  /**
   * `station_unassigned` cannot be provoked: bas_stations.site_id is NOT NULL
   * at the current schema, so no station is attached to no building. The
   * code path exists because the tree and the Points list both carry the
   * state (`siteId: null`) for the day the column is relaxed, and the refusal
   * is the honest answer then. Recorded in docs/testing-blind-spots.md.
   */
});

// ---------------------------------------------------------------------------
// 3. Bulk: inside the selection, all or nothing.
// ---------------------------------------------------------------------------

describe("POST points/bulk", () => {
  it("writes the role on every selected point and on NO other point - the mutation target", async () => {
    const before = await snapshot();
    const selection = [fixture.sat, fixture.satSp].map((id) => id.toString());

    const response = await bulk({ pointIds: selection, role: ROLES.fanCmd });
    expect(response.status).toBe(200);
    expect(await data(response)).toEqual({ points: 2, roleChanged: 2, equipmentChanged: 0, unchanged: 0 });

    const after = await snapshot();
    for (const [i, point] of after.entries()) {
      if (selection.includes(point.pointId.toString())) {
        expect(point.pointRole).toBe(ROLES.fanCmd);
      } else {
        // A bulk path that applied to the station, or to the filter, or to
        // "all" instead of the selection fails here by point id.
        expect(point, `point ${point.pointId} was outside the selection`).toEqual(before[i]);
      }
    }

    const rows = await classificationAudit();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.metadata).toMatchObject({ viaBulk: true, selectionSize: 2, role: ROLES.fanCmd });
    }
    expect(new Set(rows.map((r) => (r.metadata as { pointId: string }).pointId))).toEqual(new Set(selection));
  });

  it("sets a role and an equipment together, two audit rows per point, counting what already held", async () => {
    const other = await testDb.basEquipment.create({
      data: { siteId: fixture.siteId, name: "AHU-ZZTEST-2", equipType: ROLES.equipType },
    });
    // fanCmd already has the fan command role; the role half is unchanged for it.
    const response = await bulk({
      pointIds: [fixture.fanCmd.toString(), fixture.unknown.toString()],
      role: ROLES.fanCmd,
      equipmentId: other.equipmentId.toString(),
    });
    expect(response.status).toBe(200);
    expect(await data(response)).toEqual({ points: 2, roleChanged: 1, equipmentChanged: 2, unchanged: 0 });
    expect(await classificationAudit()).toHaveLength(3);

    // Sent again: nothing to do, nothing written.
    const again = await bulk({
      pointIds: [fixture.fanCmd.toString(), fixture.unknown.toString()],
      role: ROLES.fanCmd,
      equipmentId: other.equipmentId.toString(),
    });
    expect(await data(again)).toEqual({ points: 2, roleChanged: 0, equipmentChanged: 0, unchanged: 2 });
    expect(await classificationAudit()).toHaveLength(3);
  });

  it("clears with null, and leaves a field alone when the key is absent", async () => {
    await bulk({ pointIds: [fixture.sat.toString()], role: null });
    const after = await row(fixture.sat);
    expect(after.pointRole).toBeNull();
    expect(after.equipmentId).toBe(fixture.equipmentId); // not sent, not touched
  });

  it("writes NOTHING when one id in the selection is not a point", async () => {
    const before = await snapshot();
    const response = await bulk({
      pointIds: [fixture.sat.toString(), fixture.satSp.toString(), "999999999"],
      role: ROLES.fanCmd,
    });
    expect(response.status).toBe(404);
    const body = (await payload(response)).error as { code: string; message: string };
    expect(body.code).toBe("point_not_found");
    expect(body.message).toContain("1 of the 3");
    expect(await snapshot()).toEqual(before);
    expect(await classificationAudit()).toHaveLength(0);
  });

  it("writes NOTHING when the equipment is on another building than some of the points", async () => {
    const onB = await testDb.basEquipment.create({
      data: { siteId: fixture.siteBId, name: "AHU-B", equipType: ROLES.equipType },
    });
    const before = await snapshot();
    const response = await bulk({
      pointIds: [fixture.sat.toString(), fixture.bOk.toString()],
      role: ROLES.fanCmd,
      equipmentId: onB.equipmentId.toString(),
    });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("equipment_other_building");
    // The role half was valid for both points and was still not applied.
    expect(await snapshot()).toEqual(before);
    expect(await classificationAudit()).toHaveLength(0);
  });

  it("is 404 for a plain BAS user", async () => {
    await signInAsPlainBasUser();
    expect((await bulk({ pointIds: [fixture.sat.toString()], role: null })).status).toBe(404);
    expect((await row(fixture.sat)).pointRole).toBe(ROLES.sat);
  });
});

// ---------------------------------------------------------------------------
// 4. The ripple: a role is what the verdicts judge by.
// ---------------------------------------------------------------------------

describe("assigning a judged role", () => {
  it("brings a point into the setpoint-pair view, and clearing it takes it out", async () => {
    // A second AHU with two unclassified points. Pairing needs shared
    // equipment, which is the main practical reason to assign equipment.
    const ahu2 = await testDb.basEquipment.create({
      data: { siteId: fixture.siteId, name: "AHU-ZZTEST-2", equipType: ROLES.equipType },
    });
    const measured = await testDb.basPoint.create({
      data: { stationId: fixture.stationId, equipmentId: ahu2.equipmentId, niagaraHistoryName: "ZZTEST_M", dataType: "real", unit: "fahrenheit" },
    });
    const setpoint = await testDb.basPoint.create({
      data: { stationId: fixture.stationId, equipmentId: ahu2.equipmentId, niagaraHistoryName: "ZZTEST_SP", dataType: "real", unit: "fahrenheit" },
    });
    try {
      const baseline = await setpointPairs();
      expect(baseline).toHaveLength(1); // sat + satSp from the fixture

      await patch(measured.pointId.toString(), { role: ROLES.sat });
      expect(await setpointPairs()).toHaveLength(1); // half a pair is no pair

      await patch(setpoint.pointId.toString(), { role: ROLES.satSp });
      const paired = await setpointPairs();
      expect(paired).toHaveLength(2);
      expect(paired.some((p) => p.measured_point_id === measured.pointId && p.setpoint_point_id === setpoint.pointId)).toBe(true);

      await patch(measured.pointId.toString(), { role: null });
      expect(await setpointPairs()).toHaveLength(1);
    } finally {
      await testDb.basPoint.deleteMany({ where: { pointId: { in: [measured.pointId, setpoint.pointId] } } });
      await testDb.basEquipment.delete({ where: { equipmentId: ahu2.equipmentId } });
    }
  });

  it("brings a point into the command/status-pair view through a bulk change, and back out", async () => {
    const baseline = await commandStatusPairs();
    expect(baseline).toHaveLength(1); // fanCmd + fanStatus

    // Re-purpose `unknown` as a second status for the fan command: it pairs
    // because the status role's status_of names the command role and both
    // sit on the same equipment.
    await bulk({ pointIds: [fixture.unknown.toString()], role: ROLES.fanStatus });
    expect(await commandStatusPairs()).toHaveLength(2);

    await bulk({ pointIds: [fixture.unknown.toString()], role: null });
    expect(await commandStatusPairs()).toHaveLength(1);
  });

  it("moves the Unclassified tile on Collection Health at once, with nothing restarting", async () => {
    const before = await getCollectionHealth(viewer, { siteId: fixture.siteId });
    expect(before.totals.unclassifiedPoints).toBe(1); // fixture.unknown

    await patch(fixture.unknown.toString(), { role: ROLES.sat });
    expect((await getCollectionHealth(viewer, { siteId: fixture.siteId })).totals.unclassifiedPoints).toBe(0);

    await patch(fixture.unknown.toString(), { role: null });
    expect((await getCollectionHealth(viewer, { siteId: fixture.siteId })).totals.unclassifiedPoints).toBe(1);
  });

  it("drops the Analyze catalogue's cache on every classification write, and not on a no-op", async () => {
    const reset = vi.mocked(resetSchemaContextCache);
    reset.mockClear();
    await patch(fixture.unknown.toString(), { role: ROLES.sat });
    expect(reset).toHaveBeenCalledTimes(1);
    await patch(fixture.unknown.toString(), { role: ROLES.sat }); // unchanged
    expect(reset).toHaveBeenCalledTimes(1);
    await bulk({ pointIds: [fixture.sat.toString(), fixture.satSp.toString()], equipmentId: null });
    expect(reset).toHaveBeenCalledTimes(2);
    const created = await createEquipment({ siteId: fixture.siteId.toString(), name: "RTU-X", equipType: ROLES.equipType });
    expect(created.status).toBe(201);
    expect(reset).toHaveBeenCalledTimes(3);
  });

  it("leaves the Projects cards exactly as they were, because nothing on a card reads a role", async () => {
    // The newest-reading age is a clock reading and moves between two calls;
    // everything else on a card must not.
    const still = (dashboard: Awaited<ReturnType<typeof getDashboard>>) =>
      dashboard.projects.map((p) => ({
        ...p,
        health: p.health === null ? null : { ...p.health, minutesSinceNewestReading: null },
      }));
    const before = await getDashboard(viewer);
    await patch(fixture.unknown.toString(), { role: ROLES.sat });
    const after = await getDashboard(viewer);
    expect(still(after)).toEqual(still(before));
    expect(after.projectsInDatabase).toBe(before.projectsInDatabase);
  });
});

// ---------------------------------------------------------------------------
// 5. Suggestions: computed on read, written by nobody.
// ---------------------------------------------------------------------------

describe("reading the list", () => {
  it("changes no row and writes no audit row, however often it is read or rendered", async () => {
    const before = await snapshot();
    const list = await getStationPoints(viewer, fixture.stationId.toString());
    renderToStaticMarkup(createElement(PointsTable, { list, expectedTotal: list.pointsAccountedFor.inDatabase }));
    await getStationPoints(viewer, fixture.stationId.toString());
    expect(await snapshot()).toEqual(before);
    expect(await classificationAudit()).toHaveLength(0);
    expect(await testDb.auditEvent.count({ where: { action: { startsWith: "bas.equipment" } } })).toBe(0);
  });

  it("carries the point's equipment id and the station's building for the pickers", async () => {
    const list = await getStationPoints(viewer, fixture.stationId.toString());
    expect(list.siteId).toBe(fixture.siteId.toString());
    const sat = list.points.find((p) => p.pointId === fixture.sat.toString())!;
    expect(sat.equipmentId).toBe(fixture.equipmentId.toString());
    expect(sat.equipmentName).toBe(EQUIPMENT_NAME);
  });
});

const REAL_ROLES: ReadonlyMap<string, RoleFacts> = new Map(
  BAS_POINT_ROLES.map((r) => [
    r.pointRole,
    { pointRole: r.pointRole, displayName: r.displayName, typicalUnit: r.typicalUnit },
  ]),
);

function subject(
  name: string,
  overrides: Partial<Parameters<typeof suggestClassification>[0]> = {},
) {
  return suggestClassification(
    {
      niagaraHistoryName: name,
      niagaraDisplayName: decodeNiagaraName(name),
      unit: null,
      pointRole: null,
      equipmentId: null,
      collected: true,
      ...overrides,
    },
    REAL_ROLES,
    [{ equipmentId: "7", name: "VAV-8" }],
  );
}

describe("the suggestion engine", () => {
  it("decodes Niagara's $-hex escapes for matching, never for storage", () => {
    expect(decodeNiagaraName("VAV$2d8$20104$2d105_ZoneTemperature")).toBe("VAV-8 104-105_ZoneTemperature");
  });

  it("reads a VAV zone temperature as zone_temp on that VAV, new or existing", () => {
    const fresh = subject("VAV$2d3$20120$2d121_ZoneTemperature");
    expect(fresh).toMatchObject({
      role: "zone_temp",
      roleName: "Zone Temperature",
      equipmentName: "VAV-3",
      equipmentId: null,
      equipType: "vav",
      pattern: "vav_zone_temp",
    });
    const existing = subject("VAV$2d8$20104$2d105_ZoneTemperature");
    expect(existing).toMatchObject({ role: "zone_temp", equipmentName: "VAV-8", equipmentId: "7", equipType: null });
  });

  it("says NOTHING about a bare Temp - the lab's Temp1-Temp3 are the canon", () => {
    for (const name of ["Temp1", "Temp2", "Temp3", "points_RoomT", "Temperature_Setpoint", "Occupied", "OpState", "Unit_Status_Mode", "System_Enable", "Supply_Temp_Analog_Input"]) {
      expect(subject(name), name).toBeNull();
    }
  });

  it("reads the office RTU's unambiguous names, and leaves a setpoint word to a setpoint role", () => {
    expect(subject("Outside_Air_Temp_Analog_Input1")?.role).toBe("outside_air_temp");
    expect(subject("Outside_Air_Damper_Analog_Output1")?.role).toBe("oa_damper_cmd");
    expect(subject("Return$20Air$20Damper")?.role).toBe("ra_damper_cmd");
    expect(subject("RV_Supply_Fan_Speed_Analog_Output")?.role).toBe("supply_fan_speed");
    expect(subject("Supply_Duct_Static_Pressure_Analog_Input")?.role).toBe("duct_static_pressure");
    expect(subject("Supply_Duct_Static_Pressure_Setpoint")?.role).toBe("duct_static_pressure_sp");
    expect(subject("OccupancyCommand")?.role).toBe("occupancy_cmd");
    expect(subject("Zone_Temperature_Setpoint")?.role).toBe("zone_temp_sp");
    expect(subject("Supply_Air_Temp")?.role).toBe("supply_air_temp");
    // None of these name equipment.
    expect(subject("Outside_Air_Temp_Analog_Input1")?.equipmentName).toBeNull();
  });

  it("suggests only the missing half, nothing for an uncollected point, and nothing on a unit conflict", () => {
    expect(subject("VAV$2d3_ZoneTemperature", { pointRole: "zone_temp" })).toMatchObject({ role: null, equipmentName: "VAV-3" });
    expect(subject("VAV$2d3_ZoneTemperature", { equipmentId: "9" })).toMatchObject({ role: "zone_temp", equipmentName: null });
    expect(subject("VAV$2d3_ZoneTemperature", { pointRole: "zone_temp", equipmentId: "9" })).toBeNull();
    expect(subject("Outside_Air_Temp_Analog_Input1", { pointRole: "outside_air_temp" })).toBeNull();
    expect(subject("VAV$2d3_ZoneTemperature", { collected: false })).toBeNull();
    expect(subject("VAV$2d3_ZoneTemperature", { unit: "percent" })).toBeNull();
    expect(subject("VAV$2d3_ZoneTemperature", { unit: "fahrenheit" })).not.toBeNull();
  });

  it("is silent for a role this database does not hold", () => {
    const noRoles = suggestClassification(
      { niagaraHistoryName: "VAV$2d3_ZoneTemperature", niagaraDisplayName: null, unit: null, pointRole: null, equipmentId: null, collected: true },
      new Map(),
      [],
    );
    expect(noRoles).toBeNull();
  });

  it("names every pattern's role in the vocabulary, and each pattern once", () => {
    const ids = SUGGESTION_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of SUGGESTION_PATTERNS) expect(REAL_ROLES.has(p.role), p.id).toBe(true);
  });

  it("plans one creation per distinct equipment name and one batch per (role, equipment)", () => {
    const s = (role: string | null, equipmentName: string | null, equipmentId: string | null): PointSuggestion => ({
      role, roleName: role, equipmentName, equipmentId, equipType: equipmentName !== null && equipmentId === null ? "vav" : null, pattern: "t", confidence: "t",
    });
    const plan = planSuggestionBatches([
      { pointId: "1", suggestion: s("zone_temp", "VAV-1", null) },
      { pointId: "2", suggestion: s("zone_temp", "vav-1", null) }, // same box, other case
      { pointId: "3", suggestion: s("zone_temp", "VAV-8", "7") },
      { pointId: "4", suggestion: s("outside_air_temp", null, null) },
      { pointId: "5", suggestion: s("outside_air_temp", null, null) },
      { pointId: "6", suggestion: null },
    ]);
    expect(plan.create).toEqual([{ name: "VAV-1", equipType: "vav" }]);
    expect(plan.batches).toEqual([
      { pointIds: ["1", "2"], role: "zone_temp", equipmentId: null, equipmentName: "VAV-1" },
      { pointIds: ["3"], role: "zone_temp", equipmentId: "7", equipmentName: null },
      { pointIds: ["4", "5"], role: "outside_air_temp", equipmentId: null, equipmentName: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 6. Equipment through the routes.
// ---------------------------------------------------------------------------

describe("equipment", () => {
  const site = () => fixture.siteId.toString();

  it("is created, listed with its type, parent, notes and point count, edited and deleted", async () => {
    const rtu = await createEquipment({ siteId: site(), name: "RTU-1", equipType: ROLES.equipType });
    expect(rtu.status).toBe(201);
    const rtuId = (await data<{ equipmentId: string }>(rtu)).equipmentId;

    const vav = await createEquipment({
      siteId: site(), name: "VAV-1", equipType: ROLES.equipType, parentEquipmentId: rtuId, notes: "Serves 130-132",
    });
    expect(vav.status).toBe(201);
    const vavId = (await data<{ equipmentId: string }>(vav)).equipmentId;

    const listed = await data<{ equipment: Array<Record<string, unknown>>; equipmentAccountedFor: { rendered: number; inDatabase: number } }>(await listEquipment(site()));
    expect(listed.equipmentAccountedFor).toEqual({ rendered: 3, inDatabase: 3 }); // fixture AHU + 2
    expect(listed.equipment.find((e) => e.name === "VAV-1")).toMatchObject({
      equipType: ROLES.equipType, equipTypeName: "Air Handling Unit (test)", parentEquipmentId: rtuId, parentName: "RTU-1", notes: "Serves 130-132", pointCount: 0,
    });
    expect(listed.equipment.find((e) => e.name === EQUIPMENT_NAME)).toMatchObject({ pointCount: 5 });

    // Reparent after creation: the edit the phase turns on.
    const unparented = await patchEquipment(vavId, { parentEquipmentId: null });
    expect(await data(unparented)).toEqual({ changed: true });
    const reparented = await patchEquipment(vavId, { parentEquipmentId: rtuId, notes: "Serves 130-133" });
    expect(await data(reparented)).toEqual({ changed: true });
    expect(await data(await patchEquipment(vavId, { parentEquipmentId: rtuId }))).toEqual({ changed: false });

    // Delete refused while something sits under it; allowed once nothing does.
    const refused = await deleteEquipment(rtuId);
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe("equipment_in_use");
    expect(await data(await deleteEquipment(vavId))).toEqual({ deleted: true });
    expect(await data(await deleteEquipment(rtuId))).toEqual({ deleted: true });

    const actions = (await testDb.auditEvent.findMany({ where: { action: { startsWith: "bas.equipment" } }, orderBy: { occurredAt: "asc" } }));
    expect(actions.map((a) => a.action)).toEqual([
      "bas.equipment_created", "bas.equipment_created", "bas.equipment_updated", "bas.equipment_updated", "bas.equipment_deleted", "bas.equipment_deleted",
    ]);
    expect(actions[2]!.metadata).toMatchObject({ changed: ["parentEquipmentId"], previousParentName: "RTU-1", parentName: null });
    expect(actions[3]!.metadata).toMatchObject({ changed: ["parentEquipmentId", "notes"], parentName: "RTU-1", previousNotes: "Serves 130-132", notes: "Serves 130-133" });
  });

  it("refuses a duplicate name in the building, an unknown type, a parent elsewhere and a loop", async () => {
    const dup = await createEquipment({ siteId: site(), name: EQUIPMENT_NAME, equipType: ROLES.equipType });
    expect(dup.status).toBe(409);
    expect(await errorCode(dup)).toBe("name_taken");

    const badType = await createEquipment({ siteId: site(), name: "X", equipType: "hovercraft" });
    expect(badType.status).toBe(422);
    expect(await errorCode(badType)).toBe("equipment_type_not_found");

    const onB = await testDb.basEquipment.create({ data: { siteId: fixture.siteBId, name: "AHU-B", equipType: ROLES.equipType } });
    const parentElsewhere = await createEquipment({ siteId: site(), name: "X", equipType: ROLES.equipType, parentEquipmentId: onB.equipmentId.toString() });
    expect(parentElsewhere.status).toBe(404);
    expect(await errorCode(parentElsewhere)).toBe("equipment_not_found");

    const a = (await data<{ equipmentId: string }>(await createEquipment({ siteId: site(), name: "A", equipType: ROLES.equipType }))).equipmentId;
    const b = (await data<{ equipmentId: string }>(await createEquipment({ siteId: site(), name: "B", equipType: ROLES.equipType, parentEquipmentId: a }))).equipmentId;
    const loop = await patchEquipment(a, { parentEquipmentId: b });
    expect(loop.status).toBe(409);
    expect(await errorCode(loop)).toBe("equipment_cycle");
    const self = await patchEquipment(a, { parentEquipmentId: a });
    expect(await errorCode(self)).toBe("equipment_cycle");
  });

  it("refuses deleting equipment with points attached, naming the count", async () => {
    const response = await deleteEquipment(fixture.equipmentId.toString());
    expect(response.status).toBe(409);
    expect(((await payload(response)).error as { message: string }).message).toContain("5 points attached");
  });

  it("is 404 for a plain BAS user, on every equipment route", async () => {
    await signInAsPlainBasUser();
    expect((await listEquipment(site())).status).toBe(404);
    expect((await createEquipment({ siteId: site(), name: "X", equipType: ROLES.equipType })).status).toBe(404);
    expect((await patchEquipment(fixture.equipmentId.toString(), { notes: "x" })).status).toBe(404);
    expect((await deleteEquipment(fixture.equipmentId.toString())).status).toBe(404);
    expect((await vocabulariesRoute()).status).toBe(404);
  });
});

describe("the vocabularies route", () => {
  it("returns the roles and types this database holds, grouped by the picker's rule", async () => {
    const vocab = await data<{ roles: PointRoleOption[]; equipmentTypes: Array<{ equipType: string }> }>(await vocabulariesRoute());
    expect(vocab.roles.map((r) => r.pointRole).sort()).toEqual([ROLES.fanCmd, ROLES.fanStatus, ROLES.sat, ROLES.satSp].sort());
    expect(vocab.equipmentTypes.map((t) => t.equipType)).toEqual([ROLES.equipType]);
    const groups = groupRoles(vocab.roles);
    expect(groups.map((g) => [g.key, g.roles.map((r) => r.pointRole)])).toEqual([
      ["measurement", [ROLES.sat]],
      ["setpoint", [ROLES.satSp]],
      ["command", [ROLES.fanCmd]],
      ["status", [ROLES.fanStatus]],
    ]);
  });

  it("puts every one of the 91 real roles in exactly one group, with unclassified in its own", () => {
    const roles: PointRoleOption[] = BAS_POINT_ROLES.map((r) => ({
      pointRole: r.pointRole, displayName: r.displayName, description: r.description, measurement: r.measurement, typicalUnit: r.typicalUnit,
      isSetpoint: r.isSetpoint ?? false, isCommand: r.isCommand ?? false, isStatus: r.isStatus ?? false, setpointFor: r.setpointFor ?? null, statusOf: r.statusOf ?? null,
    }));
    const groups = groupRoles(roles);
    const placed = groups.flatMap((g) => g.roles.map((r) => r.pointRole));
    expect(placed).toHaveLength(91);
    expect(new Set(placed).size).toBe(91);
    expect(groups.find((g) => g.key === "reviewed")?.roles.map((r) => r.pointRole)).toEqual([REVIEWED_UNMAPPABLE_ROLE]);
    for (const g of groups) {
      const names = g.roles.map((r) => r.displayName);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    }
  });
});

// ---------------------------------------------------------------------------
// 7. The screen's pure rules.
// ---------------------------------------------------------------------------

describe("the list's rules", () => {
  const point = (over: Partial<SettingsPoint>): SettingsPoint => ({
    pointId: "1", label: null, niagaraHistoryName: "P", niagaraDisplayName: "P", pointRole: null, roleName: null,
    equipmentId: null, equipmentName: null, unit: null, suggestion: null,
    horizon: { state: "unknown", hours: null, currentHours: null, stationCount: null, capacity: null },
    collected: true, inactiveReason: null, completeness: null, lastRecordAt: null, visible: true, ...over,
  });

  it("filters by role, equipment and collected, and 'select all shown' is the filtered set", () => {
    const a = point({ pointId: "a", pointRole: "zone_temp", equipmentId: "1" });
    const b = point({ pointId: "b", pointRole: null, equipmentId: null });
    const c = point({ pointId: "c", pointRole: "zone_temp", equipmentId: null, collected: false });
    expect(pointMatchesFilters(a, NO_POINT_FILTERS)).toBe(true);
    expect(shownPoints([a, b, c], "", { ...NO_POINT_FILTERS, role: "none" }).map((p) => p.pointId)).toEqual(["b"]);
    expect(shownPoints([a, b, c], "", { ...NO_POINT_FILTERS, role: "zone_temp" }).map((p) => p.pointId)).toEqual(["a", "c"]);
    expect(shownPoints([a, b, c], "", { ...NO_POINT_FILTERS, equipment: "none" }).map((p) => p.pointId)).toEqual(["b", "c"]);
    expect(shownPoints([a, b, c], "", { ...NO_POINT_FILTERS, equipment: "1" }).map((p) => p.pointId)).toEqual(["a"]);
    expect(shownPoints([a, b, c], "", { ...NO_POINT_FILTERS, collected: "no" }).map((p) => p.pointId)).toEqual(["c"]);
    expect(shownPoints([a, b, c], "", { role: "zone_temp", equipment: "none", collected: "yes" })).toEqual([]);
  });

  it("names the count and both halves in the confirmation sentence", () => {
    expect(describeBulkPlan("Zone Temperature", "VAV-3", 10)).toBe("Set the role to Zone Temperature and attach to VAV-3 on 10 points.");
    expect(describeBulkPlan(null, undefined, 3)).toBe("Clear the role on 3 points.");
    expect(describeBulkPlan(undefined, null, 1)).toBe("Detach from equipment on 1 point.");
  });

  it("reports what the server did, not what was selected", () => {
    expect(describeBulkResult({ points: 10, roleChanged: 10, equipmentChanged: 0, unchanged: 0 })).toBe("Changed the role on 10 points.");
    expect(describeBulkResult({ points: 16, roleChanged: 0, equipmentChanged: 14, unchanged: 2 })).toBe("Changed the equipment on 14 points. 2 points already held them.");
    expect(describeBulkResult({ points: 2, roleChanged: 0, equipmentChanged: 0, unchanged: 2 })).toBe("No point needed changing: all 2 already held those values.");
  });

  it("words a suggestion, with (new) only for equipment that would be created", () => {
    const base: PointSuggestion = { role: "zone_temp", roleName: "Zone Temperature", equipmentName: "VAV-3", equipmentId: null, equipType: "vav", pattern: "p", confidence: "c" };
    expect(describeSuggestion(base)).toBe("Zone Temperature · VAV-3 (new)");
    expect(describeSuggestion({ ...base, equipmentId: "7", equipType: null })).toBe("Zone Temperature · VAV-3");
    expect(describeSuggestion({ ...base, equipmentName: null, equipmentId: null, equipType: null })).toBe("Zone Temperature");
    expect(describeSuggestion({ ...base, role: null, roleName: null })).toBe("VAV-3 (new)");
  });

  it("renders a suggestion as text with no button in a static render, a dash where there is none, and the ripple note nowhere without a picker", () => {
    const list = {
      stationId: "1", siteId: "1",
      points: [
        point({ pointId: "1", niagaraHistoryName: "VAV$2d3_ZoneTemperature", niagaraDisplayName: "VAV-3_ZoneTemperature", suggestion: { role: "zone_temp", roleName: "Zone Temperature", equipmentName: "VAV-3", equipmentId: null, equipType: "vav", pattern: "vav_zone_temp", confidence: "c" } }),
        point({ pointId: "2", niagaraHistoryName: "Temp1", niagaraDisplayName: null }),
      ],
      pointsAccountedFor: { rendered: 2, inDatabase: 2 },
    };
    const html = renderToStaticMarkup(createElement(PointsTable, { list, expectedTotal: 2 }));
    expect(html).toContain("Zone Temperature · VAV-3 (new)");
    expect(html).not.toContain("Apply the suggestion");
    expect(html).not.toContain(ROLE_RIPPLE_NOTE);
    expect(html).not.toContain('type="checkbox" aria-label="Select');

    const interactive = renderToStaticMarkup(
      createElement(PointsTable, {
        list, expectedTotal: 2,
        selected: new Set<string>(), onSelectionChange: () => undefined,
        onApplySuggestion: async () => undefined,
        onSetRole: async () => undefined,
        vocabularies: { roles: [], equipmentTypes: [] },
      }),
    );
    expect(interactive).toContain("Apply the suggestion Zone Temperature · VAV-3 (new) to VAV-3_ZoneTemperature");
    expect(interactive).toContain('aria-label="Select VAV-3_ZoneTemperature"');
    expect(interactive).toContain('aria-label="Role for Temp1"');
  });
});

// ---------------------------------------------------------------------------
// 8. The audit sentences.
// ---------------------------------------------------------------------------

describe("the audit sentences", () => {
  const MODULES = new Map([["bas", "Building Automation"]]);
  const event = (action: string, metadata: Record<string, unknown>) => ({
    action,
    moduleKey: "bas",
    metadata,
    actor: { id: "a", firstName: "Mahi", lastName: "Sheth", email: "m@x" },
    target: null,
  });

  it("read as sentences a person can act on", () => {
    expect(describeAuditEvent(event("bas.point_role_changed", { niagaraHistoryName: "P", previousRole: null, role: "zone_temp" }), MODULES).sentence)
      .toBe("Mahi Sheth gave the point P the role zone_temp");
    expect(describeAuditEvent(event("bas.point_role_changed", { label: "Zone 104", previousRole: "zone_temp", role: "supply_air_temp", viaBulk: true, selectionSize: 10 }), MODULES).sentence)
      .toBe("Mahi Sheth changed the role of the point Zone 104 from zone_temp to supply_air_temp (one of 10 in a bulk change)");
    expect(describeAuditEvent(event("bas.point_role_changed", { niagaraHistoryName: "P", previousRole: "zone_temp", role: null }), MODULES).sentence)
      .toBe("Mahi Sheth cleared the role zone_temp from the point P (back to unclassified)");
    expect(describeAuditEvent(event("bas.point_equipment_changed", { niagaraHistoryName: "P", previousEquipmentName: null, equipmentName: "VAV-3" }), MODULES).sentence)
      .toBe("Mahi Sheth attached the point P to the equipment VAV-3");
    expect(describeAuditEvent(event("bas.point_equipment_changed", { niagaraHistoryName: "P", previousEquipmentName: "VAV-3", equipmentName: "VAV-4" }), MODULES).sentence)
      .toBe("Mahi Sheth moved the point P from the equipment VAV-3 to VAV-4");
    expect(describeAuditEvent(event("bas.point_equipment_changed", { niagaraHistoryName: "P", previousEquipmentName: "VAV-3", equipmentName: null }), MODULES).sentence)
      .toBe("Mahi Sheth detached the point P from the equipment VAV-3");
    expect(describeAuditEvent(event("bas.equipment_created", { name: "VAV-3", equipType: "vav", parentName: "RV" }), MODULES).sentence)
      .toBe("Mahi Sheth added the equipment VAV-3 (vav) under RV");
    expect(describeAuditEvent(event("bas.equipment_updated", { name: "VAV-3", changed: ["parentEquipmentId"], previousParentName: null, parentName: "RV" }), MODULES).sentence)
      .toBe("Mahi Sheth placed the equipment VAV-3 under RV");
    expect(describeAuditEvent(event("bas.equipment_updated", { name: "VAV-3", previousName: "VAV3", changed: ["name"] }), MODULES).sentence)
      .toBe("Mahi Sheth renamed the equipment VAV3 to VAV-3");
    expect(describeAuditEvent(event("bas.equipment_updated", { name: "VAV-3", previousName: "VAV-3", changed: ["notes"] }), MODULES).sentence)
      .toBe("Mahi Sheth edited the equipment VAV-3 (notes)");
    expect(describeAuditEvent(event("bas.equipment_deleted", { name: "VAV-3" }), MODULES).sentence)
      .toBe("Mahi Sheth deleted the equipment VAV-3");
    for (const action of ["bas.point_role_changed", "bas.point_equipment_changed", "bas.equipment_created", "bas.equipment_updated", "bas.equipment_deleted"]) {
      expect(describeAuditEvent(event(action, {}), MODULES).known, action).toBe(true);
    }
  });
});
