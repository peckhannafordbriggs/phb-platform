import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Only the session is mocked. The service, its SQL, the routes, the pages and
// the cards are the real ones.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import type { Viewer } from "@/lib/authz";
import { BAS_MODULE_KEY, NO_POINT } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import {
  getCollectionHealth,
  getDashboard,
  getPointExplorer,
} from "@/lib/modules/bas/service";
import type { BasDashboard, DashboardProject } from "@/lib/modules/bas/types";
import { basFigure } from "@/lib/home/bas-figure";
import { BasShell } from "@/app/(modules)/bas/bas-shell";
import { CollectionHealth } from "@/app/(modules)/bas/collection-health";
import { Dashboard, DashboardCards, describeCounts } from "@/app/(modules)/bas/dashboard";
import { BasSettings } from "@/app/(modules)/bas/settings-view";
import { BAS_TABS, basTab } from "@/app/(modules)/bas/tabs";
import {
  POINT_PARAM,
  PROJECT_PARAM,
  dashboardCardHref,
  readFilters,
  withCascade,
} from "@/app/(modules)/bas/filters";
import { GET as dashboardRoute } from "@/app/api/modules/bas/dashboard/route";
import { GET as explorerRoute } from "@/app/api/modules/bas/point-explorer/route";
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
 * The Dashboard tab (2026-09-30): one card per project, and the module opens
 * on it.
 *
 * What is held here, in order:
 *
 *   1. One card per project ROW, with counts that match the database counted
 *      directly - independently of the joins that built the card - and a
 *      joinless guard the screen can compare against.
 *   2. A project with no active point gets counts and NO health line.
 *   3. The module opens on the Dashboard; deep links to Collection Health
 *      and Settings still open those.
 *   4. A card's href lands on Point Explorer with the project set and nothing
 *      loaded, and the dropdowns still work afterwards.
 *   5. The wording: "No points at risk" calm, "N points at risk" in the mark.
 *
 * The at-risk NUMBER on a card - that it is the one predicate, scoped to the
 * project, equal to Collection Health filtered to it - is held in
 * tests/bas-at-risk-predicate.test.ts alongside every other surface, where a
 * change to the list fails them all together.
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

const PREFIX = "ZZDASH_";
const HOUR = 3_600_000;

interface Fixture {
  liberty: bigint;
  stationless: bigint;
  pointless: bigint;
  empty: bigint;
  libertyNorthSite: bigint;
  libertySouthSite: bigint;
  libertyNorthStation: bigint;
  libertySouthStation: bigint;
  healthyPoint: bigint;
}

let viewer: Viewer;
let fx: Fixture;

/**
 * Four projects, in four states:
 *
 *   Liberty      two buildings, two JACEs, three points: one healthy with a
 *                reading five minutes old, one at risk, one HIDDEN and lost.
 *                Two at risk, and the hidden one is one of them.
 *   Stationless  one building, no JACE.
 *   Pointless    one building, one JACE, nothing discovered.
 *   Empty        no buildings at all.
 *
 * Risk states are produced by moving time, as tests/bas-fixture.ts does:
 * capacity 500 x 900 s is a 125 h horizon, half is 62.5 h.
 */
