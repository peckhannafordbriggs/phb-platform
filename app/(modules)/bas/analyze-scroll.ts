/**
 * How the Analyze thread scrolls inside its panel (2026-10-13).
 *
 * Pure, so the one decision that matters can be proved without a browser:
 * a new turn scrolls the thread to its end ONLY when the person was already
 * at, or near, the end. Someone who has scrolled up to read an older answer
 * is not yanked back down by an answer arriving; the thread grows under
 * them and they reach it when they choose. "Near" is NEAR_BOTTOM_PX of
 * slack, so the last few pixels of a smooth scroll, or a table's bottom
 * border, do not count as having scrolled away.
 */

/** How far from the end still counts as "at the end". */
export const NEAR_BOTTOM_PX = 80;

export interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/**
 * Whether the region is scrolled to within `slack` pixels of its end. A
 * region whose content fits (no overflow at all) is at its end by
 * definition, which is also what jsdom reports for every element.
 */
export function isNearBottom(metrics: ScrollMetrics, slack: number = NEAR_BOTTOM_PX): boolean {
  const remaining = metrics.scrollHeight - (metrics.scrollTop + metrics.clientHeight);
  return remaining <= slack;
}

export function metricsOf(el: HTMLElement): ScrollMetrics {
  return { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
}

/**
 * Scroll a region to its end. Smooth once the person is somewhere in the
 * thread; an instant jump when the region is still at the top, which is the
 * first render of a restored thread, where a slow slide down the whole day
 * would be the opposite of helpful. Falls back to assigning scrollTop where
 * the element has no scrollTo (jsdom).
 */
export function scrollToBottom(el: HTMLElement): void {
  const behavior: ScrollBehavior = el.scrollTop === 0 ? "auto" : "smooth";
  if (typeof el.scrollTo === "function") {
    el.scrollTo({ top: el.scrollHeight, behavior });
  } else {
    el.scrollTop = el.scrollHeight;
  }
}
