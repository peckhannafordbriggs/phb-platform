// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * The x-axis of the BAS time charts (2026-11-23): a date never prints twice.
 *
 * Recharts placed the ticks itself and the formatter printed every one as a
 * bare date, so on a 7-day range two ticks on one day read "Nov 17 Nov 17".
 * `timeAxisTicks` now chooses the ticks on the building's clock: a date once
 * per day, on its midnight (or on the first tick of a partial first day,
 * with its time), times between where the width allows, month starts over a
 * year. Tested as rules over the planner at every width that matters and
 * across both DST changes, and then as RENDERED: the real TrendChart in a
 * DOM, reading the <text> elements Recharts drew.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/bas/points",
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
}));

import { TrendChart } from "@/app/(modules)/bas/point-explorer";
import { TICK_SPACING_PX, maxTicksFor, timeAxisTicks, type AxisTick } from "@/lib/modules/bas/time-axis";
import { localParts } from "@/lib/modules/bas/reports/schedule";
import type { TrendPoint } from "@/lib/modules/bas/types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NY = "America/New_York";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTHS = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g;
const hasMonth = (label: string) => /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/.test(label);
const WIDTHS = [320, 480, 640, 900, 1100, 1600];
/** Mid-afternoon on a Monday, so every range starts part-way through a day. */
const TO = Date.parse("2026-11-23T20:37:00Z");

const ticksFor = (fromMs: number, toMs: number, width: number, timeZone = NY) =>
  timeAxisTicks(fromMs, toMs, { maxTicks: maxTicksFor(width), timeZone, locale: "en-US" });

const dayOf = (ms: number, zone = NY) => {
  const p = localParts(new Date(ms), zone);
  return `${p.year}-${p.month}-${p.day}`;
};

/** The rules every axis keeps, whatever its span and width. */
function expectHonestAxis(ticks: AxisTick[] | null, fromMs: number, toMs: number, width: number, zone = NY) {
  expect(ticks, "a plan").not.toBeNull();
  const t = ticks!;
  // Inside the range, in order, and no more than fit.
  expect(t.length).toBeGreaterThanOrEqual(2);
  expect(t.length).toBeLessThanOrEqual(maxTicksFor(width));
  for (let i = 0; i < t.length; i += 1) {
    expect(t[i]!.ms).toBeGreaterThanOrEqual(fromMs);
    expect(t[i]!.ms).toBeLessThanOrEqual(toMs);
    if (i > 0) expect(t[i]!.ms).toBeGreaterThan(t[i - 1]!.ms);
  }
  // One label per tick, and no label says a date twice.
  for (const tick of t) {
    expect(tick.label.length).toBeGreaterThan(0);
    expect(tick.label.match(MONTHS)?.length ?? 0, tick.label).toBeLessThanOrEqual(1);
  }
  // No date is printed on two ticks: the regression, "Nov 17 Nov 17".
  const dated = t.filter((x) => x.kind === "date" || x.kind === "date-time" || x.kind === "month").map((x) => x.label.replace(/ \d\d:\d\d$/, ""));
  expect(new Set(dated).size, dated.join(" · ")).toBe(dated.length);
  // And on a sub-day axis, every day that has a tick has its date exactly once.
  if (t.some((x) => x.kind === "time")) {
    const perDay = new Map<string, number>();
    for (const x of t) perDay.set(dayOf(x.ms, zone), (perDay.get(dayOf(x.ms, zone)) ?? 0) + (x.kind === "time" ? 0 : 1));
    for (const [day, dates] of perDay) expect(dates, day).toBe(1);
  }
}

