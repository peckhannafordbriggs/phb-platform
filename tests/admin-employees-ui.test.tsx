// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Admin Employees list on the kit (2026-11-13), as RENDERED and as
 * driven: the Access column, the default sort and its headers, a row's
 * expanded panel and the routes its switches call, and the filters that
 * narrow the page live until Apply runs the query.
 *
 * The router is stubbed so a navigation is a recorded href, and `fetch` is
 * stubbed so a switch is a recorded request: what is asserted is that the
 * panel reaches the employee page's own routes with the employee page's own
 * bodies, and nothing else.
 */

const nav = vi.hoisted(() => ({ pushes: [] as string[], refreshes: 0 }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => {
      nav.pushes.push(href);
    },
    replace: () => undefined,
    refresh: () => {
      nav.refreshes += 1;
    },
    prefetch: () => undefined,
  }),
  usePathname: () => "/admin",
  useSearchParams: () => new URLSearchParams(),
}));

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminActions, AdminShell } from "@/app/(platform)/admin/admin-shell";
import {
  AccessCell,
  DEFAULT_FILTERS,
  EMPLOYEE_COLUMNS,
  EmployeesView,
  listHref,
  matchesFilters,
  nextSort,
  type AdminEmployeeRow,
  type AdminModule,
} from "@/app/(platform)/admin/employee-table";
import { buildInviteEmail } from "@/lib/admin/invite-email";

// ------------------------------------------------------------------ fixtures

const REAL: AdminModule[] = [
  { key: "change-orders", displayName: "Change Orders" },
  { key: "bas", displayName: "Building Automation" },
  { key: "cost-intelligence", displayName: "Cost Intelligence" },
  { key: "knowledge-base", displayName: "Knowledge Base" },
  { key: "freeze-protection", displayName: "Freeze Protection" },
];

/** Five real modules and eleven invented ones: the "15+ modules" case. */
const MANY: AdminModule[] = [
  ...REAL,
  ...Array.from({ length: 11 }, (_, i) => ({ key: `extra-${i + 1}`, displayName: `Extra Module ${i + 1}` })),
];

const employee = (over: Partial<AdminEmployeeRow> = {}): AdminEmployeeRow => ({
  id: "00000000-0000-4000-8000-000000000001",
  email: "jordan.lee@phb1899.com",
  firstName: "Jordan",
  lastName: "Lee",
  positionOther: null,
  profileCompleted: true,
  status: "active",
  isPlatformAdmin: false,
  lastLoginAt: new Date("2026-11-12T15:00:00Z"),
  position: { id: "p1", name: "Project Manager" },
  department: { id: "d1", name: "Construction" },
  grantedModuleKeys: [],
  moduleAdminKeys: [],
  ...over,
});

const nobody = employee({ id: "00000000-0000-4000-8000-00000000000a", email: "sam.nobody@phb1899.com", firstName: "Sam", lastName: "Nobody" });
const two = employee({
  id: "00000000-0000-4000-8000-00000000000b",
  email: "taylor.two@phb1899.com",
  firstName: "Taylor",
  lastName: "Two",
  grantedModuleKeys: ["change-orders", "bas"],
  moduleAdminKeys: ["bas"],
  department: { id: "d2", name: "Service" },
});
const everyone = employee({
  id: "00000000-0000-4000-8000-00000000000c",
  email: "casey.all@phb1899.com",
  firstName: "Casey",
  lastName: "All",
  status: "disabled",
  grantedModuleKeys: MANY.map((m) => m.key),
  moduleAdminKeys: [],
});

const DEPARTMENTS = [
  { id: "d1", name: "Construction" },
  { id: "d2", name: "Service" },
];

function view(over: Partial<Parameters<typeof EmployeesView>[0]> = {}) {
  return createElement(EmployeesView, {
    employees: [nobody, two, everyone],
    modules: MANY,
    departments: DEPARTMENTS,
    applied: DEFAULT_FILTERS,
    sort: "access",
    dir: "asc",
    page: 1,
    pageSize: 25,
    total: 3,
    employeesTotal: 3,
    totalPages: 1,
    filtered: false,
    ...over,
  });
}

