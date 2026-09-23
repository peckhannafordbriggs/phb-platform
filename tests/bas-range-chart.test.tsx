// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * What a downsampled trend looks like once DRAWN.
 *
 * tests/bas-custom-range.test.ts proves the database hands the chart a bucket
 * whose minimum is -40. This file proves the chart does something with it:
 * the y-axis reaches the extreme and a band is rendered under the line. Drop
 * `min`/`max` from the axis's visible values, or the band `<Area>`, and the
 * assertions here fail against the SVG Recharts drew.
 *
 * The readings are the real points_RoomT readings from 18 to 24 August 2026
 * in the fixture file, bucketed BY LOCAL DAY here in the test with plain
 * arithmetic (average, lowest, highest). That is test-side bookkeeping, not
 * a second downsampler: the SQL one is tested where it lives.
 *
 * WHY DAYS. At 09:05 on 24 August the sensor went from 76 to -40 and stayed
 * there. In a 30-minute bucket the average of that hour is already -20, so an
 * axis fitted to averages alone would reach -40 through the buckets that
 * follow, and a test at that width passed with the band's contribution to
 * the axis removed (mutation record, 2026-09-22). Over the whole day the
 * average is about 4 degF: an axis of averages stops at 0, and only the band
 * reaches -40. That is the width at which the band is the only thing telling
 * the truth, so that is the width this test uses.
 *
 * jsdom, for the reason bas-chart-axis.test.tsx gives: Recharts renders no
 * axis at all on the server.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/bas/points",
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
}));

import { TrendChart, TrendPanel } from "@/app/(modules)/bas/point-explorer";
import type { PointExplorer, TrendPoint } from "@/lib/modules/bas/types";
import { ROOM_T } from "./bas-live-fixture";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const at = (iso: string): number => Date.parse(iso);
/** 18 to 24 August 2026, local midnights (EDT). Seven days, no clock change. */
const WEEK_FROM = at("2026-08-18T00:00:00-04:00");
const WEEK_TO = at("2026-08-25T00:00:00-04:00");
const DAY_MS = 86_400_000;
const FAULT_DAY_FROM = at("2026-08-24T00:00:00-04:00");

/** The week's real readings, one bucket per local day. */
function bucketByDay(): TrendPoint[] {
  const buckets = new Map<number, number[]>();
  for (const [ms, value] of ROOM_T.readings) {
    if (ms < WEEK_FROM || ms >= WEEK_TO || typeof value !== "number") continue;
    const start = WEEK_FROM + Math.floor((ms - WEEK_FROM) / DAY_MS) * DAY_MS;
    const list = buckets.get(start) ?? [];
    list.push(value);
    buckets.set(start, list);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([tsMs, values]) => ({
      tsMs,
      value: values.reduce((sum, v) => sum + v, 0) / values.length,
      isBreak: false,
      min: Math.min(...values),
      max: Math.max(...values),
      readings: values.length,
    }));
}

const BUCKETED = bucketByDay();
const RAW_WEEK: TrendPoint[] = ROOM_T.readings
  .filter(([ms]) => ms >= WEEK_FROM && ms < WEEK_TO)
  .map(([tsMs, value]) => ({ tsMs, value: value as number, isBreak: false }));

const CHART = { width: 640, height: 320 };

// ------------------------------------------------------------------ render

const roots: Array<{ root: Root; host: HTMLDivElement }> = [];

async function render(element: React.ReactElement): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push({ root, host });
  await act(async () => {
    root.render(element);
  });
  return host;
}

