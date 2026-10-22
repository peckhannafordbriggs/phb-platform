import { describe, expect, it } from "vitest";
import { disposition, funnel, toneCounts, visibleSteps } from "@/lib/modules/freeze-protection/disposition";
import type { DispositionCode, FpLine } from "@/lib/modules/freeze-protection/types";

/**
 * The procedure from the Controls Division's sheet, one case per outcome. Pure:
 * no database. Every screen and the report read `disposition`, so this is the
 * one place the procedure is proved.
 */

const PASSED = { fanStops: "yes", damperCloses: "yes", valveFullFlow: "yes", manualReset: "yes" } as const;

function line(overrides: Partial<FpLine> = {}): FpLine {
  return {
    id: "1",
    resultId: "1",
    buildingId: "1",
    buildingName: "Main",
    tag: "AHU-1",
    equipmentType: null,
    areaServed: null,
    coil: null,
    equipmentNotes: null,
    status: "service",
    exposure: null,
    protection: null,
    test: { answers: {}, tripTempF: null, testedBy: null, testDate: null, elements: null },
    notification: null,
    deficiency: null,
    documentation: null,
    notes: null,
    updatedAt: "2026-10-22T00:00:00.000Z",
    updatedBy: null,
    ...overrides,
  };
}

const exposedManual = { coil: "water", exposure: "yes", protection: "manual" } as const;
const tested = (answers: FpLine["test"]["answers"]) => ({
  test: { answers, tripTempF: "38", testedBy: "C. Moreno", testDate: "2026-10-16", elements: null },
});
const documented = { documentation: { with: "owner", name: "R. Patel", date: "2026-10-17", method: "Email" } } as const;

const CASES: [DispositionCode, Partial<FpLine>][] = [
  ["coil_open", {}],
  ["closed_no_coil", { coil: "none" }],
  ["exposure_open", { coil: "water" }],
  ["closed_no_exposure", { coil: "water", exposure: "no" }],
  ["exposure_unknown", { coil: "water", exposure: "unknown" }],
  ["protection_open", { coil: "water", exposure: "yes" }],
  ["no_protection", { coil: "glycol", exposure: "yes", protection: "none" }],
  ["no_protection", { coil: "glycol", exposure: "yes", protection: "unknown" }],
  [
    "no_protection_notified",
    { coil: "glycol", exposure: "yes", protection: "none", notification: { who: "Owner", date: "2026-10-14", method: null, response: null } },
  ],
  ["deferred", { ...exposedManual, status: "dry" }],
  ["deferred", { ...exposedManual, status: "not_installed" }],
  ["test_open", { ...exposedManual, status: "filled" }],
  ["test_open", { ...exposedManual, ...tested({ fanStops: "yes" }) }],
  ["test_failed", { ...exposedManual, ...tested({ ...PASSED, damperCloses: "no" }) }],
  ["test_failed", { ...exposedManual, ...tested({ fanStops: "no" }) }],
  ["deficiency", { coil: "steam", exposure: "yes", protection: "auto", ...tested(PASSED) }],
  ["deficiency", { coil: "water", exposure: "yes", protection: "software", ...tested(PASSED) }],
  ["documentation_open", { ...exposedManual, ...tested(PASSED) }],
  ["verified", { ...exposedManual, ...tested(PASSED), ...documented }],
];

describe("disposition", () => {
  it.each(CASES)("%s", (code, overrides) => {
    expect(disposition(line(overrides)).code).toBe(code);
  });

  it("covers every disposition code", () => {
    const all: DispositionCode[] = [
      "coil_open", "closed_no_coil", "exposure_open", "closed_no_exposure", "exposure_unknown",
      "protection_open", "no_protection", "no_protection_notified", "deferred", "test_open",
      "test_failed", "deficiency", "documentation_open", "verified",
    ];
    expect(new Set(CASES.map(([c]) => c))).toEqual(new Set(all));
  });

  it("a notice needs both who and when before it counts", () => {
    const half = line({ coil: "water", exposure: "yes", protection: "none", notification: { who: "Owner", date: null, method: null, response: null } });
    expect(disposition(half).code).toBe("no_protection");
  });

  it("a failed test names what failed", () => {
    const d = disposition(line({ ...exposedManual, ...tested({ ...PASSED, damperCloses: "no" }) }));
    expect(d.sentence).toContain("outside air damper drives closed");
  });

  it("never carries state by colour alone: every disposition has words", () => {
    for (const [, overrides] of CASES) {
      const d = disposition(line(overrides));
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.sentence.length).toBeGreaterThan(0);
    }
  });
});

describe("visibleSteps", () => {
  it("shows nothing past step 2 until a coil is answered", () => {
    expect(visibleSteps(line())).toMatchObject({ exposure: false, protection: false, test: false });
  });

  it("shows the notice step, not the test, when there is no protection", () => {
    expect(visibleSteps(line({ coil: "water", exposure: "yes", protection: "none" }))).toMatchObject({ notify: true, test: false });
  });

  it("hides the test while the system is not yet wet", () => {
    expect(visibleSteps(line({ ...exposedManual, status: "dry" })).test).toBe(false);
  });

  it("shows documentation only once every test is answered", () => {
    expect(visibleSteps(line({ ...exposedManual, ...tested({ fanStops: "yes" }) })).documentation).toBe(false);
    expect(visibleSteps(line({ ...exposedManual, ...tested(PASSED) })).documentation).toBe(true);
  });
});

describe("funnel and counts", () => {
  const lines = CASES.map(([, o]) => line(o));

  it("each stage is a subset of the last", () => {
    const counts = funnel(lines).map((s) => s.count);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]!);
  });

  it("tones count every line exactly once", () => {
    const t = toneCounts(lines);
    expect(t.ok + t.warn + t.bad + t.open + t.closed).toBe(lines.length);
  });
});
