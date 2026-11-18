import { describe, expect, it, vi } from "vitest";

/**
 * The Settings bar (2026-11-12): what the module's tab bar becomes while
 * Settings is open - Back · General · Usage, drawn by the same kit TabBar
 * the Reports bar uses, as RENDERED. What is asserted is the HTML: the
 * three items in one row with no module bar beside them, the right item
 * active for each path, the query string carried on every item including
 * Back, a deep link landing on the bar directly, and Back restoring the
 * module bar with Projects selected. The routing is the shared sub-bar
 * rule, held here as pure functions beside the Reports bar's.
 */
const nav = vi.hoisted(() => ({ pathname: "/bas/settings", search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BasShell } from "@/app/(modules)/bas/bas-shell";
import { REPORTS_SUB_BAR, activeReportsItemHref } from "@/app/(modules)/bas/reports/bar";
import { SETTINGS_BAR, SETTINGS_SUB_BAR, activeSettingsItemHref } from "@/app/(modules)/bas/settings/bar";
import { SUB_BAR_BACK_HREF, activeSubBarItemHref } from "@/app/(modules)/bas/sub-bar";
import { SUB_BARS, subBarFor } from "@/app/(modules)/bas/sub-bars";

const Shell = BasShell as unknown as (props: { blurb: string; canAdminister?: boolean }) => React.ReactNode;
const shell = () => renderToStaticMarkup(createElement(Shell, { blurb: "", canAdminister: true }, "body"));

const barOf = (html: string, label: string): string => {
  const found = new RegExp(`<nav[^>]*aria-label="${label}"[\\s\\S]*?</nav>`).exec(html);
  expect(found, label).not.toBeNull();
  return found![0];
};
const anchors = (bar: string) => [...bar.matchAll(/<a[^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
const labels = (bar: string) => anchors(bar).map((a) => a.replace(/<[^>]+>/g, "").trim());
// next/link writes href last; the active item carries aria-current.
const activeHref = (bar: string) => /<a[^>]*aria-current="page"[^>]*href="([^"]+)"/.exec(bar)?.[1] ?? null;
const hrefOf = (anchor: string) => /href="([^"]+)"/.exec(anchor)?.[1] ?? null;

describe("the Settings bar", () => {
  it("replaces the module bar while Settings is open: Back, General, Usage, in one row, General active on the settings page", () => {
    nav.pathname = "/bas/settings";
    nav.search = "";
    const html = shell();
    const bar = barOf(html, "Settings sections");
    expect(labels(bar)).toEqual(["Back", "General", "Usage"]);
    expect(activeHref(bar)).toBe("/bas/settings");
    // Never a second row: the module bar is not in the markup at all, and neither is the Reports bar.
    expect(html).not.toContain('aria-label="Building Automation sections"');
    expect(html).not.toContain('aria-label="Reports sections"');
    expect(html.match(/<nav /g)).toHaveLength(1);
    // Back is the same quiet item as on the Reports bar: the arrow, never active, the module's default tab.
    const back = anchors(bar)[0]!;
    expect(back).toContain("<svg");
    expect(hrefOf(back)).toBe("/bas");
    expect(back).not.toContain("aria-current");
    expect(SUB_BAR_BACK_HREF).toBe("/bas");
  });

  it("lands a deep link to Usage on the bar directly, Usage active, and carries the query string on every item including Back", () => {
    nav.pathname = "/bas/settings/usage";
    nav.search = "q=office&range=7d";
    const html = shell();
    const bar = barOf(html, "Settings sections");
    expect(labels(bar)).toEqual(["Back", "General", "Usage"]);
    // React escapes the ampersand in an attribute; the browser reads it back as one.
    expect(activeHref(bar)).toBe("/bas/settings/usage?q=office&amp;range=7d");
    expect(anchors(bar).map(hrefOf)).toEqual(["/bas?q=office&amp;range=7d", "/bas/settings?q=office&amp;range=7d", "/bas/settings/usage?q=office&amp;range=7d"]);
    expect(html.match(/<nav /g)).toHaveLength(1);
  });

  it("Back restores the module bar with Projects selected, carrying the query string, and no Settings bar", () => {
    nav.pathname = "/bas/settings";
    nav.search = "site=5";
    const back = anchors(barOf(shell(), "Settings sections"))[0]!;
    expect(hrefOf(back)).toBe("/bas?site=5");

    // Where Back lands: the module bar, Projects active, Settings offered again, and no sub-bar.
    nav.pathname = "/bas";
    const html = shell();
    expect(html).not.toContain('aria-label="Settings sections"');
    expect(html).not.toContain('aria-label="Reports sections"');
    const moduleBar = barOf(html, "Building Automation sections");
    expect(labels(moduleBar)).toEqual(["Projects", "Point Explorer", "Analyze", "Reports", "Collection Health", "Settings"]);
    expect(activeHref(moduleBar)).toBe("/bas?site=5");
    expect(html.match(/<nav /g)).toHaveLength(1);
    nav.search = "";
  });

  it("is data on the shared sub-bar shape, resolved by the same rule as the Reports bar", () => {
    expect(SETTINGS_BAR.map((i) => [i.href, i.label])).toEqual([["/bas/settings", "General"], ["/bas/settings/usage", "Usage"]]);
    expect(SETTINGS_SUB_BAR).toMatchObject({ tabHref: "/bas/settings", label: "Settings sections" });
    expect(SUB_BARS).toEqual([REPORTS_SUB_BAR, SETTINGS_SUB_BAR]);
    // The registry: which bar a path is inside, from the module tab it belongs to.
    expect(subBarFor("/bas/settings")?.label).toBe("Settings sections");
    expect(subBarFor("/bas/settings/usage")?.label).toBe("Settings sections");
    expect(subBarFor("/bas/settings/usage?x=1".split("?")[0]!)?.label).toBe("Settings sections");
    expect(subBarFor("/bas/reports/7")?.label).toBe("Reports sections");
    expect(subBarFor("/bas/reports/new")?.label).toBe("Reports sections");
    expect(subBarFor("/bas")).toBeNull();
    expect(subBarFor("/bas/points")).toBeNull();
    expect(subBarFor("/bas/settingsx")).toBeNull();
    // The items, as pure functions.
    expect(activeSettingsItemHref("/bas/settings")).toBe("/bas/settings");
    expect(activeSettingsItemHref("/bas/settings/usage")).toBe("/bas/settings/usage");
    expect(activeSettingsItemHref("/bas/settings/usage/")).toBe("/bas/settings/usage");
    expect(activeSettingsItemHref("/bas/settings/anything-else")).toBe("/bas/settings");
    expect(activeSettingsItemHref("/bas/points")).toBeNull();
    expect(activeSubBarItemHref(SETTINGS_SUB_BAR, "/bas/settings/usage")).toBe("/bas/settings/usage");
    // The Reports bar is unchanged on the shared rule, its editor-id rule included.
    expect(activeReportsItemHref("/bas/reports/generated/7")).toBe("/bas/reports");
    expect(activeReportsItemHref("/bas/reports/42/anything")).toBe("/bas/reports/scheduled");
    expect(activeReportsItemHref("/bas/settings")).toBeNull();
  });
});
