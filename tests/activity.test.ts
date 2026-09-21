import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

/**
 * "When was this person last here", and the one failure that would never be
 * noticed.
 *
 * THE BUG THIS FILE EXISTS FOR. The greeting and the digest are dated from
 * `previous_active_at`, an anchor frozen for a whole calendar day. If they
 * were dated from `last_active_at` - the value the request rendering the page
 * has just moved - the window would be zero seconds wide, the digest
 * permanently empty, and the screen would look completely normal. Nothing
 * would throw, nothing would look wrong, and it would be noticed months later,
 * if at all. Same shape as a backup that never ran.
 *
 * THE MUTATION WAS RUN. Changing the rollover in lib/activity/rollover.ts to
 * hand the anchor the live value -
 *
 *     previousActiveAt: rolled ? now : row.previousActiveAt,
 *
 * - fails EIGHT of the 38 tests in this file (run on 2026-09-18): the three
 * rollover tests that read the anchor back, the midnight-boundary test, and
 * all four guard tests that cross a day. And on every one of those the
 * database refused the UPDATE first - `23514`, check constraint
 * `employees_previous_active_before_last` - so in production the mutated
 * code would have logged `activity.record_failed` on the first morning
 * rather than shipping an empty digest for months.
 *
 * The second failure guarded here is quieter still: Collection Health refreshes
 * itself every minute while its tab is open. If a poll counted as activity, a
 * tab left open overnight would anchor the next morning at 11:59 PM and the
 * digest would cover nothing at all - the same empty page, arrived at from the
 * other direction. "an idle tab polling across midnight" is that test.
 *
 * Everything here runs with `headers()` mocked to what the middleware would
 * have stamped. The one thing a mock cannot prove - that the stamp survives
 * Next's own header handling into a real render, and that a real prefetch
 * never reaches a page - is proved over a socket in
 * tests/middleware-http.test.ts.
 */

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));

import { auth } from "@/auth";
import { headers } from "next/headers";
import { requireAuthenticated, requireEmployee } from "@/lib/authz";
import { recordActivity } from "@/lib/activity/record";
import {
  ACTIVITY_WRITE_THROTTLE_MS,
  APP_TIME_ZONE,
  PAGE_REQUEST_HEADER,
  calendarDay,
  describeLastHere,
  greetingFor,
  isPageRequest,
  isStampedPageRequest,
  planActivityWrite,
  previousCalendarDay,
  stampPageRequest,
} from "@/lib/activity/rollover";
import { createEmployee, disconnectDb, resetDb, testDb } from "./db";

const authMock = vi.mocked(auth);
const headersMock = vi.mocked(headers);

/** Eastern time as a UTC instant. EDT is -04:00; 2026-11-01 is the fall-back date. */
const edt = (iso: string): Date => new Date(`${iso}-04:00`);
const est = (iso: string): Date => new Date(`${iso}-05:00`);

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

/**
 * What the guard's `headers()` returns for a request to this path: the raw
 * headers after the middleware has stamped them. `stampPageRequest` is the
 * middleware's own function, so the guard tests below read the same bag a
 * page does. The raw headers carry nothing that matters - Next hides its
 * router headers from both the middleware and the render - so a request is
 * described by its path alone.
 */
function requestTo(pathname: string, raw: Record<string, string> = {}) {
  headersMock.mockResolvedValue(
    stampPageRequest(pathname, Object.entries(raw)) as never,
  );
}

/** A page. Every deliberate load or navigation is one of these. */
const A_PAGE = "/bas";
/** Collection Health's minute poll. Every background request is one of these. */
const A_POLL = "/api/modules/bas/collection-health";

async function rowFor(entraOid: string) {
  const row = await testDb.employee.findUnique({ where: { entraOid } });
  if (row === null) throw new Error(`no employee ${entraOid}`);
  return row;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await disconnectDb();
});

// ------------------------------------------------------- the rollover rule

