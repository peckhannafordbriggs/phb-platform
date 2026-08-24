import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Only the session is mocked. The guard, the wrapper, the Prisma queries, the
// route handler and the page are the real ones. B2 is entirely about the
// authorization boundary, and a mocked guard would only prove the mock agrees
// with the test.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { buildMe } from "@/lib/me";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import {
  basDataAvailability,
  resetBasAvailabilityCache,
  withBas,
} from "@/lib/modules/bas/route-helpers";
import { ok } from "@/lib/api/response";
import { GET as basPing } from "@/app/api/modules/bas/ping/route";
import {
  createEmployee,
  disconnectDb,
  grantModule,
  resetDb,
  revokeModule,
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
 * than merely "it threw" is the difference between proving a 404 and proving the
 * page has a bug of some kind.
 */
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
const importBasPage = () =>
  import("@/app/(modules)/bas/page").then((m) => m.default);

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // withBas remembers a confirmed schema for the life of the process. Tests run
  // in one process, so without this a test that arranges "the tables are not
  // there" would be answered from a cache filled by an earlier test.
  resetBasAvailabilityCache();
  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDb();
});

describe("the BAS ping route is behind the module grant", () => {
  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null as never);

    expect((await basPing()).status).toBe(401);
  });

  it("returns 404 - not 403 - without the grant", async () => {
    await createEmployee({ entraOid: "oid-bas-nogrant" });
    signedInAs("oid-bas-nogrant");

    const response = await basPing();

    // The acceptance criterion for B2. 404 so the platform does not confirm to
    // someone who cannot use it that the module exists at all.
    expect(response.status).toBe(404);
    expect(response.status).not.toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: "Not found." },
    });
  });

  it("returns 200 with the grant", async () => {
    const employee = await createEmployee({ entraOid: "oid-bas-granted" });
    await grantModule(employee.id, BAS_MODULE_KEY);
    signedInAs("oid-bas-granted");

    const response = await basPing();

    // The allow path. It is easy to test the denial and never notice that the
    // granted case stopped working.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { ok: true } });
  });

  it("returns 403 when the profile is incomplete", async () => {
    const employee = await createEmployee({
      entraOid: "oid-bas-incomplete",
      profileCompleted: false,
    });
    await grantModule(employee.id, BAS_MODULE_KEY);
    signedInAs("oid-bas-incomplete");

    expect((await basPing()).status).toBe(403);
  });

  it("returns 404 when the module row is hidden, even with a grant", async () => {
    const employee = await createEmployee({ entraOid: "oid-bas-hidden" });
    await grantModule(employee.id, BAS_MODULE_KEY);
    await testDb.module.update({
      where: { key: BAS_MODULE_KEY },
      data: { status: "hidden" },
    });
    signedInAs("oid-bas-hidden");

    expect((await basPing()).status).toBe(404);
  });

  it("does not accept a Change Orders grant as access to BAS", async () => {
    const employee = await createEmployee({ entraOid: "oid-bas-wrongmodule" });
    await grantModule(employee.id, "change-orders");
    signedInAs("oid-bas-wrongmodule");

    // Two modules, two grants. Holding one must not open the other.
    expect((await basPing()).status).toBe(404);
  });

  it("revoking the grant takes effect on the next request, without signing out", async () => {
    const employee = await createEmployee({ entraOid: "oid-bas-revoke" });
    await grantModule(employee.id, BAS_MODULE_KEY);
    signedInAs("oid-bas-revoke");

    expect((await basPing()).status).toBe(200);

    await revokeModule(employee.id, BAS_MODULE_KEY);

    // Same session, same token, no re-authentication.
    expect((await basPing()).status).toBe(404);
  });

  it("tells an ungranted caller nothing about the module", async () => {
    await createEmployee({ entraOid: "oid-bas-quiet" });
    signedInAs("oid-bas-quiet");

    const raw = JSON.stringify(await (await basPing()).json()).toLowerCase();

    for (const leak of ["bas", "niagara", "jace", "building", "point"]) {
      expect(raw, `the denial must not mention "${leak}"`).not.toContain(leak);
    }
  });
});

describe("the BAS page is guarded the same way as the route", () => {
  it("404s for an employee without the grant", async () => {
    await createEmployee({ entraOid: "oid-page-nogrant" });
    signedInAs("oid-page-nogrant");

    const BasPage = await importBasPage();

    await expectPageNotFound(() => BasPage());
  });

  it("404s for an unauthenticated visitor", async () => {
    authMock.mockResolvedValue(null as never);

    const BasPage = await importBasPage();

    // Not a sign-in redirect from the page itself: the middleware handles that
    // for a browser, and a page that rendered for a signed-out caller would be a
    // hole regardless.
    await expectPageNotFound(() => BasPage());
  });

  it("renders for an employee holding the grant", async () => {
    const employee = await createEmployee({ entraOid: "oid-page-granted" });
    await grantModule(employee.id, BAS_MODULE_KEY);
    signedInAs("oid-page-granted");

    const BasPage = await importBasPage();

    await expect(BasPage()).resolves.toBeDefined();
  });
});

