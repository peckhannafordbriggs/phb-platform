import { equipmentKey, parsePointName, prefixType } from "./name-prefix";
import { STATE_DATA_TYPES } from "./plausibility";
import { unitKind, type UnitKind } from "./units";
import type { PointSuggestion, SuggestionLevel } from "./types";

/**
 * Name-pattern suggestions for a point's role and equipment (B8.5).
 *
 * NOTHING HERE WRITES. This module returns a sentence for a row; a person
 * clicks it, and the click is what reaches the database. `getStationPoints`
 * calls this on every read and the read is proven not to change a row
 * (tests/bas-point-classification.test.ts). The lab's `Temp1`-`Temp3` are the
 * canon: nobody knows what they measure, no pattern below says anything about
 * a bare "Temp", and they must end B8.5 exactly as unclassified as they began.
 *
 * WHAT "CONFIDENT" MEANS. A pattern fires only when the decoded name carries a
 * whole measurement PHRASE - "Zone Temperature", "Duct Static Pressure",
 * "Outside Air Damper" - not a word that could belong to several. "Temp" alone
 * says nothing (zone? supply? water?), "Supply_Temp" without "Air" says nothing
 * (the RTU's is air; a boiler's is water), "Occupied" alone says nothing (a
 * status or a sensor). Each pattern's `confidence` string is that argument in
 * one sentence, and it is shown on the row. The rules that apply to every
 * pattern:
 *
 *   1. A name that carries a SETPOINT word (setpoint, stpt, _sp, sp at the
 *      end) can only match a setpoint role, and one that does not can only
 *      match a measurement or command role. "Zone Temperature Setpoint" is
 *      not a zone temperature.
 *   2. If two patterns agree on a role they are one suggestion; if they
 *      disagree there is NO suggestion. Ambiguity is silence, not a guess.
 *   3. The point's recorded unit, when there is one and it is of a kind the
 *      platform knows, must agree with the role's typical unit. A
 *      "ZoneTemperature" recorded in percent is not a zone temperature.
 *      (2026-11-19) And a point the station declares a state - `bool`, `str`
 *      or `enum`, STATE_DATA_TYPES - is never given a role with a physical
 *      unit: a boolean called SpaceTemp is not a temperature.
 *   4. The role must be in bas_point_roles as this database holds it. A
 *      suggestion for a role that cannot be assigned is noise.
 *   5. Only the missing half is suggested. A point that already has a role
 *      gets no role suggestion, and one with equipment no equipment one.
 *   6. An uncollected point gets no suggestion. The four Niagara system logs
 *      and the retired half of a `_cfg0` pair were left unclassified on live
 *      deliberately, and suggesting roles for retired histories is noise.
 *
 * The one EQUIPMENT pattern is the VAV one: `VAV-3 120-121_ZoneTemperature`
 * names its box at the start, so the suggestion is equipment `VAV-3` of type
 * `vav`, matched to existing equipment of that name on the building or
 * offered as "new". Nothing here suggests a parent: the RTU a VAV sits under
 * is not in the name. Every other unit a name implies is the job of
 * "Equipment from name prefixes" (name-prefix.ts), which shows a preview a
 * person edits, because only there can a wrong type be corrected before it
 * is written.
 *
 * SUFFIX TOKENS (2026-11-19). The CEI JACE names its points `V4_22/SpaceTemp`,
 * `AHU_7/DA_T`, `XTM_109/AHU_7_FinalFilter`: a unit, then an abbreviation.
 * TAIL_PATTERNS read the abbreviation - the text after the prefix
 * name-prefix.ts finds, compared WHOLE with its separators removed, so
 * `DA_T`, `DA-T` and `DAT` are one token and `122-125_ZoneTemperature` is
 * none (the phrase patterns above already read that one). Two things are
 * different about them:
 *
 *   - THE EQUIPMENT DECIDES SOME ROLES. The vocabulary says discharge air is
 *     what leaves a TERMINAL unit and supply air what leaves an air handler
 *     (`discharge_air_temp` / `supply_air_temp`; reports/library.ts reads
 *     the two that way), so `V4_22/DaTemp` is a discharge air temperature
 *     and `AHU_7/DA_T` a supply air temperature. The class comes from the
 *     equipment the point is attached to, when it is; else from the type
 *     the name's prefix implies; else it is unknown. A class a token does
 *     not name is silence.
 *   - EVERY SUGGESTION HAS A LEVEL. `high`: the token names one role and the
 *     equipment does not change it, or the equipment settles it. `medium`:
 *     the token most likely means that role, and a person should look first -
 *     a bare `Humidity` or `CO2` on a unit whose type is unknown. Only `high`
 *     goes through "Apply all high-confidence suggestions"; a medium one is
 *     applied by its own row's button, one click per point. Every B8.5
 *     phrase pattern is `high`.
 *
 * The next integrator will write `VAV1_ZN_T` or `AHU1_SAT` and some of this
 * will not catch it. That is the intended failure: no suggestion, a person
 * classifies by hand, and the vocabulary (not this file) is what makes the
 * result queryable. Patterns are added here when a real building's names
 * justify them, with a line in the PR saying what each one means.
 */

