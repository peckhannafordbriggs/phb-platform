// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  usePathname: () => "/bas/points",
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
}));

import { LinesTooltip, TrendChart, TrendPanel, type ChartLine } from "@/app/(modules)/bas/point-explorer";
import {
  BreaksList,
  DataHealthTile,
  LinesLegend,
  TrendSummaryCard,
  dataHealthTone,
} from "@/app/(modules)/bas/point-explorer-parts";
import { DashboardCards } from "@/app/(modules)/bas/dashboard";
import { HistoryUnknownLine } from "@/app/(modules)/bas/collection-health";
import { TrendSummariesLine } from "@/app/(modules)/bas/reports-usage";
import { AssumedCapacityControl } from "@/app/(modules)/bas/settings-view";
import { expectedInterval, summariseBreaks } from "@/lib/modules/bas/interval";
import type {
  BasDashboard,
  PointExplorer,
  PointOption,
  RollRisk,
  SettingsStation,
  TrendPoint,
} from "@/lib/modules/bas/types";
import type { TrendSummaryResult } from "@/lib/modules/bas/trend-summary/types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The point page as drawn (2026-11-20): the Data health tile, the breaks
 * summary, the trend summary card, several lines on one chart, and the
 * at-risk split on the Projects card and Collection Health.
 */

const roots: Array<{ root: Root; host: HTMLElement }> = [];
afterEach(async () => {
  for (const { root, host } of roots.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
});

async function mount(element: React.ReactElement): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push({ root, host });
  await act(async () => root.render(element));
  return host;
}

const HOUR = 3_600_000;
const FROM = Date.parse("2026-11-13T05:00:00Z");
const TO = FROM + 7 * 24 * HOUR;
const NONE = { gaps: 0, medianS: null, withinTolerance: 0 };

const point = (over: Partial<PointOption> = {}): PointOption => ({
  pointId: "1",
  pointName: "V4_22/SpaceTemp",
  pointRole: "zone_temp",
  unit: "fahrenheit",
  siteName: "CEI",
  valueKind: "numeric",
  states: null,
  stationId: "9",
  stationName: "CEI_JCI_N2",
  equipmentId: "3",
  equipmentName: "V4_22",
  equipmentType: "VAV Box",
  ...over,
});

const series = (n: number, start = FROM, stepMs = 30 * 60_000, value = (i: number) => 70 + (i % 5)): TrendPoint[] =>
  Array.from({ length: n }, (_, i) => ({ tsMs: start + i * stepMs, value: value(i), isBreak: false }));

function payload(over: Partial<PointExplorer> = {}): PointExplorer {
  const breaks = summariseBreaks({
    breaks: Array.from({ length: 12 }, (_, i) => ({ fromMs: FROM + i * 12 * HOUR, toMs: FROM + i * 12 * HOUR + (i === 3 ? 3.2 : 0.4 + i * 0.05) * HOUR })),
    rangeFromMs: FROM,
    rangeToMs: TO,
    earliestMs: FROM - 30 * 24 * HOUR,
  });
  return {
    windowDays: 7,
    range: { kind: "preset", days: 7, from: new Date(FROM).toISOString(), to: new Date(TO).toISOString(), fromDate: null, toDate: null, timezone: "America/New_York" },
    calendar: null,
    observedAt: new Date(TO).toISOString(),
    sites: [],
    projects: [],
    stations: [],
    selectedProjectId: null,
    selectedProjectName: null,
    selectedStationId: null,
    selectedStationName: null,
    scope: { filtered: false, label: null },
    selectedSiteId: null,
    selectedSiteName: null,
    points: [point(), point({ pointId: "2", pointName: "V4_22/DamperPos", unit: "percent" }), point({ pointId: "3", pointName: "AHU_7/DA_T", equipmentId: "4", equipmentName: "AHU_7" }), point({ pointId: "4", pointName: "Other/OAT", stationId: "10", equipmentId: null, equipmentName: null })],
    selectedPoint: point(),
    collectionIntervalS: null,
    stationClockOffsetS: null,
    stationClockMeasuredAt: null,
    stats: { readings: 330, nullRecords: 0, distinctValues: 41, latest: 71, latestAt: new Date(TO).toISOString(), average: 71.2, minimum: 68, maximum: 74 },
    pointExtent: { earliestAt: new Date(FROM - 30 * 24 * HOUR).toISOString(), latestAt: new Date(TO).toISOString() },
    trend: series(330),
    trendGaps: breaks.breaks,
    sampling: { kind: "raw", readings: 330 },
    dataGaps: [],
    expectedInterval: expectedInterval({ enteredS: null, range: { gaps: 329, medianS: 1800, withinTolerance: 320 }, storedMeasuredS: null }),
    breaks,
    history: {
      risk: "ok",
      horizon: { state: "estimated", hours: 250, currentHours: null, stationCount: null, capacity: 500, capacitySource: "assumed", intervalS: 1800, intervalSource: "measured" },
    },
    outOfRange: null,
    comparisons: [],
    comparisonNotes: [],
    ...over,
  };
}