// ------------------------------------------------------------------ harness

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<{ root: Root; host: HTMLDivElement }> = [];

async function mount(element: React.ReactElement): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push({ root, host });
  await act(async () => {
    root.render(element);
  });
  return host;
}

async function click(el: Element | null | undefined): Promise<void> {
  if (!(el instanceof HTMLElement)) throw new Error("nothing to click");
  await act(async () => {
    el.click();
  });
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const byText = (host: ParentNode, selector: string, text: string) =>
  Array.from(host.querySelectorAll(selector)).find((el) => el.textContent?.trim() === text);

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  nav.pushes.length = 0;
  nav.refreshes = 0;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  for (const { root, host } of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }
  vi.unstubAllGlobals();
});

// -------------------------------------------------------------------- tests

describe("the Access column", () => {
  it("is a count in words and nothing else: no chip, no diamond, no module name", () => {
    const markup = renderToStaticMarkup(createElement(AccessCell, { employee: two, modules: REAL }));
    expect(markup).toBe('<span class="tabular-nums" data-testid="admin-access-cell">2 modules</span>');
    expect(markup).not.toContain("diamond");
    expect(markup).not.toContain("Change Orders");
    expect(markup).not.toContain("Building Automation");
    expect(markup).not.toContain("BAS");

    const one = employee({ grantedModuleKeys: ["bas"] });
    expect(renderToStaticMarkup(createElement(AccessCell, { employee: one, modules: REAL }))).toContain(">1 module</span>");
    expect(renderToStaticMarkup(createElement(AccessCell, { employee: everyone, modules: MANY }))).toContain(">16 modules</span>");
  });

  it("counts only the active modules the registry lists, which is what the panel can show", () => {
    const retired = employee({ grantedModuleKeys: ["change-orders", "no-such-module"] });
    expect(renderToStaticMarkup(createElement(AccessCell, { employee: retired, modules: REAL }))).toContain(">1 module</span>");
  });

  it("says No access, in words and in grey, for nobody", () => {
    const markup = renderToStaticMarkup(createElement(AccessCell, { employee: nobody, modules: REAL }));
    expect(markup).toBe('<span class="text-[var(--muted)]">No access</span>');
  });
});

describe("sorting", () => {
  it("opens on Access ascending, and every header carries the next sort in its href", () => {
    const markup = renderToStaticMarkup(view());
    expect(markup).toContain('data-sort="access" data-sort-state="asc"');
    expect(markup).toContain('data-sort="name" data-sort-state="none"');
    expect(markup).toContain('aria-label="Access, sorted ascending. Sort by access"');
    // The active column flips; another opens in its natural direction.
    expect(markup).toContain('href="/admin?sort=access&amp;dir=desc"');
    expect(markup).toContain('href="/admin?sort=name&amp;dir=asc"');
    expect(markup).toContain('href="/admin?sort=lastLogin&amp;dir=desc"');
    expect(markup).toContain('href="/admin?sort=status&amp;dir=asc"');
  });

  it("nextSort flips the active column and opens another in its natural direction", () => {
    expect(nextSort({ sort: "access", dir: "asc" }, "access")).toEqual({ sort: "access", dir: "desc" });
    expect(nextSort({ sort: "access", dir: "asc" }, "lastLogin")).toEqual({ sort: "lastLogin", dir: "desc" });
    expect(nextSort({ sort: "lastLogin", dir: "desc" }, "lastLogin")).toEqual({ sort: "lastLogin", dir: "asc" });
    expect(nextSort({ sort: "name", dir: "desc" }, "status")).toEqual({ sort: "status", dir: "asc" });
  });

  it("the URL carries only what differs from the defaults, so the default view is /admin", () => {
    expect(listHref(DEFAULT_FILTERS, "access", "asc", 1)).toBe("/admin");
    expect(listHref({ ...DEFAULT_FILTERS, q: " lee " }, "access", "asc", 2)).toBe("/admin?q=lee&page=2");
    expect(listHref({ ...DEFAULT_FILTERS, scope: "none", status: "disabled" }, "name", "asc", 1)).toBe(
      "/admin?status=disabled&scope=none&sort=name&dir=asc",
    );
  });
});

