import { describe, expect, it, vi } from "vitest";

/**
 * The tab bar as it is actually RENDERED, not as `visibleBasTabs` computes it.
 *
 * tests/bas-settings.test.ts already proves the filter function omits Settings
 * for a non-admin. That is not the same claim: the filter could be correct and
 * `BasShell` could still render the full `BAS_TABS` list, because until B7.2 it
 * did exactly that. What is asserted here is the HTML.
 *
 * Why it matters enough to render React in a node-environment suite: a tab that
 * appears and then 404s on click confirms the tab exists to precisely the person
 * the 404 is hiding it from. It is the same leak a Next.js layout would create
 * by wrapping a page that called notFound(), and it is ruled out for the same
 * reason.
 *
 * next/navigation is stubbed because BasShell is a client component and the
 * hooks need a router. Nothing else is mocked - the real BasShell, the real
 * ModuleHeader, the real tab list.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/bas",
  useSearchParams: () => new URLSearchParams(""),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BasShell } from "@/app/(modules)/bas/bas-shell";

/**
 * `children` is supplied positionally, which React accepts and the prop type
 * does not describe. Cast at the call site rather than making `children`
 * optional on the component - the component is right and this is a test detail.
 */
const Shell = BasShell as unknown as (props: {
  blurb: string;
  canAdminister?: boolean;
}) => React.ReactNode;

function render(canAdminister: boolean): string {
  return renderToStaticMarkup(
    createElement(Shell, { blurb: "", canAdminister }, "body"),
  );
}

/** Tab labels in the order they appear in the markup. */
function renderedTabs(html: string): string[] {
  const nav = /<nav[^>]*aria-label="Building Automation sections"[\s\S]*?<\/nav>/.exec(
    html,
  );
  if (nav === null) throw new Error("no tab bar in the rendered output");

  return [...nav[0].matchAll(/<a[^>]*>([^<]+)<\/a>/g)].map((m) => m[1]!.trim());
}

describe("the rendered tab bar", () => {
  it("has a tab bar at all, so the assertions below are not vacuous", () => {
    expect(renderedTabs(render(true)).length).toBeGreaterThan(0);
  });

  /**
   * THE ONE THAT MATTERS. A non-admin must not see the tab.
   */
  it("omits Settings entirely for a BAS user without the admin flag", () => {
    const html = render(false);

    expect(renderedTabs(html)).toEqual(["Collection Health", "Point Explorer"]);

    // Not just the label - the href must not be in the markup either, or the
    // route is discoverable by reading the page source.
    expect(html).not.toContain("/bas/settings");
    expect(html).not.toContain(">Settings<");
  });

  it("shows Settings for a module admin", () => {
    const html = render(true);

    expect(renderedTabs(html)).toEqual([
      "Collection Health",
      "Point Explorer",
      "Settings",
    ]);
    expect(html).toContain("/bas/settings");
  });

  /**
   * The order on screen, left to right. Settings is LAST.
   *
   * Asserted as "last" rather than "third" on purpose: the chat tab is due to be
   * inserted before it, and this test should survive that and fail if the new
   * tab is appended after Settings instead.
   */
  it("puts Settings last, on the right", () => {
    const tabs = renderedTabs(render(true));
    expect(tabs[tabs.length - 1]).toBe("Settings");
    expect(tabs.indexOf("Collection Health")).toBeLessThan(
      tabs.indexOf("Point Explorer"),
    );
    expect(tabs.indexOf("Point Explorer")).toBeLessThan(
      tabs.indexOf("Settings"),
    );
  });

  /**
   * The default is the safe one. A page that forgets to pass `canAdminister`
   * hides the tab rather than showing it - a missing link somebody reports,
   * instead of a leak nobody does.
   */
  it("hides Settings when canAdminister is not passed at all", () => {
    const html = renderToStaticMarkup(
      createElement(Shell, { blurb: "" }, "body"),
    );
    expect(html).not.toContain("/bas/settings");
  });
});
