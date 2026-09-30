// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * The trend chart's y-axis as it is actually RENDERED, at a zoom narrow enough
 * to break it.
 *
 * Zoomed to under a degree, the Point Explorer's axis used to print raw float32
 * values - "72.02734375" - and clip them in the gutter. The formatter alone
 * cannot prove that is fixed: Recharts chooses the ticks, and a formatter that
 * is never called on the zoom path passes a unit test and fails on screen. So
 * the real `TrendChart` is rendered with React into a DOM, and the assertions
 * read the `<text>` elements Recharts drew.
 *
 * jsdom rather than the suite's node environment, because Recharts 3 lays a
 * chart out in effects and renders no axis at all through renderToStaticMarkup
 * (checked: the server render is an empty wrapper). jsdom has no font metrics,
 * so nothing here measures text; the gutter is checked against the same
 * estimate the component sizes it with, and that estimate is what a browser
 * gets too.
 *
 * The readings are real. They are what the office's VAV-1 130-132 zone
 * temperature sensor reported on 17 and 18 September 2026, float32 values as
 * Niagara sent them - 71.91999816894531 is how a station says 71.92. The
 * morning of the 17th spans 0.09 degF over twelve readings, which is the zoom
 * the defect needs. Nothing in this file rounds them: the whole point of the
 * change is that the display got fixed and the data did not.
 */

// TrendChart lives in a client component that imports next/navigation for the
// page around it. The chart itself never touches the router.
vi.mock("next/navigation", () => ({
  usePathname: () => "/bas/points",
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
}));

import { TrendChart } from "@/app/(modules)/bas/point-explorer";
import type { TrendPoint } from "@/lib/modules/bas/types";
import {
  AXIS_CHAR_WIDTH_EM,
  AXIS_LABEL_LANE_PX,
  axisDecimals,
  formatAxisTick,
  formatTooltipValue,
  niceStep,
  niceValueTicks,
  tooltipDecimals,
  unitKind,
  valueAxis,
} from "@/app/(modules)/bas/value-axis";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const at = (iso: string): number => Date.parse(iso);

/** 17 September 2026, 08:45 to 11:30 EDT. Twelve readings, 71.88 to 71.97. */
const QUIET_MORNING: TrendPoint[] = [
  ["2026-09-17T08:45:00.016-04:00", 71.91999816894531],
  ["2026-09-17T09:00:00.003-04:00", 71.94000244140625],
  ["2026-09-17T09:15:00.017-04:00", 71.94000244140625],
  ["2026-09-17T09:30:00.007-04:00", 71.93000030517578],
  ["2026-09-17T09:45:00.013-04:00", 71.97000122070312],
  ["2026-09-17T10:00:00.002-04:00", 71.9000015258789],
  ["2026-09-17T10:15:00.020-04:00", 71.94999694824219],
  ["2026-09-17T10:30:00.019-04:00", 71.97000122070312],
  ["2026-09-17T10:45:00.011-04:00", 71.93000030517578],
  ["2026-09-17T11:00:00.015-04:00", 71.94000244140625],
  ["2026-09-17T11:15:00.009-04:00", 71.9000015258789],
  ["2026-09-17T11:30:00.008-04:00", 71.87999725341797],
].map(([iso, value]) => ({ tsMs: at(iso as string), value: value as number, isBreak: false }));

/** The next morning, same sensor, two degrees warmer. Outside the zoom. */
const NEXT_MORNING: TrendPoint[] = [
  ["2026-09-18T09:15:00.001-04:00", 73.7300033569336],
  ["2026-09-18T09:30:00.008-04:00", 73.7699966430664],
  ["2026-09-18T09:45:00.015-04:00", 73.87000274658203],
  ["2026-09-18T10:00:00.006-04:00", 74.08000183105469],
  ["2026-09-18T10:15:00.004-04:00", 73.8499984741211],
  ["2026-09-18T10:30:00.002-04:00", 73.8499984741211],
].map(([iso, value]) => ({ tsMs: at(iso as string), value: value as number, isBreak: false }));