interface NamePattern {
  /** Stable id, shown nowhere but carried on the suggestion and in tests. */
  id: string;
  /** Over the DECODED name - Niagara's display name, or the key with $-hex escapes decoded. */
  test: RegExp;
  role: string;
  /** Whether this pattern names a setpoint role. Rule 1 above. */
  setpoint: boolean;
  /** Equipment named by the pattern's capture groups, when it names one. */
  equipment?: (match: RegExpMatchArray) => { name: string; equipType: string };
  confidence: string;
}

/** Rule 1. Exported so the token table can be held to it. */
export const SETPOINT_WORD = /(setpoint|stpt|_sp\b|sp$)/i;

/**
 * The patterns, as they stand. Each one earned its place from a real name on
 * one of the two live stations; the comment says which.
 */
export const SUGGESTION_PATTERNS: readonly NamePattern[] = [
  {
    // VAV-1 130-132_ZoneTemperature ... VAV-10 107_ZoneTemperature (office).
    id: "vav_zone_temp",
    // (?!\d) rather than \b: "VAV-3_ZoneTemperature" has no word boundary
    // after the 3, and it names its box as plainly as "VAV-3 120-121_...".
    test: /^(VAV[-_ ]?(\d{1,3}))(?!\d).*Zone[_ ]?Temp(erature)?$/i,
    role: "zone_temp",
    setpoint: false,
    // As the name writes it (2026-11-19), the same rule name-prefix.ts uses:
    // the office's "VAV-3" is unchanged, and CEI's "VAV_10" stays "VAV_10".
    // Matching existing equipment is by equipmentKey, so the two spellings
    // of one box are one box.
    equipment: (m) => ({ name: m[1]!, equipType: "vav" }),
    confidence:
      "The name starts with a VAV box number and ends with the phrase Zone Temperature, so both the role and the box are stated outright.",
  },
  {
    // The role half of the above, for a zone temperature with no box in its name.
    id: "zone_temp",
    test: /Zone[_ ]?Temp(erature)?$/i,
    role: "zone_temp",
    setpoint: false,
    confidence:
      "The name ends with the phrase Zone Temperature and carries no setpoint word.",
  },
  {
    id: "zone_temp_sp",
    test: /Zone[_ ]?Temp(erature)?.*(Setpoint|Stpt|_SP$|SP$)/i,
    role: "zone_temp_sp",
    setpoint: true,
    confidence: "The name carries the phrase Zone Temperature followed by a setpoint word.",
  },
  {
    // Outside_Air_Temp_Analog_Input1 (office).
    id: "outside_air_temp",
    test: /(Outside|Outdoor)[_ ]?Air[_ ]?Temp(erature)?/i,
    role: "outside_air_temp",
    setpoint: false,
    confidence:
      "The name carries the phrase Outside Air Temperature and no setpoint word; there is one outside air temperature on a unit.",
  },
  {
    // Outside_Air_Damper_Analog_Output1 (office).
    id: "oa_damper_cmd",
    test: /(Outside|Outdoor)[_ ]?Air[_ ]?Damper/i,
    role: "oa_damper_cmd",
    setpoint: false,
    confidence:
      "The name carries the phrase Outside Air Damper; a damper history is its commanded position.",
  },
  {
    // Return Air Damper (office).
    id: "ra_damper_cmd",
    test: /Return[_ ]?Air[_ ]?Damper/i,
    role: "ra_damper_cmd",
    setpoint: false,
    confidence:
      "The name carries the phrase Return Air Damper; a damper history is its commanded position.",
  },
  {
    // Supply_Duct_Static_Pressure_Analog_Input (office).
    id: "duct_static_pressure",
    test: /Duct[_ ]?Static[_ ]?Pressure/i,
    role: "duct_static_pressure",
    setpoint: false,
    confidence:
      "The name carries the phrase Duct Static Pressure and no setpoint word.",
  },
  {
    // Supply_Duct_Static_Pressure_Setpoint (office).
    id: "duct_static_pressure_sp",
    test: /Duct[_ ]?Static[_ ]?Pressure.*(Setpoint|Stpt|_SP$|SP$)/i,
    role: "duct_static_pressure_sp",
    setpoint: true,
    confidence:
      "The name carries the phrase Duct Static Pressure followed by a setpoint word.",
  },
  {
    // RV_Supply_Fan_Speed_Analog_Output (office).
    id: "supply_fan_speed",
    test: /Supply[_ ]?Fan[_ ]?Speed/i,
    role: "supply_fan_speed",
    setpoint: false,
    confidence: "The name carries the phrase Supply Fan Speed.",
  },
  {
    // Deliberately requires "Air": the office's Supply_Temp_Analog_Input does
    // NOT match, because a boiler's supply temperature is water. That point is
    // classified by hand, and that is the right outcome.
    id: "supply_air_temp",
    test: /Supply[_ ]?Air[_ ]?Temp(erature)?/i,
    role: "supply_air_temp",
    setpoint: false,
    confidence:
      "The name carries the phrase Supply Air Temperature with the word Air present, so it is not a water temperature.",
  },
  {
    id: "supply_air_temp_sp",
    test: /Supply[_ ]?Air[_ ]?Temp(erature)?.*(Setpoint|Stpt|_SP$|SP$)/i,
    role: "supply_air_temp_sp",
    setpoint: true,
    confidence:
      "The name carries the phrase Supply Air Temperature followed by a setpoint word.",
  },
  {
    // OccupancyCommand (office). "Occupied" alone matches nothing.
    id: "occupancy_cmd",
    test: /^Occupancy[_ ]?(Command|Cmd)$/i,
    role: "occupancy_cmd",
    setpoint: false,
    confidence: "The whole name is Occupancy Command.",
  },
];

