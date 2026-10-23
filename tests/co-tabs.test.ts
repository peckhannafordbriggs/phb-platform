import { describe, expect, it, vi } from "vitest";

/**
 * The Change Orders tab bar (2026-10-21): the list as pure data, and the bar
 * as it is actually rendered.
 *
 * next/navigation is stubbed because CoShell is a client component and the
 * hook needs a router. Nothing else is mocked - the real CoShell, the real
 * ModuleHeader, the real tab list. `renderToStaticMarkup` runs no effects, so
 * the count fetch never fires and the label renders without a number, which
 * is also the exact state the bar is in before the first poll answers.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/change-orders/review",
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CoShell } from "@/app/(modules)/change-orders/co-shell";
import {
  CO_TABS,
  MAILBOX_TAB_HREF,
  REVIEW_TAB_HREF,
  activeTabHref,
  coTab,
} from "@/app/(modules)/change-orders/tabs";

describe("the tabs are real routes", () => {
  it("registers Mailbox and Needs Review, in that order, and nothing else", () => {
    expect(CO_TABS.map((tab) => tab.href)).toEqual([MAILBOX_TAB_HREF, REVIEW_TAB_HREF]);
    expect(CO_TABS.map((tab) => tab.label)).toEqual(["Mailbox", "Needs Review"]);
  });

  it("opens on the mailbox: the module root is the Mailbox tab", () => {
    expect(coTab("/change-orders").label).toBe("Mailbox");
  });

  it("says in the Needs Review blurb where the notes come from and that nothing is changed", () => {
    const blurb = coTab(REVIEW_TAB_HREF).blurb;
    expect(blurb).toContain("_needs_review");
    expect(blurb).toMatch(/nothing here moves or changes anything/i);
  });

  it("throws on an unregistered href rather than returning a blank tab", () => {
    expect(() => coTab("/change-orders/nope")).toThrow(/No Change Orders tab/);
  });

  it("resolves the active tab by longest prefix, so the review tab does not light up Mailbox", () => {
    expect(activeTabHref("/change-orders")).toBe(MAILBOX_TAB_HREF);
    expect(activeTabHref("/change-orders/review")).toBe(REVIEW_TAB_HREF);
    expect(activeTabHref("/change-orders/review/anything")).toBe(REVIEW_TAB_HREF);
    expect(activeTabHref("/bas")).toBeNull();
  });
});

describe("the rendered tab bar", () => {
  const html = renderToStaticMarkup(createElement(CoShell, { blurb: "" }));

  function renderedTabs(markup: string): string[] {
    const nav = /<nav[^>]*aria-label="Change Orders sections"[\s\S]*?<\/nav>/.exec(markup);
    if (nav === null) throw new Error("no tab bar in the rendered output");
    return [...nav[0].matchAll(/<a[^>]*>([^<]+)<\/a>/g)].map((m) => m[1]!.trim());
  }

  it("renders both tabs as links to their routes", () => {
    expect(renderedTabs(html)).toEqual(["Mailbox", "Needs Review"]);
    expect(html).toContain('href="/change-orders"');
    expect(html).toContain('href="/change-orders/review"');
  });

  it("marks the current tab, and only the current tab, with aria-current", () => {
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page"[^>]*>Needs Review</);
  });
});
