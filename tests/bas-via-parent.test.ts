import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Only the session is mocked. The services, the SQL and the views are real:
// what is asserted is how real rows come out.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { auth } from "@/auth";
import type { Viewer } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { getCollectionHealth, getPointExplorer } from "@/lib/modules/bas/service";
import { getBasSettingsTree } from "@/lib/modules/bas/settings-service";
import { orderStationTree } from "@/lib/modules/bas/station-tree";
import { resolveScope, type DefinitionForRun } from "@/lib/modules/bas/reports/engine/scope";
import { listReportOptions } from "@/lib/modules/bas/reports/service";
import type { SettingsStation } from "@/lib/modules/bas/types";
import {
  describeStationPass,
  describeThroughParent,
  stationPickerOptions,
} from "@/app/(modules)/bas/health-client";
import { StationPassTable } from "@/app/(modules)/bas/collection-health";
import { ViaParentStationNote } from "@/app/(modules)/bas/point-explorer";
import { ThroughParentLine } from "@/app/(modules)/bas/settings-view";
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
 * Via-parent stations on the platform (2026-11-20).
 *
 * The collector now reads a via-parent station's histories through its parent
 * (phb-bas, collector/targets.py): its own points, its own runs. What the
 * platform owes that is asserted here, against real rows:
 *
 *   1. One tree, from one function: every JACE list orders a via-parent
 *      station under the station whose import carries it, roots in the order
 *      the screens already used, a loop listed rather than lost.
 *   2. Collection Health and Point Explorer: the picker's options carry depth,
 *      parent and THE STATION'S OWN last pass; the Stations panel draws them
 *      indented with "through <parent>"; the runs table names each run's
 *      station; the collector-silence count includes stations read through a
 *      parent.
 *   3. Settings: a via-parent station's card says "Collected through <parent>"
 *      where the login block was - no "Set login", no "No Niagara login
 *      stored".
 *   4. Reports: a building's scope includes a via-parent station's points
 *      when no subset is ticked, and the station-subset picker lists it under
 *      its parent.
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

const HOUR = 3_600_000;

let fixture: HealthFixture;
let viewer: Viewer;
let childA: bigint;
let childB: bigint;
let childOther: bigint;
const extraRuns: bigint[] = [];

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

  const employee = await createEmployee({ entraOid: "oid-via-parent" });
  await grantModule(employee.id, BAS_MODULE_KEY);
  await grantModuleAdmin(employee.id, BAS_MODULE_KEY);
  signedInAs("oid-via-parent");
  viewer = {
    id: employee.id,
    email: employee.email,
    firstName: employee.firstName,
    lastName: employee.lastName,
    profileCompleted: true,
    isPlatformAdmin: false,
  };

  // The fixture's stations take the column default, via_parent with no
  // parent. The JACE becomes direct, as CEI_JCI_N2 is, and three stations are
  // read through it: two on its building (named so the alphabet would put
  // them FIRST if the tree were not honoured) and one on the other building.
  await testDb.basStation.update({
    where: { stationId: fixture.stationId },
    data: { connectionMode: "direct", baseUrl: "https://198.51.100.149" },
  });
  childA = (
    await testDb.basStation.create({
      data: {
        siteId: fixture.siteId,
        niagaraStationName: "AAA_CEI_AHU_7",
        connectionMode: "via_parent",
        parentStationId: fixture.stationId,
      },
    })
  ).stationId;
  childB = (
    await testDb.basStation.create({
      data: {
        siteId: fixture.siteId,
        niagaraStationName: "AAA_CEI_AHU_8",
        connectionMode: "via_parent",
        parentStationId: fixture.stationId,
      },
    })
  ).stationId;
  childOther = (
    await testDb.basStation.create({
      data: {
        siteId: fixture.siteBId,
        niagaraStationName: "AAA_CEI_PLANT",
        connectionMode: "via_parent",
        parentStationId: fixture.stationId,
      },
    })
  ).stationId;

  // childA's own last pass FAILED (its folder was not there) while the
  // parent's is ok - the case the per-station status exists for.
  const now = Date.now();
  extraRuns.push(
    (
      await testDb.basIngestRun.create({
        data: {
          stationId: childA,
          startedAt: new Date(now - HOUR),
          finishedAt: new Date(now - HOUR + 20_000),
          status: "failed",
          collectorHost: "ZZTEST-HOST",
        },
      })
    ).runId,
  );
});

afterEach(async () => {
  // The children first: parent_station_id is RESTRICT, and the fixture's
  // cleanup deletes the parent.
  await testDb.basIngestRun.deleteMany({ where: { runId: { in: extraRuns.splice(0) } } });
  await testDb.basPoint.deleteMany({ where: { stationId: { in: [childA, childB, childOther] } } });
  await testDb.basStation.deleteMany({ where: { stationId: { in: [childA, childB, childOther] } } });
  await fixture.cleanup();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDb();
});

