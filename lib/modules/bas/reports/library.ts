/**
 * The shared question library, as data: the twenty questions of Jim's
 * "BAS Health Report: Build Spec" (27 October 2026), one record each.
 *
 * This file is the source of truth for the twenty. It reaches a database two
 * ways, both carrying the same values (docs/10-adding-a-module.md states the
 * rule for module rows, and it applies here for the same reason - the seed
 * never runs on production):
 *
 *   - prisma/bas-report-library.ts upserts these rows from the seed, so a
 *     fresh database has them;
 *   - the add_bas_reports migration inserts the same rows with
 *     ON CONFLICT (key) DO NOTHING, so production has them.
 *
 * tests/bas-reports-library.test.ts holds the two to each other by running the
 * migration's INSERT block and comparing row for row.
 *
 * WHAT IS DATA AND WHAT IS CODE. The spec says: "Storing these as structured
 * data (one record per question) will make it easier to add questions per
 * building later." The Applies-to column drives the spec's Step 1 and the
 * Points-required column drives Step 2, so both are structured here -
 * equipment type keys from prisma/bas-vocabularies.ts, and point role keys
 * from the same file - rather than prose the engine would have to parse.
 * `analysisFn` names the function Phase 2 implements; nothing in Phase 1
 * calls it, and the name is fixed now so the library row and the code that
 * answers it can never disagree about which is which.
 *
 * Text is the spec's, verbatim. A question the spec words one way and the
 * report another would compare badly week to week, which is the one property
 * the spec asks for.
 */

/**
 * One requirement from the spec's "Points required" column.
 *
 * Satisfied when ANY alternative is satisfied; an alternative is one or more
 * role keys that must ALL be present on the equipment. So "active setpoint
 * (or heating and cooling setpoints)" is
 * `anyOf: [["zone_temp_sp"], ["zone_temp_cooling_sp", "zone_temp_heating_sp"]]`.
 * `label` is the spec's own words for the point, kept so a screen can say what
 * is missing in the language the spec uses.
 */
export interface RoleRequirement {
  label: string;
  anyOf: string[][];
}

export type LibrarySection =
  | "summary"
  | "space_comfort"
  | "vav"
  | "ahu_rtu"
  | "hot_water"
  | "chilled_water"
  | "dx"
  | "schedules"
  | "data_health";

/** The sections in report order, with the heading the template uses. */
export const LIBRARY_SECTIONS: ReadonlyArray<{ key: LibrarySection; label: string }> = [
  { key: "summary", label: "Summary" },
  { key: "space_comfort", label: "Space Comfort" },
  { key: "vav", label: "VAV" },
  { key: "ahu_rtu", label: "AHU / RTU" },
  { key: "hot_water", label: "Hot Water" },
  { key: "chilled_water", label: "Chilled Water" },
  { key: "dx", label: "DX Cooling and Heat" },
  { key: "schedules", label: "Schedules" },
  { key: "data_health", label: "Data Health" },
];

export function sectionLabel(key: string): string {
  return LIBRARY_SECTIONS.find((s) => s.key === key)?.label ?? key;
}

export type LibraryQuestionKind = "computed" | "planner";

export interface LibraryQuestionSeed {
  /** Stable key; what a preset names. `qNN_` prefix is the spec's row number. */
  key: string;
  section: LibrarySection;
  /** The spec's row number, which is also the order in the standard report. */
  position: number;
  text: string;
  kind: LibraryQuestionKind;
  /** The function Phase 2 implements for a computed question. */
  analysisFn: string;
  /** The spec's "Applies to" wording, verbatim. */
  appliesToLabel: string;
  /** Equipment type keys. Empty means the whole building ("All"). */
  appliesToEquipment: string[];
  requiredRoles: RoleRequirement[];
  /** The spec's 80% rule, as a fraction. */
  minCoverage: number;
}

/** Default coverage a required point needs over the period before a question is answered. */
export const DEFAULT_MIN_COVERAGE = 0.8;