// ---------------------------------------------------------------------------
// Suffix tokens (2026-11-19)
// ---------------------------------------------------------------------------

/**
 * What a point is on, as far as a token's meaning goes. `terminal`: a box
 * that delivers air into a zone. `air_handler`: a unit that supplies a duct.
 * `other`: a type that is neither. `unknown`: no equipment, and a name whose
 * prefix implies no type.
 */
export type EquipmentClass = "terminal" | "air_handler" | "other" | "unknown";

export const TERMINAL_TYPES: readonly string[] = ["vav", "cav", "fcu"];
export const AIR_HANDLER_TYPES: readonly string[] = ["ahu", "rtu", "doas"];

export function equipmentClass(equipType: string | null): EquipmentClass {
  if (equipType === null) return "unknown";
  if (TERMINAL_TYPES.includes(equipType)) return "terminal";
  if (AIR_HANDLER_TYPES.includes(equipType)) return "air_handler";
  return "other";
}

interface Outcome {
  role: string;
  level: SuggestionLevel;
}

export interface TailPattern {
  id: string;
  /**
   * The whole tail, upper case with `-`, `_`, space and `.` removed. Exact
   * match only: `RA_CO2` is not `CO2`, and `OA_Humidity` is not `Humidity`.
   */
  tokens: readonly string[];
  /** Rule 1: whether the role is a setpoint. */
  setpoint: boolean;
  /** By the class of equipment the point is on. A class left out is silence. */
  byClass: Partial<Record<EquipmentClass, Outcome>>;
  /**
   * For a token that names a thing and not a quantity - a filter - the
   * role is decided by the value instead, and `byClass` is not read.
   */
  byValue?: (value: { dataType: string | null; unitKind: UnitKind }) => Outcome | null;
  confidence: string;
}