async function seed(): Promise<Fixture> {
  const org = await testDb.basOrg.create({ data: { name: `${PREFIX}ORG` } });
  const project = (name: string) =>
    testDb.basProject.create({ data: { orgId: org.orgId, name: `${PREFIX}${name}` } });

  const liberty = await project("Liberty Center");
  const stationless = await project("Stationless");
  const pointless = await project("Pointless");
  const empty = await project("Empty");

  const site = (projectId: bigint, name: string) =>
    testDb.basSite.create({
      data: { orgId: org.orgId, projectId, name: `${PREFIX}${name}`, timezone: "America/New_York" },
    });
  const station = (siteId: bigint, name: string) =>
    testDb.basStation.create({
      data: { siteId, niagaraStationName: `${PREFIX}${name}`, connectionMode: "direct" },
    });

  const north = await site(liberty.projectId, "North");
  const south = await site(liberty.projectId, "South");
  const northStation = await station(north.siteId, "NorthJACE");
  const southStation = await station(south.siteId, "SouthJACE");

  const lonely = await site(stationless.projectId, "Lonely");
  void lonely;
  const quiet = await site(pointless.projectId, "Quiet");
  await station(quiet.siteId, "QuietJACE");

  const now = Date.now();
  const point = async (
    stationId: bigint,
    name: string,
    agoMs: number,
    visible = true,
  ) => {
    const row = await testDb.basPoint.create({
      data: {
        stationId,
        niagaraHistoryName: `${PREFIX}${name}`,
        dataType: "real",
        capacity: 500,
        collectionIntervalS: 900,
        fullPolicy: "roll",
        isVisible: visible,
        checkpoint: {
          create: {
            lastRecordTs: new Date(now - agoMs),
            lastRunAt: new Date(now - agoMs),
            lastStatus: "ok",
          },
        },
      },
    });
    return row.pointId;
  };

  const healthyPoint = await point(northStation.stationId, "Healthy", 5 * 60_000);
  await point(northStation.stationId, "AtRisk", 100 * HOUR);
  await point(southStation.stationId, "LostHidden", 200 * HOUR, false);

  // The project's newest reading: five minutes old, on the healthy point.
  await testDb.basReading.createMany({
    data: [
      { pointId: healthyPoint, ts: new Date(now - 65 * 60_000), valueNum: 70.1 },
      { pointId: healthyPoint, ts: new Date(now - 5 * 60_000), valueNum: 70.4 },
    ],
  });

  return {
    liberty: liberty.projectId,
    stationless: stationless.projectId,
    pointless: pointless.projectId,
    empty: empty.projectId,
    libertyNorthSite: north.siteId,
    libertySouthSite: south.siteId,
    libertyNorthStation: northStation.stationId,
    libertySouthStation: southStation.stationId,
    healthyPoint,
  };
}

async function drop(): Promise<void> {
  await testDb.basPoint.deleteMany({ where: { niagaraHistoryName: { startsWith: PREFIX } } });
  await testDb.basStation.deleteMany({ where: { niagaraStationName: { startsWith: PREFIX } } });
  await testDb.basSite.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await testDb.basProject.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await testDb.basOrg.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetBasAvailabilityCache();
  await drop();
  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();
  fx = await seed();

  const employee = await createEmployee({ entraOid: "oid-dash" });
  await grantModule(employee.id, BAS_MODULE_KEY);
  signedInAs("oid-dash");
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
  await drop();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDb();
});

const byName = (d: BasDashboard, name: string) =>
  d.projects.find((p) => p.name === `${PREFIX}${name}`) as DashboardProject;

// =============================================================================
// 1. One card per project row, counted independently
// =============================================================================

describe("one card per project row, from bas_projects", () => {
  it("renders exactly the projects in the database, in org-then-name order", async () => {
    const dashboard = await getDashboard(viewer);

    const inDatabase = await testDb.basProject.findMany({ orderBy: { name: "asc" } });
    expect(inDatabase).toHaveLength(4);
    expect(dashboard.projects.map((p) => p.projectId)).toEqual(
      inDatabase.map((p) => p.projectId.toString()),
    );
    // The guard the screen compares against: a joinless count(*).
    expect(dashboard.projectsInDatabase).toBe(4);
    expect(dashboard.projectsInDatabase).toBe(dashboard.projects.length);
  });

  it("counts buildings and JACEs as the database does, independently of the card join", async () => {
    const dashboard = await getDashboard(viewer);

    for (const project of dashboard.projects) {
      const projectId = BigInt(project.projectId);
      const buildings = await testDb.basSite.count({ where: { projectId } });
      const stations = await testDb.basStation.count({ where: { site: { projectId } } });
      expect(project.buildings, `${project.name} buildings`).toBe(buildings);
      expect(project.stations, `${project.name} JACEs`).toBe(stations);
    }

    // And absolutely, so the loop above is not vacuous.
    expect(byName(dashboard, "Liberty Center")).toMatchObject({ buildings: 2, stations: 2 });
    expect(byName(dashboard, "Stationless")).toMatchObject({ buildings: 1, stations: 0 });
    expect(byName(dashboard, "Pointless")).toMatchObject({ buildings: 1, stations: 1 });
    expect(byName(dashboard, "Empty")).toMatchObject({ buildings: 0, stations: 0 });
  });

  it("a project with two buildings and three points is ONE card, not three", async () => {
    // The card query LEFT JOINs buildings and the health view. Without the
    // GROUP BY it would produce a row per point; this is the row count the
    // guard exists to catch, asserted directly as well.
    const dashboard = await getDashboard(viewer);
    expect(dashboard.projects.filter((p) => p.name === `${PREFIX}Liberty Center`)).toHaveLength(1);
  });

  it("a project created with nothing under it gets a card the moment it exists", async () => {
    const dashboard = await getDashboard(viewer);
    expect(byName(dashboard, "Empty")).toBeDefined();
  });

  it("says so when there are no projects at all", async () => {
    await drop();
    const dashboard = await getDashboard(viewer);
    expect(dashboard.projects).toEqual([]);
    expect(dashboard.projectsInDatabase).toBe(0);
  });
});