describe("the filters", () => {
  it("match the way the server matches: name or email, module over scope, scope otherwise", () => {
    expect(matchesFilters(two, { ...DEFAULT_FILTERS, q: "TAYLOR" })).toBe(true);
    expect(matchesFilters(two, { ...DEFAULT_FILTERS, q: "two@" })).toBe(true);
    expect(matchesFilters(two, { ...DEFAULT_FILTERS, q: "casey" })).toBe(false);
    expect(matchesFilters(two, { ...DEFAULT_FILTERS, departmentId: "d2" })).toBe(true);
    expect(matchesFilters(two, { ...DEFAULT_FILTERS, departmentId: "d1" })).toBe(false);
    expect(matchesFilters(everyone, { ...DEFAULT_FILTERS, status: "disabled" })).toBe(true);
    expect(matchesFilters(two, { ...DEFAULT_FILTERS, status: "disabled" })).toBe(false);
    expect(matchesFilters(two, { ...DEFAULT_FILTERS, moduleKey: "bas" })).toBe(true);
    expect(matchesFilters(two, { ...DEFAULT_FILTERS, moduleKey: "knowledge-base" })).toBe(false);
    // A module filter wins over the scope, as on the server.
    expect(matchesFilters(two, { ...DEFAULT_FILTERS, moduleKey: "bas", scope: "none" })).toBe(true);
    expect(matchesFilters(nobody, { ...DEFAULT_FILTERS, scope: "none" })).toBe(true);
    expect(matchesFilters(nobody, { ...DEFAULT_FILTERS, scope: "granted" })).toBe(false);
    expect(matchesFilters(two, { ...DEFAULT_FILTERS, scope: "granted" })).toBe(true);
  });

  it("narrow the page live as you type, say so, and Apply runs the query into the URL", async () => {
    const host = await mount(view());
    const count = () => host.querySelector('[data-testid="admin-employees-count"]')?.textContent;
    const rows = () => host.querySelectorAll('input[aria-label^="Select "]:not([aria-label="Select all on this page"])');
    expect(rows()).toHaveLength(3);
    expect(count()).toBe("3 employees");

    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search employees"]');
    await type(search!, "taylor");
    expect(rows()).toHaveLength(1);
    expect(count()).toBe("1 of 3 on this page match. Apply to search all 3.");
    expect(nav.pushes).toEqual([]);

    // Apply: the form submits, the drafted filters go to the server and the URL.
    const form = host.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(nav.pushes).toEqual(["/admin?q=taylor"]);
  });

  it("a dropdown narrows live too, and Reset clears the draft and the URL together", async () => {
    const host = await mount(view({ applied: { ...DEFAULT_FILTERS, scope: "granted" }, filtered: true }));
    // Opened on "With a grant" from the URL: the page's rows are what the server sent, unnarrowed.
    expect(host.querySelector('[data-testid="admin-employees-count"]')?.textContent).toBe("3 employees matching the current filters");

    await click(host.querySelector('button[aria-label="Status"]'));
    await click(byText(host, '[role="option"]', "Disabled"));
    const rows = host.querySelectorAll('input[aria-label^="Select "]:not([aria-label="Select all on this page"])');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute("aria-label")).toBe("Select casey.all@phb1899.com");

    await click(byText(host, "button", "Reset"));
    expect(nav.pushes).toEqual(["/admin"]);
    expect(host.querySelector('button[aria-label="Status"]')?.textContent).toBe("Any");
    expect(host.querySelector('button[aria-label="Show"]')?.textContent).toBe("Everyone");
  });

  it("the page's own empty state when the draft matches nobody on this page", async () => {
    const host = await mount(view());
    await type(host.querySelector<HTMLInputElement>('input[aria-label="Search employees"]')!, "zzz");
    expect(host.textContent).toContain("No one on this page matches");
    expect(host.textContent).toContain("Apply to search all 3 employees.");
  });
});