afterEach(async () => {
  for (const { root, host } of roots.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
});

function yLabels(host: HTMLElement): number[] {
  const texts = [
    ...host.querySelectorAll<SVGTextElement>(
      ".recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value",
    ),
  ];
  if (texts.length === 0) throw new Error("no y-axis ticks were rendered");
  return texts.map((text) => Number(text.textContent));
}

const chart = (trend: TrendPoint[], sampled: boolean) =>
  createElement(TrendChart, {
    trend,
    gaps: [],
    unit: "fahrenheit",
    zoom: null,
    range: { fromMs: WEEK_FROM, toMs: WEEK_TO },
    timeZone: "America/New_York",
    sampled,
    selection: null,
    onDragStart: () => {},
    onDragMove: () => {},
    onDragEnd: () => {},
    ...CHART,
  });

// ----------------------------------------------------------- the extreme

describe("the sensor fault of 24 August 2026, in day buckets", () => {
  it("is in the source, and the day's average hides it", () => {
    expect(RAW_WEEK.some((p) => p.value === -40)).toBe(true);
    const faultDay = BUCKETED.find((b) => b.tsMs === FAULT_DAY_FROM);
    expect(faultDay).toBeDefined();
    expect(faultDay!.min).toBe(-40);
    expect(faultDay!.max).toBeGreaterThan(75);
    // The average of 76 for nine hours and -40 for fifteen. A chart of
    // averages would show a sensor a little above freezing.
    expect(faultDay!.value).toBeGreaterThan(0);
    expect(faultDay!.value).toBeLessThan(10);
    // Every other day of the week averaged in the seventies.
    for (const day of BUCKETED.filter((b) => b.tsMs !== FAULT_DAY_FROM)) {
      expect(day.value).toBeGreaterThan(70);
      expect(day.min).toBeGreaterThan(70);
    }
  });

  it("reaches the axis: the lowest tick is at or below -40", async () => {
    const host = await render(chart(BUCKETED, true));
    const labels = yLabels(host);
    expect(Math.min(...labels)).toBeLessThanOrEqual(-40);
    expect(Math.max(...labels)).toBeGreaterThanOrEqual(77);
  });

  it("an axis of the averages alone would stop at zero - the control", async () => {
    // The same buckets with min and max stripped: what the chart would show if
    // the band's values were not part of the axis. This is the shape the
    // mutation produces, rendered on purpose so the assertion above is known
    // to be able to fail.
    const averagesOnly = BUCKETED.map(({ tsMs, value, isBreak }) => ({ tsMs, value, isBreak }));
    const host = await render(chart(averagesOnly, false));
    expect(Math.min(...yLabels(host))).toBeGreaterThan(-40);
  });

  it("draws a band under the line - two areas, not one", async () => {
    const host = await render(chart(BUCKETED, true));
    const areas = host.querySelectorAll(".recharts-area");
    expect(areas).toHaveLength(2);
    const fills = [...host.querySelectorAll<SVGPathElement>(".recharts-area-area")];
    expect(fills).toHaveLength(2);
    expect(fills.every((path) => (path.getAttribute("d") ?? "").length > 50)).toBe(true);
  });

  it("with the same buckets drawn as raw samples, the band is absent", async () => {
    // The control: `sampled` false draws one series. Proves the count of two
    // above comes from the band and not from something else on the chart.
    const host = await render(chart(BUCKETED, false));
    expect(host.querySelectorAll(".recharts-area")).toHaveLength(1);
  });

  it("the axis of the RAW week reaches -40 too, so raw and bucketed agree on the floor", async () => {
    const host = await render(chart(RAW_WEEK, false));
    expect(Math.min(...yLabels(host))).toBeLessThanOrEqual(-40);
  });
});

// --------------------------------------------------------- the notices

const RANGE = {
  kind: "custom" as const,
  days: null,
  from: new Date(WEEK_FROM).toISOString(),
  to: new Date(WEEK_TO).toISOString(),
  fromDate: "2026-08-18",
  toDate: "2026-08-24",
  timezone: "America/New_York",
};

function payload(overrides: Partial<PointExplorer>): PointExplorer {
  return {
    windowDays: 7,
    range: RANGE,
    calendar: {
      timezone: "America/New_York",
      today: "2026-09-22",
      earliestDate: "2024-02-21",
      latestDate: "2026-09-22",
      years: [2024, 2025, 2026],
    },
    observedAt: "2026-09-22T18:00:00.000Z",
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
    points: [],
    selectedPoint: {
      pointId: "44",
      pointName: "points_RoomT",
      pointRole: "zone_temp",
      unit: "fahrenheit",
      siteName: "PHB Spring Grove",
    },
    collectionIntervalS: 300,
    stationClockOffsetS: 0,
    stationClockMeasuredAt: null,
    stats: {
      readings: RAW_WEEK.length,
      nullRecords: 0,
      distinctValues: 10,
      latest: -40,
      latestAt: "2026-09-22T18:20:00.020Z",
      average: 60,
      minimum: -40,
      maximum: 77,
    },
    pointExtent: {
      earliestAt: "2026-08-18T19:10:00.015Z",
      latestAt: "2026-09-22T18:20:00.020Z",
    },
    trend: BUCKETED,
    trendGaps: [],
    sampling: {
      kind: "bucketed",
      bucketSeconds: 86_400,
      bucketLabel: "day",
      buckets: BUCKETED.length,
      readings: RAW_WEEK.length,
      maxRaw: 10_000,
    },
    dataGaps: [],
    ...overrides,
  };
}

describe("the trend panel says what it did", () => {
  it("shows the downsampling notice when the trend is bucketed", async () => {
    const host = await render(createElement(TrendPanel, { data: payload({}), unit: "fahrenheit" }));
    const notice = host.querySelector('[data-testid="bas-sampling-notice"]');
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain("Averaged to one point per day");
    expect(notice!.textContent).toContain(`${RAW_WEEK.length.toLocaleString("en-US")} readings`);
    expect(notice!.textContent).toContain("lowest and highest reading");
  });

  it("shows no such notice when the trend is raw", async () => {
    const host = await render(
      createElement(TrendPanel, {
        data: payload({ trend: RAW_WEEK, sampling: { kind: "raw", readings: RAW_WEEK.length } }),
        unit: "fahrenheit",
      }),
    );
    expect(host.querySelector('[data-testid="bas-sampling-notice"]')).toBeNull();
  });

  it("replaces an empty chart with a sentence naming the range and the nearest data", async () => {
    const host = await render(
      createElement(TrendPanel, {
        data: payload({
          trend: [],
          stats: { ...payload({}).stats, readings: 0 },
          sampling: { kind: "raw", readings: 0 },
          range: {
            ...RANGE,
            from: "2025-12-01T05:00:00.000Z",
            to: "2026-01-01T05:00:00.000Z",
            fromDate: "2025-12-01",
            toDate: "2025-12-31",
          },
        }),
        unit: "fahrenheit",
      }),
    );
    const empty = host.querySelector('[data-testid="bas-no-readings"]');
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toMatch(/^No readings for points_RoomT between /);
    expect(empty!.textContent).toContain("earliest reading held for this point");
    expect(host.querySelector(".recharts-responsive-container")).toBeNull();
  });

  it("says where the data begins when the range starts before it", async () => {
    const host = await render(
      createElement(TrendPanel, {
        data: payload({
          range: {
            ...RANGE,
            from: "2026-08-01T04:00:00.000Z",
            fromDate: "2026-08-01",
          },
        }),
        unit: "fahrenheit",
      }),
    );
    const notices = [...host.querySelectorAll('[data-testid="bas-extent-notice"]')];
    expect(notices).toHaveLength(1);
    expect(notices[0]!.textContent).toMatch(/^Data for this point begins /);
    expect(notices[0]!.textContent).toContain("not because the equipment was off");
  });

  it("legends the recorded gaps that touch the range", async () => {
    const host = await render(
      createElement(TrendPanel, {
        data: payload({
          dataGaps: [
            {
              // The real 21-22 August overwrite: inside the week.
              gapId: "9",
              pointName: "points_RoomT",
              siteName: "PHB Spring Grove",
              gapStart: "2026-08-21T20:05:00.003Z",
              gapEnd: "2026-08-22T18:40:46.073Z",
              detectedAt: "2026-08-24T12:20:46.152Z",
              hoursLost: 22.6,
              cause: "roll_overwrite",
              notes: null,
            },
            {
              // The real 28-29 August one: outside the week, not legended.
              gapId: "13",
              pointName: "points_RoomT",
              siteName: "PHB Spring Grove",
              gapStart: "2026-08-28T19:50:00.013Z",
              gapEnd: "2026-08-29T18:40:49.058Z",
              detectedAt: "2026-08-31T12:20:49.192Z",
              hoursLost: 22.8,
              cause: "roll_overwrite",
              notes: null,
            },
          ],
        }),
        unit: "fahrenheit",
      }),
    );
    const legend = host.querySelector('[data-testid="bas-recorded-gaps-legend"]');
    expect(legend).not.toBeNull();
    expect(legend!.textContent).toContain("the 1 gap in this range");
  });
});

describe("recorded gaps are outlined on the chart", () => {
  it("draws one reference area per recorded gap, labelled with its cause", async () => {
    const host = await render(
      createElement(TrendChart, {
        trend: RAW_WEEK,
        gaps: [],
        recordedGaps: [
          { fromMs: at("2026-08-21T16:05:00-04:00"), toMs: at("2026-08-22T14:40:46-04:00"), cause: "Station overwrote it" },
        ],
        unit: "fahrenheit",
        zoom: null,
        range: { fromMs: WEEK_FROM, toMs: WEEK_TO },
        timeZone: "America/New_York",
        selection: null,
        onDragStart: () => {},
        onDragMove: () => {},
        onDragEnd: () => {},
        ...CHART,
      }),
    );
    const areas = host.querySelectorAll(".recharts-reference-area");
    expect(areas).toHaveLength(1);
    expect(host.textContent).toContain("Station overwrote it");
  });
});
