import { parseRoleRequirements, type RoleRequirement } from "../library";
import type { EquipmentTypeFound, EquipmentUnit, OccupancySource, PointSeries, UnitClassification } from "./types";

/**
 * Jim's Steps 1 and 2 (Reports, Phase 2): classify each unit from its
 * points, then decide per question whether it can be answered at all.
 *
 * STEP 1. "Valve commands mean hydronic. Compressor status or cooling stage
 * points mean DX. Heat stage points mean gas or electric heat. A unit can be
 * more than one." Read from the roles present on the unit's points, and
 * written to the inventory as one line PER UNIT ("RV: DX with economizer
 * (compressors not trended)"). The inventory's "Equipment types found" line
 * is a different thing: the equipment TYPES the building has, by count
 * (one rooftop unit, ten VAV boxes), read from bas_equipment.equip_type.
 * Until 2026-11-12 that line printed the Step 1 words instead - the office
 * read "Equipment types found: economizer", a classification tag standing
 * where the reader expected the equipment list.
 *
 * APPLICABILITY. A question applies to the equipment TYPES its library row
 * names (the spec's Applies-to column), read from bas_equipment.equip_type,
 * with the spec's three sub-types narrowed by the role that defines them:
 * "VAV with reheat" needs a reheat valve, "with economizer" needs an outside
 * air damper. "Hydronic heating" and "hydronic cooling" are the plant types
 * (boiler, chiller, the two plants) or any listed unit carrying the water
 * roles. A question with no applicable unit is NOT APPLICABLE and leaves the
 * report. So an office with one rooftop unit and ten VAVs has the DX
 * questions apply - a rooftop unit is DX by type, whether or not its
 * compressors are trended - and the hydronic ones not.
 *
 * STEP 2. "For each remaining question, check whether every required point
 * exists and has trend data for at least 80% of the period." Per applicable
 * unit, each requirement group in `required_roles` is met when one of its
 * alternatives has every role present on the unit at or above
 * `min_coverage`. An occupancy group is met by the station's occupancy
 * source (a trended point, or the building's manual hours). A unit with a
 * group unmet is skipped and the group's label - the spec's own words - is
 * what the report names. A question with no unit left is NOT MONITORED.
 *
 * Neither outcome affects the building status.
 */

export const DX_TYPES: readonly string[] = ["rtu", "split_system", "crac", "vrf_outdoor", "vrf_indoor"];
export const HYDRONIC_HEATING_TYPES: readonly string[] = ["boiler", "plant_hw"];
export const HYDRONIC_COOLING_TYPES: readonly string[] = ["chiller", "plant_chw"];

export function classify(points: PointSeries[]): Pick<EquipmentUnit, "roles" | "hydronic" | "dx" | "stagedHeat" | "economizer" | "reheat"> {
  const roles = new Set<string>();
  for (const p of points) if (p.role !== null) roles.add(p.role);
  const has = (r: string) => roles.has(r);
  return {
    roles,
    hydronic: has("cooling_valve_cmd") || has("heating_valve_cmd") || has("reheat_valve_cmd"),
    dx: has("compressor_cmd") || has("compressor_status") || has("cooling_stage_cmd"),
    stagedHeat: has("heating_stage_cmd"),
    economizer: has("oa_damper_cmd"),
    reheat: has("reheat_valve_cmd"),
  };
}

/** The label the inventory prints for a unit with no equipment type. */
export const NO_TYPE_LABEL = "no type set";

/**
 * The inventory line: which kinds of equipment are in scope, by count,
 * most numerous first and then by name. A unit with no type is counted
 * under "no type set" rather than dropped, because it is in scope and the
 * reader should know it cannot be matched to any question.
 */
export function equipmentTypesFound(units: EquipmentUnit[]): EquipmentTypeFound[] {
  const byType = new Map<string, EquipmentTypeFound>();
  for (const u of units) {
    const key = u.equipType ?? "";
    const existing = byType.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      continue;
    }
    byType.set(key, {
      equipType: u.equipType,
      label: u.equipType === null ? NO_TYPE_LABEL : (u.equipTypeLabel ?? u.equipType),
      count: 1,
    });
  }
  return [...byType.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * Jim's Step 1 for one unit, in words, or null when the unit's points and
 * type say nothing: "hydronic", "DX with economizer", "DX (by type;
 * compressors not trended)", "gas or electric heat", "with reheat".
 *
 * DX is said two ways on purpose. From a compressor or cooling-stage role
 * it is the spec's own rule. From the type alone (a rooftop unit with no
 * compressor point) it is what makes the DX questions APPLY, and the
 * parenthesis says why they will read Not Monitored.
 */
