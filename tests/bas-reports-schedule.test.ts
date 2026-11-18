import { describe, expect, it } from "vitest";
import {
  ANALYSIS_WINDOWS,
  computeNextRun,
  describeCadence,
  describeSchedule,
  formatInZone,
  localParts,
  readScheduleSpec,
  scheduleParamsOf,
  scheduleProblem,
  todayIn,
  zonedDateTimeToUtc,
  type ScheduleSpec,
} from "@/lib/modules/bas/reports/schedule";

/**
 * The schedule arithmetic (Reports, Phase 1), pure.
 *
 * The one property that matters: a report at 06:00 in the building's zone
 * runs at 06:00 on the building's clock on EVERY day it fires, which means
 * its UTC instant moves by an hour across a clock change. America/New_York
 * leaves daylight time on Sunday 1 November 2026 and enters it on Sunday
 * 8 March 2026; both edges are walked below, and so is every schedule kind.
 */

const NY = "America/New_York";
const iso = (d: Date) => d.toISOString();

describe("next run across the November 2026 clock change", () => {
  it("keeps a weekly Monday 06:00 report at 06:00 local: 10:00Z before the change, 11:00Z after", () => {
    const monday6: ScheduleSpec = { kind: "weekly", weekdays: [1] };
    // Tuesday 20 October 2026, midday UTC. Next Monday is 26 October, still EDT.
    expect(iso(computeNextRun(monday6, "06:00", NY, new Date("2026-10-20T12:00:00Z")))).toBe(
      "2026-10-26T10:00:00.000Z",
    );
    // Tuesday 27 October. Next Monday is 2 November, EST: one hour later in UTC.
    expect(iso(computeNextRun(monday6, "06:00", NY, new Date("2026-10-27T12:00:00Z")))).toBe(
      "2026-11-02T11:00:00.000Z",
    );
    // Both read 06:00 on the building's clock.
    for (const after of ["2026-10-20T12:00:00Z", "2026-10-27T12:00:00Z"]) {
      const next = computeNextRun(monday6, "06:00", NY, new Date(after));
      expect(localParts(next, NY)).toMatchObject({ hour: 6, minute: 0, weekday: 1 });
    }
  });

  it("resolves a local time that happens twice (01:30 on 1 November) to its first occurrence, and does not run it twice", () => {
    const daily: ScheduleSpec = { kind: "daily" };
    // Saturday 31 October, 02:00 EDT (06:00Z). Next 01:30 is Sunday's, which the
    // clock shows twice: at 05:30Z (EDT) and 06:30Z (EST). The first.
    const first = computeNextRun(daily, "01:30", NY, new Date("2026-10-31T06:00:00Z"));
    expect(iso(first)).toBe("2026-11-01T05:30:00.000Z");
    // Advancing from that instant skips the second 01:30 and lands on Monday's.
    expect(iso(computeNextRun(daily, "01:30", NY, first))).toBe("2026-11-02T06:30:00.000Z");
  });

  it("resolves a local time that never happens (02:30 on 8 March) to the instant after the gap", () => {
    // Sunday 8 March 2026, midnight EST (05:00Z). 02:30 is skipped; the clock
    // goes from 02:00 EST to 03:00 EDT at 07:00Z. The report runs at 07:30Z,
    // which the building's clock shows as 03:30.
    const next = computeNextRun({ kind: "daily" }, "02:30", NY, new Date("2026-03-08T05:00:00Z"));
    expect(iso(next)).toBe("2026-03-08T07:30:00.000Z");
    expect(localParts(next, NY)).toMatchObject({ hour: 3, minute: 30 });
  });

  it("converts a wall-clock time through the zone, both ways, with the overlap taking the earlier instant", () => {
    const overlap = zonedDateTimeToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, NY);
    expect(iso(overlap)).toBe("2026-11-01T05:30:00.000Z");
    const plain = zonedDateTimeToUtc({ year: 2026, month: 7, day: 4, hour: 12, minute: 0 }, NY);
    expect(iso(plain)).toBe("2026-07-04T16:00:00.000Z");
    expect(localParts(plain, NY)).toMatchObject({ year: 2026, month: 7, day: 4, hour: 12, minute: 0, weekday: 6 });
  });
});

