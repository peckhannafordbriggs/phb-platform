/**
 * When somebody was last here, and how that is decided.
 *
 * A plain module with no imports, like lib/home/last-visit.ts was before it:
 * every rule in this file has to be *proved*, and the module that applies it
 * (lib/activity/record.ts) reaches Prisma, which a node test cannot load
 * without a database. Logic that needs a test lives where a test can import
 * it.
 *
 * ACTIVITY IS NOT AUTHENTICATION
 *
 * `last_login_at` and `previous_login_at` record when a session was issued.
 * A session lasts days, so somebody who uses the platform every day without
 * re-authenticating has a previous sign-in from last week, and a greeting
 * dated from it says "Monday" all week. The two columns this file governs
 * record something else: the most recent day the person actually used the
 * platform. The login columns are untouched by anything here.
 *
 * TWO VALUES, NOT ONE, AND THE TRAP IN IT
 *
 *   lastActiveAt      the live value. Moves as the person uses the platform.
 *   previousActiveAt  the anchor. Frozen for a whole calendar day. The ONLY
 *                     value the greeting and the digest may read.
 *
 * If the greeting read the live value the window would be zero seconds wide,
 * the digest permanently empty, and the screen would look completely normal
 * while telling you nothing - the same failure shape as a backup that never
 * ran. `planActivityWrite` below never hands the anchor the new value, a
 * CHECK in the migration refuses a row where the two are equal, and
 * tests/activity.test.ts mutates the rollover to the live value and confirms
 * the suite fails.
 *
 * WHAT COUNTS AS ACTIVITY
 *
 * Deliberate page loads and navigations. Not the minute-by-minute polling
 * three screens do while their tab is open, not a `<Link>` prefetch. How
 * that is decided - and what Next.js does and does not let us see - is under
 * PAGE_REQUEST_HEADER below.
 */

/**
 * The one application timezone for the day boundary.
 *
 * America/New_York, not UTC. Midnight UTC is 8 PM in Cincinnati for half the
 * year and 7 PM for the other half, so a UTC day would roll while people are
 * still working: somebody active at 7:30 PM and again at 8:30 PM would have
 * their anchor moved mid-evening. The company works in one timezone and the
 * greeting is read in it, so the boundary is drawn in it.
 *
 * Also the zone the greeting FORMATS in. Home is a server component, so a
 * `toLocaleTimeString()` with no zone renders in the container's zone - UTC
 * on Azure - and "yesterday at 4:52 PM" would have been "yesterday at 8:52
 * PM" in production. One zone for the boundary and the display, so the two
 * cannot disagree.
 */
export const APP_TIME_ZONE = "America/New_York";

/**
 * How stale the stored value must be before a request writes it.
 *
 * A write per request would be one UPDATE per page load, per person, with no
 * benefit: the anchor only cares which DAY the last action fell on, and the
 * live value is shown nowhere. Five minutes is a few writes per person per
 * day. The rollover itself is not throttled by this - the first action of a
 * new day is by definition more than five minutes after the last one of the
 * previous day, unless the two straddle midnight, and a value written at
 * 11:58 PM followed by an action at 12:01 AM correctly waits until 12:03 AM
 * to roll. The anchor is then 11:58 PM of the previous day, which is right.
 */
export const ACTIVITY_WRITE_THROTTLE_MS = 5 * 60 * 1000;

/** What the two columns hold for one employee. Both null until first recorded. */
export interface ActivityRow {
  lastActiveAt: Date | null;
  previousActiveAt: Date | null;
}

/** The UPDATE to make, or nothing. */
export interface ActivityWrite {
  lastActiveAt: Date;
  previousActiveAt: Date | null;
  /** True when this write moved the anchor - the first action of a new day. */
  rolled: boolean;
}

/**
 * The calendar day an instant falls on, in the application timezone, as
 * `YYYY-MM-DD`. Two instants are "the same day" when these strings are equal.
 *
 * `en-CA` is used for its output shape, not its language: it is the one common
 * locale whose short date is ISO-ordered. Node ships full ICU, so the zone
 * lookup is correct across DST - checked in tests/activity.test.ts on the
 * 2026 autumn change.
 */