describe("a row's expanded panel", () => {
  const panelFor = (host: ParentNode) => host.querySelector('[data-testid="admin-access-panel"]');

  it("opens from the chevron and lists every module with a switch, the settings switch only where it belongs", async () => {
    const host = await mount(view());
    expect(panelFor(host)).toBeNull();

    await click(host.querySelector('button[aria-label="Show access for Taylor Two"]'));
    const panel = panelFor(host);
    expect(panel).not.toBeNull();
    expect(host.querySelector('button[aria-label="Hide access for Taylor Two"]')?.getAttribute("aria-expanded")).toBe("true");

    const cards = panel!.querySelectorAll('[data-testid="admin-access-module"]');
    expect(cards).toHaveLength(16);
    // A wrapping grid, not a row: sixteen modules never need a sideways scroll.
    expect(panel!.querySelector("ul")?.className).toContain("grid-cols-[repeat(auto-fill,minmax(16rem,1fr))]");

    // Granted first, then the rest, each half in the registry's order; the
    // panel is the only place a specific grant is named.
    const names = Array.from(cards).map((card) => card.querySelector(".font-medium")?.textContent);
    expect(names.slice(0, 2)).toEqual(["Change Orders", "Building Automation"]);
    expect(names.slice(2)).toEqual(MANY.filter((m) => !two.grantedModuleKeys.includes(m.key)).map((m) => m.displayName));
    expect(Array.from(cards).map((card) => card.getAttribute("data-granted"))).toEqual([
      "true",
      "true",
      ...Array.from({ length: 14 }, () => "false"),
    ]);

    const switches = (card: Element) => Array.from(card.querySelectorAll('[role="switch"]'));
    const co = byText(panel!, '[data-testid="admin-access-module"] .font-medium', "Change Orders")!.closest("li")!;
    const bas = byText(panel!, '[data-testid="admin-access-module"] .font-medium', "Building Automation")!.closest("li")!;
    const kb = byText(panel!, '[data-testid="admin-access-module"] .font-medium', "Knowledge Base")!.closest("li")!;

    // Change Orders: granted, and no settings screen, so no settings switch.
    expect(switches(co).map((s) => [s.textContent, s.getAttribute("aria-checked")])).toEqual([["Access", "true"]]);
    // Building Automation: granted and a module admin, so both, both on.
    expect(switches(bas).map((s) => [s.textContent, s.getAttribute("aria-checked")])).toEqual([
      ["Access", "true"],
      ["Can change settings", "true"],
    ]);
    // Knowledge Base: not granted, so only Access, off.
    expect(switches(kb).map((s) => [s.textContent, s.getAttribute("aria-checked")])).toEqual([["Access", "false"]]);

    // The module's own colour on each card, the way the sidebar draws it.
    expect(bas.querySelector(".diamond")?.getAttribute("style")).toBe("color: var(--phb-cyan);");

    await click(host.querySelector('button[aria-label="Hide access for Taylor Two"]'));
    expect(panelFor(host)).toBeNull();
  });

  it("the switches call the employee page's own routes, and nothing else", async () => {
    const host = await mount(view());
    await click(host.querySelector('button[aria-label="Show access for Taylor Two"]'));
    const panel = panelFor(host)!;
    const card = (name: string) => byText(panel, '[data-testid="admin-access-module"] .font-medium', name)!.closest("li")!;
    const sw = (li: Element, label: string) => byText(li, '[role="switch"]', label);

    // Grant: POST to the grants collection with the module in the body.
    await click(sw(card("Knowledge Base"), "Access"));
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/admin/employees/${two.id}/grants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moduleKey: "knowledge-base" }),
    });

    // Revoke: DELETE the grant by module.
    await click(sw(card("Change Orders"), "Access"));
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/admin/employees/${two.id}/grants/change-orders`, { method: "DELETE" });

    // Settings rights: PUT the flag.
    await click(sw(card("Building Automation"), "Can change settings"));
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/admin/employees/${two.id}/grants/bas/admin`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isModuleAdmin: false }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toMatch(/^\/api\/admin\/employees\//);
    }
    // Each success re-reads the page from the server; the panel stays open.
    expect(nav.refreshes).toBe(3);
    expect(panelFor(host)).not.toBeNull();
  });

  it("shows the server's refusal beside the switches, in its own words", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "That module has no settings screen, so there is nothing to administer." } }), {
        status: 422,
      }),
    );
    const host = await mount(view());
    await click(host.querySelector('button[aria-label="Show access for Taylor Two"]'));
    const panel = panelFor(host)!;
    await click(byText(byText(panel, '[data-testid="admin-access-module"] .font-medium', "Knowledge Base")!.closest("li")!, '[role="switch"]', "Access"));
    expect(panel.querySelector('[role="alert"]')?.textContent).toBe(
      "That module has no settings screen, so there is nothing to administer.",
    );
    expect(nav.refreshes).toBe(0);
  });
});

