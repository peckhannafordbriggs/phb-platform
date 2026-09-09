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

/** The two levels B7.6 added either side of the building. */
export const PROJECT_PARAM = "project";
export const STATION_PARAM = "station";

/**
 * Which parameters a change at each level must CLEAR.
 *
 * Pick Liberty Center -> North Building, then switch to Kenwood Mall, and
 * "North Building" has to go: a building that is not in the selected project
 * filters everything out and the screen goes blank with nothing saying why.
 * The server refuses that combination with a 404 rather than showing the wrong
 * data, so without this the cascade would be a dead end instead of a blank.
 *
 * The point selection goes too, at every level. A point belongs to a station in
 * a building, so narrowing above it can strand it just as easily.
 */
export const CASCADE_CLEARS: Readonly<Record<string, readonly string[]>> = {
  [PROJECT_PARAM]: [SITE_PARAM, STATION_PARAM, POINT_PARAM],
  [SITE_PARAM]: [STATION_PARAM, POINT_PARAM],
  [STATION_PARAM]: [POINT_PARAM],
};

/**
 * The Settings tab's search and filters (B7.6), in the URL like everything
 * else on this module.
 *
 * Same three properties as the rest: they survive a refresh, they survive a
 * tab switch because `tabHref` carries the query string, and "every station
 * with no credential" is a URL somebody can paste into a ticket.
 *
 * Read by the SERVER, which does the filtering in SQL. These constants exist so
 * the component and the route cannot disagree about the spelling.
 */
export const SEARCH_PARAM = "q";
export const MODE_PARAM = "mode";
export const STATE_PARAM = "state";
export const CRED_PARAM = "cred";

/** The dropdown's "All" value. Never sent - absent IS all. */
export const ALL_SITES = "__all__";

export interface BasFilters {
  /** `null` means every building the employee may see. */
  siteId: string | null;
  windowDays: number;
  /** `null` means "whichever point the picker offers first". */
  pointId: string | null;
  /** `null` at either level means All (B7.6). */
  projectId: string | null;
  stationId: string | null;
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

  const clean = (raw: string | null) =>
    raw === null || raw.length === 0 || raw === ALL_SITES ? null : raw;

  return {
    siteId: clean(site),
    windowDays: Number.isFinite(days) ? days : DEFAULT_WINDOW_DAYS,
    pointId: point === null || point.length === 0 ? null : point,
    projectId: clean(params.get(PROJECT_PARAM)),
    stationId: clean(params.get(STATION_PARAM)),
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


/** The Settings tab's filters, read from a query string. */
export interface SettingsUrlFilters {
  q: string;
  mode: string | null;
  state: string | null;
  cred: string | null;
}

/**
 * Tolerant, like readFilters above. The server validates these again and falls
 * back to unfiltered on anything it does not recognise, so a stale bookmark
 * renders the screen instead of an error.
 */
export function readSettingsFilters(params: ParamsLike): SettingsUrlFilters {
  const value = (key: string) => {
    const raw = params.get(key);
    return raw === null || raw.length === 0 ? null : raw;
  };

  return {
    q: params.get(SEARCH_PARAM) ?? "",
    mode: value(MODE_PARAM),
    state: value(STATE_PARAM),
    cred: value(CRED_PARAM),
  };
}

/** The query string to send to the settings API for these filters. */
export function settingsQuery(f: SettingsUrlFilters): string {
  const next = new URLSearchParams();
  if (f.q.trim().length > 0) next.set(SEARCH_PARAM, f.q.trim());
  if (f.mode !== null) next.set(MODE_PARAM, f.mode);
  if (f.state !== null) next.set(STATE_PARAM, f.state);
  if (f.cred !== null) next.set(CRED_PARAM, f.cred);
  const query = next.toString();
  return query.length > 0 ? `?${query}` : "";
}


/**
 * A new query string with one level changed and everything below it cleared.
 *
 * `withFilter` on its own cannot do this: it preserves every other parameter,
 * which is right for the time range and wrong for a cascade. Built on top of it
 * so the "absent means all" and "drop the default window" rules stay in one
 * place.
 */
export function withCascade(
  params: ParamsLike & { toString(): string },
  key: string,
  value: string | null,
): string {
  let query = withFilter(params, key, value);

  for (const cleared of CASCADE_CLEARS[key] ?? []) {
    query = withFilter(new URLSearchParams(query.replace(/^\?/, "")), cleared, null);
  }

  return query;
}
