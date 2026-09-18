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
    horizonSource: "configured",
    horizon: {
      state: "configured",
      hours: 41.7,
      currentHours: null,
      stationCount: null,
      capacity: 500,
    },
    completeness: "complete",
    stationCount: null,
    heldCount: null,
    visible: true,
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
      notFull: 0,
      total: 0,
    });
  });

  /**
   * A buffer below capacity (2026-09-18). Six office points sat at 300-odd of
   * 500 with nothing overwritten and were filed under "unknown" here, which
   * made the badge read "1 unknown" x 6 for a set that was entirely known.
   */
  it("counts a not-full buffer on its own line, never as unknown", () => {
    const result = computeHeadroom([
      point({ pointId: "known", minutesAgo: 60 }),
      notFull("nf"),
    ]);

    expect(result.known).toBe(1);
    expect(result.unknown).toBe(0);
    expect(result.notFull).toBe(1);
    // The number covers the known point only, and is not dragged to null.
    expect(result.hours).toBeCloseTo(40.7, 5);
  });

  it("does not let a not-full buffer contribute a number", () => {
    // Even with a stale checkpoint - nothing has rolled, so there is nothing
    // to count down towards.
    const result = computeHeadroom([notFull("a", { minutesAgo: 400 * 24 * 60 })]);

    expect(result.hours).toBeNull();
    expect(result.notFull).toBe(1);
    expect(result.unknown).toBe(0);
  });
});

/** OperatingState's shape: 320 of 500 over years, and no horizon at all. */
function notFull(id: string, over: Partial<PointHealthRow> = {}): PointHealthRow {
  return point({
    pointId: id,
    risk: "buffer_not_full",
    rollHorizonHours: null,
    horizonSource: null,
    horizon: { state: "not_full", hours: null, currentHours: null, stationCount: 320, capacity: 500 },
    ...over,
  });
}

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

  it("names a not-full buffer as what it is, not as unknown", () => {
    const text = describeHeadroom(computeHeadroom([point({ minutesAgo: 60 }), notFull("b")]));

    expect(text).toBe("40.7 h headroom across 1 of 2 points, 1 not full yet");
    expect(text).not.toContain("unknown");
  });

  it("names both shares when a set has an unknown and a not-full point", () => {
    const points = [
      point({ pointId: "a", minutesAgo: 60 }),
      point({ pointId: "b", rollHorizonHours: null, risk: "roll_horizon_unknown" }),
      notFull("c"),
    ];

    expect(describeHeadroom(computeHeadroom(points))).toBe(
      "40.7 h headroom across 1 of 3 points, 1 unknown, 1 not full yet",
    );
  });

  it("does not say 'unknown' about a set where every buffer is simply not full", () => {
    const text = describeHeadroom(computeHeadroom([notFull("a"), notFull("b")]));

    expect(text).toBe("No buffer full yet (2 of 2)");
    expect(text).not.toContain("unknown");
  });

  it("keeps the unknown word when a set is part unknown, part not full, and no number is computable", () => {
    const points = [point({ pointId: "a", rollHorizonHours: null }), notFull("b")];

    expect(describeHeadroom(computeHeadroom(points))).toBe(
      "Headroom unknown, 1 not full yet",
    );
  });
});