describe("the Data health tile", () => {
  it("says how often the point reports and where that came from, what is missing, and the history with assumed and measured beside it", () => {
    const html = renderToStaticMarkup(createElement(DataHealthTile, { data: payload() }));
    expect(html).toContain("Data health");
    expect(html).toMatch(/>[\d.]+% missing</);
    expect(html).toContain("Reports about every 30 min (measured)");
    expect(html).toContain("Station keeps about 10.4 days of history (assumed 500 records × measured 30 min)");
    expect(html).toContain('data-tone="neutral"');
    expect(html).not.toContain("bas-stuck-warning");
    expect(html).not.toContain("bas-out-of-range");
  });

  it("warns in the stuck-sensor colour when the value is stuck, by the existing distinct-values rule", () => {
    const stuck = payload({ stats: { ...payload().stats, distinctValues: 1 } });
    const html = renderToStaticMarkup(createElement(DataHealthTile, { data: stuck }));
    expect(html).toContain('data-tone="bad"');
    expect(html).toContain("bas-stuck-warning");
    expect(html).toContain("Reads as a stuck sensor, not a stable room.");
    expect(dataHealthTone({ distinctValues: 1, readings: 330, valueKind: "numeric", outOfRange: null })).toBe("bad");
    // A boolean point's two values are not a stuck sensor.
    expect(dataHealthTone({ distinctValues: 2, readings: 330, valueKind: "boolean", outOfRange: null })).toBe("neutral");
  });

  it("warns, red, when a reading is out of physical range", () => {
    const html = renderToStaticMarkup(
      createElement(DataHealthTile, {
        data: payload({ outOfRange: { label: "a room or return air temperature", min: 35, max: 110, lowest: -40, highest: 74 } }),
      }),
    );
    expect(html).toContain('data-tone="bad"');
    expect(html).toContain("Out of physical range: lowest -40 °F; a room or return air temperature reads 35 °F to 110 °F.");
  });

  it("says None missing, from Workbench, and history size unknown when that is the truth", () => {
    const html = renderToStaticMarkup(
      createElement(DataHealthTile, {
        data: payload({
          expectedInterval: expectedInterval({ enteredS: 900, range: NONE, storedMeasuredS: null }),
          breaks: summariseBreaks({ breaks: [], rangeFromMs: FROM, rangeToMs: TO, earliestMs: FROM }),
          history: { risk: "roll_horizon_unknown", horizon: { state: "unknown", hours: null, currentHours: null, stationCount: null, capacity: 500, capacitySource: "assumed", intervalS: null, intervalSource: null } },
        }),
      }),
    );
    expect(html).toContain(">None missing<");
    expect(html).toContain("Reports about every 15 min (from Workbench)");
    expect(html).toContain("History size unknown");
  });
});

