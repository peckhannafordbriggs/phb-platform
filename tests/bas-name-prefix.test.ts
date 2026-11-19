import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEADING_TOKEN_LETTERS,
  PREFIX_TYPE_RULES,
  equipmentKey,
  groupEquipmentPrefixes,
  groupIncludedByDefault,
  parsePointName,
  prefixType,
  type NamePrefixGroup,
  type PrefixSubject,
} from "@/lib/modules/bas/name-prefix";
import {
  AIR_HANDLER_TYPES,
  SETPOINT_WORD,
  TAIL_PATTERNS,
  TERMINAL_TYPES,
  compactToken,
  decodeNiagaraName,
  planSuggestionBatches,
  suggestClassification,
  type RoleFacts,
  type SuggestionSubject,
} from "@/lib/modules/bas/suggestions";
import type { PointSuggestion, SettingsEquipment, SettingsPoint } from "@/lib/modules/bas/types";
import { STATE_DATA_TYPES } from "@/lib/modules/bas/plausibility";
import {
  highConfidencePoints,
  initialPrefixDrafts,
  newEquipmentOffered,
  prefixRequestRows,
  prefixRowStates,
  suggestionLevels,
} from "@/app/(modules)/bas/settings-points-names";
import { BAS_EQUIPMENT_TYPES, BAS_POINT_ROLES } from "../prisma/bas-vocabularies";

/**
 * The name parsers behind "Create N pieces of equipment from name prefixes"
 * and the suffix-token role suggestions (2026-11-19). Pure: no database.
 *
 * The CEI names are the six the request quoted from CEI_JCI_N2's 334. The
 * full list was not readable from this repository - it is only in the
 * production database - so these are the cases, and the office and lab
 * fixtures (read from live) are the canon that must not move.
 */

const CEI = {
  spaceTemp: "V4_22/SpaceTemp",
  daTemp: "V4_22/DaTemp",
  ahuDaT: "AHU_7/DA_T",
  ahuOaEnth: "AHU_7/OA_Enth",
  xtmFilter: "XTM_109/AHU_7_FinalFilter",
  vav10: "VAV_10_ZoneTemperature",
};

interface FixturePoint {
  niagaraHistoryName: string;
  niagaraDisplayName: string | null;
  unit: string | null;
  dataType: string;
  isActive: boolean;
  role: string | null;
  equipment: string | null;
}
const fixture = JSON.parse(
  readFileSync(path.join(process.cwd(), "tests/fixtures/bas-office-classification.json"), "utf8"),
) as { office: { points: FixturePoint[] }; lab: { points: FixturePoint[] } };

const REAL_ROLES: ReadonlyMap<string, RoleFacts> = new Map(
  BAS_POINT_ROLES.map((r) => [
    r.pointRole,
    { pointRole: r.pointRole, displayName: r.displayName, typicalUnit: r.typicalUnit },
  ]),
);
const ROLE_SEEDS = new Map(BAS_POINT_ROLES.map((r) => [r.pointRole, r]));
const EQUIPMENT_TYPES = new Set(BAS_EQUIPMENT_TYPES.map((t) => t.equipType));

function suggest(
  name: string,
  over: Partial<SuggestionSubject> = {},
  equipment: Array<{ equipmentId: string; name: string }> = [],
): PointSuggestion | null {
  return suggestClassification(
    {
      niagaraHistoryName: name,
      niagaraDisplayName: null,
      unit: null,
      pointRole: null,
      equipmentId: null,
      collected: true,
      dataType: "real",
      ...over,
    },
    REAL_ROLES,
    equipment,
  );
}

// ---------------------------------------------------------------------------

