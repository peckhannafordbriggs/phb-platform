/**
 * Units, as `bas_points.unit` stores them and as a screen shows them.
 *
 * The stored value is Niagara's own unit-database name, lower case -
 * "fahrenheit", "percent", "inches of water" - and it is never changed here or
 * anywhere: the collector writes it, the views carry it, the model's SQL
 * matches against it. This module decides only what a person SEES beside a
 * number: °F, %, inWC. One formatter, driven by the unit column, used by the
 * Point Explorer tiles, the chart axis and tooltip, the per-point table and
 * the Analyze context alike, so the same reading cannot read "72.0 fahrenheit"
 * on one screen and "72.0 °F" on the next.
 *
 * Matched after normalisation (trimmed, lower-cased, spaces collapsed), never
 * by substring: "percent" must not match "percent of full scale" by accident,
 * and a unit that is not here is shown as it was stored rather than guessed
 * at. No unit at all stays no unit - a bare number, and an axis that says so.
 *
 * Add a unit by adding its names to the right list and its symbol to
 * UNIT_SYMBOLS. Nothing else changes. See tests/bas-unit-symbols.test.tsx.
 */

export type UnitKind = "temperature" | "percentage" | "pressure" | "other";

/**
 * The kinds, and every spelling of each unit that has been seen or is likely.
 * The kind decides how many decimals an axis shows (value-axis.ts).
 */
const UNIT_NAMES: Record<Exclude<UnitKind, "other">, readonly string[]> = {
  temperature: [
    "fahrenheit",
    "celsius",
    "centigrade",
    "kelvin",
    "degrees fahrenheit",
    "degrees celsius",
    "°f",
    "°c",
    "degf",
    "degc",
    "deg f",
    "deg c",
    "f",
    "c",
    "k",
  ],
  percentage: ["percent", "percentage", "%", "pct"],
  pressure: [
    "inches of water",
    "inch of water",
    "inches water column",
    "in wc",
    "in. w.c.",
    "inwc",
    "inh2o",
    "in h2o",
    "pounds per square inch",
    "psi",
    "psig",
    "pascal",
    "pascals",
    "pa",
    "kilopascal",
    "kilopascals",
    "kpa",
    "bar",
    "millibar",
    "mbar",
  ],
};

/**
 * The symbol for each normalised name. Every name in UNIT_NAMES has one, and a
 * test walks the lists to prove it; a name here that is not in a list above
 * would be a symbol for a unit the axis does not know how to round.
 */
const UNIT_SYMBOLS: Record<string, string> = {
  fahrenheit: "°F",
  "degrees fahrenheit": "°F",
  "°f": "°F",
  degf: "°F",
  "deg f": "°F",
  f: "°F",
  celsius: "°C",
  centigrade: "°C",
  "degrees celsius": "°C",
  "°c": "°C",
  degc: "°C",
  "deg c": "°C",
  c: "°C",
  kelvin: "K",
  k: "K",
  percent: "%",
  percentage: "%",
  "%": "%",
  pct: "%",
  "inches of water": "inWC",
  "inch of water": "inWC",
  "inches water column": "inWC",
  "in wc": "inWC",
  "in. w.c.": "inWC",
  inwc: "inWC",
  inh2o: "inH₂O",
  "in h2o": "inH₂O",
  "pounds per square inch": "psi",
  psi: "psi",
  psig: "psig",
  pascal: "Pa",
  pascals: "Pa",
  pa: "Pa",
  kilopascal: "kPa",
  kilopascals: "kPa",
  kpa: "kPa",
  bar: "bar",
  millibar: "mbar",
  mbar: "mbar",
};

export function normaliseUnit(unit: string): string {
  return unit.trim().toLowerCase().replace(/\s+/g, " ");
}

export function unitKind(unit: string | null): UnitKind {
  if (unit === null) return "other";
  const name = normaliseUnit(unit);
  if (name.length === 0) return "other";
  for (const kind of Object.keys(UNIT_NAMES) as Array<keyof typeof UNIT_NAMES>) {
    if (UNIT_NAMES[kind].includes(name)) return kind;
  }
  return "other";
}

/** Every name the kinds know, for the test that checks each has a symbol. */
export function knownUnitNames(): readonly string[] {
  return Object.values(UNIT_NAMES).flat();
}

/**
 * The symbol a unit is shown as.
 *
 *   "fahrenheit"       -> "°F"
 *   "percent"          -> "%"
 *   "inches of water"  -> "inWC"
 *   "furlongs"         -> "furlongs"   (unknown: shown as stored, trimmed)
 *   null / ""          -> null         (no unit recorded)
 */
export function unitSymbol(unit: string | null): string | null {
  if (unit === null) return null;
  const trimmed = unit.trim();
  if (trimmed.length === 0) return null;
  return UNIT_SYMBOLS[normaliseUnit(trimmed)] ?? trimmed;
}

/**
 * A rendered number with its unit symbol: "72.0 °F", "33%", "1.23 inWC",
 * and the bare number when there is no unit. Percent attaches to the number
 * because that is how it is written; every other symbol takes a space.
 */
export function withUnit(rendered: string, unit: string | null): string {
  const symbol = unitSymbol(unit);
  if (symbol === null) return rendered;
  return symbol === "%" ? `${rendered}%` : `${rendered} ${symbol}`;
}
