import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Only the session is mocked. The guard, the wrapper, the Zod schema, the
// services and the real SQL - views included - all run against the test
// database, because the claim under test is about what the database's own
// rows render as, and a mock would only agree with itself.
vi.mock("@/auth", () => ({ auth: vi.fn() }));
// settings-view.tsx is a client component whose top-level hooks need a router;
// PointsTable itself calls none of them, but the module has to import.
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
import { getCollectionHealth, getPointExplorer } from "@/lib/modules/bas/service";
import {
  getBasSettingsTree,
  getStationPoints,
  setBasPointLabel,
} from "@/lib/modules/bas/settings-service";
import {
  NO_SETTINGS_FILTERS,
  pointDisplayName,
  pointMatchesSearch,
} from "@/lib/modules/bas/types";
import type { SettingsPoint, StationPointsList } from "@/lib/modules/bas/types";
import { updatePointSchema } from "@/lib/validation/bas-settings";
import { PointsTable } from "@/app/(modules)/bas/settings-view";
import { PATCH as patchPoint } from "@/app/api/modules/bas/settings/points/[pointId]/route";
import {
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
 * Editable labels (B8.4): three names, one precedence, tested with the label
 * NULL first.
 *
 * What is asserted, in order of how much it matters:
 *
 *   1. THE FALLBACK IS THE NORMAL PATH. Every real point has label NULL today,
 *      so the first thing checked - on every browsing screen and on the Points
 *      list - is that a fixture where NO point has a label renders Niagara's
 *      name everywhere, and the history name where Niagara sent none, and a
 *      blank nowhere. docs/testing-blind-spots.md asked for exactly this, from
 *      the same mistake on bas_stations.display_name, which is also NULL on
 *      both real stations; that fallback is now asserted here too.
 *   2. Precedence when a label IS set: the label wins on Point Explorer and
 *      Collection Health (table, gaps, vanished points, selected point) and
 *      the Niagara name stays on the Settings row - and only there.
 *   3. Setting, changing and clearing move ONE column. The oBIX key, Niagara's
 *      name, is_active, is_visible and inactive_reason are read before and
 *      after. Each change is one audit row with a sentence for its shape.
 *   4. Search finds a point by any of its three names - in the Settings tree
 *      (SQL) and on the Points list (browser) - because somebody will paste
 *      a name out of Workbench for a point the screen calls something else.
 *   5. The payload is closed: no `isActive`, no `niagaraHistoryName`, one
 *      field per request, blank means NULL, and 120 characters is the cap.
 *   6. The read service selects and orders every point name through one
 *      fragment. A bare `point_name` in a SELECT list or ORDER BY fails the
 *      build.
 *
 * The health fixture is used because it is the one with every screen's rows:
 * two buildings, a recorded gap, and points with and without a station
 * display name once one is nulled. Every label starts NULL in it - the
 * fixture was written before labels existed, which is the property that
 * makes section 1 honest.
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
let adminId: string;

async function adminViewer(): Promise<Viewer> {
  const employee = await createEmployee();
  await grantModule(employee.id, BAS_MODULE_KEY);
  await grantModuleAdmin(employee.id, BAS_MODULE_KEY);
  signedInAs(employee.entraOid!);
  const access = await requireModuleAdmin(BAS_MODULE_KEY);
  if (!access.ok) throw new Error(`expected access, got ${access.denial}`);
  adminId = employee.id;
  return access.viewer;
}

async function signInAsPlainBasUser() {
  const employee = await createEmployee();
  await grantModule(employee.id, BAS_MODULE_KEY);
  signedInAs(employee.entraOid!);
}

function patch(pointId: string, body: unknown): Promise<Response> {
  return patchPoint(
    new Request(`http://localhost/api/modules/bas/settings/points/${pointId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ pointId }) },
  );
}

async function payload(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** The five columns that must not move, plus the one that may. */
async function row(pointId: bigint) {
  return testDb.basPoint.findUniqueOrThrow({
    where: { pointId },
    select: {
      label: true,
      niagaraHistoryName: true,
      niagaraDisplayName: true,
      isActive: true,
      isVisible: true,
      inactiveReason: true,
    },
  });
}

async function auditRows() {
  return testDb.auditEvent.findMany({
    where: { action: "bas.point_label_changed" },
    orderBy: { occurredAt: "asc" },
  });
}

const deactivate = (pointId: bigint, reason: string) =>
  testDb.basPoint.update({
    where: { pointId },
    data: { isActive: false, inactiveReason: reason },
  });

const explorer = (options: { siteId?: bigint; pointId?: bigint } = {}) =>
  getPointExplorer(viewer, options);
const health = () => getCollectionHealth(viewer, { siteId: fixture.siteId });
const settingsList = () => getStationPoints(viewer, fixture.stationId.toString());
const tree = (q: string) => getBasSettingsTree(viewer, { ...NO_SETTINGS_FILTERS, q });

/** Every station the tree renders, by Niagara name. */
function treeStations(t: Awaited<ReturnType<typeof tree>>): string[] {
  return [
    ...t.projects.flatMap((p) => p.buildings.flatMap((b) => b.stations)),
    ...t.unassignedStations,
  ]
    .map((s) => s.niagaraStationName)
    .sort();
}

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
  await fixture.cleanup();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDb();
});

// ---------------------------------------------------------------------------
// 1. The fallback is the normal path.
// ---------------------------------------------------------------------------

describe("with every label NULL - which is every real point today", () => {
  it("starts from a fixture where no point has a label", async () => {
    const labelled = await testDb.basPoint.count({ where: { label: { not: null } } });
    expect(labelled).toBe(0);
    // And no station has a display name either, like both real stations.
    const namedStations = await testDb.basStation.count({
      where: { displayName: { not: null } },
    });
    expect(namedStations).toBe(0);
  });

  it("shows Niagara's name for every point in the Point Explorer picker, never a blank", async () => {
    const result = await explorer();
    const expected = await testDb.basPoint.findMany({
      where: { isActive: true },
      select: { pointId: true, niagaraDisplayName: true },
    });
    expect(result.points.length).toBe(expected.length);
    for (const option of result.points) {
      const point = expected.find((p) => p.pointId.toString() === option.pointId);
      expect(option.pointName).toBe(point?.niagaraDisplayName);
      expect(option.pointName.length).toBeGreaterThan(0);
    }
  });

  it("shows Niagara's name on every Collection Health row, the gap, and the selected point", async () => {
    const result = await health();
    for (const point of result.points) {
      expect(point.pointName).toMatch(/^AHU-1_/);
    }
    expect(result.dataGaps.map((g) => g.pointName)).toEqual(["AHU-1_SupplyAirTemp"]);

    const selected = await explorer({ siteId: fixture.siteId, pointId: fixture.sat });
    expect(selected.selectedPoint?.pointName).toBe("AHU-1_SupplyAirTemp");
    expect(selected.dataGaps.map((g) => g.pointName)).toEqual(["AHU-1_SupplyAirTemp"]);
  });

  it("falls through to the oBIX key when Niagara sent no name either, and is never blank", async () => {
    await testDb.basPoint.update({
      where: { pointId: fixture.sat },
      data: { niagaraDisplayName: null },
    });

    const picker = await explorer({ siteId: fixture.siteId });
    const option = picker.points.find((p) => p.pointId === fixture.sat.toString());
    expect(option?.pointName).toBe("AHU$2d1_SupplyAirTemp");

    const table = await health();
    const rowInTable = table.points.find((p) => p.pointId === fixture.sat.toString());
    expect(rowInTable?.pointName).toBe("AHU$2d1_SupplyAirTemp");
    expect(table.dataGaps.map((g) => g.pointName)).toEqual(["AHU$2d1_SupplyAirTemp"]);

    const list = await settingsList();
    const settingsRow = list.points.find((p) => p.pointId === fixture.sat.toString())!;
    expect(settingsRow.label).toBeNull();
    expect(settingsRow.niagaraDisplayName).toBeNull();
    expect(pointDisplayName(settingsRow)).toBe("AHU$2d1_SupplyAirTemp");
  });

  it("lists a vanished point by Niagara's name, and the station by ITS Niagara name", async () => {
    await deactivate(fixture.fanCmd, "no_longer_reported");
    const result = await health();
    expect(result.vanished.map((p) => p.pointName)).toEqual(["AHU-1_FanCmd"]);
    // bas_stations.display_name is NULL here as it is on both real stations;
    // the fallback to niagara_station_name is the path every station is on.
    expect(result.vanished[0]?.stationName).toBe("ZZTestStation");
  });

  it("names a station by its Niagara name in the cascade, and by its display name once one is set", async () => {
    const before = await explorer({ siteId: fixture.siteId });
    expect(before.stations.map((s) => s.name)).toEqual(["ZZTestStation"]);

    await testDb.basStation.update({
      where: { stationId: fixture.stationId },
      data: { displayName: "Office JACE" },
    });
    const after = await explorer({ siteId: fixture.siteId });
    expect(after.stations.map((s) => s.name)).toEqual(["Office JACE"]);

    await deactivate(fixture.fanCmd, "no_longer_reported");
    expect((await health()).vanished[0]?.stationName).toBe("Office JACE");
  });

  it("orders the two pure functions the same way as the SQL", () => {
    const key = { label: null, niagaraDisplayName: null, niagaraHistoryName: "VAV$2d8_ZoneTemp" };
    expect(pointDisplayName(key)).toBe("VAV$2d8_ZoneTemp");
    expect(pointDisplayName({ ...key, niagaraDisplayName: "VAV-8_ZoneTemp" })).toBe(
      "VAV-8_ZoneTemp",
    );
    expect(
      pointDisplayName({ ...key, niagaraDisplayName: "VAV-8_ZoneTemp", label: "Zone Temp 104" }),
    ).toBe("Zone Temp 104");
    // A label with no Niagara name still wins, and the key is still the floor.
    expect(pointDisplayName({ ...key, label: "Zone Temp 104" })).toBe("Zone Temp 104");
  });
});

// ---------------------------------------------------------------------------
// 2. Precedence when a label is set.
// ---------------------------------------------------------------------------

describe("a labelled point", () => {
  const LABEL = "Supply Air Temp (AHU-1)";

  beforeEach(async () => {
    await setBasPointLabel(viewer, fixture.sat.toString(), { label: LABEL });
  });

  it("shows its label in the Point Explorer picker, and its Niagara name is gone from it", async () => {
    const result = await explorer({ siteId: fixture.siteId });
    const names = result.points.map((p) => p.pointName);
    expect(names).toContain(LABEL);
    expect(names).not.toContain("AHU-1_SupplyAirTemp");
    expect(names).not.toContain("AHU$2d1_SupplyAirTemp");
    // The other four are untouched - still Niagara's names.
    expect(names.filter((n) => n.startsWith("AHU-1_"))).toHaveLength(4);
  });

  it("shows its label as the selected point and on its gaps", async () => {
    const result = await explorer({ siteId: fixture.siteId, pointId: fixture.sat });
    expect(result.selectedPoint?.pointName).toBe(LABEL);
    expect(result.dataGaps.map((g) => g.pointName)).toEqual([LABEL]);
  });

  it("shows its label on the Collection Health table and gap list", async () => {
    const result = await health();
    const row = result.points.find((p) => p.pointId === fixture.sat.toString());
    expect(row?.pointName).toBe(LABEL);
    expect(result.dataGaps.map((g) => g.pointName)).toEqual([LABEL]);
  });

  it("shows its label when the station stops reporting it", async () => {
    await deactivate(fixture.sat, "no_longer_reported");
    const result = await health();
    expect(result.vanished.map((p) => p.pointName)).toEqual([LABEL]);
  });

  it("still shows all three names on its Settings row - the key is what you match against Workbench", async () => {
    const list = await settingsList();
    const row = list.points.find((p) => p.pointId === fixture.sat.toString())!;
    expect(row.label).toBe(LABEL);
    expect(row.niagaraDisplayName).toBe("AHU-1_SupplyAirTemp");
    expect(row.niagaraHistoryName).toBe("AHU$2d1_SupplyAirTemp");

    const html = renderToStaticMarkup(
      createElement(PointsTable, { list, expectedTotal: list.pointsAccountedFor.inDatabase }),
    );
    expect(html).toContain(LABEL);
    expect(html).toContain("AHU-1_SupplyAirTemp");
    expect(html).toContain("AHU$2d1_SupplyAirTemp");
  });

  it("sorts the picker by the name on screen", async () => {
    // "AAA" sorts before "AHU-1_..." in any collation this database could
    // have: same first letter, then A before H.
    await setBasPointLabel(viewer, fixture.unknown.toString(), { label: "AAA Mystery point" });
    const result = await explorer({ siteId: fixture.siteId });
    expect(result.points[0]?.pointName).toBe("AAA Mystery point");
  });

  it("survives a rediscovery of the point's Niagara name", async () => {
    // What discover writes, by column: display_name, unit, data_type,
    // source_timezone, last_seen_at, is_active - and never label. The
    // collector's own test (phb-bas test_point_management.py) runs the real
    // upsert against these migrations; this is the platform-side view of the
    // same guarantee, applied through Prisma so a schema default cannot
    // sneak a value in.
    await testDb.basPoint.update({
      where: { pointId: fixture.sat },
      data: { niagaraDisplayName: "AHU-1 SAT (renamed in Workbench)", lastSeenAt: new Date() },
    });
    const after = await row(fixture.sat);
    expect(after.label).toBe(LABEL);
    expect(after.niagaraDisplayName).toBe("AHU-1 SAT (renamed in Workbench)");
    const picker = await explorer({ siteId: fixture.siteId });
    expect(picker.points.map((p) => p.pointName)).toContain(LABEL);
  });
});

// ---------------------------------------------------------------------------
// 3. One column moves, and every change is audited.
// ---------------------------------------------------------------------------

describe("setting, changing and clearing a label", () => {
  it("moves label and nothing else", async () => {
    const before = await row(fixture.sat);
    expect(before.label).toBeNull();

    const set = await setBasPointLabel(viewer, fixture.sat.toString(), { label: "Zone Temp 130" });
    expect(set).toEqual({ changed: true, label: "Zone Temp 130" });

    const after = await row(fixture.sat);
    expect(after.label).toBe("Zone Temp 130");
    // THE COLUMNS THAT MUST NOT MOVE.
    expect(after.niagaraHistoryName).toBe(before.niagaraHistoryName);
    expect(after.niagaraDisplayName).toBe(before.niagaraDisplayName);
    expect(after.isActive).toBe(before.isActive);
    expect(after.isVisible).toBe(before.isVisible);
    expect(after.inactiveReason).toBe(before.inactiveReason);
  });

  it("changes and clears, and clearing puts the Niagara name back on screen", async () => {
    await setBasPointLabel(viewer, fixture.sat.toString(), { label: "First" });
    await setBasPointLabel(viewer, fixture.sat.toString(), { label: "Second" });
    expect((await row(fixture.sat)).label).toBe("Second");

    const cleared = await setBasPointLabel(viewer, fixture.sat.toString(), { label: null });
    expect(cleared).toEqual({ changed: true, label: null });
    expect((await row(fixture.sat)).label).toBeNull();

    const picker = await explorer({ siteId: fixture.siteId });
    expect(picker.points.map((p) => p.pointName)).toContain("AHU-1_SupplyAirTemp");
  });

  it("treats the same label twice, and clearing an unlabelled point, as no change with no audit row", async () => {
    expect(await setBasPointLabel(viewer, fixture.sat.toString(), { label: null })).toEqual({
      changed: false,
      label: null,
    });
    await setBasPointLabel(viewer, fixture.sat.toString(), { label: "Same" });
    expect(await setBasPointLabel(viewer, fixture.sat.toString(), { label: "Same" })).toEqual({
      changed: false,
      label: "Same",
    });
    expect(await auditRows()).toHaveLength(1);
  });

  it("labels a point that is not collected without touching why it is off", async () => {
    await deactivate(fixture.fanCmd, "manual");
    await setBasPointLabel(viewer, fixture.fanCmd.toString(), { label: "Old fan command" });
    expect(await row(fixture.fanCmd)).toMatchObject({
      label: "Old fan command",
      isActive: false,
      inactiveReason: "manual",
    });
  });

  it("writes one audit row per change, carrying both names and both labels", async () => {
    await setBasPointLabel(viewer, fixture.sat.toString(), { label: "Zone Temp 130" });
    await setBasPointLabel(viewer, fixture.sat.toString(), { label: "Zone Temp 131" });
    await setBasPointLabel(viewer, fixture.sat.toString(), { label: null });

    const rows = await auditRows();
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.actorEmployeeId).toBe(adminId);
      expect(r.moduleKey).toBe(BAS_MODULE_KEY);
      expect(r.metadata).toMatchObject({
        pointId: fixture.sat.toString(),
        stationId: fixture.stationId.toString(),
        niagaraHistoryName: "AHU$2d1_SupplyAirTemp",
        niagaraDisplayName: "AHU-1_SupplyAirTemp",
      });
    }
    expect(rows[0]!.metadata).toMatchObject({ previousLabel: null, label: "Zone Temp 130" });
    expect(rows[1]!.metadata).toMatchObject({ previousLabel: "Zone Temp 130", label: "Zone Temp 131" });
    expect(rows[2]!.metadata).toMatchObject({ previousLabel: "Zone Temp 131", label: null });
  });

  it("reads as three different sentences, each naming the point by its key", async () => {
    await setBasPointLabel(viewer, fixture.sat.toString(), { label: "Zone Temp 130" });
    await setBasPointLabel(viewer, fixture.sat.toString(), { label: "Zone Temp 131" });
    await setBasPointLabel(viewer, fixture.sat.toString(), { label: null });
    const actor = { id: "a", firstName: "Jim", lastName: "Schwarz", email: "j@phb1899.com" };
    const sentences = (await auditRows()).map(
      (r) =>
        describeAuditEvent({
          action: r.action,
          moduleKey: r.moduleKey,
          metadata: r.metadata,
          actor,
          target: null,
        }).sentence,
    );
    expect(sentences).toEqual([
      'Jim Schwarz labelled the point AHU$2d1_SupplyAirTemp "Zone Temp 130"',
      'Jim Schwarz relabelled the point AHU$2d1_SupplyAirTemp from "Zone Temp 130" to "Zone Temp 131"',
      'Jim Schwarz cleared the label "Zone Temp 131" from the point AHU$2d1_SupplyAirTemp (back to its Niagara name)',
    ]);
  });

  it("is 404 from the service for a point that does not exist or an id that is not one", async () => {
    await expect(setBasPointLabel(viewer, "999999999", { label: "x" })).rejects.toMatchObject({
      code: "point_not_found",
    });
    await expect(setBasPointLabel(viewer, "1e5", { label: "x" })).rejects.toMatchObject({
      code: "point_not_found",
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Search by any of the three names.
// ---------------------------------------------------------------------------

describe("search finds a point by any of its three names", () => {
  it("surfaces the station in the Settings tree for a label, a Niagara name, or a pasted key", async () => {
    await setBasPointLabel(viewer, fixture.sat.toString(), { label: "Zone Temp 104-105" });

    // What the screen shows.
    expect(treeStations(await tree("Zone Temp 104"))).toEqual(["ZZTestStation"]);
    // What Niagara reports.
    expect(treeStations(await tree("AHU-1_SupplyAirTempSp"))).toEqual(["ZZTestStation"]);
    // What Workbench shows, escapes and all.
    expect(treeStations(await tree("AHU$2d1_Supply"))).toEqual(["ZZTestStation"]);
    // Station B's point, by ITS name, finds station B and not A.
    expect(treeStations(await tree("B_Unknown"))).toEqual(["ZZTestStationB"]);
    // And a term matching nothing returns nothing, not everything.
    expect(treeStations(await tree("no-such-point"))).toEqual([]);
  });

  it("counts a station found by a point's name as matched, so the guard stays quiet", async () => {
    const t = await tree("AHU$2d1_Supply");
    expect(t.stationsAccountedFor.rendered).toBe(1);
    expect(t.stationsAccountedFor.matched).toBe(1);
    expect(t.stationsAccountedFor.filtered).toBe(true);
  });

  it("matches the label of a point that is not collected, and is case-insensitive", async () => {
    await deactivate(fixture.fanCmd, "manual");
    await setBasPointLabel(viewer, fixture.fanCmd.toString(), { label: "Old Fan Command" });
    expect(treeStations(await tree("old fan"))).toEqual(["ZZTestStation"]);
  });

  it("matches on the Points list by all three names, with NULL labels across the board", async () => {
    const list = await settingsList();
    const byKey = (q: string) => list.points.filter((p) => pointMatchesSearch(p, q));

    expect(byKey("AHU$2d1_SupplyAirTemp").map((p) => p.niagaraHistoryName).sort()).toEqual([
      "AHU$2d1_SupplyAirTemp",
      "AHU$2d1_SupplyAirTempSp",
    ]);
    expect(byKey("ahu-1_fancmd").map((p) => p.niagaraDisplayName)).toEqual(["AHU-1_FanCmd"]);
    expect(byKey("")).toHaveLength(list.points.length);
    expect(byKey("   ")).toHaveLength(list.points.length);
    expect(byKey("Zone Temp")).toEqual([]);

    // Now a label, and the same point is found by the label too.
    await setBasPointLabel(viewer, fixture.sat.toString(), { label: "Zone Temp 104-105" });
    const relisted = await settingsList();
    const matches = relisted.points.filter((p) => pointMatchesSearch(p, "zone temp 104"));
    expect(matches.map((p) => p.niagaraHistoryName)).toEqual(["AHU$2d1_SupplyAirTemp"]);
  });

  it("renders the narrowed table with a count, and says so when nothing matches", async () => {
    const list = await settingsList();
    const render = (query: string) =>
      renderToStaticMarkup(
        createElement(PointsTable, {
          list,
          expectedTotal: list.pointsAccountedFor.inDatabase,
          query,
        }),
      );

    const narrowed = render("FanCmd");
    expect(narrowed).toContain("1 of 5 points match");
    expect(narrowed).toContain("AHU$2d1_FanCmd");
    expect(narrowed).not.toContain("AHU$2d1_SupplyAirTempSp");
    // The service's counts are untouched by a search: no alarm.
    expect(narrowed).not.toContain("could not be placed");

    const nothing = render("no-such-point");
    expect(nothing).toContain("No point on this station matches");
    expect(nothing).toContain("Clear the search to see all 5");
  });
});

// ---------------------------------------------------------------------------
// 5. The payload is closed.
// ---------------------------------------------------------------------------

describe("PATCH /settings/points/{id} with a label", () => {
  it("sets a trimmed label and answers with what it stored", async () => {
    const response = await patch(fixture.sat.toString(), { label: "  Zone Temp 130  " });
    expect(response.status).toBe(200);
    expect(await payload(response)).toEqual({ data: { changed: true, label: "Zone Temp 130" } });
    expect((await row(fixture.sat)).label).toBe("Zone Temp 130");
  });

  it("turns a blank into NULL - 'no label' has one spelling", async () => {
    await patch(fixture.sat.toString(), { label: "Zone Temp 130" });
    for (const blank of ["", "   ", null]) {
      await patch(fixture.sat.toString(), { label: "Zone Temp 130" });
      const response = await patch(fixture.sat.toString(), { label: blank });
      expect(response.status).toBe(200);
      expect(await payload(response)).toEqual({ data: { changed: true, label: null } });
      expect((await row(fixture.sat)).label).toBeNull();
    }
    // The CHECK agrees: a blank can never be stored by any path.
    await expect(
      testDb.basPoint.update({ where: { pointId: fixture.sat }, data: { label: "  " } }),
    ).rejects.toThrow(/bas_points_label_not_blank/);
  });

  it("caps a label at 120 characters", async () => {
    expect((await patch(fixture.sat.toString(), { label: "x".repeat(120) })).status).toBe(200);
    expect((await patch(fixture.sat.toString(), { label: "x".repeat(121) })).status).toBe(422);
    expect((await row(fixture.sat)).label).toBe("x".repeat(120));
  });

  it("refuses a body that tries to reach is_active or the oBIX key, and moves nothing", async () => {
    const before = await row(fixture.sat);
    expect(
      (await patch(fixture.sat.toString(), { label: "x", isActive: false })).status,
    ).toBe(422);
    expect(
      (await patch(fixture.sat.toString(), { label: "x", niagaraHistoryName: "Other" })).status,
    ).toBe(422);
    expect(
      (await patch(fixture.sat.toString(), { niagaraHistoryName: "Other" })).status,
    ).toBe(422);
    expect(await row(fixture.sat)).toEqual(before);
  });

  it("takes one field per request: both, or neither, is 422", async () => {
    expect((await patch(fixture.sat.toString(), { label: "x", visible: false })).status).toBe(422);
    expect((await patch(fixture.sat.toString(), {})).status).toBe(422);
    expect((await patch(fixture.sat.toString(), { label: 7 })).status).toBe(422);
    const after = await row(fixture.sat);
    expect(after.label).toBeNull();
    expect(after.isVisible).toBe(true);
  });

  it("still hides through the same route, leaving the label alone", async () => {
    await patch(fixture.sat.toString(), { label: "Zone Temp 130" });
    const response = await patch(fixture.sat.toString(), { visible: false });
    expect(await payload(response)).toEqual({ data: { changed: true } });
    expect(await row(fixture.sat)).toMatchObject({ label: "Zone Temp 130", isVisible: false });
  });

  it("is 404 without the module-admin flag, and for a point that does not exist", async () => {
    await signInAsPlainBasUser();
    expect((await patch(fixture.sat.toString(), { label: "x" })).status).toBe(404);
    expect((await row(fixture.sat)).label).toBeNull();
    expect(await auditRows()).toHaveLength(0);

    await adminViewer();
    expect((await patch("999999999", { label: "x" })).status).toBe(404);
    expect((await patch("not-a-number", { label: "x" })).status).toBe(404);
  });

  it("is strict at the schema, not only at the route", () => {
    expect(updatePointSchema.safeParse({ label: "x", isActive: false }).success).toBe(false);
    expect(updatePointSchema.safeParse({ visible: false, isActive: false }).success).toBe(false);
    expect(updatePointSchema.safeParse({ label: " x " })).toMatchObject({
      success: true,
      data: { label: "x" },
    });
    expect(updatePointSchema.safeParse({ label: "" })).toMatchObject({
      success: true,
      data: { label: null },
    });
  });
});

// ---------------------------------------------------------------------------
// 6. The Points list renders the label, and one fragment names every point.
// ---------------------------------------------------------------------------

describe("the Points list", () => {
  const point = (label: string | null, niagaraDisplayName: string | null): SettingsPoint => ({
    pointId: "7",
    label,
    niagaraHistoryName: "VAV$2d8$20104$2d105_ZoneTemperature",
    niagaraDisplayName,
    pointRole: null,
    roleName: null,
    equipmentId: null,
    equipmentName: null,
    unit: null,
    suggestion: null,
    horizon: { state: "unknown", hours: null, currentHours: null, stationCount: null, capacity: null },
    collected: true,
    inactiveReason: null,
    completeness: "complete",
    lastRecordAt: null,
    visible: true,
  });
  const list = (p: SettingsPoint): StationPointsList => ({
    stationId: "1",
    siteId: "1",
    points: [p],
    pointsAccountedFor: { rendered: 1, inDatabase: 1 },
  });

  it("offers Add label on an unlabelled row, and names the point by Niagara's name in the checkbox", () => {
    const html = renderToStaticMarkup(
      createElement(PointsTable, {
        list: list(point(null, "VAV-8 104-105_ZoneTemperature")),
        expectedTotal: 1,
        onSaveLabel: async () => undefined,
      }),
    );
    expect(html).toContain("Add label");
    expect(html).toContain("Show VAV-8 104-105_ZoneTemperature on the browsing screens");
    expect(html).toContain("VAV$2d8$20104$2d105_ZoneTemperature");
  });

  it("names the point by its key in the checkbox when Niagara sent no name", () => {
    const html = renderToStaticMarkup(
      createElement(PointsTable, {
        list: list(point(null, null)),
        expectedTotal: 1,
        onSaveLabel: async () => undefined,
      }),
    );
    expect(html).toContain("Show VAV$2d8$20104$2d105_ZoneTemperature on the browsing screens");
    // Never an empty name.
    expect(html).not.toContain("Show  on the browsing screens");
  });

  it("shows the label as the editable text, and as plain text in a static render", () => {
    const editable = renderToStaticMarkup(
      createElement(PointsTable, {
        list: list(point("Zone Temp 104-105", "VAV-8 104-105_ZoneTemperature")),
        expectedTotal: 1,
        onSaveLabel: async () => undefined,
      }),
    );
    expect(editable).toContain("Edit the label for Zone Temp 104-105");
    expect(editable).toContain("Show Zone Temp 104-105 on the browsing screens");
    expect(editable).not.toContain("Add label");

    const readOnly = renderToStaticMarkup(
      createElement(PointsTable, {
        list: list(point("Zone Temp 104-105", "VAV-8 104-105_ZoneTemperature")),
        expectedTotal: 1,
      }),
    );
    expect(readOnly).toContain("Zone Temp 104-105");
    expect(readOnly).not.toContain("Edit the label");
  });

  it("says what a label does and does not change - on the column, not under the table", async () => {
    const html = renderToStaticMarkup(
      createElement(PointsTable, {
        list: list(point(null, null)),
        expectedTotal: 1,
      }),
    );
    // Since 2026-09-29 the explanation is the Label and Niagara name
    // columns' own tooltips; the paragraph under the table is the count only.
    expect(html).toContain("A label replaces the station");
    expect(html).toContain("the Niagara name is never editable");
    expect(html).not.toContain("Labels and roles are edited in a later phase");
    expect(html).not.toContain("Roles and equipment are edited in a later phase");
    const body = html.replace(/title="[^"]*"/g, "");
    expect(body).not.toContain("A label replaces the station");
    expect(body).not.toContain("never editable");
  });
});

describe("one fragment names every point the read service returns", () => {
  it("selects and orders through shownPointName, never a bare point_name (source text)", async () => {
    const source = await readFile(
      path.join(process.cwd(), "lib", "modules", "bas", "service.ts"),
      "utf8",
    );
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*|--)/.test(line));

    // A SELECT-list line that is just `x.point_name,` - the B8.3 spelling.
    const bareSelect = code.filter((line) => /^\s*[a-z]+\.point_name\s*,?\s*$/.test(line));
    expect(bareSelect).toEqual([]);
    // An ORDER BY that sorts by the view's name rather than the shown one.
    const bareOrder = code.filter((line) => /ORDER BY.*\b[a-z]+\.point_name\b/.test(line));
    expect(bareOrder).toEqual([]);
    // And the fragment is what remains.
    expect((source.match(/shownPointName\(/g) ?? []).length).toBeGreaterThanOrEqual(7);
  });
});