// =============================================================================
// 2. Health: present when there is something to have it, else absent
// =============================================================================

describe("the health line", () => {
  it("is the project's Collection Health, scoped: two at risk, the hidden one counted", async () => {
    const dashboard = await getDashboard(viewer);
    const card = byName(dashboard, "Liberty Center");
    const filtered = await getCollectionHealth(viewer, { projectId: fx.liberty });

    expect(card.health).not.toBeNull();
    expect(card.health!.activePoints).toBe(3);
    expect(card.health!.pointsAtRisk).toBe(2);
    expect(card.health!.pointsAtRisk).toBe(filtered.totals.pointsAtRisk);
    expect(card.health!.riskCounts).toEqual(filtered.totals.riskCounts);
    // The hidden, lost point is in the figure.
    expect(filtered.totals.hiddenPointsAtRisk).toBe(1);
    expect(card.health!.riskCounts.data_lost).toBe(1);
  });

  it("carries the newest reading's age, from the same query Collection Health runs", async () => {
    const dashboard = await getDashboard(viewer);
    const card = byName(dashboard, "Liberty Center");
    const filtered = await getCollectionHealth(viewer, { projectId: fx.liberty });

    expect(card.health!.minutesSinceNewestReading).not.toBeNull();
    expect(card.health!.minutesSinceNewestReading!).toBeGreaterThanOrEqual(5);
    expect(card.health!.minutesSinceNewestReading!).toBeLessThan(6);
    // Two transactions, two now()s, a few milliseconds apart.
    expect(
      Math.abs(card.health!.minutesSinceNewestReading! - filtered.totals.minutesSinceNewestReading!),
    ).toBeLessThan(0.5);
    // Worded by the Home tile's function, so the card says what Home says.
    expect(basFigure(card.health!)).toEqual({
      state: "ok",
      value: "2 points at risk",
      status: "newest reading 5 min ago",
      alarm: true,
    });
  });

  it("is ABSENT for a project with no active point, however many buildings and JACEs it has", async () => {
    const dashboard = await getDashboard(viewer);
    // No stations: the case the spec names.
    expect(byName(dashboard, "Stationless").health).toBeNull();
    expect(byName(dashboard, "Empty").health).toBeNull();
    // A JACE registered and nothing discovered yet: still nothing to be
    // healthy. "No points at risk" over zero points would be invented.
    expect(byName(dashboard, "Pointless").health).toBeNull();
  });

  it("appears the moment the project has one active point, and reads calm when it is fine", async () => {
    const quietStation = await testDb.basStation.findFirstOrThrow({
      where: { niagaraStationName: `${PREFIX}QuietJACE` },
    });
    await testDb.basPoint.create({
      data: {
        stationId: quietStation.stationId,
        niagaraHistoryName: `${PREFIX}First`,
        dataType: "real",
        capacity: 500,
        collectionIntervalS: 900,
        fullPolicy: "roll",
        checkpoint: {
          create: { lastRecordTs: new Date(), lastRunAt: new Date(), lastStatus: "ok" },
        },
      },
    });

    const card = byName(await getDashboard(viewer), "Pointless");
    expect(card.health).toMatchObject({ activePoints: 1, pointsAtRisk: 0 });
    // No readings yet, and that is said as such, never as a healthy zero.
    expect(basFigure(card.health!)).toEqual({
      state: "none",
      value: "No points at risk",
      status: "No readings yet",
    });
  });
});

// =============================================================================
// 3. The module opens on the Dashboard; deep links still work
// =============================================================================