describe("the breaks, said once", () => {
  it("is a summary line and the five longest, with the rest behind Show all", async () => {
    const data = payload();
    const host = await mount(createElement(BreaksList, { breaks: data.breaks, expected: data.expectedInterval, timeZone: "America/New_York" }));
    expect(host.querySelector('[data-testid="bas-breaks-summary"]')?.textContent).toMatch(/^12 breaks, longest 3\.2 h, [\d.]+% of the period missing$/);
    expect(host.querySelectorAll('[data-testid="bas-breaks-longest"] li')).toHaveLength(5);
    expect(host.querySelector('[data-testid="bas-breaks-longest"] li')?.textContent).toContain("3.2 h");
    expect(host.querySelector('[data-testid="bas-breaks-all"]')).toBeNull();
    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="bas-breaks-toggle"]')!;
    expect(toggle.textContent).toBe("Show all 12");
    await act(async () => toggle.click());
    expect(host.querySelectorAll('[data-testid="bas-breaks-all"] li')).toHaveLength(12);
    expect(toggle.textContent).toBe("Show fewer");
  });

  it("says nothing when there are no breaks", async () => {
    const data = payload({ breaks: summariseBreaks({ breaks: [], rangeFromMs: FROM, rangeToMs: TO, earliestMs: FROM }) });
    const host = await mount(createElement(BreaksList, { breaks: data.breaks, expected: data.expectedInterval, timeZone: null }));
    expect(host.innerHTML).toBe("");
  });
});

describe("the trend summary card", () => {
  const result: TrendSummaryResult = {
    state: "written",
    summary: "The space swung between 68 °F and 74 °F each day. One break of 3.2 h is worth a look.",
    message: null,
    rangeFrom: new Date(FROM).toISOString(),
    rangeTo: new Date(TO).toISOString(),
    timezone: "America/New_York",
    newestReadingAt: new Date(TO).toISOString(),
    generatedAt: new Date(TO).toISOString(),
    cached: false,
    costUsd: 0.0123,
    model: "claude-opus-5-5",
    stats: null,
  };

  it("asks for nothing until Explain this trend is pressed, then shows the sentences, the range covered, and Refresh", async () => {
    const request = vi.fn(async () => result);
    const host = await mount(createElement(TrendSummaryCard, { data: payload(), request }));
    expect(request).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="bas-trend-summary-body"]')).toBeNull();
    const button = host.querySelector<HTMLButtonElement>('[data-testid="bas-explain-trend"]')!;
    expect(button.textContent).toBe("Explain this trend");

    await act(async () => button.click());
    expect(request).toHaveBeenCalledWith({ point: "1", days: 7, refresh: false });
    expect(host.querySelector('[data-testid="bas-trend-summary-body"]')?.textContent).toContain("One break of 3.2 h");
    expect(host.querySelector('[data-testid="bas-trend-summary-meta"]')?.textContent).toMatch(/^Covers .+ – .+ · written .+ · \$0\.0123 · numbers checked against the data$/);

    const refresh = host.querySelector<HTMLButtonElement>('[data-testid="bas-trend-summary-refresh"]')!;
    await act(async () => refresh.click());
    expect(request).toHaveBeenLastCalledWith({ point: "1", days: 7, refresh: true });
  });

  it("says why when there is no summary, and never shows a withheld one", async () => {
    const request = vi.fn(async () => ({ ...result, state: "withheld" as const, summary: null, message: "The summary was withheld: it used numbers that are not in the data (88.8)." }));
    const host = await mount(createElement(TrendSummaryCard, { data: payload(), request }));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="bas-explain-trend"]')!.click());
    expect(host.textContent).toContain("withheld");
    expect(host.textContent).not.toContain("88.8 °F");
  });
});