const everywhere = (role: string, level: SuggestionLevel): TailPattern["byClass"] => ({
  terminal: { role, level },
  air_handler: { role, level },
  other: { role, level },
  unknown: { role, level },
});

/** A discharge air token: the vocabulary's terminal/air-handler split. */
const dischargeAir = (terminal: string, airHandler: string): TailPattern["byClass"] => ({
  terminal: { role: terminal, level: "high" },
  air_handler: { role: airHandler, level: "high" },
});

/** A duct static token: an air handler's, never a terminal's. */
const ductStatic = (role: string, unknown: SuggestionLevel, airHandler: SuggestionLevel): TailPattern["byClass"] => ({
  air_handler: { role, level: airHandler },
  unknown: { role, level: unknown },
});

/** A zone sensor token: a terminal's for certain, an air handler's never said. */
const zoneSensor = (role: string): TailPattern["byClass"] => ({
  terminal: { role, level: "high" },
  unknown: { role, level: "medium" },
});

const STATE_TYPES = new Set(STATE_DATA_TYPES);

/**
 * The suffix tokens, CHOSEN 2026-11-19 from the CEI names given in the
 * request (`SpaceTemp`, `DaTemp`, `DA_T`, `OA_Enth`, `FinalFilter`,
 * `ZoneTemperature`) and the abbreviations the request listed beside them,
 * with their spelled-out forms and setpoints. Not one has been checked
 * against CEI's full list of 334 names, which is not in any database this
 * repository can read; Nathan's corrections land here.
 *
 * Deliberately absent: `DSP` and `DA_SP` (ending in SP, they read as a
 * setpoint under rule 1 - "duct static pressure" and "discharge setpoint"
 * are both real); `OA_Enth` (the vocabulary has no enthalpy role - add the
 * role first); a bare `SP`, `T`, `Temp` or `RoomT` (the lab's canon).
 */