describe("the module opens on the Dashboard", () => {
  type ShellElement = ReactElement<{ blurb: string; children: ReactElement }>;

  it("/bas renders the Dashboard inside the shell", async () => {
    const BasPage = (await import("@/app/(modules)/bas/page")).default;
    const element = (await BasPage()) as ShellElement;

    expect(element.type).toBe(BasShell);
    expect(element.props.children.type).toBe(Dashboard);
    expect(element.props.blurb).toBe(basTab("/bas").blurb);
    expect(BAS_TABS[0]).toMatchObject({ href: "/bas", label: "Dashboard" });
  });

  it("/bas/health renders Collection Health - the deep link moved with the screen", async () => {
    const HealthPage = (await import("@/app/(modules)/bas/health/page")).default;
    const element = (await HealthPage()) as ShellElement;

    expect(element.type).toBe(BasShell);
    expect(element.props.children.type).toBe(CollectionHealth);
    expect(element.props.blurb).toBe(basTab("/bas/health").blurb);
  });

  it("/bas/settings still opens Settings for a module admin", async () => {
    const admin = await createEmployee({ entraOid: "oid-dash-admin" });
    await grantModule(admin.id, BAS_MODULE_KEY);
    await grantModuleAdmin(admin.id, BAS_MODULE_KEY);
    signedInAs("oid-dash-admin");

    const SettingsPage = (await import("@/app/(modules)/bas/settings/page")).default;
    const element = (await SettingsPage()) as ShellElement;

    expect(element.type).toBe(BasShell);
    expect(element.props.children.type).toBe(BasSettings);
  });

  it("/bas/points still opens Point Explorer with its first point, unchanged", async () => {
    // The default landing changed; the Point Explorer's own default did not.
    const explorer = await getPointExplorer(viewer, { projectId: fx.liberty });
    expect(explorer.selectedPoint).not.toBeNull();
    expect(explorer.selectedPoint!.pointName).toBe(`${PREFIX}AtRisk`);
  });
});

// =============================================================================
// 4. Clicking a card
// =============================================================================

describe("clicking a card", () => {
  it("links to Point Explorer with the project set and no point", () => {
    const href = dashboardCardHref("41");
    expect(href).toBe("/bas/points?project=41&point=none");

    const filters = readFilters(new URLSearchParams(href.split("?")[1]));
    expect(filters.projectId).toBe("41");
    expect(filters.pointId).toBe(NO_POINT);
    expect(filters.siteId).toBeNull();
    expect(filters.stationId).toBeNull();
  });

  it("yields the project's lists narrowed to it, and nothing loaded", async () => {
    const explorer = await getPointExplorer(viewer, {
      projectId: fx.liberty,
      selectPoint: false,
    });

    // The Project dropdown reads the project; the other two are narrowed to it.
    expect(explorer.selectedProjectId).toBe(fx.liberty.toString());
    expect(explorer.selectedProjectName).toBe(`${PREFIX}Liberty Center`);
    expect(explorer.sites.map((s) => s.siteId).sort()).toEqual(
      [fx.libertyNorthSite, fx.libertySouthSite].map(String).sort(),
    );
    expect(explorer.stations.map((s) => s.stationId).sort()).toEqual(
      [fx.libertyNorthStation, fx.libertySouthStation].map(String).sort(),
    );
    // The point list is there to pick from - the hidden point is not in it,
    // exactly as on any other visit - and nothing is chosen.
    expect(explorer.points.map((p) => p.pointName).sort()).toEqual(
      [`${PREFIX}AtRisk`, `${PREFIX}Healthy`].sort(),
    );
    expect(explorer.selectedPoint).toBeNull();
    // Nothing was queried for a point: zero readings, an empty trend.
    expect(explorer.stats.readings).toBe(0);
    expect(explorer.trend).toEqual([]);
    // The Project dropdown still offers every OTHER project with a building,
    // so it can be changed. The cascade has always listed only projects that
    // have one - "Empty" is not here, which is why its card is not a link.
    expect(explorer.projects.map((p) => p.name).sort()).toEqual(
      ["Liberty Center", "Pointless", "Stationless"].map((n) => `${PREFIX}${n}`).sort(),
    );
  });

  it("a project with a building and no JACE still opens: an empty picker that says so", async () => {
    const explorer = await getPointExplorer(viewer, {
      projectId: fx.stationless,
      selectPoint: false,
    });
    expect(explorer.selectedProjectId).toBe(fx.stationless.toString());
    expect(explorer.sites).toHaveLength(1);
    expect(explorer.stations).toEqual([]);
    expect(explorer.points).toEqual([]);
    expect(explorer.selectedPoint).toBeNull();
  });

  it("a project with no building is refused by the cascade, so its card must not link there", async () => {
    await expect(
      getPointExplorer(viewer, { projectId: fx.empty, selectPoint: false }),
    ).rejects.toMatchObject({ code: "site_not_found" });
  });

  it("goes through the route as ?point=none, and the same URL without it loads a point", async () => {
    const none = await explorerRoute(
      new Request(`http://localhost/api/modules/bas/point-explorer?project=${fx.liberty}&point=${NO_POINT}`),
    );
    expect(none.status).toBe(200);
    const noneBody = (await none.json()) as { data: { selectedPoint: unknown; points: unknown[]; selectedProjectId: string } };
    expect(noneBody.data.selectedPoint).toBeNull();
    expect(noneBody.data.points).toHaveLength(2);
    expect(noneBody.data.selectedProjectId).toBe(fx.liberty.toString());

    const first = await explorerRoute(
      new Request(`http://localhost/api/modules/bas/point-explorer?project=${fx.liberty}`),
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { data: { selectedPoint: { pointName: string } | null } };
    expect(firstBody.data.selectedPoint?.pointName).toBe(`${PREFIX}AtRisk`);
  });

  it("changing the project afterwards clears the none marker and loads that project's first point", () => {
    // The dropdown's own writer. `point` is below `project` in the cascade,
    // so switching project drops it - and an absent `point` is the picker's
    // first, as it always was.
    const arrived = new URLSearchParams(dashboardCardHref("41").split("?")[1]);
    const switched = withCascade(arrived, PROJECT_PARAM, "42");
    const filters = readFilters(new URLSearchParams(switched.replace(/^\?/, "")));
    expect(filters.projectId).toBe("42");
    expect(filters.pointId).toBeNull();
    expect(switched).not.toContain(POINT_PARAM);
  });
});

// =============================================================================
// 5. The route
// =============================================================================

describe("the dashboard route", () => {
  it("is behind the module grant like every other BAS route", async () => {
    authMock.mockResolvedValue(null as never);
    expect((await dashboardRoute()).status).toBe(401);

    await createEmployee({ entraOid: "oid-dash-nogrant" });
    signedInAs("oid-dash-nogrant");
    expect((await dashboardRoute()).status).toBe(404);
  });

  it("returns the cards for a granted employee", async () => {
    const response = await dashboardRoute();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: BasDashboard };
    expect(body.data.projects).toHaveLength(4);
    expect(body.data.projectsInDatabase).toBe(4);
    expect(byName(body.data, "Liberty Center").health?.pointsAtRisk).toBe(2);
  });
});