describe("several lines on one chart", () => {
  const line = (over: Partial<ChartLine> = {}): ChartLine => ({
    pointId: "2",
    trend: series(330, FROM + 5 * 60_000, 30 * 60_000, (i) => (i % 10) * 10),
    unit: "percent",
    states: null,
    name: "V4_22/DamperPos",
    axis: "right",
    slot: 1,
    withinMs: 3_600_000,
    ...over,
  });

  const chart = (others: ChartLine[]) =>
    mount(
      createElement(TrendChart, {
        trend: series(330),
        gaps: [],
        unit: "fahrenheit",
        zoom: null,
        range: { fromMs: FROM, toMs: TO },
        selection: null,
        onDragStart: () => {},
        onDragMove: () => {},
        onDragEnd: () => {},
        width: 900,
        height: 350,
        others,
        primaryName: "V4_22/SpaceTemp",
      }),
    );

  it("draws two units on two axes, each labelled with its unit", async () => {
    const host = await chart([line()]);
    expect(host.querySelectorAll(".recharts-yAxis")).toHaveLength(2);
    const labels = [...host.querySelectorAll(".recharts-label")].map((n) => n.textContent);
    expect(labels).toContain("°F");
    expect(labels).toContain("%");
    expect(host.querySelectorAll(".recharts-area-curve").length).toBeGreaterThanOrEqual(2);
    expect(host.innerHTML).toContain("var(--phb-purple)");
  });

  it("puts every line of the first line's unit on the left axis and keeps two axes with four lines", async () => {
    const host = await chart([
      line({ pointId: "5", unit: "fahrenheit", axis: "left", slot: 1, name: "V4_22/SpaceTempSp", trend: series(330, FROM, 30 * 60_000, () => 72) }),
      line({ pointId: "2", slot: 2 }),
      line({ pointId: "6", unit: "percent", axis: "right", slot: 3, name: "V4_22/Valve" }),
    ]);
    expect(host.querySelectorAll(".recharts-yAxis")).toHaveLength(2);
    // Slots 2 and 3 carry their dash patterns as well as their colours.
    expect(host.innerHTML).toContain('stroke-dasharray="6 3"');
    expect(host.innerHTML).toContain('stroke-dasharray="2 3"');
  });

  it("shares one axis when every line carries the first line's unit", async () => {
    const host = await chart([line({ unit: "fahrenheit", axis: "left", trend: series(330, FROM + 5 * 60_000, 30 * 60_000, () => 72) })]);
    expect(host.querySelectorAll(".recharts-yAxis")).toHaveLength(1);
  });

  it("draws one point and one axis with one line", async () => {
    const host = await chart([]);
    expect(host.querySelectorAll(".recharts-yAxis")).toHaveLength(1);
    expect(host.innerHTML).not.toContain("var(--phb-purple)");
  });

  it("reads every value at the shared cursor, each in its own unit, and nothing from across a hole", () => {
    const at = FROM + 30 * 60_000;
    const html = renderToStaticMarkup(
      createElement(LinesTooltip, {
        active: true,
        label: at,
        lines: [
          { trend: series(330), unit: "fahrenheit", states: null, name: "V4_22/SpaceTemp", slot: 0, withinMs: HOUR },
          line(),
          line({ name: "Other/OAT", unit: "fahrenheit", slot: 2, trend: series(10, FROM + 20 * HOUR), withinMs: HOUR }),
        ],
        zone: "America/New_York",
      }),
    );
    // The single-point tooltip's own formatter: one more decimal than the axis.
    expect(html).toContain("V4_22/SpaceTemp: 71.00 °F");
    expect(html).toContain("V4_22/DamperPos: 10.0%");
    expect(html).toContain("Other/OAT: no reading");
  });

  it("names every line in the legend with its axis, and removes one from it", async () => {
    const data = payload();
    const onRemove = vi.fn();
    const host = await mount(
      createElement(LinesLegend, {
        lines: [
          { point: data.selectedPoint!, slot: 0, axis: "left", sampling: { kind: "raw", readings: 330 } },
          { point: point({ pointId: "2", pointName: "V4_22/DamperPos", unit: "percent" }), slot: 1, axis: "right", sampling: { kind: "raw", readings: 330 } },
          { point: point({ pointId: "4", pointName: "Other/OAT", stationId: "10", stationName: "CEI_OTHER" }), slot: 3, axis: "left", sampling: { kind: "bucketed", bucketSeconds: 3600, bucketLabel: "hour", buckets: 168, readings: 2016, maxRaw: 3333 } },
        ],
        onRemove,
      }),
    );
    const entries = [...host.querySelectorAll('[data-testid="bas-legend-line"]')].map((n) => n.textContent);
    expect(entries[0]).toContain("V4_22/SpaceTemp(°F, left axis, CEI_JCI_N2, in the tiles)");
    expect(entries[1]).toContain("V4_22/DamperPos(%, right axis, CEI_JCI_N2)");
    expect(entries[2]).toContain("Other/OAT(°F, left axis, hour averages, CEI_OTHER)");
    const remove = host.querySelector<HTMLButtonElement>('[data-point="2"] [data-testid="bas-legend-remove"]')!;
    expect(remove.getAttribute("aria-label")).toBe("Remove V4_22/DamperPos from the chart");
    await act(async () => remove.click());
    expect(onRemove).toHaveBeenCalledWith("2");
  });

  it("offers no remove button with one line", async () => {
    const data = payload();
    const host = await mount(
      createElement(LinesLegend, { lines: [{ point: data.selectedPoint!, slot: 0, axis: "left", sampling: data.sampling }], onRemove: () => {} }),
    );
    expect(host.querySelector('[data-testid="bas-legend-remove"]')).toBeNull();
  });

  it("disables the trend summary with more than one line, and asks for nothing", async () => {
    const request = vi.fn();
    const host = await mount(createElement(TrendSummaryCard, { data: payload(), request, lines: 3 }));
    const button = host.querySelector<HTMLButtonElement>('[data-testid="bas-explain-trend"]')!;
    expect(button.disabled).toBe(true);
    expect(host.querySelector('[data-testid="bas-trend-summary-several"]')?.textContent).toBe(
      "A summary describes one point. With 3 lines on the chart, plot one point to explain its trend.",
    );
    await act(async () => button.click());
    expect(request).not.toHaveBeenCalled();
  });

  it("says whose breaks they are when the chart holds several lines", async () => {
    const data = payload();
    const host = await mount(
      createElement(BreaksList, { breaks: data.breaks, expected: data.expectedInterval, timeZone: null, showing: "V4_22/SpaceTemp" }),
    );
    expect(host.querySelector('[data-testid="bas-breaks-showing"]')?.textContent).toBe("showing V4_22/SpaceTemp");
  });

  it("shows the first point's tiles under a note naming it, and the other lines' notes on the panel", async () => {
    const data = payload({
      comparisons: [
        {
          point: point({ pointId: "2", pointName: "V4_22/DamperPos", unit: "percent" }),
          trend: series(330, FROM, 30 * 60_000, (i) => i % 100),
          sampling: { kind: "raw", readings: 330 },
          stats: { readings: 330, average: 50, minimum: 0, maximum: 99, latest: 10, latestAt: new Date(TO).toISOString() },
          expectedInterval: payload().expectedInterval,
          axis: "right",
        },
      ],
      comparisonNotes: ["V4_22/Occ is not drawn: the chart already has two axes (°F and %) and it reads True / False. Remove a line to make room for it."],
    });
    const host = await mount(createElement(TrendPanel, { data, unit: "fahrenheit", slots: ["1", "2"], onAdd: () => {}, onRemove: () => {} }));
    expect(host.querySelector('[data-testid="bas-compare-note"]')?.textContent).toContain("V4_22/Occ is not drawn");
    expect(host.querySelectorAll('[data-testid="bas-legend-line"]')).toHaveLength(2);
    expect(host.querySelector('[data-testid="bas-breaks-showing"]')?.textContent).toBe("showing V4_22/SpaceTemp");
    expect(host.querySelector('[data-testid="bas-add-point-button"]')?.textContent).toBe("Add point");
  });
});

