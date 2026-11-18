import { REPORTS_SUB_BAR } from "./reports/bar";
import { SETTINGS_SUB_BAR } from "./settings/bar";
import type { SubBar } from "./sub-bar";
import { activeTabHref } from "./tabs";

/**
 * The registry the shell reads (2026-11-12): every module tab that swaps the
 * module bar for a bar of its own while it is open. Adding one is a data
 * file on the sub-bar shape and a line here; the shell, the routing and the
 * Back item are shared.
 */
export const SUB_BARS: readonly SubBar[] = [REPORTS_SUB_BAR, SETTINGS_SUB_BAR];

/** The bar a path is inside, decided by the module tab the path belongs to; null means the module bar. */
export function subBarFor(pathname: string): SubBar | null {
  const tab = activeTabHref(pathname);
  return SUB_BARS.find((bar) => bar.tabHref === tab) ?? null;
}