describe("the module registration drives the sidebar", () => {
  /**
   * The sidebar renders whatever buildMe returns - components/sidebar.tsx has no
   * module list of its own. So asserting on buildMe is asserting on the sidebar,
   * without a browser.
   */
  const viewerFor = (employee: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  }) => ({
    id: employee.id,
    email: employee.email,
    firstName: employee.firstName,
    lastName: employee.lastName,
    profileCompleted: true,
    isPlatformAdmin: false,
  });

  it("lists Building Automation for an employee holding the grant", async () => {
    const employee = await createEmployee({ entraOid: "oid-sidebar-bas" });
    await grantModule(employee.id, BAS_MODULE_KEY);

    const me = await buildMe(viewerFor(employee));

    expect(me.grantedModuleKeys).toEqual([BAS_MODULE_KEY]);
    expect(me.modules[0]?.displayName).toBe("Building Automation");
    // components/sidebar.tsx builds the href as `/${module.key}`, so the key has
    // to match the app/(modules)/bas segment or the link leads to a 404.
    expect(me.modules[0]?.key).toBe("bas");
  });

  it("sorts Building Automation after Change Orders", async () => {
    const employee = await createEmployee({ entraOid: "oid-sidebar-both" });
    await grantModule(employee.id, "change-orders");
    await grantModule(employee.id, BAS_MODULE_KEY);

    const me = await buildMe(viewerFor(employee));

    expect(me.grantedModuleKeys).toEqual(["change-orders", "bas"]);
  });

  it("shows nothing to an employee without the grant", async () => {
    const employee = await createEmployee({ entraOid: "oid-sidebar-none" });

    const me = await buildMe(viewerFor(employee));

    expect(me.modules).toEqual([]);
  });

  it("hides it again once the module row is hidden", async () => {
    const employee = await createEmployee({ entraOid: "oid-sidebar-hidden" });
    await grantModule(employee.id, BAS_MODULE_KEY);
    await testDb.module.update({
      where: { key: BAS_MODULE_KEY },
      data: { status: "hidden" },
    });

    const me = await buildMe(viewerFor(employee));

    expect(me.modules).toEqual([]);
  });
});

describe("the seed registers the module", () => {
  /**
   * Read from source rather than executed: prisma/seed.ts is a script with a
   * top-level main() that connects and exits the process. What matters here is
   * the row it declares and the field it declines to overwrite.
   */
  const seedSource = () =>
    import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(process.cwd(), "prisma/seed.ts"), "utf8"),
    );

  it("declares the bas row with the key the code authorizes on", async () => {
    const source = await seedSource();

    expect(source).toContain(`key: "${BAS_MODULE_KEY}"`);
    expect(source).toContain('displayName: "Building Automation"');
  });

  it("does not overwrite status on re-seed", async () => {
    const source = await seedSource();

    // An admin who hid a module must not have it un-hidden by the next deploy.
    // The upsert update block is shared by every module row.
    const update = /update: \{[\s\S]*?\n {8}\},/.exec(source)?.[0] ?? "";

    expect(update).not.toBe("");
    expect(update).toContain("displayName");
    expect(update).not.toContain("status");
  });

  it("re-seeding the row leaves a hidden module hidden", async () => {
    // The behaviour the source assertion above stands in for, run against the
    // real database with the same upsert shape the seed uses.
    await testDb.module.update({
      where: { key: BAS_MODULE_KEY },
      data: { status: "hidden" },
    });

    await testDb.module.upsert({
      where: { key: BAS_MODULE_KEY },
      update: {
        displayName: "Building Automation",
        description: "re-seeded",
        icon: "gauge",
        sortOrder: 200,
      },
      create: {
        key: BAS_MODULE_KEY,
        displayName: "Building Automation",
        sortOrder: 200,
      },
    });

    const row = await testDb.module.findUniqueOrThrow({
      where: { key: BAS_MODULE_KEY },
    });

    expect(row.status).toBe("hidden");
    expect(row.description).toBe("re-seeded");
  });
});