export const TAIL_PATTERNS: readonly TailPattern[] = [
  {
    id: "tail_zone_temp",
    tokens: ["SPACETEMP", "SPACETEMPERATURE", "ZONETEMP", "ZONETEMPERATURE", "ZNT", "ZNTEMP"],
    setpoint: false,
    byClass: everywhere("zone_temp", "high"),
    confidence:
      "The suffix is a zone or space temperature token; it means that on any unit (a single-zone air handler's space sensor is a zone temperature too).",
  },
  {
    id: "tail_zone_temp_sp",
    tokens: ["SPACETEMPSP", "SPACETEMPSETPOINT", "ZONETEMPSP", "ZONETEMPSETPOINT", "ZNTSP"],
    setpoint: true,
    byClass: everywhere("zone_temp_sp", "high"),
    confidence: "The suffix is a zone or space temperature token followed by a setpoint word.",
  },
  {
    id: "tail_discharge_air_temp",
    tokens: ["DATEMP", "DAT", "DATEMPERATURE", "DISCHARGEAIRTEMP", "DISCHARGEAIRTEMPERATURE"],
    setpoint: false,
    byClass: dischargeAir("discharge_air_temp", "supply_air_temp"),
    confidence:
      "The suffix is discharge air temperature. The vocabulary calls a terminal unit's discharge air discharge_air_temp and an air handler's supply_air_temp, so the equipment decides; with no equipment type known, nothing is suggested.",
  },
  {
    id: "tail_discharge_air_temp_sp",
    tokens: ["DATEMPSP", "DATSP", "DATEMPSETPOINT", "DATSETPOINT", "DISCHARGEAIRTEMPSP"],
    setpoint: true,
    byClass: dischargeAir("discharge_air_temp_sp", "supply_air_temp_sp"),
    confidence:
      "The suffix is a discharge air temperature setpoint; as for the temperature, the equipment decides which setpoint role.",
  },
  {
    id: "tail_supply_air_temp",
    tokens: ["SAT", "SATEMP", "SATEMPERATURE"],
    setpoint: false,
    byClass: {
      air_handler: { role: "supply_air_temp", level: "high" },
      unknown: { role: "supply_air_temp", level: "high" },
    },
    confidence:
      "SA is supply AIR, so this is not a water temperature. On a terminal unit it could be the air arriving at the box, so nothing is suggested there.",
  },
  {
    id: "tail_supply_air_temp_sp",
    tokens: ["SATSP", "SATEMPSP", "SATSETPOINT"],
    setpoint: true,
    byClass: {
      air_handler: { role: "supply_air_temp_sp", level: "high" },
      unknown: { role: "supply_air_temp_sp", level: "high" },
    },
    confidence: "The suffix is a supply air temperature setpoint.",
  },
  {
    id: "tail_outside_air_temp",
    tokens: ["OAT", "OATEMP", "OATEMPERATURE", "OUTSIDEAIRTEMP", "OUTDOORAIRTEMP"],
    setpoint: false,
    byClass: everywhere("outside_air_temp", "high"),
    confidence: "OA is outside air; an outside air temperature means that on any unit.",
  },
  {
    id: "tail_return_air_temp",
    tokens: ["RAT", "RATEMP", "RATEMPERATURE", "RETURNAIRTEMP"],
    setpoint: false,
    byClass: everywhere("return_air_temp", "high"),
    confidence: "RA is return air; a return air temperature means that on any unit.",
  },
  {
    id: "tail_mixed_air_temp",
    tokens: ["MAT", "MATEMP", "MATEMPERATURE", "MIXEDAIRTEMP"],
    setpoint: false,
    byClass: everywhere("mixed_air_temp", "high"),
    confidence: "MA is mixed air; a mixed air temperature means that on any unit.",
  },
  {
    id: "tail_return_air_humidity",
    tokens: ["RAHUM", "RARH", "RAHUMIDITY", "RETURNAIRHUMIDITY"],
    setpoint: false,
    byClass: everywhere("return_air_humidity", "high"),
    confidence: "The suffix names return air humidity outright.",
  },
  {
    id: "tail_outside_air_humidity",
    tokens: ["OAHUM", "OARH", "OAHUMIDITY", "OUTSIDEAIRHUMIDITY"],
    setpoint: false,
    byClass: everywhere("outside_air_humidity", "high"),
    confidence: "The suffix names outside air humidity outright.",
  },
  {
    id: "tail_space_humidity",
    tokens: ["SPACEHUMIDITY", "SPACEHUM", "SPACERH", "ZONEHUMIDITY", "ZNHUM", "ZNRH"],
    setpoint: false,
    byClass: everywhere("space_humidity", "high"),
    confidence: "The suffix names space or zone humidity outright.",
  },
  {
    id: "tail_humidity",
    tokens: ["HUMIDITY", "HUM", "RH"],
    setpoint: false,
    byClass: zoneSensor("space_humidity"),
    confidence:
      "A bare humidity on a terminal unit is its room sensor. With no equipment type it is probably the space and worth a look; on an air handler it could be return, outside or space air, so nothing is suggested.",
  },
  {
    id: "tail_space_co2",
    tokens: ["SPACECO2", "ZONECO2", "ZNCO2"],
    setpoint: false,
    byClass: everywhere("space_co2", "high"),
    confidence: "The suffix names space or zone CO2 outright.",
  },
  {
    id: "tail_co2",
    tokens: ["CO2"],
    setpoint: false,
    byClass: zoneSensor("space_co2"),
    confidence:
      "A bare CO2 on a terminal unit is its room sensor. With no equipment type it is probably the space; on an air handler it is usually return air CO2, which the vocabulary has no role for, so nothing is suggested.",
  },
  {
    id: "tail_space_co2_sp",
    tokens: ["SPACECO2SP", "ZNCO2SP", "CO2SP", "CO2SETPOINT"],
    setpoint: true,
    byClass: zoneSensor("space_co2_sp"),
    confidence: "The suffix is a CO2 setpoint; on a terminal unit that is the space's.",
  },
  {
    id: "tail_duct_static",
    tokens: ["DASAP", "DUCTSTATIC", "DUCTSTATICPRESSURE", "DASTATIC", "SASTATIC"],
    setpoint: false,
    byClass: ductStatic("duct_static_pressure", "high", "high"),
    confidence:
      "The suffix is discharge or duct static pressure: the duct static an air handler's fan controls to. A terminal unit does not own one, so nothing is suggested there.",
  },
  {
    id: "tail_sap",
    tokens: ["SAP"],
    setpoint: false,
    byClass: ductStatic("duct_static_pressure", "medium", "medium"),
    confidence:
      "SAP is most often supply air (duct) static pressure, but it is short enough to be building static on some jobs; look before applying.",
  },
  {
    id: "tail_duct_static_sp",
    tokens: ["DASAPSP", "SAPSP", "DUCTSTATICSP", "DUCTSTATICSETPOINT", "DASTATICSP"],
    setpoint: true,
    byClass: ductStatic("duct_static_pressure_sp", "high", "high"),
    confidence: "The suffix is a duct static pressure setpoint.",
  },
  {
    id: "tail_filter",
    tokens: ["FINALFILTER", "PREFILTER", "FILTER", "FLTR"],
    setpoint: false,
    byClass: {},
    byValue: ({ dataType, unitKind: kind }) => {
      if (dataType === "bool") return { role: "filter_status", level: "high" };
      if (kind === "pressure") return { role: "filter_dp", level: "high" };
      if (dataType === "enum" || dataType === "str") return { role: "filter_status", level: "medium" };
      if (dataType === "real" || dataType === "int") return { role: "filter_dp", level: "medium" };
      return null;
    },
    confidence:
      "A filter point is a dirty-filter switch or a differential pressure, and the name does not say which: a boolean is the switch (filter_status), a pressure unit is the pressure (filter_dp). A number with no unit is probably the pressure; look first.",
  },
  {
    id: "tail_filter_dp",
    tokens: ["FILTERDP", "FINALFILTERDP", "PREFILTERDP", "FILTERDIFFPRESSURE"],
    setpoint: false,
    byClass: everywhere("filter_dp", "high"),
    confidence: "The suffix names a filter differential pressure outright.",
  },
  {
    id: "tail_filter_status",
    tokens: ["FILTERSTATUS", "FILTERALARM", "DIRTYFILTER"],
    setpoint: false,
    byClass: everywhere("filter_status", "high"),
    confidence: "The suffix names a dirty-filter status outright.",
  },
];

