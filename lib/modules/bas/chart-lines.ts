/**
 * The lines on Point Explorer's chart (2026-11-20, multi-line): how many, which
 * axis each is drawn against, what each looks like, and how the set changes
 * when a line is added or removed.
 *
 * Pure, and imported by both halves: the service decides the axes and refuses
 * a line it cannot draw; the browser uses the same rule to grey out a point in
 * the picker before anyone asks for it. If the two ever disagreed the service
 * would still win - its note says which line was left off and why.
 *
 * THE AXIS RULE IS B4's, CARRIED TO SIX LINES. Point Explorer was one point at
 * a time because 55 °F and a bare 12.8 on one scale read as the same quantity
 * (WHY-ITS-BUILT-THIS-WAY.md § 91). Lines share an axis only when they are
 * known to be the same quantity: a number with the same recorded unit, or a
 * state with the same two words. A number with no unit shares with nothing.
 * There are two axes, left and right, and no third: a line that would need
 * one is not drawn, and the note names it and the two axes already in use.
 */

import { normaliseUnit, unitSymbol } from "./units";
import type { BooleanStates, ValueKind } from "./value-kind";

/** The most lines one chart draws: the point and five more. */
export const MAX_CHART_LINES = 6;

export type AxisSide = "left" | "right";

/** What a line has to say about itself for the axis rule. */
export interface LineIdentity {
  pointId: string;
  valueKind: ValueKind;
  unit: string | null;
  states: BooleanStates | null;
}

/**
 * The quantity a line is drawn as. Two lines with the same key may share an
 * axis; nothing else may. A number with no unit, and a text point, get a key
 * of their own - an unknown unit cannot be shown to match any other.
 */
export function axisKey(line: LineIdentity): string {
  if (line.valueKind === "boolean" && line.states !== null) {
    return `states:${line.states.on}|${line.states.off}`;
  }
  if (line.valueKind === "numeric" && line.unit !== null && normaliseUnit(line.unit).length > 0) {
    return `unit:${normaliseUnit(line.unit)}`;
  }
  return `alone:${line.pointId}`;
}

/**
 * Which axis each line is drawn on, in order: the first line takes the left,
 * the first line of another quantity takes the right, and a line of a third
 * quantity gets `null` - not drawn.
 */
export function assignAxes(lines: readonly LineIdentity[]): Array<AxisSide | null> {
  let left: string | null = null;
  let right: string | null = null;
  return lines.map((line) => {
    const key = axisKey(line);
    if (left === null || key === left) {
      left = key;
      return "left";
    }
    if (right === null || key === right) {
      right = key;
      return "right";
    }
    return null;
  });
}

/** How an axis is labelled: the state words, the unit's symbol, or "no unit recorded". */
export function axisWords(line: Pick<LineIdentity, "valueKind" | "unit" | "states">): string {
  if (line.valueKind === "boolean" && line.states !== null) return `${line.states.on} / ${line.states.off}`;
  return unitSymbol(line.unit) ?? "no unit recorded";
}

/**
 * Why a point cannot be added to the lines already drawn, or null when it can.
 * The picker shows this beside the point instead of letting it be chosen.
 */
export type AddRefusal = "on_chart" | "full" | "third_axis";

export function addRefusal(
  current: readonly LineIdentity[],
  candidate: LineIdentity,
): AddRefusal | null {
  if (current.some((line) => line.pointId === candidate.pointId)) return "on_chart";
  if (current.length >= MAX_CHART_LINES) return "full";
  return assignAxes([...current, candidate]).at(-1) === null ? "third_axis" : null;
}

/** The sentence for a refusal, said where the point is offered. */
export function describeAddRefusal(
  refusal: AddRefusal,
  current: readonly LineIdentity[],
): string {
  switch (refusal) {
    case "on_chart":
      return "Already on the chart";
    case "full":
      return `The chart holds ${MAX_CHART_LINES} lines`;
    case "third_axis": {
      const [left, right] = axisOwners(current);
      return `Needs a third axis: the chart already has ${left === undefined ? "" : axisWords(left)}${right === undefined ? "" : ` and ${axisWords(right)}`}`;
    }
  }
}

/** The first line on each axis - the one whose unit or states label it. */
export function axisOwners(lines: readonly LineIdentity[]): [LineIdentity | undefined, LineIdentity | undefined] {
  const sides = assignAxes(lines);
  return [lines[sides.indexOf("left")], lines[sides.indexOf("right")]];
}

/**
 * The note for a line the service left off for want of an axis. Names the
 * point, the two axes in use and what the point reads in, so the fix - remove
 * a line of one of those quantities - is in the sentence.
 */