describe("withBas runs authorization, then validation, then availability", () => {
  const ROUTE = "/api/modules/bas/test";

  async function grantedEmployee(oid: string) {
    const employee = await createEmployee({ entraOid: oid });
    await grantModule(employee.id, BAS_MODULE_KEY);
    signedInAs(oid);
    return employee;
  }

  it("never parses the body for a caller without the grant", async () => {
    await createEmployee({ entraOid: "oid-order-nogrant" });
    signedInAs("oid-order-nogrant");

    const parse = vi.fn(async () => ({ ok: true as const, data: 1 }));
    const handler = vi.fn(async () => ok({ reached: true }));

    const response = await withBas(ROUTE, handler, parse);

    expect(response.status).toBe(404);
    // An unauthenticated or ungranted caller must not learn what a valid request
    // body looks like, which means the parser must not run at all.
    expect(parse).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("answers 422 for a malformed body from a granted caller", async () => {
    await grantedEmployee("oid-order-invalid");

    const handler = vi.fn(async () => ok({ reached: true }));

    const response = await withBas(ROUTE, handler, async () => ({
      ok: false,
      message: "top must be a positive integer",
    }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "validation_failed",
        message: "top must be a positive integer",
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("hands the parsed input to the handler", async () => {
    const employee = await grantedEmployee("oid-order-valid");

    const response = await withBas(
      ROUTE,
      async (viewer, input: { top: number }) =>
        ok({ employeeId: viewer.id, top: input.top }),
      async () => ({ ok: true, data: { top: 25 } }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { employeeId: employee.id, top: 25 },
    });
  });

  it("reports bas_unavailable when the bas tables are not there", async () => {
    await grantedEmployee("oid-order-noschema");

    // The one place this file mocks below the guard. A database that has the
    // platform tables but not the add_bas_tables migration is a real state - a
    // fresh environment, or a restore predating B1 - and it cannot be arranged
    // in the test database without dropping a table.
    vi.spyOn(prisma, "$queryRaw").mockResolvedValue([{ present: false }]);

    const handler = vi.fn(async () => ok({ reached: true }));
    const response = await withBas(ROUTE, handler);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("bas_unavailable");
    expect(handler).not.toHaveBeenCalled();
    // The diagnostic half stays in the log.
    expect(body.error.message).not.toContain("bas_readings");
    expect(body.error.message).not.toContain("migration");
  });

  it("reports the same thing when the database itself cannot be reached", async () => {
    await grantedEmployee("oid-order-unreachable");

    vi.spyOn(prisma, "$queryRaw").mockRejectedValue(
      new Error("connect ECONNREFUSED 127.0.0.1:5432"),
    );

    const response = await withBas(ROUTE, async () => ok({ reached: true }));
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("bas_unavailable");
    expect(body.error.message).not.toContain("ECONNREFUSED");
  });

  it("turns a handler that throws into a 500 with nothing leaked", async () => {
    await grantedEmployee("oid-order-throws");

    const response = await withBas(ROUTE, async () => {
      throw new Error("SELECT * FROM bas_readings failed: relation is locked");
    });
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("server_error");
    expect(JSON.stringify(body)).not.toContain("bas_readings");
  });

  it("checks availability against the real database when nothing is mocked", async () => {
    await grantedEmployee("oid-order-real");

    // The counterpart to the two mocked cases above: on a database that has had
    // the migration applied, the availability step passes and the handler runs.
    const response = await withBas(ROUTE, async () => ok({ reached: true }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { reached: true },
    });
  });
});

describe("the availability check caches the answer it is allowed to cache", () => {
  /**
   * B3 turned one `to_regclass` on one ping route into one per screen refresh.
   * Caching it is safe in exactly one direction, and these are the tests that
   * hold that asymmetry in place.
   */
  it("asks the database only once after the schema is confirmed", async () => {
    const spy = vi.spyOn(prisma, "$queryRaw");

    await expect(basDataAvailability()).resolves.toEqual({ available: true });
    await basDataAvailability();
    await basDataAvailability();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not remember a missing schema", async () => {
    const spy = vi
      .spyOn(prisma, "$queryRaw")
      .mockResolvedValue([{ present: false }]);

    const first = await basDataAvailability();
    const second = await basDataAvailability();

    // A database that gains the add_bas_tables migration must be picked up on
    // the very next request, not at the next container restart.
    expect(first.available).toBe(false);
    expect(second.available).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);

    spy.mockResolvedValue([{ present: true }]);
    await expect(basDataAvailability()).resolves.toEqual({ available: true });
  });

  it("does not remember an unreachable database", async () => {
    const spy = vi
      .spyOn(prisma, "$queryRaw")
      .mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5432"));

    await basDataAvailability();
    await basDataAvailability();

    // A five-second Postgres blip must not leave the module dark until restart.
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("no BAS route handler calls the guard itself", () => {
  /**
   * The point of the wrapper is that a route cannot be written without the grant
   * check. A handler that called requireModuleAccess directly would work, and
   * would quietly re-establish the pattern where forgetting the call is possible.
   */
  it("app/api/modules/bas contains no requireModuleAccess call", async () => {
    const fs = await import("node:fs/promises");
    const root = path.join(process.cwd(), "app/api/modules/bas");

    const files: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
    }
    await walk(root);

    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = await fs.readFile(file, "utf8");
      // The call, not the name: a comment is free to explain why the guard is
      // not invoked here.
      expect(source, `${file} must go through withBas`).not.toContain(
        "requireModuleAccess(",
      );
      expect(source, `${file} must go through withBas`).toContain("withBas");
    }
  });
});
