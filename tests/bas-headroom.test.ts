import { describe, expect, it } from "vitest";
import {
  computeHeadroom,
  describeHeadroom,
} from "@/app/(modules)/bas/health-client";
import type { PointHealthRow } from "@/lib/modules/bas/types";

/**
 * Headroom - hours until the station starts overwriting data nobody collected.
 *
 * The BAS answer to the delta badge, and a different idiom on purpose: a
 * comparison dashboard asks whether a number moved, and this one asks how much
 * time is left.
 *
 * The rule these tests exist for is the same one the whole screen turns on. A
 * point whose roll horizon is unknown contributes NOTHING, and a set that is
 * only partly known must say so rather than reporting a clean minimum over the
 * points that happen to have one. A confident number that hides the gap is worse
 * than no number.
 */

function point(over: Partial<PointHealthRow> = {}): PointHealthRow {
  return {
    pointId: "p1",
    pointName: "points_RoomT",
    siteName: "Lab",
    pointRole: "room_temp",
    unit: "°F",
    risk: "ok",
    lastReadingAt: "2026-08-28T12:00:00.000Z",
    minutesAgo: 60,
    rollHorizonHours: 41.7,
    ...over,
  };
}

describe("the number itself", () => {
  it("is the horizon less the time since collection", () => {
    // 41.7 h horizon, collected an hour ago.
    expect(computeHeadroom([point()]).hours).toBeCloseTo(40.7, 5);
  });

  it("takes the SMALLEST across points, not the average", () => {
    /**
     * The first point to run out decides when data starts being lost. An average
     * would report comfort while one sensor was minutes from the edge.
     */
    const result = computeHeadroom([
      point({ pointId: "a", minutesAgo: 60 }),
      point({ pointId: "b", minutesAgo: 40 * 60 }),
      point({ pointId: "c", minutesAgo: 120 }),
    ]);

    expect(result.hours).toBeCloseTo(1.7, 5);
    expect(result.known).toBe(3);
  });

  it("goes negative when a point is already past its horizon", () => {
    // Not clamped to zero: "already losing" is a different fact from "just ran
    // out", and the caller decides how to say it.
    const result = computeHeadroom([point({ minutesAgo: 50 * 60 })]);

    expect(result.hours).toBeLessThan(0);
  });

  it("handles differing horizons across points", () => {
    const result = computeHeadroom([
      point({ pointId: "a", rollHorizonHours: 41.7, minutesAgo: 60 }),
      point({ pointId: "b", rollHorizonHours: 6, minutesAgo: 60 }),
    ]);

    expect(result.hours).toBeCloseTo(5, 5);
  });
});

describe("what does NOT contribute", () => {
  /**
   * The rule the screen exists for, applied to the badge.
   */
  it("excludes a point whose horizon is unknown", () => {
    const result = computeHeadroom([
      point({ pointId: "known", minutesAgo: 60 }),
      point({ pointId: "unknown", rollHorizonHours: null, risk: "roll_horizon_unknown" }),
    ]);

    expect(result.known).toBe(1);
    expect(result.unknown).toBe(1);
    // The number covers the known point only.
    expect(result.hours).toBeCloseTo(40.7, 5);
  });

  it("excludes a point that has never been collected", () => {
    // No "time since" to subtract, so there is no headroom to compute - not zero.
    const result = computeHeadroom([
      point({ pointId: "never", minutesAgo: null, lastReadingAt: null, risk: "never_collected" }),
    ]);

    expect(result.known).toBe(0);
    expect(result.unknown).toBe(1);
    expect(result.hours).toBeNull();
  });

  it("reports no number at all when nothing is computable", () => {
    const result = computeHeadroom([
      point({ pointId: "a", rollHorizonHours: null }),
      point({ pointId: "b", rollHorizonHours: null }),
    ]);

    expect(result.hours).toBeNull();
    expect(result.known).toBe(0);
    expect(result.unknown).toBe(2);
  });

  it("counts an empty set as nothing rather than as healthy", () => {
    expect(computeHeadroom([])).toEqual({
      hours: null,
      known: 0,
      unknown: 0,
      total: 0,
    });
  });
});

describe("the badge never hides an unknown behind a clean number", () => {
  it("says the number plainly when every point is known", () => {
    const text = describeHeadroom(computeHeadroom([point(), point({ pointId: "b" })]));

    expect(text).toBe("40.7 h headroom");
    expect(text).not.toContain("unknown");
  });

  it("says how much of the set the number covers when part is unknown", () => {
    const points = [
      point({ pointId: "a", minutesAgo: 60 }),
      point({ pointId: "b", minutesAgo: 60 }),
      point({ pointId: "c", minutesAgo: 60 }),
      point({ pointId: "d", rollHorizonHours: null, risk: "roll_horizon_unknown" }),
    ];

    expect(describeHeadroom(computeHeadroom(points))).toBe(
      "40.7 h headroom across 3 of 4 points, 1 unknown",
    );
  });

  it("refuses a number entirely when no horizon is known", () => {
    const points = [
      point({ pointId: "a", rollHorizonHours: null }),
      point({ pointId: "b", rollHorizonHours: null }),
    ];

    expect(describeHeadroom(computeHeadroom(points))).toBe("Headroom unknown");
  });

  it("never reports a bare figure computed from a subset", () => {
    /**
     * The failure this whole file is about: three healthy points and one whose
     * horizon nobody filled in must NOT render as a confident "40.7 h".
     */
    const points = [
      point({ pointId: "a" }),
      point({ pointId: "b" }),
      point({ pointId: "c" }),
      point({ pointId: "d", rollHorizonHours: null, risk: "roll_horizon_unknown" }),
    ];

    expect(describeHeadroom(computeHeadroom(points))).not.toBe("40.7 h headroom");
  });

  it("says there is none left rather than a negative number", () => {
    const text = describeHeadroom(computeHeadroom([point({ minutesAgo: 50 * 60 })]));

    expect(text).toBe("No headroom left");
    expect(text).not.toContain("-");
  });

  it("still names the unknown share when there is no headroom left", () => {
    const points = [
      point({ pointId: "a", minutesAgo: 50 * 60 }),
      point({ pointId: "b", rollHorizonHours: null }),
    ];

    expect(describeHeadroom(computeHeadroom(points))).toBe(
      "No headroom left across 1 of 2 points, 1 unknown",
    );
  });

  it("has an honest answer for an empty site", () => {
    expect(describeHeadroom(computeHeadroom([]))).toBe("No active points");
  });
});