// ------------------------------------------------------------- the split

const risks = (partial: Partial<Record<RollRisk, number>>): Record<RollRisk, number> => ({
  ok: 0,
  at_risk: 0,
  data_lost: 0,
  short_horizon: 0,
  buffer_not_full: 0,
  roll_horizon_unknown: 0,
  never_collected: 0,
  ...partial,
});

const dashboard = (health: BasDashboard["projects"][number]["health"]): BasDashboard => ({
  observedAt: new Date(TO).toISOString(),
  projects: [{ projectId: "7", name: "CEI", orgName: "PH+B", buildings: 1, stations: 1, health }],
  projectsInDatabase: 1,
});

describe("the Projects card splits a real risk from an unknown history size", () => {
  it("reads calm with 334 unknown: no mark, and the muted line beside it", () => {
    const html = renderToStaticMarkup(
      createElement(DashboardCards, {
        data: dashboard({ activePoints: 334, pointsAtRisk: 0, pointsHistoryUnknown: 334, riskCounts: risks({ roll_horizon_unknown: 334 }), minutesSinceNewestReading: 12 }),
      }),
    );
    expect(html).toContain("No points at risk");
    expect(html).not.toContain("bas-dashboard-alarm");
    expect(html).toContain("334 points: history size unknown");
    // A non-admin gets the words, not a link Settings would answer 404.
    expect(html).not.toContain('href="/bas/settings?history=unknown"');
    // The whole card is still the project's link.
    expect(html).toContain('href="/bas/points?project=7&amp;point=none"');
  });

  it("links a module admin to Settings, filtered to those points", () => {
    const html = renderToStaticMarkup(
      createElement(DashboardCards, {
        canAdminister: true,
        data: dashboard({ activePoints: 334, pointsAtRisk: 0, pointsHistoryUnknown: 334, riskCounts: risks({ roll_horizon_unknown: 334 }), minutesSinceNewestReading: 12 }),
      }),
    );
    expect(html).toContain('href="/bas/settings?history=unknown"');
    // No link inside a link: the card's own link is an overlay beside it.
    const dom = document.createElement("div");
    dom.innerHTML = html;
    expect(dom.querySelectorAll("a")).toHaveLength(2);
    expect(dom.querySelector("a a")).toBeNull();
  });

  it("marks a measured risk in the alert colour, with the unknown line beside it and not in it", () => {
    const html = renderToStaticMarkup(
      createElement(DashboardCards, {
        data: dashboard({ activePoints: 334, pointsAtRisk: 3, pointsHistoryUnknown: 7, riskCounts: risks({ short_horizon: 3, roll_horizon_unknown: 7, ok: 324 }), minutesSinceNewestReading: 12 }),
      }),
    );
    expect(/data-testid="bas-dashboard-alarm"[^>]*>([^<]*)</.exec(html)?.[1]).toBe("3 points at risk of data loss");
    expect(html).toContain("7 points: history size unknown");
  });

  it("says the same on Collection Health's headline tile", () => {
    expect(renderToStaticMarkup(createElement(HistoryUnknownLine, { count: 334, canAdminister: true }))).toContain(
      'href="/bas/settings?history=unknown"',
    );
    expect(renderToStaticMarkup(createElement(HistoryUnknownLine, { count: 334, canAdminister: false }))).toContain(
      "334 points: history size unknown",
    );
    expect(renderToStaticMarkup(createElement(HistoryUnknownLine, { count: 0, canAdminister: true }))).toBe("");
  });
});

