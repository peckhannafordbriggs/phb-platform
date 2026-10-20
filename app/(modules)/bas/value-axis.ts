/**
 * The value axis of a reading chart: which ticks, how many decimals, how wide.
 *
 * Niagara stores readings as 32-bit floats, so 72.02734375 is a genuine value
 * (7/256 is exactly representable) and 71.91999816894531 is how a station says
 * 71.92. Nothing here touches those numbers - the database, the API and the
 * chart's data array all carry the float32 value exactly as it arrived. This
 * module decides only how the AXIS and the TOOLTIP read.
 *
 * Why it exists: Recharts chooses round ticks for a domain it derives itself,
 * but a zoomed chart hands it an explicit domain, and on that path it appends
 * the raw domain endpoints as ticks and stops rounding once the range is
 * narrow. Zoomed to under a degree, the axis printed "72.02734375" and the
 * gutter clipped it. So the ticks are chosen here, at every zoom level, from
 * the same rule, and Recharts is given the list rather than the range.
 *
 * Display only, pure, and imported by a test that renders the real chart. See
 * tests/bas-chart-axis.test.tsx and WHY-ITS-BUILT-THIS-WAY.md § 50.
 */

import { unitKind, withUnit, type UnitKind } from "@/lib/modules/bas/units";
import { stateWord, type BooleanStates } from "@/lib/modules/bas/value-kind";

/**
 * The unit names and their symbols live in lib/modules/bas/units.ts, because
 * the Analyze context on the server needs the same symbol the chart shows.
 * Re-exported so the axis test keeps importing them from here.
 */
export { unitKind, type UnitKind };

/**
 * Decimals on an AXIS label, by the kind of quantity. The tooltip shows one
 * more, because a tooltip answers "what was the reading" and an axis answers
 * "roughly where is this".
 *
 * A tenth of a degree is the resolution anybody sets a thermostat to; a whole
 * percent is how a damper or valve position is spoken of; static pressure in
 * inches of water is quoted to hundredths because a duct runs at 1.50 in wc.
 * Anything unrecognised, including a point with no unit at all, gets two.
 */
const AXIS_DECIMALS: Record<UnitKind, number> = {
  temperature: 1,
  percentage: 0,
  pressure: 2,
  other: 2,
};

export function axisDecimals(unit: string | null): number {
  return AXIS_DECIMALS[unitKind(unit)];
}

export function tooltipDecimals(unit: string | null): number {
  return axisDecimals(unit) + 1;
}

/** An axis tick label: fixed decimals, so "72.0" and "72.1", never "72.02734375". */
export function formatAxisTick(value: number, decimals: number): string {
  return value.toFixed(decimals);
}

/** The tooltip's reading: one more decimal than the axis, with the unit's symbol. */
export function formatTooltipValue(
  value: number | null,
  unit: string | null,
): string {
  if (value === null) return "—";
  return withUnit(value.toFixed(tooltipDecimals(unit)), unit);
}

/**
 * The round step nearest above `rough`: 1, 2 or 5 times a power of ten.
 *
 * `minStep` is the floor, and it is what makes the labels honest at any zoom.
 * With one decimal on the axis, a step of 0.05 would print 71.9, 71.9, 72.0,
 * 72.0 - two labels for one line each - so the step can never be finer than
 * the precision the label shows. When the zoom is narrower than one step the
 * ticks simply bracket the data, which is true, rather than subdividing it
 * with labels that cannot tell the ticks apart.
 */
export function niceStep(rough: number, minStep: number): number {
  if (!(rough > 0) || !Number.isFinite(rough)) return minStep;
  const exponent = Math.floor(Math.log10(rough));
  const magnitude = 10 ** exponent;
  const base = rough / magnitude;
  const tolerance = 1e-9;
  const mantissa =
    base <= 1 + tolerance ? 1 : base <= 2 + tolerance ? 2 : base <= 5 + tolerance ? 5 : 10;
  return Math.max(cleanMultiple(mantissa, exponent), minStep);
}

/**
 * `mantissa × 10^exponent` without float residue: 5 × 10^-2 is 0.05, not
 * 0.05000000000000001. Division for negative exponents because a division by a
 * power of ten is correctly rounded and a multiplication by 0.01 is not.
 */
function cleanMultiple(mantissa: number, exponent: number): number {
  return exponent < 0 ? mantissa / 10 ** -exponent : mantissa * 10 ** exponent;
}

/**
 * Round tick values covering [min, max], never fewer than two.
 *
 * Ticks are whole multiples of the step, computed as integers and divided once,
 * so 719 tenths is 71.9 and not 71.90000000000001. They may sit outside the
 * data - the first tick is at or below the minimum, the last at or above the
 * maximum - which is what makes the domain they define contain every reading.
 */
export function niceValueTicks(
  min: number,
  max: number,
  decimals: number,
  tickCount = 5,
): number[] {
  const minStep = cleanMultiple(1, -decimals);
  const [lo, hi] = min <= max ? [min, max] : [max, min];
  const step =
    hi > lo ? niceStep((hi - lo) / Math.max(tickCount - 1, 1), minStep) : minStep;

  // Work in whole steps. The epsilon keeps a value that IS a tick from falling
  // one step out through float noise in the division.
  const epsilon = 1e-9;
  let first = Math.floor(lo / step + epsilon);
  let last = Math.ceil(hi / step - epsilon);
  if (first === last) {
    first -= 1;
    last += 1;
  }

  const ticks: number[] = [];
  for (let index = first; index <= last; index += 1) {
    ticks.push(tickValue(index, step));
  }
  return ticks;
}