describe("the rollover", () => {
  const anchorDay = edt("2026-09-14T16:58:00");

  it("carries the OLD live value into the anchor on a new day, never the new one", () => {
    const now = edt("2026-09-15T08:15:00");

    const plan = planActivityWrite(
      { lastActiveAt: anchorDay, previousActiveAt: null },
      now,
    );

    expect(plan).not.toBeNull();
    expect(plan!.rolled).toBe(true);
    // The whole design in one assertion.
    expect(plan!.previousActiveAt?.getTime()).toBe(anchorDay.getTime());
    expect(plan!.previousActiveAt?.getTime()).not.toBe(now.getTime());
    expect(plan!.lastActiveAt.getTime()).toBe(now.getTime());
  });

  it("leaves the anchor alone during a single day's use", () => {
    const anchor = edt("2026-09-14T16:58:00");
    let live = edt("2026-09-15T08:15:00");

    // Nine actions spread across one working day.
    for (const at of [
      "2026-09-15T08:40:00",
      "2026-09-15T09:30:00",
      "2026-09-15T10:05:00",
      "2026-09-15T11:59:00",
      "2026-09-15T13:20:00",
      "2026-09-15T14:00:00",
      "2026-09-15T16:45:00",
      "2026-09-15T17:30:00",
      "2026-09-15T18:02:00",
    ]) {
      const plan = planActivityWrite(
        { lastActiveAt: live, previousActiveAt: anchor },
        edt(at),
      );
      expect(plan).not.toBeNull();
      expect(plan!.rolled).toBe(false);
      // Frozen. A digest that shrank as you used it would be worse than useless.
      expect(plan!.previousActiveAt?.getTime()).toBe(anchor.getTime());
      live = plan!.lastActiveAt;
    }

    expect(live.getTime()).toBe(edt("2026-09-15T18:02:00").getTime());
  });

  it("rolls exactly once per day, not once per request", () => {
    let row = {
      lastActiveAt: edt("2026-09-14T16:58:00") as Date | null,
      previousActiveAt: null as Date | null,
    };

    // Four actions on the 15th and three on the 16th.
    const actions = [
      "2026-09-15T08:15:00",
      "2026-09-15T09:00:00",
      "2026-09-15T13:00:00",
      "2026-09-15T17:45:00",
      "2026-09-16T07:50:00",
      "2026-09-16T12:10:00",
      "2026-09-16T16:30:00",
    ];

    const rolls: string[] = [];
    for (const at of actions) {
      const plan = planActivityWrite(row, edt(at));
      expect(plan).not.toBeNull();
      if (plan!.rolled) rolls.push(at);
      row = {
        lastActiveAt: plan!.lastActiveAt,
        previousActiveAt: plan!.previousActiveAt,
      };
    }

    // Two new days, two rolls - the first action of each.
    expect(rolls).toEqual(["2026-09-15T08:15:00", "2026-09-16T07:50:00"]);
    // And the anchor is the last action of the 15th, not the first.
    expect(row.previousActiveAt?.getTime()).toBe(edt("2026-09-15T17:45:00").getTime());
  });

  it("opens a window that is never empty - the point of the whole design", () => {
    let row = {
      lastActiveAt: edt("2026-09-14T09:00:00") as Date | null,
      previousActiveAt: null as Date | null,
    };

    for (const at of [
      "2026-09-14T17:10:00",
      "2026-09-15T08:15:00",
      "2026-09-15T16:40:00",
      "2026-09-16T08:05:00",
    ]) {
      const plan = planActivityWrite(row, edt(at));
      row = {
        lastActiveAt: plan!.lastActiveAt,
        previousActiveAt: plan!.previousActiveAt,
      };

      if (row.previousActiveAt !== null) {
        // Strictly earlier, always. Equal is the silent-empty-digest bug.
        expect(row.previousActiveAt.getTime()).toBeLessThan(
          row.lastActiveAt!.getTime(),
        );
      }
    }
  });

  it("writes nothing when the stored value is under five minutes old", () => {
    const stored = edt("2026-09-15T09:00:00");

    expect(
      planActivityWrite(
        { lastActiveAt: stored, previousActiveAt: null },
        new Date(stored.getTime() + ACTIVITY_WRITE_THROTTLE_MS - 1),
      ),
    ).toBeNull();

    expect(
      planActivityWrite(
        { lastActiveAt: stored, previousActiveAt: null },
        new Date(stored.getTime() + ACTIVITY_WRITE_THROTTLE_MS),
      ),
    ).not.toBeNull();
  });

  it("does not write backwards when a stored value is in the future", () => {
    // Two app instances whose clocks differ. Waiting is better than rewinding.
    const stored = edt("2026-09-15T09:10:00");
    expect(
      planActivityWrite(
        { lastActiveAt: stored, previousActiveAt: null },
        edt("2026-09-15T09:00:00"),
      ),
    ).toBeNull();
  });

  it("gives a row with no activity a live value and no anchor", () => {
    const now = edt("2026-09-15T08:15:00");
    const plan = planActivityWrite({ lastActiveAt: null, previousActiveAt: null }, now);

    expect(plan).toEqual({ lastActiveAt: now, previousActiveAt: null, rolled: false });
  });
});