export function classificationText(unit: Pick<EquipmentUnit, "equipType" | "hydronic" | "dx" | "stagedHeat" | "economizer" | "reheat">): string | null {
  const parts: string[] = [];
  if (unit.hydronic || HYDRONIC_HEATING_TYPES.includes(unit.equipType ?? "") || HYDRONIC_COOLING_TYPES.includes(unit.equipType ?? "")) {
    parts.push("hydronic");
  }
  if (unit.dx) parts.push("DX");
  else if (DX_TYPES.includes(unit.equipType ?? "")) parts.push("DX (by type; compressors not trended)");
  if (unit.stagedHeat) parts.push("gas or electric heat");
  const qualifiers: string[] = [];
  if (unit.economizer) qualifiers.push("economizer");
  if (unit.reheat) qualifiers.push("reheat");
  if (parts.length === 0 && qualifiers.length === 0) return null;
  const head = parts.join(" and ");
  if (qualifiers.length === 0) return head;
  const tail = `with ${qualifiers.join(" and ")}`;
  return head.length === 0 ? tail : `${head} ${tail}`;
}

/** Step 1 per unit, for the inventory's Classification lines; units that classify as nothing are left out. */
export function classifications(units: EquipmentUnit[]): UnitClassification[] {
  const out: UnitClassification[] = [];
  for (const u of units) {
    const text = classificationText(u);
    if (text === null) continue;
    out.push({ equipmentId: u.equipmentId, name: u.name, equipType: u.equipType, text });
  }
  return out;
}

export interface LibraryRowForEngine {
  key: string;
  position: number;
  section: string;
  text: string;
  kind: string;
  appliesToLabel: string;
  appliesToEquipment: string[];
  requiredRoles: unknown;
  minCoverage: number;
}

/** Which units a question applies to, by type and the spec's sub-types. */
export function applicableUnits(question: LibraryRowForEngine, units: EquipmentUnit[]): EquipmentUnit[] {
  const types = question.appliesToEquipment;
  let candidates = types.length === 0 ? units : units.filter((u) => u.equipType !== null && types.includes(u.equipType));

  switch (question.key) {
    case "q08_reheat_open_above_cooling_sp":
      candidates = candidates.filter((u) => u.reheat);
      break;
    case "q12_economizer_at_minimum":
    case "q17_compressors_during_economizer":
      candidates = candidates.filter((u) => u.economizer);
      break;
    case "q13_hw_supply_and_delta_t":
      candidates = units.filter(
        (u) => HYDRONIC_HEATING_TYPES.includes(u.equipType ?? "") || [...u.roles].some((r) => r.startsWith("hw_")),
      );
      break;
    case "q14_chw_supply_and_delta_t":
      candidates = units.filter(
        (u) => HYDRONIC_COOLING_TYPES.includes(u.equipType ?? "") || [...u.roles].some((r) => r.startsWith("chw_")),
      );
      break;
    case "q03_zone_comfort":
    case "q04_worst_zones":
      // A zone is wherever a room temperature is trended.
      candidates = units.filter((u) => u.roles.has("zone_temp"));
      break;
    default:
      break;
  }
  return candidates;
}

const OCCUPANCY_ROLES: readonly string[] = ["occupancy_status", "occupancy_cmd"];

function isOccupancyGroup(group: RoleRequirement): boolean {
  return group.anyOf.every((alt) => alt.every((r) => OCCUPANCY_ROLES.includes(r)));
}

export interface RequirementCheck {
  met: boolean;
  /** The labels of the unmet groups, the spec's words. */
  missing: string[];
  /** Points present but under coverage, by name with the figure. */
  lowCoverage: Array<{ name: string; coverage: number }>;
}

/**
 * Step 2 for one unit. A role counts as present when a point on the unit
 * carries it with coverage at or above the floor; a point on the unit's
 * STATION with the role also counts for building-level roles (outside air
 * temperature lives on the rooftop unit and serves every VAV).
 */
