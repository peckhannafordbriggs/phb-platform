import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Only the session is mocked. The guard, the wrappers, the Zod schemas, the
// service and the real Prisma queries all run - a mocked guard would only prove
// the mock agrees with the test, and half this file is about a 404.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { resetTimezoneCache } from "@/lib/modules/bas/settings-service";
import { POST as createProject } from "@/app/api/modules/bas/settings/projects/route";
import {
  DELETE as deleteProject,
  PATCH as patchProject,
} from "@/app/api/modules/bas/settings/projects/[projectId]/route";
import { POST as createBuilding } from "@/app/api/modules/bas/settings/buildings/route";
import {
  DELETE as deleteBuilding,
  PATCH as patchBuilding,
} from "@/app/api/modules/bas/settings/buildings/[siteId]/route";
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

function json(body: unknown, method = "POST"): Request {
  return new Request("http://localhost/api/modules/bas/settings", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const projectParams = (projectId: string) => ({
  params: Promise.resolve({ projectId }),
});
const siteParams = (siteId: string) => ({ params: Promise.resolve({ siteId }) });

async function payload(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

let orgId: bigint;

async function seedOrg() {
  const org = await testDb.basOrg.create({ data: { name: "ZZTEST_W_ORG" } });
  orgId = org.orgId;
  return org;
}

/** An employee holding the BAS grant AND the module-admin flag. */
async function signInAsAdmin() {
  const employee = await createEmployee();
  await grantModule(employee.id, BAS_MODULE_KEY);
  await grantModuleAdmin(employee.id, BAS_MODULE_KEY);
  signedInAs(employee.entraOid!);
  return employee;
}

/** An employee holding the BAS grant and NOTHING else. */
async function signInAsPlainBasUser() {
  const employee = await createEmployee();
  await grantModule(employee.id, BAS_MODULE_KEY);
  signedInAs(employee.entraOid!);
  return employee;
}

async function dropBas() {
  await testDb.basPoint.deleteMany({
    where: { niagaraHistoryName: { startsWith: "ZZTest" } },
  });
  await testDb.basStation.deleteMany({
    where: { niagaraStationName: { startsWith: "ZZTest" } },
  });
  await testDb.basSite.deleteMany({ where: { name: { startsWith: "ZZTEST_W" } } });
  await testDb.basProject.deleteMany({
    where: { name: { startsWith: "ZZTEST_W" } },
  });
  await testDb.basOrg.deleteMany({ where: { name: { startsWith: "ZZTEST_W" } } });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetBasAvailabilityCache();
  resetTimezoneCache();
  await dropBas();
  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();
  await seedOrg();
});

afterAll(async () => {
  await dropBas();
  await disconnectDb();
});

// ---------------------------------------------------------------------------
// The negative tests. Same weight as the happy path.
// ---------------------------------------------------------------------------

describe("a BAS user without the admin flag cannot write, and is told nothing exists", () => {
  /**
   * 404 on every write route, not 403.
   *
   * A write route answering 403 would confirm the settings surface exists to
   * exactly the person the GET route is hiding it from. The pair has to agree
   * or neither is worth anything.
   */
  it("gets 404 POSTing directly to the create-project route", async () => {
    await signInAsPlainBasUser();

    const response = await createProject(
      json({ orgId: orgId.toString(), name: "ZZTEST_W_SNEAKY" }),
    );

    expect(response.status).toBe(404);
    expect(response.status).not.toBe(403);
  });

  it("gets 404 POSTing directly to the create-building route", async () => {
    const project = await testDb.basProject.create({
      data: { orgId, name: "ZZTEST_W_P" },
    });
    await signInAsPlainBasUser();

    const response = await createBuilding(
      json({
        projectId: project.projectId.toString(),
        name: "ZZTEST_W_SNEAKY",
        timezone: "America/New_York",
      }),
    );

    expect(response.status).toBe(404);
  });

  it("gets 404 PATCHing a project and a building", async () => {
    const project = await testDb.basProject.create({
      data: { orgId, name: "ZZTEST_W_P" },
    });
    const site = await testDb.basSite.create({
      data: {
        orgId,
        projectId: project.projectId,
        name: "ZZTEST_W_S",
        timezone: "America/New_York",
      },
    });
    await signInAsPlainBasUser();

    expect(
      (
        await patchProject(
          json({ name: "ZZTEST_W_RENAMED" }, "PATCH"),
          projectParams(project.projectId.toString()),
        )
      ).status,
    ).toBe(404);

    expect(
      (
        await patchBuilding(
          json({ name: "ZZTEST_W_RENAMED" }, "PATCH"),
          siteParams(site.siteId.toString()),
        )
      ).status,
    ).toBe(404);
  });

  it("gets 404 DELETEing a project and a building", async () => {
    const project = await testDb.basProject.create({
      data: { orgId, name: "ZZTEST_W_P" },
    });
    const site = await testDb.basSite.create({
      data: {
        orgId,
        projectId: project.projectId,
        name: "ZZTEST_W_S",
        timezone: "America/New_York",
      },
    });
    await signInAsPlainBasUser();

    expect(
      (
        await deleteProject(
          json({}, "DELETE"),
          projectParams(project.projectId.toString()),
        )
      ).status,
    ).toBe(404);
    expect(
      (await deleteBuilding(json({}, "DELETE"), siteParams(site.siteId.toString())))
        .status,
    ).toBe(404);
  });

  /**
   * The refusal has to be a refusal, not a 404 page in front of a completed
   * write. Checked against the rows, because a status code says nothing about
   * what happened before it was returned.
   */
  it("writes nothing at all while being refused", async () => {
    const before = await testDb.basProject.count();
    await signInAsPlainBasUser();

    await createProject(json({ orgId: orgId.toString(), name: "ZZTEST_W_GHOST" }));

    expect(await testDb.basProject.count()).toBe(before);
    expect(
      await testDb.basProject.findFirst({ where: { name: "ZZTEST_W_GHOST" } }),
    ).toBeNull();
    // And no audit row claiming it happened.
    expect(
      await testDb.auditEvent.count({ where: { action: "bas.project_created" } }),
    ).toBe(0);
  });

  it("gets 404 as a platform admin without the module-admin flag", async () => {
    const employee = await createEmployee({ isPlatformAdmin: true });
    await grantModule(employee.id, BAS_MODULE_KEY);
    signedInAs(employee.entraOid!);

    expect(
      (await createProject(json({ orgId: orgId.toString(), name: "ZZTEST_W_X" })))
        .status,
    ).toBe(404);
  });

  it("gets 401, not 404, when not signed in", async () => {
    authMock.mockResolvedValue(null as never);
    expect(
      (await createProject(json({ orgId: orgId.toString(), name: "ZZTEST_W_X" })))
        .status,
    ).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

describe("creating and editing a project", () => {
  it("creates one and records who did it", async () => {
    const admin = await signInAsAdmin();

    const response = await createProject(
      json({ orgId: orgId.toString(), name: "ZZTEST_W_LIBERTY" }),
    );
    expect(response.status).toBe(201);

    const created = await testDb.basProject.findFirst({
      where: { name: "ZZTEST_W_LIBERTY" },
    });
    expect(created).not.toBeNull();
    expect(created?.orgId).toBe(orgId);

    const event = await testDb.auditEvent.findFirst({
      where: { action: "bas.project_created" },
    });
    expect(event?.actorEmployeeId).toBe(admin.id);
    expect(event?.moduleKey).toBe(BAS_MODULE_KEY);
    expect((event?.metadata as { name?: string })?.name).toBe("ZZTEST_W_LIBERTY");
    // The subject is a project, not a person.
    expect(event?.targetEmployeeId).toBeNull();
  });

  it("refuses a duplicate name in the same org, with 409", async () => {
    await signInAsAdmin();
    await createProject(json({ orgId: orgId.toString(), name: "ZZTEST_W_DUP" }));

    const again = await createProject(
      json({ orgId: orgId.toString(), name: "ZZTEST_W_DUP" }),
    );

    expect(again.status).toBe(409);
    expect((await payload(again)).error).toMatchObject({ code: "name_taken" });
    expect(
      await testDb.basProject.count({ where: { name: "ZZTEST_W_DUP" } }),
    ).toBe(1);
  });

  it("refuses a blank or whitespace-only name", async () => {
    await signInAsAdmin();

    // 422, which is what docs/07 reserves for validation. There is no 400 in
    // this platform.
    expect(
      (await createProject(json({ orgId: orgId.toString(), name: "" }))).status,
    ).toBe(422);
    // The one a naive min(1) lets through, which then renders as an unclickable
    // blank row.
    expect(
      (await createProject(json({ orgId: orgId.toString(), name: "   " }))).status,
    ).toBe(422);
  });

  it("refuses an org that does not exist, with 404", async () => {
    await signInAsAdmin();
    const response = await createProject(
      json({ orgId: "999999", name: "ZZTEST_W_ORPHAN" }),
    );
    expect(response.status).toBe(404);
    expect((await payload(response)).error).toMatchObject({
      code: "org_not_found",
    });
  });

  it("renames one, and the audit row keeps the old name", async () => {
    await signInAsAdmin();
    const project = await testDb.basProject.create({
      data: { orgId, name: "ZZTEST_W_OLD" },
    });

    const response = await patchProject(
      json({ name: "ZZTEST_W_NEW" }, "PATCH"),
      projectParams(project.projectId.toString()),
    );

    expect(response.status).toBe(200);
    expect(
      (await testDb.basProject.findUnique({
        where: { projectId: project.projectId },
      }))?.name,
    ).toBe("ZZTEST_W_NEW");

    const event = await testDb.auditEvent.findFirst({
      where: { action: "bas.project_updated" },
    });
    const meta = event?.metadata as { name?: string; previousName?: string };
    expect(meta.name).toBe("ZZTEST_W_NEW");
    // The row it describes has been overwritten, so this is the only surviving
    // record of what it used to be called.
    expect(meta.previousName).toBe("ZZTEST_W_OLD");
  });

  /**
   * Saving without changing anything writes no audit row.
   *
   * A log full of "updated" entries that changed nothing is a log that has to
   * be discounted when read, which makes the entries that DID change something
   * harder to find.
   */
  it("writes no audit row when nothing actually changed", async () => {
    await signInAsAdmin();
    const project = await testDb.basProject.create({
      data: { orgId, name: "ZZTEST_W_SAME" },
    });

    const response = await patchProject(
      json({ name: "ZZTEST_W_SAME" }, "PATCH"),
      projectParams(project.projectId.toString()),
    );

    expect(response.status).toBe(200);
    expect((await payload(response)).data).toMatchObject({ changed: false });
    expect(
      await testDb.auditEvent.count({ where: { action: "bas.project_updated" } }),
    ).toBe(0);
  });

  it("404s on a project that does not exist", async () => {
    await signInAsAdmin();
    expect(
      (await patchProject(json({ name: "ZZTEST_W_X" }, "PATCH"), projectParams("999999")))
        .status,
    ).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Buildings, and the unique key that moved in B7.1
// ---------------------------------------------------------------------------

describe("creating and editing a building", () => {
  async function project(name: string) {
    return testDb.basProject.create({ data: { orgId, name } });
  }

  it("creates one under a project and inherits the org from it", async () => {
    await signInAsAdmin();
    const p = await project("ZZTEST_W_P1");

    const response = await createBuilding(
      json({
        projectId: p.projectId.toString(),
        name: "ZZTEST_W_NORTH",
        timezone: "America/Chicago",
        address: "1 Example Street",
      }),
    );
    expect(response.status).toBe(201);

    const site = await testDb.basSite.findFirst({
      where: { name: "ZZTEST_W_NORTH" },
    });
    expect(site?.projectId).toBe(p.projectId);
    expect(site?.timezone).toBe("America/Chicago");
    expect(site?.address).toBe("1 Example Street");
    // Not sent by the form. Taken from the project, which is what keeps the
    // bas_sites_project_org_match trigger satisfied.
    expect(site?.orgId).toBe(orgId);
  });

  /**
   * THE ONE B7.1 MOVED THE KEY FOR.
   *
   * Building names are unique within a PROJECT, not within an organisation. Two
   * projects each having a "North Building" is ordinary - it is the example in
   * the plan doc - and an org-scoped key would have refused the second one.
   */
  it("allows the same building name in two different projects", async () => {
    await signInAsAdmin();
    const liberty = await project("ZZTEST_W_LIBERTY");
    const kenwood = await project("ZZTEST_W_KENWOOD");

    const first = await createBuilding(
      json({
        projectId: liberty.projectId.toString(),
        name: "ZZTEST_W_NORTH",
        timezone: "America/New_York",
      }),
    );
    const second = await createBuilding(
      json({
        projectId: kenwood.projectId.toString(),
        name: "ZZTEST_W_NORTH",
        timezone: "America/New_York",
      }),
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await testDb.basSite.count({ where: { name: "ZZTEST_W_NORTH" } })).toBe(
      2,
    );
  });

  it("still refuses the same name twice in ONE project, with 409", async () => {
    await signInAsAdmin();
    const p = await project("ZZTEST_W_P1");

    await createBuilding(
      json({
        projectId: p.projectId.toString(),
        name: "ZZTEST_W_NORTH",
        timezone: "America/New_York",
      }),
    );
    const again = await createBuilding(
      json({
        projectId: p.projectId.toString(),
        name: "ZZTEST_W_NORTH",
        timezone: "America/New_York",
      }),
    );

    expect(again.status).toBe(409);
    expect((await payload(again)).error).toMatchObject({ code: "name_taken" });
  });

  it("refuses a rename that would collide inside the same project", async () => {
    await signInAsAdmin();
    const p = await project("ZZTEST_W_P1");
    await testDb.basSite.create({
      data: {
        orgId,
        projectId: p.projectId,
        name: "ZZTEST_W_A",
        timezone: "America/New_York",
      },
    });
    const b = await testDb.basSite.create({
      data: {
        orgId,
        projectId: p.projectId,
        name: "ZZTEST_W_B",
        timezone: "America/New_York",
      },
    });

    const response = await patchBuilding(
      json({ name: "ZZTEST_W_A" }, "PATCH"),
      siteParams(b.siteId.toString()),
    );
    expect(response.status).toBe(409);
  });

  it("404s creating under a project that does not exist", async () => {
    await signInAsAdmin();
    const response = await createBuilding(
      json({
        projectId: "999999",
        name: "ZZTEST_W_X",
        timezone: "America/New_York",
      }),
    );
    expect(response.status).toBe(404);
    expect((await payload(response)).error).toMatchObject({
      code: "project_not_found",
    });
  });
});

// ---------------------------------------------------------------------------
// The timezone, which is set here and nowhere else
// ---------------------------------------------------------------------------

describe("the timezone is validated against the database, not a regex alone", () => {
  /**
   * Why this is checked at all: `bas_sites.timezone` is what converts stored UTC
   * back into building-local time. A wrong-but-plausible zone raises no error -
   * it shifts every local timestamp on the Point Explorer by a whole number of
   * hours and looks entirely correct.
   */
  it("refuses a zone that is shaped right but does not exist", async () => {
    await signInAsAdmin();
    const p = await testDb.basProject.create({
      data: { orgId, name: "ZZTEST_W_P1" },
    });

    const response = await createBuilding(
      json({
        projectId: p.projectId.toString(),
        name: "ZZTEST_W_TZ",
        // Passes the IANA-shape regex. Is not a zone.
        timezone: "America/Nowhere",
      }),
    );

    // 422 like every other validation failure here: the caller should not have
    // to work out from the status whether Zod or the database rejected it.
    expect(response.status).toBe(422);
    expect((await payload(response)).error).toMatchObject({
      code: "invalid_timezone",
    });
    expect(await testDb.basSite.findFirst({ where: { name: "ZZTEST_W_TZ" } })).toBeNull();
  });

  it("refuses a zone that is not even the right shape, at the schema", async () => {
    await signInAsAdmin();
    const p = await testDb.basProject.create({
      data: { orgId, name: "ZZTEST_W_P1" },
    });

    expect(
      (
        await createBuilding(
          json({
            projectId: p.projectId.toString(),
            name: "ZZTEST_W_TZ",
            timezone: "not a timezone at all",
          }),
        )
      ).status,
    ).toBe(422);
  });

  it("accepts a real one and records a change of zone in the audit log", async () => {
    await signInAsAdmin();
    const p = await testDb.basProject.create({
      data: { orgId, name: "ZZTEST_W_P1" },
    });
    const site = await testDb.basSite.create({
      data: {
        orgId,
        projectId: p.projectId,
        name: "ZZTEST_W_TZ",
        timezone: "America/New_York",
      },
    });

    const response = await patchBuilding(
      json({ timezone: "America/Chicago" }, "PATCH"),
      siteParams(site.siteId.toString()),
    );

    expect(response.status).toBe(200);
    expect(
      (await testDb.basSite.findUnique({ where: { siteId: site.siteId } }))
        ?.timezone,
    ).toBe("America/Chicago");

    const event = await testDb.auditEvent.findFirst({
      where: { action: "bas.building_updated" },
    });
    const meta = event?.metadata as {
      timezone?: string;
      previousTimezone?: string;
    };
    expect(meta.timezone).toBe("America/Chicago");
    // Every reading is stored UTC and this is what renders it locally, so
    // moving it re-reads years of history. Nothing else records when.
    expect(meta.previousTimezone).toBe("America/New_York");
  });
});

// ---------------------------------------------------------------------------
// Delete refuses rather than cascading
// ---------------------------------------------------------------------------

describe("nothing is deleted out from under its children", () => {
  it("refuses to delete a project that still has buildings, and says how many", async () => {
    await signInAsAdmin();
    const p = await testDb.basProject.create({
      data: { orgId, name: "ZZTEST_W_FULL" },
    });
    await testDb.basSite.create({
      data: {
        orgId,
        projectId: p.projectId,
        name: "ZZTEST_W_S1",
        timezone: "America/New_York",
      },
    });

    const response = await deleteProject(
      json({}, "DELETE"),
      projectParams(p.projectId.toString()),
    );

    expect(response.status).toBe(409);
    const body = (await payload(response)).error as {
      code?: string;
      message?: string;
    };
    expect(body.code).toBe("project_has_buildings");
    // A number, not "cannot delete". The person reading it has no psql.
    expect(body.message).toContain("1 building");

    // Still there.
    expect(
      await testDb.basProject.findUnique({ where: { projectId: p.projectId } }),
    ).not.toBeNull();
  });

  it("deletes an empty project", async () => {
    await signInAsAdmin();
    const p = await testDb.basProject.create({
      data: { orgId, name: "ZZTEST_W_EMPTY" },
    });

    const response = await deleteProject(
      json({}, "DELETE"),
      projectParams(p.projectId.toString()),
    );

    expect(response.status).toBe(200);
    expect(
      await testDb.basProject.findUnique({ where: { projectId: p.projectId } }),
    ).toBeNull();
    expect(
      await testDb.auditEvent.count({ where: { action: "bas.project_deleted" } }),
    ).toBe(1);
  });

  it("refuses to delete a building that still has a station", async () => {
    await signInAsAdmin();
    const p = await testDb.basProject.create({
      data: { orgId, name: "ZZTEST_W_P1" },
    });
    const site = await testDb.basSite.create({
      data: {
        orgId,
        projectId: p.projectId,
        name: "ZZTEST_W_S1",
        timezone: "America/New_York",
      },
    });
    await testDb.basStation.create({
      data: { siteId: site.siteId, niagaraStationName: "ZZTestWriteStation" },
    });

    const response = await deleteBuilding(
      json({}, "DELETE"),
      siteParams(site.siteId.toString()),
    );

    expect(response.status).toBe(409);
    const body = (await payload(response)).error as {
      code?: string;
      message?: string;
    };
    expect(body.code).toBe("building_has_stations");
    expect(body.message).toContain("1 station");
    expect(
      await testDb.basSite.findUnique({ where: { siteId: site.siteId } }),
    ).not.toBeNull();
  });

  it("deletes an empty building", async () => {
    await signInAsAdmin();
    const p = await testDb.basProject.create({
      data: { orgId, name: "ZZTEST_W_P1" },
    });
    const site = await testDb.basSite.create({
      data: {
        orgId,
        projectId: p.projectId,
        name: "ZZTEST_W_S1",
        timezone: "America/New_York",
      },
    });

    expect(
      (await deleteBuilding(json({}, "DELETE"), siteParams(site.siteId.toString())))
        .status,
    ).toBe(200);
    expect(
      await testDb.basSite.findUnique({ where: { siteId: site.siteId } }),
    ).toBeNull();
  });
});