// --------------------------------------------------------- the day boundary

describe("the day boundary", () => {
  it("is drawn in the application timezone, not UTC", () => {
    /**
     * 8 PM in Cincinnati is midnight UTC. Under a UTC boundary the anchor
     * would roll while people are still working - somebody active at 7:30 PM
     * and again at 8:30 PM would find their morning greeting dating from
     * 7:30 PM the same evening.
     */
    const beforeEight = edt("2026-09-15T19:30:00");
    const afterEight = edt("2026-09-15T20:30:00");

    expect(calendarDay(beforeEight)).toBe("2026-09-15");
    expect(calendarDay(afterEight)).toBe("2026-09-15");
    // The same two instants, in UTC, are on different days. That is the bug.
    expect(beforeEight.toISOString().slice(0, 10)).toBe("2026-09-15");
    expect(afterEight.toISOString().slice(0, 10)).toBe("2026-09-16");

    const plan = planActivityWrite(
      { lastActiveAt: beforeEight, previousActiveAt: null },
      afterEight,
    );
    expect(plan!.rolled).toBe(false);
  });

  it("is midnight Eastern, and rolls there", () => {
    const lateNight = edt("2026-09-15T23:50:00");
    const justAfter = edt("2026-09-16T00:10:00");

    expect(calendarDay(lateNight)).toBe("2026-09-15");
    expect(calendarDay(justAfter)).toBe("2026-09-16");

    const plan = planActivityWrite(
      { lastActiveAt: lateNight, previousActiveAt: null },
      justAfter,
    );
    expect(plan!.rolled).toBe(true);
    expect(plan!.previousActiveAt?.getTime()).toBe(lateNight.getTime());
  });

  it("survives the day the clocks go back, which is 25 hours long", () => {
    // 2026-11-01: EDT ends at 02:00, so 01:30 happens twice.
    const firstOneThirty = edt("2026-11-01T01:30:00");
    const secondOneThirty = est("2026-11-01T01:30:00");

    expect(secondOneThirty.getTime() - firstOneThirty.getTime()).toBe(3_600_000);
    expect(calendarDay(firstOneThirty)).toBe("2026-11-01");
    expect(calendarDay(secondOneThirty)).toBe("2026-11-01");

    const plan = planActivityWrite(
      { lastActiveAt: firstOneThirty, previousActiveAt: null },
      secondOneThirty,
    );
    // Same calendar day. An hour of wall clock passed and the anchor stays put.
    expect(plan!.rolled).toBe(false);

    /**
     * And "yesterday" is calendar arithmetic rather than `now` minus 24 hours:
     * at 11:30 PM on a 25-hour day, 24 hours earlier is still the same day.
     */
    expect(previousCalendarDay("2026-11-01")).toBe("2026-10-31");
    expect(
      describeLastHere(est("2026-11-01T23:00:00"), est("2026-11-01T23:30:00")),
    ).toBe("today at 11:00 PM");
  });

  it("names the day the same way on both sides of a month and a year", () => {
    expect(previousCalendarDay("2026-03-01")).toBe("2026-02-28");
    expect(previousCalendarDay("2027-01-01")).toBe("2026-12-31");
  });
});

// ------------------------------------------------------------- what it says

