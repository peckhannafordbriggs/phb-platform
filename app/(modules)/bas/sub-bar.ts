/**
 * A sub-bar (2026-11-12): what the module's tab bar becomes while one of its
 * tabs is open - Reports since 2026-11-11, Settings since today. One bar,
 * never two rows: BasShell draws the sub-bar with the kit's TabBar in place
 * of the module tabs, with Back at the far left, and Back brings the module
 * tabs back with the default tab selected, carrying the query string.
 *
 * Each bar is DATA on this shape (app/(modules)/bas/reports/bar.ts,
 * app/(modules)/bas/settings/bar.ts), and sub-bars.ts is the registry the
 * shell reads. The routing is one rule for every bar: real routes, one
 * list, longest-prefix match, with an optional `resolve` hook for a bar
 * whose paths carry ids (the Reports editor's numeric id goes to Scheduled).
 */
export interface SubBarItem {
  /** A real route. Bookmarkable, refreshable, middle-clickable. */
  href: string;
  label: string;
}

export interface SubBar {
  /** The module tab this bar replaces: the `href` in tabs.ts, matched by `activeTabHref`. */
  tabHref: string;
  /** The nav's accessible name, e.g. "Reports sections". */
  label: string;
  items: readonly SubBarItem[];
  /** Every path prefix the bar knows, and the item it belongs to. Longest prefix wins. */
  paths: readonly { prefix: string; item: string }[];
  /** A rule the prefixes cannot express, checked first. Null means fall through to the prefixes. */
  resolve?: (pathname: string) => string | null;
}

/** Where Back goes: the module's default tab (Projects). */
export const SUB_BAR_BACK_HREF = "/bas";

/**
 * Which item of a bar a path belongs to: the bar's own rule first, then
 * the longest prefix that matches. Null outside the bar's paths.
 */
export function activeSubBarItemHref(bar: SubBar, pathname: string): string | null {
  const resolved = bar.resolve?.(pathname) ?? null;
  if (resolved !== null) return resolved;
  let best: { prefix: string; item: string } | null = null;
  for (const entry of bar.paths) {
    const matches = pathname === entry.prefix || pathname.startsWith(`${entry.prefix}/`);
    if (matches && (best === null || entry.prefix.length > best.prefix.length)) best = entry;
  }
  return best === null ? null : best.item;
}