describe("every schedule kind", () => {
  it("daily: the next occurrence strictly after now, today if the time is still ahead", () => {
    // 10:00Z on 3 November is 05:00 EST; 06:00 is still ahead today.
    expect(iso(computeNextRun({ kind: "daily" }, "06:00", NY, new Date("2026-11-03T10:00:00Z")))).toBe(
      "2026-11-03T11:00:00.000Z",
    );
    // At exactly 06:00 the next run is tomorrow's: strictly after.
    expect(iso(computeNextRun({ kind: "daily" }, "06:00", NY, new Date("2026-11-03T11:00:00Z")))).toBe(
      "2026-11-04T11:00:00.000Z",
    );
  });

  it("every N days counts from the anchor date on the local calendar", () => {
    const spec: ScheduleSpec = { kind: "every_n_days", intervalDays: 3, anchorDate: "2026-11-01" };
    // Sunday 1 November 19:00 EST. 1 November's 06:00 has passed; 4 November is next.
    expect(iso(computeNextRun(spec, "06:00", NY, new Date("2026-11-02T00:00:00Z")))).toBe(
      "2026-11-04T11:00:00.000Z",
    );
    // And from there, 7 November - three calendar days, not 72 hours.
    expect(iso(computeNextRun(spec, "06:00", NY, new Date("2026-11-04T11:00:00Z")))).toBe(
      "2026-11-07T11:00:00.000Z",
    );
    // Before the anchor, the anchor day itself is the first run.
    expect(iso(computeNextRun(spec, "06:00", NY, new Date("2026-10-20T00:00:00Z")))).toBe(
      "2026-11-01T11:00:00.000Z",
    );
  });

  it("weekly on several weekdays picks the nearest, and the zone decides which day it is", () => {
    const spec: ScheduleSpec = { kind: "weekly", weekdays: [1, 4] };
    // Tuesday 3 November: Thursday 5 November is nearer than Monday 9.
    expect(iso(computeNextRun(spec, "06:00", NY, new Date("2026-11-03T12:00:00Z")))).toBe(
      "2026-11-05T11:00:00.000Z",
    );
    // Los Angeles is three hours behind: Monday 06:00 PST is 14:00Z.
    expect(iso(computeNextRun({ kind: "weekly", weekdays: [1] }, "06:00", "America/Los_Angeles", new Date("2026-11-03T00:00:00Z")))).toBe(
      "2026-11-09T14:00:00.000Z",
    );
  });

  it("monthly on day 31 runs on the last day of a shorter month", () => {
    const spec: ScheduleSpec = { kind: "monthly", dayOfMonth: 31 };
    expect(iso(computeNextRun(spec, "06:00", NY, new Date("2026-11-01T00:00:00Z")))).toBe(
      "2026-11-30T11:00:00.000Z",
    );
    expect(iso(computeNextRun(spec, "06:00", NY, new Date("2027-02-01T00:00:00Z")))).toBe(
      "2027-02-28T11:00:00.000Z",
    );
    // A month that has the day runs on it.
    expect(iso(computeNextRun({ kind: "monthly", dayOfMonth: 15 }, "06:00", NY, new Date("2026-11-01T00:00:00Z")))).toBe(
      "2026-11-15T11:00:00.000Z",
    );
  });

  it("refuses a time that is not a time and a schedule that cannot fire", () => {
    expect(() => computeNextRun({ kind: "daily" }, "6:00", NY, new Date())).toThrow(/Not a time of day/);
    expect(() => computeNextRun({ kind: "weekly", weekdays: [] }, "06:00", NY, new Date())).toThrow(/weekday/);
    expect(() => computeNextRun({ kind: "daily" }, "06:00", "Mars/Olympus_Mons", new Date())).toThrow();
  });
});

