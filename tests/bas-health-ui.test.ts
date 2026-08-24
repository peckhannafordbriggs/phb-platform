import { describe, expect, it } from "vitest";
import {
  AT_RISK_ROLL_RISKS,
  type RollRisk,
  type RunGap,
} from "@/lib/modules/bas/types";
import {
  RISK_LABEL,
  atRiskTone,
  basRiskTone,
  describeRunGap,
  formatCount,
  formatDurationAgainstHorizon,
  formatHours,
  formatMinutes,
  formatTimestamp,
  riskBreakdown,
  runGapTone,
  stalenessTone,
  unclassifiedTone,
} from "@/app/(modules)/bas/health-client";

/**
 * The rules that decide what colour a number is, and what a number reads as.
 *
 * These are pure functions in their own module precisely so this file can exist:
 * the suite runs in a `node` environment with no DOM, and the one thing about
 * this screen that MUST be proved rather than eyeballed is that an unknown never
 * renders green.
 */

const EVERY_RISK: RollRisk[] = [
  "ok",
  "at_risk",
  "data_lost",
  "roll_horizon_unknown",
  "never_collected",
];

describe("unknown is never rendered as safe", () => {
  it("gives roll_horizon_unknown a warning tone, not the ok tone", () => {
    // The single assertion this screen exists to protect. docs/08: "Unknown is
    // not the same as safe and must never render green."
    expect(basRiskTone("roll_horizon_unknown")).not.toBe("ok");
    expect(basRiskTone("roll_horizon_unknown")).toBe("warn");
  });

  it("gives the ok tone to exactly one risk state", () => {
    const green = EVERY_RISK.filter((risk) => basRiskTone(risk) === "ok");

    expect(green).toEqual(["ok"]);
  });

  it("treats never_collected as unhealthy too", () => {
    expect(basRiskTone("never_collected")).not.toBe("ok");
  });

  it("reserves the worst tone for data that is already gone", () => {
    expect(basRiskTone("data_lost")).toBe("bad");
  });

  it("labels every risk state, so none renders as a raw column value", () => {
    for (const risk of EVERY_RISK) {
      expect(RISK_LABEL[risk]).toBeTruthy();
      expect(RISK_LABEL[risk]).not.toBe(risk);
    }
  });
});

describe("the tile thresholds mirror the Grafana panels", () => {
  it("makes unclassified points amber from one, and green only at zero", () => {
    // Amber by design, per docs/08 - a backlog item, not an error. Green at
    // zero, because zero really is the finished state.
    expect(unclassifiedTone(0)).toBe("ok");
    expect(unclassifiedTone(1)).toBe("warn");
    expect(unclassifiedTone(300)).toBe("warn");
  });

  it("makes points at risk red from one", () => {
    expect(atRiskTone(0)).toBe("ok");
    expect(atRiskTone(1)).toBe("bad");
  });

  it("walks the staleness boundaries at 30 and 60 minutes", () => {
    // Grafana steps: green null, orange 30, red 60. Steps are inclusive upward.
    expect(stalenessTone(0)).toBe("ok");
    expect(stalenessTone(29.9)).toBe("ok");
    expect(stalenessTone(30)).toBe("warn");
    expect(stalenessTone(59.9)).toBe("warn");
    expect(stalenessTone(60)).toBe("bad");
    expect(stalenessTone(3_840)).toBe("bad");
  });

  it("does not render 'no readings at all' as a healthy zero", () => {
    // The empty-database form of the unknown-is-not-safe bug. Zero minutes ago
    // is the best possible answer; never having collected anything is close to
    // the worst. They must not be the same colour.
    expect(stalenessTone(null)).toBe("neutral");
    expect(stalenessTone(null)).not.toBe(stalenessTone(0));
  });
});

describe("the risk breakdown says which states make up the total", () => {
  const counts = (partial: Partial<Record<RollRisk, number>>) => ({
    ok: 0,
    at_risk: 0,
    data_lost: 0,
    roll_horizon_unknown: 0,
    never_collected: 0,
    ...partial,
  });

  it("drops zeroes and orders worst first", () => {
    const breakdown = riskBreakdown(
      counts({ never_collected: 1, data_lost: 2, roll_horizon_unknown: 3 }),
    );

    expect(breakdown).toEqual([
      { risk: "data_lost", count: 2 },
      { risk: "roll_horizon_unknown", count: 3 },
      { risk: "never_collected", count: 1 },
    ]);
  });

  it("never lists ok, however many there are", () => {
    expect(riskBreakdown(counts({ ok: 99 }))).toEqual([]);
  });

  it("covers every state the at-risk tile counts", () => {
    // If a sixth risk state is added to the view and the tile starts counting
    // it, the breakdown has to be able to name it - otherwise the total says 4
    // and the list says 3.
    const all = counts({
      at_risk: 1,
      data_lost: 1,
      roll_horizon_unknown: 1,
      never_collected: 1,
    });

    expect(riskBreakdown(all).map((entry) => entry.risk).sort()).toEqual(
      [...AT_RISK_ROLL_RISKS].sort(),
    );
  });
});

