import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { getBasSettingsTree } from "@/lib/modules/bas/settings-service";
import { requireModuleAdmin } from "@/lib/authz";
import {
  NO_SETTINGS_FILTERS,
  settingsCountState,
  settingsFiltersActive,
  type BasSettingsFilters,
  type BasSettingsTree,
} from "@/lib/modules/bas/types";
import {
  readSettingsFilters,
  settingsQuery,
} from "@/app/(modules)/bas/filters";
import { GET as settingsRoute } from "@/app/api/modules/bas/settings/route";
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

const authMock = vi.mocked(auth);

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

function treeRequest(query = ""): Request {
  return new Request("http://localhost/api/modules/bas/settings" + query);
}

const filters = (patch: Partial<BasSettingsFilters> = {}): BasSettingsFilters => ({
  ...NO_SETTINGS_FILTERS,
  ...patch,
});

let orgId: bigint;

/**
 * Two projects, three buildings, four stations, deliberately varied so every
 * filter has both a hit and a miss to distinguish.
 *
 *   Liberty Center
 *     North Building   ZZTestDirectFresh   direct, credential, collecting
 *                      ZZTestViaParent     via_parent, no credential, never
 *     South Building   ZZTestStale         direct, credential, stale
 *   Kenwood Mall
 *     Mall Building    ZZTestNoCred        direct, no credential, never
 */
async function seedFixture() {
  const org = await testDb.basOrg.create({ data: { name: "ZZTEST_F_ORG" } });
  orgId = org.orgId;

  const liberty = await testDb.basProject.create({
    data: { orgId, name: "ZZTEST_F_Liberty Center" },
  });
  const kenwood = await testDb.basProject.create({
    data: { orgId, name: "ZZTEST_F_Kenwood Mall" },
  });
  const north = await testDb.basSite.create({
    data: {
      orgId,
      projectId: liberty.projectId,
      name: "ZZTEST_F_North Building",
      timezone: "America/New_York",
    },
  });
  const south = await testDb.basSite.create({
    data: {
      orgId,
      projectId: liberty.projectId,
      name: "ZZTEST_F_South Building",
      timezone: "America/New_York",
    },
  });
  const mall = await testDb.basSite.create({
    data: {
      orgId,
      projectId: kenwood.projectId,
      name: "ZZTEST_F_Mall Building",
      timezone: "America/New_York",
    },
  });
  const fresh = await testDb.basStation.create({
    data: {
      siteId: north.siteId,
      niagaraStationName: "ZZTestDirectFresh",
      displayName: "Front of house",
      connectionMode: "direct",
      baseUrl: "https://196.1.1.213",
    },
  });
  const viaParent = await testDb.basStation.create({
    data: {
      siteId: north.siteId,
      niagaraStationName: "ZZTestViaParent",
      connectionMode: "via_parent",
      parentStationId: fresh.stationId,
    },
  });
  const stale = await testDb.basStation.create({
    data: {
      siteId: south.siteId,
      niagaraStationName: "ZZTestStale",
      connectionMode: "direct",
      baseUrl: "https://198.51.100.4",
    },
  });
  const noCred = await testDb.basStation.create({
    data: {
      siteId: mall.siteId,
      niagaraStationName: "ZZTestNoCred",
      connectionMode: "direct",
      baseUrl: "https://203.0.113.9",
    },
  });

  // Credentials on two of the four.
  for (const station of [fresh, stale]) {
    await testDb.basStationCredential.create({
      data: {
        stationId: station.stationId,
        username: "bas_collector",
        passwordCiphertext: "v1:ZZTEST:ZZTEST:ZZTEST",
        keyVersion: 1,
      },
    });
  }

  // Collection state comes from the newest checkpoint on a station's points.
  const withRecord = async (stationId: bigint, name: string, ago: number | null) => {
    const point = await testDb.basPoint.create({
      data: { stationId, niagaraHistoryName: name, dataType: "real" },
    });
    if (ago !== null) {
      await testDb.basSyncCheckpoint.create({
        data: {
          pointId: point.pointId,
          lastRecordTs: new Date(Date.now() - ago),
          lastStatus: "ok",
        },
      });
    }
  };

  await withRecord(fresh.stationId, "ZZTestP_fresh", 10 * 60_000); // 10 min
  await withRecord(stale.stationId, "ZZTestP_stale", 30 * 3_600_000); // 30 h
  await withRecord(viaParent.stationId, "ZZTestP_never", null);
  await withRecord(noCred.stationId, "ZZTestP_never2", null);
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
  await testDb.basSite.deleteMany({ where: { name: { startsWith: "ZZTEST_F" } } });
  await testDb.basProject.deleteMany({
    where: { name: { startsWith: "ZZTEST_F" } },
  });
  await testDb.basOrg.deleteMany({ where: { name: { startsWith: "ZZTEST_F" } } });
}

