import { unitKind } from "./units";
import type { PointSuggestion } from "./types";

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
 * is not in the name.
 *
 * The next integrator will write `VAV1_ZN_T` or `AHU1_SAT` and none of this
 * will catch it. That is the intended failure: no suggestion, a person
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

const SETPOINT_WORD = /(setpoint|stpt|_sp\b|sp$)/i;

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
    test: /^VAV[-_ ]?(\d{1,3})(?!\d).*Zone[_ ]?Temp(erature)?$/i,
    role: "zone_temp",
    setpoint: false,
    equipment: (m) => ({ name: `VAV-${m[1]}`, equipType: "vav" }),
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
    if (s.equipmentName !== null && s.equipmentId === null && s.equipType !== null) {
      const key = s.equipmentName.toLowerCase();
      if (!create.has(key)) create.set(key, { name: s.equipmentName, equipType: s.equipType });
      equipmentName = create.get(key)!.name;
    }
    const batchKey = `${s.role ?? ""}|${s.equipmentId ?? ""}|${equipmentName?.toLowerCase() ?? ""}`;
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

/** What the engine needs to know about one point. */
export interface SuggestionSubject {
  niagaraHistoryName: string;
  niagaraDisplayName: string | null;
  unit: string | null;
  pointRole: string | null;
  equipmentId: string | null;
  collected: boolean;
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

export function suggestClassification(
  point: SuggestionSubject,
  roles: ReadonlyMap<string, RoleFacts>,
  equipment: readonly EquipmentFacts[],
): PointSuggestion | null {
  // Rule 6.
  if (!point.collected) return null;
  // Rule 5: nothing left to suggest.
  if (point.pointRole !== null && point.equipmentId !== null) return null;

  const name = point.niagaraDisplayName ?? decodeNiagaraName(point.niagaraHistoryName);
  const hasSetpointWord = SETPOINT_WORD.test(name);

  const hits: Array<{ pattern: NamePattern; match: RegExpMatchArray }> = [];
  for (const pattern of SUGGESTION_PATTERNS) {
    // Rule 1.
    if (pattern.setpoint !== hasSetpointWord) continue;
    const match = name.match(pattern.test);
    if (match !== null) hits.push({ pattern, match });
  }
  const first = hits[0];
  if (first === undefined) return null;

  // Rule 2: agreement or silence.
  const roleKeys = new Set(hits.map((h) => h.pattern.role));
  if (roleKeys.size !== 1) return null;
  const roleKey = first.pattern.role;

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

  // The most specific hit - the one that names equipment - speaks for the
  // group. Patterns agree on the role (rule 2), so only the equipment half
  // can differ, and at most one pattern names any.
  const lead = hits.find((h) => h.pattern.equipment !== undefined) ?? first;
  const named =
    lead.pattern.equipment !== undefined ? lead.pattern.equipment(lead.match) : null;

  const suggestRole = point.pointRole === null;
  const suggestEquipment = point.equipmentId === null && named !== null;
  if (!suggestRole && !suggestEquipment) return null;

  const existing =
    named === null
      ? undefined
      : equipment.find((e) => e.name.toLowerCase() === named.name.toLowerCase());

  return {
    role: suggestRole ? roleKey : null,
    roleName: suggestRole ? role.displayName : null,
    equipmentName: suggestEquipment ? named!.name : null,
    equipmentId: suggestEquipment ? (existing?.equipmentId ?? null) : null,
    equipType: suggestEquipment && existing === undefined ? named!.equipType : null,
    pattern: lead.pattern.id,
    confidence: lead.pattern.confidence,
  };
}