describe("parsePointName: the CEI names", () => {
  it("reads the unit before a slash, and everything after it as the tail", () => {
    expect(parsePointName(CEI.spaceTemp)).toEqual({
      prefix: "V4_22", key: "V4-22", source: "slash", ioModule: null, tail: "SpaceTemp",
    });
    expect(parsePointName(CEI.daTemp)).toMatchObject({ prefix: "V4_22", tail: "DaTemp" });
    expect(parsePointName(CEI.ahuDaT)).toEqual({
      prefix: "AHU_7", key: "AHU7", source: "slash", ioModule: null, tail: "DA_T",
    });
    expect(parsePointName(CEI.ahuOaEnth)).toMatchObject({ prefix: "AHU_7", tail: "OA_Enth" });
  });

  it("looks past an XTM I/O module to the unit the point names", () => {
    expect(parsePointName(CEI.xtmFilter)).toEqual({
      prefix: "AHU_7",
      key: "AHU7",
      source: "after_io_module",
      ioModule: "XTM_109",
      tail: "FinalFilter",
    });
  });

  it("offers an XTM that names no unit as the module itself, with no type", () => {
    expect(parsePointName("XTM_109/Spare_AI_3")).toEqual({
      prefix: "XTM_109", key: "XTM109", source: "slash", ioModule: "XTM_109", tail: "Spare_AI_3",
    });
    expect(prefixType("XTM_109")).toMatchObject({ equipType: null, ioModule: true });
  });

  it("reads a leading VAV_n token when there is no slash", () => {
    expect(parsePointName(CEI.vav10)).toEqual({
      prefix: "VAV_10", key: "VAV10", source: "leading_token", ioModule: null, tail: "ZoneTemperature",
    });
  });

  it("takes the segment nearest the point when the path has several", () => {
    expect(parsePointName("N2Trunk1/V4_22/SpaceTemp")).toMatchObject({ prefix: "V4_22", tail: "SpaceTemp" });
  });

  it("maps the prefixes the request named to their types", () => {
    expect(prefixType("V4_22").equipType).toBe("vav");
    expect(prefixType("VAV-3").equipType).toBe("vav");
    expect(prefixType("AHU_7").equipType).toBe("ahu");
    expect(prefixType("RTU_1").equipType).toBe("rtu");
    // A VFD is not a V, and a plant name asks.
    expect(prefixType("VFD_2").equipType).toBeNull();
    expect(prefixType("CH_1").equipType).toBeNull();
    expect(prefixType("BLR_2").equipType).toBeNull();
  });
});

describe("parsePointName: the office's names, and names with no prefix", () => {
  it("reads the office VAVs' leading box and leaves the rooms in the tail", () => {
    expect(parsePointName("VAV-2 122-125_ZoneTemperature")).toEqual({
      prefix: "VAV-2", key: "VAV2", source: "leading_token", ioModule: null, tail: "122-125_ZoneTemperature",
    });
    expect(parsePointName(decodeNiagaraName("VAV$2d10$20107_ZoneTemperature"))).toMatchObject({
      prefix: "VAV-10", key: "VAV10",
    });
  });

  it("finds no prefix on any other office or lab name - the RTU is RV, and RV is not a unit token", () => {
    const names = [...fixture.office.points, ...fixture.lab.points]
      .map((p) => p.niagaraDisplayName ?? decodeNiagaraName(p.niagaraHistoryName))
      .filter((n) => !n.startsWith("VAV-"));
    expect(names.length).toBe(29);
    for (const name of names) {
      expect(parsePointName(name), name).toMatchObject({ prefix: null, source: null, tail: name });
    }
  });

  it("finds no prefix where none is stated", () => {
    for (const name of ["SpaceTemp", "Temp1", "points_RoomT", "VAV_Box_Status", "AHU_SAT", "VAV10ZoneTemp", "RTU", "/SpaceTemp", "V4_22/"]) {
      expect(parsePointName(name).prefix, name).toBeNull();
    }
  });

  it("treats a word before a slash as an unknown unit, never a typed one", () => {
    expect(parsePointName("Points/SpaceTemp")).toMatchObject({ prefix: "Points", source: "slash" });
    expect(prefixType("Points")).toMatchObject({ equipType: null, ioModule: false });
  });
});

describe("equipmentKey: two spellings of one unit, and two units that only look alike", () => {
  it("joins AHU_7, AHU-7, ahu 7 and AHU7", () => {
    expect(new Set(["AHU_7", "AHU-7", "ahu 7", "AHU7", " AHU_7 "].map(equipmentKey))).toEqual(new Set(["AHU7"]));
    expect(equipmentKey("VAV-2")).toBe(equipmentKey("VAV_2"));
  });

  it("keeps V4_22, V42_2 and V422 apart - separators between digits mean something", () => {
    const keys = ["V4_22", "V42_2", "V422"].map(equipmentKey);
    expect(new Set(keys).size).toBe(3);
    expect(equipmentKey("V4_22")).toBe(equipmentKey("V4-22"));
  });
});

