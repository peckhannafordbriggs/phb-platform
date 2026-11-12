import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BAS_EQUIPMENT_TYPES, BAS_POINT_ROLES } from "@/prisma/bas-vocabularies";
import { seedBasReportLibrary } from "@/prisma/bas-report-library";
import {
  BAS_LIBRARY_QUESTIONS,
  DEFAULT_MIN_COVERAGE,
  LIBRARY_SECTIONS,
  describeRequiredRoles,
  libraryEquipmentKeys,
  libraryRoleKeys,
  parseRoleRequirements,
} from "@/lib/modules/bas/reports/library";
import { PRESET_KEYS, REPORT_PRESETS } from "@/lib/modules/bas/reports/presets";
import { disconnectDb } from "./db";
import { inRollback } from "./bas-fixture";

/**
 * The shared library (Reports, Phase 1): the spec's twenty questions as data,
 * the two presets, and the three places the rows live - the
 * TypeScript list, the seed, and the migration's INSERT block.
 */

afterAll(async () => {
  await disconnectDb();
});

const MIGRATION = path.join(
  process.cwd(),
  "prisma/migrations/20261110120000_add_bas_reports/migration.sql",
);

describe("the twenty questions", () => {
  it("are twenty, keyed q01..q20, positioned 1..20, all computed, all with their function named", () => {
    expect(BAS_LIBRARY_QUESTIONS).toHaveLength(20);
    const sorted = [...BAS_LIBRARY_QUESTIONS].sort((a, b) => a.position - b.position);
    sorted.forEach((q, i) => {
      expect(q.position).toBe(i + 1);
      expect(q.key).toMatch(new RegExp(`^q${String(i + 1).padStart(2, "0")}_[a-z0-9_]+$`));
      expect(q.kind).toBe("computed");
      // The function IS the question: named now, implemented in Phase 2.
      expect(q.analysisFn).toBe(q.key);
      expect(q.text.trim().length).toBeGreaterThan(10);
      expect(q.appliesToLabel.length).toBeGreaterThan(0);
      expect(q.minCoverage).toBe(DEFAULT_MIN_COVERAGE);
    });
    expect(new Set(BAS_LIBRARY_QUESTIONS.map((q) => q.key)).size).toBe(20);
    expect(DEFAULT_MIN_COVERAGE).toBe(0.8);
  });

  it("name only role keys and equipment type keys the vocabulary declares", () => {
    const roles = new Set(BAS_POINT_ROLES.map((r) => r.pointRole));
    const types = new Set(BAS_EQUIPMENT_TYPES.map((t) => t.equipType));
    for (const key of libraryRoleKeys()) expect(roles, `role ${key}`).toContain(key);
    for (const key of libraryEquipmentKeys()) expect(types, `equipment type ${key}`).toContain(key);
    // Not vacuous: the spec's points required reach well into the vocabulary.
    expect(libraryRoleKeys().length).toBeGreaterThan(25);
    expect(libraryEquipmentKeys().length).toBeGreaterThan(5);
  });

  it("use only the nine sections, in the template's order", () => {
    const keys = LIBRARY_SECTIONS.map((s) => s.key);
    expect(keys).toEqual([
      "summary",
      "space_comfort",
      "vav",
      "ahu_rtu",
      "hot_water",
      "chilled_water",
      "dx",
      "schedules",
      "data_health",
    ]);
    for (const q of BAS_LIBRARY_QUESTIONS) expect(keys).toContain(q.section);
    // Positions never run backwards across sections: the spec's table order.
    let lastSection = -1;
    for (const q of [...BAS_LIBRARY_QUESTIONS].sort((a, b) => a.position - b.position)) {
      const idx = keys.indexOf(q.section);
      expect(idx).toBeGreaterThanOrEqual(lastSection);
      lastSection = idx;
    }
  });

  it("carry the spec's points required as requirement groups a screen can read", () => {
    const q3 = BAS_LIBRARY_QUESTIONS.find((q) => q.key === "q03_zone_comfort")!;
    expect(describeRequiredRoles(q3.requiredRoles)).toBe(
      "space temp; active setpoint (or heating and cooling setpoints); occupancy",
    );
    expect(q3.requiredRoles[1]).toEqual({
      label: "active setpoint (or heating and cooling setpoints)",
      anyOf: [["zone_temp_sp"], ["zone_temp_cooling_sp", "zone_temp_heating_sp"]],
    });
    // Data Health always runs: nothing required.
    const q20 = BAS_LIBRARY_QUESTIONS.find((q) => q.key === "q20_data_health")!;
    expect(q20.requiredRoles).toEqual([]);
    expect(describeRequiredRoles(q20.requiredRoles)).toBe("No trended points required");
    // The parser reads back what is stored and drops what it cannot read.
    expect(parseRoleRequirements(JSON.parse(JSON.stringify(q3.requiredRoles)))).toEqual(q3.requiredRoles);
    expect(parseRoleRequirements([{ label: 1 }, "x", { label: "ok", anyOf: [["a"], "bad"] }])).toEqual([
      { label: "ok", anyOf: [["a"]] },
    ]);
    expect(parseRoleRequirements("nonsense")).toEqual([]);
  });
});