export function calendarDay(at: Date, zone: string = APP_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * Decide what a deliberate action at `now` does to the two columns.
 *
 * Returns null when nothing should be written: the stored live value is less
 * than the throttle old (including a stored value in the future, which a clock
 * difference between two app instances could produce - writing backwards
 * would be worse than waiting).
 *
 * Otherwise the live value moves to `now`, and the anchor moves ONLY when the
 * stored live value fell on a different calendar day - and then it takes the
 * OLD live value, never `now`. Same day: the anchor is carried across
 * unchanged, so the digest stays stable all day rather than shrinking as you
 * use it.
 *
 * A row with no live value (first activity ever, or a row that predates the
 * columns) gets `now` as its live value and keeps a null anchor: there is no
 * earlier active day to date a window from, and Home says nothing about one.
 */
export function planActivityWrite(
  row: ActivityRow,
  now: Date,
  zone: string = APP_TIME_ZONE,
): ActivityWrite | null {
  const stored = row.lastActiveAt;

  if (stored !== null) {
    const age = now.getTime() - stored.getTime();
    if (age < ACTIVITY_WRITE_THROTTLE_MS) return null;

    const rolled = calendarDay(stored, zone) !== calendarDay(now, zone);
    return {
      lastActiveAt: now,
      // The OLD live value on a new day; the existing anchor otherwise. Never
      // `now` - that is the trap in the file comment.
      previousActiveAt: rolled ? stored : row.previousActiveAt,
      rolled,
    };
  }

  return { lastActiveAt: now, previousActiveAt: row.previousActiveAt, rolled: false };
}

/** The subset of a header bag this module reads. `Headers` satisfies it. */
export interface HeaderReader {
  get(name: string): string | null;
}

/**
 * Is a request for this path a request for a PAGE, as opposed to an API
 * route? Pages are where deliberate loads and navigations land. API routes
 * are where every background request goes: Collection Health, the Point
 * Explorer and the mailbox workspace each poll their route every minute
 * while the tab is visible, and none of that may count as being here.
 */
export function isPageRequest(pathname: string): boolean {
  return pathname !== "/api" && !pathname.startsWith("/api/");
}

/**
 * The request header the middleware stamps with `isPageRequest`'s answer,
 * and the ONLY thing the authorization guard reads to decide whether a
 * request can be activity.
 *
 * WHAT CAN AND CANNOT BE SEEN - measured on next@15.5.23, 2026-09-18, by
 * tests/middleware-http.test.ts driving the real middleware and a real
 * render:
 *
 *   - Next's own router headers - `rsc`, `next-router-prefetch`,
 *     `next-router-segment-prefetch`, `next-hmr-refresh`,
 *     `next-router-state-tree`, the FLIGHT_HEADERS - are invisible to BOTH
 *     the middleware and a page. The middleware adapter
 *     (next/dist/server/web/adapter.js) deletes them before invoking the
 *     middleware and re-attaches them only afterwards; the request store
 *     (next/dist/server/async-storage/request-store.js) deletes them again
 *     before a render's `headers()`. So no code of ours can tell a soft
 *     navigation from a prefetch by header. The first version of this file
 *     tried to, and the end-to-end test found it out.
 *   - `sec-fetch-mode` does reach both, but a soft navigation and a poll are
 *     both `cors`, so it separates nothing that matters.
 *   - The PATHNAME is visible to the middleware. That separates a page from
 *     an API route, and that is the whole stamp.
 *
 * Prefetches are excluded STRUCTURALLY rather than by header. A prefetch of
 * a dynamic route renders no components at all unless a `loading.tsx` exists
 * somewhere below it (walk-tree-with-flight-router-state.js), and where one
 * does, the render stops AT that boundary (create-component-tree.js): the
 * layouts above it run, the page beneath it does not. So the only component
 * a prefetch can ever reach in this app is the shared shell, and the shell
 * passes `recordActivity: false` to the guard. Every page calls a guard of
 * its own - that is the authorization contract - and those calls record.
 * See requireAuthenticated in lib/authz/guard.ts.
 *
 * Nothing else may set or read this header.
 */
export const PAGE_REQUEST_HEADER = "x-phb-page-request";

/**
 * The request headers to forward, with the page stamp written in.
 *
 * Always written - set to "1" or deleted - so a value the client sent is
 * never passed through. Spoofing it would only move the spoofer's own
 * anchor, but the guard's contract is "the middleware decided this", and a
 * header that might be either is not that.
 */
export function stampPageRequest(
  pathname: string,
  raw: Iterable<[string, string]>,
): Headers {
  const forwarded = new Headers();
  for (const [name, value] of raw) forwarded.set(name, value);

  if (isPageRequest(pathname)) {
    forwarded.set(PAGE_REQUEST_HEADER, "1");
  } else {
    forwarded.delete(PAGE_REQUEST_HEADER);
  }
  return forwarded;
}

/** What the guard asks of the stamped bag. */
export function isStampedPageRequest(stamped: HeaderReader): boolean {
  return stamped.get(PAGE_REQUEST_HEADER) === "1";
}

/**
 * "yesterday at 4:52 PM", "today at 9:03 AM", or "on Monday 14 September at
 * 12:58 PM", all in the application timezone.
 *
 * Relative for the last day because "yesterday at 4:52 PM" is what somebody
 * actually remembers; absolute beyond that, because "17 days ago" is a number
 * you have to do arithmetic on to place. The year is omitted: a gap of a year
 * or more reads with the same words and the date is still true, and an
 * internal tool nobody has been absent from for a year does not need to spend
 * the width on it.
 *
 * `today` and `yesterday` are decided by calendar day in the zone, not by
 * 24-hour distance - 11 PM followed by 1 AM is "yesterday", which is what the
 * person would say.
 */
export function describeLastHere(
  at: Date,
  now: Date,
  zone: string = APP_TIME_ZONE,
): string {
  const time = at.toLocaleTimeString("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
  });

  const day = calendarDay(at, zone);
  const today = calendarDay(now, zone);
  if (day === today) return `today at ${time}`;

  // Yesterday is arithmetic on the calendar day, not `now` minus 24 hours: the
  // day the clocks fall back is 25 hours long, and at 11:30 PM on it "24 hours
  // ago" is still the same day.
  if (day === previousCalendarDay(today)) return `yesterday at ${time}`;

  const date = at.toLocaleDateString("en-GB", {
    timeZone: zone,
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  return `on ${date} at ${time}`;
}

/** The `YYYY-MM-DD` before a `YYYY-MM-DD`. Pure date arithmetic; no zone involved. */
export function previousCalendarDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const previous = new Date(Date.UTC(y, m - 1, d - 1));
  return previous.toISOString().slice(0, 10);
}

/**
 * "Good morning" by the application clock.
 *
 * Home is a server component, so `new Date().getHours()` would be the
 * container's hour - UTC on Azure - and 9 AM in Cincinnati would read "Good
 * afternoon". Same zone as everything else on the page.
 */
export function greetingFor(now: Date, zone: string = APP_TIME_ZONE): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "numeric",
      hourCycle: "h23",
    }).format(now),
  );
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}
