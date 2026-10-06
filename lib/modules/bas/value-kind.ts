/**
 * What KIND of value a point produces, and how a boolean one is worded.
 *
 * `bas_readings` has three value columns - `value_num`, `value_bool`,
 * `value_str` - and the collector fills exactly one of them per row, chosen
 * from the oBIX record's own type (`collector/obix.py` in phb-bas: `real` and
 * `int` go to value_num, `bool` to value_bool, everything else to value_str).
 * The same type is written to `bas_points.data_type` at discovery, from the
 * history's #RecordDef prototype, so the point's metadata already says which
 * column its readings live in. Checked against live on 2026-10-06: 39 points,
 * data_type agrees with the populated column on every one, and no point has
 * readings in more than one column.
 *
 * Until this module existed the Point Explorer read `value_num` only, so a
 * boolean point rendered as 421 null samples - an empty plot under a y-axis
 * that read -0.01 / 0.00 / 0.01 - and its tiles said "Distinct values 0 ·
 * Reads as a stuck sensor". A state is not a quantity, and the chart has to
 * know which it is drawing before it chooses an axis.
 *
 * `data_type` is the authority. `unknown` - the column's default, for a point
 * whose prototype was never read - falls back to whichever column the readings
 * in the window actually populate, and to numeric when there are none, which is
 * what the chart drew before. The fallback is a fallback: on live it decides
 * nothing today.
 *
 * Pure, shared by the service (which picks the SQL column from the kind) and
 * the chart (which picks the axis). See WHY-ITS-BUILT-THIS-WAY.md § 63.
 */

export type ValueKind = "numeric" | "boolean" | "string";

/**
 * The two words a boolean point's states are shown as. `on` is what `true`
 * reads as, `off` is `false`. Never a number: the axis, the tooltip and the
 * Latest tile all print these and nothing else for a boolean point.
 */
export interface BooleanStates {
  on: string;
  off: string;
}

/** How many rows in the window populate each value column. */
export interface PopulatedColumns {
  num: number;
  bool: number;
  str: number;
}

/**
 * The kind from the point's declared type alone. What the picker's list rows
 * carry, where no readings have been counted.
 */
export function valueKindFromDataType(dataType: string): ValueKind {
  switch (dataType) {
    case "bool":
      return "boolean";
    case "str":
    case "enum":
      return "string";
    case "real":
    case "int":
      return "numeric";
    default:
      // "unknown", "abstime", or a value this build has no word for: numeric,
      // which is the column the chart has always read. valueKindOf refines it
      // from the readings when it has them.
      return "numeric";
  }
}

/**
 * The kind for the SELECTED point: the declared type, refined from the
 * readings only when the type is not declared.
 *
 * The readings never override a declared type. A `real` point with a stray
 * boolean row is a collector defect to be found, not a chart to be redrawn,
 * and letting the data vote would make the axis change kind as the window
 * moved.
 */
export function valueKindOf(
  dataType: string,
  populated: PopulatedColumns,
): ValueKind {
  if (dataType !== "unknown" && dataType !== "abstime") {
    return valueKindFromDataType(dataType);
  }
  if (populated.num === 0 && populated.bool > 0) return "boolean";
  if (populated.num === 0 && populated.bool === 0 && populated.str > 0) return "string";
  return "numeric";
}

/**
 * What a boolean point's two states are called.
 *
 * The data cannot say - `value_bool` is true or false and nothing else - so
 * the words come from what the point is FOR, in this order:
 *
 *  1. Occupancy, by role or by name: Occupied / Unoccupied.
 *  2. An alarm, by role or by name: Alarm / Normal.
 *  3. "Enable" anywhere in the name: Enabled / Disabled. The office JACE's
 *     `System_Enable` carries no role and is named exactly this.
 *  4. Any other status or command role - a fan, a pump, a boiler: On / Off.
 *  5. Otherwise True / False, which is the one pair that cannot be wrong.
 *
 * Roles before names, because a role is a person's classification and a name
 * is whatever the integrator typed. Names are matched case-insensitively on
 * the Niagara history name AND the shown name, so `$`-escapes in one and a
 * label in the other both get a look.
 */
export function booleanStates(point: {
  role: string | null;
  isStatus: boolean;
  isCommand: boolean;
  names: readonly (string | null)[];
}): BooleanStates {
  const role = point.role ?? "";
  const names = point.names
    .filter((name): name is string => name !== null)
    .map((name) => name.toLowerCase());
  const named = (needle: string) => names.some((name) => name.includes(needle));

  if (role.startsWith("occupancy_") || named("occup")) {
    return { on: "Occupied", off: "Unoccupied" };
  }
  if (role === "alarm_status" || named("alarm")) {
    return { on: "Alarm", off: "Normal" };
  }
  if (named("enable")) {
    return { on: "Enabled", off: "Disabled" };
  }
  if (point.isStatus || point.isCommand) {
    return { on: "On", off: "Off" };
  }
  return { on: "True", off: "False" };
}

/**
 * The state word for a boolean sample. The trend carries a boolean reading as
 * 1 or 0 so that the same series shape, the same break logic and the same
 * bucketing serve every kind; this is the one place the number turns back
 * into the word. Anything that is not exactly 0 or 1 - a bucket's average -
 * is not a state and gets null, so the caller says "share" rather than
 * inventing a third state.
 */
export function stateWord(value: number | null, states: BooleanStates): string | null {
  if (value === 1) return states.on;
  if (value === 0) return states.off;
  return null;
}
