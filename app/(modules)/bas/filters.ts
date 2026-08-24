import { DEFAULT_WINDOW_DAYS } from "./health-client";

/**
 * The module's filters live in the URL, and that is the whole design.
 *
 * Three properties fall out of it and none of them are free any other way:
 *
 *  - **They persist across tabs.** `tabHref` carries the query string, so the
 *    selection is not React state that a route change discards.
 *  - **They are bookmarkable.** "Spring Grove Lab, last 24 hours, Temp1" is a
 *    URL somebody can paste into a ticket.
 *  - **They survive a refresh and a middle-click**, because there is nothing to
 *    survive - the URL *is* the state.
 *
 * The server is the only thing that interprets them. These helpers read and
 * rewrite the query string; every actual filtering decision happens in SQL, in
 * `lib/modules/bas/service.ts`.
 */

export const SITE_PARAM = "site";
export const DAYS_PARAM = "days";
export const POINT_PARAM = "point";

/** The dropdown's "All" value. Never sent - absent IS all. */
export const ALL_SITES = "__all__";

export interface BasFilters {
  /** `null` means every building the employee may see. */
  siteId: string | null;
  windowDays: number;
  /** `null` means "whichever point the picker offers first". */
  pointId: string | null;
}

interface ParamsLike {
  get(name: string): string | null;
}

/**
 * Read the filters out of a query string.
 *
 * Tolerant on purpose. These values arrive from a URL a person may have edited,
 * and the server validates them again anyway - so a malformed `days` falls back
 * to the default here rather than throwing before the screen can render an
 * error it could explain.
 */
export function readFilters(params: ParamsLike): BasFilters {
  const rawDays = params.get(DAYS_PARAM);
  const days = rawDays === null ? Number.NaN : Number.parseInt(rawDays, 10);

  const site = params.get(SITE_PARAM);
  const point = params.get(POINT_PARAM);

  return {
    siteId: site === null || site.length === 0 || site === ALL_SITES ? null : site,
    windowDays: Number.isFinite(days) ? days : DEFAULT_WINDOW_DAYS,
    pointId: point === null || point.length === 0 ? null : point,
  };
}

/**
 * A new query string with one filter changed.
 *
 * `null` removes the parameter rather than writing an empty value, so the URL
 * of an unfiltered screen is `/bas` and not `/bas?site=&days=&point=`. The
 * default window is dropped for the same reason - a URL should carry choices,
 * not restate defaults.
 *
 * Every other parameter is preserved untouched, which is what lets a tab-local
 * filter survive a change to a shared one.
 */
export function withFilter(
  params: ParamsLike & { toString(): string },
  key: string,
  value: string | null,
): string {
  const next = new URLSearchParams(params.toString());

  if (value === null || value.length === 0 || value === ALL_SITES) {
    next.delete(key);
  } else {
    next.set(key, value);
  }

  if (next.get(DAYS_PARAM) === String(DEFAULT_WINDOW_DAYS)) {
    next.delete(DAYS_PARAM);
  }

  const query = next.toString();
  return query.length > 0 ? `?${query}` : "";
}
