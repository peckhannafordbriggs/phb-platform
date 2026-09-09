import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Only the session is mocked. The guard, the wrapper, the Prisma queries, the
// route handler and the page are the real ones - a mocked guard would only
// prove the mock agrees with the test, and this file exists to prove a 404.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { getBasSettingsTree } from "@/lib/modules/bas/settings-service";
import { hasModuleAdmin, requireModuleAdmin } from "@/lib/authz";
import { describeReach } from "@/app/(modules)/bas/health-client";
import { visibleBasTabs } from "@/app/(modules)/bas/tabs";
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

/**
 * What notFound() from next/navigation actually throws, verified by running it:
 * a plain Error whose digest carries the status. Asserting on the digest rather
 * than merely "it threw" is the difference between proving a 404 and proving
 * the page has a bug of some kind. Same constant as tests/bas-module.test.ts.
 */
/**
 * The settings tree route takes a Request as of B7.6, so it can read the search
 * and filter parameters out of the query string. Unfiltered unless a test
 * passes one.
 */
function treeRequest(query = ""): Request {
  return new Request("http://localhost/api/modules/bas/settings" + query);
}

const NOT_FOUND_DIGEST = "NEXT_HTTP_ERROR_FALLBACK;404";

async function expectPageNotFound(run: () => Promise<unknown>): Promise<void> {
  let digest: unknown = "the page returned instead of calling notFound()";
  try {
    await run();
  } catch (error) {
    digest = (error as { digest?: unknown }).digest;
  }
  expect(digest).toBe(NOT_FOUND_DIGEST);
}

/** Imported lazily so the session mock is in place first. */
const importSettingsPage = () =>
  import("@/app/(modules)/bas/settings/page").then((m) => m.default);

/** A BAS org -> project -> building -> station chain, cleaned up by resetDb. */
async function seedHierarchy() {
  const org = await testDb.basOrg.create({ data: { name: "ZZTEST_SET_ORG" } });
  const project = await testDb.basProject.create({
    data: { orgId: org.orgId, name: "ZZTEST_SET_PROJECT" },
  });
  const site = await testDb.basSite.create({
    data: {
      orgId: org.orgId,
      projectId: project.projectId,
      name: "ZZTEST_SET_SITE",
      timezone: "America/New_York",
    },
  });
  const station = await testDb.basStation.create({
    data: {
      siteId: site.siteId,
      niagaraStationName: "ZZTestSettingsStation",
      connectionMode: "direct",
      baseUrl: "https://198.51.100.7",
    },
  });
  return { org, project, site, station };
}

