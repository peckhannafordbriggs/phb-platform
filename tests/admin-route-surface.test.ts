import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Importing a route module pulls in the auth stack. Only the module's exported
// shape is under test here, so the session is stubbed exactly as admin.test.ts
// does - nothing below signs in or calls a handler.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import * as auditRoute from "@/app/api/admin/audit/route";

/**
 * What the admin API surface is allowed to be.
 *
 * The tests in admin.test.ts enumerate routes by hand and assert a non-admin
 * gets 403 from each. That is worth having and it has one weakness: a route
 * added tomorrow is not in the list, and nothing notices. PHASE-10's acceptance
 * criterion says "every `/api/admin/*` route, including new ones", so this file
 * discovers them from the filesystem instead of trusting a list to stay current.
 *
 * Two properties, both structural:
 *
 *   1. Every admin route goes through `withAdmin`, which is where the
 *      `isPlatformAdmin` check lives. A handler calling `requireAdmin` itself
 *      would work and would quietly re-establish the pattern where forgetting it
 *      is possible.
 *   2. Nothing anywhere can edit or delete an audit row.
 */

const ADMIN_API_ROOT = "app/api/admin";

async function routeFiles(root: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === "route.ts") found.push(full);
    }
  }

  await walk(path.join(process.cwd(), root));
  return found;
}

describe("every admin route is guarded the same way", () => {
  it("finds the admin routes at all", async () => {
    const files = await routeFiles(ADMIN_API_ROOT);

    // A guard that silently matches nothing passes forever.
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it("routes through withAdmin, and never calls the guard directly", async () => {
    for (const file of await routeFiles(ADMIN_API_ROOT)) {
      const source = await readFile(file, "utf8");

      expect(source, `${file} must go through withAdmin`).toContain("withAdmin");
      expect(source, `${file} must not call requireAdmin itself`).not.toContain(
        "requireAdmin(",
      );
    }
  });

  it("has no create-employee handler anywhere under /api/admin", async () => {
    /**
     * CLAUDE.md: employees self-provision, admins grant access. There is no
     * create-employee endpoint, and the absence is the enforcement.
     *
     * The employees collection is the file that would grow one, so its POST is
     * asserted absent in admin.test.ts. This is the wider version: no route
     * under /api/admin creates an employee row at all.
     */
    for (const file of await routeFiles(ADMIN_API_ROOT)) {
      const source = await readFile(file, "utf8");

      expect(source, `${file} must not create an employee`).not.toMatch(
        /employee\.create\b/,
      );
      expect(source, `${file} must not create employees in bulk`).not.toMatch(
        /employee\.createMany\b/,
      );
    }
  });
});

describe("audit rows cannot be edited or deleted", () => {
  /**
   * PHASE-10: "No endpoint can edit or delete an audit row — asserted by test."
   *
   * The database trigger already refuses both, and audit.test.ts proves that
   * against a live connection. This is the other half: the trigger is the
   * backstop, and the absence of any route that would hit it is the design. A
   * route that tried would 500 in production rather than 404 — the failure
   * would be discovered by an admin, not by a test.
   */
  it("the audit route exposes GET and nothing else", () => {
    const exported = auditRoute as Record<string, unknown>;

    expect(exported.GET).toBeTypeOf("function");
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      expect(exported[method], `audit route must not export ${method}`).toBeUndefined();
    }
  });

  it("no admin route writes to auditEvent except by appending", async () => {
    for (const file of await routeFiles(ADMIN_API_ROOT)) {
      const source = await readFile(file, "utf8");

      for (const forbidden of [
        "auditEvent.update",
        "auditEvent.updateMany",
        "auditEvent.delete",
        "auditEvent.deleteMany",
        "auditEvent.upsert",
      ]) {
        expect(source, `${file} must not call ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("nothing in lib/ mutates an audit row either", async () => {
    const files: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        // The generated Prisma client naturally contains every method name.
        if (entry.name === "generated") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
    }
    await walk(path.join(process.cwd(), "lib"));

    for (const file of files) {
      const source = await readFile(file, "utf8");

      for (const forbidden of [
        "auditEvent.update",
        "auditEvent.delete",
        "auditEvent.upsert",
      ]) {
        expect(source, `${file} must not call ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
