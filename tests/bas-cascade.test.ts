import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import {
  getCollectionHealth,
  getPointExplorer,
} from "@/lib/modules/bas/service";
import { requireModuleAccess } from "@/lib/authz";
import { describeHiddenRisk, scopeSuffix } from "@/lib/modules/bas/types";
import {
  CASCADE_CLEARS,
  PROJECT_PARAM,
  SITE_PARAM,
  STATION_PARAM,
  POINT_PARAM,
  readFilters,
  withCascade,
} from "@/app/(modules)/bas/filters";
import { GET as healthRoute } from "@/app/api/modules/bas/collection-health/route";
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

function healthRequest(query = ""): Request {
  return new Request(
    "http://localhost/api/modules/bas/collection-health" + query,
  );
}

interface Fixture {
  libertyId: bigint;
  kenwoodId: bigint;
  northId: bigint;
  southId: bigint;
  mallId: bigint;
  northStationId: bigint;
  southStationId: bigint;
  mallStationId: bigint;
}

let fx: Fixture;

/**
 * Two projects, three buildings, three JACEs, and exactly one point at risk -
 * in Kenwood Mall.
 *
 * That last detail is the whole fixture. Filtering to Liberty Center gives a
 * view where every tile reads healthy while a point is losing data elsewhere,
 * which is the failure this phase exists to make impossible.
 */
async function seedFixture(): Promise<Fixture> {
  const org = await testDb.basOrg.create({ data: { name: "ZZTEST_X_ORG" } });

  const liberty = await testDb.basProject.create({
    data: { orgId: org.orgId, name: "ZZTEST_X_Liberty Center" },
  });
  const kenwood = await testDb.basProject.create({
    data: { orgId: org.orgId, name: "ZZTEST_X_Kenwood Mall" },
  });

  const site = async (projectId: bigint, name: string) =>
    testDb.basSite.create({
      data: {
        orgId: org.orgId,
        projectId,
        name,
        timezone: "America/New_York",
      },
    });

  const north = await site(liberty.projectId, "ZZTEST_X_North Building");
  const south = await site(liberty.projectId, "ZZTEST_X_South Building");
  const mall = await site(kenwood.projectId, "ZZTEST_X_Mall Building");

  const station = async (siteId: bigint, name: string) =>
    testDb.basStation.create({
      data: { siteId, niagaraStationName: name, connectionMode: "direct" },
    });

  const northStation = await station(north.siteId, "ZZTestNorthJACE");
  const southStation = await station(south.siteId, "ZZTestSouthJACE");
  const mallStation = await station(mall.siteId, "ZZTestMallJACE");

  /**
   * A point, with a checkpoint placed so roll_risk lands where we want it.
   *
   * roll_risk is computed by bas_v_collection_health from capacity *
   * collection_interval_s against how long ago the last record was, so the
   * state is produced by MOVING TIME rather than by writing the risk column -
   * the same discipline tests/bas-fixture.ts uses.
   */
  const point = async (
    stationId: bigint,
    name: string,
    agoSeconds: number,
  ) => {
    const row = await testDb.basPoint.create({
      data: {
        stationId,
        niagaraHistoryName: name,
        dataType: "real",
        // 500 * 900 = 450000s horizon. Half of it is 62.5 hours.
        capacity: 500,
        collectionIntervalS: 900,
      },
    });
    await testDb.basSyncCheckpoint.create({
      data: {
        pointId: row.pointId,
        lastRecordTs: new Date(Date.now() - agoSeconds * 1000),
        lastStatus: "ok",
      },
    });
    return row;
  };

  // Healthy: minutes old, well inside half the horizon.
  await point(northStation.stationId, "ZZTestNorthPoint", 600);
  await point(southStation.stationId, "ZZTestSouthPoint", 600);
  // AT RISK: past half the roll horizon, not yet past all of it.
  await point(mallStation.stationId, "ZZTestMallPoint", 300_000);

  return {
    libertyId: liberty.projectId,
    kenwoodId: kenwood.projectId,
    northId: north.siteId,
    southId: south.siteId,
    mallId: mall.siteId,
    northStationId: northStation.stationId,
    southStationId: southStation.stationId,
    mallStationId: mallStation.stationId,
  };
}

async function dropBas() {
  await testDb.basIngestRun.deleteMany({
    where: { station: { niagaraStationName: { contains: "ZZTest" } } },
  });
  await testDb.basPoint.deleteMany({
    where: { niagaraHistoryName: { startsWith: "ZZTest" } },
  });
  await testDb.basStation.deleteMany({
    where: { niagaraStationName: { contains: "ZZTest" } },
  });
  await testDb.basSite.deleteMany({ where: { name: { startsWith: "ZZTEST_X" } } });
  await testDb.basProject.deleteMany({
    where: { name: { startsWith: "ZZTEST_X" } },
  });
  await testDb.basOrg.deleteMany({ where: { name: { startsWith: "ZZTEST_X" } } });
}