describe("the tick planner", () => {
  it("on the 7-day range: a date once per day at every width, with times between where there is room", () => {
    const from = TO - 7 * DAY;
    for (const width of WIDTHS) expectHonestAxis(ticksFor(from, TO, width), from, TO, width);

    const wide = ticksFor(from, TO, 1100)!;
    // The range opens at 15:37 on the 16th, after that day's noon tick, so
    // the first tick is the 17th's midnight.
    expect(wide.map((x) => x.label).join(" · ")).toBe(
      "Nov 17 · 12:00 · Nov 18 · 12:00 · Nov 19 · 12:00 · Nov 20 · 12:00 · Nov 21 · 12:00 · Nov 22 · 12:00 · Nov 23 · 12:00",
    );
    // Narrow: no room for times, so dates alone - each once.
    const narrow = ticksFor(from, TO, 420)!;
    expect(narrow.every((x) => x.kind === "date")).toBe(true);
    expect(narrow.map((x) => x.label)).toEqual(["Nov 17", "Nov 19", "Nov 21", "Nov 23"]);
    expect(wide.map((x) => x.label).join(" ")).not.toContain("Nov 17 Nov 17");
  });

  it("on the 30-day range: dates only, each once, every second day at full width", () => {
    const from = TO - 30 * DAY;
    for (const width of WIDTHS) expectHonestAxis(ticksFor(from, TO, width), from, TO, width);
    const wide = ticksFor(from, TO, 1100)!;
    expect(wide.every((x) => x.kind === "date")).toBe(true);
    expect(wide.map((x) => x.label).slice(0, 4)).toEqual(["Oct 26", "Oct 28", "Oct 30", "Nov 1"]);
    expect(new Set(wide.map((x) => x.label)).size).toBe(wide.length);
  });

  it("on the 24-hour range: the date of each day once - the partial first day on its first tick - and times between", () => {
    const from = TO - DAY;
    for (const width of WIDTHS) expectHonestAxis(ticksFor(from, TO, width), from, TO, width);
    const t = ticksFor(from, TO, 1100)!;
    expect(t[0]).toMatchObject({ kind: "date-time", label: "Nov 22 16:00" });
    expect(t.filter((x) => x.kind === "date").map((x) => x.label)).toEqual(["Nov 23"]);
    expect(t.filter((x) => x.kind === "time").length).toBeGreaterThan(5);
  });

  it("across both DST changes in New York, hour by hour: no instant twice, each date once, no hour twice in a day", () => {
    for (const [from, to] of [
      [Date.parse("2026-03-07T17:00:00Z"), Date.parse("2026-03-09T05:00:00Z")], // 8 March: 02:00 does not exist
      [Date.parse("2026-10-31T16:00:00Z"), Date.parse("2026-11-02T05:00:00Z")], // 1 November: 01:00 happens twice
    ] as const) {
      const t = timeAxisTicks(from, to, { maxTicks: 48, timeZone: NY, locale: "en-US" })!;
      expectHonestAxis(t, from, to, 48 * TICK_SPACING_PX);
      expect(new Set(t.map((x) => x.ms)).size).toBe(t.length);
      const byDay = new Map<string, string[]>();
      for (const x of t) byDay.set(dayOf(x.ms), [...(byDay.get(dayOf(x.ms)) ?? []), x.label]);
      for (const labels of byDay.values()) expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it("in a half-hour zone the dates still fall on local midnight", () => {
    const from = TO - 7 * DAY;
    const t = timeAxisTicks(from, TO, { maxTicks: maxTicksFor(1100), timeZone: "Asia/Kolkata", locale: "en-US" })!;
    expectHonestAxis(t, from, TO, 1100, "Asia/Kolkata");
    for (const x of t.filter((y) => y.kind === "date")) {
      expect(localParts(new Date(x.ms), "Asia/Kolkata")).toMatchObject({ hour: 0, minute: 0 });
    }
  });

  it("over a year and more: month starts, each month once", () => {
    for (const span of [400 * DAY, 730 * DAY, 3 * 365 * DAY]) {
      const from = TO - span;
      for (const width of WIDTHS) expectHonestAxis(ticksFor(from, TO, width), from, TO, width);
      expect(ticksFor(from, TO, 1100)!.every((x) => x.kind === "month" && /^[A-Z][a-z]{2} \d{4}$/.test(x.label))).toBe(true);
    }
  });

  it("weekly steps land on Mondays, and a span of a minute leaves the ticks to Recharts", () => {
    for (const span of [100 * DAY, 160 * DAY]) {
      const from = TO - span;
      const t = ticksFor(from, TO, 1100)!;
      expect(t.every((x) => x.kind === "date"), t.map((x) => x.label).join(" · ")).toBe(true);
      expect(t.map((x) => localParts(new Date(x.ms), NY).weekday)).toEqual(t.map(() => 1));
    }
    expect(timeAxisTicks(TO - 30_000, TO, { maxTicks: 10, timeZone: NY })).toBeNull();
    expect(timeAxisTicks(TO, TO, { maxTicks: 10, timeZone: NY })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// As rendered
// ---------------------------------------------------------------------------

const roots: Array<{ root: Root; host: HTMLDivElement }> = [];

afterEach(async () => {
  for (const { root, host } of roots.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
});

/** Hourly readings over the range, a gentle wave. */
function hourly(fromMs: number, toMs: number): TrendPoint[] {
  const out: TrendPoint[] = [];
  for (let ms = Math.ceil(fromMs / HOUR) * HOUR; ms <= toMs; ms += HOUR) {
    out.push({ tsMs: ms, value: 70 + Math.sin(ms / (6 * HOUR)), isBreak: false });
  }
  return out;
}

async function renderRange(fromMs: number, toMs: number, width: number): Promise<string[]> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push({ root, host });
  await act(async () => {
    root.render(
      createElement(TrendChart, {
        trend: hourly(fromMs, toMs),
        gaps: [],
        unit: "fahrenheit",
        zoom: null,
        range: { fromMs, toMs },
        timeZone: NY,
        selection: null,
        onDragStart: () => {},
        onDragMove: () => {},
        onDragEnd: () => {},
        width,
        height: 320,
      }),
    );
  });
  const texts = [...host.querySelectorAll<SVGTextElement>(".recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value")];
  if (texts.length === 0) throw new Error("no x-axis ticks were rendered");
  return texts.map((t) => t.textContent ?? "");
}

describe("the Point Explorer chart, rendered", () => {
  it("on 7 days draws each date once, with times between, at the planner's ticks - and never 'Nov 17 Nov 17'", async () => {
    const from = TO - 7 * DAY;
    const labels = await renderRange(from, TO, 1100);
    const dates = labels.filter(hasMonth);
    expect(dates.length).toBeGreaterThanOrEqual(7);
    expect(new Set(dates).size).toBe(dates.length);
    expect(labels).toContain("12:00");
    expect(labels.join(" ")).not.toContain("Nov 17 Nov 17");
    for (const l of labels) expect(l.match(MONTHS)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it("on 30 days draws dates only, each once; at a narrow width fewer, still each once", async () => {
    const from = TO - 30 * DAY;
    for (const width of [1100, 480]) {
      const labels = await renderRange(from, TO, width);
      expect(labels.every((l) => /^[A-Z][a-z]{2} \d{1,2}$/.test(l)), labels.join(" · ")).toBe(true);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });
});