/**
 * The series as the API would deliver it: both mornings, and the synthetic
 * break `buildTrend` inserts between them. The break is a null the axis must
 * skip - folded in as zero it would drag every axis down to 0.
 */
const BREAK_MS =
  QUIET_MORNING[QUIET_MORNING.length - 1]!.tsMs +
  Math.floor((NEXT_MORNING[0]!.tsMs - QUIET_MORNING[QUIET_MORNING.length - 1]!.tsMs) / 2);
const SERIES: TrendPoint[] = [
  ...QUIET_MORNING,
  { tsMs: BREAK_MS, value: null, isBreak: true },
  ...NEXT_MORNING,
];

const ZOOM = {
  from: QUIET_MORNING[0]!.tsMs,
  to: QUIET_MORNING[QUIET_MORNING.length - 1]!.tsMs,
};

const CHART = { width: 640, height: 320 };
const FONT_SIZE = 11;

// ------------------------------------------------------------------ render

const roots: Array<{ root: Root; host: HTMLDivElement }> = [];

async function renderChart(props: {
  trend?: TrendPoint[];
  unit: string | null;
  zoom: { from: number; to: number } | null;
  tooltipIndex?: number;
}): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push({ root, host });

  await act(async () => {
    root.render(
      createElement(TrendChart, {
        trend: props.trend ?? SERIES,
        gaps: [],
        unit: props.unit,
        zoom: props.zoom,
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

/** The y-axis tick labels, top to bottom as Recharts drew them. */
function yTickTexts(host: HTMLElement): SVGTextElement[] {
  const texts = [
    ...host.querySelectorAll<SVGTextElement>(
      // The tick-labels group rather than the axis group: jsdom's selector
      // engine finds nothing under ".recharts-yAxis" for these SVG nodes,
      // though a browser does. Same elements either way.
      ".recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value",
    ),
  ];
  if (texts.length === 0) throw new Error("no y-axis ticks were rendered");
  return texts;
}

const yLabels = (host: HTMLElement): string[] =>
  yTickTexts(host).map((text) => text.textContent ?? "");

// ----------------------------------------------------------- the defect

describe("zoomed to under a degree on a real office zone temperature", () => {
  it("renders round tenths, never the float32 values", async () => {
    const host = await renderChart({ unit: "fahrenheit", zoom: ZOOM });

    // The window spans 71.88 to 71.97. At one decimal the only honest ticks
    // are the tenths that bracket it.
    expect(yLabels(host)).toEqual(["71.8", "71.9", "72.0"]);
  });

  it("gives every label exactly the unit's decimals", async () => {
    const host = await renderChart({ unit: "fahrenheit", zoom: ZOOM });

    for (const label of yLabels(host)) {
      expect(label).toMatch(/^-?\d+\.\d$/);
    }
  });

  it("repeats no label - the step is never finer than the label can show", async () => {
    const host = await renderChart({ unit: "fahrenheit", zoom: ZOOM });
    const labels = yLabels(host);

    expect(new Set(labels).size).toBe(labels.length);
  });

  it("sizes the gutter to its widest label, so nothing is clipped", async () => {
    const host = await renderChart({ unit: "fahrenheit", zoom: ZOOM });
    const axis = valueAxis(
      QUIET_MORNING.map((point) => point.value as number),
      "fahrenheit",
      { fontSize: FONT_SIZE },
    );

    for (const text of yTickTexts(host)) {
      // Recharts stamps the axis width on every tick label. It must be the
      // width the component asked for, not a constant left over from before.
      expect(text.getAttribute("width")).toBe(String(axis.width));

      // Right-aligned text extends left from x by its own width. The left
      // edge, on the same estimate the gutter was sized with, must clear the
      // chart's left margin and the lane the rotated unit label occupies.
      const x = Number(text.getAttribute("x"));
      const label = text.textContent ?? "";
      const leftEdge = x - label.length * AXIS_CHAR_WIDTH_EM * FONT_SIZE;
      const marginLeft = 4;
      expect(leftEdge).toBeGreaterThanOrEqual(marginLeft + AXIS_LABEL_LANE_PX);
    }
  });

  it("widens the gutter when the labels get longer", async () => {
    // No unit recorded: two decimals, so "71.85" against "71.8".
    const fahrenheit = await renderChart({ unit: "fahrenheit", zoom: ZOOM });
    const unitless = await renderChart({ unit: null, zoom: ZOOM });

    const widthOf = (host: HTMLElement) =>
      Number(yTickTexts(host)[0]!.getAttribute("width"));
    expect(yLabels(unitless).every((label) => /^\d+\.\d{2}$/.test(label))).toBe(true);
    expect(widthOf(unitless)).toBeGreaterThan(widthOf(fahrenheit));
  });

  it("excludes the readings outside the zoom from the axis", async () => {
    const host = await renderChart({ unit: "fahrenheit", zoom: ZOOM });
    const top = Number(yLabels(host)[yLabels(host).length - 1]);

    // The next morning read 74.08. An axis that saw it would reach 74 or more.
    expect(top).toBeLessThan(73);
  });

  it("leaves the data exactly as delivered", async () => {
    const before = SERIES.map((point) => point.value);
    await renderChart({ unit: "fahrenheit", zoom: ZOOM });

    expect(SERIES.map((point) => point.value)).toEqual(before);
    expect(SERIES[0]!.value).toBe(71.91999816894531);
  });
});

describe("at default zoom the same rule applies", () => {
  it("renders whole degrees with one decimal, across both mornings", async () => {
    const host = await renderChart({ unit: "fahrenheit", zoom: null });

    expect(yLabels(host)).toEqual(["71.0", "72.0", "73.0", "74.0", "75.0"]);
  });

  it("skips the break's null rather than dragging the axis to zero", async () => {
    const host = await renderChart({ unit: "fahrenheit", zoom: null });

    expect(Number(yLabels(host)[0])).toBeGreaterThan(60);
  });
});

describe("decimals follow the unit, not a hardcoded fahrenheit", () => {
  it("shows a percentage as whole percent", async () => {
    const trend: TrendPoint[] = QUIET_MORNING.map((point, index) => ({
      ...point,
      value: 33 + index * 0.1300048828125, // float32-ish damper positions, 33.0 to 34.4
    }));
    const host = await renderChart({ trend, unit: "percent", zoom: ZOOM });

    for (const label of yLabels(host)) expect(label).toMatch(/^-?\d+$/);
    expect(yLabels(host)).toEqual(["33", "34", "35"]);
  });

  it("shows a pressure to hundredths", async () => {
    const trend: TrendPoint[] = QUIET_MORNING.map((point, index) => ({
      ...point,
      value: 1.2300000190734863 + index * 0.0019989013671875,
    }));
    const host = await renderChart({ trend, unit: "inches of water", zoom: ZOOM });

    for (const label of yLabels(host)) expect(label).toMatch(/^-?\d+\.\d{2}$/);
  });

  it("shows a temperature in celsius to tenths too", async () => {
    const host = await renderChart({ unit: "celsius", zoom: ZOOM });

    for (const label of yLabels(host)) expect(label).toMatch(/^-?\d+\.\d$/);
  });

  it("falls back to two decimals for a unit it does not know, and for none", () => {
    expect(axisDecimals("furlongs per fortnight")).toBe(2);
    expect(axisDecimals(null)).toBe(2);
    expect(axisDecimals("")).toBe(2);
  });

  it("matches a unit by its whole name, not by a substring", () => {
    expect(unitKind("Fahrenheit ")).toBe("temperature");
    expect(unitKind("percent")).toBe("percentage");
    expect(unitKind("percent of full scale")).toBe("other");
    expect(unitKind("inches of water")).toBe("pressure");
  });
});

describe("the tooltip shows one more decimal than the axis", () => {
  it("for every kind of unit", () => {
    expect(tooltipDecimals("fahrenheit")).toBe(axisDecimals("fahrenheit") + 1);
    // With the unit's symbol, not its stored name (2026-09-29): the stored
    // value is "fahrenheit", and nothing here changes that.
    expect(formatTooltipValue(71.91999816894531, "fahrenheit")).toBe("71.92 °F");
    expect(formatTooltipValue(33.33000183105469, "percent")).toBe("33.3%");
    expect(formatTooltipValue(1.2300000190734863, "inches of water")).toBe("1.230 inWC");
    expect(formatTooltipValue(71.91999816894531, null)).toBe("71.920");
    expect(formatTooltipValue(null, "fahrenheit")).toBe("—");
  });

  it("and that is what the rendered tooltip says", async () => {
    // A pointer cannot land on a jsdom plot, so the chart is asked to open the
    // tooltip on the first sample of the quiet morning: 71.91999816894531.
    const host = await renderChart({
      unit: "fahrenheit",
      zoom: ZOOM,
      tooltipIndex: 0,
    });

    const item = host.querySelector(".recharts-tooltip-item-value");
    if (item === null) throw new Error("the tooltip did not render");
    expect(item.textContent).toBe("71.92 °F");
    expect(host.querySelector(".recharts-tooltip-item-name")?.textContent).toBe(
      "reading",
    );
  });

  it("is the only formatter the Tooltip is wired to", () => {
    // Belt to the braces above: the two-decimal tile formatter must not creep
    // back into the chart.
    const source = readFileSync(
      path.resolve(process.cwd(), "app/(modules)/bas/point-explorer.tsx"),
      "utf8",
    );
    const tooltip = /<Tooltip[\s\S]*?\/>/.exec(source)?.[0];
    expect(tooltip).toBeDefined();
    expect(tooltip).toMatch(/formatTooltipValue\(value, unit\)/);
    expect(tooltip).not.toMatch(/formatValue\(/);
  });
});

describe("the tick chooser", () => {
  it("brackets the quiet morning with tenths", () => {
    expect(niceValueTicks(71.87999725341797, 71.97000122070312, 1)).toEqual([
      71.8, 71.9, 72.0,
    ]);
  });

  it("never goes below the label's precision", () => {
    expect(niceStep(0.0225, 0.1)).toBe(0.1);
    expect(niceStep(0.0225, 0.01)).toBe(0.05);
    expect(niceStep(1.2, 0.1)).toBe(2);
    expect(niceStep(25_000, 1)).toBe(50_000);
  });

  it("gives a flat line two ticks either side of it", () => {
    expect(niceValueTicks(71.9, 71.9, 1)).toEqual([71.8, 71.9, 72.0]);
  });

  it("puts zero on the axis when the data crosses it", () => {
    expect(niceValueTicks(-0.3, 0.4, 1)).toEqual([-0.4, -0.2, 0, 0.2, 0.4]);
  });

  it("produces clean values, not 71.90000000000001", () => {
    for (const tick of niceValueTicks(71.83, 72.41, 1)) {
      expect(tick.toString().length).toBeLessThanOrEqual(5);
    }
  });

  it("never repeats a label and never floods the axis, at any narrow range", () => {
    for (let index = 1; index <= 200; index += 1) {
      const min = 60 + index * 0.0731;
      const max = min + index * 0.00137;
      for (const decimals of [0, 1, 2]) {
        const ticks = niceValueTicks(min, max, decimals);
        const labels = ticks.map((tick) => formatAxisTick(tick, decimals));
        expect(new Set(labels).size).toBe(labels.length);
        expect(ticks.length).toBeGreaterThanOrEqual(2);
        expect(ticks.length).toBeLessThanOrEqual(7);
        expect(ticks[0]).toBeLessThanOrEqual(min);
        expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max);
      }
    }
  });
});