// Shared alternatives, named once so the twenty rows cannot spell them differently.
const ZONE_TEMP: RoleRequirement = { label: "space temp", anyOf: [["zone_temp"]] };
const ZONE_SETPOINT: RoleRequirement = {
  label: "active setpoint (or heating and cooling setpoints)",
  anyOf: [["zone_temp_sp"], ["zone_temp_cooling_sp", "zone_temp_heating_sp"]],
};
const OCCUPANCY: RoleRequirement = {
  label: "occupancy",
  anyOf: [["occupancy_status"], ["occupancy_cmd"]],
};
/** Discharge air on an air handler is the vocabulary's supply_air_temp; a terminal's is discharge_air_temp. */
const DAT: RoleRequirement = {
  label: "DAT",
  anyOf: [["supply_air_temp"], ["discharge_air_temp"]],
};
const DAT_SETPOINT: RoleRequirement = {
  label: "DAT setpoint",
  anyOf: [["supply_air_temp_sp"], ["discharge_air_temp_sp"]],
};
const FAN_STATUS: RoleRequirement = { label: "fan status", anyOf: [["supply_fan_status"]] };
const COMPRESSOR: RoleRequirement = {
  label: "compressor status",
  anyOf: [["compressor_status"], ["compressor_cmd"]],
};
const RETURN_OR_MIXED: RoleRequirement = {
  label: "RAT or MAT",
  anyOf: [["return_air_temp"], ["mixed_air_temp"]],
};

/**
 * Equipment types that can carry DX cooling. The spec classifies DX from the
 * points (Step 1: compressor status or cooling stage points), so this is the
 * widest set a DX question could apply to; Phase 2's classifier narrows it
 * per unit.
 */
const DX_EQUIPMENT = ["rtu", "ahu", "split_system", "crac", "vrf_outdoor"];