// ---------------------------------------------------------------------------
// 1. The tree
// ---------------------------------------------------------------------------

describe("orderStationTree", () => {
  const row = (stationId: string, parentStationId: string | null, name: string, siteName = "S") => ({
    stationId,
    parentStationId,
    name,
    siteName,
  });

  it("puts each child under its parent, by name, with its depth and parent", () => {
    const out = orderStationTree([
      row("1", null, "CEI_JCI_N2"),
      row("2", "1", "CEI_PLANT"),
      row("3", "1", "CEI_AHU_7"),
      row("4", null, "PHBoffice"),
      row("5", "3", "AHU7_SUB"),
    ]);
    expect(out.map((r) => [r.name, r.depth, r.parentName])).toEqual([
      ["CEI_JCI_N2", 0, null],
      ["CEI_AHU_7", 1, "CEI_JCI_N2"],
      ["AHU7_SUB", 2, "CEI_AHU_7"],
      ["CEI_PLANT", 1, "CEI_JCI_N2"],
      ["PHBoffice", 0, null],
    ]);
  });

  it("keeps the caller's order for roots", () => {
    const out = orderStationTree([row("9", null, "Zed"), row("1", null, "Alpha")]);
    expect(out.map((r) => r.name)).toEqual(["Zed", "Alpha"]);
  });

  it("makes a child whose parent is outside the list a root", () => {
    const out = orderStationTree([row("2", "1", "CEI_PLANT")]);
    expect(out).toEqual([{ ...row("2", "1", "CEI_PLANT"), depth: 0, parentName: null }]);
  });

  it("lists a loop rather than hanging or dropping it", () => {
    const out = orderStationTree([row("1", "2", "A"), row("2", "1", "B"), row("3", "3", "Self")]);
    expect(out.map((r) => r.name).sort()).toEqual(["A", "B", "Self"]);
  });
});

// ---------------------------------------------------------------------------
// 2. Collection Health and Point Explorer
// ---------------------------------------------------------------------------

describe("the JACE lists", () => {
  it("list each via-parent station under its parent, with its own last pass", async () => {
    const health = await getCollectionHealth(viewer, { siteId: fixture.siteId });
    expect(health.stations.map((s) => [s.name, s.depth, s.parentName, s.viaParent])).toEqual([
      ["ZZTestStation", 0, null, false],
      ["AAA_CEI_AHU_7", 1, "ZZTestStation", true],
      ["AAA_CEI_AHU_8", 1, "ZZTestStation", true],
    ]);
    const byName = new Map(health.stations.map((s) => [s.name, s]));
    expect(byName.get("ZZTestStation")?.lastPass?.status).toBe("ok");
    expect(byName.get("AAA_CEI_AHU_7")?.lastPass?.status).toBe("failed");
    expect(byName.get("AAA_CEI_AHU_8")?.lastPass).toBeNull();
  });

  it("are the same tree in Point Explorer", async () => {
    const explorer = await getPointExplorer(viewer, { siteId: fixture.siteId, selectPoint: false });
    const health = await getCollectionHealth(viewer, { siteId: fixture.siteId });
    expect(explorer.stations).toEqual(health.stations);
  });

  it("make a child on another building a root there, still marked via parent", async () => {
    const health = await getCollectionHealth(viewer, { siteId: fixture.siteBId });
    const plant = health.stations.find((s) => s.name === "AAA_CEI_PLANT");
    expect(plant).toMatchObject({ depth: 0, parentName: null, viaParent: true });
  });

  it("name each run's station in the runs table", async () => {
    const health = await getCollectionHealth(viewer, { siteId: fixture.siteId });
    const names = new Set(health.runs.map((r) => r.stationName));
    expect(names.has("AAA_CEI_AHU_7")).toBe(true);
    expect(names.has("ZZTestStation")).toBe(true);
  });

  it("count a station read through a parent as collectable, and not one with no parent", async () => {
    // Direct parent + three children with a parent; the fixture's site-B
    // station is via_parent with NO parent and is not collected.
    const health = await getCollectionHealth(viewer);
    expect(health.collectorPass.collectableStations).toBe(4);
  });

  it("render indented, with 'through <parent>' and each station's own pass", async () => {
    const health = await getCollectionHealth(viewer, { siteId: fixture.siteId });
    const html = renderToStaticMarkup(createElement(StationPassTable, { stations: health.stations }));
    expect(html).toContain('data-depth="1"');
    expect(html).toContain("through ZZTestStation");
    expect(html).toContain("last pass failed");
    expect(html).toContain("no pass recorded");

    const options = stationPickerOptions(health.stations);
    expect(options.map((o) => o.indent)).toEqual([0, 1, 1]);
    expect(options[1]!.hint).toContain("last pass failed");

    const note = renderToStaticMarkup(
      createElement(ViaParentStationNote, {
        stations: health.stations,
        selectedStationId: childA.toString(),
      }),
    );
    expect(note).toContain("AAA_CEI_AHU_7 is collected through ZZTestStation");
    expect(note).toContain("last pass failed");
    // Nothing for the direct station.
    expect(
      renderToStaticMarkup(
        createElement(ViaParentStationNote, {
          stations: health.stations,
          selectedStationId: fixture.stationId.toString(),
        }),
      ),
    ).toBe("");
  });

  it("word a missing pass as amber, never as fine", () => {
    expect(describeStationPass(null)).toEqual({ label: "no pass recorded", tone: "warn" });
    expect(describeStationPass({ status: "ok", at: new Date().toISOString() }).tone).toBe("ok");
    expect(describeStationPass({ status: "failed", at: new Date().toISOString() }).tone).toBe("bad");
  });
});

