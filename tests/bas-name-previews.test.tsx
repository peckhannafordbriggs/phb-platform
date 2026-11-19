// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PrefixPreview,
  SuggestionsPreview,
  initialPrefixDrafts,
  type PrefixDraft,
} from "@/app/(modules)/bas/settings-points-names";
import type { NamePrefixGroup } from "@/lib/modules/bas/name-prefix";
import type { SettingsEquipment, SettingsPoint } from "@/lib/modules/bas/types";

/**
 * The two previews (2026-11-19) render what they will do, in words, and
 * Confirm is off until the preview can be applied. Nothing here writes: the
 * previews hand the parent a selection and the parent sends it.
 */

const group = (key: string, name: string, over: Partial<NamePrefixGroup> = {}): NamePrefixGroup => ({
  key,
  name,
  spellings: [name],
  equipType: "vav",
  typeReason: "V followed by a number is a VAV box (the CEI convention, V4_22).",
  ioModule: false,
  existing: null,
  pointIds: ["1", "2"],
  sampleNames: ["V4_22/DaTemp", "V4_22/SpaceTemp"],
  ...over,
});

const TYPES = [
  { equipType: "vav", displayName: "VAV Box", category: "terminal" },
  { equipType: "ahu", displayName: "Air Handling Unit", category: "air_side" },
];

const point = (pointId: string, name: string, equipmentName: string | null = null) =>
  ({
    pointId,
    label: null,
    niagaraHistoryName: name,
    niagaraDisplayName: name,
    suggestion: {
      role: "zone_temp",
      roleName: "Zone Temperature",
      equipmentName,
      equipmentId: null,
      equipType: equipmentName === null ? null : "vav",
      pattern: "tail_zone_temp",
      confidence: "The suffix is a zone or space temperature token.",
      level: "high",
    },
  }) as unknown as SettingsPoint;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(element: ReturnType<typeof createElement>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(element));
  return host;
}

describe("the equipment preview", () => {
  it("shows prefix, editable name, type, points and the reason, and says what Confirm will do", () => {
    const drafts = initialPrefixDrafts([
      group("V4-22", "V4_22"),
      group("AHU7", "AHU_7", { spellings: ["AHU_7", "AHU-7"], equipType: "ahu", pointIds: ["3", "4", "5"] }),
      group("XTM109", "XTM_109", { equipType: null, ioModule: true, typeReason: "XTM is a Johnson Controls expansion I/O module", pointIds: ["6"] }),
    ]);
    const html = renderToStaticMarkup(
      createElement(PrefixPreview, {
        drafts,
        onDraftsChange: () => {},
        equipment: [],
        equipmentTypes: TYPES,
        onConfirm: () => {},
        onCancel: () => {},
        busy: false,
      }),
    );
    expect(html).toContain("AHU_7 · AHU-7");
    expect(html).toContain("2 spellings of one unit");
    expect(html).toContain("XTM is a Johnson Controls expansion I/O module");
    expect(html).toContain("V4_22/DaTemp, V4_22/SpaceTemp");
    // Two ticked rows, five points; the module is unticked.
    expect(html).toContain("Create 2 pieces of equipment");
    expect(html).toContain("attach 5");
    expect(html).toContain("Choose a type…");
  });

  it("names a row that will attach to existing equipment, and keeps Confirm off while a row has a problem", () => {
    const onConfirm = vi.fn();
    let drafts: PrefixDraft[] = initialPrefixDrafts([group("V4-22", "V4_22"), group("P", "Points", { equipType: null })]);
    drafts = drafts.map((d, i) => (i === 1 ? { ...d, include: true } : d));
    const existing: SettingsEquipment = {
      equipmentId: "9", siteId: "1", name: "V4-22", equipType: "vav", equipTypeName: "VAV Box",
      parentEquipmentId: null, parentName: null, notes: null, pointCount: 0,
    };
    const node = mount(
      createElement(PrefixPreview, {
        drafts,
        onDraftsChange: () => {},
        equipment: [existing],
        equipmentTypes: TYPES,
        onConfirm,
        onCancel: () => {},
        busy: false,
      }),
    );
    expect(node.textContent).toContain("Already exists: the points attach to V4-22.");
    expect(node.textContent).toContain("Choose a type.");
    expect(node.textContent).toContain("Fix 1 row first.");
    const confirm = [...node.querySelectorAll("button")].find((b) => b.textContent === "Confirm")!;
    expect(confirm.disabled).toBe(true);
    act(() => confirm.click());
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("the suggestions preview", () => {
  it("lists every high-confidence row with a box, names the equipment it will create, and confirms the ticked count", () => {
    const onConfirm = vi.fn();
    const onSelectionChange = vi.fn();
    const points = [point("1", "V4_22/SpaceTemp"), point("2", "VAV_10_ZoneTemperature", "VAV_10")];
    const node = mount(
      createElement(SuggestionsPreview, {
        points,
        selected: new Set(["1", "2"]),
        onSelectionChange,
        onConfirm,
        onCancel: () => {},
        busy: false,
      }),
    );
    expect(node.textContent).toContain("2 high-confidence suggestions on this station");
    expect(node.textContent).toContain("Zone Temperature · VAV_10 (new)");
    expect(node.textContent).toContain("creating 1 piece of equipment (VAV_10)");
    const boxes = node.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    act(() => (boxes[0] as HTMLInputElement).click());
    expect([...(onSelectionChange.mock.calls[0]![0] as Set<string>)]).toEqual(["2"]);
    const apply = [...node.querySelectorAll("button")].find((b) => b.textContent === "Apply 2")!;
    act(() => apply.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