describe("validation and words", () => {
  it("names the problem with an unsound spec, and nothing with a sound one", () => {
    expect(scheduleProblem({ kind: "daily" })).toBeNull();
    expect(scheduleProblem({ kind: "weekly", weekdays: [1, 1] })).toMatch(/twice/);
    expect(scheduleProblem({ kind: "weekly", weekdays: [8] })).toMatch(/1 \(Monday\) to 7/);
    expect(scheduleProblem({ kind: "every_n_days", intervalDays: 1, anchorDate: "2026-11-01" })).toMatch(/choose Daily/);
    expect(scheduleProblem({ kind: "every_n_days", intervalDays: 3, anchorDate: "2026-02-30" })).toMatch(/calendar date/);
    expect(scheduleProblem({ kind: "monthly", dayOfMonth: 0 })).toMatch(/1 to 31/);
    expect(scheduleProblem({ kind: "monthly", dayOfMonth: 31 })).toBeNull();
  });

  it("says the cadence in plain words, and the whole schedule with its zone and window", () => {
    expect(describeCadence({ kind: "daily" }, "06:00")).toBe("Every day at 06:00");
    expect(describeCadence({ kind: "every_n_days", intervalDays: 3, anchorDate: "2026-11-01" }, "06:00")).toBe("Every 3 days at 06:00");
    expect(describeCadence({ kind: "weekly", weekdays: [4, 1] }, "06:00")).toBe("Every Monday and Thursday at 06:00");
    expect(describeCadence({ kind: "weekly", weekdays: [1, 3, 5] }, "17:30")).toBe("Every Monday, Wednesday and Friday at 17:30");
    expect(describeCadence({ kind: "monthly", dayOfMonth: 1 }, "06:00")).toBe("Monthly on the 1st at 06:00");
    expect(describeCadence({ kind: "monthly", dayOfMonth: 22 }, "06:00")).toBe("Monthly on the 22nd at 06:00");
    expect(describeSchedule({ kind: "weekly", weekdays: [1] }, "06:00", NY, "7d")).toBe(
      "Every Monday at 06:00 (America/New_York) · last 7 days",
    );
    expect(ANALYSIS_WINDOWS).toEqual(["24h", "3d", "7d", "14d", "30d"]);
  });

  it("stores and reads back every kind's parameters, and refuses a row of the wrong shape", () => {
    const specs: ScheduleSpec[] = [
      { kind: "daily" },
      { kind: "every_n_days", intervalDays: 5, anchorDate: "2026-11-10" },
      { kind: "weekly", weekdays: [5, 1] },
      { kind: "monthly", dayOfMonth: 15 },
    ];
    for (const spec of specs) {
      const back = readScheduleSpec(spec.kind, scheduleParamsOf(spec));
      expect(back).not.toBeNull();
      expect(scheduleProblem(back!)).toBeNull();
      if (spec.kind === "weekly") expect(back).toEqual({ kind: "weekly", weekdays: [1, 5] });
      else expect(back).toEqual(spec);
    }
    expect(readScheduleSpec("weekly", {})).toBeNull();
    expect(readScheduleSpec("every_n_days", { intervalDays: "3" })).toBeNull();
    expect(readScheduleSpec("monthly", null)).toBeNull();
    expect(readScheduleSpec("hourly", {})).toBeNull();
  });

  it("formats an instant on the building's clock, and knows today's date there", () => {
    expect(formatInZone(new Date("2026-11-02T11:00:00Z"), NY)).toBe("Mon, 2 Nov 2026, 06:00");
    expect(todayIn(NY, new Date("2026-11-03T03:30:00Z"))).toBe("2026-11-02");
  });
});
