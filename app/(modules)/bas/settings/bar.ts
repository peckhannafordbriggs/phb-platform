import { activeSubBarItemHref, type SubBar, type SubBarItem } from "../sub-bar";

/**
 * The Settings bar (2026-11-12): what the module's tab bar becomes while the
 * Settings tab is open, exactly as the Reports bar does for Reports - the
 * same kit TabBar in the same place, one row, never two, with Back at the
 * far left returning to the module bar with Projects selected. Data on the
 * shared sub-bar shape (../sub-bar.ts).
 *
 *   General  /bas/settings - the Settings screen as it always was (projects,
 *            buildings, stations, credentials, occupied hours); the default
 *   Usage    /bas/settings/usage - the Reports Usage view at a second route,
 *            safety ceiling included
 *
 * Both are `requireModuleAdmin` pages, as every Settings page is; a deep
 * link to either lands on this bar directly, because the shell decides the
 * bar from the path. Every other path under /bas/settings reads as General.
 */
export const SETTINGS_BAR: readonly SubBarItem[] = [
  { href: "/bas/settings", label: "General" },
  { href: "/bas/settings/usage", label: "Usage" },
];

export const SETTINGS_SUB_BAR: SubBar = {
  tabHref: "/bas/settings",
  label: "Settings sections",
  items: SETTINGS_BAR,
  paths: [
    { prefix: "/bas/settings", item: "/bas/settings" },
    { prefix: "/bas/settings/usage", item: "/bas/settings/usage" },
  ],
};

/** Which item a path belongs to: Usage for /bas/settings/usage and below, General for the rest of Settings, null outside it. */
export function activeSettingsItemHref(pathname: string): string | null {
  return activeSubBarItemHref(SETTINGS_SUB_BAR, pathname);
}
