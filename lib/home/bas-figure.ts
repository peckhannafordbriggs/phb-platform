import { formatMinutes } from "@/app/(modules)/bas/health-client";
import type { Figure } from "./service";

/**
 * The BAS card's figure: the STATE as the headline, and how fresh the data is
 * underneath.
 *
 * "No points at risk" or "3 points at risk" is the number this module exists
 * to answer, so it is the big text. It used to be the small line under a
 * headroom figure - "2.2 h headroom across 24 of 30 points, 6 not full yet" -
 * which put the detail above the verdict, and headroom belongs on Collection
 * Health where the per-point breakdown behind it is. The count is the
 * service's `pointsAtRisk`, decided by the one at-risk predicate
 * (lib/modules/bas/types.ts), so this card and the hero tile cannot disagree;
 * a point with an unknown horizon is in it, because unknown is not safe.
 *
 * Above zero the figure carries `alarm`, and the card marks it red: the tile
 * may never look calmer than Collection Health does.
 *
 * The small line is the age of the newest reading, from the same total the
 * "Since newest reading" tile shows. `null` there means no readings at all,
 * which is said as such and never as a healthy zero.
 *
 * Its own module, with no import of the auth chain, so
 * tests/bas-quiet-ui.test.tsx can drive it at zero and at one and read the
 * rendered text without a session.
 */
export function basFigure(totals: {
  pointsAtRisk: number;
  minutesSinceNewestReading: number | null;
}): Figure {
  const atRisk = totals.pointsAtRisk;
  const status =
    totals.minutesSinceNewestReading === null
      ? "No readings yet"
      : `newest reading ${formatMinutes(totals.minutesSinceNewestReading)} ago`;

  if (atRisk === 0) {
    return { state: "none", value: "No points at risk", status };
  }
  return {
    state: "ok",
    value: atRisk === 1 ? "1 point at risk" : `${atRisk} points at risk`,
    status,
    alarm: true,
  };
}