describe("the two presets", () => {
  it("health_weekly is all twenty in position order, and health_daily is Summary, Space Comfort and Data Health", () => {
    const byPosition = [...BAS_LIBRARY_QUESTIONS].sort((a, b) => a.position - b.position).map((q) => q.key);
    expect(REPORT_PRESETS.health_weekly.questionKeys).toEqual(byPosition);
    expect(REPORT_PRESETS.health_daily.questionKeys).toEqual([
      "q01_building_status",
      "q02_changes_since_last",
      "q03_zone_comfort",
      "q04_worst_zones",
      "q05_manual_overrides",
      "q20_data_health",
    ]);
    expect(PRESET_KEYS).toEqual(["health_weekly", "health_daily"]);
  });

  it("name only library keys, and are not writable at runtime", () => {
    const keys = new Set(BAS_LIBRARY_QUESTIONS.map((q) => q.key));
    for (const preset of Object.values(REPORT_PRESETS)) {
      for (const key of preset.questionKeys) expect(keys).toContain(key);
      expect(preset.label.length).toBeGreaterThan(0);
      // Nothing is locked since 2026-11-12: a preset is a button that ticks a set.
      expect(`${preset.label} ${preset.description}`).not.toMatch(/locked|fixed order|cannot be edited/i);
      expect(preset.description).toMatch(/Ticks /);
    }
    // The list is a readonly array; a caller that mutated it would be mutating
    // the preset for every report after it. TypeScript refuses the write, and
    // this holds the runtime shape to the same promise.
    expect(Array.isArray(REPORT_PRESETS.health_weekly.questionKeys)).toBe(true);
    expect(REPORT_PRESETS.health_weekly.questionKeys.length).toBe(20);
  });
});

describe("the three copies agree", () => {
  it("the migration's INSERT block produces exactly the TypeScript rows", async () => {
    const sql = await readFile(MIGRATION, "utf8");
    const start = sql.indexOf("-- LIBRARY SEED BEGIN");
    const end = sql.indexOf("-- LIBRARY SEED END");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = sql.slice(start, end);
    expect(block).toContain("ON CONFLICT (key) DO NOTHING");
    expect(block).not.toMatch(/DO UPDATE/i);

    await inRollback(async (tx) => {
      // Start from nothing, run the block as deploy would, read it back.
      await tx.$executeRawUnsafe("DELETE FROM bas_report_questions");
      await tx.$executeRawUnsafe("DELETE FROM bas_library_questions");
      await tx.$executeRawUnsafe(block);
      const rows = await tx.basLibraryQuestion.findMany({ orderBy: { position: "asc" } });
      expect(rows).toHaveLength(20);
      for (const row of rows) {
        const declared = BAS_LIBRARY_QUESTIONS.find((q) => q.key === row.key);
        expect(declared, row.key).toBeDefined();
        expect(row.section).toBe(declared!.section);
        expect(row.position).toBe(declared!.position);
        expect(row.text).toBe(declared!.text);
        expect(row.kind).toBe(declared!.kind);
        expect(row.analysisFn).toBe(declared!.analysisFn);
        expect(row.appliesToLabel).toBe(declared!.appliesToLabel);
        expect(row.appliesToEquipment).toEqual(declared!.appliesToEquipment);
        expect(row.requiredRoles).toEqual(JSON.parse(JSON.stringify(declared!.requiredRoles)));
        expect(Number(row.minCoverage)).toBe(declared!.minCoverage);
        expect(row.enabled).toBe(true);
        expect(row.addedById).toBeNull();
      }
      // And running it again changes nothing.
      await tx.$executeRawUnsafe(block);
      expect(await tx.basLibraryQuestion.count()).toBe(20);
    });
  });

  it("the seed installs the same rows, corrects text, and never writes `enabled`", async () => {
    await inRollback(async (tx) => {
      await tx.$executeRawUnsafe("DELETE FROM bas_report_questions");
      await tx.$executeRawUnsafe("DELETE FROM bas_library_questions");

      const first = await seedBasReportLibrary(tx);
      expect(first.questions).toBe(20);
      expect(first.undeclared).toEqual([]);
      expect(await tx.basLibraryQuestion.count()).toBe(20);

      // Drift the text and turn one off, as an admin might; re-seed.
      await tx.basLibraryQuestion.update({
        where: { key: "q20_data_health" },
        data: { text: "edited by hand", enabled: false },
      });
      const second = await seedBasReportLibrary(tx);
      expect(second.undeclared).toEqual([]);
      const q20 = await tx.basLibraryQuestion.findUnique({ where: { key: "q20_data_health" } });
      expect(q20?.text).toBe(BAS_LIBRARY_QUESTIONS.find((q) => q.key === "q20_data_health")!.text);
      expect(q20?.enabled).toBe(false);

      // A computed row this repo does not declare is reported, not deleted.
      await tx.basLibraryQuestion.create({
        data: {
          key: "q99_stray",
          section: "summary",
          position: 99,
          text: "stray",
          kind: "computed",
          analysisFn: "q99_stray",
          appliesToLabel: "All",
        },
      });
      expect((await seedBasReportLibrary(tx)).undeclared).toEqual(["q99_stray"]);
      expect(await tx.basLibraryQuestion.count()).toBe(21);
    });
  });
});