/** `index × step`, cleaned to the step's own decimals. */
function tickValue(index: number, step: number): number {
  const decimals = stepDecimals(step);
  return Number((index * step).toFixed(decimals));
}

/** How many decimals a step needs to be written exactly: 0.05 -> 2, 20 -> 0. */
function stepDecimals(step: number): number {
  const text = step.toString();
  if (text.includes("e-")) return Number(text.split("e-")[1]);
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

/**
 * How wide the axis gutter has to be for its widest label, in pixels.
 *
 * An estimate rather than a measurement - the chart is laid out before the
 * text exists, and the test environment has no font metrics - so it errs
 * wide: 0.65 em per character covers a digit in every face the platform
 * ships, and the sign and the point are narrower than that. The lane on the
 * left is for the rotated unit label, which Recharts draws inside the axis
 * width, and the tick line and its margin match the Recharts defaults.
 */
export const AXIS_CHAR_WIDTH_EM = 0.65;
export const AXIS_TICK_LINE_PX = 6;
export const AXIS_TICK_MARGIN_PX = 2;
export const AXIS_LABEL_LANE_PX = 16;

export function axisGutterWidth(
  labels: readonly string[],
  fontSize: number,
): number {
  const widest = labels.reduce((max, label) => Math.max(max, label.length), 0);
  return Math.ceil(
    widest * AXIS_CHAR_WIDTH_EM * fontSize +
      AXIS_TICK_LINE_PX +
      AXIS_TICK_MARGIN_PX +
      AXIS_LABEL_LANE_PX,
  );
}

export interface ValueAxis {
  /** Round tick values, first at or below the data, last at or above. */
  ticks: number[];
  /** The tick range. Handing Recharts this AND `ticks` is what keeps them aligned. */
  domain: [number, number];
  /** Decimals on every tick label. */
  decimals: number;
  /** Every label, formatted, in tick order. */
  labels: string[];
  /** Gutter width in pixels that fits the widest label. */
  width: number;
}

/**
 * Everything the chart's y-axis needs, from the values on screen and the unit.
 *
 * `values` is whatever is visible: the whole series at default zoom, the
 * samples inside the zoom window otherwise. Nulls are the caller's to drop -
 * they are absent readings, and folding them in as zero would drag the axis
 * down and flatten everything real. With nothing visible the axis falls back to
 * a unit-wide band around zero rather than throwing.
 */
export function valueAxis(
  values: readonly number[],
  unit: string | null,
  options: { tickCount?: number; fontSize?: number } = {},
): ValueAxis {
  const decimals = axisDecimals(unit);
  const finite = values.filter((value) => Number.isFinite(value));
  const min = finite.length === 0 ? 0 : Math.min(...finite);
  const max = finite.length === 0 ? 0 : Math.max(...finite);
  const ticks = niceValueTicks(min, max, decimals, options.tickCount ?? 5);
  const labels = ticks.map((tick) => formatAxisTick(tick, decimals));
  return {
    ticks,
    domain: [ticks[0]!, ticks[ticks.length - 1]!],
    decimals,
    labels,
    width: axisGutterWidth(labels, options.fontSize ?? 11),
  };
}

// ------------------------------------------------------------ boolean points

/**
 * How far the plot extends past the two states, as a fraction of the gap
 * between them. Without it the stepped line sits on the plot's top and bottom
 * edges, where it merges with the frame and the x-axis.
 */
export const STATE_AXIS_PADDING = 0.15;

/**
 * The y-axis of a BOOLEAN point: two ticks, two words, nothing between.
 *
 * A boolean reading travels as 1 or 0 (see `TrendPoint.value`), so the ticks
 * are at exactly those values and the labels are the point's state words -
 * "Occupied" / "Unoccupied", "On" / "Off". The domain is padded on both sides
 * so the line has somewhere to be; it is NOT the tick range, which is why this
 * is a separate function from `valueAxis` rather than a parameter on it. The
 * grid draws one line per tick, so no 0.2 / 0.4 / 0.6 gridline can appear:
 * there is no tick there to draw one from.
 *
 * `decimals` is 0 and unused by the formatter - a state has no decimals - and
 * is on the object so the two axis shapes stay interchangeable.
 */
export function stateAxis(
  states: BooleanStates,
  options: { fontSize?: number } = {},
): ValueAxis {
  const labels = [states.off, states.on];
  return {
    ticks: [0, 1],
    domain: [-STATE_AXIS_PADDING, 1 + STATE_AXIS_PADDING],
    decimals: 0,
    labels,
    width: axisGutterWidth(labels, options.fontSize ?? 11),
  };
}

/** A state tick's label: the word, never the number behind it. */
export function formatStateTick(value: number, states: BooleanStates): string {
  return stateWord(value, states) ?? "";
}

/**
 * The tooltip's reading for a boolean point.
 *
 * A raw sample is exactly 0 or 1 and reads as its state word. A bucketed
 * sample's `value` is the share of readings in the bucket that were true, so
 * it reads as that share with the state word beside it - "On 72% of readings"
 * - rather than as a decimal, and never as a third state. The band a bucket
 * carries is [min, max]: both states when the point changed inside the
 * bucket, one word when it did not.
 */
export function formatStateTooltip(
  value: number | null,
  states: BooleanStates,
): string {
  if (value === null) return "—";
  const word = stateWord(value, states);
  if (word !== null) return word;
  return `${states.on} ${Math.round(value * 100)}% of readings`;
}

export function formatStateBand(
  low: number,
  high: number,
  states: BooleanStates,
): string {
  const lowWord = stateWord(low, states);
  const highWord = stateWord(high, states);
  if (lowWord === null || highWord === null) return "—";
  return lowWord === highWord ? lowWord : `${lowWord} – ${highWord}`;
}
