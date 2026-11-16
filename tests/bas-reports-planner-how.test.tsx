// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// The kit Button imports next/link; nothing here navigates.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }) }));

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PlannerHowToggle } from "@/app/(modules)/bas/reports-planner-how";
import { HIDE_HOW_LABEL, SHOW_HOW_LABEL } from "@/lib/modules/bas/reports/engine/planner-display";
import { PLANNER_INTERPRETATION, PLANNER_SQL, plannerAnswer } from "./fixtures/bas-report-planner-answer";

/**
 * The web run view's "Show how this was answered" toggle (2026-11-16),
 * clicked in a DOM: collapsed by default, a click opens the panel and the
 * label reads Hide, a second click closes it.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(createElement(PlannerHowToggle, { answer: plannerAnswer(), timezone: "America/New_York" })));
  return host;
}

describe("Show how this was answered", () => {
  it("opens and closes the panel, flipping its label and aria-expanded", () => {
    const el = mount();
    const button = () => el.querySelector<HTMLButtonElement>('[data-testid="planner-how-toggle"]')!;
    expect(button().tagName).toBe("BUTTON");
    expect(button().textContent).toBe(SHOW_HOW_LABEL);
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(el.querySelector(".planner-how-panel")).toBeNull();

    act(() => button().click());
    expect(button().textContent).toBe(HIDE_HOW_LABEL);
    expect(button().getAttribute("aria-expanded")).toBe("true");
    const panel = el.querySelector(".planner-how-panel")!;
    expect(panel.textContent).toContain(PLANNER_INTERPRETATION);
    expect(panel.querySelector("pre.sql")!.textContent).toBe(PLANNER_SQL);
    expect(panel.textContent).toContain("2 model calls · $0.2313");

    act(() => button().click());
    expect(button().textContent).toBe(SHOW_HOW_LABEL);
    expect(el.querySelector(".planner-how-panel")).toBeNull();
  });
});