export const BAS_LIBRARY_QUESTIONS: readonly LibraryQuestionSeed[] = [
  {
    key: "q01_building_status",
    section: "summary",
    position: 1,
    text: "What is the building status (Good, Watch, Action Needed), and what three findings drove it?",
    kind: "computed",
    analysisFn: "q01_building_status",
    appliesToLabel: "All",
    appliesToEquipment: [],
    // "Results of the questions below" - derived, no points of its own.
    requiredRoles: [],
    minCoverage: DEFAULT_MIN_COVERAGE,
  },
  {
    key: "q02_changes_since_last",
    section: "summary",
    position: 2,
    text: "What's new, what's still open, and what cleared since last period?",
    kind: "computed",
    analysisFn: "q02_changes_since_last",
    appliesToLabel: "All",
    appliesToEquipment: [],
    // "Last period's report" - the previous run, not a point.
    requiredRoles: [],
    minCoverage: DEFAULT_MIN_COVERAGE,
  },
  {
    key: "q03_zone_comfort",
    section: "space_comfort",
    position: 3,
    text: "What percent of occupied hours did each zone hold within ±2°F of setpoint?",
    kind: "computed",
    analysisFn: "q03_zone_comfort",
    appliesToLabel: "All",
    appliesToEquipment: [],
    requiredRoles: [ZONE_TEMP, ZONE_SETPOINT, OCCUPANCY],
    minCoverage: DEFAULT_MIN_COVERAGE,
  },
  {
    key: "q04_worst_zones",
    section: "space_comfort",
    position: 4,
    text: "Which 10 zones were out of range the most, how far off, and at what times of day?",
    kind: "computed",
    analysisFn: "q04_worst_zones",
    appliesToLabel: "All",
    appliesToEquipment: [],
    requiredRoles: [ZONE_TEMP, ZONE_SETPOINT, OCCUPANCY],
    minCoverage: DEFAULT_MIN_COVERAGE,
  },
  {
    key: "q05_manual_overrides",
    section: "space_comfort",
    position: 5,
    text: "Which setpoints or outputs are in manual override, and since when?",
    kind: "computed",
    analysisFn: "q05_manual_overrides",
    appliesToLabel: "All",
    appliesToEquipment: [],
    // The vocabulary has no general "override or priority status" role;
    // occupancy_override is the one override it names. Widening this is a
    // vocabulary decision (prisma/bas-vocabularies.ts), not a report one.
    requiredRoles: [{ label: "override or priority status", anyOf: [["occupancy_override"]] }],
    minCoverage: DEFAULT_MIN_COVERAGE,
  },
  {
    key: "q06_vav_starved_airflow",
    section: "vav",
    position: 6,
    text: "Which VAVs ran below 80% of airflow setpoint while occupied?",
    kind: "computed",
    analysisFn: "q06_vav_starved_airflow",
    appliesToLabel: "VAV",
    appliesToEquipment: ["vav"],
    requiredRoles: [
      { label: "airflow", anyOf: [["supply_air_flow"]] },
      { label: "airflow setpoint", anyOf: [["supply_air_flow_sp"]] },
      OCCUPANCY,
    ],
    minCoverage: DEFAULT_MIN_COVERAGE,
  },
  {
    key: "q07_vav_damper_full_missed_setpoint",
    section: "vav",
    position: 7,
    text: "Which VAVs sat at 100% damper and still missed setpoint?",
    kind: "computed",
    analysisFn: "q07_vav_damper_full_missed_setpoint",
    appliesToLabel: "VAV",
    appliesToEquipment: ["vav"],
    requiredRoles: [
      { label: "damper position", anyOf: [["vav_damper_cmd"]] },
      ZONE_TEMP,
      ZONE_SETPOINT,
    ],
    minCoverage: DEFAULT_MIN_COVERAGE,
  },
  {
    key: "q08_reheat_open_above_cooling_sp",
    section: "vav",
    position: 8,
    text: "Which reheat valves were open while the zone was above cooling setpoint?",
    kind: "computed",
    analysisFn: "q08_reheat_open_above_cooling_sp",
    appliesToLabel: "VAV with reheat",
    appliesToEquipment: ["vav"],
    requiredRoles: [
      { label: "reheat valve command", anyOf: [["reheat_valve_cmd"]] },
      ZONE_TEMP,
      { label: "cooling setpoint", anyOf: [["zone_temp_cooling_sp"]] },
    ],
    minCoverage: DEFAULT_MIN_COVERAGE,
  },
  {
    key: "q09_dat_holds_setpoint",
    section: "ahu_rtu",
    position: 9,
    text: "Did discharge air temp hold setpoint? ±1.5°F on modulating valves, ±4°F on staged DX.",
    kind: "computed",
    analysisFn: "q09_dat_holds_setpoint",
    appliesToLabel: "AHU, RTU",
    appliesToEquipment: ["ahu", "rtu"],
    requiredRoles: [DAT, DAT_SETPOINT, FAN_STATUS],
    minCoverage: DEFAULT_MIN_COVERAGE,
  },
  {
    key: "q10_static_tracks_setpoint",
    section: "ahu_rtu",
    position: 10,
    text: "Did duct static pressure track setpoint?",
    kind: "computed",
    analysisFn: "q10_static_tracks_setpoint",
    appliesToLabel: "AHU, RTU",
    appliesToEquipment: ["ahu", "rtu"],
    requiredRoles: [
      { label: "duct static", anyOf: [["duct_static_pressure"]] },
      { label: "static setpoint", anyOf: [["duct_static_pressure_sp"]] },
      FAN_STATUS,
    ],
    minCoverage: DEFAULT_MIN_COVERAGE,
  },
  {
    key: "q11_simultaneous_heating_cooling",
    section: "ahu_rtu",
    position: 11,
    text: "Were heating and cooling on at the same time (valves open together, or heat stages and compressors on together)?",
    kind: "computed",
    analysisFn: "q11_simultaneous_heating_cooling",
    appliesToLabel: "AHU, RTU",
    appliesToEquipment: ["ahu", "rtu"],
    requiredRoles: [
      { label: "heating valve or heat stage", anyOf: [["heating_valve_cmd"], ["heating_stage_cmd"]] },
      {
        label: "cooling valve or compressor status",
        anyOf: [["cooling_valve_cmd"], ["compressor_status"], ["compressor_cmd"], ["cooling_stage_cmd"]],
      },
    ],
    minCoverage: DEFAULT_MIN_COVERAGE,
  },
  {
    key: "q12_economizer_at_minimum",
    section: "ahu_rtu",
    position: 12,
    text: "Was the economizer at minimum when free cooling was available?",
    kind: "computed",
    analysisFn: "q12_economizer_at_minimum",
    appliesToLabel: "AHU, RTU with economizer",
    appliesToEquipment: ["ahu", "rtu"],
    // "RAT (MAT if available)": the return is required, the mixed is a bonus.
    requiredRoles: [
      { label: "OA damper", anyOf: [["oa_damper_cmd"]] },
      { label: "OAT", anyOf: [["outside_air_temp"]] },
      { label: "RAT", anyOf: [["return_air_temp"]] },
    ],
    minCoverage: DEFAULT_MIN_COVERAGE,
  },
  {
    key: "q13_hw_supply_and_delta_t",
    section: "hot_water",
    position: 13,
    text: "Did HW supply temp hold setpoint or reset, and was delta T at least 10°F?",
    kind: "computed",
    analysisFn: "q13_hw_supply_and_delta_t",
    appliesToLabel: "Hydronic heating",
    appliesToEquipment: ["boiler", "plant_hw"],
    requiredRoles: [
      { label: "HWS temp", anyOf: [["hw_supply_temp"]] },
      { label: "HWR temp", anyOf: [["hw_return_temp"]] },
      { label: "HWS setpoint", anyOf: [["hw_supply_temp_sp"]] },
    ],
    minCoverage: DEFAULT_MIN_COVERAGE,
  },
  {
    key: "q14_chw_supply_and_delta_t",
    section: "chilled_water",
    position: 14,
    text: "Did CHW supply temp hold setpoint, and was delta T at least 8°F?",
    kind: "computed",
    analysisFn: "q14_chw_supply_and_delta_t",
    appliesToLabel: "Hydronic cooling",
    appliesToEquipment: ["chiller", "plant_chw"],
    requiredRoles: [
      { label: "CHWS temp", anyOf: [["chw_supply_temp"]] },
      { label: "CHWR temp", anyOf: [["chw_return_temp"]] },
      { label: "CHWS setpoint", anyOf: [["chw_supply_temp_sp"]] },
    ],
    minCoverage: DEFAULT_MIN_COVERAGE,
  },
  {
    key: "q15_compressor_short_cycling",
    section: "dx",
    position: 15,
    text: "Are compressors short cycling (more than 4 starts per hour on any stage)?",
    kind: "computed",
    analysisFn: "q15_compressor_short_cycling",
    appliesToLabel: "DX",
    appliesToEquipment: DX_EQUIPMENT,
    requiredRoles: [
      {
        label: "compressor status or stage command",
        anyOf: [["compressor_status"], ["compressor_cmd"], ["cooling_stage_cmd"]],
      },
    ],
    minCoverage: DEFAULT_MIN_COVERAGE,
  },
  {
    key: "q16_dx_cooling_delta",
    section: "dx",
    position: 16,
    text: "With compressors running 15 minutes or more, did DAT drop at least 15°F below return or mixed air? Under 10°F points to low charge, a failed compressor, or a dirty coil.",
    kind: "computed",
    analysisFn: "q16_dx_cooling_delta",
    appliesToLabel: "DX",
    appliesToEquipment: DX_EQUIPMENT,
    requiredRoles: [COMPRESSOR, DAT, RETURN_OR_MIXED],
    minCoverage: DEFAULT_MIN_COVERAGE,
  },
  {
    key: "q17_compressors_during_economizer",
    section: "dx",
    position: 17,
    text: "Did compressors run while OAT was below 55°F with the economizer at minimum?",
    kind: "computed",
    analysisFn: "q17_compressors_during_economizer",
    appliesToLabel: "DX with economizer",
    appliesToEquipment: DX_EQUIPMENT,
    requiredRoles: [
      COMPRESSOR,
      { label: "OAT", anyOf: [["outside_air_temp"]] },
      { label: "OA damper", anyOf: [["oa_damper_cmd"]] },
    ],
    minCoverage: DEFAULT_MIN_COVERAGE,
  },
  {
    key: "q18_heat_stage_delta",
    section: "dx",
    position: 18,
    text: "With heat stages on 10 minutes or more, did DAT rise at least 20°F above return or mixed air?",
    kind: "computed",
    analysisFn: "q18_heat_stage_delta",
    appliesToLabel: "Gas or electric heat",
    appliesToEquipment: ["rtu", "ahu", "unit_heater", "split_system"],
    requiredRoles: [
      { label: "heat stage status", anyOf: [["heating_stage_cmd"]] },
      DAT,
      RETURN_OR_MIXED,
    ],
    minCoverage: DEFAULT_MIN_COVERAGE,
  },
  {
    key: "q19_run_outside_schedule",
    section: "schedules",
    position: 19,
    text: "What equipment ran outside its occupancy schedule, and for how many hours?",
    kind: "computed",
    analysisFn: "q19_run_outside_schedule",
    appliesToLabel: "All",
    appliesToEquipment: [],
    requiredRoles: [
      {
        label: "fan or equipment status",
        anyOf: [
          ["supply_fan_status"],
          ["return_fan_status"],
          ["exhaust_fan_status"],
          ["pump_status"],
          ["chiller_status"],
          ["boiler_status"],
          ["compressor_status"],
          ["tower_fan_status"],
        ],
      },
      { label: "occupancy schedule", anyOf: [["occupancy_status"], ["occupancy_cmd"]] },
    ],
    minCoverage: DEFAULT_MIN_COVERAGE,
  },
  {
    key: "q20_data_health",
    section: "data_health",
    position: 20,
    text: "Which points went offline, stopped trending, flat-lined, or read out of physical range?",
    kind: "computed",
    analysisFn: "q20_data_health",
    appliesToLabel: "All",
    appliesToEquipment: [],
    // "Always runs": no required point, so the 80% rule gates nothing here.
    requiredRoles: [],
    minCoverage: DEFAULT_MIN_COVERAGE,
  },
];

