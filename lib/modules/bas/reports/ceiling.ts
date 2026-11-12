/**
 * The Reports module's one safety ceiling (2026-11-12): the most a single
 * run may spend and the longest it may take. ONE row in bas_report_settings,
 * edited by BAS module admins from the Usage page, read by the engine for
 * every run. It replaced the per-report budget and time cap, which nobody
 * wanted to decide report by report.
 *
 * This file is the PURE half - the shape, the defaults, the bounds and the
 * one sentence - and imports nothing that touches a database, because the
 * Usage page's client component reads it and Next refuses `pg` in a browser
 * bundle. The read is `readSafetyCeiling` in ceiling-read.ts; the admin
 * write is `setSafetyCeiling` in service.ts, where the audit row and the
 * admin check live.
 */

export interface SafetyCeiling {
  /** Dollars per run. */
  usd: number;
  /** Minutes per run, 1 to MAX_CEILING_MINUTES. */
  minutes: number;
}

export interface SafetyCeilingView extends SafetyCeiling {
  /** When the row was last written; null when the defaults are in force and nobody has saved them. */
  updatedAt: string | null;
  updatedBy: string | null;
}

/** $10.00 and 25 minutes per run: the migration's row, and what an absent row reads as. */
export const DEFAULT_SAFETY_CEILING: Readonly<SafetyCeiling> = { usd: 10, minutes: 25 };

/**
 * The most minutes the ceiling may hold. The worker job's 30-minute replica
 * timeout (infra/main.bicep) is held above this plus the worker's drain
 * window by tests/deploy-guards.test.ts, so the engine always stops itself
 * and stores a partial report before the platform kills the execution.
 */
export const MAX_CEILING_MINUTES = 25;

/** A cap of a thousand dollars is one a runaway run never meets. */
export const MAX_CEILING_USD = 1000;

export const SETTINGS_ROW_ID = 1;

/** "$10.00 and 25 minutes per run" - the one sentence every screen uses for it. */
export function describeSafetyCeiling(ceiling: SafetyCeiling): string {
  return `$${ceiling.usd.toFixed(2)} and ${ceiling.minutes} minute${ceiling.minutes === 1 ? "" : "s"} per run`;
}
