import { readdir } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// adminFailureResponse imports the authz stack, which imports next-auth.
// Nothing here signs in or calls a handler; the session is stubbed exactly as
// tests/admin-route-surface.test.ts does, for the same reason.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import {
  MODULE_SETTINGS_SURFACES,
  hasSettingsSurface,
  moduleSettingsHref,
} from "@/lib/module-settings";
import { setModuleAdmin } from "@/lib/admin/service";
import { adminFailureResponse } from "@/lib/admin/route-helpers";
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
 * The module-admin checkbox used to be offered for every granted module, which
 * meant the admin screen advertised "Can change settings for Change Orders" -
 * a permission that leads nowhere, because Change Orders is configured in
 * Exchange and in the flows and has no settings screen at all.
 *
 * Two halves, and this file tests both: a declaration of which modules have a
 * settings surface, and a refusal in the one place that writes the flag. The
 * refusal is the half that matters - hiding a checkbox is a rendering decision
 * and the API would otherwise still accept the request and write an audit row
 * saying it happened.
 */

afterAll(disconnectDb);

describe("the declaration", () => {
  /**
   * Every declared href resolves to a page that exists.
   *
   * This is the test that earns the code table its place over a `has_settings`
   * column: a boolean in Postgres is a claim nothing can check, and it stays
   * true after the page is deleted. An href can be walked back to a file.
   *
   * Route groups - the `(modules)` in the path - are not part of the URL, so
   * they are stripped. That is the same rule Next.js applies.
   */
  it("points every module at a settings page that exists", async () => {
    const routes = await appRoutes();

    for (const [moduleKey, href] of MODULE_SETTINGS_SURFACES) {
      expect(
        routes,
        `${moduleKey} declares ${href}, but no page renders that route`,
      ).toContain(href);
    }
  });

  /**
   * BAS is declared. Asserted explicitly rather than left to the loop above,
   * which passes happily when the table is empty: deleting the entry would
   * remove the only way to give anyone BAS settings, and no other test would
   * notice.
   */
  it("declares the BAS settings screen", () => {
    expect(moduleSettingsHref("bas")).toBe("/bas/settings");
    expect(hasSettingsSurface("bas")).toBe(true);
  });

  /**
   * An unknown key is not an error and not a surface. A module added tomorrow
   * with no entry here withholds the permission rather than offering one that
   * leads nowhere - absence can only under-permit.
   */
  it("treats an undeclared module as having no settings", () => {
    expect(hasSettingsSurface("change-orders")).toBe(false);
    expect(hasSettingsSurface("a-module-that-does-not-exist")).toBe(false);
    expect(moduleSettingsHref("change-orders")).toBeNull();
  });

  /**
   * The guard used to fail OPEN for these.
   *
   * With an object literal, `lookup["constructor"]` returns a function off
   * `Object.prototype` rather than undefined, so `?? null` never fired and the
   * module was treated as having a settings screen - the one direction this
   * check must never fail in. A Map has no prototype chain to fall through.
   *
   * `modules.key` is a free-text primary key, so these are writable keys and not
   * merely theoretical ones. Named here so the fix cannot be undone by tidying
   * the Map back into a literal without a test going red.
   */
  it.each([
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "__proto__",
    "isPrototypeOf",
    "propertyIsEnumerable",
  ])("does not inherit a settings surface from Object.prototype: %s", (key) => {
    expect(moduleSettingsHref(key)).toBeNull();
    expect(hasSettingsSurface(key)).toBe(false);
  });
});

