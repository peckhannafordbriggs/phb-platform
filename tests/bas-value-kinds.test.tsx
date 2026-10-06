// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * A boolean point is a STATE, not a quantity, and the chart has to draw it as
 * one: a stepped line between two labelled states, no decimal axis, a word in
 * the tooltip. This file renders the real `TrendChart` with a boolean payload
 * and reads the axis, the line and the tooltip back off the DOM, the way
 * tests/bas-chart-axis.test.tsx does for the numeric axis.
 *
 * The one assertion the whole change hangs on is the first: at no zoom level,
 * raw or bucketed, does a boolean point's y-axis carry a digit. Before this
 * change a boolean point rendered as null samples under an axis that read
 * -0.01 / 0.00 / 0.01 (observed on 2026-10-06 by calling valueAxis([], null)),
 * and "Distinct values 0 · Reads as a stuck sensor" beside it.
 *
 * The readings are the shape of the office's `Occupied` point - 421 rows,
 * mostly true, on live - compressed to a morning.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/bas/points",
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
}));

import { TrendChart } from "@/app/(modules)/bas/point-explorer";
import {
  describeDistinctValues,
  distinctValuesTone,
} from "@/app/(modules)/bas/health-client";
import {
  formatStateBand,
  formatStateTick,
  formatStateTooltip,
  stateAxis,
  STATE_AXIS_PADDING,
} from "@/app/(modules)/bas/value-axis";
import {
  booleanStates,
  stateWord,
  valueKindFromDataType,
  valueKindOf,
  type BooleanStates,
} from "@/lib/modules/bas/value-kind";
import type { TrendPoint } from "@/lib/modules/bas/types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const at = (iso: string): number => Date.parse(iso);

const OCCUPANCY: BooleanStates = { on: "Occupied", off: "Unoccupied" };
const ON_OFF: BooleanStates = { on: "On", off: "Off" };

/** Unoccupied overnight, occupied from 07:00, a lunchtime drop, occupied again. */
const MORNING: TrendPoint[] = [
  ["2026-09-17T05:00:00-04:00", 0],
  ["2026-09-17T06:00:00-04:00", 0],
  ["2026-09-17T07:00:00-04:00", 1],
  ["2026-09-17T08:00:00-04:00", 1],
  ["2026-09-17T09:00:00-04:00", 1],
  ["2026-09-17T12:10:00-04:00", 0],
  ["2026-09-17T12:50:00-04:00", 1],
  ["2026-09-17T14:00:00-04:00", 1],
].map(([iso, value]) => ({ tsMs: at(iso as string), value: value as number, isBreak: false }));

/** The occupied stretch only: an axis fitted to the data would show one state. */
const ZOOM_ALL_ON = {
  from: at("2026-09-17T07:30:00-04:00"),
  to: at("2026-09-17T09:30:00-04:00"),
};

/** Hour buckets of the same morning: one bucket mixed, the rest a single state. */
const BUCKETED: TrendPoint[] = [
  { tsMs: at("2026-09-17T05:00:00-04:00"), value: 0, isBreak: false, min: 0, max: 0, readings: 2 },
  { tsMs: at("2026-09-17T07:00:00-04:00"), value: 1, isBreak: false, min: 1, max: 1, readings: 3 },
  { tsMs: at("2026-09-17T12:00:00-04:00"), value: 0.72, isBreak: false, min: 0, max: 1, readings: 25 },
  { tsMs: at("2026-09-17T14:00:00-04:00"), value: 1, isBreak: false, min: 1, max: 1, readings: 1 },
];

/** A numeric series for the contrast cases: a duct static pressure in inches of water. */
const PRESSURE: TrendPoint[] = MORNING.map((point, index) => ({
  ...point,
  value: 1.2300000190734863 + index * 0.0019989013671875,
}));

const CHART = { width: 640, height: 320 };

// ------------------------------------------------------------------ render

const roots: Array<{ root: Root; host: HTMLDivElement }> = [];

async function renderChart(props: {
  trend: TrendPoint[];
  states: BooleanStates | null;
  unit?: string | null;
  zoom?: { from: number; to: number } | null;
  sampled?: boolean;
  tooltipIndex?: number;
}): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push({ root, host });

  await act(async () => {
    root.render(
      createElement(TrendChart, {
        trend: props.trend,
        gaps: [],
        unit: props.unit ?? null,
        states: props.states,
        zoom: props.zoom ?? null,
        sampled: props.sampled ?? false,
        selection: null,
        onDragStart: () => {},
        onDragMove: () => {},
        onDragEnd: () => {},
        tooltipIndex: props.tooltipIndex,
        ...CHART,
      }),
    );
  });

  return host;
}