// =============================================================================
// 6. The cards as rendered
// =============================================================================

describe("the cards as rendered", () => {
  const project = (over: Partial<DashboardProject>): DashboardProject => ({
    projectId: "1",
    name: "Liberty Center",
    orgName: "PH+B",
    buildings: 2,
    stations: 2,
    health: null,
    ...over,
  });
  const risks = (over: Partial<Record<string, number>> = {}) => ({
    ok: 0,
    at_risk: 0,
    data_lost: 0,
    buffer_not_full: 0,
    roll_horizon_unknown: 0,
    never_collected: 0,
    ...over,
  });
  const render = (data: BasDashboard, canAdminister = false) =>
    renderToStaticMarkup(createElement(DashboardCards, { data, canAdminister }));
  const payload = (projects: DashboardProject[], inDatabase = projects.length): BasDashboard => ({
    observedAt: "2026-09-30T12:00:00.000Z",
    projects,
    projectsInDatabase: inDatabase,
  });

  it("renders one linked card per project, to Point Explorer with that project and no point", () => {
    const html = render(
      payload([project({ projectId: "7", name: "Liberty Center" }), project({ projectId: "9", name: "Kenwood Mall" })]),
    );
    const cards = [...html.matchAll(/data-testid="bas-dashboard-card"/g)];
    expect(cards).toHaveLength(2);
    expect(html).toContain('href="/bas/points?project=7&amp;point=none"');
    expect(html).toContain('href="/bas/points?project=9&amp;point=none"');
    expect(html).toContain("Liberty Center");
    expect(html).toContain("Kenwood Mall");
  });

  it("at zero: 'No points at risk', calm, with the newest reading under it", () => {
    const html = render(
      payload([
        project({
          health: { activePoints: 26, pointsAtRisk: 0, riskCounts: risks({ ok: 26 }), minutesSinceNewestReading: 4 },
        }),
      ]),
    );
    expect(html).toContain("No points at risk");
    expect(html).toContain("newest reading 4 min ago");
    expect(html).not.toContain("bas-dashboard-alarm");
  });

  it("at N: 'N points at risk' inside the maroon mark", () => {
    const html = render(
      payload([
        project({
          health: {
            activePoints: 26,
            pointsAtRisk: 2,
            riskCounts: risks({ ok: 24, at_risk: 1, data_lost: 1 }),
            minutesSinceNewestReading: 4,
          },
        }),
      ]),
    );
    const mark = /<span[^>]*data-testid="bas-dashboard-alarm"[^>]*>([^<]*)<\/span>/.exec(html);
    expect(mark).not.toBeNull();
    expect(mark![1]).toBe("2 points at risk");
    // The mark's colours live in one stylesheet rule, .card-mark - maroon,
    // white words, white edge. tests/bas-dashboard-colours.test.ts reads it.
    expect(mark![0]).toContain('class="card-mark"');
    expect(html).toContain("newest reading 4 min ago");
  });

  it("at one: singular", () => {
    const html = render(
      payload([
        project({
          health: { activePoints: 1, pointsAtRisk: 1, riskCounts: risks({ at_risk: 1 }), minutesSinceNewestReading: null },
        }),
      ]),
    );
    expect(html).toContain("1 point at risk");
    expect(html).toContain("No readings yet");
  });

  it("a project with nothing under it: '0 buildings · 0 JACEs', no health line, and no link", () => {
    const html = render(payload([project({ buildings: 0, stations: 0, health: null })]));
    expect(html).toContain("0 buildings · 0 JACEs");
    expect(html).toContain("bas-dashboard-card");
    expect(html).not.toContain("bas-dashboard-health");
    expect(html).not.toContain("points at risk");
    expect(html).not.toContain("newest reading");
    expect(html).not.toContain("No readings yet");
    // Point Explorer would answer 404 for a project with no building.
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("/bas/points");
  });

  it("a project with a building and no JACE: '1 building · 0 JACEs', no health line, still a link", () => {
    const html = render(payload([project({ projectId: "5", buildings: 1, stations: 0, health: null })]));
    expect(html).toContain("1 building · 0 JACEs");
    expect(html).not.toContain("bas-dashboard-health");
    expect(html).toContain('href="/bas/points?project=5&amp;point=none"');
  });

  it("counts read as counts: singular and plural, buildings and JACEs", () => {
    expect(describeCounts({ buildings: 2, stations: 2 })).toBe("2 buildings · 2 JACEs");
    expect(describeCounts({ buildings: 1, stations: 1 })).toBe("1 building · 1 JACE");
    expect(describeCounts({ buildings: 1, stations: 0 })).toBe("1 building · 0 JACEs");
    expect(describeCounts({ buildings: 0, stations: 0 })).toBe("0 buildings · 0 JACEs");
  });

  it("no projects: one line, pointing at Settings for an admin, naming it for anyone else", () => {
    const admin = render(payload([]), true);
    expect(admin).toContain("No projects yet.");
    expect(admin).toContain('href="/bas/settings"');
    expect(admin).not.toContain("bas-dashboard-card");

    // A plain BAS user is not offered the Settings tab, so not a link to it
    // either - a link that 404s would announce the surface the 404 hides.
    const user = render(payload([]), false);
    expect(user).toContain("No projects yet.");
    expect(user).toContain("Settings");
    expect(user).not.toContain('href="/bas/settings"');
  });

  it("says so, in red, when the cards do not account for every project", () => {
    const html = render(payload([project({})], 3));
    const alert = /<p[^>]*data-testid="bas-dashboard-count-mismatch"[^>]*>([^<]*)<\/p>/.exec(html);
    expect(alert).not.toBeNull();
    expect(alert![1]).toBe("2 projects are in the database but not shown here.");
    expect(alert![0]).toContain("var(--phb-maroon)");
    // The cards it does have are still drawn.
    expect(html).toContain("bas-dashboard-card");

    // And is silent when they agree.
    expect(render(payload([project({})]))).not.toContain("bas-dashboard-count-mismatch");
  });

  it("decides nothing about risk itself: no state name and no predicate in the component", async () => {
    // The card takes the service's number through basFigure. A component
    // that looked at a roll-risk state would be a candidate sixth definition.
    const source = await readFile(
      path.join(process.cwd(), "app/(modules)/bas/dashboard.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/isAtRisk|AT_RISK_ROLL_RISKS|atRiskCount|riskCounts|roll_risk|data_lost|never_collected/);
    expect(source).toContain("basFigure(");
  });
});