describe("the chrome", () => {
  it("is the module shells' shape with the chrome purple by name, one tab, and the three actions as kit buttons", () => {
    const markup = renderToStaticMarkup(
      <AdminShell actions={<AdminActions email={buildInviteEmail()} />}>body</AdminShell>,
    );
    expect(markup).toMatch(/^<div class="dashboard-ground -mx-8 -my-8 px-8 py-8">/);
    expect(markup).toContain('style="--module-accent:var(--accent);--module-accent-ink:var(--accent)"');
    expect(markup).toContain(">Admin</h1>");
    expect(markup).toContain('<nav aria-label="Admin sections"');
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
    expect(markup).toContain(">Employees<");
    // Three actions, kit buttons: the invite (a button), the two links.
    expect(markup).toMatch(/<button[^>]*aria-expanded="false"[^>]*>[\s\S]*Copy invite email/);
    expect(markup).toMatch(/<a [^>]*href="\/admin\/audit"[^>]*>[\s\S]*Audit log/);
    expect(markup).toMatch(/<a [^>]*href="\/admin\/lists"[^>]*>[\s\S]*Positions &amp; departments/);
    // The one red primary on the screen is Apply, not a header action.
    expect(markup).not.toContain("bg-[var(--phb-red-btn)]");
  });

  it("the list's Apply is the red primary, the Reset the white secondary, and the columns are the list's own", () => {
    const markup = renderToStaticMarkup(view());
    expect(markup).toMatch(/<button type="submit"[^>]*class="[^"]*bg-\[var\(--phb-red-btn\)\][^"]*"[^>]*>Apply<\/button>/);
    expect(markup).toMatch(/<button type="button"[^>]*class="[^"]*border-\[var\(--border\)\] bg-white[^"]*"[^>]*>Reset<\/button>/);
    expect(markup).toContain(`grid-template-columns:${EMPLOYEE_COLUMNS}`);
    // The status pills keep the colours the table had: teal for active, maroon for disabled.
    expect(markup).toContain("text-[var(--phb-teal-ink)]");
    expect(markup).toContain("text-[var(--phb-maroon)]");
    // No row names a module while collapsed; the counts do the work.
    expect(markup).toContain(">No access</span>");
    expect(markup).toContain(">2 modules</span>");
    expect(markup).toContain(">16 modules</span>");
    expect(markup).not.toContain('style="color:var(--phb-cyan)"');
    expect(markup).not.toContain("Building Automation");
  });
});