describe("the wording", () => {
  const now = edt("2026-09-15T09:30:00");

  it("reads a gap of minutes as today", () => {
    expect(describeLastHere(edt("2026-09-15T08:52:00"), now)).toBe("today at 8:52 AM");
  });

  it("reads a gap of hours across midnight as yesterday", () => {
    expect(describeLastHere(edt("2026-09-14T16:52:00"), now)).toBe(
      "yesterday at 4:52 PM",
    );
  });

  it("names the weekday and date for a gap of days", () => {
    expect(describeLastHere(edt("2026-09-14T12:58:00"), edt("2026-09-18T09:00:00"))).toBe(
      "on Monday 14 September at 12:58 PM",
    );
  });

  it("names the date for a gap of months, without arithmetic for the reader", () => {
    expect(describeLastHere(edt("2026-06-03T14:05:00"), now)).toBe(
      "on Wednesday 3 June at 2:05 PM",
    );
  });

  it("formats in the application timezone, not the server's", () => {
    /**
     * Home is a server component. On Azure the container runs in UTC, so a
     * plain toLocaleTimeString() would have rendered "yesterday at 8:52 PM"
     * for a 4:52 PM visit. The zone is passed explicitly everywhere.
     */
    const at = edt("2026-09-14T16:52:00");
    expect(at.toLocaleTimeString("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" })).toBe(
      "8:52 PM",
    );
    expect(describeLastHere(at, now)).toContain("4:52 PM");
  });

  it("greets by the application clock", () => {
    // 09:00 Eastern is 13:00 UTC. A UTC hour would say "Good afternoon".
    expect(greetingFor(edt("2026-09-15T09:00:00"))).toBe("Good morning");
    expect(greetingFor(edt("2026-09-15T13:00:00"))).toBe("Good afternoon");
    expect(greetingFor(edt("2026-09-15T19:00:00"))).toBe("Good evening");
  });

  it("uses one application timezone, and it is not UTC", () => {
    expect(APP_TIME_ZONE).toBe("America/New_York");
  });
});

// ------------------------------------------------------- what counts as use

describe("what counts as activity", () => {
  it("is a request for a page", () => {
    for (const path of ["/", "/bas", "/bas/points", "/change-orders", "/admin", "/onboarding", "/profile"]) {
      expect(isPageRequest(path), path).toBe(true);
    }
  });

  it("is never a request to an API route - which is where every poll goes", () => {
    for (const path of [
      "/api",
      "/api/me",
      "/api/modules/bas/collection-health",
      "/api/modules/bas/point-explorer",
      "/api/modules/change-orders/mailbox/folders",
      "/api/health",
    ]) {
      expect(isPageRequest(path), path).toBe(false);
    }
  });

  it("does not decide from headers, because none it could use survive", () => {
    /**
     * Measured against the real middleware and a real render in
     * tests/middleware-http.test.ts: `rsc` and `next-router-prefetch` reach
     * neither, and `sec-fetch-mode` is `cors` for a soft navigation and a
     * poll alike. A version of this module that read them was found out by
     * that test. The rule is the path, and only the path.
     */
    const source = String(isPageRequest);
    for (const header of ["rsc", "prefetch", "sec-fetch"]) {
      expect(source).not.toContain(header);
    }
  });
});

describe("the middleware's stamp", () => {
  it("writes the decision into a header of ours, and forwards everything else", () => {
    const stamped = stampPageRequest("/bas", [["cookie", "authjs.session-token=x"]]);

    expect(stamped.get(PAGE_REQUEST_HEADER)).toBe("1");
    expect(stamped.get("cookie")).toBe("authjs.session-token=x");
    expect(isStampedPageRequest(stamped)).toBe(true);
  });

  it("removes the header rather than leaving it absent-by-luck on an API route", () => {
    const stamped = stampPageRequest(A_POLL, []);
    expect(stamped.has(PAGE_REQUEST_HEADER)).toBe(false);
    expect(isStampedPageRequest(stamped)).toBe(false);
  });

  it("overwrites a value the client sent, in both directions", () => {
    // A poll claiming to be a page.
    const forged = stampPageRequest(A_POLL, [[PAGE_REQUEST_HEADER, "1"]]);
    expect(forged.has(PAGE_REQUEST_HEADER)).toBe(false);

    // A page claiming not to be one.
    const denied = stampPageRequest(A_PAGE, [[PAGE_REQUEST_HEADER, "0"]]);
    expect(denied.get(PAGE_REQUEST_HEADER)).toBe("1");
  });
});