async function dropHierarchy() {
  // Children before parents. bas_points.station_id is RESTRICT, so deleting a
  // station first fails, leaves the whole chain behind, and the NEXT file gets
  // a confusing count - the same ordering trap the B7.1 fixture hit.
  // Credentials cascade from the station and need no line of their own.
  await testDb.basPoint.deleteMany({
    where: { niagaraHistoryName: { startsWith: "ZZTest" } },
  });
  await testDb.basStation.deleteMany({
    where: { niagaraStationName: { startsWith: "ZZTest" } },
  });
  await testDb.basSite.deleteMany({
    where: { name: { startsWith: "ZZTEST_SET" } },
  });
  await testDb.basProject.deleteMany({
    where: { name: { startsWith: "ZZTEST_SET" } },
  });
  await testDb.basOrg.deleteMany({
    where: { name: { startsWith: "ZZTEST_SET" } },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetBasAvailabilityCache();
  await dropHierarchy();
  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();
});

afterAll(async () => {
  await dropHierarchy();
  await disconnectDb();
});

// ---------------------------------------------------------------------------
// The negative test. This is the phase.
// ---------------------------------------------------------------------------

describe("a BAS user WITHOUT the module-admin grant is told nothing exists", () => {
  /**
   * 404 and not 403, on the page and on the route.
   *
   * 403 answers the question "is there a settings screen?" with yes. For an
   * administrative surface that is the answer we are trying not to give: the
   * point of the module-admin flag is that changing what gets collected is a
   * different privilege from looking at it, and someone probing for the former
   * should not learn it is there.
   */
  it("gets 404 from the settings page, holding a plain BAS grant", async () => {
    const employee = await createEmployee();
    await grantModule(employee.id, BAS_MODULE_KEY);
    signedInAs(employee.entraOid!);

    const Page = await importSettingsPage();
    await expectPageNotFound(() => Page());
  });

  it("gets 404 from the settings API route, holding a plain BAS grant", async () => {
    const employee = await createEmployee();
    await grantModule(employee.id, BAS_MODULE_KEY);
    signedInAs(employee.entraOid!);

    const response = await settingsRoute(treeRequest());
    expect(response.status).toBe(404);
  });

  it("is refused as 404 rather than 403 - the distinction IS the requirement", async () => {
    const employee = await createEmployee();
    await grantModule(employee.id, BAS_MODULE_KEY);
    signedInAs(employee.entraOid!);

    const response = await settingsRoute(treeRequest());
    expect(response.status).not.toBe(403);
    expect(response.status).toBe(404);
  });

  it("learns nothing about the hierarchy from the body", async () => {
    const { project, site, station } = await seedHierarchy();
    const employee = await createEmployee();
    await grantModule(employee.id, BAS_MODULE_KEY);
    signedInAs(employee.entraOid!);

    const body = await (await settingsRoute(treeRequest())).text();

    // Not merely "no data key" - the names must not appear anywhere in the
    // response, including inside an error message that echoed a query back.
    expect(body).not.toContain(project.name);
    expect(body).not.toContain(site.name);
    expect(body).not.toContain(station.niagaraStationName);
  });

  /**
   * A platform admin is NOT automatically a BAS settings admin.
   *
   * Confirmed as the intended behaviour when the phase was scoped. It matches
   * the rest of the platform - `requireModuleAccess` has no `isPlatformAdmin`
   * branch either, so a platform admin already gets 404 on /bas itself without
   * a grant. If this ever flips, the audit row "granted BAS admin to Jake" stops
   * describing everyone who can add a building.
   */
  it("gets 404 even as a platform admin, without the module-admin flag", async () => {
    const employee = await createEmployee({ isPlatformAdmin: true });
    await grantModule(employee.id, BAS_MODULE_KEY);
    signedInAs(employee.entraOid!);

    expect((await settingsRoute(treeRequest())).status).toBe(404);
    const Page = await importSettingsPage();
    await expectPageNotFound(() => Page());
  });

  it("gets 404 with no BAS grant at all", async () => {
    const employee = await createEmployee();
    signedInAs(employee.entraOid!);

    expect((await settingsRoute(treeRequest())).status).toBe(404);
  });

  it("gets 401, not 404, when not signed in - a different question", async () => {
    authMock.mockResolvedValue(null as never);
    expect((await settingsRoute(treeRequest())).status).toBe(401);
  });

  /**
   * The flag is on the grant row, so revoking access revokes admin rights in
   * the same statement. Proved by revoking and re-granting: if the flag
   * survived on a re-created row this would come back as 200.
   */
  it("loses admin rights when the module grant is revoked and re-added", async () => {
    const employee = await createEmployee();
    await grantModule(employee.id, BAS_MODULE_KEY);
    await grantModuleAdmin(employee.id, BAS_MODULE_KEY);
    signedInAs(employee.entraOid!);
    expect((await settingsRoute(treeRequest())).status).toBe(200);

    await testDb.moduleGrant.deleteMany({
      where: { employeeId: employee.id, moduleKey: BAS_MODULE_KEY },
    });
    await grantModule(employee.id, BAS_MODULE_KEY);

    expect((await settingsRoute(treeRequest())).status).toBe(404);
  });
});

describe("a BAS user WITH the module-admin grant gets in", () => {
  /**
   * The other half. Every refusal above would also pass if the guard refused
   * everyone, which would be a broken screen rather than a secure one.
   */
  it("gets 200 from the route and a rendered page", async () => {
    await seedHierarchy();
    const employee = await createEmployee();
    await grantModule(employee.id, BAS_MODULE_KEY);
    await grantModuleAdmin(employee.id, BAS_MODULE_KEY);
    signedInAs(employee.entraOid!);

    expect((await settingsRoute(treeRequest())).status).toBe(200);

    const Page = await importSettingsPage();
    await expect(Page()).resolves.toBeTruthy();
  });

  it("sees the project, building and station", async () => {
    const { project, site, station } = await seedHierarchy();
    const employee = await createEmployee();
    await grantModule(employee.id, BAS_MODULE_KEY);
    await grantModuleAdmin(employee.id, BAS_MODULE_KEY);
    signedInAs(employee.entraOid!);

    const body = await (await settingsRoute(treeRequest())).text();
    expect(body).toContain(project.name);
    expect(body).toContain(site.name);
    expect(body).toContain(station.niagaraStationName);
  });

  /**
   * CHANGED IN B7.4, deliberately.
   *
   * When this was written the credential was returned as a bare boolean and the
   * username was asserted never to leave. B7.4 specifies that a GET answers
   * `{ username, passwordSet: true, passwordUpdatedAt }` - the form has to be
   * able to show WHO the login is for and when it last moved, and a masked
   * field beside a blank username is not usable.
   *
   * The line that matters is unchanged and is now stricter: the ciphertext, the
   * key version and the password itself never appear, and the credential object
   * is asserted to have exactly three keys, so a fourth added later fails here.
   */
  it("is handed the username and the fact of a password, never the password", async () => {
    const { station } = await seedHierarchy();
    await testDb.basStationCredential.create({
      data: {
        stationId: station.stationId,
        username: "zztest_niagara_user",
        passwordCiphertext: "ZZTESTCIPHERTEXTDONOTLEAK",
        keyVersion: 1,
      },
    });

    const employee = await createEmployee();
    await grantModule(employee.id, BAS_MODULE_KEY);
    await grantModuleAdmin(employee.id, BAS_MODULE_KEY);
    signedInAs(employee.entraOid!);

    const body = await (await settingsRoute(treeRequest())).text();

    expect(body).toContain('"hasCredential":true');
    expect(body).toContain('"passwordSet":true');

    // The three that must never appear, whatever else changes.
    expect(body).not.toContain("ZZTESTCIPHERTEXTDONOTLEAK");
    expect(body).not.toContain("passwordCiphertext");
    expect(body).not.toContain("keyVersion");

    const parsed = JSON.parse(body) as {
      data: {
        projects: Array<{
          buildings: Array<{
            stations: Array<{ credential: Record<string, unknown> | null }>;
          }>;
        }>;
      };
    };
    const credential = parsed.data.projects[0]?.buildings[0]?.stations[0]
      ?.credential;

    // Exactly three keys. A fourth added to this object later fails here rather
    // than being noticed after it has shipped.
    expect(Object.keys(credential ?? {}).sort()).toEqual([
      "passwordSet",
      "passwordUpdatedAt",
      "username",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The structural guard, matching the one bas-module.test.ts runs for the module
// ---------------------------------------------------------------------------

describe("every settings route goes through withBasSettings", () => {
  const SETTINGS_API_ROOT = "app/api/modules/bas/settings";

  async function settingsFiles(): Promise<string[]> {
    const found: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith(".ts")) found.push(full);
      }
    }
    await walk(path.join(process.cwd(), SETTINGS_API_ROOT));
    return found;
  }

  it("finds the settings routes at all", async () => {
    // A walker that silently matches nothing passes forever. The floor rises
    // with each phase: B7.2 shipped one route, B7.3 added four more. It is a
    // floor rather than an equality so adding a route is not a chore, but a
    // walker that stopped seeing them is caught.
    expect((await settingsFiles()).length).toBeGreaterThanOrEqual(5);
  });

  /**
   * `withBas` alone would be the dangerous mistake here, and it is the easy one
   * to make: it is the wrapper every other file in this module uses, it looks
   * right, and it would leave the whole settings surface open to any BAS user.
   * Nothing else in the suite would notice.
   */
  it("uses withBasSettings, never withBas and never a guard directly", async () => {
    for (const file of await settingsFiles()) {
      const source = await readFile(file, "utf8");

      expect(source, `${file} must use withBasSettings`).toContain(
        "withBasSettings",
      );
      expect(source, `${file} must not call requireModuleAdmin itself`).not.toContain(
        "requireModuleAdmin(",
      );
      expect(source, `${file} must not call requireModuleAccess itself`).not.toContain(
        "requireModuleAccess(",
      );
      // withBas( with the paren, so withBasSettings( does not match.
      expect(source, `${file} must not fall back to withBas`).not.toContain(
        "withBas(",
      );
    }
  });

  /**
   * No layout may wrap the settings tab.
   *
   * A Next.js layout renders around a page that called notFound(), so an
   * ungranted employee would get the Building Automation heading and the tab
   * bar wrapped around a 404 body - confirming the tab exists to exactly the
   * person it is hidden from. This bit the module once already, which is why
   * BasShell is a component rendered inside each guarded page.
   */
  it("has no layout file anywhere under the BAS module", async () => {
    const root = path.join(process.cwd(), "app/(modules)/bas");
    const layouts: string[] = [];

    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (/^layout\.(tsx|ts|jsx|js)$/.test(entry.name)) layouts.push(full);
      }
    }
    await walk(root);

    expect(layouts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The tab bar must not announce the tab
// ---------------------------------------------------------------------------

describe("the Settings tab is offered only to a module admin", () => {
  it("is absent for a plain BAS user and present for an admin", () => {
    const withoutAdmin = visibleBasTabs(false).map((t) => t.href);
    const withAdmin = visibleBasTabs(true).map((t) => t.href);

    expect(withoutAdmin).not.toContain("/bas/settings");
    expect(withAdmin).toContain("/bas/settings");

    // The other tabs are unaffected either way.
    expect(withoutAdmin).toContain("/bas");
    expect(withoutAdmin).toContain("/bas/points");
  });

  /**
   * The page -> shell wiring, which the rendering test in bas-tab-bar.test.tsx
   * cannot see.
   *
   * That file proves BasShell renders the right tabs for a given
   * `canAdminister`. This proves the pages compute the right value to hand it.
   * Both halves are needed: a correct shell fed `true` for everyone leaks the
   * tab just as effectively as a shell that ignored the prop.
   */
  it("has Collection Health tell the shell NOT to offer Settings to a plain BAS user", async () => {
    const employee = await createEmployee();
    await grantModule(employee.id, BAS_MODULE_KEY);
    signedInAs(employee.entraOid!);

    const Page = (await import("@/app/(modules)/bas/page")).default;
    const element = (await Page()) as { props: { canAdminister?: boolean } };

    expect(element.props.canAdminister).toBe(false);
  });

  it("has Point Explorer offer it once the flag is granted", async () => {
    const employee = await createEmployee();
    await grantModule(employee.id, BAS_MODULE_KEY);
    await grantModuleAdmin(employee.id, BAS_MODULE_KEY);
    signedInAs(employee.entraOid!);

    const Page = (await import("@/app/(modules)/bas/points/page")).default;
    const element = (await Page()) as { props: { canAdminister?: boolean } };

    expect(element.props.canAdminister).toBe(true);
  });

  it("puts Settings last", () => {
    const hrefs = visibleBasTabs(true).map((t) => t.href);
    expect(hrefs[hrefs.length - 1]).toBe("/bas/settings");
  });

  it("reports the flag from the grant row, not from the platform admin flag", async () => {
    const plain = await createEmployee();
    await grantModule(plain.id, BAS_MODULE_KEY);
    expect(await hasModuleAdmin(plain.id, BAS_MODULE_KEY)).toBe(false);

    const platformAdmin = await createEmployee({ isPlatformAdmin: true });
    await grantModule(platformAdmin.id, BAS_MODULE_KEY);
    expect(await hasModuleAdmin(platformAdmin.id, BAS_MODULE_KEY)).toBe(false);

    await grantModuleAdmin(plain.id, BAS_MODULE_KEY);
    expect(await hasModuleAdmin(plain.id, BAS_MODULE_KEY)).toBe(true);

    // A grant on a DIFFERENT module confers nothing here.
    const other = await createEmployee();
    await grantModule(other.id, "change-orders");
    await testDb.moduleGrant.update({
      where: {
        employeeId_moduleKey: {
          employeeId: other.id,
          moduleKey: "change-orders",
        },
      },
      data: { isModuleAdmin: true },
    });
    expect(await hasModuleAdmin(other.id, BAS_MODULE_KEY)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The tree itself
// ---------------------------------------------------------------------------

describe("the settings tree accounts for every station", () => {
  async function viewerFor(employeeId: string) {
    signedInAs((await testDb.employee.findUniqueOrThrow({
      where: { id: employeeId },
      select: { entraOid: true },
    })).entraOid!);
    const access = await requireModuleAdmin(BAS_MODULE_KEY);
    if (!access.ok) throw new Error(`expected access, got ${access.denial}`);
    return access.viewer;
  }

  async function adminViewer() {
    const employee = await createEmployee();
    await grantModule(employee.id, BAS_MODULE_KEY);
    await grantModuleAdmin(employee.id, BAS_MODULE_KEY);
    return viewerFor(employee.id);
  }

  it("renders exactly as many stations as the database holds", async () => {
    await seedHierarchy();
    const tree = await getBasSettingsTree(await adminViewer());

    expect(tree.stationsAccountedFor.rendered).toBe(
      tree.stationsAccountedFor.inDatabase,
    );
    expect(tree.stationsAccountedFor.inDatabase).toBe(
      await testDb.basStation.count(),
    );
  });

  /**
   * A project with no buildings, and a building with no stations, both appear.
   *
   * This is why the service runs two queries. A single station-rooted join
   * cannot produce a row for a building that has no stations, so an empty
   * project created a moment ago would be invisible to the person who created
   * it - which in B7.3 reads as "the form did not work".
   */
  it("shows a project with no buildings and a building with no stations", async () => {
    const org = await testDb.basOrg.create({ data: { name: "ZZTEST_SET_ORG" } });
    const empty = await testDb.basProject.create({
      data: { orgId: org.orgId, name: "ZZTEST_SET_PROJECT_EMPTY" },
    });
    const withBuilding = await testDb.basProject.create({
      data: { orgId: org.orgId, name: "ZZTEST_SET_PROJECT_B" },
    });
    await testDb.basSite.create({
      data: {
        orgId: org.orgId,
        projectId: withBuilding.projectId,
        name: "ZZTEST_SET_SITE_NOSTATIONS",
        timezone: "America/New_York",
      },
    });

    const tree = await getBasSettingsTree(await adminViewer());

    const emptyProject = tree.projects.find(
      (p) => p.projectId === empty.projectId.toString(),
    );
    expect(emptyProject).toBeDefined();
    expect(emptyProject?.buildings).toEqual([]);

    const stationless = tree.projects
      .find((p) => p.projectId === withBuilding.projectId.toString())
      ?.buildings.find((b) => b.name === "ZZTEST_SET_SITE_NOSTATIONS");
    expect(stationless).toBeDefined();
    expect(stationless?.stations).toEqual([]);
  });

  it("counts a station's points and reports its reach", async () => {
    const { station } = await seedHierarchy();
    await testDb.basPoint.createMany({
      data: [
        {
          stationId: station.stationId,
          niagaraHistoryName: "ZZTestActive",
          dataType: "real",
          isActive: true,
        },
        {
          stationId: station.stationId,
          niagaraHistoryName: "ZZTestInactive",
          dataType: "real",
          isActive: false,
        },
      ],
    });

    const tree = await getBasSettingsTree(await adminViewer());
    const row = tree.projects[0]?.buildings[0]?.stations[0];

    expect(row?.activePoints).toBe(1);
    expect(row?.totalPoints).toBe(2);
    expect(row?.reach).toBe("direct");
    expect(row?.hasCredential).toBe(false);
  });
});

/**
 * "Discovered, unassigned" - and what the schema actually permits.
 *
 * The brief asked for stations with no building or project attached. The schema
 * cannot produce one: `bas_stations.site_id` and `bas_sites.project_id` are both
 * NOT NULL, so a station always has a building and a building always has a
 * project. The real form of the same worry is a station whose connection was
 * never configured - `via_parent` with no parent - which is exactly what a JACE
 * linked in Workbench and never labelled here looks like, and which the
 * add_bas_projects migration deliberately allows rather than CHECK-ing away.
 */
describe("a discovered, unconfigured station is surfaced, not hidden", () => {
  it("reads via_parent with no parent as unconfigured, and warns", () => {
    expect(
      describeReach({
        reach: "unconfigured",
        baseUrl: null,
        parentStationName: null,
      }).tone,
    ).toBe("warn");
    expect(
      describeReach({
        reach: "unconfigured",
        baseUrl: null,
        parentStationName: null,
      }).label,
    ).toBe("Discovered, unassigned");
  });

  it("does not let an inherited base_url make it look configured", () => {
    // The collector writes the CENTRAL station's URL onto every station it
    // discovers, so a set base_url says nothing about whether anyone configured
    // this row. If this ever reads "ok", the amber has been lost.
    expect(
      describeReach({
        reach: "unconfigured",
        baseUrl: "https://196.1.1.213",
        parentStationName: null,
      }).tone,
    ).toBe("warn");
  });

  it("classifies a real via_parent station as configured", () => {
    expect(
      describeReach({
        reach: "via_parent",
        baseUrl: null,
        parentStationName: "SpringGroveLabComputer",
      }).tone,
    ).toBe("ok");
  });

  it("warns about a direct station with no address", () => {
    expect(
      describeReach({ reach: "direct", baseUrl: null, parentStationName: null })
        .tone,
    ).toBe("warn");
  });

  it("surfaces it through the service against a real row", async () => {
    const { site } = await seedHierarchy();
    await testDb.basStation.create({
      data: {
        siteId: site.siteId,
        niagaraStationName: "ZZTestDiscovered",
        // Exactly what ensure_station writes for a newly linked JACE: the
        // column default, no parent, and the central station's URL inherited
        // from the collector's config.
        connectionMode: "via_parent",
        baseUrl: "https://198.51.100.7",
      },
    });

    const employee = await createEmployee();
    await grantModule(employee.id, BAS_MODULE_KEY);
    await grantModuleAdmin(employee.id, BAS_MODULE_KEY);
    signedInAs(employee.entraOid!);
    const access = await requireModuleAdmin(BAS_MODULE_KEY);
    if (!access.ok) throw new Error("expected access");

    const tree = await getBasSettingsTree(access.viewer);
    const stations = tree.projects.flatMap((p) =>
      p.buildings.flatMap((b) => b.stations),
    );
    const discovered = stations.find(
      (s) => s.niagaraStationName === "ZZTestDiscovered",
    );

    expect(discovered?.reach).toBe("unconfigured");
    // And it is still counted, which is the whole point - a station nobody
    // labelled is not a station the screen may drop.
    expect(tree.stationsAccountedFor.rendered).toBe(
      tree.stationsAccountedFor.inDatabase,
    );
  });
});
