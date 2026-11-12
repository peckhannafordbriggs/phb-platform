import { SUB_BAR_BACK_HREF, activeSubBarItemHref, type SubBar, type SubBarItem } from "../sub-bar";

/**
 * The Reports bar (2026-11-11): what the module's tab bar becomes while the
 * Reports tab is open. One bar, never two rows - BasShell draws this list
 * with the kit's TabBar in place of the module tabs, and Back brings the
 * module tabs back with Projects selected. Data on the shared sub-bar shape
 * since 2026-11-12 (../sub-bar.ts), beside the Settings bar.
 *
 * Real routes, one list, longest-prefix match, on the tabs.ts pattern. The
 * items and the paths that belong to each:
 *
 *   Reports    /bas/reports (the runs, the default when Reports is opened)
 *              and a run at /bas/reports/generated/<runId>
 *   Scheduled  /bas/reports/scheduled (the definitions), the editor at
 *              /bas/reports/new and /bas/reports/<id>
 *   Questions  /bas/reports/library (the shared questions and the viewer's
 *              own; the route keeps the name the tables have)
 *   Usage      /bas/reports/usage
 *
 * `/bas/reports/generated` itself redirects to `/bas/reports`, so an old
 * link lands on the same list under its new name.
 */
export type ReportsBarItem = SubBarItem;

export const REPORTS_BAR: readonly ReportsBarItem[] = [
  { href: "/bas/reports", label: "Reports" },
  { href: "/bas/reports/scheduled", label: "Scheduled" },
  { href: "/bas/reports/library", label: "Questions" },
  { href: "/bas/reports/usage", label: "Usage" },
];

/** Where Back goes: the module's default tab (Projects). */
export const REPORTS_BACK_HREF = SUB_BAR_BACK_HREF;

/** An editor path: /bas/reports/<digits>, with or without more after it. */
const EDITOR = /^\/bas\/reports\/[0-9]+(?:\/|$)/;

export const REPORTS_SUB_BAR: SubBar = {
  tabHref: "/bas/reports",
  label: "Reports sections",
  items: REPORTS_BAR,
  paths: [
    { prefix: "/bas/reports", item: "/bas/reports" },
    { prefix: "/bas/reports/generated", item: "/bas/reports" },
    { prefix: "/bas/reports/scheduled", item: "/bas/reports/scheduled" },
    { prefix: "/bas/reports/new", item: "/bas/reports/scheduled" },
    { prefix: "/bas/reports/library", item: "/bas/reports/library" },
    { prefix: "/bas/reports/usage", item: "/bas/reports/usage" },
  ],
  // The editor's numeric ids go to Scheduled.
  resolve: (pathname) => (EDITOR.test(pathname) ? "/bas/reports/scheduled" : null),
};

/**
 * Which item a path belongs to: the longest prefix that matches, with the
 * editor's numeric ids going to Scheduled. Null outside /bas/reports.
 */
export function activeReportsItemHref(pathname: string): string | null {
  return activeSubBarItemHref(REPORTS_SUB_BAR, pathname);
}