describe("setModuleAdmin", () => {
  beforeEach(async () => {
    await resetDb();
    await seedChangeOrdersModule();
    await seedBasModule();
  });

  it("refuses the flag on a module with no settings screen", async () => {
    const admin = await createEmployee({ isPlatformAdmin: true });
    const target = await createEmployee();
    await grantModule(target.id, "change-orders");

    const result = await setModuleAdmin(
      admin.id,
      target.id,
      "change-orders",
      true,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("no_settings_surface");
  });

  /**
   * A refusal leaves nothing behind. The audit log is the record of what was
   * done to an employee's access, so a `grant.admin_added` row for a change
   * that did not happen would be a false entry in the one place an admin goes
   * to find out why somebody has something.
   */
  it("writes neither the column nor an audit row when it refuses", async () => {
    const admin = await createEmployee({ isPlatformAdmin: true });
    const target = await createEmployee();
    await grantModule(target.id, "change-orders");

    await setModuleAdmin(admin.id, target.id, "change-orders", true);

    const grant = await testDb.moduleGrant.findUnique({
      where: {
        employeeId_moduleKey: {
          employeeId: target.id,
          moduleKey: "change-orders",
        },
      },
      select: { isModuleAdmin: true },
    });
    expect(grant?.isModuleAdmin).toBe(false);

    const events = await testDb.auditEvent.count({
      where: { targetEmployeeId: target.id },
    });
    expect(events).toBe(0);
  });

  it("still grants it on a module that has settings", async () => {
    const admin = await createEmployee({ isPlatformAdmin: true });
    const target = await createEmployee();
    await grantModule(target.id, "bas");

    const result = await setModuleAdmin(admin.id, target.id, "bas", true);

    expect(result.ok).toBe(true);
    const grant = await testDb.moduleGrant.findUnique({
      where: { employeeId_moduleKey: { employeeId: target.id, moduleKey: "bas" } },
      select: { isModuleAdmin: true },
    });
    expect(grant?.isModuleAdmin).toBe(true);
  });

  /**
   * The escape hatch, and the reason the refusal is one-directional.
   *
   * A flag set before this rule existed - or left behind by a module that lost
   * its settings screen - has to be removable, or hiding it would make it
   * permanent. The local development database had exactly this row for
   * change-orders when the rule was written.
   */
  it("always allows clearing the flag, even with no settings screen", async () => {
    const admin = await createEmployee({ isPlatformAdmin: true });
    const target = await createEmployee();
    await grantModule(target.id, "change-orders");
    await grantModuleAdmin(target.id, "change-orders");

    const result = await setModuleAdmin(
      admin.id,
      target.id,
      "change-orders",
      false,
    );

    expect(result.ok).toBe(true);
    const grant = await testDb.moduleGrant.findUnique({
      where: {
        employeeId_moduleKey: {
          employeeId: target.id,
          moduleKey: "change-orders",
        },
      },
      select: { isModuleAdmin: true },
    });
    expect(grant?.isModuleAdmin).toBe(false);

    const removed = await testDb.auditEvent.count({
      where: { targetEmployeeId: target.id, action: "grant.admin_removed" },
    });
    expect(removed).toBe(1);
  });

  /**
   * The same hole, at the only place that writes the column.
   *
   * A module row keyed `constructor` is a legal row - `modules.key` is a
   * free-text primary key - so this is the whole failure path, not a unit test
   * of the lookup: real module, real grant, real call. Before the Map it
   * returned ok and wrote `grant.admin_added`.
   */
  it("refuses a module whose key is an Object.prototype member", async () => {
    await testDb.module.create({
      data: { key: "constructor", displayName: "Constructor", sortOrder: 900 },
    });

    const admin = await createEmployee({ isPlatformAdmin: true });
    const target = await createEmployee();
    await grantModule(target.id, "constructor");

    const result = await setModuleAdmin(
      admin.id,
      target.id,
      "constructor",
      true,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("no_settings_surface");

    const events = await testDb.auditEvent.count({
      where: { targetEmployeeId: target.id },
    });
    expect(events).toBe(0);
  });

  /**
   * The grant check comes first. "Grant access first" is a more useful answer
   * than "no settings screen" to an admin who has not granted the module,
   * and the two messages must not race.
   */
  it("reports the missing grant before the missing settings screen", async () => {
    const admin = await createEmployee({ isPlatformAdmin: true });
    const target = await createEmployee();

    const result = await setModuleAdmin(
      admin.id,
      target.id,
      "change-orders",
      true,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_found");
  });
});

/**
 * 422, not 403.
 *
 * A 403 would tell the admin they lack the standing to do this, and they do
 * not: no admin can make the state exist, because the module has no settings
 * screen. That is an invalid combination of values, which is what
 * docs/07-conventions.md reserves 422 for.
 */
describe("the HTTP mapping", () => {
  it("answers 422 for a module with no settings screen", () => {
    const response = adminFailureResponse("no_settings_surface", "nope");
    expect(response.status).toBe(422);
  });
});

/**
 * Every route under app/ that has a page, as a URL path.
 *
 * Walks the directory rather than taking a list, so a settings page that is
 * moved or renamed fails the declaration test instead of quietly disagreeing
 * with it. Route groups `(like-this)` and private folders `_like-this` are not
 * part of the URL; dynamic segments are left as written, because no settings
 * href is parameterised and one that was would deserve its own decision.
 */
async function appRoutes(): Promise<string[]> {
  const root = path.resolve(process.cwd(), "app");
  const found: string[] = [];

  async function walk(dir: string, segments: string[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const isGroup = entry.name.startsWith("(") && entry.name.endsWith(")");
        const isPrivate = entry.name.startsWith("_");
        await walk(
          path.join(dir, entry.name),
          isGroup || isPrivate ? segments : [...segments, entry.name],
        );
        continue;
      }

      if (/^page\.tsx?$/.test(entry.name)) {
        found.push(`/${segments.join("/")}`);
      }
    }
  }

  await walk(root, []);
  return found;
}