async function basViewer() {
  const employee = await createEmployee();
  await grantModule(employee.id, BAS_MODULE_KEY);
  signedInAs(employee.entraOid!);
  const access = await requireModuleAccess(BAS_MODULE_KEY);
  if (!access.ok) throw new Error(`expected access, got ${access.denial}`);
  return access.viewer;
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetBasAvailabilityCache();
  await dropBas();
  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();
  fx = await seedFixture();
});

afterAll(async () => {
  await dropBas();
  await disconnectDb();
});

// ---------------------------------------------------------------------------
// THE TRAP. A filtered view must never look healthier than the estate is.
// ---------------------------------------------------------------------------

describe("a filter can hide a problem, and the screen has to say so", () => {
  it("counts only the filtered set, which is why the rest of this matters", async () => {
    const viewer = await basViewer();

    const all = await getCollectionHealth(viewer, {});
    expect(all.totals.pointsAtRisk).toBe(1);

    const liberty = await getCollectionHealth(viewer, {
      projectId: fx.libertyId,
    });
    // Correct, and dangerous on its own.
    expect(liberty.totals.pointsAtRisk).toBe(0);
    expect(liberty.totals.activePoints).toBe(2);
  });

  /**
   * THE ASSERTION THE PHASE EXISTS FOR.
   *
   * Filter to a project with nothing at risk, while a point is at risk
   * elsewhere. The payload must carry enough for the screen to refuse to read
   * as all-clear.
   */
  it("does NOT read as all-clear when an at-risk point is outside the filter", async () => {
    const viewer = await basViewer();
    const health = await getCollectionHealth(viewer, {
      projectId: fx.libertyId,
    });

    expect(health.totals.pointsAtRisk).toBe(0);

    // The unfiltered comparison came back, scoped to the entitlement.
    expect(health.unfiltered).not.toBeNull();
    expect(health.unfiltered?.pointsAtRisk).toBe(1);

    // And the screen has a sentence to render.
    const warning = describeHiddenRisk(health);
    expect(warning).not.toBeNull();
    expect(warning).toContain("1");
    expect(warning).toContain("at risk elsewhere");
    // It names where you are, so the reader can tell what was excluded.
    expect(warning).toContain("Liberty Center");
  });

  /**
   * The unfiltered comparison is scoped to the ENTITLEMENT, and this is a
   * structural test because no behavioural one can catch it today.
   *
   * Found by mutation. Replacing the entitlement predicate with TRUE passed
   * every test in this file, because `basSiteScope` currently returns `null`
   * for everyone - one org, one entitlement, no difference to observe. The day
   * bas_site_grant exists, that mutation becomes "outside your filter" quietly
   * meaning "outside your permissions", which is a disclosure the module guard
   * spends its whole existence preventing.
   *
   * Coarse, and the only thing that catches it. Same reasoning as the
   * `matched`-is-its-own-query check in bas-settings-filters.test.ts.
   */
  it("scopes the unfiltered comparison to the entitlement, not the whole table", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await readFile(
      path.join(process.cwd(), "lib/modules/bas/service.ts"),
      "utf8",
    );

    const query = source.slice(
      source.indexOf("const unfiltered = selection.filtered"),
      source.indexOf('"unfiltered totals"'),
    );

    expect(query.length).toBeGreaterThan(0);
    expect(query).toContain("siteFilter(entitled");
    // Never an unscoped count.
    expect(query).not.toMatch(/WHERE\s+TRUE/);
  });

  it("says nothing when the filter hides no risk", async () => {
    const viewer = await basViewer();

    // Kenwood holds the only at-risk point, so nothing is hidden.
    const kenwood = await getCollectionHealth(viewer, {
      projectId: fx.kenwoodId,
    });
    expect(kenwood.totals.pointsAtRisk).toBe(1);
    expect(describeHiddenRisk(kenwood)).toBeNull();
  });

  it("says nothing at all when nothing is filtered", async () => {
    const viewer = await basViewer();
    const all = await getCollectionHealth(viewer, {});

    expect(all.scope.filtered).toBe(false);
    expect(all.scope.label).toBeNull();
    // Skipped entirely rather than computed and ignored.
    expect(all.unfiltered).toBeNull();
    expect(describeHiddenRisk(all)).toBeNull();
  });

  /**
   * Every tile has to say what it is counting. "0 at risk" and "0 at risk in
   * Liberty Center" are different claims and only one of them is true.
   */
  it("gives every tile a scope to append", async () => {
    const viewer = await basViewer();

    const filtered = await getCollectionHealth(viewer, {
      projectId: fx.libertyId,
      siteId: fx.northId,
    });
    expect(scopeSuffix(filtered.scope)).toBe(
      " in ZZTEST_X_Liberty Center → ZZTEST_X_North Building",
    );

    const all = await getCollectionHealth(viewer, {});
    // Unfiltered reads exactly as it did before B7.6.
    expect(scopeSuffix(all.scope)).toBe("");
  });

  it("phrases it differently when the filtered view is not itself clean", () => {
    const warning = describeHiddenRisk({
      totals: { pointsAtRisk: 2 },
      unfiltered: { activePoints: 40, pointsAtRisk: 5 },
      scope: { filtered: true, label: "Kenwood Mall" },
    });
    expect(warning).toBe("3 more points are at risk outside Kenwood Mall.");
  });

  it("is silent when the unfiltered estate is no worse", () => {
    expect(
      describeHiddenRisk({
        totals: { pointsAtRisk: 3 },
        unfiltered: { activePoints: 40, pointsAtRisk: 3 },
        scope: { filtered: true, label: "Kenwood Mall" },
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The cascade
// ---------------------------------------------------------------------------

describe("Project -> Building -> JACE narrows in SQL", () => {
  it("defaults to everything with no selection", async () => {
    const viewer = await basViewer();
    const health = await getCollectionHealth(viewer, {});

    expect(health.totals.activePoints).toBe(3);
    expect(health.projects).toHaveLength(2);
    expect(health.sites).toHaveLength(3);
    expect(health.stations).toHaveLength(3);
  });

  it("narrows buildings to the chosen project", async () => {
    const viewer = await basViewer();
    const health = await getCollectionHealth(viewer, {
      projectId: fx.libertyId,
    });

    expect(health.sites.map((s) => s.name).sort()).toEqual([
      "ZZTEST_X_North Building",
      "ZZTEST_X_South Building",
    ]);
    // The project list itself is NOT narrowed - a dropdown that lost its other
    // options the moment you picked one could not be used to pick again.
    expect(health.projects).toHaveLength(2);
  });

  it("narrows JACEs to the chosen building", async () => {
    const viewer = await basViewer();
    const health = await getCollectionHealth(viewer, {
      projectId: fx.libertyId,
      siteId: fx.northId,
    });

    expect(health.stations.map((s) => s.name)).toEqual(["ZZTestNorthJACE"]);
    expect(health.totals.activePoints).toBe(1);
  });

  it("narrows the figures to the chosen JACE", async () => {
    const viewer = await basViewer();
    const health = await getCollectionHealth(viewer, {
      stationId: fx.mallStationId,
    });

    expect(health.totals.activePoints).toBe(1);
    expect(health.totals.pointsAtRisk).toBe(1);
    expect(health.points.map((p) => p.pointName)).toEqual(["ZZTestMallPoint"]);
  });

  /**
   * A building that is not in the selected project is refused, not silently
   * ignored. Showing the data anyway would render something the URL did not
   * ask for; ignoring the project would do the same.
   */
  it("refuses a building outside the selected project", async () => {
    const viewer = await basViewer();

    await expect(
      getCollectionHealth(viewer, {
        projectId: fx.libertyId,
        siteId: fx.mallId,
      }),
    ).rejects.toThrow(/not available/);
  });

  it("refuses a JACE outside the selected building", async () => {
    const viewer = await basViewer();

    await expect(
      getCollectionHealth(viewer, {
        siteId: fx.northId,
        stationId: fx.mallStationId,
      }),
    ).rejects.toThrow(/not available/);
  });

  it("renders that refusal as 404 through the route", async () => {
    await basViewer();

    const response = await healthRoute(
      healthRequest(`?project=${fx.libertyId}&site=${fx.mallId}`),
    );
    expect(response.status).toBe(404);
  });

  it("refuses an id that is not a number rather than 500ing", async () => {
    await basViewer();
    expect(
      (await healthRoute(healthRequest("?project=not-a-number"))).status,
    ).toBe(404);
    expect(
      (await healthRoute(healthRequest("?station=%27%3B--"))).status,
    ).toBe(404);
  });

  /**
   * Filtered in the WHERE clause, not by fetching everything and hiding rows.
   * Asserted on the payload: the excluded points must not be in it at all.
   */
  it("does not ship the excluded points to the client", async () => {
    await basViewer();

    const response = await healthRoute(
      healthRequest(`?project=${fx.libertyId}`),
    );
    const text = await response.text();

    expect(text).toContain("ZZTestNorthPoint");
    expect(text).not.toContain("ZZTestMallPoint");
  });
});

// ---------------------------------------------------------------------------
// Point Explorer
// ---------------------------------------------------------------------------

describe("the cascade narrows which points are selectable", () => {
  it("offers every point with no selection", async () => {
    const viewer = await basViewer();
    const explorer = await getPointExplorer(viewer, {});
    expect(explorer.points).toHaveLength(3);
  });

  it("offers only the chosen project's points", async () => {
    const viewer = await basViewer();
    const explorer = await getPointExplorer(viewer, {
      projectId: fx.libertyId,
    });

    expect(explorer.points.map((p) => p.pointName).sort()).toEqual([
      "ZZTestNorthPoint",
      "ZZTestSouthPoint",
    ]);
  });

  it("offers only the chosen JACE's points", async () => {
    const viewer = await basViewer();
    const explorer = await getPointExplorer(viewer, {
      stationId: fx.southStationId,
    });

    expect(explorer.points.map((p) => p.pointName)).toEqual([
      "ZZTestSouthPoint",
    ]);
    expect(explorer.selectedPoint?.pointName).toBe("ZZTestSouthPoint");
  });

  it("carries the same three dropdowns as Collection Health", async () => {
    const viewer = await basViewer();
    const explorer = await getPointExplorer(viewer, {
      projectId: fx.libertyId,
    });

    expect(explorer.projects).toHaveLength(2);
    expect(explorer.sites).toHaveLength(2);
    expect(explorer.selectedProjectName).toBe("ZZTEST_X_Liberty Center");
    expect(explorer.scope.filtered).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The URL, and the clearing rule
// ---------------------------------------------------------------------------

describe("all four live in the URL and higher levels clear lower ones", () => {
  const read = (query: string) => readFilters(new URLSearchParams(query));
  const cascade = (query: string, key: string, value: string | null) =>
    withCascade(new URLSearchParams(query), key, value);

  it("reads all four", () => {
    expect(read("project=2&site=5&station=9&days=30")).toMatchObject({
      projectId: "2",
      siteId: "5",
      stationId: "9",
      windowDays: 30,
    });
  });

  /**
   * THE ONE THE BRIEF CALLED OUT. Pick Liberty -> North, switch to Kenwood, and
   * North has to clear - otherwise the selection names a building that is not
   * in the project, the server answers 404, and the screen goes blank with
   * nothing saying why.
   */
  it("clears the building and JACE when the project changes", () => {
    const next = cascade("project=1&site=5&station=9", PROJECT_PARAM, "2");
    const filters = read(next.replace(/^\?/, ""));

    expect(filters.projectId).toBe("2");
    expect(filters.siteId).toBeNull();
    expect(filters.stationId).toBeNull();
  });

  it("clears the JACE when the building changes, and keeps the project", () => {
    const next = cascade("project=1&site=5&station=9", SITE_PARAM, "6");
    const filters = read(next.replace(/^\?/, ""));

    expect(filters.projectId).toBe("1");
    expect(filters.siteId).toBe("6");
    expect(filters.stationId).toBeNull();
  });

  it("clears the point at every level, because a point can be stranded too", () => {
    for (const key of [PROJECT_PARAM, SITE_PARAM, STATION_PARAM]) {
      const next = cascade("project=1&site=5&station=9&point=41", key, "2");
      expect(read(next.replace(/^\?/, "")).pointId).toBeNull();
    }
  });

  it("keeps the time range across a cascade change", () => {
    const next = cascade("project=1&site=5&days=30", PROJECT_PARAM, "2");
    expect(read(next.replace(/^\?/, "")).windowDays).toBe(30);
  });

  it("clearing a level to All also clears below it", () => {
    const next = cascade("project=1&site=5&station=9", PROJECT_PARAM, null);
    const filters = read(next.replace(/^\?/, ""));

    expect(filters.projectId).toBeNull();
    expect(filters.siteId).toBeNull();
    expect(filters.stationId).toBeNull();
  });

  it("declares the clearing rule in one place", () => {
    // The table is the rule. A level that forgot to clear the point would be a
    // silent dead end, so the shape is asserted rather than left implicit.
    expect(CASCADE_CLEARS[PROJECT_PARAM]).toEqual([
      SITE_PARAM,
      STATION_PARAM,
      POINT_PARAM,
    ]);
    expect(CASCADE_CLEARS[SITE_PARAM]).toEqual([STATION_PARAM, POINT_PARAM]);
    expect(CASCADE_CLEARS[STATION_PARAM]).toEqual([POINT_PARAM]);
  });

  it("survives a round trip through the route", async () => {
    await basViewer();

    const response = await healthRoute(
      healthRequest(`?project=${fx.libertyId}&site=${fx.northId}`),
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      data: {
        selectedProjectId: string;
        selectedSiteId: string;
        scope: { filtered: boolean };
      };
    };
    expect(body.data.selectedProjectId).toBe(fx.libertyId.toString());
    expect(body.data.selectedSiteId).toBe(fx.northId.toString());
    expect(body.data.scope.filtered).toBe(true);
  });
});
