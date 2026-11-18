import { describe, expect, it } from "vitest";
import type { RawSchedule } from "@/lib/modules/freeze-protection/import/analyze";
import { mergeSchedules } from "@/lib/modules/freeze-protection/import/merge";
import type { CoilType } from "@/lib/modules/freeze-protection/types";
import { selectForImport } from "@/lib/modules/freeze-protection/import/select";
import { MARK, firstCell, layoutText, splitPage } from "@/lib/modules/freeze-protection/import/split";
import { FLAG_FROM_LIST, FLAG_NOT_FOUND, type PdfItem, type ScheduleBlock } from "@/lib/modules/freeze-protection/import/types";
import { checkSchedule } from "@/lib/modules/freeze-protection/import/validate";

/**
 * The deterministic half of the schedule import: splitting a sheet into
 * schedules, and checking the model's answer. No model, no PDF: items are
 * built by hand in reading coordinates (x right, y down, y at the baseline).
 */

const body = (x: number, y: number, s: string): PdfItem => ({ x, y, w: s.length * 5, h: 10, s });
const title = (x: number, y: number, s: string): PdfItem => ({ x, y, w: s.length * 10, h: 18, s });

/** A small table: a title, a header line, and one row per mark. */
function table(x: number, y: number, name: string, marks: string[]): PdfItem[] {
  return [
    title(x, y, name),
    body(x, y + 25, "MARK"),
    body(x + 80, y + 25, "AREA SERVED"),
    ...marks.flatMap((m, i) => [body(x, y + 40 + i * 15, m), body(x + 80, y + 40 + i * 15, `ROOM ${i + 1}`)]),
  ];
}

describe("splitting a sheet into schedules", () => {
  it("cuts side-by-side and stacked tables apart and keeps each table's rows", () => {
    const items = [
      ...table(100, 100, "FAN COIL UNIT SCHEDULE", ["FCU-1", "FCU-2", "FCU-3"]),
      ...table(1200, 100, "PUMP SCHEDULE", ["P-1", "P-2"]),
      ...table(100, 600, "HOT WATER FINNED TUBE SCHEDULE", ["FTR-1"]),
      // the title block on the right edge: large text, never a schedule
      title(2800, 1900, "MECHANICAL"),
      title(2800, 1930, "SCHEDULES"),
      body(2800, 2000, "M-701-R"),
    ];
    const blocks = splitPage({ page: 1, width: 3024, height: 2160, items: Array(40).fill(body(5000, 5000, "x")).concat(items) });
    expect(blocks.map((b) => b.title)).toEqual([
      "FAN COIL UNIT SCHEDULE",
      "PUMP SCHEDULE",
      "HOT WATER FINNED TUBE SCHEDULE",
    ]);
    expect(blocks.map((b) => b.marks)).toEqual([3, 2, 1]);
    expect(blocks[0]!.text).toContain("FCU-3");
    expect(blocks[0]!.text).not.toContain("P-1");
    expect(blocks.every((b) => b.sheet === "M-701-R")).toBe(true);
  });

  it("joins a table split by a wide column gap back to its title", () => {
    const items = [
      ...table(400, 100, "FAN POWERED BOX SCHEDULE", ["FPB-1", "FPB-2"]),
      // a far right column, same rows, more than a few characters away
      body(620, 140, "HW"),
      body(620, 155, "HW"),
    ];
    const [block] = splitPage({ page: 1, width: 3024, height: 2160, items });
    expect(block!.text.split("\n").find((l) => l.includes("FPB-1"))).toMatch(/FPB-1.*ROOM 1.*HW/);
  });

  it("keeps columns in place in the layout text", () => {
    const lines = layoutText([body(0, 10, "A"), body(100, 10, "B"), body(100, 25, "C")], 10);
    expect(lines[0]!.indexOf("B")).toBe(lines[1]!.indexOf("C"));
  });

  it("recognises marks, including one split by a stray space", () => {
    for (const m of ["AHU-1", "DS-AHU-R1A", "FPB-2-03", "EF1", "SAV-DS2-907.3"]) expect(MARK.test(m), m).toBe(true);
    for (const m of ["MARK", "NOTES:", "1.", "0-1850", "(60Hz)"]) expect(MARK.test(m), m).toBe(false);
    expect(firstCell("  SAV-DS 1-920.1   RECEPTION")).toBe("SAV-DS1-920.1");
  });
});

const block: ScheduleBlock = {
  key: "p1-1",
  page: 1,
  sheet: "M-703-R",
  title: "FAN COIL UNIT SCHEDULE",
  part: null,
  text: "MARK  AREA\nFCU-DS 1-939  TELECOM\nFCU-2  LOBBY\nFCU-3  ELEC\nDS-ASHP-R1,R2  ROOF",
  marks: 4,
};

const row = (name: string, extra: Partial<RawSchedule["rows"][number]> = {}): RawSchedule["rows"][number] => ({
  name,
  from_list: false,
  equipment_type: null,
  area_served: null,
  coil: "water",
  exposure: "unclear",
  exposure_evidence: null,
  ...extra,
});

