import { equipmentKey, parsePointName } from "./name-prefix";

/**
 * When the STATION is the equipment (2026-11-23).
 *
 * CEI_JCI_N2 imports three controllers as via-parent stations, and each is one
 * piece of equipment: CEI_AHU_7 is the air handler AHU_7, CEI_AHU_8 is AHU_8,
 * CEI_PLANT the cooling plant. Their point names were read from production on
 * 2026-11-23 (docs/fixtures/cei-controller-point-names.txt): the AHU points
 * write their unit at the front (`AHU_7_Da_Temp`, and eight `AHU_07_...`), the
 * plant's write none (`Clg_Plant_Chws_Temp`). Either way the station's name
 * says which unit they belong to, and that is what this module reads. Pure, no
 * database; the assignment pass (auto-assign.ts) acts on it.
 *
 * THE RULE. A station whose name ENDS with an equipment token is that
 * equipment:
 *
 *   - a unit token, letters and a number: `AHU_7` -> ahu, `RTU_3` -> rtu
 *     (the air-handler rows of PREFIX_TYPE_RULES; a station is never a VAV);
 *   - a plant word: `CHILLER` -> chiller, `BOILER` -> boiler, `CHW` ->
 *     plant_chw, `HW` -> plant_hw, and `PLANT`, whose type the points decide
 *     (a `CHW_PLANT` or `HW_PLANT` qualifier decides it outright).
 *
 * `CEI_JCI_N2` ends with `N2`, which is no unit: a JACE is not equipment.
 *
 * WHICH POINTS. A point on such a station that names NO unit, or names the
 * station's own unit (`AHU_07_Oa_Temp` on CEI_AHU_7 - leading zeros are not
 * a different unit), belongs to it. A point whose name carries a DIFFERENT
 * unit (`V4_22/SpaceTemp` on CEI_AHU_7) is left to the name-prefix rule.
 *
 * A PLANT. `PLANT` alone: each point's name is read for a side - cooling
 * (`CHW...`, `CH`/`CH1`, `CHILLER...`, `CLG`) or heating (`HW...`, `BLR...`,
 * `BOILER...`, `HTG`). All one side: one piece, plant_chw or plant_hw, and
 * every point belongs to it. Both sides on one station: SPLIT into
 * `<token>_CHW` (plant_chw) and `<token>_HW` (plant_hw) - the plant types,
 * because each half carries a loop's temperatures and pumps, not one
 * machine's - and a point that names neither side, or both, is left for a
 * person. Neither side anywhere: nothing, a person decides.
 */

/** Letters a station's unit token may have, and the type each means: the air handlers. */
export const STATION_UNIT_TYPES: Readonly<Record<string, string>> = {
  AHU: "ahu",
  RTU: "rtu",
};

/** Plant words a station name may end with, and the type each fixes (null: the points decide). */
export const STATION_PLANT_TYPES: Readonly<Record<string, string | null>> = {
  PLANT: null,
  CHW: "plant_chw",
  HW: "plant_hw",
  CHILLER: "chiller",
  CHILLERS: "chiller",
  BOILER: "boiler",
  BOILERS: "boiler",
};

/** A qualifier before PLANT that fixes the type: `CHW_PLANT`, `HW_PLANT`, `CLG_PLANT`. */
const PLANT_QUALIFIERS: Readonly<Record<string, string>> = {
  CHW: "plant_chw",
  CLG: "plant_chw",
  HW: "plant_hw",
  HTG: "plant_hw",
};

export interface StationUnit {
  /** As the station name writes it: `AHU_7`, `PLANT`, `CHW_PLANT`. */
  token: string;
  kind: "unit" | "plant";
  /** The type, or null for a bare PLANT whose points decide. */
  equipType: string | null;
  /** One sentence for the audit row. */
  reason: string;
}

const UNIT_AT_END = new RegExp(
  `(?:^|[^A-Za-z0-9])((${Object.keys(STATION_UNIT_TYPES).join("|")})[-_ ]?\\d{1,3}[A-Za-z]?)$`,
  "i",
);