describe("the small lines", () => {
  it("meters trend summaries on the Usage page under their own line", () => {
    const html = renderToStaticMarkup(createElement(TrendSummariesLine, { trendSummaries: { written: 3, withheld: 1, tokens: 4400, spend: 0.0412 } }));
    expect(html).toContain("Trend summaries:");
    expect(html).toContain("3 written");
    expect(html).toContain("1 withheld or failed");
    expect(html).toContain("not in the run figures above");
    expect(renderToStaticMarkup(createElement(TrendSummariesLine, { trendSummaries: { written: 0, withheld: 0, tokens: 0, spend: 0 } }))).toBe("");
  });

  it("shows a station's assumed capacity as Niagara's default, with Change", () => {
    const station = { stationId: "9", assumedCapacity: 500 } as SettingsStation;
    const html = renderToStaticMarkup(createElement(AssumedCapacityControl, { station, busy: false, run: async () => true }));
    expect(html).toContain("500 records");
    expect(html).toContain("(Niagara&#x27;s default)");
    expect(html).toContain("Change");
    const changed = renderToStaticMarkup(createElement(AssumedCapacityControl, { station: { ...station, assumedCapacity: 1000 }, busy: false, run: async () => true }));
    expect(changed).toContain("Niagara&#x27;s default is 500");
  });
});