async function adminViewer() {
  const employee = await createEmployee();
  await grantModule(employee.id, BAS_MODULE_KEY);
  await grantModuleAdmin(employee.id, BAS_MODULE_KEY);
  signedInAs(employee.entraOid!);
  const access = await requireModuleAdmin(BAS_MODULE_KEY);
  if (!access.ok) throw new Error(`expected access, got ${access.denial}`);
  return access.viewer;
}

/** Every station name the tree renders, across projects and unassigned. */
function stationNames(tree: BasSettingsTree): string[] {
  return [
    ...tree.projects.flatMap((p) => p.buildings.flatMap((b) => b.stations)),
    ...tree.unassignedStations,
  ]
    .map((s) => s.niagaraStationName)
    .sort();
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
  await seedFixture();
});

afterAll(async () => {
  await dropBas();
  await disconnectDb();
});

// ---------------------------------------------------------------------------
// THE TRAP. This is the point of the phase.
// ---------------------------------------------------------------------------

describe("a filter hides stations without raising the alarm", () => {
  /**
   * B7.2 turned the screen red when the tree held fewer stations than the
   * database. Filtering hides stations deliberately, so a naive version of that
   * check fires on every keystroke - and a false alarm is how somebody learns
   * to ignore a real one, which is exactly the failure this project keeps
   * writing rules about.
   */
  it("reports rendered === matched while hiding most of the stations", async () => {
    const viewer = await adminViewer();
    const tree = await getBasSettingsTree(viewer, filters({ credential: "unset" }));

    const { rendered, matched, inDatabase, filtered } = tree.stationsAccountedFor;

    // Two of the four have no credential.
    expect(inDatabase).toBe(4);
    expect(matched).toBe(2);
    expect(rendered).toBe(2);

    // THE ASSERTION. rendered === matched, so nothing goes red.
    expect(rendered).toBe(matched);
    expect(filtered).toBe(true);
    // And the honest "showing 2 of 4" is derivable without colour.
    expect(matched).toBeLessThan(inDatabase);
  });

  it("does the same for every other filter", async () => {
    const viewer = await adminViewer();

    for (const f of [
      filters({ q: "Kenwood" }),
      filters({ q: "196.1.1" }),
      filters({ mode: "direct" }),
      filters({ mode: "via_parent" }),
      filters({ state: "collecting" }),
      filters({ state: "stale" }),
      filters({ state: "never" }),
      filters({ credential: "set" }),
      filters({ credential: "unset" }),
      filters({ q: "North", mode: "direct", credential: "set" }),
    ]) {
      const tree = await getBasSettingsTree(viewer, f);
      const { rendered, matched } = tree.stationsAccountedFor;
      expect(
        rendered,
        `rendered !== matched for ${JSON.stringify(f)} - this would go red`,
      ).toBe(matched);
    }
  });

  /**
   * The other half, and the one that must still work: a genuine mismatch has
   * to stay red.
   *
   * Checked against the RULE rather than the database, and that is a finding
   * rather than a shortcut. At the current schema the tree cannot lose a
   * station - bas_stations.site_id and bas_sites.project_id are both NOT NULL
   * with foreign keys, and a station whose building is missing from the
   * hierarchy still lands in unassignedStations, which `rendered` counts. There
   * is no way to provoke a real mismatch through Prisma, and faking one by
   * editing the returned object would assert nothing about the code.
   *
   * So the rule lives in `settingsCountState`, a pure function, and is tested
   * here directly. It is defence against a future change that relaxes one of
   * those constraints.
   */
  it("raises the alarm when rendered disagrees with matched", () => {
    expect(
      settingsCountState({
        rendered: 3,
        matched: 4,
        inDatabase: 4,
        filtered: false,
      }).alarm,
    ).toBe(true);

    // And while a filter is active, which is the case that must not be excused.
    expect(
      settingsCountState({
        rendered: 1,
        matched: 2,
        inDatabase: 37,
        filtered: true,
      }).alarm,
    ).toBe(true);
  });

  it("does NOT raise it when a filter hid the difference", () => {
    const state = settingsCountState({
      rendered: 4,
      matched: 4,
      inDatabase: 37,
      filtered: true,
    });

    expect(state.alarm).toBe(false);
    // But it does say so, in words rather than colour.
    expect(state.hiding).toBe(true);
  });

  it("says nothing at all when nothing is filtered and nothing is missing", () => {
    expect(
      settingsCountState({
        rendered: 37,
        matched: 37,
        inDatabase: 37,
        filtered: false,
      }),
    ).toEqual({ alarm: false, hiding: false });
  });

  /**
   * The specific regression: comparing against inDatabase instead of matched.
   * That is the naive implementation, and this is the shape it fails on.
   */
  it("would have gone red under the naive rendered-vs-inDatabase comparison", () => {
    const counts = { rendered: 2, matched: 2, inDatabase: 4, filtered: true };

    expect(counts.rendered === counts.inDatabase).toBe(false); // the naive check
    expect(settingsCountState(counts).alarm).toBe(false); // the real one
  });

  /**
   * `matched` must be an INDEPENDENT count, and this is a structural test
   * because no behavioural one can catch it.
   *
   * Found by mutation. Replacing the separate query with `matched: rendered`
   * makes the comparison a tautology that can never fire - and every other test
   * in this file still passed, because at the current schema the two numbers
   * legitimately never diverge. A check that cannot fail is worse than no
   * check: it reads as protection and provides none.
   *
   * So the assertion is on the source, the same way the route walkers in
   * bas-settings.test.ts assert on route files. It is coarse and it is the only
   * thing that catches this.
   */
  it("counts matched with its own query, not from the assembled tree", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await readFile(
      path.join(process.cwd(), "lib/modules/bas/settings-service.ts"),
      "utf8",
    );

    // A second COUNT that applies the filter, separate from the tree's joins.
    expect(source).toContain("stationMatched");
    expect(source).toMatch(/matched:\s*Number\(stationMatched/);

    // And explicitly NOT derived from what the tree produced.
    expect(source).not.toMatch(/matched:\s*rendered/);
  });

  it("is not marked filtered when nothing is filtering", async () => {
    const viewer = await adminViewer();
    const tree = await getBasSettingsTree(viewer);

    expect(tree.stationsAccountedFor.filtered).toBe(false);
    expect(tree.stationsAccountedFor.matched).toBe(
      tree.stationsAccountedFor.inDatabase,
    );
    expect(tree.stationsAccountedFor.rendered).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe("search matches the five things somebody would type", () => {
  it("matches a project name, and keeps its whole subtree", async () => {
    const viewer = await adminViewer();
    const tree = await getBasSettingsTree(viewer, filters({ q: "Kenwood" }));

    expect(tree.projects.map((p) => p.name)).toEqual(["ZZTEST_F_Kenwood Mall"]);
    expect(stationNames(tree)).toEqual(["ZZTestNoCred"]);
  });

  it("matches a building name", async () => {
    const viewer = await adminViewer();
    const tree = await getBasSettingsTree(viewer, filters({ q: "South" }));

    expect(stationNames(tree)).toEqual(["ZZTestStale"]);
    // And the project it sits under is still the one on screen.
    expect(tree.projects.map((p) => p.name)).toEqual(["ZZTEST_F_Liberty Center"]);
  });

  it("matches a station display name", async () => {
    const viewer = await adminViewer();
    const tree = await getBasSettingsTree(viewer, filters({ q: "Front of house" }));
    expect(stationNames(tree)).toEqual(["ZZTestDirectFresh"]);
  });

  it("matches the Niagara station name", async () => {
    const viewer = await adminViewer();
    const tree = await getBasSettingsTree(viewer, filters({ q: "ZZTestStale" }));
    expect(stationNames(tree)).toEqual(["ZZTestStale"]);
  });

  /**
   * The one the brief called out: somebody will search an IP fragment, because
   * the address is how the lab station gets referred to in conversation.
   */
  it("matches part of a base URL", async () => {
    const viewer = await adminViewer();
    const tree = await getBasSettingsTree(viewer, filters({ q: "196.1.1" }));
    expect(stationNames(tree)).toEqual(["ZZTestDirectFresh"]);
  });

  it("is case-insensitive", async () => {
    const viewer = await adminViewer();
    const tree = await getBasSettingsTree(viewer, filters({ q: "kenWOOD" }));
    expect(tree.projects.map((p) => p.name)).toEqual(["ZZTEST_F_Kenwood Mall"]);
  });

  /**
   * A name containing a LIKE metacharacter searches for itself. Without
   * escaping, "%" matches everything and the search silently stops narrowing.
   */
  it("treats % and _ as literal characters", async () => {
    const viewer = await adminViewer();

    const all = await getBasSettingsTree(viewer, filters({ q: "%" }));
    expect(all.projects).toEqual([]);

    const underscore = await getBasSettingsTree(viewer, filters({ q: "ZZTestStal_" }));
    expect(underscore.projects).toEqual([]);
  });

  it("returns nothing, not everything, when nothing matches", async () => {
    const viewer = await adminViewer();
    const tree = await getBasSettingsTree(viewer, filters({ q: "no-such-thing" }));

    expect(tree.projects).toEqual([]);
    expect(stationNames(tree)).toEqual([]);
    expect(tree.stationsAccountedFor.rendered).toBe(0);
    expect(tree.stationsAccountedFor.matched).toBe(0);
    expect(tree.stationsAccountedFor.inDatabase).toBe(4);
  });

  /**
   * A project with no buildings must still surface on its own name. "Did my new
   * project save?" is a question this screen has to be able to answer, and a
   * station-rooted filter cannot answer it.
   */
  it("finds an empty project by name", async () => {
    const viewer = await adminViewer();
    await testDb.basProject.create({
      data: { orgId, name: "ZZTEST_F_Brand New" },
    });

    const tree = await getBasSettingsTree(viewer, filters({ q: "Brand New" }));
    expect(tree.projects.map((p) => p.name)).toEqual(["ZZTEST_F_Brand New"]);
    expect(tree.projects[0]?.buildings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe("the three filters", () => {
  it("filters by connection mode", async () => {
    const viewer = await adminViewer();

    expect(
      stationNames(await getBasSettingsTree(viewer, filters({ mode: "direct" }))),
    ).toEqual(["ZZTestDirectFresh", "ZZTestNoCred", "ZZTestStale"]);

    expect(
      stationNames(await getBasSettingsTree(viewer, filters({ mode: "via_parent" }))),
    ).toEqual(["ZZTestViaParent"]);
  });

  /**
   * `unconfigured` is split out of `via_parent` (B7.6).
   *
   * In the data it IS via_parent - the pair is connection_mode = 'via_parent'
   * with no parent_station_id - but as a filter they mean different things.
   * "Via parent" is a category; "discovered, unassigned" is the work queue of
   * stations nobody has finished configuring, and at scale that is the one
   * people reach for.
   */
  it("separates discovered-unassigned from via-parent", async () => {
    const viewer = await adminViewer();

    // The fixture's via_parent station HAS a parent, so it is configured.
    expect(
      stationNames(await getBasSettingsTree(viewer, filters({ mode: "via_parent" }))),
    ).toEqual(["ZZTestViaParent"]);
    expect(
      stationNames(
        await getBasSettingsTree(viewer, filters({ mode: "unconfigured" })),
      ),
    ).toEqual([]);

    // Add one with no parent - what a JACE linked in Workbench and never
    // labelled here actually looks like.
    const site = await testDb.basSite.findFirstOrThrow({
      where: { name: "ZZTEST_F_Mall Building" },
    });
    await testDb.basStation.create({
      data: {
        siteId: site.siteId,
        niagaraStationName: "ZZTestOrphanJACE",
        connectionMode: "via_parent",
      },
    });

    expect(
      stationNames(
        await getBasSettingsTree(viewer, filters({ mode: "unconfigured" })),
      ),
    ).toEqual(["ZZTestOrphanJACE"]);

    // And it is NO LONGER in the via_parent bucket - the split is exclusive, so
    // the two filters cannot both claim the same row.
    expect(
      stationNames(await getBasSettingsTree(viewer, filters({ mode: "via_parent" }))),
    ).toEqual(["ZZTestViaParent"]);
  });

  it("filters by collection state, from the newest record", async () => {
    const viewer = await adminViewer();

    expect(
      stationNames(await getBasSettingsTree(viewer, filters({ state: "collecting" }))),
    ).toEqual(["ZZTestDirectFresh"]);

    expect(
      stationNames(await getBasSettingsTree(viewer, filters({ state: "stale" }))),
    ).toEqual(["ZZTestStale"]);

    expect(
      stationNames(await getBasSettingsTree(viewer, filters({ state: "never" }))),
    ).toEqual(["ZZTestNoCred", "ZZTestViaParent"]);
  });

  it("filters by whether a credential is stored", async () => {
    const viewer = await adminViewer();

    expect(
      stationNames(await getBasSettingsTree(viewer, filters({ credential: "set" }))),
    ).toEqual(["ZZTestDirectFresh", "ZZTestStale"]);

    expect(
      stationNames(await getBasSettingsTree(viewer, filters({ credential: "unset" }))),
    ).toEqual(["ZZTestNoCred", "ZZTestViaParent"]);
  });

  it("combines filters with AND, not OR", async () => {
    const viewer = await adminViewer();
    const tree = await getBasSettingsTree(
      viewer,
      filters({ mode: "direct", credential: "unset" }),
    );
    // Direct AND no credential is one station. OR would be three.
    expect(stationNames(tree)).toEqual(["ZZTestNoCred"]);
  });

  /**
   * A station filter drops buildings and projects that hold nothing matching.
   * Otherwise filtering to "never collected" leaves a page of empty cards.
   */
  it("drops projects and buildings with no surviving station", async () => {
    const viewer = await adminViewer();
    const tree = await getBasSettingsTree(viewer, filters({ state: "collecting" }));

    expect(tree.projects.map((p) => p.name)).toEqual(["ZZTEST_F_Liberty Center"]);
    expect(tree.projects[0]?.buildings.map((b) => b.name)).toEqual([
      "ZZTEST_F_North Building",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The filters are in the URL
// ---------------------------------------------------------------------------

describe("the filters live in the URL and survive a round trip", () => {
  it("reads them out of a query string", () => {
    const params = new URLSearchParams(
      "q=196.1.1&mode=direct&state=stale&cred=unset",
    );
    expect(readSettingsFilters(params)).toEqual({
      q: "196.1.1",
      mode: "direct",
      state: "stale",
      cred: "unset",
    });
  });

  it("round-trips back to the same query string", () => {
    const original = "q=Spring+Grove&mode=via_parent&state=never&cred=set";
    const read = readSettingsFilters(new URLSearchParams(original));
    const rebuilt = new URLSearchParams(settingsQuery(read).slice(1));

    expect(rebuilt.get("q")).toBe("Spring Grove");
    expect(rebuilt.get("mode")).toBe("via_parent");
    expect(rebuilt.get("state")).toBe("never");
    expect(rebuilt.get("cred")).toBe("set");
  });

  it("writes nothing for an empty filter set, so an unfiltered URL is clean", () => {
    expect(settingsQuery(readSettingsFilters(new URLSearchParams("")))).toBe("");
  });

  it("agrees with settingsFiltersActive about what counts as active", () => {
    expect(settingsFiltersActive(NO_SETTINGS_FILTERS)).toBe(false);
    expect(settingsFiltersActive(filters({ q: "   " }))).toBe(false);
    expect(settingsFiltersActive(filters({ q: "x" }))).toBe(true);
    expect(settingsFiltersActive(filters({ mode: "direct" }))).toBe(true);
  });

  /**
   * The route reads them from the query string and applies them. A stale or
   * hand-edited value falls back to unfiltered rather than 422 - refusing to
   * render the screen because one parameter is unrecognised would be a worse
   * answer than showing it unfiltered.
   */
  it("applies them through the route", async () => {
    await adminViewer();

    const filteredResponse = await settingsRoute(treeRequest("?cred=unset"));
    expect(filteredResponse.status).toBe(200);
    const body = (await filteredResponse.json()) as {
      data: BasSettingsTree;
    };
    expect(body.data.stationsAccountedFor.matched).toBe(2);
    expect(body.data.stationsAccountedFor.inDatabase).toBe(4);
    expect(body.data.stationsAccountedFor.filtered).toBe(true);
  });

  it("ignores a value it does not recognise rather than refusing", async () => {
    await adminViewer();

    const response = await settingsRoute(treeRequest("?mode=sideways&state=purple"));
    expect(response.status).toBe(200);

    const body = (await response.json()) as { data: BasSettingsTree };
    expect(body.data.stationsAccountedFor.filtered).toBe(false);
    expect(body.data.stationsAccountedFor.rendered).toBe(4);
  });

  /** Still 404 for a BAS user without the module-admin flag, filters or not. */
  it("is still admin-only with filters applied", async () => {
    const employee = await createEmployee();
    await grantModule(employee.id, BAS_MODULE_KEY);
    signedInAs(employee.entraOid!);

    expect((await settingsRoute(treeRequest("?q=Kenwood"))).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Filtering happens in SQL
// ---------------------------------------------------------------------------

describe("filtering narrows the query, not the response", () => {
  /**
   * A screen that fetched every station and hid most of them in the browser
   * would have shipped the rows it claimed to exclude. With one project that is
   * invisible; at ten it is not.
   *
   * Asserted on the PAYLOAD rather than by counting queries: the rows must not
   * be in the response at all.
   */
  it("does not ship the hidden stations to the client", async () => {
    await adminViewer();

    const response = await settingsRoute(treeRequest("?q=Kenwood"));
    const text = await response.text();

    expect(text).toContain("ZZTestNoCred");
    for (const hidden of ["ZZTestDirectFresh", "ZZTestStale", "ZZTestViaParent"]) {
      expect(text, `${hidden} was filtered out but still in the body`).not.toContain(
        hidden,
      );
    }
    // Nor the address of a station that was filtered out.
    expect(text).not.toContain("196.1.1.213");
  });

  it("keeps unassigned stations out of the count when they do not match", async () => {
    const viewer = await adminViewer();
    const tree = await getBasSettingsTree(viewer, filters({ q: "Kenwood" }));

    expect(tree.unassignedStations).toEqual([]);
    expect(tree.stationsAccountedFor.rendered).toBe(
      tree.stationsAccountedFor.matched,
    );
  });
});