// ---------------------------------------------------------------------------

const subject = (pointId: string, name: string, over: Partial<PrefixSubject> = {}): PrefixSubject => ({
  pointId, name, collected: true, equipmentId: null, ...over,
});

describe("groupEquipmentPrefixes: the preview's rows", () => {
  const points: PrefixSubject[] = [
    subject("1", CEI.spaceTemp),
    subject("2", CEI.daTemp),
    subject("3", CEI.ahuDaT),
    subject("4", CEI.ahuOaEnth),
    subject("5", CEI.xtmFilter),
    subject("6", CEI.vav10),
    subject("7", "AHU-7/MA_T"), // the colliding spelling
    subject("8", "V42_2/SpaceTemp"), // looks like V4_22, is not
    subject("9", "XTM_109/Spare_AI_3"),
    subject("10", "V9_1/SpaceTemp", { equipmentId: "77" }), // already attached: never offered
    subject("11", "V9_2/SpaceTemp", { collected: false }), // not collected: never offered
    subject("12", "SpaceTemp"), // no prefix
  ];
  const groups = groupEquipmentPrefixes(points, []);
  const byKey = new Map(groups.map((g) => [g.key, g]));

  it("makes one row per unit, merging spellings and the points an XTM carries for it", () => {
    expect([...byKey.keys()].sort()).toEqual(["AHU7", "V4-22", "V42-2", "VAV10", "XTM109"]);
    expect(byKey.get("AHU7")).toMatchObject({
      name: "AHU_7",
      spellings: ["AHU_7", "AHU-7"].sort(new Intl.Collator("en", { numeric: true, sensitivity: "base" }).compare),
      equipType: "ahu",
      ioModule: false,
      existing: null,
      pointIds: ["3", "4", "5", "7"],
    });
    expect(byKey.get("V4-22")).toMatchObject({ name: "V4_22", equipType: "vav", pointIds: ["1", "2"] });
    expect(byKey.get("V42-2")).toMatchObject({ name: "V42_2", pointIds: ["8"] });
    expect(byKey.get("VAV10")).toMatchObject({ name: "VAV_10", equipType: "vav", pointIds: ["6"] });
  });

  it("offers the XTM's leftover points as the module, unticked and with no type", () => {
    const xtm = byKey.get("XTM109")!;
    expect(xtm).toMatchObject({ name: "XTM_109", equipType: null, ioModule: true, pointIds: ["9"] });
    expect(groupIncludedByDefault(xtm)).toBe(false);
    expect(xtm.typeReason).toMatch(/expansion I\/O module/);
  });

  it("never offers a point that has equipment or is not collected, and drops a row left with none", () => {
    const all = groups.flatMap((g) => g.pointIds);
    expect(all).not.toContain("10");
    expect(all).not.toContain("11");
    expect(all).not.toContain("12");
    expect(byKey.has("V9-1")).toBe(false);
    expect(byKey.has("V9-2")).toBe(false);
  });

  it("names a row by its commonest spelling before a slash", () => {
    const merged = groupEquipmentPrefixes(
      [subject("1", "AHU-7/DA_T"), subject("2", "AHU_7/RA_T"), subject("3", "AHU_7/MA_T"), subject("4", "AHU_7_SAP")],
      [],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ key: "AHU7", name: "AHU_7", pointIds: ["1", "2", "3", "4"] });
  });

  it("attaches to existing equipment matched by key, keeping its name and type", () => {
    const withExisting = groupEquipmentPrefixes(points, [{ equipmentId: "40", name: "AHU-7", equipType: "rtu" }]);
    const ahu = withExisting.find((g) => g.key === "AHU7")!;
    expect(ahu).toMatchObject({
      name: "AHU-7",
      equipType: "rtu",
      existing: { equipmentId: "40", name: "AHU-7", equipType: "rtu" },
    });
    expect(groupIncludedByDefault(ahu)).toBe(true);
  });

  it("lists the rows a type is proposed for first, in natural order", () => {
    const order = groupEquipmentPrefixes(
      [subject("1", "V4_10/SpaceTemp"), subject("2", "V4_9/SpaceTemp"), subject("3", "Points/X"), subject("4", "AHU_1/DA_T")],
      [],
    ).map((g) => g.name);
    expect(order).toEqual(["AHU_1", "V4_9", "V4_10", "Points"]);
  });

  it("derives exactly the office's ten VAVs from the office's names", () => {
    const office = groupEquipmentPrefixes(
      fixture.office.points.map((p, i) =>
        subject(String(i), p.niagaraDisplayName ?? decodeNiagaraName(p.niagaraHistoryName), { collected: p.isActive }),
      ),
      [],
    );
    expect(office.map((g) => g.name)).toEqual(
      ["VAV-1", "VAV-2", "VAV-3", "VAV-4", "VAV-5", "VAV-6", "VAV-7", "VAV-8", "VAV-9", "VAV-10"],
    );
    for (const g of office) {
      expect(g.equipType).toBe("vav");
      expect(g.pointIds).toHaveLength(1);
      // The name each derives is the name live gave that box.
      const point = fixture.office.points[Number(g.pointIds[0])]!;
      expect(point.equipment).toBe(g.name);
    }
    // And nothing at all from the lab.
    expect(
      groupEquipmentPrefixes(fixture.lab.points.map((p, i) => subject(String(i), p.niagaraHistoryName)), []),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("suffix-token role suggestions: the CEI names", () => {
  it("reads SpaceTemp as a zone temperature, high, naming no equipment", () => {
    expect(suggest(CEI.spaceTemp)).toMatchObject({
      role: "zone_temp", level: "high", equipmentName: null, pattern: "tail_zone_temp",
    });
  });

  it("lets the equipment decide discharge air: a VAV's is discharge, an AHU's is supply", () => {
    expect(suggest(CEI.daTemp)).toMatchObject({ role: "discharge_air_temp", level: "high" });
    expect(suggest(CEI.ahuDaT)).toMatchObject({ role: "supply_air_temp", level: "high" });
    // With no equipment type, the equipment cannot decide, so nothing.
    expect(suggest("DaTemp")).toBeNull();
    expect(suggest("Points/DA_T")).toBeNull();
  });

  it("prefers the equipment a person attached over the type the name implies", () => {
    expect(suggest(CEI.ahuDaT, { equipmentId: "9", equipmentType: "vav" })?.role).toBe("discharge_air_temp");
    expect(suggest("DaTemp", { equipmentId: "9", equipmentType: "rtu" })?.role).toBe("supply_air_temp");
    expect(suggest("DaTemp", { equipmentId: "9", equipmentType: null })).toBeNull();
  });

  it("is silent on OA_Enth: the vocabulary has no enthalpy role", () => {
    expect(suggest(CEI.ahuOaEnth)).toBeNull();
  });

  it("decides a filter by its value: a boolean is the switch, a pressure the differential", () => {
    expect(suggest(CEI.xtmFilter, { dataType: "bool" })).toMatchObject({ role: "filter_status", level: "high" });
    expect(suggest(CEI.xtmFilter, { unit: "inches of water" })).toMatchObject({ role: "filter_dp", level: "high" });
    expect(suggest(CEI.xtmFilter)).toMatchObject({ role: "filter_dp", level: "medium" });
    expect(suggest(CEI.xtmFilter, { dataType: "enum" })).toMatchObject({ role: "filter_status", level: "medium" });
    expect(suggest(CEI.xtmFilter, { dataType: "unknown" })).toBeNull();
    expect(suggest("AHU_7/PreFilter", { dataType: "bool" })?.role).toBe("filter_status");
  });

  it("keeps the B8.5 VAV pattern, with the box named as written and matched by key", () => {
    expect(suggest(CEI.vav10)).toMatchObject({
      role: "zone_temp", level: "high", equipmentName: "VAV_10", equipmentId: null, equipType: "vav", pattern: "vav_zone_temp",
    });
    expect(suggest(CEI.vav10, {}, [{ equipmentId: "5", name: "VAV-10" }])).toMatchObject({
      equipmentName: "VAV-10", equipmentId: "5", equipType: null,
    });
  });

  it("reads the rest of the request's abbreviations", () => {
    expect(suggest("AHU_7/OA_T")).toMatchObject({ role: "outside_air_temp", level: "high" });
    expect(suggest("AHU_7/RA_T")).toMatchObject({ role: "return_air_temp", level: "high" });
    expect(suggest("AHU_7/MA_T")).toMatchObject({ role: "mixed_air_temp", level: "high" });
    expect(suggest("AHU_7/SA_T")).toMatchObject({ role: "supply_air_temp", level: "high" });
    expect(suggest("AHU_7/RA_HUM")).toMatchObject({ role: "return_air_humidity", level: "high" });
    expect(suggest("AHU_7/OA_HUM")).toMatchObject({ role: "outside_air_humidity", level: "high" });
    expect(suggest("AHU_7/DA_SAP", { unit: "inches of water" })).toMatchObject({ role: "duct_static_pressure", level: "high" });
    expect(suggest("AHU_7/SAP")).toMatchObject({ role: "duct_static_pressure", level: "medium" });
    expect(suggest("V4_22/CO2")).toMatchObject({ role: "space_co2", level: "high" });
    expect(suggest("CO2")).toMatchObject({ role: "space_co2", level: "medium" });
    expect(suggest("V4_22/Humidity")).toMatchObject({ role: "space_humidity", level: "high" });
    expect(suggest("Humidity")).toMatchObject({ role: "space_humidity", level: "medium" });
    expect(suggest("V4_22/ZN_T")).toMatchObject({ role: "zone_temp", level: "high" });
  });

  it("is silent where the equipment makes a token ambiguous", () => {
    expect(suggest("AHU_7/CO2")).toBeNull(); // return air CO2 has no role
    expect(suggest("AHU_7/Humidity")).toBeNull(); // return, outside or space
    expect(suggest("V4_22/SAP")).toBeNull(); // a box has no duct static
    expect(suggest("V4_22/SA_T")).toBeNull(); // the air arriving at the box?
    expect(suggest("CH_1/DA_T")).toBeNull(); // a type that is neither
  });

  it("reads the setpoint forms as setpoints, and only setpoint tokens as setpoints", () => {
    expect(suggest("V4_22/ZN_T_SP")).toMatchObject({ role: "zone_temp_sp", level: "high" });
    expect(suggest("V4_22/SpaceTempSP")).toMatchObject({ role: "zone_temp_sp" });
    expect(suggest("V4_22/DA_T_SP")).toMatchObject({ role: "discharge_air_temp_sp" });
    expect(suggest("AHU_7/DA_T_SP")).toMatchObject({ role: "supply_air_temp_sp" });
    expect(suggest("AHU_7/DA_SAP_SP")).toMatchObject({ role: "duct_static_pressure_sp" });
    // DSP ends in SP: rule 1 reads it as a setpoint, and it is not in the table.
    expect(suggest("AHU_7/DSP")).toBeNull();
  });

  it("reads the WHOLE tail, never only the text after the last underscore", () => {
    expect(suggest("AHU_7/RA_CO2")).toBeNull(); // not CO2
    // OA_Humidity is outside air humidity as a whole, not a bare Humidity
    // (which would read as the space).
    expect(suggest("AHU_7/OA_Humidity")?.role).toBe("outside_air_humidity");
    expect(suggest("V4_22/Bldg_Humidity")).toBeNull(); // not Humidity
    expect(suggest("Floor2_SpaceTemp")).toBeNull(); // no unit token, so no tail
    expect(suggest("AHU_7/T")).toBeNull();
  });

  it("applies rules 3, 5 and 6 to suffix tokens too", () => {
    expect(suggest(CEI.spaceTemp, { unit: "percent" })).toBeNull();
    expect(suggest(CEI.spaceTemp, { unit: "fahrenheit" })?.role).toBe("zone_temp");
    expect(suggest(CEI.spaceTemp, { dataType: "bool" })).toBeNull(); // a boolean is not a temperature
    expect(suggest(CEI.spaceTemp, { pointRole: "zone_temp" })).toBeNull(); // the tail names no equipment
    expect(suggest(CEI.spaceTemp, { collected: false })).toBeNull();
  });

  it("is silent when a phrase pattern and a token disagree", () => {
    // Contrived on purpose: the phrase says outside air, the tail says zone.
    expect(suggest("Outside_Air_Temp/SpaceTemp")).toBeNull();
  });
});

describe("the canon: the office and lab names suggest exactly what they did before", () => {
  const suggested = new Map(
    [...fixture.office.points, ...fixture.lab.points].map((p) => [
      p.niagaraHistoryName,
      suggestClassification(
        {
          niagaraHistoryName: p.niagaraHistoryName,
          niagaraDisplayName: p.niagaraDisplayName,
          unit: p.unit,
          pointRole: null,
          equipmentId: null,
          collected: p.isActive,
          dataType: p.dataType,
        },
        REAL_ROLES,
        [],
      ),
    ]),
  );

  it("suggests the same 17 office points, each at high confidence, each what live holds", () => {
    const office = fixture.office.points.filter((p) => suggested.get(p.niagaraHistoryName) !== null);
    expect(office).toHaveLength(17);
    for (const p of office) {
      const s = suggested.get(p.niagaraHistoryName)!;
      expect(s.level, p.niagaraHistoryName).toBe("high");
      expect(s.role, p.niagaraHistoryName).toBe(p.role);
      if (s.equipmentName !== null) expect(s.equipmentName).toBe(p.equipment);
    }
  });

  it("still says nothing about any lab point", () => {
    for (const p of fixture.lab.points) expect(suggested.get(p.niagaraHistoryName), p.niagaraHistoryName).toBeNull();
  });
});

describe("the tables are consistent with the vocabulary", () => {
  const outcomes = (pattern: (typeof TAIL_PATTERNS)[number]) => {
    const found = Object.values(pattern.byClass).filter((o) => o !== undefined);
    if (pattern.byValue !== undefined) {
      for (const dataType of ["bool", "enum", "str", "real", "int", "unknown", null]) {
        for (const unitKind of ["temperature", "percentage", "pressure", "other"] as const) {
          const o = pattern.byValue({ dataType, unitKind });
          if (o !== null) found.push(o);
        }
      }
    }
    return found;
  };

  it("names only roles the vocabulary holds, with the setpoint flag the role has", () => {
    for (const pattern of TAIL_PATTERNS) {
      const found = outcomes(pattern);
      expect(found.length, pattern.id).toBeGreaterThan(0);
      for (const o of found) {
        const seed = ROLE_SEEDS.get(o.role);
        expect(seed, `${pattern.id} -> ${o.role}`).toBeDefined();
        expect(seed!.isSetpoint === true, `${pattern.id} -> ${o.role}`).toBe(pattern.setpoint);
      }
    }
  });

  it("writes every token compact, uses each once, and agrees with rule 1's setpoint word", () => {
    const all = TAIL_PATTERNS.flatMap((p) => p.tokens);
    expect(new Set(all).size).toBe(all.length);
    for (const pattern of TAIL_PATTERNS) {
      for (const token of pattern.tokens) {
        expect(compactToken(token), token).toBe(token);
        // A token the setpoint rule disagrees with could never fire.
        expect(SETPOINT_WORD.test(token), `${pattern.id} ${token}`).toBe(pattern.setpoint);
      }
    }
  });

  it("maps prefixes and classes only to equipment types the vocabulary holds", () => {
    for (const rule of PREFIX_TYPE_RULES) {
      if (rule.equipType !== null) expect(EQUIPMENT_TYPES.has(rule.equipType), rule.letters).toBe(true);
      expect(rule.equipType === null || !rule.ioModule, rule.letters).toBe(true);
    }
    for (const type of [...TERMINAL_TYPES, ...AIR_HANDLER_TYPES]) expect(EQUIPMENT_TYPES.has(type), type).toBe(true);
    for (const letters of LEADING_TOKEN_LETTERS) {
      expect(PREFIX_TYPE_RULES.find((r) => r.letters === letters)?.equipType, letters).not.toBeNull();
    }
  });

  it("uses the module's own list of state data types", () => {
    expect(suggest("V4_22/SpaceTemp", { dataType: STATE_DATA_TYPES[0] })).toBeNull();
  });
});

describe("planSuggestionBatches creates one piece of equipment per key", () => {
  it("treats VAV-1 and VAV_1 as one creation", () => {
    const s = (equipmentName: string): PointSuggestion => ({
      role: "zone_temp", roleName: "Zone Temperature", equipmentName, equipmentId: null, equipType: "vav", pattern: "t", confidence: "t", level: "high",
    });
    const plan = planSuggestionBatches([
      { pointId: "1", suggestion: s("VAV-1") },
      { pointId: "2", suggestion: s("VAV_1") },
    ]);
    expect(plan.create).toEqual([{ name: "VAV-1", equipType: "vav" }]);
    expect(plan.batches).toEqual([{ pointIds: ["1", "2"], role: "zone_temp", equipmentId: null, equipmentName: "VAV-1" }]);
  });
});

// ---------------------------------------------------------------------------

describe("the previews' rules", () => {
  const group = (key: string, name: string, over: Partial<NamePrefixGroup> = {}): NamePrefixGroup => ({
    key, name, spellings: [name], equipType: "vav", typeReason: "r", ioModule: false, existing: null,
    pointIds: ["1"], sampleNames: [], ...over,
  });
  const equipment = (name: string, equipType: string | null = "ahu"): SettingsEquipment => ({
    equipmentId: "e-" + name, siteId: "1", name, equipType, equipTypeName: null, parentEquipmentId: null,
    parentName: null, notes: null, pointCount: 0,
  });

  it("ticks typed and existing rows, leaves modules and unknowns unticked, and counts only new typed ones", () => {
    const groups = [
      group("V4-22", "V4_22"),
      group("XTM109", "XTM_109", { equipType: null, ioModule: true }),
      group("POINTS", "Points", { equipType: null }),
      group("AHU7", "AHU-7", { equipType: "ahu", existing: { equipmentId: "4", name: "AHU-7", equipType: "ahu" } }),
    ];
    expect(initialPrefixDrafts(groups).map((d) => d.include)).toEqual([true, false, false, true]);
    expect(newEquipmentOffered(groups)).toBe(1);
  });

  it("refuses a blank name, two ticked rows with one name, and a new row with no type", () => {
    const drafts = initialPrefixDrafts([group("A", "AHU_1"), group("B", "AHU-1"), group("C", "V1", { equipType: null }), group("D", "V2")]);
    drafts[2]!.include = true;
    drafts[3]!.name = "  ";
    const states = prefixRowStates(drafts, []);
    expect(states.map((s) => s.problem)).toEqual([
      "Another ticked row has the same name.",
      "Another ticked row has the same name.",
      "Choose a type.",
      "Give it a name.",
    ]);
    // Unticking one of the pair clears both.
    drafts[1]!.include = false;
    expect(prefixRowStates(drafts, [])[0]!.problem).toBeNull();
  });

  it("attaches a row to existing equipment when its EDITED name matches by key, and sends no type for it", () => {
    const drafts = initialPrefixDrafts([group("A", "AHU_7", { equipType: null }), group("B", "V4_22")]);
    expect(drafts[0]!.include).toBe(false); // no type: starts unticked
    drafts[0]!.include = true;
    drafts[0]!.name = "ahu 7";
    const states = prefixRowStates(drafts, [equipment("AHU-7")]);
    expect(states[0]).toEqual({ existing: equipment("AHU-7"), problem: null });
    expect(prefixRequestRows(drafts, states)).toEqual([
      { key: "A", name: "ahu 7" },
      { key: "B", name: "V4_22", equipType: "vav" },
    ]);
  });

  it("offers only high-confidence points to Apply all, and counts both levels", () => {
    const point = (pointId: string, level: "high" | "medium" | null) =>
      ({
        pointId,
        suggestion: level === null ? null : { role: "zone_temp", roleName: "Z", equipmentName: null, equipmentId: null, equipType: null, pattern: "p", confidence: "c", level },
      }) as unknown as SettingsPoint;
    const points = [point("1", "high"), point("2", "medium"), point("3", null), point("4", "high")];
    expect(highConfidencePoints(points).map((p) => p.pointId)).toEqual(["1", "4"]);
    expect(suggestionLevels(points)).toEqual({ high: 2, medium: 1 });
  });
});
