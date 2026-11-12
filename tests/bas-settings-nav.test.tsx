import { describe, expect, it, vi } from "vitest";

/**
 * The Settings tab's own row (2026-11-12): General and Usage, drawn by the
 * kit's TabBar under the module bar, as RENDERED. What is asserted is the
 * HTML: both items, the right one active for each path, the query string
 * carried, and the module bar keeping Settings active for the Usage route -
 * a deep link to /bas/settings/usage lands with both rows marked right.
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
import { BAS_SETTINGS_NAV, BasSettingsNav, activeSettingsItemHref } from "@/app/(modules)/bas/settings/settings-nav";
import { activeTabHref } from "@/app/(modules)/bas/tabs";

const Shell = BasShell as unknown as (props: { blurb: string; canAdminister?: boolean }) => React.ReactNode;

const row = (html: string): string => {
  const found = /<nav[^>]*aria-label="Building Automation settings"[\s\S]*?<\/nav>/.exec(html);
  expect(found).not.toBeNull();
  return found![0];
};
const anchors = (bar: string) => [...bar.matchAll(/<a[^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
const labels = (bar: string) => anchors(bar).map((a) => a.replace(/<[^>]+>/g, "").trim());
const activeHref = (bar: string) => /<a[^>]*aria-current="page"[^>]*href="([^"]+)"/.exec(bar)?.[1] ?? null;

describe("the Settings row", () => {
  it("draws General and Usage with the kit's bar, General active on the settings page", () => {
    nav.pathname = "/bas/settings";
    nav.search = "";
    const bar = row(renderToStaticMarkup(createElement(BasSettingsNav)));
    expect(labels(bar)).toEqual(["General", "Usage"]);
    expect(activeHref(bar)).toBe("/bas/settings");
    expect(BAS_SETTINGS_NAV.map((i) => i.href)).toEqual(["/bas/settings", "/bas/settings/usage"]);
  });

  it("marks Usage active at its route and carries the query string across both items", () => {
    nav.pathname = "/bas/settings/usage";
    nav.search = "q=office&range=7d";
    const bar = row(renderToStaticMarkup(createElement(BasSettingsNav)));
    // React escapes the ampersand in an attribute; the browser reads it back as one.
    expect(activeHref(bar)).toBe("/bas/settings/usage?q=office&amp;range=7d");
    expect(anchors(bar)[0]).toContain('href="/bas/settings?q=office&amp;range=7d"');
  });

  it("decides the item as a pure function, and the module bar keeps Settings active for the Usage deep link", () => {
    expect(activeSettingsItemHref("/bas/settings")).toBe("/bas/settings");
    expect(activeSettingsItemHref("/bas/settings/usage")).toBe("/bas/settings/usage");
    expect(activeSettingsItemHref("/bas/settings/usage/")).toBe("/bas/settings/usage");
    expect(activeSettingsItemHref("/bas/settings/anything-else")).toBe("/bas/settings");
    expect(activeTabHref("/bas/settings/usage")).toBe("/bas/settings");

    nav.pathname = "/bas/settings/usage";
    nav.search = "";
    const html = renderToStaticMarkup(createElement(Shell, { blurb: "", canAdminister: true }, "body"));
    const moduleBar = /<nav[^>]*aria-label="Building Automation sections"[\s\S]*?<\/nav>/.exec(html);
    expect(moduleBar).not.toBeNull();
    expect(activeHref(moduleBar![0])).toBe("/bas/settings");
    // Not the Reports bar: Settings → Usage is a Settings page.
    expect(html).not.toContain('aria-label="Reports sections"');
  });
});
