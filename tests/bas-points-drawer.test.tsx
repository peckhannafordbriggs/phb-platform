// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { PointsTable, pointMatchesQuery } from "@/app/(modules)/bas/settings-points";
import { notCheckedPlausibility } from "@/lib/modules/bas/plausibility";
import type {
  BasVocabularies,
  SettingsEquipment,
  SettingsPoint,
  StationPointsList,
} from "@/lib/modules/bas/types";

/**
 * The Points drawer (2026-11-10): renaming a point is discoverable from its
 * row, and the drawer saves through the four single-field requests the row
 * already used - nothing new on the server.
 *
 * What is held here:
 *   1. A read-only render has no pencil; a render with the handlers has one
 *      per row, named for the point, and an unlabelled row says "Add label".
 *   2. The pencil opens the drawer with the point's values filled in and the
 *      Niagara name shown read-only.
 *   3. Save calls exactly the handlers whose field changed - label, role,
 *      visibility here - and not the equipment one, then closes.
 *   4. Cancel and Escape close it with nothing called.
 *   5. The search over the list reaches the role and the equipment.
 */

const KEY = "VAV$2d8$20104$2d105_ZoneTemperature";
const NIAGARA = "VAV-8 104-105_ZoneTemperature";

const point = (over: Partial<SettingsPoint> = {}): SettingsPoint => ({
  pointId: "7",
  label: null,
  niagaraHistoryName: KEY,
  niagaraDisplayName: NIAGARA,
  pointRole: null,
  roleName: null,
  equipmentId: null,
  equipmentName: null,
  unit: "fahrenheit",
  suggestion: null,
  horizon: { state: "unknown", hours: null, currentHours: null, stationCount: null, capacity: null },
  collected: true,
  inactiveReason: null,
  completeness: "complete",
  lastRecordAt: null,
  visible: true,
  plausibility: notCheckedPlausibility("no_role"),
  ...over,
});

const labelled = point({
  pointId: "8",
  label: "Supply Air",
  niagaraHistoryName: "AHU$2d1_SupplyAirTemp",
  niagaraDisplayName: "AHU-1_SupplyAirTemp",
  pointRole: "supply_air_temp",
  roleName: "Supply air temperature",
  equipmentId: "5",
  equipmentName: "RTU-1",
});

const list = (points: SettingsPoint[]): StationPointsList => ({
  stationId: "1",
  siteId: "1",
  points,
  pointsAccountedFor: { rendered: points.length, inDatabase: points.length },
});

const role = (pointRole: string, displayName: string, flags: Partial<BasVocabularies["roles"][number]> = {}) => ({
  pointRole,
  displayName,
  description: "",
  measurement: "temperature",
  typicalUnit: "fahrenheit",
  isSetpoint: false,
  isCommand: false,
  isStatus: false,
  setpointFor: null,
  statusOf: null,
  ...flags,
});

const vocabularies: BasVocabularies = {
  roles: [role("zone_temp", "Zone temperature"), role("supply_air_temp", "Supply air temperature")],
  equipmentTypes: [{ equipType: "rtu", displayName: "Rooftop unit", category: "air_handling" }],
};

const equipment: SettingsEquipment[] = [
  {
    equipmentId: "5",
    siteId: "1",
    name: "RTU-1",
    equipType: "rtu",
    equipTypeName: "Rooftop unit",
    parentEquipmentId: null,
    parentName: null,
    notes: null,
    pointCount: 3,
  },
];

// ------------------------------------------------------------------ render

const roots: Array<{ root: Root; host: HTMLDivElement }> = [];

function handlers() {
  return {
    onSaveLabel: vi.fn(async () => undefined),
    onSetRole: vi.fn(async () => undefined),
    onSetEquipment: vi.fn(async () => undefined),
    onToggleVisible: vi.fn(),
  };
}

