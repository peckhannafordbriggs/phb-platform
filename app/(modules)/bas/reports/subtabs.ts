/**
 * The Reports tab's sub-tabs (Phase 1), on the tabs.ts pattern: real routes,
 * one list, longest-prefix match. `/bas/reports/new` and `/bas/reports/<id>`
 * belong to the Reports sub-tab, which is why the match is by prefix.
 */
export interface ReportSubTab {
  href: string;
  label: string;
}

export const REPORT_SUBTABS: readonly ReportSubTab[] = [
  { href: "/bas/reports", label: "Reports" },
  { href: "/bas/reports/generated", label: "Generated" },
  { href: "/bas/reports/library", label: "Library" },
  { href: "/bas/reports/usage", label: "Usage" },
];

export function activeSubTabHref(pathname: string): string | null {
  let best: string | null = null;
  for (const tab of REPORT_SUBTABS) {
    const matches = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
    if (matches && (best === null || tab.href.length > best.length)) best = tab.href;
  }
  return best;
}
