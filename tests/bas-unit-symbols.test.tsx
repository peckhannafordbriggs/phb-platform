// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Units are shown as symbols: °F, %, inWC - everywhere a value or an axis
 * shows one, from ONE formatter driven by the unit column (2026-09-29).
 *
 * The stored value is untouched: `bas_points.unit` still says "fahrenheit",
 * and the tests here hand the components that stored value and read the
 * symbol back off what they rendered - a tile, the chart's axis label, the
 * tooltip, the per-point table. The no-unit case is asserted in each place
 * too, because a bare number and "no unit recorded" are different claims.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/bas/points",
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
}));

import { PointTable } from "@/app/(modules)/bas/collection-health";
import { axisLabel, formatValue } from "@/app/(modules)/bas/health-client";
import { Tile, TrendChart } from "@/app/(modules)/bas/point-explorer";
import { formatTooltipValue } from "@/app/(modules)/bas/value-axis";
import {
  knownUnitNames,
  unitKind,
  unitSymbol,
  withUnit,
} from "@/lib/modules/bas/units";
import type { PointHealthRow, TrendPoint } from "@/lib/modules/bas/types";

// ------------------------------------------------------------- the formatter

describe("unitSymbol", () => {
  it("maps the three units the estate uses to their symbols", () => {
    expect(unitSymbol("fahrenheit")).toBe("°F");
    expect(unitSymbol("percent")).toBe("%");
    expect(unitSymbol("inches of water")).toBe("inWC");
  });

  it("matches by the whole normalised name, as the axis does", () => {
    expect(unitSymbol(" Fahrenheit ")).toBe("°F");
    expect(unitSymbol("Degrees   Fahrenheit")).toBe("°F");
    expect(unitSymbol("celsius")).toBe("°C");
    expect(unitSymbol("psi")).toBe("psi");
    expect(unitSymbol("kilopascals")).toBe("kPa");
  });

  it("shows an unknown unit as it was stored, never as a guess", () => {
    expect(unitSymbol("percent of full scale")).toBe("percent of full scale");
    expect(unitSymbol("furlongs per fortnight")).toBe("furlongs per fortnight");
  });

  it("is null for no unit, so a bare number stays a bare number", () => {
    expect(unitSymbol(null)).toBeNull();
    expect(unitSymbol("")).toBeNull();
    expect(unitSymbol("   ")).toBeNull();
  });

  it("has a symbol for every name the axis knows how to round", () => {
    const SYMBOLS = ["°F", "°C", "K", "%", "inWC", "inH₂O", "psi", "psig", "Pa", "kPa", "bar", "mbar"];
    for (const name of knownUnitNames()) {
      expect(SYMBOLS, name).toContain(unitSymbol(name));
      expect(unitKind(name), name).not.toBe("other");
    }
  });
});

describe("withUnit", () => {
  it("attaches percent and spaces everything else", () => {
    expect(withUnit("72.0", "fahrenheit")).toBe("72.0 °F");
    expect(withUnit("33", "percent")).toBe("33%");
    expect(withUnit("1.23", "inches of water")).toBe("1.23 inWC");
    expect(withUnit("72.0", null)).toBe("72.0");
  });
});

// ------------------------------------------------------------------- a tile

describe("a Point Explorer tile", () => {
  // 72.02734375 is a genuine float32 reading (7/256); the tile shows it at
  // the two decimals the database rounds to.
  const tile = (unit: string | null) =>
    renderToStaticMarkup(
      createElement(Tile, { label: "Latest", value: formatValue(72.02734375, unit), tone: "neutral" }),
    );

  it("shows °F for fahrenheit", () => {
    expect(tile("fahrenheit")).toContain(">72.03 °F<");
    expect(tile("fahrenheit")).not.toContain("fahrenheit");
  });

  it("shows % for percent, attached", () => {
    expect(tile("percent")).toContain(">72.03%<");
  });

  it("shows the bare number when no unit is recorded", () => {
    expect(tile(null)).toContain(">72.03<");
  });
});

// ------------------------------------------------------------------ the axis