async function render(points: SettingsPoint[], h = handlers()) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push({ root, host });
  await act(async () => {
    root.render(
      createElement(PointsTable, {
        list: list(points),
        expectedTotal: points.length,
        vocabularies,
        equipment,
        ...h,
      }),
    );
  });
  return { host, h };
}

afterEach(async () => {
  for (const { root, host } of roots.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
});

const drawer = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-testid="bas-point-drawer"]');

async function click(el: Element | null) {
  if (el === null) throw new Error("nothing to click");
  await act(async () => {
    (el as HTMLElement).click();
  });
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

// ------------------------------------------------------------------ tests

describe("the pencil on a row", () => {
  it("is absent from a read-only render, and present, named for the point, with the handlers", () => {
    const readOnly = renderToStaticMarkup(createElement(PointsTable, { list: list([point()]), expectedTotal: 1 }));
    expect(readOnly).not.toContain("Edit the label for");
    expect(readOnly).toContain(NIAGARA);

    const editable = renderToStaticMarkup(
      createElement(PointsTable, { list: list([point(), labelled]), expectedTotal: 2, onSaveLabel: async () => undefined }),
    );
    expect(editable).toContain(`aria-label="Edit the label for ${NIAGARA}"`);
    expect(editable).toContain('aria-label="Edit the label for Supply Air"');
    // The unlabelled row says so; the labelled one does not.
    expect(editable.match(/Add label/g)).toHaveLength(1);
    expect(editable).not.toContain('data-testid="bas-point-drawer"');
  });
});

describe("the drawer", () => {
  it("opens from the pencil with the point's values, and the Niagara name read-only", async () => {
    const { host } = await render([labelled]);
    expect(drawer(host)).toBeNull();

    await click(host.querySelector('button[aria-label="Edit the label for Supply Air"]'));
    const open = drawer(host);
    expect(open).not.toBeNull();
    expect(open!.getAttribute("role")).toBe("dialog");
    expect(open!.querySelector<HTMLInputElement>('input[aria-label="Label for AHU$2d1_SupplyAirTemp"]')!.value).toBe("Supply Air");
    expect(open!.querySelector<HTMLSelectElement>('select[aria-label="Role for Supply Air"]')!.value).toBe("supply_air_temp");
    expect(open!.querySelector<HTMLSelectElement>('select[aria-label="Equipment for Supply Air"]')!.value).toBe("5");
    expect(open!.textContent).toContain("Niagara name: AHU$2d1_SupplyAirTemp");
    expect(open!.textContent).toContain("cannot change");
    expect(open!.querySelector("input[value='AHU$2d1_SupplyAirTemp']")).toBeNull();
    // Nothing changed yet, so there is nothing to save.
    const save = [...open!.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
    expect(save.disabled).toBe(true);
  });

  it("saves only the fields that changed, through the row's own handlers, then closes", async () => {
    const { host, h } = await render([point()]);
    await click(host.querySelector(`button[aria-label="Edit the label for ${NIAGARA}"]`));
    const open = drawer(host)!;

    await type(open.querySelector<HTMLInputElement>(`input[aria-label="Label for ${KEY}"]`)!, "Zone Temp 104-105");
    await choose(open.querySelector<HTMLSelectElement>(`select[aria-label="Role for ${NIAGARA}"]`)!, "zone_temp");
    const [, hidden] = open.querySelectorAll('[aria-label="Shown on the browsing screens"] button');
    await click(hidden!);

    await click([...open.querySelectorAll("button")].find((b) => b.textContent === "Save")!);

    expect(h.onSaveLabel).toHaveBeenCalledTimes(1);
    expect(h.onSaveLabel.mock.calls[0]![1]).toBe("Zone Temp 104-105");
    expect(h.onSetRole).toHaveBeenCalledTimes(1);
    expect(h.onSetRole.mock.calls[0]![1]).toBe("zone_temp");
    expect(h.onToggleVisible).toHaveBeenCalledTimes(1);
    expect(h.onToggleVisible.mock.calls[0]![1]).toBe(false);
    expect(h.onSetEquipment).not.toHaveBeenCalled();
    expect(drawer(host)).toBeNull();
  });

  it("clears a label with a blank, and saves a label alone", async () => {
    const { host, h } = await render([labelled]);
    await click(host.querySelector('button[aria-label="Edit the label for Supply Air"]'));
    await type(drawer(host)!.querySelector<HTMLInputElement>('input[aria-label="Label for AHU$2d1_SupplyAirTemp"]')!, "   ");
    await click([...drawer(host)!.querySelectorAll("button")].find((b) => b.textContent === "Save")!);

    expect(h.onSaveLabel).toHaveBeenCalledTimes(1);
    expect(h.onSaveLabel.mock.calls[0]![1]).toBeNull();
    expect(h.onSetRole).not.toHaveBeenCalled();
    expect(h.onSetEquipment).not.toHaveBeenCalled();
    expect(h.onToggleVisible).not.toHaveBeenCalled();
  });

  it("stays open and says so when the label save fails", async () => {
    const h = handlers();
    h.onSaveLabel = vi.fn(async () => {
      throw new Error("refused");
    });
    const { host } = await render([point()], h);
    await click(host.querySelector(`button[aria-label="Edit the label for ${NIAGARA}"]`));
    await type(drawer(host)!.querySelector<HTMLInputElement>(`input[aria-label="Label for ${KEY}"]`)!, "x");
    await click([...drawer(host)!.querySelectorAll("button")].find((b) => b.textContent === "Save")!);

    expect(drawer(host)).not.toBeNull();
    expect(drawer(host)!.querySelector('[role="alert"]')!.textContent).toContain("Could not save that change");
  });

  it("closes on Cancel and on Escape with nothing called", async () => {
    const { host, h } = await render([point()]);
    const pencil = `button[aria-label="Edit the label for ${NIAGARA}"]`;

    await click(host.querySelector(pencil));
    await type(drawer(host)!.querySelector<HTMLInputElement>(`input[aria-label="Label for ${KEY}"]`)!, "changed");
    await click([...drawer(host)!.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!);
    expect(drawer(host)).toBeNull();

    await click(host.querySelector(pencil));
    await act(async () => {
      drawer(host)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(drawer(host)).toBeNull();

    expect(h.onSaveLabel).not.toHaveBeenCalled();
    expect(h.onSetRole).not.toHaveBeenCalled();
    expect(h.onSetEquipment).not.toHaveBeenCalled();
    expect(h.onToggleVisible).not.toHaveBeenCalled();
  });
});

describe("the search over the Points list", () => {
  it("matches the role's name, the role key and the equipment, as well as the three names", () => {
    expect(pointMatchesQuery(labelled, "supply air temperature")).toBe(true);
    expect(pointMatchesQuery(labelled, "supply_air_temp")).toBe(true);
    expect(pointMatchesQuery(labelled, "rtu-1")).toBe(true);
    expect(pointMatchesQuery(labelled, "Supply Air")).toBe(true);
    expect(pointMatchesQuery(labelled, "AHU$2d1")).toBe(true);
    expect(pointMatchesQuery(point(), "rtu")).toBe(false);
    expect(pointMatchesQuery(point(), "")).toBe(true);
    expect(pointMatchesQuery(point(), "   ")).toBe(true);
  });

  it("narrows the rendered table by equipment, with the count, and says what it searched", () => {
    const html = renderToStaticMarkup(
      createElement(PointsTable, { list: list([point(), labelled]), expectedTotal: 2, query: "RTU-1" }),
    );
    expect(html).toContain("1 of 2 points match");
    expect(html).toContain("AHU$2d1_SupplyAirTemp");
    expect(html).not.toContain(KEY);

    const nothing = renderToStaticMarkup(
      createElement(PointsTable, { list: list([point(), labelled]), expectedTotal: 2, query: "boiler" }),
    );
    expect(nothing).toContain("by label, station name, Niagara name, role or equipment");
    expect(nothing).toContain("Clear the search to see all 2");
  });
});