/** `DA_T` -> `DAT`; `Space Temp` -> `SPACETEMP`. */
export function compactToken(text: string): string {
  return text.toUpperCase().replace(/[-_ .]+/g, "");
}

/**
 * What "Apply all N suggestions" will send, as data (B8.5).
 *
 * Pure, so the component executes it and the acceptance test executes the
 * SAME plan through the routes - the test is then a statement about the
 * requests the UI makes, not a re-implementation of them. Equipment a
 * suggestion names but the building lacks is created once per distinct name
 * (case-insensitive, first spelling wins); then one bulk request per distinct
 * (role, equipment) pair. The caller resolves `equipmentName` to the id it
 * just created.
 *
 * Nothing in the plan is applied here. A plan is a list of requests a person
 * has been shown the count of and has confirmed.
 *
 * (2026-11-19) The SERVICE now executes this plan, in one transaction, for
 * "Apply all high-confidence suggestions" (applyHighConfidenceSuggestions);
 * the browser no longer runs it request by request. Distinct names are by
 * equipmentKey, so `VAV-3` and `VAV_3` are one creation.
 */
export interface SuggestionBatch {
  pointIds: string[];
  role: string | null;
  /** Existing equipment, when the suggestion matched one. */
  equipmentId: string | null;
  /** Equipment to be created first, when it did not. */
  equipmentName: string | null;
}

