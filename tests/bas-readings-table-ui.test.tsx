// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * The trend panel's table face, in the DOM.
 *
 *  - ZERO COST UNTIL ASKED: the panel in chart view makes no request at all;
 *    switched to the table it makes exactly one, for page 1 of the chart's own
 *    instants; the CSV is requested only by the click.
 *  - A boolean point's rows are words, and no cell holds a digit.
 *  - A row's timestamp is the chart tooltip's formatter in the chart's zone.
 *  - The heading carries the count; the pager says where you are.
 *  - A capped download says what was exported and what was cut, in the
 *    warning tone; a clean one says nothing.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/bas/points",
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
}));

import { TrendPanel } from "@/app/(modules)/bas/point-explorer";
import {
  describeCappedExport,
  formatTimestamp,
} from "@/app/(modules)/bas/health-client";
import type {
  PointExplorer,
  PointReadingsPage,
  TrendPoint,
} from "@/lib/modules/bas/types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

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

/** Let the component's fetch resolve and React commit the result. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(async () => {
  for (const { root, host } of roots.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  vi.restoreAllMocks();
});

const ZONE = "America/New_York";
const RANGE = {
  kind: "preset" as const,
  days: 7,
  from: "2026-09-15T18:00:00.000Z",
  to: "2026-09-22T18:00:00.000Z",
  fromDate: null,
  toDate: null,
  timezone: ZONE,
};

const TREND: TrendPoint[] = [
  { tsMs: Date.parse("2026-09-22T10:00:00Z"), value: 0, isBreak: false },
  { tsMs: Date.parse("2026-09-22T11:00:00Z"), value: 1, isBreak: false },
  { tsMs: Date.parse("2026-09-22T12:00:00Z"), value: 1, isBreak: false },
  { tsMs: Date.parse("2026-09-22T13:00:00Z"), value: 0, isBreak: false },
];

function payload(overrides: Partial<PointExplorer> = {}): PointExplorer {
  return {
    windowDays: 7,
    range: RANGE,
    calendar: null,
    observedAt: RANGE.to,
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
      pointName: "Supply fan status",
      pointRole: "supply_fan_status",
      unit: null,
      siteName: "ZZTEST_SITE",
      valueKind: "boolean",
      states: { on: "On", off: "Off" },
    },
    collectionIntervalS: 300,
    stationClockOffsetS: 0,
    stationClockMeasuredAt: null,
    stats: {
      readings: 4,
      nullRecords: 0,
      distinctValues: 2,
      latest: 0,
      latestAt: "2026-09-22T13:00:00.000Z",
      average: null,
      minimum: 0,
      maximum: 1,
    },
    pointExtent: { earliestAt: "2026-09-22T10:00:00.000Z", latestAt: "2026-09-22T13:00:00.000Z" },
    trend: TREND,
    trendGaps: [],
    sampling: { kind: "raw", readings: 4 },
    dataGaps: [],
    ...overrides,
  };
}

const PAGE: PointReadingsPage = {
  point: payload().selectedPoint!,
  stationId: "7",
  stationName: "ZZTestStation",
  niagaraHistoryName: "SupplyFanStatus",
  timezone: ZONE,
  from: RANGE.from,
  to: RANGE.to,
  total: 4,
  page: 1,
  pageSize: 200,
  pages: 1,
  rows: [
    { ts: "2026-09-22T13:00:00.000000Z", valueNum: null, valueBool: false, valueStr: null, status: null },
    { ts: "2026-09-22T12:00:00.000000Z", valueNum: null, valueBool: true, valueStr: null, status: null },
    { ts: "2026-09-22T11:00:00.000000Z", valueNum: null, valueBool: true, valueStr: null, status: null },
    { ts: "2026-09-22T10:00:00.000000Z", valueNum: null, valueBool: false, valueStr: null, status: null },
  ],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("nothing is fetched until the table is shown", () => {
  it("the chart view makes no request", async () => {
    const host = await render(createElement(TrendPanel, { data: payload(), unit: null }));
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    // The toggle and the button are there, and that is all that is new.
    expect(host.querySelector('[role="group"][aria-label="Show as"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="bas-download-csv"]')!.textContent).toBe(
      "Download CSV",
    );
    expect(host.querySelector('[data-testid="bas-readings-table"]')).toBeNull();
    expect(host.querySelector("h2")!.textContent).toBe("Trend");
  });

  it("the table view makes exactly one, for page 1 of the chart's instants", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: PAGE }));
    await render(createElement(TrendPanel, { data: payload(), unit: null, view: "table" }));
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]![0]), "http://localhost");
    expect(url.pathname).toBe("/api/modules/bas/point-readings");
    expect(url.searchParams.get("point")).toBe("44");
    expect(url.searchParams.get("from")).toBe(RANGE.from);
    expect(url.searchParams.get("to")).toBe(RANGE.to);
    expect(url.searchParams.get("page")).toBe("1");
  });
});

describe("the rows", () => {
  it("a boolean point reads as words, with no digit in any value cell", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: PAGE }));
    const host = await render(
      createElement(TrendPanel, { data: payload(), unit: null, view: "table" }),
    );
    await settle();

    const cells = [...host.querySelectorAll('[data-testid="bas-reading-value"]')].map(
      (cell) => cell.textContent,
    );
    expect(cells).toEqual(["Off", "On", "On", "Off"]);
    for (const text of cells) expect(text).not.toMatch(/\d/);
  });

  it("timestamps are the tooltip's formatter in the chart's zone, with the exact instant as the title", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: PAGE }));
    const host = await render(
      createElement(TrendPanel, { data: payload(), unit: null, view: "table" }),
    );
    await settle();

    const cells = [...host.querySelectorAll("tbody td:first-child")];
    expect(cells.map((cell) => cell.textContent)).toEqual(
      PAGE.rows.map((row) => formatTimestamp(row.ts, undefined, ZONE)),
    );
    expect(cells.map((cell) => cell.getAttribute("title"))).toEqual(PAGE.rows.map((r) => r.ts));
    // In the zone: 13:00Z on 22 September is 09:00 in New York.
    expect(cells[0]!.textContent).toMatch(/09:00/);
  });

  it("the heading carries the count and the pager says where you are", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { ...PAGE, total: 9012, pages: 46 } }));
    const host = await render(
      createElement(TrendPanel, { data: payload(), unit: null, view: "table" }),
    );
    await settle();

    expect(host.querySelector("h2")!.textContent).toBe("Readings (9,012)");
    expect(host.querySelector('[data-testid="bas-readings-page"]')!.textContent).toBe(
      "Page 1 of 46",
    );
    expect(host.querySelector('[data-testid="bas-readings-position"]')!.textContent).toBe(
      "1–4 of 9,012, newest first",
    );
    expect(host.querySelector('[data-testid="bas-sampling-notice"]')).toBeNull();
  });

  it("paging requests the next page and nothing else", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { ...PAGE, total: 500, pages: 3 } }));
    const host = await render(
      createElement(TrendPanel, { data: payload(), unit: null, view: "table" }),
    );
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValue(
      jsonResponse({ data: { ...PAGE, total: 500, pages: 3, page: 2 } }),
    );
    const next = [...host.querySelectorAll("nav button")].find(
      (b) => b.textContent === "Next",
    ) as HTMLButtonElement;
    await act(async () => next.click());
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const url = new URL(String(fetchMock.mock.calls[1]![0]), "http://localhost");
    expect(url.searchParams.get("page")).toBe("2");
    expect(host.querySelector('[data-testid="bas-readings-page"]')!.textContent).toBe(
      "Page 2 of 3",
    );
  });
});

describe("Download CSV", () => {
  function csvResponse(total: number, exported: number): Response {
    return new Response("timestamp,value\r\n", {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="readings-test.csv"',
        "X-PHB-Readings-Total": String(total),
        "X-PHB-Readings-Exported": String(exported),
        "X-PHB-Readings-Cap": "500000",
      },
    });
  }

  beforeEach(() => {
    vi.stubGlobal("URL", Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:test"),
      revokeObjectURL: vi.fn(),
    }));
  });

  it("is requested only by the click, and a clean export says nothing", async () => {
    const host = await render(createElement(TrendPanel, { data: payload(), unit: null }));
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(csvResponse(4, 4));
    const button = host.querySelector('[data-testid="bas-download-csv"]') as HTMLButtonElement;
    await act(async () => button.click());
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]![0]), "http://localhost");
    expect(url.pathname).toBe("/api/modules/bas/point-readings/csv");
    expect(url.searchParams.get("point")).toBe("44");
    expect(url.searchParams.get("from")).toBe(RANGE.from);
    expect(url.searchParams.get("to")).toBe(RANGE.to);
    expect(url.searchParams.has("page")).toBe(false);
    expect(host.querySelector('[data-testid="bas-download-note"]')).toBeNull();
    expect(button.textContent).toBe("Download CSV");
  });

  it("a capped export says what was exported and what was cut", async () => {
    fetchMock.mockResolvedValue(csvResponse(612_345, 500_000));
    const host = await render(createElement(TrendPanel, { data: payload(), unit: null }));
    const button = host.querySelector('[data-testid="bas-download-csv"]') as HTMLButtonElement;
    await act(async () => button.click());
    await settle();

    const note = host.querySelector('[data-testid="bas-download-note"]');
    expect(note).not.toBeNull();
    expect(note!.textContent).toBe(
      "Exported the newest 500,000 of 612,345 readings. 112,345 older readings were not included; narrow the range to export them.",
    );
    expect(note!.getAttribute("role")).toBe("note");
    expect(describeCappedExport({ total: 10, exported: 10 })).toBeNull();
    expect(describeCappedExport({ total: 3, exported: 2 })).toContain("1 older reading was");
  });

  it("a failed download says so, as an alert", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "not_found", message: "That point is hidden from Point Explorer. Show it again under Settings → Points." } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    const host = await render(createElement(TrendPanel, { data: payload(), unit: null }));
    const button = host.querySelector('[data-testid="bas-download-csv"]') as HTMLButtonElement;
    await act(async () => button.click());
    await settle();

    const note = host.querySelector('[data-testid="bas-download-note"]');
    expect(note!.getAttribute("role")).toBe("alert");
    expect(note!.textContent).toContain("hidden from Point Explorer");
  });
});

describe("the table's source", () => {
  it("formats every timestamp through the tooltip's formatter and nothing of its own", () => {
    const source = readFileSync(
      path.join(process.cwd(), "app", "(modules)", "bas", "readings-table.tsx"),
      "utf8",
    );
    expect(source).toContain("formatTimestamp(row.ts, undefined, zone)");
    expect(source).not.toMatch(/toLocale(Date|Time)?String/);
    expect(source).not.toContain("Intl.DateTimeFormat");
    // Raw rows only: the table never receives the trend.
    expect(source).not.toContain("trend");
    expect(source).not.toContain("sampling");
  });
});