describe("checking the model's answer", () => {
  it("flags names not in the text, keeps list expansions, drops duplicates and warns on a short count", () => {
    const out = checkSchedule(block, {
      is_equipment: true,
      reason: "Fan coil units.",
      equipment_type: "Fan coil unit",
      rows: [
        row("FCU-DS1-939", { exposure: "unlikely", exposure_evidence: "No OA" }),
        row("FCU-2"),
        row("FCU-2"),
        row("FCU-99"),
        row("DS-ASHP-R2", { from_list: true }),
        row("   "),
      ],
    });
    expect(out.rows.map((r) => [r.name, r.flags])).toEqual([
      ["FCU-DS1-939", []],
      ["FCU-2", []],
      ["FCU-99", [FLAG_NOT_FOUND]],
      ["DS-ASHP-R2", [FLAG_FROM_LIST]],
    ]);
    expect(out.rows[0]!.equipmentType).toBe("Fan coil unit");
    expect(out.rows[0]!.exposureSuggestion).toBe("unlikely");
    expect(out.rows[1]!.exposureSuggestion).toBeNull();
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/row without a usable name/);
  });

  it("warns when fewer units come back than the schedule has marked rows", () => {
    const out = checkSchedule(block, { is_equipment: true, reason: "", equipment_type: null, rows: [row("FCU-2")] });
    expect(out.warnings.join(" ")).toMatch(/Found 1 unit, but the schedule has at least 4/);
  });
});

describe("merging units across schedules", () => {
  const sched = (key: string, isEquipment: boolean, rows: ReturnType<typeof checkSchedule>["rows"]) => ({
    key, page: 1, sheet: "M-701-R", title: key, part: null, isEquipment, reason: "", rows, warnings: [],
  });
  const r = (name: string, coil: "none" | "water" | "glycol" | "steam", extra = {}) => ({
    name, equipmentType: null, areaServed: null, coil, exposureSuggestion: null, exposureEvidence: null, flags: [], ...extra,
  });

  it("keeps one unit per name with the riskiest coil and the strongest exposure", () => {
    const merged = mergeSchedules([
      sched("PART A", true, [r("AHU-1", "none", { areaServed: "LABS", exposureSuggestion: "likely", exposureEvidence: "OA 29,250 cfm" })]),
      sched("PART B", true, [r("AHU-1", "glycol"), r("AHU-2", "none")]),
      sched("PART C", true, [r("AHU-1", "water", { exposureSuggestion: "unlikely" })]),
      sched("GRILLES", false, [r("WS1", "none")]),
    ]);
    expect(merged).toHaveLength(3);
    const ahu = merged[0]!;
    expect(ahu).toMatchObject({ name: "AHU-1", coil: "water", areaServed: "LABS", exposureSuggestion: "likely", include: true });
    expect(ahu.sources).toHaveLength(3);
    expect(merged[1]).toMatchObject({ name: "AHU-2", exposureSuggestion: null, include: true });
    expect(merged[2]).toMatchObject({ name: "WS1", include: false });
  });

  it("starts a not-found name unticked, unless another schedule found it", () => {
    const merged = mergeSchedules([
      sched("A", true, [r("FCU-9", "water", { flags: [FLAG_NOT_FOUND] }), r("FCU-8", "water", { flags: [FLAG_NOT_FOUND] })]),
      sched("B", true, [r("FCU-9", "water")]),
    ]);
    expect(merged.find((c) => c.name === "FCU-9")).toMatchObject({ include: true, flags: [] });
    expect(merged.find((c) => c.name === "FCU-8")).toMatchObject({ include: false });
  });
});

describe("choosing what an import adds, with no review step", () => {
  const sched = (title: string, isEquipment: boolean, names: string[], flags: string[] = []) => ({
    key: title, page: 1, sheet: "M-701-R", title, part: null, isEquipment, reason: "", warnings: [],
    rows: names.map((name) => ({ name, equipmentType: "Fan", areaServed: " Roof ", coil: "water" as const, exposureSuggestion: null, exposureEvidence: "stray", flags })),
  });

  it("adds equipment with a coil found in the PDF, and counts what it leaves out", () => {
    const fans = sched("EXHAUST FAN SCHEDULE", true, ["EXF-1"]);
    const noCoil = { ...fans, rows: fans.rows.map((r) => ({ ...r, coil: "none" as CoilType })) };
    const fcus = sched("FAN COIL UNIT SCHEDULE", true, ["FCU-1"]);
    const recirculating = { ...fcus, rows: fcus.rows.map((r) => ({ ...r, exposureSuggestion: "unlikely" as const })) };
    const candidates = mergeSchedules([
      noCoil,
      recirculating,
      sched("FAN SCHEDULE", true, ["EF-1", "EF-2"]),
      sched("FAN SCHEDULE 2", true, ["EF-9"], [FLAG_NOT_FOUND]),
      sched("GRILLE SCHEDULE", false, ["WS1", "LD1"]),
    ]);
    const out = selectForImport(candidates, ["ef-2"]);
    expect(out.rows).toEqual([
      { name: "EF-1", equipmentType: "Fan", areaServed: "Roof", coil: "water", exposureSuggestion: null, exposureEvidence: null, source: "M-701-R · FAN SCHEDULE" },
    ]);
    expect(out).toMatchObject({ notEquipment: 2, noCoil: 1, notExposed: 1, existing: ["EF-2"], notFound: ["EF-9"] });
  });
});