describe("prefetches are excluded by structure", () => {
  it("the shared shell is the one caller that opts out, and says why", async () => {
    const shell = await readFile(
      path.join(process.cwd(), "components/app-shell.tsx"),
      "utf8",
    );
    /**
     * A prefetch renders nothing unless a `loading.tsx` sits below it, and
     * where one does the render stops at that boundary: the shell runs, the
     * page does not. So the shell must not record, and nothing else may opt
     * out - a page that did would make its own navigations invisible.
     */
    expect(shell).toContain("requireAuthenticated({ recordActivity: false })");

    const others = await Promise.all(
      [
        "app/(platform)/page.tsx",
        "app/(modules)/bas/page.tsx",
        "app/(modules)/change-orders/page.tsx",
        "app/(platform)/admin/page.tsx",
        "app/onboarding/page.tsx",
      ].map((file) => readFile(path.join(process.cwd(), file), "utf8")),
    );
    for (const source of others) {
      expect(source).not.toContain("recordActivity: false");
    }
  });

  it("names the loading boundaries that make the opt-out necessary", async () => {
    /**
     * If this list changes, re-read the shell's comment and the note in
     * lib/authz/guard.ts. A `loading.tsx` under a route is what lets a
     * prefetch reach the shell at all; a new one is fine, a new one placed
     * so that a PAGE renders during a prefetch is not, and the end-to-end
     * test in tests/middleware-http.test.ts is where that would show.
     */
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(path.join(process.cwd(), "app"), { recursive: true });
    const found = entries
      .map((entry) => `app/${entry.replace(/\\/g, "/")}`)
      .filter((entry) => entry.endsWith("/loading.tsx"));
    expect(found.sort()).toEqual([
      "app/(platform)/admin/audit/loading.tsx",
      "app/(platform)/admin/loading.tsx",
    ]);
  });
});

// ------------------------------------------- the guard, against the database

