/**
 * Paging the Reports runs list and the Scheduled list (2026-11-23). No
 * imports: the service, the routes and the two client lists all read these,
 * and a client component that imports anything reaching @/lib/db breaks the
 * build.
 *
 * Both lists are 25 rows a page, newest first, paged in SQL with a tiebreak
 * on the id - two rows with one timestamp must never swap across a page
 * boundary, or one would be shown twice and the other never.
 */

export const REPORTS_PAGE_SIZE = 25;

/** The run states, in the order the Status filter offers them. */
export const RUN_STATUS_FILTERS = ["queued", "running", "succeeded", "partial", "failed"] as const;
export type RunStatusFilter = (typeof RUN_STATUS_FILTERS)[number];

export function isRunStatusFilter(value: unknown): value is RunStatusFilter {
  return typeof value === "string" && (RUN_STATUS_FILTERS as readonly string[]).includes(value);
}

/** A page number from a query string: a whole number from 1, anything else 1. */
export function parsePage(value: string | number | null | undefined): number {
  const n = typeof value === "number" ? value : Number.parseInt(value ?? "", 10);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** An id filter from a query string: digits, or no filter. */
export function parseIdFilter(value: string | null | undefined): string | null {
  return typeof value === "string" && /^[0-9]{1,20}$/.test(value) ? value : null;
}

export interface PageWindow {
  /** The page actually served: the one asked for, held to 1..last. */
  page: number;
  pageSize: number;
  /** How many rows the page should hold, and where it starts. */
  offset: number;
  expectedRows: number;
  lastPage: number;
}

/**
 * The page to serve. A page past the end - the last rows of the last page
 * were just deleted, or a filter narrowed the list under an old URL - is the
 * last page, never an empty one.
 */
export function pageWindow(requested: number, total: number, pageSize = REPORTS_PAGE_SIZE): PageWindow {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(requested)), lastPage);
  const offset = (page - 1) * pageSize;
  return { page, pageSize, offset, expectedRows: Math.max(0, Math.min(pageSize, total - offset)), lastPage };
}

/** "1–25 of 30", "26–30 of 30"; "0 of 0" when there is nothing. An en dash. */
export function describePageRange(page: number, pageSize: number, total: number): string {
  if (total <= 0) return "0 of 0";
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  return `${first}–${last} of ${total}`;
}