describe("the collector silence is described by its consequence", () => {
  const gap = (overrides: Partial<RunGap> = {}): RunGap => ({
    fromAt: "2026-08-21T20:05:45.000Z",
    toAt: "2026-08-24T12:20:46.000Z",
    hours: 64.25,
    rollHorizonHours: 41.666,
    exceedsRollHorizon: true,
    ...overrides,
  });

  it("says the data is gone when the silence outran the roll horizon", () => {
    // The dev database's real state: the laptop was closed over the weekend,
    // 21 Aug 16:05 to 24 Aug 08:20, against a 41.7-hour horizon.
    const sentence = describeRunGap(gap());

    // Both units, deliberately. "2.7 days against a 41.7 h horizon" makes the
    // reader do the arithmetic the sentence exists to spare them.
    expect(sentence).toContain("64.3 h");
    expect(sentence).toContain("2.7 days");
    expect(sentence).toContain("41.7 h");
    expect(sentence).toContain("gone permanently");
    expect(runGapTone(gap())).toBe("bad");
  });

  it("does not raise an alarm for a silence inside the horizon", () => {
    const inside = gap({ hours: 0.5, exceedsRollHorizon: false });

    expect(describeRunGap(inside)).toContain("inside the");
    expect(describeRunGap(inside)).not.toContain("gone permanently");
    expect(runGapTone(inside)).toBe("neutral");
  });

  it("refuses to claim either way when no horizon is known", () => {
    const unknown = gap({
      rollHorizonHours: null,
      exceedsRollHorizon: false,
    });
    const sentence = describeRunGap(unknown);

    expect(sentence).toContain("cannot be determined");
    // It must not read as an all-clear.
    expect(sentence).not.toContain("inside the");
  });

  it("has nothing to say when there are fewer than two runs", () => {
    expect(describeRunGap(null)).toBeNull();
    expect(runGapTone(null)).toBe("neutral");
  });
});

describe("formatting", () => {
  it("reads a duration at every scale this screen sees", () => {
    expect(formatMinutes(0.4)).toBe("under a minute");
    expect(formatMinutes(10)).toBe("10 min");
    expect(formatMinutes(59)).toBe("59 min");
    expect(formatMinutes(60)).toBe("1 h");
    expect(formatMinutes(95)).toBe("1 h 35 min");
    // 64 h 15 m - the real outage. Past two days it reads in days.
    expect(formatMinutes(3_855)).toBe("2.7 days");
  });

  it("renders a missing duration as an em dash rather than zero", () => {
    expect(formatMinutes(null)).toBe("—");
    expect(formatHours(null)).toBe("—");
  });

  it("keeps hours when a duration is compared against a horizon in hours", () => {
    expect(formatDurationAgainstHorizon(6.25)).toBe("6.3 h");
    expect(formatDurationAgainstHorizon(64.25)).toBe("64.3 h (2.7 days)");
  });

  it("renders the measured roll horizon as 41.7 hours", () => {
    // 500 records x 300 s. docs/08: "Measured on the lab station."
    expect(formatHours(150_000 / 3600)).toBe("41.7 h");
  });

  it("separates thousands, so 5,519 is not read as 5519 at a glance", () => {
    expect(formatCount(5_519)).toBe("5,519");
    expect(formatCount(0)).toBe("0");
  });

  it("formats a timestamp in the requested zone and nothing else", () => {
    // Stored UTC, displayed local - the display half of docs/08's
    // "every timestamp is timestamptz, stored UTC".
    const utc = "2026-08-24T12:35:00.009Z";

    expect(formatTimestamp(utc, "en-US", "UTC")).toBe("Aug 24, 12:35");
    expect(formatTimestamp(utc, "en-US", "America/New_York")).toBe(
      "Aug 24, 08:35",
    );
  });

  it("renders a null or unparseable timestamp as an em dash", () => {
    expect(formatTimestamp(null)).toBe("—");
    expect(formatTimestamp("not a date")).toBe("—");
  });
});