const at = (iso: string): number => Date.parse(iso);
const TREND: TrendPoint[] = [
  ["2026-09-17T08:45:00-04:00", 71.91999816894531],
  ["2026-09-17T09:00:00-04:00", 71.94000244140625],
  ["2026-09-17T09:15:00-04:00", 71.97000122070312],
  ["2026-09-17T09:30:00-04:00", 71.9000015258789],
].map(([iso, value]) => ({ tsMs: at(iso as string), value: value as number, isBreak: false }));

const roots: Array<{ root: Root; host: HTMLDivElement }> = [];

async function renderChart(unit: string | null, tooltipIndex?: number): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push({ root, host });
  await act(async () => {
    root.render(
      createElement(TrendChart, {
        trend: TREND,
        gaps: [],
        unit,
        zoom: null,
        selection: null,
        onDragStart: () => {},
        onDragMove: () => {},
        onDragEnd: () => {},
        tooltipIndex,
        width: 640,
        height: 320,
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

/** The rotated label on the y-axis, as Recharts drew it. */
function axisLabelText(host: HTMLElement): string {
  const label = host.querySelector(".recharts-yAxis .recharts-label, .recharts-label");
  if (label === null) throw new Error("no axis label was rendered");
  return label.textContent ?? "";
}

describe("the chart's axis label", () => {
  it("is the symbol, from the same formatter", () => {
    expect(axisLabel("fahrenheit")).toBe("°F");
    expect(axisLabel("percent")).toBe("%");
    expect(axisLabel("inches of water")).toBe("inWC");
    expect(axisLabel(null)).toBe("no unit recorded");
  });

  it("renders °F on a fahrenheit point", async () => {
    const host = await renderChart("fahrenheit");
    expect(axisLabelText(host)).toBe("°F");
    expect(host.textContent).not.toContain("fahrenheit");
  });

  it("renders % on a percent point", async () => {
    const host = await renderChart("percent");
    expect(axisLabelText(host)).toBe("%");
  });

  it("says so when no unit is recorded, rather than leaving the axis bare", async () => {
    const host = await renderChart(null);
    expect(axisLabelText(host)).toBe("no unit recorded");
  });
});

describe("the tooltip", () => {
  it("shows the symbol with one more decimal than the axis", () => {
    expect(formatTooltipValue(71.91999816894531, "fahrenheit")).toBe("71.92 °F");
    expect(formatTooltipValue(33.33000183105469, "percent")).toBe("33.3%");
    expect(formatTooltipValue(1.2300000190734863, "inches of water")).toBe("1.230 inWC");
    expect(formatTooltipValue(71.91999816894531, null)).toBe("71.920");
  });

  it("and that is what the rendered tooltip says", async () => {
    const host = await renderChart("fahrenheit", 0);
    const item = host.querySelector(".recharts-tooltip-item-value");
    if (item === null) throw new Error("the tooltip did not render");
    expect(item.textContent).toBe("71.92 °F");
  });
});

// ------------------------------------------------------------ the points table

describe("the per-point table on Collection Health", () => {
  const row = (pointId: string, pointName: string, unit: string | null): PointHealthRow => ({
    pointId,
    pointName,
    siteName: "PHBoffice",
    pointRole: "zone_temp",
    unit,
    risk: "ok",
    lastReadingAt: "2026-09-29T11:55:00.000Z",
    minutesAgo: 5,
    rollHorizonHours: 41.7,
    horizonSource: "configured",
    horizon: { state: "configured", hours: 41.7, currentHours: null, stationCount: 500, capacity: 500 },
    completeness: "complete",
    stationCount: 500,
    heldCount: 500,
    visible: true,
  });

  it("shows the symbol in the unit column, and a dash for none", () => {
    const html = renderToStaticMarkup(
      createElement(PointTable, {
        points: [
          row("1", "points_RoomT", "fahrenheit"),
          row("2", "Damper", "percent"),
          row("3", "Static", "inches of water"),
          row("4", "Temp1", null),
        ],
        siteName: null,
      }),
    );
    expect(html).toContain(">°F<");
    expect(html).toContain(">%<");
    expect(html).toContain(">inWC<");
    expect(html).toContain(">—<");
    expect(html).not.toContain("fahrenheit");
    expect(html).not.toContain("inches of water");
  });
});