export function describeThirdAxis(name: string, line: LineIdentity, drawn: readonly LineIdentity[]): string {
  const [left, right] = axisOwners(drawn);
  const own = line.valueKind === "boolean" && line.states !== null
    ? `reads ${axisWords(line)}`
    : line.unit === null
      ? "has no unit recorded"
      : `reads in ${axisWords(line)}`;
  return (
    `${name} is not drawn: the chart already has two axes` +
    `${left !== undefined && right !== undefined ? ` (${axisWords(left)} and ${axisWords(right)})` : ""}` +
    ` and it ${own}. Remove a line to make room for it.`
  );
}

/**
 * Each line's share of the draw budget.
 *
 * The raw cap in range.ts (`MAX_RAW_TREND_POINTS`) was measured for ONE line:
 * under 400 ms to draw and zoom at 10,000 points, a 2.7 s hang at 70,000. Six
 * lines each held to it would put 60,000 on one chart. So the cap is the
 * chart's, shared: each line is raw up to its share and bucketed past it, and
 * the notice on the chart says so as it always has.
 */
export function lineShare(total: number, lines: number): number {
  return Math.max(1, Math.floor(total / Math.max(1, lines)));
}

/**
 * Each line's look, by SLOT. Slot 0 is the point the tiles describe, in the
 * module's accent as it has always been; slot 1 is compare mode's purple,
 * unchanged. Slots 2-5 are the remaining decorative inks (lib/module-accent.ts
 * DECORATIVE_CARD_FILLS less orange, which collapses into gold under
 * deuteranopia - ΔE 1.0) and the platform's neutral ink. No set of four brand
 * inks clears the colour-blind separation floor beside cyan and purple (the
 * best, this one, is ΔE 7.8 at its worst pair and 12.9 under normal vision,
 * cyan against teal), so every slot past the second also has its own dash
 * pattern, and the legend and the cursor's readout name every line. Red and
 * maroon are never a line: red reads as an alarm, maroon is the gap bands.
 */
export const LINE_STYLES: ReadonlyArray<{ stroke: string; dash: string | undefined }> = [
  { stroke: "var(--module-accent, var(--phb-cyan))", dash: undefined },
  { stroke: "var(--phb-purple)", dash: undefined },
  { stroke: "var(--phb-pink-ink)", dash: "6 3" },
  { stroke: "var(--phb-gold-ink)", dash: "2 3" },
  { stroke: "var(--phb-teal-ink)", dash: "8 3 2 3" },
  { stroke: "var(--neutral-700)", dash: "12 4" },
];

export function lineStyle(slot: number): { stroke: string; dash: string | undefined } {
  return LINE_STYLES[Math.min(Math.max(0, Math.trunc(slot)), LINE_STYLES.length - 1)]!;
}

// ---------------------------------------------------------------- the slots

/**
 * The lines as SLOTS: slot 0 is the point the tiles describe and is never
 * empty; slots 1-5 are the other lines, and an empty slot (null) is a line
 * that was removed. A line's colour is its slot's, so removing one line
 * leaves every other line the colour it was - a colour follows the line it
 * was given to, never its position in a list. Adding fills the first empty
 * slot. Removing the point the tiles describe moves the next line into slot
 * 0, and that one line changes colour, because the module's accent IS "the
 * line the tiles describe".
 */
export type LineSlots = ReadonlyArray<string | null>;

/** Trailing empty slots carry nothing. */
function trimSlots(slots: Array<string | null>): Array<string | null> {
  while (slots.length > 1 && slots[slots.length - 1] === null) slots.pop();
  return slots;
}

/** The ids drawn, in slot order, skipping empty slots. */
export function slotIds(slots: LineSlots): string[] {
  return slots.filter((id): id is string => id !== null);
}

export function addSlot(slots: LineSlots, pointId: string): Array<string | null> {
  const next = [...slots];
  if (next.includes(pointId) || slotIds(next).length >= MAX_CHART_LINES) return next;
  const free = next.indexOf(null, 1);
  if (free !== -1) next[free] = pointId;
  else next.push(pointId);
  return next;
}

export function removeSlot(slots: LineSlots, pointId: string): Array<string | null> {
  const next = [...slots];
  const at = next.indexOf(pointId);
  if (at === -1 || slotIds(next).length < 2) return next;
  if (at === 0) {
    const promoted = next.findIndex((id, i) => i > 0 && id !== null);
    next[0] = next[promoted]!;
    next[promoted] = null;
  } else {
    next[at] = null;
  }
  return trimSlots(next);
}
