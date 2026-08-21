import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

/**
 * Acceptance criterion 1 of B2: the module appears in the sidebar for an employee
 * holding a bas grant.
 *
 * Verified here rather than in a browser, because a browser check needs an
 * interactive Entra sign-in and proves nothing the next person can re-run. Two
 * halves, and both are needed: the shell has to hand the module to the sidebar,
 * and the sidebar has to turn it into a link that points somewhere real.
 *
 * usePathname is mocked because Sidebar is a client component and there is no
 * router outside a request. Everything else - the guard, buildMe, the grant
 * query, the component - is real.
 */
vi.mock("@/auth", () => ({ auth: vi.fn(), signOut: vi.fn() }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/",
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { auth } from "@/auth";
import { AppShell } from "@/components/app-shell";
import { Sidebar } from "@/components/sidebar";
import type { MeModule } from "@/lib/me";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import {
  createEmployee,
  disconnectDb,
  grantModule,
  resetDb,
  seedBasModule,
  seedChangeOrdersModule,
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

/** The modules AppShell actually passes down, found by walking what it returned. */
function sidebarModules(tree: unknown): MeModule[] | null {
  if (tree === null || typeof tree !== "object") return null;

  const node = tree as {
    props?: { modules?: unknown; children?: unknown };
  };

  if (Array.isArray(node.props?.modules)) return node.props.modules as MeModule[];

  const children = node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = sidebarModules(child);
    if (found !== null) return found;
  }

  return null;
}

beforeEach(async () => {
  vi.clearAllMocks();
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

describe("the sidebar for an employee holding a bas grant", () => {
  it("is handed Building Automation by the shell", async () => {
    const employee = await createEmployee({ entraOid: "oid-shell-granted" });
    await grantModule(employee.id, BAS_MODULE_KEY);
    signedInAs("oid-shell-granted");

    const modules = sidebarModules(await AppShell({ children: null }));

    expect(modules?.map((m) => m.key)).toEqual([BAS_MODULE_KEY]);
  });

  it("renders a link to /bas labelled Building Automation", async () => {
    const employee = await createEmployee({ entraOid: "oid-shell-render" });
    await grantModule(employee.id, "change-orders");
    await grantModule(employee.id, BAS_MODULE_KEY);
    signedInAs("oid-shell-render");

    const modules = sidebarModules(await AppShell({ children: null }));
    expect(modules).not.toBeNull();

    const html = renderToStaticMarkup(
      createElement(Sidebar, {
        modules: modules ?? [],
        isPlatformAdmin: false,
        employeeName: "Test Person",
        employeeEmail: "test@phb1899.com",
        signOutAction: async () => {},
      }),
    );

    // The label the employee reads, and the href it leads to. The href has to
    // match the app/(modules)/bas segment or the item is a link to a 404.
    expect(html).toContain('href="/bas"');
    expect(html).toContain("Building Automation");
    // Still alongside Change Orders, not instead of it.
    expect(html).toContain('href="/change-orders"');
    expect(html.indexOf("Change Orders")).toBeLessThan(
      html.indexOf("Building Automation"),
    );
  });

  it("renders no Systems section at all for an employee with no grants", async () => {
    await createEmployee({ entraOid: "oid-shell-nogrant" });
    signedInAs("oid-shell-nogrant");

    const modules = sidebarModules(await AppShell({ children: null }));

    const html = renderToStaticMarkup(
      createElement(Sidebar, {
        modules: modules ?? [],
        isPlatformAdmin: false,
        employeeName: "Test Person",
        employeeEmail: "test@phb1899.com",
        signOutAction: async () => {},
      }),
    );

    expect(modules).toEqual([]);
    expect(html).not.toContain("Building Automation");
    expect(html).not.toContain('href="/bas"');
    expect(html).not.toContain("Systems");
  });
});