/** Every role key the twenty questions name, for the test that holds them to the vocabulary. */
export function libraryRoleKeys(): string[] {
  const keys = new Set<string>();
  for (const q of BAS_LIBRARY_QUESTIONS) {
    for (const req of q.requiredRoles) {
      for (const alternative of req.anyOf) {
        for (const role of alternative) keys.add(role);
      }
    }
  }
  return [...keys].sort();
}

/** Every equipment type key the twenty questions name. */
export function libraryEquipmentKeys(): string[] {
  const keys = new Set<string>();
  for (const q of BAS_LIBRARY_QUESTIONS) {
    for (const type of q.appliesToEquipment) keys.add(type);
  }
  return [...keys].sort();
}

/**
 * The requirement in words, for a screen: "space temp; active setpoint (or
 * heating and cooling setpoints); occupancy". The spec's labels, joined.
 */
export function describeRequiredRoles(requirements: readonly RoleRequirement[]): string {
  if (requirements.length === 0) return "No trended points required";
  return requirements.map((r) => r.label).join("; ");
}

/**
 * `requiredRoles` as it comes back from the database (jsonb), narrowed to the
 * shape above or rejected. A row somebody edited by hand into a different
 * shape reads as an empty requirement list rather than a crash - and the
 * screen says so by showing nothing required, which is the honest rendering
 * of "we could not read what is required".
 */
export function parseRoleRequirements(value: unknown): RoleRequirement[] {
  if (!Array.isArray(value)) return [];
  const out: RoleRequirement[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const label = (item as { label?: unknown }).label;
    const anyOf = (item as { anyOf?: unknown }).anyOf;
    if (typeof label !== "string" || !Array.isArray(anyOf)) continue;
    const alternatives: string[][] = [];
    for (const alt of anyOf) {
      if (!Array.isArray(alt) || !alt.every((r) => typeof r === "string")) continue;
      alternatives.push(alt as string[]);
    }
    out.push({ label, anyOf: alternatives });
  }
  return out;
}