/** The equipment a station's name says it is, or null. */
export function stationUnit(stationName: string): StationUnit | null {
  const name = stationName.trim();
  const unit = UNIT_AT_END.exec(name);
  if (unit !== null) {
    const token = unit[1]!;
    const type = STATION_UNIT_TYPES[unit[2]!.toUpperCase()]!;
    return {
      token,
      kind: "unit",
      equipType: type,
      reason: `The station ${name} is named for the unit ${token}: its points are that unit's.`,
    };
  }

  const words = name.split(/[^A-Za-z0-9]+/).filter((w) => w.length > 0);
  const last = words.at(-1)?.toUpperCase();
  if (last === undefined || !(last in STATION_PLANT_TYPES)) return null;
  const before = words.at(-2)?.toUpperCase();
  if (last === "PLANT" && before !== undefined && before in PLANT_QUALIFIERS) {
    const token = `${words.at(-2)}_${words.at(-1)}`;
    return {
      token,
      kind: "plant",
      equipType: PLANT_QUALIFIERS[before]!,
      reason: `The station ${name} is named for the plant ${token}: its points are that plant's.`,
    };
  }
  const token = words.at(-1)!;
  return {
    token,
    kind: "plant",
    equipType: STATION_PLANT_TYPES[last]!,
    reason: `The station ${name} is named for the plant ${token}: its points are that plant's.`,
  };
}

/** Unit keys with leading zeros dropped: `AHU_07` and `AHU_7` are one unit. */
export function unitKey(name: string): string {
  return equipmentKey(name).replace(/(^|[^0-9])0+(?=\d)/g, "$1");
}

/**
 * Whether a point on this station belongs to the station's equipment: its
 * name names no unit, or names this one.
 */
export function pointBelongsToStation(unit: StationUnit, pointName: string): boolean {
  const parsed = parsePointName(pointName);
  if (parsed.prefix === null) return true;
  return unitKey(parsed.prefix) === unitKey(unit.token);
}

export type PlantSide = "cooling" | "heating";

const COOLING_WORD = /^(CHW[A-Z0-9]*|CH\d*|CHILLER[A-Z0-9]*|CHLR[A-Z0-9]*|CLG)$/;
const HEATING_WORD = /^(HW[A-Z0-9]*|BLR[A-Z0-9]*|BOILER[A-Z0-9]*|HTG)$/;

/** Which side of a plant a point's name is on; null for neither or both. */
export function plantSide(pointName: string): PlantSide | null {
  const words = pointName.toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length > 0);
  const cooling = words.some((w) => COOLING_WORD.test(w));
  const heating = words.some((w) => HEATING_WORD.test(w));
  if (cooling === heating) return null;
  return cooling ? "cooling" : "heating";
}

/** One piece of equipment the station implies, and the points that belong to it. */
export interface StationPiece {
  name: string;
  equipType: string;
  reason: string;
  pointIds: string[];
}

/**
 * The pieces a station implies, over the points it would attach. `all` is
 * every collected point's name on the station, so a plant's type does not
 * change as its points are attached pass by pass; `candidates` are the ones
 * that may be attached now.
 */
export function planStationPieces(
  unit: StationUnit,
  all: ReadonlyArray<{ name: string }>,
  candidates: ReadonlyArray<{ pointId: string; name: string }>,
): StationPiece[] {
  const mine = candidates.filter((p) => pointBelongsToStation(unit, p.name));
  if (mine.length === 0) return [];
  if (unit.equipType !== null) {
    return [{ name: unit.token, equipType: unit.equipType, reason: unit.reason, pointIds: mine.map((p) => p.pointId) }];
  }

  // A bare PLANT: the points decide.
  const sides = all.filter((p) => pointBelongsToStation(unit, p.name)).map((p) => plantSide(p.name));
  const cooling = sides.includes("cooling");
  const heating = sides.includes("heating");
  if (!cooling && !heating) return [];
  if (cooling !== heating) {
    const type = cooling ? "plant_chw" : "plant_hw";
    const what = cooling ? "chilled water" : "hot water";
    return [
      {
        name: unit.token,
        equipType: type,
        reason: `${unit.reason} Its points name only the ${what} side, so it is a ${what} plant.`,
        pointIds: mine.map((p) => p.pointId),
      },
    ];
  }
  const half = (side: PlantSide, suffix: string, type: string, what: string): StationPiece => ({
    name: `${unit.token}_${suffix}`,
    equipType: type,
    reason: `${unit.reason} Its points name both the chilled and the hot water side; this one names the ${what} side.`,
    pointIds: mine.filter((p) => plantSide(p.name) === side).map((p) => p.pointId),
  });
  return [half("cooling", "CHW", "plant_chw", "chilled water"), half("heating", "HW", "plant_hw", "hot water")].filter(
    (piece) => piece.pointIds.length > 0,
  );
}
