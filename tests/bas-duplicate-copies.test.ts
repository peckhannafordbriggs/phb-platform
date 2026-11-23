import { describe, expect, it } from "vitest";
import {
  FLAT_MIN_READINGS,
  findCandidatePairs,
  isFlat,
  isLive,
  judgePair,
  nameKey,
  namesUnit,
  planDuplicateActions,
  stationEndsWithPrefix,
  type CandidatePair,
  type PointVisibility,
  type SeriesStats,
} from "@/lib/modules/bas/duplicate-copies";

/**
 * The duplicate-copy rules (2026-11-23, lib/modules/bas/duplicate-copies.ts),
 * pure: names, the dead-copy test in numbers, and the plan. The database half
 * is tests/bas-auto-hide.test.ts, on the CEI fixture.
 */

const N2 = { stationId: "1", niagaraStationName: "CEI_JCI_N2" };
const AHU7 = { stationId: "2", niagaraStationName: "CEI_AHU_7" };
const AHU8 = { stationId: "3", niagaraStationName: "CEI_AHU_8" };
const OTHER_JACE = { stationId: "4", niagaraStationName: "CEI_JCI_N3" };

/** oBIX escapes `/` as `$2f` in a history key; the rules decode it. */
const key = (name: string) => name.replace(/\//g, "$2f");
let nextId = 100;
const point = (stationId: string, name: string, id = String(nextId++)) => ({ pointId: id, stationId, niagaraHistoryName: key(name) });

describe("names", () => {
  it("ignores case and every separator", () => {
    expect(nameKey("AHU_7/DA_SAP")).toBe("AHU7DASAP");
    expect(nameKey("ahu-7 da.sap")).toBe("AHU7DASAP");
  });

  it("matches a station that ends with the prefix on a token boundary, and only then", () => {
    expect(stationEndsWithPrefix("CEI_AHU_7", "AHU_7")).toBe(true);
    expect(stationEndsWithPrefix("CEI_AHU_7", "AHU7")).toBe(true);
    expect(stationEndsWithPrefix("cei-ahu-7", "AHU_7")).toBe(true);
    expect(stationEndsWithPrefix("CEI_AHU7", "AHU_7")).toBe(true);
    expect(stationEndsWithPrefix("AHU_7", "AHU_7")).toBe(true);
    // Another unit, and a name where AHU is not a token of its own.
    expect(stationEndsWithPrefix("CEI_AHU_17", "AHU_7")).toBe(false);
    expect(stationEndsWithPrefix("CEIAHU_7", "AHU_7")).toBe(false);
    expect(stationEndsWithPrefix("CEI_AHU_7_SPARE", "AHU_7")).toBe(false);
    // A prefix with no letter names no equipment.
    expect(stationEndsWithPrefix("CEI_AHU_7", "7")).toBe(false);
  });

  it("calls a prefix a unit only when it has letters and a number", () => {
    expect(namesUnit("AHU_7")).toBe(true);
    expect(namesUnit("V4_22")).toBe(true);
    expect(namesUnit("Points")).toBe(false);
    expect(namesUnit(null)).toBe(false);
  });
});

describe("pairs", () => {
  it("pairs AHU_7/DA_SAP on the JACE with DA_SAP on CEI_AHU_7, and AHU_8's with CEI_AHU_8's", () => {
    const p7 = point(N2.stationId, "AHU_7/DA_SAP", "10");
    const q7 = point(AHU7.stationId, "DA_SAP", "20");
    const p8 = point(N2.stationId, "AHU_8/OA_H", "11");
    const q8 = point(AHU8.stationId, "OA_H", "30");
    const q7oa = point(AHU7.stationId, "OA_H", "21");
    const pairs = findCandidatePairs([N2, AHU7, AHU8], [p7, q7, p8, q8, q7oa]);
    expect(pairs).toEqual([
      { a: "10", b: "20", rule: "prefix" },
      { a: "11", b: "30", rule: "prefix" },
    ]);
  });

  it("ignores case and separators between the tail and the child's name", () => {
    const pairs = findCandidatePairs([N2, AHU7], [point(N2.stationId, "AHU_7/DA_SAP", "10"), point(AHU7.stationId, "da-sap", "20")]);
    expect(pairs).toEqual([{ a: "10", b: "20", rule: "prefix" }]);
  });

  it("does NOT pair the same bare name on two sibling units: CEI_AHU_7's OA_H is not CEI_AHU_8's", () => {
    const pairs = findCandidatePairs(
      [N2, AHU7, AHU8],
      [point(AHU7.stationId, "OA_H", "21"), point(AHU8.stationId, "OA_H", "30"), point(AHU7.stationId, "OAT", "22"), point(OTHER_JACE.stationId, "OAT", "40")],
    );
    expect(pairs).toEqual([]);
  });

  it("pairs the same name across stations when the name carries its unit", () => {
    const pairs = findCandidatePairs(
      [N2, OTHER_JACE],
      [point(N2.stationId, "V4_22/SpaceTemp", "50"), point(OTHER_JACE.stationId, "V4_22/SpaceTemp", "51"), point(N2.stationId, "Points/OAT", "52"), point(OTHER_JACE.stationId, "Points/OAT", "53")],
    );
    // Points/OAT names a folder, not a unit.
    expect(pairs).toEqual([{ a: "50", b: "51", rule: "exact" }]);
  });

  it("never pairs two points on one station, and reports a pair found both ways once, as prefix", () => {
    const pairs = findCandidatePairs(
      [N2, AHU7],
      [
        point(N2.stationId, "AHU_7/DA_T", "60"),
        point(N2.stationId, "DA_T", "61"),
        // The child holds the prefixed name too: exact AND prefix? Only exact
        // can match it; the prefix rule pairs 60 with the child's bare DA_T.
        point(AHU7.stationId, "AHU_7/DA_T", "62"),
        point(AHU7.stationId, "DA_T", "63"),
      ],
    );
    expect(pairs).toEqual([
      { a: "60", b: "62", rule: "exact" },
      { a: "60", b: "63", rule: "prefix" },
    ]);
  });

  it("looks past an I/O module the way the assignment does: XTM_109/AHU_7_FinalFilter is AHU_7's FinalFilter", () => {
    const pairs = findCandidatePairs([N2, AHU7], [point(N2.stationId, "XTM_109/AHU_7_FinalFilter", "70"), point(AHU7.stationId, "FinalFilter", "71")]);
    expect(pairs).toEqual([{ a: "70", b: "71", rule: "prefix" }]);
  });
});

// ---------------------------------------------------------------------------

const flat = (readings = 336, value = "0"): SeriesStats => ({ readings, distinct: 1, modeCount: readings, modeValue: value, min: 0, max: 0 });
const live = (readings = 336): SeriesStats => ({ readings, distinct: 40, modeCount: 20, modeValue: "1.2", min: 0.8, max: 1.6 });

describe("the dead-copy test, numbers only", () => {
  it("flat: one value, or 99% one value, over at least ten readings", () => {
    expect(isFlat(flat())).toBe(true);
    expect(isFlat({ readings: 336, distinct: 3, modeCount: 333, modeValue: "0", min: 0, max: 5 })).toBe(true); // 99.1%
    expect(isFlat({ readings: 336, distinct: 3, modeCount: 332, modeValue: "0", min: 0, max: 5 })).toBe(false); // 98.8%
    expect(isFlat(flat(FLAT_MIN_READINGS - 1))).toBe(false);
  });

  it("live: at least 10 readings, more than 3 distinct values, a non-zero range", () => {
    expect(isLive(live())).toBe(true);
    expect(isLive(live(9))).toBe(false);
    expect(isLive({ readings: 336, distinct: 3, modeCount: 200, modeValue: "1", min: 0, max: 2 })).toBe(false);
    // A cycling boolean has two values: never live by these numbers.
    expect(isLive({ readings: 336, distinct: 2, modeCount: 200, modeValue: "true", min: 0, max: 1 })).toBe(false);
    // Strings have no range.
    expect(isLive({ readings: 336, distinct: 5, modeCount: 100, modeValue: "auto", min: null, max: null })).toBe(false);
  });

  const pair: CandidatePair = { a: "1", b: "2", rule: "prefix" };
  it("the flat half is the copy, whichever side it is on", () => {
    expect(judgePair(pair, new Map([["1", flat()], ["2", live()]]))).toEqual({ kind: "copy", copy: "1", live: "2" });
    expect(judgePair(pair, new Map([["1", live()], ["2", flat()]]))).toEqual({ kind: "copy", copy: "2", live: "1" });
  });

  it("both flat, both varying, or not enough data: nothing - a question for a person", () => {
    expect(judgePair(pair, new Map([["1", flat()], ["2", flat()]]))).toEqual({ kind: "none", why: "both_flat" });
    expect(judgePair(pair, new Map([["1", live()], ["2", live()]]))).toEqual({ kind: "none", why: "both_vary" });
    expect(judgePair(pair, new Map([["1", flat()]]))).toEqual({ kind: "none", why: "not_clear" });
    expect(judgePair(pair, new Map([["1", flat()], ["2", live(9)]]))).toEqual({ kind: "none", why: "not_clear" });
  });
});

// ---------------------------------------------------------------------------

const shown = (pointId: string, over: Partial<PointVisibility> = {}): PointVisibility => ({
  pointId,
  collected: true,
  visible: true,
  hiddenSource: null,
  hiddenReason: null,
  duplicateOf: null,
  ...over,
});
const autoCopyOf = (pointId: string, of: string): PointVisibility =>
  shown(pointId, { visible: false, hiddenSource: "auto", hiddenReason: "duplicate_copy", duplicateOf: of });
const states = (...rows: PointVisibility[]) => new Map(rows.map((r) => [r.pointId, r]));
const P: CandidatePair = { a: "10", b: "20", rule: "prefix" };

describe("the plan", () => {
  it("hides the flat copy as a copy of the live point", () => {
    const actions = planDuplicateActions([P], new Map([["10", flat()], ["20", live()]]), states(shown("10"), shown("20")));
    expect(actions).toEqual([{ kind: "hide", pointId: "10", duplicateOf: "20", rule: "prefix", swap: false }]);
  });

  it("never touches a point a person set, hidden or shown", () => {
    const stats = new Map([["10", flat()], ["20", live()]]);
    expect(planDuplicateActions([P], stats, states(shown("10", { hiddenSource: "manual" }), shown("20")))).toEqual([]);
    expect(planDuplicateActions([P], stats, states(shown("10", { visible: false, hiddenSource: "manual" }), shown("20")))).toEqual([]);
  });

  it("never hides a copy of a point that is hidden or not collected, and never an uncollected copy", () => {
    const stats = new Map([["10", flat()], ["20", live()]]);
    expect(planDuplicateActions([P], stats, states(shown("10"), shown("20", { visible: false, hiddenSource: "manual" })))).toEqual([]);
    expect(planDuplicateActions([P], stats, states(shown("10"), shown("20", { collected: false })))).toEqual([]);
    expect(planDuplicateActions([P], stats, states(shown("10", { collected: false }), shown("20")))).toEqual([]);
  });

  it("leaves a copy it already hid alone while it is still flat", () => {
    expect(planDuplicateActions([P], new Map([["10", flat()], ["20", live()]]), states(autoCopyOf("10", "20"), shown("20")))).toEqual([]);
  });

  it("swaps when the live point goes flat and the copy varies", () => {
    const actions = planDuplicateActions([P], new Map([["10", live()], ["20", flat()]]), states(autoCopyOf("10", "20"), shown("20")));
    expect(actions).toEqual([
      { kind: "show", pointId: "10", previousDuplicateOf: "20", reason: "swap" },
      { kind: "hide", pointId: "20", duplicateOf: "10", rule: "prefix", swap: true },
    ]);
  });

  it("shows a copy again when it varies, and hides nothing when both vary", () => {
    const actions = planDuplicateActions([P], new Map([["10", live()], ["20", live()]]), states(autoCopyOf("10", "20"), shown("20")));
    expect(actions).toEqual([{ kind: "show", pointId: "10", previousDuplicateOf: "20", reason: "readings_vary" }]);
  });

  it("does not swap onto a partner a person set", () => {
    const actions = planDuplicateActions(
      [P],
      new Map([["10", live()], ["20", flat()]]),
      states(autoCopyOf("10", "20"), shown("20", { hiddenSource: "manual" })),
    );
    expect(actions).toEqual([{ kind: "show", pointId: "10", previousDuplicateOf: "20", reason: "readings_vary" }]);
  });

  it("takes the prefix partner over an exact one, then the lower id, and decides each copy once", () => {
    const pairs: CandidatePair[] = [
      { a: "10", b: "30", rule: "exact" },
      { a: "10", b: "20", rule: "prefix" },
    ];
    const actions = planDuplicateActions(
      pairs,
      new Map([["10", flat()], ["20", live()], ["30", live()]]),
      states(shown("10"), shown("20"), shown("30")),
    );
    expect(actions).toEqual([{ kind: "hide", pointId: "10", duplicateOf: "20", rule: "prefix", swap: false }]);
  });
});
