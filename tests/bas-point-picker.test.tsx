// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("next/navigation", () => ({
  usePathname: () => "/bas/points",
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
}));

import {
  AddPointPanel,
  EquipmentSelect,
  PointList,
  UNCLASSIFIED,
  UNCLASSIFIED_LABEL,
  equipmentOptions,
  filterPointGroups,
  matchesQuery,
  pruneEquipment,
} from "@/app/(modules)/bas/point-picker";
import { chartSlots, readFilters, withLines } from "@/app/(modules)/bas/filters";
import { MultiSelect } from "@/components/ui";
import {
  LINE_STYLES,
  MAX_CHART_LINES,
  addRefusal,
  addSlot,
  assignAxes,
  describeThirdAxis,
  lineShare,
  removeSlot,
  slotIds,
  type LineIdentity,
} from "@/lib/modules/bas/chart-lines";
import type { PointExplorer, PointOption } from "@/lib/modules/bas/types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Point Explorer's picker and its lines (2026-11-20): the Equipment
 * multi-select and the grouped Point list, "Tick several" and "Add point",
 * the URL that carries up to six lines, and the rules for which axis a line
 * takes and which colour it keeps.
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

/** Types into a React-controlled input the way a person does. */
async function type(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const click = (el: Element | null) =>
  act(async () => {
    if (el === null) throw new Error("nothing to click");
    (el as HTMLElement).click();
  });

let nextId = 1;
const pt = (name: string, over: Partial<PointOption> = {}): PointOption => ({
  pointId: String(nextId++),
  pointName: name,
  pointRole: null,
  unit: "fahrenheit",
  siteName: "CEI",
  valueKind: "numeric",
  states: null,
  stationId: "9",
  stationName: "CEI_JCI_N2",
  equipmentId: null,
  equipmentName: null,
  equipmentType: null,
  ...over,
});
const on = (id: string, name: string, type: string | null) => ({ equipmentId: id, equipmentName: name, equipmentType: type });

// A station shaped like CEI_JCI_N2, small enough to read.
const SPACE = pt("V4_22/SpaceTemp", { pointRole: "zone_temp", ...on("22", "V4_22", "VAV Box") });
const SETPOINT = pt("V4_22/SpaceTempSp", { pointRole: "zone_temp_sp", ...on("22", "V4_22", "VAV Box") });
const DAMPER = pt("V4_22/DamperPos", { pointRole: "damper_position", unit: "percent", ...on("22", "V4_22", "VAV Box") });
const SPACE9 = pt("V4_9/SpaceTemp", { pointRole: "zone_temp", ...on("9", "V4_9", "VAV Box") });
const DA_T = pt("AHU_7/DA_T", { pointRole: "discharge_air_temp", ...on("7", "AHU_7", "Air Handling Unit") });
const FAN = pt("AHU_7/SF_S", {
  pointRole: "supply_fan_status",
  unit: null,
  valueKind: "boolean",
  states: { on: "On", off: "Off" },
  ...on("7", "AHU_7", "Air Handling Unit"),
});
const OAT = pt("OAT", { pointRole: "outside_air_temp" });
const ENTHALPY = pt("OA_Enthalpy", { unit: "btu per pound" });
const POINTS = [SPACE, SETPOINT, DAMPER, SPACE9, DA_T, FAN, OAT, ENTHALPY];

const identity = (p: PointOption): LineIdentity => ({ pointId: p.pointId, valueKind: p.valueKind, unit: p.unit, states: p.states });

// ------------------------------------------------------------ filtering

describe("the Equipment options", () => {
  it("lists the station's equipment by name as a person counts, with its type and point count, then Unclassified", () => {
    expect(equipmentOptions(POINTS).map((o) => [o.name, o.type, o.count])).toEqual([
      ["AHU_7", "Air Handling Unit", 2],
      ["V4_9", "VAV Box", 1],
      ["V4_22", "VAV Box", 3],
      [UNCLASSIFIED_LABEL, null, 2],
    ]);
    expect(equipmentOptions(POINTS).at(-1)!.value).toBe(UNCLASSIFIED);
  });

  it("offers no Unclassified entry when every point is on equipment", () => {
    expect(equipmentOptions([SPACE, DA_T]).some((o) => o.value === UNCLASSIFIED)).toBe(false);
  });

  it("names the building beside each equipment only when the list spans buildings", () => {
    const other = pt("AHU-1/SAT", { siteName: "Kenwood", ...on("50", "AHU-1", "Air Handling Unit") });
    expect(equipmentOptions([SPACE, other]).map((o) => o.siteName)).toEqual(["Kenwood", "CEI"]);
    expect(equipmentOptions([SPACE]).map((o) => o.siteName)).toEqual([null]);
  });
});

describe("the Point list's filter", () => {
  const names = (groups: ReturnType<typeof filterPointGroups>) =>
    groups.map((g) => [g.name, g.points.map((p) => p.pointName)]);

  it("shows every point, grouped by equipment, when no equipment is chosen", () => {
    expect(names(filterPointGroups(POINTS, { equipment: [], query: "" }))).toEqual([
      ["AHU_7", ["AHU_7/DA_T", "AHU_7/SF_S"]],
      ["V4_9", ["V4_9/SpaceTemp"]],
      ["V4_22", ["V4_22/DamperPos", "V4_22/SpaceTemp", "V4_22/SpaceTempSp"]],
      [UNCLASSIFIED_LABEL, ["OA_Enthalpy", "OAT"]],
    ]);
  });

  it("shows only the chosen equipment's points", () => {
    expect(names(filterPointGroups(POINTS, { equipment: ["22", "7"], query: "" }))).toEqual([
      ["AHU_7", ["AHU_7/DA_T", "AHU_7/SF_S"]],
      ["V4_22", ["V4_22/DamperPos", "V4_22/SpaceTemp", "V4_22/SpaceTempSp"]],
    ]);
  });

  it("shows the points on no equipment under Unclassified", () => {
    expect(names(filterPointGroups(POINTS, { equipment: [UNCLASSIFIED], query: "" }))).toEqual([
      [UNCLASSIFIED_LABEL, ["OA_Enthalpy", "OAT"]],
    ]);
  });

  it("searches any part of the name or the role, every word, inside the chosen equipment", () => {
    expect(names(filterPointGroups(POINTS, { equipment: [], query: "spacetemp" }))).toEqual([
      ["V4_9", ["V4_9/SpaceTemp"]],
      ["V4_22", ["V4_22/SpaceTemp", "V4_22/SpaceTempSp"]],
    ]);
    // By role: no point is called "zone_temp", two have the role.
    expect(names(filterPointGroups(POINTS, { equipment: [], query: "zone_temp " })).flatMap(([, p]) => p)).toEqual([
      "V4_9/SpaceTemp",
      "V4_22/SpaceTemp",
      "V4_22/SpaceTempSp",
    ]);
    expect(names(filterPointGroups(POINTS, { equipment: ["22"], query: "v4 tempsp" }))).toEqual([["V4_22", ["V4_22/SpaceTempSp"]]]);
    expect(filterPointGroups(POINTS, { equipment: ["9"], query: "damper" })).toEqual([]);
    expect(matchesQuery(FAN, "FAN STATUS")).toBe(true);
  });

  it("drops a chosen equipment the list no longer has, rather than filtering to nothing", () => {
    expect(pruneEquipment(["22", "999", UNCLASSIFIED], [SPACE, DA_T])).toEqual(["22"]);
  });
});

// --------------------------------------------------------- multi-select

function Harness({ initial = [] as string[] }) {
  const [value, setValue] = useState<string[]>(initial);
  return createElement("div", null, [
    createElement(MultiSelect, {
      key: "ms",
      label: "Equipment",
      placeholder: "All equipment",
      options: equipmentOptions(POINTS).map((o) => ({ value: o.value, label: o.name })),
      value,
      onChange: setValue,
      chipLimit: 3,
    }),
    createElement("output", { key: "out", "data-testid": "value" }, value.join("|")),
  ]);
}

describe("the Equipment multi-select", () => {
  const value = (host: HTMLElement) => host.querySelector('[data-testid="value"]')!.textContent;
  const chips = (host: HTMLElement) => [...host.querySelectorAll('[data-testid="multiselect-chip"]')].map((c) => c.textContent);
  const option = (host: HTMLElement, label: string) =>
    [...host.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes(label)) ?? null;

  it("opens on a click, ticks two, and shows a chip for each", async () => {
    const host = await mount(createElement(Harness));
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="Equipment"]')!;
    expect(toggle.textContent).toBe("All equipment");
    await click(toggle);
    expect(host.querySelector('[role="listbox"]')).not.toBeNull();
    await click(option(host, "V4_22"));
    await click(option(host, "AHU_7"));
    expect(value(host)).toBe("22|7");
    // Chips in the options' order, not the order ticked.
    expect(chips(host)).toEqual(["AHU_7", "V4_22"]);
    expect(toggle.textContent).toBe("2 selected");
    expect(option(host, "V4_22")!.getAttribute("aria-selected")).toBe("true");
  });

  it("selects all that the search shows, clears, and removes one by its chip", async () => {
    const host = await mount(createElement(Harness));
    await click(host.querySelector('button[aria-label="Equipment"]'));
    await type(host.querySelector<HTMLInputElement>('input[type="search"]')!, "v4");
    expect([...host.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(["V4_9", "V4_22"]);
    await click([...host.querySelectorAll("button")].find((b) => b.textContent === "Select all 2 shown")!);
    expect(value(host)).toBe("9|22");

    await type(host.querySelector<HTMLInputElement>('input[type="search"]')!, "");
    await click([...host.querySelectorAll("button")].find((b) => b.textContent === "Select all")!);
    expect(value(host).split("|").sort()).toEqual(["22", "7", "9", UNCLASSIFIED].sort());
    // Past the chip limit, the rest is one "+N more".
    expect(chips(host)).toHaveLength(3);
    expect(host.querySelector('[data-testid="multiselect-more"]')?.textContent).toBe("+1 more");

    await click(host.querySelector('button[aria-label="Remove V4_9"]'));
    expect(value(host).split("|").sort()).toEqual(["22", "7", UNCLASSIFIED].sort());
    await click([...host.querySelectorAll("button")].find((b) => b.textContent === "Clear")!);
    expect(value(host)).toBe("");
    expect(chips(host)).toEqual([]);
  });

  it("ticks with the keyboard and closes on Escape", async () => {
    const host = await mount(createElement(Harness));
    await click(host.querySelector('button[aria-label="Equipment"]'));
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    const key = (k: string) =>
      act(async () => {
        search.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
      });
    await key("ArrowDown");
    await key("Enter");
    expect(value(host)).toBe("9");
    await key("Escape");
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });

  it("closes on a click outside it", async () => {
    const host = await mount(createElement(Harness));
    await click(host.querySelector('button[aria-label="Equipment"]'));
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });

  it("is the Equipment control, with each equipment's type and point count beside it", async () => {
    const host = await mount(createElement(EquipmentSelect, { points: POINTS, value: [], onChange: () => {} }));
    await click(host.querySelector('button[aria-label="Equipment"]'));
    expect(option(host, "V4_22")!.textContent).toBe("V4_22VAV Box · 3 points");
    expect(option(host, UNCLASSIFIED_LABEL)!.textContent).toBe(`${UNCLASSIFIED_LABEL}2 points`);
  });
});

// ------------------------------------------------------------ the list

describe("the Point list", () => {
  const rows = (host: HTMLElement) => [...host.querySelectorAll('[data-testid="bas-point-option"]')].map((b) => b.querySelector("span")!.textContent);

  it("groups by equipment with the role beside each name, narrows by search, and opens one point", async () => {
    const onPick = vi.fn();
    const host = await mount(createElement(PointList, { points: POINTS, equipment: ["22"], onPick }));
    expect([...host.querySelectorAll('[data-testid="bas-point-group"] h3')].map((h) => h.textContent)).toEqual(["V4_22VAV Box · 3 points"]);
    expect(rows(host)).toEqual(["V4_22/DamperPos", "V4_22/SpaceTemp", "V4_22/SpaceTempSp"]);
    expect(host.querySelector(`[data-point="${SPACE.pointId}"]`)!.textContent).toContain("zone_temp");
    expect(host.querySelector('[data-testid="bas-point-list-count"]')?.textContent).toBe("3 of 8 points");

    await type(host.querySelector<HTMLInputElement>('input[type="search"]')!, "tempsp");
    expect(rows(host)).toEqual(["V4_22/SpaceTempSp"]);
    await click(host.querySelector(`[data-point="${SETPOINT.pointId}"]`));
    expect(onPick).toHaveBeenCalledWith(SETPOINT.pointId);
  });

  it("shows the whole list with the search box when no equipment is chosen", async () => {
    const host = await mount(createElement(PointList, { points: POINTS, equipment: [], onPick: () => {} }));
    expect(rows(host)).toHaveLength(8);
    expect(host.querySelector('[data-testid="bas-point-list-count"]')?.textContent).toBe("8 points");
    expect(host.querySelector('input[type="search"]')).not.toBeNull();
  });

  it("ticks several, starting from the lines already drawn, refuses a third axis, and plots them in the order ticked", async () => {
    const onPlot = vi.fn();
    const host = await mount(
      createElement(PointList, { points: POINTS, equipment: [], onPick: () => {}, plotted: [SPACE], onPlot }),
    );
    expect(host.querySelector('[data-testid="bas-tick-footer"]')).toBeNull();
    await click(host.querySelector('[data-testid="bas-tick-several"]'));
    const box = (p: PointOption) => host.querySelector<HTMLInputElement>(`input[aria-label="Tick ${p.pointName}"]`)!;
    expect(box(SPACE).checked).toBe(true);

    await click(box(DAMPER));
    await click(box(OAT));
    // °F on the left, % on the right: a state and a third unit need a third axis.
    expect(box(FAN).disabled).toBe(true);
    expect(box(FAN).closest("label")!.getAttribute("title")).toBe("Needs a third axis: the chart already has °F and %");
    expect(box(ENTHALPY).disabled).toBe(true);
    expect(box(SPACE9).disabled).toBe(false);

    expect([...host.querySelectorAll('[data-testid="bas-ticked-chip"]')].map((c) => c.textContent)).toEqual([
      "V4_22/SpaceTemp×",
      "V4_22/DamperPos×",
      "OAT×",
    ]);
    await click(host.querySelector('[data-testid="bas-plot-selected"]'));
    expect(onPlot).toHaveBeenCalledWith([SPACE.pointId, DAMPER.pointId, OAT.pointId]);
    expect(host.querySelector('[data-testid="bas-tick-footer"]')).toBeNull();
  });

  it("stops at six ticked", async () => {
    const many = Array.from({ length: 8 }, (_, i) => pt(`T${i + 1}`));
    const host = await mount(createElement(PointList, { points: many, equipment: [], onPick: () => {}, onPlot: () => {} }));
    await click(host.querySelector('[data-testid="bas-tick-several"]'));
    const boxes = [...host.querySelectorAll<HTMLInputElement>('[data-testid="bas-point-tick"]')];
    for (const b of boxes.slice(0, 6)) await click(b);
    expect(boxes.filter((b) => b.checked)).toHaveLength(MAX_CHART_LINES);
    expect(boxes[6]!.disabled).toBe(true);
    expect(host.querySelector('[data-testid="bas-plot-selected"]')?.textContent).toBe("Plot selected (6)");
  });
});

describe("Add point", () => {
  const start = (points: PointOption[]): Pick<PointExplorer, "projects" | "sites" | "stations" | "points" | "selectedProjectId" | "selectedSiteId" | "selectedStationId"> => ({
    projects: [
      { projectId: "1", name: "CEI", orgName: "PH+B" },
      { projectId: "2", name: "Kenwood", orgName: "PH+B" },
    ],
    sites: [],
    stations: [],
    points,
    selectedProjectId: "1",
    selectedSiteId: null,
    selectedStationId: null,
  });

  it("offers every point, greys out what is on the chart or needs a third axis, and adds one", async () => {
    const onAdd = vi.fn();
    const host = await mount(
      createElement(AddPointPanel, { start: start(POINTS), windowDays: 7, lines: [SPACE, DAMPER], onAdd, onClose: () => {}, load: vi.fn() }),
    );
    const row = (p: PointOption) => host.querySelector<HTMLButtonElement>(`[data-point="${p.pointId}"]`)!;
    expect(row(SPACE).disabled).toBe(true);
    expect(row(SPACE).textContent).toContain("Already on the chart");
    expect(row(FAN).disabled).toBe(true);
    expect(row(FAN).textContent).toContain("Needs a third axis");
    expect(host.textContent).toContain("2 of 6 on the chart");
    await click(row(OAT));
    expect(onAdd).toHaveBeenCalledWith(OAT.pointId);
  });

  it("reaches another project through its own cascade, with no point loaded, leaving the page's alone", async () => {
    const elsewhere = pt("KW/AHU-1/SAT", { siteName: "Kenwood", stationId: "30", stationName: "KW_JACE" });
    const load = vi.fn(async () => ({ ...start([elsewhere]), selectedProjectId: "2" }) as unknown as PointExplorer);
    const host = await mount(
      createElement(AddPointPanel, { start: start(POINTS), windowDays: 30, lines: [SPACE], onAdd: () => {}, onClose: () => {}, load }),
    );
    await click(host.querySelector('button[aria-label="Add point: Project"]'));
    await click([...host.querySelectorAll('[role="option"]')].find((o) => o.textContent === "Kenwood")!);
    expect(load).toHaveBeenCalledWith({ days: 30, pointId: "none", projectId: "2", siteId: null, stationId: null });
    expect(host.querySelector(`[data-point="${elsewhere.pointId}"]`)).not.toBeNull();
    expect(host.querySelector(`[data-point="${SPACE.pointId}"]`)).toBeNull();
  });
});

// ------------------------------------------------------------- the lines

describe("the axis rule", () => {
  it("puts the same quantity on the left, a second on the right, and refuses a third", () => {
    expect(assignAxes([SPACE, SETPOINT, DAMPER, OAT, FAN].map(identity))).toEqual(["left", "left", "right", "left", null]);
    // A number with no unit shares with nothing - not even another with no unit.
    const bare1 = pt("Temp1", { unit: null });
    const bare2 = pt("Temp2", { unit: null });
    expect(assignAxes([bare1, bare2, SPACE].map(identity))).toEqual(["left", "right", null]);
    // Two states with the same words share one axis.
    const fan2 = { ...FAN, pointId: "f2" };
    expect(assignAxes([SPACE, FAN, fan2].map(identity))).toEqual(["left", "right", "right"]);
  });

  it("says why a point cannot be added", () => {
    const lines = [SPACE, DAMPER].map(identity);
    expect(addRefusal(lines, identity(SPACE))).toBe("on_chart");
    expect(addRefusal(lines, identity(FAN))).toBe("third_axis");
    expect(addRefusal(lines, identity(OAT))).toBeNull();
    const six = Array.from({ length: 6 }, (_, i) => identity(pt(`F${i}`)));
    expect(addRefusal(six, identity(OAT))).toBe("full");
    expect(describeThirdAxis("AHU_7/SF_S", identity(FAN), lines)).toBe(
      "AHU_7/SF_S is not drawn: the chart already has two axes (°F and %) and it reads On / Off. Remove a line to make room for it.",
    );
  });

  it("shares the chart's draw budget between its lines", () => {
    expect(lineShare(10_000, 1)).toBe(10_000);
    expect(lineShare(10_000, 6)).toBe(1_666);
    expect(lineShare(3_000, 6)).toBe(500);
  });

  it("gives six lines six looks, every one past the second dashed, none red or maroon", () => {
    expect(LINE_STYLES).toHaveLength(MAX_CHART_LINES);
    expect(new Set(LINE_STYLES.map((s) => s.stroke)).size).toBe(6);
    expect(LINE_STYLES.slice(0, 2).every((s) => s.dash === undefined)).toBe(true);
    expect(new Set(LINE_STYLES.slice(2).map((s) => s.dash)).size).toBe(4);
    expect(LINE_STYLES.some((s) => /red|maroon/.test(s.stroke))).toBe(false);
  });
});

describe("the slots: a removed line leaves its colour behind, so the others keep theirs", () => {
  it("removes a middle line as a free slot, and a new line takes it", () => {
    const slots = ["1", "2", "3", "4"];
    const removed = removeSlot(slots, "2");
    expect(removed).toEqual(["1", null, "3", "4"]);
    expect(addSlot(removed, "9")).toEqual(["1", "9", "3", "4"]);
    // Trailing free slots carry nothing.
    expect(removeSlot(["1", "2", "3"], "3")).toEqual(["1", "2"]);
  });

  it("moves the next line into slot 0 when the first is removed - the tiles' line is always the accent", () => {
    expect(removeSlot(["1", null, "3", "4"], "1")).toEqual(["3", null, null, "4"]);
    expect(removeSlot(["1"], "1")).toEqual(["1"]);
  });

  it("adds nothing past six or twice", () => {
    const six = ["1", "2", "3", "4", "5", "6"];
    expect(addSlot(six, "7")).toEqual(six);
    expect(addSlot(["1", "2"], "2")).toEqual(["1", "2"]);
    expect(slotIds(["1", null, "3"])).toEqual(["1", "3"]);
  });
});

describe("the URL carries the whole set", () => {
  const roundTrip = (slots: Array<string | null>) => {
    const query = withLines(new URLSearchParams("project=2&days=30&view=table"), slots);
    const params = new URLSearchParams(query.slice(1));
    return { query, params, back: chartSlots(readFilters(params), null) };
  };

  it("round-trips one point as the URL it always was", () => {
    const { query, back } = roundTrip(["41"]);
    expect(query).toBe("?project=2&days=30&view=table&point=41");
    expect(back).toEqual(["41"]);
  });

  it("round-trips six points, in order", () => {
    const six = ["41", "42", "43", "44", "45", "46"];
    const { params, back } = roundTrip(six);
    expect(params.get("point")).toBe("41");
    expect(params.get("compare")).toBe("42,43,44,45,46");
    expect(back).toEqual(six);
  });

  it("round-trips a free slot, so a bookmark keeps every line's colour", () => {
    const { params, back } = roundTrip(["41", null, "43"]);
    expect(params.get("compare")).toBe(",43");
    expect(back).toEqual(["41", null, "43"]);
  });

  it("still reads a link from before: point alone, and compare with one id", () => {
    expect(chartSlots(readFilters(new URLSearchParams("point=41")), null)).toEqual(["41"]);
    expect(chartSlots(readFilters(new URLSearchParams("point=41&compare=44")), null)).toEqual(["41", "44"]);
    // No point in the URL: the one the server chose is slot 0.
    expect(chartSlots(readFilters(new URLSearchParams("")), "7")).toEqual(["7"]);
    expect(chartSlots(readFilters(new URLSearchParams("point=none&compare=44")), null)).toEqual([]);
  });

  it("reads a hand-edited compare tolerantly: junk and repeats are free slots, past five is dropped", () => {
    const filters = readFilters(new URLSearchParams("point=41&compare=41,abc,44,44,45,46,47,48"));
    expect(filters.compareSlots).toEqual([null, null, "44", null, "45"]);
  });

  it("removing every other line drops compare from the URL", () => {
    const { query } = roundTrip(["41", null, null]);
    expect(query).toBe("?project=2&days=30&view=table&point=41");
  });
});