describe("the authorization guard records activity", () => {
  beforeEach(async () => {
    await createEmployee({ entraOid: "oid-activity", email: "activity@phb1899.com" });
    signedInAs("oid-activity");
  });

  it("stamps the live value on a page load, and no anchor on the first day", async () => {
    requestTo(A_PAGE);

    const access = await requireAuthenticated();
    expect(access.ok).toBe(true);

    const row = await rowFor("oid-activity");
    expect(row.lastActiveAt).toBeInstanceOf(Date);
    // Nothing to date a window from yet, and Home says nothing rather than
    // rendering a blank or an epoch date.
    expect(row.previousActiveAt).toBeNull();
  });

  it("does not write on every request", async () => {
    requestTo(A_PAGE);

    await requireAuthenticated();
    const first = await rowFor("oid-activity");

    await new Promise((resolve) => setTimeout(resolve, 25));
    await requireAuthenticated();
    const second = await rowFor("oid-activity");

    // Under the throttle: the same value, not a second UPDATE.
    expect(second.lastActiveAt?.getTime()).toBe(first.lastActiveAt?.getTime());
    expect(second.updatedAt.getTime()).toBe(first.updatedAt.getTime());
  });

  it("records through every guard a page might call", async () => {
    // Pages call requireEmployee, requireModuleAccess, requireAdmin - all of
    // which chain to requireAuthenticated with the default. One is enough to
    // prove the default records; the others are the same call.
    requestTo("/profile");

    const access = await requireEmployee();
    expect(access.ok).toBe(true);

    const row = await rowFor("oid-activity");
    expect(row.lastActiveAt).toBeInstanceOf(Date);
  });

  it("does not record when the caller opts out - the shell during a prefetch", async () => {
    requestTo("/admin");

    const access = await requireAuthenticated({ recordActivity: false });
    expect(access.ok).toBe(true);

    const row = await rowFor("oid-activity");
    expect(row.lastActiveAt).toBeNull();
  });

  it("does not record a poll, or a request outside any page", async () => {
    for (const path of [A_POLL, "/api/me", "/api/health"]) {
      requestTo(path);
      const access = await requireAuthenticated();
      expect(access.ok).toBe(true);
    }

    // `headers()` throwing - a route handler called directly by a test, a
    // script - is "no", not an error.
    headersMock.mockRejectedValue(new Error("outside a request scope") as never);
    expect((await requireAuthenticated()).ok).toBe(true);

    const row = await rowFor("oid-activity");
    expect(row.lastActiveAt).toBeNull();
    expect(row.previousActiveAt).toBeNull();
  });

  it("records nothing for a request it rejects", async () => {
    requestTo(A_PAGE);
    await testDb.employee.update({
      where: { entraOid: "oid-activity" },
      data: { status: "disabled" },
    });

    const access = await requireAuthenticated();
    expect(access.ok).toBe(false);

    const row = await rowFor("oid-activity");
    expect(row.lastActiveAt).toBeNull();
  });

  it("rolls the anchor on the next day's first page load, and only then", async () => {
    // Only Date is faked; the timers Prisma and pg use stay real.
    vi.useFakeTimers({ toFake: ["Date"] });
    requestTo(A_PAGE);

    vi.setSystemTime(edt("2026-09-14T09:05:00"));
    await requireAuthenticated();
    vi.setSystemTime(edt("2026-09-14T16:58:00"));
    await requireAuthenticated();

    const endOfDayOne = await rowFor("oid-activity");
    expect(endOfDayOne.lastActiveAt?.getTime()).toBe(edt("2026-09-14T16:58:00").getTime());
    expect(endOfDayOne.previousActiveAt).toBeNull();

    // Next morning.
    vi.setSystemTime(edt("2026-09-15T08:15:00"));
    await requireAuthenticated();

    const morning = await rowFor("oid-activity");
    expect(morning.previousActiveAt?.getTime()).toBe(edt("2026-09-14T16:58:00").getTime());
    expect(morning.lastActiveAt?.getTime()).toBe(edt("2026-09-15T08:15:00").getTime());

    // Three more page loads the same day. The anchor does not move again.
    for (const at of ["2026-09-15T09:30:00", "2026-09-15T13:00:00", "2026-09-15T17:20:00"]) {
      vi.setSystemTime(edt(at));
      await requireAuthenticated();
      const row = await rowFor("oid-activity");
      expect(row.previousActiveAt?.getTime()).toBe(edt("2026-09-14T16:58:00").getTime());
    }
  });

  it("does not move the anchor for an idle tab polling across midnight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });

    // A real last action: 4:52 PM, then the person goes home.
    requestTo(A_PAGE);
    vi.setSystemTime(edt("2026-09-14T16:52:00"));
    await requireAuthenticated();

    /**
     * Collection Health left open overnight. Every one of these is older than
     * the throttle and several fall on the far side of midnight, so any of
     * them would write - and the 11:59 PM one would become the anchor - if a
     * poll counted as activity.
     */
    requestTo(A_POLL);
    for (let minute = 0; minute <= 16 * 60; minute += 20) {
      vi.setSystemTime(new Date(edt("2026-09-14T17:00:00").getTime() + minute * 60_000));
      await requireAuthenticated();
    }

    const overnight = await rowFor("oid-activity");
    expect(overnight.lastActiveAt?.getTime()).toBe(edt("2026-09-14T16:52:00").getTime());
    expect(overnight.previousActiveAt).toBeNull();

    // The person comes back and actually navigates.
    requestTo(A_PAGE);
    vi.setSystemTime(edt("2026-09-15T09:10:00"));
    await requireAuthenticated();

    const row = await rowFor("oid-activity");
    // Yesterday's real last action, not 11:59 PM, and not this morning.
    expect(row.previousActiveAt?.getTime()).toBe(edt("2026-09-14T16:52:00").getTime());
    expect(describeLastHere(row.previousActiveAt!, edt("2026-09-15T09:10:00"))).toBe(
      "yesterday at 4:52 PM",
    );
  });

  it("leaves the login columns exactly as it found them", async () => {
    const before = await testDb.employee.update({
      where: { entraOid: "oid-activity" },
      data: {
        lastLoginAt: edt("2026-09-08T08:00:00"),
        previousLoginAt: edt("2026-09-01T08:00:00"),
      },
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    requestTo(A_PAGE);
    for (const at of ["2026-09-14T09:00:00", "2026-09-15T09:00:00", "2026-09-16T09:00:00"]) {
      vi.setSystemTime(edt(at));
      await requireAuthenticated();
    }

    const after = await rowFor("oid-activity");
    expect(after.lastLoginAt?.getTime()).toBe(before.lastLoginAt?.getTime());
    expect(after.previousLoginAt?.getTime()).toBe(before.previousLoginAt?.getTime());
    // And the activity columns did move, so this is not passing by doing nothing.
    expect(after.previousActiveAt?.getTime()).toBe(edt("2026-09-15T09:00:00").getTime());
  });

  it("does not roll twice when two tabs load at once on a new day", async () => {
    const employee = await rowFor("oid-activity");
    const yesterday = edt("2026-09-14T16:58:00");
    await testDb.employee.update({
      where: { id: employee.id },
      data: { lastActiveAt: yesterday },
    });

    const row = { id: employee.id, lastActiveAt: yesterday, previousActiveAt: null };
    const now = edt("2026-09-15T08:15:00");

    // Both tabs read the same row and plan the same rollover.
    await recordActivity(row, now);
    await recordActivity(row, new Date(now.getTime() + 1000));

    const after = await rowFor("oid-activity");
    // The second matched zero rows. The anchor is yesterday, not this morning.
    expect(after.previousActiveAt?.getTime()).toBe(yesterday.getTime());
    expect(after.lastActiveAt?.getTime()).toBe(now.getTime());
  });
});

// ------------------------------------------------- the database's own guard

describe("the database refuses the silent-empty-digest bug", () => {
  it("rejects an anchor equal to the live value", async () => {
    const employee = await createEmployee({ entraOid: "oid-check" });
    const at = edt("2026-09-15T09:00:00");

    /**
     * This is the mutated rollover's write, issued directly. Correct code can
     * never produce it - the anchor is always a copy of an OLDER live value -
     * so the constraint costs nothing and turns an invisible failure into a
     * loud one.
     */
    await expect(
      testDb.employee.update({
        where: { id: employee.id },
        data: { lastActiveAt: at, previousActiveAt: at },
      }),
    ).rejects.toThrow(/employees_previous_active_before_last/);
  });

  it("rejects an anchor later than the live value", async () => {
    const employee = await createEmployee({ entraOid: "oid-check-2" });

    await expect(
      testDb.employee.update({
        where: { id: employee.id },
        data: {
          lastActiveAt: edt("2026-09-15T09:00:00"),
          previousActiveAt: edt("2026-09-15T09:30:00"),
        },
      }),
    ).rejects.toThrow(/employees_previous_active_before_last/);
  });

  it("rejects an anchor with no live value at all", async () => {
    const employee = await createEmployee({ entraOid: "oid-check-3" });

    await expect(
      testDb.employee.update({
        where: { id: employee.id },
        data: { previousActiveAt: edt("2026-09-15T09:00:00") },
      }),
    ).rejects.toThrow(/employees_previous_active_before_last/);
  });

  it("accepts the shape correct code writes", async () => {
    const employee = await createEmployee({ entraOid: "oid-check-4" });

    const row = await testDb.employee.update({
      where: { id: employee.id },
      data: {
        lastActiveAt: edt("2026-09-15T09:00:00"),
        previousActiveAt: edt("2026-09-14T17:00:00"),
      },
    });

    expect(row.previousActiveAt!.getTime()).toBeLessThan(row.lastActiveAt!.getTime());
  });
});

// ------------------------------------------------------ what the page reads

describe("Home reads the anchor and nothing else", () => {
  it("never selects or renders the live value", async () => {
    const service = await readFile(
      path.join(process.cwd(), "lib/home/service.ts"),
      "utf8",
    );
    const page = await readFile(
      path.join(process.cwd(), "app/(platform)/page.tsx"),
      "utf8",
    );
    const code = (text: string) =>
      text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

    /**
     * The mutation this guards is not a wrong constant - it is one word.
     * Reading `lastActiveAt` here dates the digest from the request that is
     * rendering the page, and nothing on screen would look wrong.
     */
    expect(code(service)).not.toContain("lastActiveAt");
    expect(code(page)).not.toContain("lastActiveAt");
    expect(code(service)).toContain("previousActiveAt");

    // And it does not fall back to the authentication columns either.
    for (const column of ["previousLoginAt", "lastLoginAt", "firstSeenAt"]) {
      expect(code(service)).not.toContain(column);
    }
  });

  it("says nothing at all when there is no previous active day", async () => {
    const page = await readFile(
      path.join(process.cwd(), "app/(platform)/page.tsx"),
      "utf8",
    );

    /**
     * Most employee rows are NULL here at first, so this is the common case,
     * not an edge. No blank line, no epoch date, and no "this is your first
     * time here" - that last one would be a false claim about everybody whose
     * row predates the columns.
     */
    const code = page.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).toContain("{lastHere !== null && (");
    expect(code).not.toContain("first time here");
    expect(code).not.toContain("1970");
  });

  it("heads the digest with the same window the greeting names", async () => {
    const page = await readFile(
      path.join(process.cwd(), "app/(platform)/page.tsx"),
      "utf8",
    );

    // One phrase, computed once in getHomeData, rendered in both places.
    expect(page).toContain("You were last here {lastHere.phrase}");
    expect(page).toContain("Since you were last here, {lastHere.phrase}");
    // The old wording claimed a sign-in, which a session lasting days made false.
    expect(page).not.toContain("Last signed in");
    expect(page).not.toContain("Since you last signed in");
  });
});