afterEach(async () => {
  for (const { root, host } of roots.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
});

function yLabels(host: HTMLElement): string[] {
  const texts = [
    ...host.querySelectorAll<SVGTextElement>(
      ".recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value",
    ),
  ];
  if (texts.length === 0) throw new Error("no y-axis ticks were rendered");
  return texts.map((text) => text.textContent ?? "");
}

/** The `d` of the line itself (not the fill under it). */
function linePath(host: HTMLElement): string {
  const curve = host.querySelector<SVGPathElement>(".recharts-area-curve");
  if (curve === null) throw new Error("no line was rendered");
  return curve.getAttribute("d") ?? "";
}

function tooltipItems(host: HTMLElement): Array<{ name: string; value: string }> {
  const items = [...host.querySelectorAll(".recharts-tooltip-item")];
  if (items.length === 0) throw new Error("the tooltip did not render");
  return items.map((item) => ({
    name: item.querySelector(".recharts-tooltip-item-name")?.textContent ?? "",
    value: item.querySelector(".recharts-tooltip-item-value")?.textContent ?? "",
  }));
}

const allTexts = (host: HTMLElement): string[] =>
  [...host.querySelectorAll("text")].map((text) => text.textContent ?? "");

// --------------------------------------------- the axis is two words, never digits

describe("a boolean point never renders with a numeric decimal axis", () => {
  const payloads: Array<[string, Parameters<typeof renderChart>[0]]> = [
    ["raw, whole morning", { trend: MORNING, states: OCCUPANCY }],
    ["zoomed to a stretch that is all one state", { trend: MORNING, states: OCCUPANCY, zoom: ZOOM_ALL_ON }],
    ["bucketed, with a mixed bucket at 0.72", { trend: BUCKETED, states: OCCUPANCY, sampled: true }],
    ["a single sample", { trend: MORNING.slice(0, 1), states: ON_OFF }],
    ["a mostly-null series with one state", {
      trend: MORNING.map((point, index) => ({ ...point, value: index === 3 ? 1 : null })),
      states: ON_OFF,
    }],
  ];

  for (const [label, props] of payloads) {
    it(`${label}: the y-axis is exactly the two state words`, async () => {
      const host = await renderChart(props);
      const labels = yLabels(host);

      expect(labels).toEqual([props.states!.off, props.states!.on]);
      for (const text of labels) expect(text).not.toMatch(/\d/);
    });
  }

  it("draws a gridline per state and no 0.2 / 0.4 / 0.6 lines between them", async () => {
    const host = await renderChart({ trend: MORNING, states: OCCUPANCY });
    const tickYs = [
      ...host.querySelectorAll<SVGTextElement>(
        ".recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value",
      ),
    ].map((text) => Number(text.getAttribute("y")));
    const lineYs = [
      ...host.querySelectorAll<SVGLineElement>(".recharts-cartesian-grid-horizontal line"),
    ].map((line) => Number(line.getAttribute("y1")));

    // Recharts draws a line at every tick AND at the plot's two edges (the
    // numeric chart's edge lines coincide with its outer ticks). Between the
    // two state lines there must be nothing: no line for a value that is not
    // a state.
    expect(tickYs).toHaveLength(2);
    const [onY, offY] = [Math.min(...tickYs), Math.max(...tickYs)];
    const between = lineYs.filter((y) => y > onY + 0.5 && y < offY - 0.5);
    expect(between).toEqual([]);
    for (const y of tickYs) expect(lineYs.some((lineY) => Math.abs(lineY - y) < 0.5)).toBe(true);
  });

  it("draws no y-axis at all for a series with no values - as the numeric chart does", async () => {
    // Recharts renders no ticks for an axis whose data holds no value, for any
    // kind. There is nothing to put a decimal on either way; this pins that
    // the boolean path does not change it.
    const nulls = MORNING.map((point) => ({ ...point, value: null }));
    const boolean = await renderChart({ trend: nulls, states: ON_OFF });
    const numeric = await renderChart({ trend: nulls, states: null, unit: "fahrenheit" });
    const ticks = (host: HTMLElement) =>
      host.querySelectorAll(".recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value");

    expect(ticks(boolean)).toHaveLength(0);
    expect(ticks(numeric)).toHaveLength(0);
    for (const text of allTexts(boolean)) expect(text).not.toMatch(/^-?\d+\.\d+$/);
  });

  it("carries no rotated unit label - the states are the axis", async () => {
    const boolean = await renderChart({ trend: MORNING, states: OCCUPANCY });
    const numeric = await renderChart({ trend: PRESSURE, states: null, unit: "inches of water" });

    expect(allTexts(boolean)).not.toContain("no unit recorded");
    expect(allTexts(numeric)).toContain("inWC");
  });

  it("is decided by stateAxis: ticks at 0 and 1, a padded domain, words for labels", () => {
    const axis = stateAxis(OCCUPANCY);

    expect(axis.ticks).toEqual([0, 1]);
    expect(axis.labels).toEqual(["Unoccupied", "Occupied"]);
    expect(axis.domain).toEqual([-STATE_AXIS_PADDING, 1 + STATE_AXIS_PADDING]);
    expect(formatStateTick(0, OCCUPANCY)).toBe("Unoccupied");
    expect(formatStateTick(1, OCCUPANCY)).toBe("Occupied");
    // A value that is not a state has no label, rather than a made-up one.
    expect(formatStateTick(0.5, OCCUPANCY)).toBe("");
  });

  it("sizes the gutter to the longer state word", () => {
    expect(stateAxis(OCCUPANCY).width).toBeGreaterThan(stateAxis(ON_OFF).width);
  });
});

// ------------------------------------------------------------- the stepped line

describe("the line holds flat and jumps - it never slopes between states", () => {
  it("is drawn with straight segments only for a boolean point", async () => {
    const host = await renderChart({ trend: MORNING, states: OCCUPANCY });
    const d = linePath(host);

    // A monotone curve is cubic Béziers ("C"); a step is moves and lines.
    expect(d.length).toBeGreaterThan(20);
    expect(d).not.toMatch(/[CcSsQq]/);
  });

  it("keeps the curve for a numeric point", async () => {
    const host = await renderChart({ trend: PRESSURE, states: null, unit: "inches of water" });

    expect(linePath(host)).toMatch(/C/);
  });

  it("steps the band as well when a boolean trend is bucketed", async () => {
    const host = await renderChart({ trend: BUCKETED, states: OCCUPANCY, sampled: true });
    // The band has no stroke, so it has no curve path - its FILL is the shape
    // that would slope. Both areas' fills, then: the band's and the line's.
    const fills = [...host.querySelectorAll<SVGPathElement>(".recharts-area-area")];

    expect(fills).toHaveLength(2);
    for (const fill of fills) {
      expect((fill.getAttribute("d") ?? "").length).toBeGreaterThan(20);
      expect(fill.getAttribute("d") ?? "").not.toMatch(/[CcSsQq]/);
    }
  });

  it("chooses the type in one place, for both areas", () => {
    const source = readFileSync(
      path.join(process.cwd(), "app/(modules)/bas/point-explorer.tsx"),
      "utf8",
    );

    expect(source.match(/type=\{lineType\}/g)).toHaveLength(2);
    expect(source).not.toMatch(/type="monotone"/);
    expect(source).toMatch(/states !== null \? "stepAfter" : "monotone"/);
  });
});

// ------------------------------------------------------------------ the tooltip

describe("the tooltip says the state word, not a number", () => {
  it("names a raw sample's state", async () => {
    // Sample 2 is 07:00, the first Occupied reading.
    const host = await renderChart({ trend: MORNING, states: OCCUPANCY, tooltipIndex: 2 });

    expect(tooltipItems(host)).toEqual([{ name: "state", value: "Occupied" }]);
  });

  it("names the other state too, and never '0' or '1'", async () => {
    const host = await renderChart({ trend: MORNING, states: OCCUPANCY, tooltipIndex: 0 });
    const [item] = tooltipItems(host);

    expect(item!.value).toBe("Unoccupied");
    expect(item!.value).not.toMatch(/\d/);
  });

  it("says what a mixed bucket is: the states seen, and the share that was on", async () => {
    const host = await renderChart({
      trend: BUCKETED,
      states: OCCUPANCY,
      sampled: true,
      tooltipIndex: 2,
    });
    const items = tooltipItems(host);

    expect(items).toContainEqual({ name: "states seen", value: "Unoccupied – Occupied" });
    expect(items).toContainEqual({ name: "share of readings", value: "Occupied 72% of readings" });
  });

  it("collapses a single-state bucket to its one word", async () => {
    const host = await renderChart({
      trend: BUCKETED,
      states: OCCUPANCY,
      sampled: true,
      tooltipIndex: 1,
    });
    const items = tooltipItems(host);

    expect(items).toContainEqual({ name: "states seen", value: "Occupied" });
    expect(items).toContainEqual({ name: "share of readings", value: "Occupied" });
  });

  it("reads a pressure point with its unit, as before", async () => {
    const host = await renderChart({
      trend: PRESSURE,
      states: null,
      unit: "inches of water",
      tooltipIndex: 0,
    });

    expect(tooltipItems(host)).toEqual([{ name: "reading", value: "1.230 inWC" }]);
  });

  it("is written by the state formatters", () => {
    expect(formatStateTooltip(1, ON_OFF)).toBe("On");
    expect(formatStateTooltip(0, ON_OFF)).toBe("Off");
    expect(formatStateTooltip(0.5, ON_OFF)).toBe("On 50% of readings");
    expect(formatStateTooltip(null, ON_OFF)).toBe("—");
    expect(formatStateBand(0, 1, ON_OFF)).toBe("Off – On");
    expect(formatStateBand(1, 1, ON_OFF)).toBe("On");
    expect(formatStateBand(0.2, 1, ON_OFF)).toBe("—");
  });
});

// ------------------------------------------------------ deciding what a point is

describe("which kind a point is", () => {
  it("comes from the collector's declared type", () => {
    expect(valueKindFromDataType("bool")).toBe("boolean");
    expect(valueKindFromDataType("real")).toBe("numeric");
    expect(valueKindFromDataType("int")).toBe("numeric");
    expect(valueKindFromDataType("str")).toBe("string");
    expect(valueKindFromDataType("enum")).toBe("string");
    expect(valueKindFromDataType("unknown")).toBe("numeric");
  });

  it("falls back to the populated column only when the type is undeclared", () => {
    const none = { num: 0, bool: 0, str: 0 };
    expect(valueKindOf("unknown", { num: 0, bool: 12, str: 0 })).toBe("boolean");
    expect(valueKindOf("unknown", { num: 0, bool: 0, str: 12 })).toBe("string");
    expect(valueKindOf("unknown", { num: 12, bool: 0, str: 0 })).toBe("numeric");
    expect(valueKindOf("unknown", none)).toBe("numeric");
    // Declared wins. A real point with a stray boolean row is a collector
    // defect to find, not a chart to redraw.
    expect(valueKindOf("real", { num: 0, bool: 12, str: 0 })).toBe("numeric");
    expect(valueKindOf("bool", { num: 12, bool: 0, str: 0 })).toBe("boolean");
  });
});

describe("what a boolean point's states are called", () => {
  const plain = { role: null, isStatus: false, isCommand: false };

  it("occupancy, by role or by name", () => {
    expect(booleanStates({ role: "occupancy_status", isStatus: true, isCommand: false, names: ["Occupied"] }))
      .toEqual(OCCUPANCY);
    expect(booleanStates({ role: "occupancy_cmd", isStatus: false, isCommand: true, names: ["OccupancyCommand"] }))
      .toEqual(OCCUPANCY);
    expect(booleanStates({ ...plain, names: ["Zone Occupied", "Occ$20Sensor"] })).toEqual(OCCUPANCY);
  });

  it("an alarm, by role or by name", () => {
    expect(booleanStates({ role: "alarm_status", isStatus: true, isCommand: false, names: ["X"] }))
      .toEqual({ on: "Alarm", off: "Normal" });
    expect(booleanStates({ ...plain, names: ["Global_Alarm"] })).toEqual({ on: "Alarm", off: "Normal" });
  });

  it("'enable' in the name: the office's System_Enable has no role", () => {
    expect(booleanStates({ ...plain, names: ["System_Enable"] })).toEqual({ on: "Enabled", off: "Disabled" });
  });

  it("any other status or command role is On / Off", () => {
    expect(booleanStates({ role: "supply_fan_status", isStatus: true, isCommand: false, names: ["AHU$2d1_FanStatus"] }))
      .toEqual(ON_OFF);
    expect(booleanStates({ role: "pump_cmd", isStatus: false, isCommand: true, names: ["P1"] })).toEqual(ON_OFF);
  });

  it("and with nothing to go on, True / False - the pair that cannot be wrong", () => {
    expect(booleanStates({ ...plain, names: ["Point7", null] })).toEqual({ on: "True", off: "False" });
  });

  it("turns 1 and 0 back into the words, and nothing else into anything", () => {
    expect(stateWord(1, OCCUPANCY)).toBe("Occupied");
    expect(stateWord(0, OCCUPANCY)).toBe("Unoccupied");
    expect(stateWord(0.5, OCCUPANCY)).toBeNull();
    expect(stateWord(null, OCCUPANCY)).toBeNull();
  });
});

// ------------------------------------------------------------------- the tiles

describe("the distinct-values tile does not call a healthy boolean a stuck sensor", () => {
  it("is neutral for a boolean or string point, whatever the count", () => {
    expect(distinctValuesTone(2, 421, "boolean")).toBe("neutral");
    expect(distinctValuesTone(1, 319, "boolean")).toBe("neutral");
    expect(distinctValuesTone(0, 5236, "string")).toBe("neutral");
    // Numeric is judged exactly as before.
    expect(distinctValuesTone(2, 421, "numeric")).toBe("bad");
    expect(distinctValuesTone(2, 421)).toBe("bad");
  });

  it("gives the denominator and no diagnosis", () => {
    expect(describeDistinctValues(2, 421, "boolean")).toBe("Across 421 readings.");
    expect(describeDistinctValues(2, 421, "boolean")).not.toContain("stuck");
    expect(describeDistinctValues(2, 421, "numeric")).toContain("stuck");
  });
});
