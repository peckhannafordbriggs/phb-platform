import { describe, expect, it } from "vitest";
import {
  AT_RISK_ROLL_RISKS,
  type RollRisk,
  type RunGap,
} from "@/lib/modules/bas/types";
import {
  DEFAULT_WINDOW_DAYS,
  RISK_LABEL,
  WINDOW_PRESETS,
  atRiskTone,
  atRiskShape,
  describeAtRisk,
  basRiskTone,
  describeEmptyRuns,
  describeRunGap,
  describeScope,
  formatCount,
  formatDurationAgainstHorizon,
  formatHours,
  formatMinutes,
  formatTimestamp,
  riskBreakdown,
  runGapTone,
  stalenessTone,
  unclassifiedTone,
  windowLabel,
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

/** A full risk-count record with only the named states set. */
const atRisk = (partial: Partial<Record<RollRisk, number>>): Record<RollRisk, number> => ({
  ok: 0,
  at_risk: 0,
  data_lost: 0,
  roll_horizon_unknown: 0,
  never_collected: 0,
  ...partial,
});

describe("the tile thresholds mirror the Grafana panels", () => {
  it("makes unclassified points amber from one, and green only at zero", () => {
    // Amber by design, per docs/08 - a backlog item, not an error. Green at
    // zero, because zero really is the finished state.
    expect(unclassifiedTone(0)).toBe("ok");
    expect(unclassifiedTone(1)).toBe("warn");
    expect(unclassifiedTone(300)).toBe("warn");
  });

  /**
   * REPLACED DELIBERATELY. The previous assertion was:
   *
   *     expect(atRiskTone(0)).toBe("ok");
   *     expect(atRiskTone(1)).toBe("bad");
   *
   * "red from one" mirrored the Grafana panel, and the panel is wrong about
   * this: it treats "capacity has not been filled in from Workbench" and "the
   * station has destroyed records nobody collected" as the same severity. The
   * first is a gap in what we know, the second is permanent loss, and they call
   * for different actions.
   *
   * This is a change to what the screen claims, not a fix to a broken
   * implementation - the old behaviour matched its old test exactly. It is a
   * stronger assertion than the one it replaces: it pins the invariant the old
   * one only implied, that the tile is never `ok` above zero, AND it pins the
   * distinction the old one could not express.
   */
  it("never renders any at-risk total as ok, whatever it is made of", () => {
    // The rule the whole screen exists for. Unknown is not safe, and amber is
    // its floor rather than its ceiling.
    for (const shape of [
      atRisk({ roll_horizon_unknown: 1 }),
      atRisk({ at_risk: 1 }),
      atRisk({ never_collected: 1 }),
      atRisk({ data_lost: 1 }),
      atRisk({ roll_horizon_unknown: 400 }),
    ]) {
      expect(atRiskTone(shape)).not.toBe("ok");
    }
  });

  it("is ok only at zero", () => {
    expect(atRiskTone(atRisk({}))).toBe("ok");
  });

  it("reserves the worst tone for a total that includes real loss", () => {
    expect(atRiskTone(atRisk({ data_lost: 1 }))).toBe("bad");
    // One lost point among many unknowns is still loss.
    expect(atRiskTone(atRisk({ data_lost: 1, roll_horizon_unknown: 40 }))).toBe("bad");
  });

  it("warns rather than alarms when nothing is lost yet", () => {
    expect(atRiskTone(atRisk({ roll_horizon_unknown: 3 }))).toBe("warn");
    expect(atRiskTone(atRisk({ at_risk: 2, never_collected: 1 }))).toBe("warn");
  });

  it("classifies the shape behind the count", () => {
    expect(atRiskShape(atRisk({}))).toBe("none");
    expect(atRiskShape(atRisk({ roll_horizon_unknown: 3 }))).toBe("unknown");
    expect(atRiskShape(atRisk({ data_lost: 1 }))).toBe("losing");
  });
});

describe("the tile says which problem it has, not just how many", () => {
  /**
   * The count alone is the least useful part of the answer. "3 points, capacity
   * unknown" and "3 points losing data" are different sentences about the same
   * number, and somebody glancing at the screen should not have to decode a
   * stripe or a hue to tell them apart.
   */
  it("names capacity when nothing is lost", () => {
    expect(describeAtRisk(atRisk({ roll_horizon_unknown: 3 }))).toBe(
      "3 points, capacity unknown",
    );
  });

  it("names loss when data is gone", () => {
    expect(describeAtRisk(atRisk({ data_lost: 3 }))).toBe("3 points losing data");
  });

  it("says how many of the total are actually losing, when it is mixed", () => {
    // "1 of 4 points losing data" is more use than either "4 at risk" or
    // "1 losing" on its own.
    expect(describeAtRisk(atRisk({ data_lost: 1, roll_horizon_unknown: 3 }))).toBe(
      "1 of 4 points losing data",
    );
  });

  it("uses the singular for one point", () => {
    expect(describeAtRisk(atRisk({ data_lost: 1 }))).toBe("1 point losing data");
    expect(describeAtRisk(atRisk({ roll_horizon_unknown: 1 }))).toBe(
      "1 point, capacity unknown",
    );
  });

  it("says nothing alarming at zero", () => {
    expect(describeAtRisk(atRisk({}))).toBe("None at risk");
  });

  it("never describes a non-zero total as none", () => {
    expect(describeAtRisk(atRisk({ at_risk: 1 }))).not.toContain("None");
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

  /**
   * The assertion on the phrase "gone permanently" was REMOVED DELIBERATELY.
   *
   * The sentence used to end "...and they are gone permanently", which is what
   * the whole screen is for - the reader already knows it by the time they are
   * reading a collector-silence panel. What they cannot see is the comparison:
   * 64.3 h of silence against a 41.7 h horizon. That is now the whole sentence,
   * and the consequence is carried by the maroon tone and the gaps table.
   *
   * Nothing about the MEANING moved. The tone assertion below is unchanged, and
   * the both-units rule it existed to protect is asserted more tightly than
   * before.
   */
  it("compares the silence against the horizon, in both units", () => {
    // The dev database's real state: the laptop was closed over the weekend,
    // 21 Aug 16:05 to 24 Aug 08:20, against a 41.7-hour horizon.
    const sentence = describeRunGap(gap());

    // Both units, deliberately. "2.7 days against a 41.7 h horizon" makes the
    // reader do the arithmetic the sentence exists to spare them.
    expect(sentence).toContain("64.3 h");
    expect(sentence).toContain("2.7 days");
    expect(sentence).toContain("41.7 h");

    // The severity is the tone's job, and it is unchanged.
    expect(runGapTone(gap())).toBe("bad");
  });

  it("stays one sentence, because it sits under a tile that already alarmed", () => {
    // The cut that prompted this: the panel was three clauses where one carries
    // the finding.
    const sentence = describeRunGap(gap()) ?? "";

    expect(sentence.split(". ").filter((part) => part.trim().length > 0)).toHaveLength(1);
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

describe("the two controls say what they are showing", () => {
  it("offers 24 hours, 7 days and 30 days, defaulting to Grafana's 7", () => {
    expect(WINDOW_PRESETS.map((preset) => preset.days)).toEqual([1, 7, 30]);
    expect(DEFAULT_WINDOW_DAYS).toBe(7);
    expect(
      WINDOW_PRESETS.some((preset) => preset.days === DEFAULT_WINDOW_DAYS),
    ).toBe(true);
  });

  it("never writes '1 days'", () => {
    expect(windowLabel(1)).toBe("24 hours");
    expect(windowLabel(7)).toBe("7 days");
    expect(windowLabel(30)).toBe("30 days");
    // Reachable by hand-editing the URL; the service accepts 1 to 90.
    expect(windowLabel(45)).toBe("45 days");
  });

  it("restates both selections in words", () => {
    // Not decoration. Two controls change what every panel means, and a reader
    // who has lost track of which building is selected cannot tell a real zero
    // from a filtered one.
    expect(describeScope("Spring Grove Lab", 7)).toBe(
      "Spring Grove Lab · run history covers the last 7 days",
    );
    expect(describeScope(null, 1)).toBe(
      "All buildings · run history covers the last 24 hours",
    );
  });
});

describe("an empty run list explains which kind of empty it is", () => {
  it("says so when the collector has never run", () => {
    const sentence = describeEmptyRuns(null, 7, null);

    expect(sentence).toContain("never recorded a run");
    expect(sentence).toContain("this database");
  });

  it("names the building when one is selected", () => {
    expect(describeEmptyRuns(null, 7, "Spring Grove Lab")).toContain(
      "Spring Grove Lab",
    );
  });

  it("points at the run just outside the window rather than falling silent", () => {
    // The failure this exists to prevent: "the collector has never run" and
    // "it last ran four days ago and you are looking at 24 hours" both render
    // as an empty table, and only one of them is fine.
    const sentence = describeEmptyRuns("2026-08-21T20:05:45.000Z", 1, null);

    expect(sentence).toContain("last 24 hours");
    expect(sentence).toContain("outside this window");
    expect(sentence).toContain("widen the range");
    expect(sentence).not.toContain("never");
  });

  it("distinguishes the two, which is the whole point", () => {
    expect(describeEmptyRuns(null, 1, null)).not.toBe(
      describeEmptyRuns("2026-08-21T20:05:45.000Z", 1, null),
    );
  });
});