// ---------------------------------------------------------------------------
// 3. Settings
// ---------------------------------------------------------------------------

describe("Settings: a via-parent station's card", () => {
  it("says it is collected through its parent, where the login block was", async () => {
    const tree = await getBasSettingsTree(viewer);
    const stations = tree.projects
      .flatMap((p) => p.buildings)
      .flatMap((b) => b.stations) as SettingsStation[];
    const child = stations.find((s) => s.stationId === childA.toString())!;
    expect(child.reach).toBe("via_parent");
    expect(child.parentStationName).toBe("ZZTestStation");

    const html = renderToStaticMarkup(createElement(ThroughParentLine, { station: child }));
    expect(html).toContain("Collected through ZZTestStation");
    expect(html).toContain("its login and certificate are used");
    expect(html).not.toContain("Set login");
    expect(html).not.toContain("No Niagara login stored");
  });

  it("never draws the credential panel for a station read through a parent (source text)", async () => {
    // StationRow is not exported; this holds its one branch. The login block
    // - "No Niagara login stored", "Set login" - is drawn only for a direct
    // station, and the Edit form for a via-parent one is the names-and-parent
    // form with no mode, address or fingerprint.
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("app/(modules)/bas/settings-view.tsx", "utf8");
    expect(source).toMatch(/const throughParent = station\.reach !== "direct";/);
    expect(source).toMatch(/\{throughParent \? \(\s*<ThroughParentLine station=\{station\} \/>\s*\) : \(\s*<CredentialPanel/);
    expect(source).toMatch(/if \(editing && station\.reach === "via_parent"\)[\s\S]{0,400}viaParentOnly/);
    expect(source).toMatch(/\{!viaParentOnly && \(\s*<Field label="How its history reaches us">/);
  });

  it("says what fixes an unassigned station, which is not collected", () => {
    expect(describeThroughParent({ reach: "unassigned", parentStationName: null })).toEqual({
      label: "Not collected - no parent chosen. Edit it and choose the station that imports its history.",
      tone: "warn",
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Reports
// ---------------------------------------------------------------------------

describe("Reports", () => {
  const definition = (stationIds: bigint[]): DefinitionForRun =>
    ({
      site: { siteId: fixture.siteId, name: "ZZTEST_SITE", timezone: "America/New_York" },
      stationIds,
    }) as unknown as DefinitionForRun;

  it("take a via-parent station's points into a building's scope when no subset is ticked", async () => {
    const point = await testDb.basPoint.create({
      data: { stationId: childA, niagaraHistoryName: "DA_T", dataType: "real" },
    });
    const now = Date.now();
    const scope = await resolveScope(definition([]), { start: now - 24 * HOUR, end: now });
    expect(scope.stations.map((s) => s.stationId)).toContain(childA.toString());
    expect(scope.points.map((p) => p.pointId)).toContain(point.pointId.toString());

    // Ticking only the parent leaves the child out: each is a station of its own.
    const parentOnly = await resolveScope(definition([fixture.stationId]), { start: now - 24 * HOUR, end: now });
    expect(parentOnly.points.map((p) => p.pointId)).not.toContain(point.pointId.toString());
  });

  it("list a via-parent station under its parent in the station-subset picker", async () => {
    const options = await listReportOptions(viewer);
    const site = options.sites.find((s) => s.siteId === fixture.siteId.toString())!;
    expect(site.stations.map((s) => [s.name, s.depth, s.viaParent, s.parentName])).toEqual([
      ["ZZTestStation", 0, false, null],
      ["AAA_CEI_AHU_7", 1, true, "ZZTestStation"],
      ["AAA_CEI_AHU_8", 1, true, "ZZTestStation"],
    ]);
  });
});