export function checkRequirements(
  question: LibraryRowForEngine,
  unit: EquipmentUnit,
  stationPoints: PointSeries[],
  occupancy: OccupancySource | null,
  excluded: Set<string>,
): RequirementCheck {
  const groups = parseRoleRequirements(question.requiredRoles);
  const missing: string[] = [];
  const lowCoverage: Array<{ name: string; coverage: number }> = [];

  const pointFor = (role: string): PointSeries | undefined =>
    unit.points.find((p) => p.role === role && !excluded.has(p.pointId)) ??
    (BUILDING_LEVEL_ROLES.includes(role) ? stationPoints.find((p) => p.role === role && !excluded.has(p.pointId)) : undefined);

  for (const group of groups) {
    if (isOccupancyGroup(group)) {
      if (occupancy === null || occupancy.kind === "none") missing.push(group.label);
      continue;
    }
    let satisfied = false;
    const under: Array<{ name: string; coverage: number }> = [];
    for (const alternative of group.anyOf) {
      const points = alternative.map(pointFor);
      if (points.some((p) => p === undefined)) continue;
      const short = (points as PointSeries[]).filter((p) => p.coverage < question.minCoverage);
      if (short.length === 0) {
        satisfied = true;
        break;
      }
      under.push(...short.map((p) => ({ name: p.name, coverage: p.coverage })));
    }
    if (!satisfied) {
      // Present but under coverage is said as such: the point exists, and the
      // spec's 80% rule is what kept the question from running.
      const worst = under.length === 0 ? null : Math.min(...under.map((u) => u.coverage));
      missing.push(worst === null ? group.label : `${group.label} (coverage ${Math.round(worst * 100)}%)`);
      lowCoverage.push(...under);
    }
  }

  return { met: missing.length === 0, missing, lowCoverage };
}

/** Roles that describe the building rather than one unit, satisfied from anywhere on the station. */
export const BUILDING_LEVEL_ROLES: readonly string[] = ["outside_air_temp", "outside_air_humidity"];

export interface QuestionDecision {
  outcome: "not_applicable" | "not_monitored" | "runnable";
  reason: string | null;
  missing: string[];
  /** Units the question runs over. */
  qualified: EquipmentUnit[];
  skipped: Array<{ name: string; reason: string }>;
  lowCoverage: Array<{ name: string; coverage: number }>;
}

export function decideQuestion(
  question: LibraryRowForEngine,
  units: EquipmentUnit[],
  pointsByStation: Map<string, PointSeries[]>,
  occupancyByStation: Map<string, OccupancySource>,
  stationOf: (unit: EquipmentUnit) => string | null,
  excluded: Set<string>,
): QuestionDecision {
  const applicable = applicableUnits(question, units);
  if (applicable.length === 0 && question.appliesToEquipment.length > 0) {
    return {
      outcome: "not_applicable",
      reason: `no ${question.appliesToLabel.toLowerCase()} on this building`,
      missing: [],
      qualified: [],
      skipped: [],
      lowCoverage: [],
    };
  }
  if (applicable.length === 0) {
    // A building-level question with no unit to judge: nothing trended that
    // it could run over. That is not monitored, not inapplicable.
    const groups = parseRoleRequirements(question.requiredRoles);
    return {
      outcome: "not_monitored",
      reason: null,
      missing: groups.map((g) => g.label),
      qualified: [],
      skipped: [],
      lowCoverage: [],
    };
  }

  const qualified: EquipmentUnit[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const missingUnion = new Set<string>();
  // A function rather than a ternary on the variable: TypeScript narrows a
  // null-initialised let to null at the top of the loop and types the
  // spread as never.
  const intersectMissing = (acc: Set<string> | null, next: readonly string[]): Set<string> =>
    acc === null ? new Set(next) : new Set([...acc].filter((m) => next.includes(m)));
  // What EVERY skipped unit lacks is what makes the question Not Monitored;
  // what one unit alone lacks (a sensor Data Health excluded, say) belongs
  // in that unit's skipped line, not in the building-wide list. The union
  // is the fallback when the units miss different things.
  let missingAll: Set<string> | null = null;
  const lowCoverage: Array<{ name: string; coverage: number }> = [];

  for (const unit of applicable) {
    const station = stationOf(unit);
    const check = checkRequirements(
      question,
      unit,
      station === null ? [] : (pointsByStation.get(station) ?? []),
      station === null ? null : (occupancyByStation.get(station) ?? null),
      excluded,
    );
    if (check.met) {
      qualified.push(unit);
    } else {
      skipped.push({ name: unit.name, reason: `missing ${check.missing.join("; ")}` });
      for (const m of check.missing) missingUnion.add(m);
      missingAll = intersectMissing(missingAll, check.missing);
      lowCoverage.push(...check.lowCoverage);
    }
  }

  const missing = missingAll !== null && missingAll.size > 0 ? [...missingAll] : [...missingUnion];
  if (qualified.length === 0) {
    return { outcome: "not_monitored", reason: null, missing, qualified, skipped, lowCoverage };
  }
  return { outcome: "runnable", reason: null, missing, qualified, skipped, lowCoverage };
}
