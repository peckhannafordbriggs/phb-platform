/**
 * The Reports bar (2026-11-11): what the module's tab bar becomes while the
 * Reports tab is open. One bar, never two rows - BasShell draws this list
 * with the kit's TabBar in place of the module tabs, and Back brings the
 * module tabs back with Projects selected.
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
export interface ReportsBarItem {
  href: string;
  label: string;
}

export const REPORTS_BAR: readonly ReportsBarItem[] = [
  { href: "/bas/reports", label: "Reports" },
  { href: "/bas/reports/scheduled", label: "Scheduled" },
  { href: "/bas/reports/library", label: "Questions" },
  { href: "/bas/reports/usage", label: "Usage" },
];

/** Where Back goes: the module's default tab (Projects). */
export const REPORTS_BACK_HREF = "/bas";

/** Every path prefix the bar knows, and the item it belongs to. */
const PATHS: readonly { prefix: string; item: string }[] = [
  { prefix: "/bas/reports", item: "/bas/reports" },
  { prefix: "/bas/reports/generated", item: "/bas/reports" },
  { prefix: "/bas/reports/scheduled", item: "/bas/reports/scheduled" },
  { prefix: "/bas/reports/new", item: "/bas/reports/scheduled" },
  { prefix: "/bas/reports/library", item: "/bas/reports/library" },
  { prefix: "/bas/reports/usage", item: "/bas/reports/usage" },
];

/** An editor path: /bas/reports/<digits>, with or without more after it. */
const EDITOR = /^\/bas\/reports\/[0-9]+(?:\/|$)/;

/**
 * Which item a path belongs to: the longest prefix that matches, with the
 * editor's numeric ids going to Scheduled. Null outside /bas/reports.
 */
export function activeReportsItemHref(pathname: string): string | null {
  if (EDITOR.test(pathname)) return "/bas/reports/scheduled";
  let best: { prefix: string; item: string } | null = null;
  for (const entry of PATHS) {
    const matches = pathname === entry.prefix || pathname.startsWith(`${entry.prefix}/`);
    if (matches && (best === null || entry.prefix.length > best.prefix.length)) best = entry;
  }
  return best === null ? null : best.item;
}