export interface SuggestionPlan {
  create: Array<{ name: string; equipType: string }>;
  batches: SuggestionBatch[];
}

export function planSuggestionBatches(
  points: ReadonlyArray<{ pointId: string; suggestion: PointSuggestion | null }>,
): SuggestionPlan {
  const create = new Map<string, { name: string; equipType: string }>();
  const batches = new Map<string, SuggestionBatch>();

  for (const point of points) {
    const s = point.suggestion;
    if (s === null) continue;
    let equipmentName: string | null = null;
    let createKey = "";
    if (s.equipmentName !== null && s.equipmentId === null && s.equipType !== null) {
      createKey = equipmentKey(s.equipmentName);
      if (!create.has(createKey)) create.set(createKey, { name: s.equipmentName, equipType: s.equipType });
      equipmentName = create.get(createKey)!.name;
    }
    const batchKey = `${s.role ?? ""}|${s.equipmentId ?? ""}|${createKey}`;
    const batch = batches.get(batchKey) ?? {
      pointIds: [],
      role: s.role,
      equipmentId: s.equipmentId,
      equipmentName,
    };
    batch.pointIds.push(point.pointId);
    batches.set(batchKey, batch);
  }

  return { create: [...create.values()], batches: [...batches.values()] };
}

/** `VAV$2d8$20104$2d105_ZoneTemperature` -> `VAV-8 104-105_ZoneTemperature`. */
export function decodeNiagaraName(historyName: string): string {
  return historyName.replace(/\$([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

/** The name the patterns read: Niagara's display name, else the decoded key. */
export function readableName(point: {
  niagaraHistoryName: string;
  niagaraDisplayName: string | null;
}): string {
  return point.niagaraDisplayName ?? decodeNiagaraName(point.niagaraHistoryName);
}

/** What the engine needs to know about one point. */
export interface SuggestionSubject {
  niagaraHistoryName: string;
  niagaraDisplayName: string | null;
  unit: string | null;
  pointRole: string | null;
  equipmentId: string | null;
  collected: boolean;
  /**
   * bas_points.data_type (2026-11-19): rule 3's state half, and the filter
   * token's tie-break. Absent reads as unknown.
   */
  dataType?: string | null;
  /**
   * The type of the equipment the point is attached to, when it is (2026-11-19).
   * A person's assignment outranks what the name implies.
   */
  equipmentType?: string | null;
}

/** The vocabulary as this database holds it, for rules 3 and 4. */
export interface RoleFacts {
  pointRole: string;
  displayName: string;
  typicalUnit: string | null;
}

/** Equipment already on the building, for matching a suggested name. */
export interface EquipmentFacts {
  equipmentId: string;
  name: string;
}

interface Hit {
  id: string;
  role: string;
  level: SuggestionLevel;
  confidence: string;
  equipment: { name: string; equipType: string } | null;
}

/** The B8.5 phrase patterns that fire on a name. */
function phraseHits(name: string, hasSetpointWord: boolean): Hit[] {
  const hits: Hit[] = [];
  for (const pattern of SUGGESTION_PATTERNS) {
    // Rule 1.
    if (pattern.setpoint !== hasSetpointWord) continue;
    const match = name.match(pattern.test);
    if (match === null) continue;
    hits.push({
      id: pattern.id,
      role: pattern.role,
      level: "high",
      confidence: pattern.confidence,
      equipment: pattern.equipment === undefined ? null : pattern.equipment(match),
    });
  }
  return hits;
}

/** The suffix token that fires on a name's tail, decided for this point. */
function tailHit(point: SuggestionSubject, name: string, hasSetpointWord: boolean): Hit | null {
  const parsed = parsePointName(name);
  const token = compactToken(parsed.tail);
  if (token.length === 0) return null;
  const pattern = TAIL_PATTERNS.find((p) => p.tokens.includes(token));
  // Rule 1, again: the whole name decides whether it is a setpoint.
  if (pattern === undefined || pattern.setpoint !== hasSetpointWord) return null;

  let outcome: Outcome | null | undefined;
  if (pattern.byValue !== undefined) {
    outcome = pattern.byValue({ dataType: point.dataType ?? null, unitKind: unitKind(point.unit) });
  } else {
    // The equipment the point is on, when it is; else what the name implies.
    const impliedType = parsed.prefix === null ? null : prefixType(parsed.prefix).equipType;
    const type = point.equipmentId !== null ? (point.equipmentType ?? null) : impliedType;
    outcome = pattern.byClass[equipmentClass(type)];
  }
  if (outcome === null || outcome === undefined) return null;
  return {
    id: pattern.id,
    role: outcome.role,
    level: outcome.level,
    confidence: pattern.confidence,
    equipment: null,
  };
}

export function suggestClassification(
  point: SuggestionSubject,
  roles: ReadonlyMap<string, RoleFacts>,
  equipment: readonly EquipmentFacts[],
): PointSuggestion | null {
  // Rule 6.
  if (!point.collected) return null;
  // Rule 5: nothing left to suggest.
  if (point.pointRole !== null && point.equipmentId !== null) return null;

  const name = readableName(point);
  const hasSetpointWord = SETPOINT_WORD.test(name);

  const hits = phraseHits(name, hasSetpointWord);
  const tail = tailHit(point, name, hasSetpointWord);
  if (tail !== null) hits.push(tail);
  const first = hits[0];
  if (first === undefined) return null;

  // Rule 2: agreement or silence.
  const roleKeys = new Set(hits.map((h) => h.role));
  if (roleKeys.size !== 1) return null;
  const roleKey = first.role;

  // Rule 4.
  const role = roles.get(roleKey);
  if (role === undefined) return null;

  // Rule 3.
  if (point.unit !== null && role.typicalUnit !== null) {
    const pointKind = unitKind(point.unit);
    const roleKind = unitKind(role.typicalUnit);
    if (pointKind !== "other" && roleKind !== "other" && pointKind !== roleKind) {
      return null;
    }
  }
  // Rule 3, the state half: a state point never takes a role with a unit.
  if (role.typicalUnit !== null && point.dataType != null && STATE_TYPES.has(point.dataType)) {
    return null;
  }

  // The most specific hit - the one that names equipment - speaks for the
  // group. Hits agree on the role (rule 2), so only the equipment half
  // can differ, and at most one pattern names any. Agreement is as sure as
  // its surest hit.
  const lead = hits.find((h) => h.equipment !== null) ?? first;
  const named = lead.equipment;
  const level: SuggestionLevel = hits.some((h) => h.level === "high") ? "high" : "medium";

  const suggestRole = point.pointRole === null;
  const suggestEquipment = point.equipmentId === null && named !== null;
  if (!suggestRole && !suggestEquipment) return null;

  const existing =
    named === null
      ? undefined
      : equipment.find((e) => equipmentKey(e.name) === equipmentKey(named.name));

  return {
    role: suggestRole ? roleKey : null,
    roleName: suggestRole ? role.displayName : null,
    equipmentName: suggestEquipment ? (existing?.name ?? named!.name) : null,
    equipmentId: suggestEquipment ? (existing?.equipmentId ?? null) : null,
    equipType: suggestEquipment && existing === undefined ? named!.equipType : null,
    pattern: lead.id,
    confidence: lead.confidence,
    level,
  };
}
