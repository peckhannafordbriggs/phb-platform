import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ANALYSIS_AVAILABILITY,
  CHOSEN_THRESHOLDS,
  EQUIPMENT_QUESTIONS,
  chilledWaterLoop,
  compressorShortCycling,
  compressorsDuringEconomizer,
  dataHealth,
  datBand,
  datHoldsSetpoint,
  dxCoolingDelta,
  economizerAtMinimum,
  heatStageDelta,
  hotWaterLoop,
  reheatOpenAboveCoolingSetpoint,
  simultaneousHeatingCooling,
  slidingStarts,
  staticTolerance,
  staticTracksSetpoint,
  vavDamperFullMissedSetpoint,
  vavStarvedAirflow,
  type AnalysisContext,
  type QuestionAnalysis,
  type QuestionFn,
} from "@/lib/modules/bas/reports/engine/analysis";
import * as thresholds from "@/lib/modules/bas/reports/engine/analysis/thresholds";
import { classify, decideQuestion, type LibraryRowForEngine } from "@/lib/modules/bas/reports/engine/inventory";
import { dxTableRows } from "@/lib/modules/bas/reports/engine/render";
import { DAY_MS, HOUR_MS, MINUTE_MS, occupiedFromSchedule } from "@/lib/modules/bas/reports/engine/series";
import type { EquipmentUnit, Interval, OccupancySource, PointSeries, QuestionResult, RawFinding } from "@/lib/modules/bas/reports/engine/types";
import { positiveAnswer } from "@/lib/modules/bas/reports/engine/wording";
import { BAS_LIBRARY_QUESTIONS } from "@/lib/modules/bas/reports/library";
import { BAS_POINT_ROLES } from "@/prisma/bas-vocabularies";

/**
 * Questions 6-18 (Reports, Phase 5) over synthetic series whose answers are
 * known. Pure: no database. For every question:
 *
 *   - a case that MUST raise a finding, with the numbers asserted;
 *   - a case that must NOT - just under the threshold, or shorter than the
 *     spec's persistence rule (30 minutes, or two days);
 *   - a case where Data Health flags one of the unit's points (flat, out of
 *     range, stale), the inventory then refuses the unit, and the function
 *     called with the exclusion raises nothing - while the same data
 *     WITHOUT the exclusion would have raised the equipment finding the
 *     spec forbids ("report it only under Data Health");
 *   - Not Applicable and Not Monitored for units lacking the type or roles.
 *
 * The week is Monday 2 November 2026 00:00 New York to the next Monday, no
 * clock change, so a local hour is arithmetic on the offset from the start.
 */

const NY = "America/New_York";
const WEEK_START = Date.UTC(2026, 10, 2, 5, 0, 0);
const WEEK: Interval = { start: WEEK_START, end: WEEK_START + 7 * DAY_MS };
const OCCUPIED = occupiedFromSchedule(
  [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 8 * 60, endMinute: 18 * 60 })),
  WEEK,
  NY,
);
const WEEKDAYS = [0, 1, 2, 3, 4];

/** 0 is Monday. */
const dayOf = (t: number) => Math.floor((t - WEEK.start) / DAY_MS);
/** Fractional local hour of day. */
const hourOf = (t: number) => ((t - WEEK.start) % DAY_MS) / HOUR_MS;
const between = (t: number, from: number, to: number, days: number[] = WEEKDAYS) => days.includes(dayOf(t)) && hourOf(t) >= from && hourOf(t) < to;
const noise = (t: number, amp = 0.3) => amp * Math.sin(t / HOUR_MS);
const at = (day: number, hour: number) => WEEK.start + day * DAY_MS + hour * HOUR_MS;

let nextId = 1;

function defaults(role: string): Pick<PointSeries, "measurement" | "unit" | "dataType" | "isSetpoint" | "isStatus" | "isCommand"> {
  const vocab = BAS_POINT_ROLES.find((r) => r.pointRole === role);
  const measurement = vocab?.measurement ?? null;
  const unit =
    measurement === "temperature"
      ? "fahrenheit"
      : measurement === "flow"
        ? "cubic feet per minute"
        : measurement === "pressure"
          ? "inches of water"
          : measurement === "position" || measurement === "speed"
            ? "percent"
            : null;
  const bool = role.endsWith("_status") || role === "heating_stage_cmd" || role.startsWith("occupancy");
  return {
    measurement,
    unit,
    dataType: bool ? "bool" : "real",
    isSetpoint: vocab?.isSetpoint ?? false,
    isStatus: vocab?.isStatus ?? false,
    isCommand: vocab?.isCommand ?? false,
  };
}

/** An interval series from a function of the instant; null is no reading. */
function series(role: string, value: (t: number) => number | null, over: Partial<PointSeries> = {}, stepMs = 15 * MINUTE_MS): PointSeries {
  const samples: Array<{ t: number; v: number }> = [];
  for (let t = WEEK.start; t < WEEK.end; t += stepMs) {
    const v = value(t);
    if (v !== null) samples.push({ t, v });
  }
  const id = String(nextId++);
  return {
    pointId: id,
    name: over.name ?? `${role}-${id}`,
    role,
    ...defaults(role),
    equipmentId: null,
    equipmentName: null,
    stationId: "1",
    intervalS: stepMs / 1000,
    coverage: 1,
    carryIn: null,
    carryInAt: null,
    samples,
    readingCount: samples.length,
    gaps: [],
    bucketMs: null,
    ...over,
  };
}

/** A change-of-value series: the value from each change until the next; `start` holds from before the week. */
function cov(role: string, changes: Array<[number, number]>, start = 0, over: Partial<PointSeries> = {}): PointSeries {
  const samples = changes.map(([t, v]) => ({ t, v }));
  const id = String(nextId++);
  return {
    pointId: id,
    name: over.name ?? `${role}-${id}`,
    role,
    ...defaults(role),
    equipmentId: null,
    equipmentName: null,
    stationId: "1",
    intervalS: null,
    coverage: 1,
    carryIn: start,
    carryInAt: WEEK.start - HOUR_MS,
    samples,
    readingCount: samples.length,
    gaps: [],
    bucketMs: null,
    ...over,
  };
}

const onOff = (on: (t: number) => boolean) => (t: number) => (on(t) ? 1 : 0);

function unit(name: string, equipType: string, points: PointSeries[]): EquipmentUnit {
  const id = String(nextId++);
  for (const p of points) {
    p.equipmentId = id;
    p.equipmentName = name;
  }
  return { equipmentId: id, name, equipType, equipTypeLabel: null, parentEquipmentId: null, points, ...classify(points) };
}

function ctx(o: { excluded?: Set<string>; occupied?: Interval[] | null; station?: PointSeries[] } = {}): AnalysisContext {
  return {
    range: WEEK,
    timezone: NY,
    excluded: o.excluded ?? new Set(),
    occupiedFor: () => (o.occupied === undefined ? OCCUPIED : o.occupied),
    stationPointsFor: () => o.station ?? [],
  };
}

const row = (key: string) => BAS_LIBRARY_QUESTIONS.find((q) => q.key === key)! as unknown as LibraryRowForEngine;
const OCCUPANCY = new Map<string, OccupancySource>([["1", { stationId: "1", stationName: "S", kind: "manual", intervals: OCCUPIED, detail: "" }]]);

function decide(key: string, units: EquipmentUnit[], excluded = new Set<string>(), station: PointSeries[] = []) {
  const points = [...units.flatMap((u) => u.points), ...station];
  return decideQuestion(row(key), units, new Map([["1", points]]), OCCUPANCY, () => "1", excluded);
}

/** The spec's bar for a finding: exact equipment, actual, expected, and a duration or a percent. */
function expectEvidence(f: RawFinding) {
  expect(f.subjectName.length).toBeGreaterThan(0);
  expect(f.evidence.actual.length).toBeGreaterThan(0);
  expect(f.evidence.expected.length).toBeGreaterThan(0);
  expect(f.evidence.duration ?? f.evidence.percent).toBeDefined();
  expect(f.evidence.when.length).toBeGreaterThan(0);
}

function only(r: QuestionAnalysis, name: string): RawFinding {
  const f = r.findings.filter((x) => x.subjectName === name);
  expect(f, `findings on ${name}`).toHaveLength(1);
  expectEvidence(f[0]!);
  return f[0]!;
}

/**
 * The data-quality case. `bad` is a point on the unit Data Health must flag;
 * without the exclusion the function would raise an equipment finding on
 * that unit; with it, the inventory refuses the unit (Not Monitored naming
 * `missing`) and the function, given the exclusion, raises nothing.
 */
function dataQuality(key: string, fn: QuestionFn, u: EquipmentUnit, bad: PointSeries, missing: string[], station: PointSeries[] = []) {
  const health = dataHealth([...u.points, ...station], WEEK, NY);
  expect(health.excluded.has(bad.pointId), "Data Health flags the bad point").toBe(true);
  expect(health.findings.some((f) => f.subjectKey === `point:${bad.pointId}`)).toBe(true);
  expect(fn([u], ctx({ station })).findings.length, "without the exclusion the equipment finding would appear").toBeGreaterThan(0);
  const decision = decide(key, [u], health.excluded, station);
  expect(decision.outcome).toBe("not_monitored");
  expect(decision.missing).toEqual(missing);
  const r = fn([u], ctx({ excluded: health.excluded, station }));
  expect(r.findings).toEqual([]);
  expect(r.skipped.map((s) => s.name)).toEqual([u.name]);
}

function answered(key: string, r: QuestionAnalysis): Pick<QuestionResult, "key" | "metrics" | "equipment"> {
  return { key, metrics: r.metrics, equipment: [] };
}

// ------------------------------------------------------------------ VAV

describe("Q6 VAV airflow below 80% of setpoint while occupied", () => {
  const vav = (name: string, flow: (t: number) => number) =>
    unit(name, "vav", [series("supply_air_flow", flow), series("supply_air_flow_sp", () => 500), series("zone_temp", (t) => 72 + noise(t))]);

  it("raises Watch at 40% of occupied hours and Action Needed at 90%, judging occupied hours only", () => {
    // 300 cfm (60%) 14:00-18:00 every weekday; 100 cfm at night, which is unoccupied and not judged.
    const a = vav("VAV-A", (t) => (between(t, 14, 18) ? 300 : between(t, 8, 18) ? 480 + noise(t, 5) : 100));
    const b = vav("VAV-B", (t) => (between(t, 9, 18) ? 300 : between(t, 8, 18) ? 480 : 100));
    const r = vavStarvedAirflow([a, b], ctx());
    const fa = only(r, "VAV-A");
    expect(fa).toMatchObject({ questionKey: "q06_vav_starved_airflow", section: "vav", issueCode: "starved_airflow", priority: "watch" });
    expect(fa.evidence).toMatchObject({ percent: 40, hours: 20, averageAirflow: 300, averageSetpoint: 500, occupiedHoursJudged: 50 });
    expect(fa.evidence.actual).toContain("60% of setpoint");
    expect(only(r, "VAV-B")).toMatchObject({ priority: "action_needed", evidence: expect.objectContaining({ percent: 90 }) });
    expect(r.metrics).toMatchObject({ judged: 2, worst: { name: "VAV-B", hours: 45, percent: 90 } });
  });

  it("raises nothing for 15 minutes on one day, or for airflow at 81% of setpoint all week", () => {
    const a = vav("VAV-A", (t) => (dayOf(t) === 0 && hourOf(t) >= 14 && hourOf(t) < 14.25 ? 300 : 480));
    const b = vav("VAV-B", (t) => 405 + Math.abs(noise(t, 2)));
    const r = vavStarvedAirflow([a, b], ctx());
    expect(r.findings).toEqual([]);
    expect(r.metrics).toMatchObject({ judged: 2, worst: { name: "VAV-A", hours: 0.3 } });
    expect(positiveAnswer(answered("q06_vav_starved_airflow", r))).toBe(
      "None of the 2 VAVs judged ran below 80% of airflow setpoint while occupied for 30 minutes at a stretch or on two days; the most time below was 0.3 h (VAV-A).",
    );
  });

  it("a flat-lined airflow sensor goes to Data Health and raises no VAV finding", () => {
    const flow = series("supply_air_flow", () => 300);
    const u = unit("VAV-F", "vav", [flow, series("supply_air_flow_sp", () => 500)]);
    dataQuality("q06_vav_starved_airflow", vavStarvedAirflow, u, flow, ["airflow"]);
  });
});

describe("Q7 VAV at 100% damper and still missed setpoint", () => {
  const vav = (name: string, damper: (t: number) => number, temp: (t: number) => number) =>
    unit(name, "vav", [series("vav_damper_cmd", damper), series("zone_temp", temp), series("zone_temp_sp", () => 72)]);

  it("raises Watch at 40% of occupied hours, 4 °F warm; with no occupancy source it judges every hour", () => {
    const u = vav(
      "VAV-7",
      (t) => (between(t, 14, 18) || between(t, 0, 6) ? 100 : 50 + noise(t, 10)),
      (t) => (between(t, 14, 18) ? 76 : between(t, 0, 6) ? 80 : 72 + noise(t)),
    );
    const r = vavDamperFullMissedSetpoint([u], ctx());
    const f = only(r, "VAV-7");
    expect(f).toMatchObject({ issueCode: "damper_full_zone_warm", priority: "watch" });
    expect(f.evidence).toMatchObject({ percent: 40, hours: 20, maxDeviationF: 4, averageDamperPercent: 100 });
    expect(f.evidence.expected).toBe("within ±2 °F of the 72.0 °F setpoint");
    expect(r.metrics.hoursJudged).toBe("occupied");
    // No occupancy source: the night hours count too, 20 + 30 of 168.
    const all = vavDamperFullMissedSetpoint([u], ctx({ occupied: null }));
    expect(only(all, "VAV-7").evidence).toMatchObject({ hours: 50, percent: 30 });
    expect(all.metrics.hoursJudged).toBe("all");
  });

  it("raises nothing for a damper at 94%, or a zone 1.9 °F off at 100%", () => {
    const a = vav("VAV-A", (t) => (between(t, 14, 18) ? 94 : 50 + noise(t, 10)), (t) => (between(t, 14, 18) ? 76 : 72 + noise(t)));
    const b = vav("VAV-B", (t) => (between(t, 14, 18) ? 100 : 50 + noise(t, 10)), (t) => (between(t, 14, 18) ? 73.9 : 72 + noise(t)));
    const r = vavDamperFullMissedSetpoint([a, b], ctx());
    expect(r.findings).toEqual([]);
    expect(r.metrics).toMatchObject({ judged: 2, worst: { hours: 0 } });
    expect(positiveAnswer(answered("q07_vav_damper_full_missed_setpoint", r))).toBe(
      "None of the 2 VAVs judged sat at full damper and missed setpoint for 30 minutes at a stretch or on two days.",
    );
  });

  it("a flat-lined space temperature goes to Data Health and raises no VAV finding", () => {
    const temp = series("zone_temp", () => 76);
    const u = unit("VAV-F", "vav", [series("vav_damper_cmd", (t) => (between(t, 14, 18) ? 100 : 50 + noise(t, 10))), temp, series("zone_temp_sp", () => 72)]);
    dataQuality("q07_vav_damper_full_missed_setpoint", vavDamperFullMissedSetpoint, u, temp, ["space temp"]);
  });
});

describe("Q8 reheat open while the zone is above cooling setpoint", () => {
  const vav = (name: string, valve: (t: number) => number, temp: (t: number) => number) =>
    unit(name, "vav", [series("reheat_valve_cmd", valve), series("zone_temp", temp), series("zone_temp_cooling_sp", () => 74)]);

  it("raises Watch for 4 h on two days and Action Needed for 10 h", () => {
    const a = vav("VAV-A", (t) => (between(t, 13, 15, [0, 1]) ? 40 : 0), (t) => (between(t, 13, 15, [0, 1]) ? 76 : 72 + noise(t)));
    const b = vav("VAV-B", (t) => (between(t, 10, 12) ? 40 : 0), (t) => (between(t, 10, 12) ? 76 : 72 + noise(t)));
    const r = reheatOpenAboveCoolingSetpoint([a, b], ctx());
    expect(only(r, "VAV-A")).toMatchObject({ issueCode: "reheat_against_cooling", priority: "watch", evidence: expect.objectContaining({ hours: 4, averageValvePercent: 40, maxZoneTempF: 76 }) });
    expect(only(r, "VAV-B")).toMatchObject({ priority: "action_needed", evidence: expect.objectContaining({ hours: 10 }) });
    expect(r.findings.map((f) => f.subjectName)).toEqual(["VAV-B", "VAV-A"]);
  });

  it("raises nothing for a zone 0.8 °F over cooling setpoint, or a valve at 5%", () => {
    const a = vav("VAV-A", () => 40, (t) => 74.8 + Math.abs(noise(t, 0.1)) - 0.1);
    const b = vav("VAV-B", () => 5, (t) => 78 + noise(t));
    const r = reheatOpenAboveCoolingSetpoint([a, b], ctx());
    expect(r.findings).toEqual([]);
    expect(positiveAnswer(answered("q08_reheat_open_above_cooling_sp", r))).toBe(
      "None of the 2 reheat valves judged opened while its zone was above cooling setpoint for 30 minutes at a stretch or on two days.",
    );
  });

  it("a flat-lined space temperature goes to Data Health and raises no reheat finding", () => {
    const temp = series("zone_temp", () => 76);
    const u = unit("VAV-F", "vav", [series("reheat_valve_cmd", (t) => 40 + noise(t, 5)), temp, series("zone_temp_cooling_sp", () => 74)]);
    dataQuality("q08_reheat_open_above_cooling_sp", reheatOpenAboveCoolingSetpoint, u, temp, ["space temp"]);
  });
});

// ------------------------------------------------------------------ AHU / RTU

/** The supply fan on 06:00-18:00 weekdays, off otherwise. */
const fanOn = (t: number) => between(t, 6, 18);
/** Discharge air 70 °F with the fan off and for the first 15 minutes after it starts. */
const datProfile = (warmBy: number) => (t: number) => (!fanOn(t) || hourOf(t) < 6.25 ? 70 : between(t, 12, 15) ? 55 + warmBy + noise(t, 0.2) : 55 + noise(t, 0.2));

describe("Q9 discharge air temperature held setpoint", () => {
  const ahu = (name: string, type: string, extra: PointSeries, dat: (t: number) => number) =>
    unit(name, type, [series("supply_air_temp", dat), series("supply_air_temp_sp", () => 55), series("supply_fan_status", onOff(fanOn)), extra]);

  it("judges a modulating unit at ±1.5 °F and a staged DX unit at ±4 °F, skipping the fan's first 15 minutes", () => {
    const hydronic = ahu("AHU-1", "ahu", series("cooling_valve_cmd", (t) => 40 + noise(t, 10)), datProfile(2));
    const dx = ahu("RTU-1", "rtu", series("compressor_status", onOff((t) => between(t, 12, 15))), datProfile(2));
    expect(datBand(hydronic)).toEqual({ band: 1.5, kind: "modulating" });
    expect(datBand(dx)).toEqual({ band: 4, kind: "staged DX" });
    const r = datHoldsSetpoint([hydronic, dx], ctx());
    // 15 h out of 58.75 fan-on hours judged (12 h a day less the 15-minute settle): 26%.
    expect(only(r, "AHU-1")).toMatchObject({
      issueCode: "dat_above_setpoint",
      priority: "watch",
      evidence: expect.objectContaining({ percent: 26, hours: 15, bandF: 1.5, bandKind: "modulating", fanOnHoursJudged: 58.8 }),
    });
    expect(r.findings.map((f) => f.subjectName)).toEqual(["AHU-1"]);
    expect(r.metrics).toMatchObject({ judged: 2, lowest: { name: "AHU-1", percentInBand: 74 } });
  });

  it("raises nothing 1.4 °F off on a modulating unit, 3.9 °F off on a DX unit, or for a cold start every morning", () => {
    const hydronic = ahu("AHU-1", "ahu", series("heating_valve_cmd", (t) => 40 + noise(t, 10)), (t) => (!fanOn(t) || hourOf(t) < 6.25 ? 70 : 56.3 + noise(t, 0.1)));
    const dx = ahu("RTU-1", "rtu", series("compressor_status", onOff(() => false)), (t) => (!fanOn(t) || hourOf(t) < 6.25 ? 70 : 58.8 + noise(t, 0.1)));
    const r = datHoldsSetpoint([hydronic, dx], ctx());
    expect(r.findings).toEqual([]);
    expect(r.metrics).toMatchObject({ judged: 2, lowest: { percentInBand: 100 } });
    expect(positiveAnswer(answered("q09_dat_holds_setpoint", r))).toMatch(/^All 2 units judged held discharge air within its band .* for at least 100% of fan-on hours/);
  });

  it("a flat-lined discharge air sensor goes to Data Health and raises no AHU finding", () => {
    const dat = series("supply_air_temp", () => 57);
    const u = unit("AHU-F", "ahu", [dat, series("supply_air_temp_sp", () => 55), series("supply_fan_status", onOff(fanOn)), series("cooling_valve_cmd", (t) => 40 + noise(t, 10))]);
    dataQuality("q09_dat_holds_setpoint", datHoldsSetpoint, u, dat, ["DAT"]);
  });
});

describe("Q10 duct static tracked setpoint", () => {
  const ahu = (name: string, pv: PointSeries, sp: PointSeries) => unit(name, "ahu", [pv, sp, series("supply_fan_status", onOff(fanOn))]);
  const staticProfile = (low: number, normal: number, amp: number) => (t: number) => (!fanOn(t) || hourOf(t) < 6.25 ? 0 : between(t, 12, 15) ? low : normal + noise(t, amp));

  it("raises Watch for 0.7 against 1.0 in. w.c., in in. w.c. and in pascals alike", () => {
    const a = ahu("AHU-1", series("duct_static_pressure", staticProfile(0.7, 1, 0.01)), series("duct_static_pressure_sp", () => 1));
    const b = ahu(
      "AHU-2",
      series("duct_static_pressure", staticProfile(174.4, 249.1, 2), { unit: "pascal" }),
      series("duct_static_pressure_sp", () => 249.1, { unit: "pascal" }),
    );
    expect(staticTolerance(1)).toBe(0.1);
    expect(staticTolerance(3)).toBeCloseTo(0.3);
    const r = staticTracksSetpoint([a, b], ctx());
    expect(only(r, "AHU-1")).toMatchObject({ issueCode: "static_below_setpoint", priority: "watch", evidence: expect.objectContaining({ percent: 26, hours: 15, averageStaticInWc: 0.7, averageSetpointInWc: 1 }) });
    expect(only(r, "AHU-2")).toMatchObject({ evidence: expect.objectContaining({ percent: 26, averageStaticInWc: 0.7, averageSetpointInWc: 1 }) });
  });

  it("raises nothing 0.09 in. w.c. under setpoint", () => {
    const a = ahu("AHU-1", series("duct_static_pressure", staticProfile(0.91, 0.91, 0.005)), series("duct_static_pressure_sp", () => 1));
    const r = staticTracksSetpoint([a], ctx());
    expect(r.findings).toEqual([]);
    expect(positiveAnswer(answered("q10_static_tracks_setpoint", r))).toBe("The one unit judged tracked duct static setpoint for at least 100% of fan-on hours (lowest: AHU-1).");
  });

  it("a flat-lined static sensor goes to Data Health and raises no AHU finding", () => {
    const pv = series("duct_static_pressure", () => 0.7);
    dataQuality("q10_static_tracks_setpoint", staticTracksSetpoint, ahu("AHU-F", pv, series("duct_static_pressure_sp", () => 1)), pv, ["duct static"]);
  });
});

describe("Q11 heating and cooling on together", () => {
  it("raises Action Needed for valves open together 9 h, and Watch for a heat stage with a compressor for 1 h", () => {
    const ahu = unit("AHU-1", "ahu", [
      series("heating_valve_cmd", (t) => (between(t, 10, 13, [0, 1, 2]) ? 30 : 0)),
      series("cooling_valve_cmd", (t) => 40 + noise(t, 10)),
    ]);
    const rtu = unit("RTU-1", "rtu", [
      series("heating_stage_cmd", onOff((t) => between(t, 10, 11, [0]))),
      series("compressor_status", onOff((t) => between(t, 9, 12, [0]))),
    ]);
    const r = simultaneousHeatingCooling([ahu, rtu], ctx());
    expect(only(r, "AHU-1")).toMatchObject({ issueCode: "heating_and_cooling_together", priority: "action_needed", evidence: expect.objectContaining({ hours: 9, days: 3 }) });
    expect(only(r, "RTU-1")).toMatchObject({ priority: "watch", evidence: expect.objectContaining({ hours: 1, days: 1 }) });
  });

  it("raises nothing for a heating valve at 5%, or a heat stage on with a compressor for 15 minutes on one day", () => {
    const ahu = unit("AHU-1", "ahu", [series("heating_valve_cmd", () => 5), series("cooling_valve_cmd", (t) => 40 + noise(t, 10))]);
    const rtu = unit("RTU-1", "rtu", [
      series("heating_stage_cmd", onOff((t) => between(t, 10, 10.25, [0]))),
      series("compressor_status", onOff((t) => between(t, 9, 12, [0]))),
    ]);
    const r = simultaneousHeatingCooling([ahu, rtu], ctx());
    expect(r.findings).toEqual([]);
    expect(r.metrics).toMatchObject({ judged: 2, worst: { name: "RTU-1", hours: 0.3 } });
  });

  it("a heating valve reading 150% goes to Data Health and raises no simultaneous heating finding", () => {
    const heat = series("heating_valve_cmd", (t) => 150 + noise(t, 5));
    const u = unit("AHU-F", "ahu", [heat, series("cooling_valve_cmd", (t) => 40 + noise(t, 10))]);
    dataQuality("q11_simultaneous_heating_cooling", simultaneousHeatingCooling, u, heat, ["heating valve or heat stage"]);
  });
});

describe("Q12 economizer at minimum with free cooling available", () => {
  const compressorOn = (t: number) => between(t, 13, 16);
  const rtu = (name: string, cooling: boolean, rat: PointSeries = series("return_air_temp", (t) => 72 + noise(t))) =>
    unit(name, "rtu", [
      series("oa_damper_cmd", (t) => (compressorOn(t) ? 15 : 40 + noise(t, 5))),
      rat,
      series("supply_fan_status", onOff(fanOn)),
      ...(cooling ? [series("compressor_status", onOff(compressorOn))] : []),
    ]);
  const weather = (oat: number) => [series("outside_air_temp", (t) => oat + noise(t, 2), { name: "OAT" })];

  it("raises Action Needed for 15 h at minimum while cooling ran with 50 °F outside, reading OAT from the station", () => {
    const station = weather(50);
    const r = economizerAtMinimum([rtu("RTU-1", true)], ctx({ station }));
    expect(only(r, "RTU-1")).toMatchObject({ issueCode: "economizer_at_minimum", priority: "action_needed" });
    expect(only(r, "RTU-1").evidence).toMatchObject({ hours: 15, percent: 100, freeCoolingHours: 15 });
    expect(r.metrics).toMatchObject({ judged: 1, freeCoolingHours: 15 });
  });

  it("raises nothing above the 65 °F high limit, and does not judge a unit with no cooling point trended", () => {
    const r = economizerAtMinimum([rtu("RTU-1", true)], ctx({ station: weather(68) }));
    expect(r.findings).toEqual([]);
    expect(r.metrics).toMatchObject({ judged: 1, freeCoolingHours: 0 });
    // The documented exception to "the seed's roles are enough": the
    // inventory runs Q12 for a unit with no cooling point, and the function
    // says why it did not judge it.
    const noCall = rtu("RTU-2", false);
    expect(decide("q12_economizer_at_minimum", [noCall], new Set(), weather(50)).outcome).toBe("runnable");
    const skipped = economizerAtMinimum([noCall], ctx({ station: weather(50) }));
    expect(skipped.findings).toEqual([]);
    expect(skipped.skipped).toEqual([{ name: "RTU-2", reason: "no cooling valve, compressor or cooling stage trended, so a call for cooling cannot be told from deadband" }]);
    expect(positiveAnswer(answered("q12_economizer_at_minimum", skipped))).toBe("No unit could be judged.");
  });

  it("a flat-lined return air sensor goes to Data Health and raises no economizer finding", () => {
    const rat = series("return_air_temp", () => 72);
    dataQuality("q12_economizer_at_minimum", economizerAtMinimum, rtu("RTU-F", true, rat), rat, ["RAT"], weather(50));
  });
});

// ------------------------------------------------------------------ hydronic

describe("Q13 hot water supply and delta T", () => {
  const boiler = (name: string, hws: (t: number) => number, dt: (t: number) => number, extra: PointSeries[] = []) =>
    unit(name, "boiler", [series("hw_supply_temp", hws), series("hw_return_temp", (t) => hws(t) - dt(t)), series("hw_supply_temp_sp", () => 180), ...extra]);

  it("raises supply below setpoint at 18% of in-service hours, and low delta T at 6 °F; the headline is time-weighted", () => {
    const a = boiler("B-1", (t) => (between(t, 6, 12) ? 170 : 180) + noise(t, 0.5), () => 15);
    const b = boiler("B-2", (t) => 180 + noise(t, 0.5), () => 6);
    const r = hotWaterLoop([a, b], ctx());
    expect(only(r, "B-1")).toMatchObject({ issueCode: "supply_below_setpoint", issue: "HWS below setpoint", priority: "watch", evidence: expect.objectContaining({ percent: 18, hours: 30, inServiceHours: 168 }) });
    expect(only(r, "B-2")).toMatchObject({ issueCode: "low_delta_t", priority: "watch", evidence: expect.objectContaining({ averageDeltaT: 6, percent: 100 }) });
    expect(r.metrics).toMatchObject({ judged: 2, label: "HWS", onTargetPercent: 91, averageDeltaT: 10.5 });
  });

  it("raises nothing 3.8 °F off with a 10.5 °F delta T; a plant off for the season, or outside its status, is not judged", () => {
    const fine = boiler("B-1", (t) => 183.5 + noise(t, 0.3), () => 10.5);
    const seasonOff = boiler("B-2", (t) => 70 + noise(t), () => 0.5);
    // With a boiler status, the hours it is off are not judged even though supply is far off setpoint.
    const statusRun = boiler("B-3", (t) => (between(t, 6, 18) ? 180 + noise(t, 0.5) : 120), (t) => (between(t, 6, 18) ? 12 : 20), [series("boiler_status", onOff((t) => between(t, 6, 18)))]);
    const r = hotWaterLoop([fine, seasonOff, statusRun], ctx());
    expect(r.findings).toEqual([]);
    expect(r.skipped).toEqual([{ name: "B-2", reason: "loop never in service in the period" }]);
    expect(r.metrics).toMatchObject({ judged: 2, onTargetPercent: 100 });
    expect(positiveAnswer(answered("q13_hw_supply_and_delta_t", r))).toMatch(/^HWS held setpoint and delta T held its minimum on the 2 loops judged; HWS on target 100% of in-service hours, average delta T 1\d\.\d °F\.$/);
  });

  it("a flat-lined HWS sensor goes to Data Health and raises no hot water finding", () => {
    const hws = series("hw_supply_temp", () => 170);
    const u = unit("B-F", "boiler", [hws, series("hw_return_temp", (t) => 155 + noise(t)), series("hw_supply_temp_sp", () => 180)]);
    dataQuality("q13_hw_supply_and_delta_t", hotWaterLoop, u, hws, ["HWS temp"]);
  });
});

describe("Q14 chilled water supply and delta T", () => {
  it("judges a chiller only while its status is on: 43% off setpoint; a 5 °F delta T is low", () => {
    const on = (t: number) => between(t, 6, 20);
    const chws = (t: number) => (!on(t) ? 60 + noise(t) : between(t, 12, 18) ? 48 + noise(t, 0.2) : 44 + noise(t, 0.2));
    const a = unit("CH-1", "chiller", [
      series("chw_supply_temp", chws),
      series("chw_return_temp", (t) => (on(t) ? chws(t) + 10 : chws(t) + 0.5)),
      series("chw_supply_temp_sp", () => 44),
      series("chiller_status", onOff(on)),
    ]);
    const b = unit("CH-2", "chiller", [
      series("chw_supply_temp", (t) => 44 + noise(t, 0.2)),
      series("chw_return_temp", (t) => 49 + noise(t, 0.2)),
      series("chw_supply_temp_sp", () => 44),
    ]);
    const r = chilledWaterLoop([a, b], ctx());
    expect(only(r, "CH-1")).toMatchObject({ issueCode: "supply_above_setpoint", issue: "CHWS above setpoint", evidence: expect.objectContaining({ percent: 43, hours: 30, inServiceHours: 70 }) });
    expect(only(r, "CH-2")).toMatchObject({ issueCode: "low_delta_t", evidence: expect.objectContaining({ averageDeltaT: 5 }) });
    expect(r.metrics).toMatchObject({ label: "CHWS", judged: 2 });
  });

  it("raises nothing 1.8 °F off with an 8.5 °F delta T", () => {
    const u = unit("CH-1", "chiller", [
      series("chw_supply_temp", (t) => 45.8 + noise(t, 0.1)),
      series("chw_return_temp", (t) => 54.3 + noise(t, 0.1)),
      series("chw_supply_temp_sp", () => 44),
    ]);
    const r = chilledWaterLoop([u], ctx());
    expect(r.findings).toEqual([]);
    expect(r.metrics).toMatchObject({ onTargetPercent: 100, averageDeltaT: 8.5 });
  });

  it("a flat-lined CHWS sensor goes to Data Health and raises no chilled water finding", () => {
    const chws = series("chw_supply_temp", () => 48);
    const u = unit("CH-F", "chiller", [chws, series("chw_return_temp", (t) => 58 + noise(t)), series("chw_supply_temp_sp", () => 44)]);
    dataQuality("q14_chw_supply_and_delta_t", chilledWaterLoop, u, chws, ["CHWS temp"]);
  });
});

// ------------------------------------------------------------------ DX

/** `n` cycles of on `onMin` / off `offMin` starting at `start`. */
function cycles(start: number, n: number, onMin: number, offMin: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let k = 0; k < n; k += 1) {
    const t = start + k * (onMin + offMin) * MINUTE_MS;
    out.push([t, 1], [t + onMin * MINUTE_MS, 0]);
  }
  return out;
}

describe("Q15 compressor short cycling", () => {
  it("counts 6 starts in an hour; two days is Action Needed, one day Watch; a numeric stage command counts each stage", () => {
    const a = unit("RTU-A", "rtu", [cov("compressor_status", [...cycles(at(0, 14), 6, 5, 5), ...cycles(at(1, 14), 6, 5, 5)])]);
    const b = unit("RTU-B", "rtu", [cov("compressor_status", cycles(at(0, 14), 6, 5, 5))]);
    const stages: Array<[number, number]> = [[at(0, 14), 1]];
    for (let k = 0; k < 6; k += 1) stages.push([at(0, 14) + (5 + 10 * k) * MINUTE_MS, 2], [at(0, 14) + (10 + 10 * k) * MINUTE_MS, 1]);
    stages.push([at(0, 15.5), 0]);
    const c = unit("RTU-C", "rtu", [cov("cooling_stage_cmd", stages, 0, { dataType: "real", name: "Cool_Stage" })]);
    const r = compressorShortCycling([a, b, c], ctx());
    expect(only(r, "RTU-A")).toMatchObject({ issueCode: "short_cycling", priority: "action_needed", evidence: expect.objectContaining({ peakStartsPerHour: 6, startsInPeriod: 12, days: 2 }) });
    expect(only(r, "RTU-B")).toMatchObject({ priority: "watch", evidence: expect.objectContaining({ peakStartsPerHour: 6, days: 1 }) });
    expect(only(r, "RTU-C").evidence).toMatchObject({ peakStartsPerHour: 6, peakStage: "Cool_Stage stage 2", startsInPeriod: 7 });
    expect(r.metrics).toMatchObject({ judged: 3, peak: { startsPerHour: 6 } });
  });

  it("raises nothing for 4 starts an hour, and does not judge a 15-minute trend", () => {
    expect(slidingStarts([0, 15, 30, 45].map((m) => at(0, 14) + m * MINUTE_MS), WEEK)).toEqual({ peak: 4, over: [] });
    const four = unit("RTU-A", "rtu", [cov("compressor_status", [0, 1, 2].flatMap((d) => cycles(at(d, 14), 4, 5, 10)))]);
    const coarse = unit("RTU-B", "rtu", [series("compressor_status", onOff((t) => between(t, 12, 16)), { name: "Comp1" })]);
    const r = compressorShortCycling([four, coarse], ctx());
    expect(r.findings).toEqual([]);
    expect(r.skipped).toEqual([{ name: "RTU-B", reason: "Comp1 is trended every 15 min, too coarse to count starts" }]);
    expect(positiveAnswer(answered("q15_compressor_short_cycling", r))).toBe(
      "The one unit judged did not start a compressor stage more than 4 times in an hour; the peak was 4 in an hour (RTU-A).",
    );
  });

  it("a compressor trend that stopped goes to Data Health and raises no short-cycling finding", () => {
    // One-minute readings, cycling Monday and Tuesday afternoons, then nothing from Wednesday.
    const status = series(
      "compressor_status",
      (t) => (dayOf(t) >= 2 ? null : between(t, 14, 15, [0, 1]) && Math.floor((t - at(dayOf(t), 14)) / (5 * MINUTE_MS)) % 2 === 0 ? 1 : 0),
      {},
      MINUTE_MS,
    );
    dataQuality("q15_compressor_short_cycling", compressorShortCycling, unit("RTU-F", "rtu", [status]), status, ["compressor status or stage command"]);
  });
});

describe("Q16 DAT drop with compressors on", () => {
  const compressorOn = (t: number) => between(t, 12, 16);
  const rtu = (name: string, drop: number, mat = false) => {
    const rat = (t: number) => 75 + noise(t);
    return unit(name, "rtu", [
      series("compressor_status", onOff(compressorOn)),
      series("return_air_temp", rat),
      series("supply_air_temp", (t) => (compressorOn(t) ? rat(t) - drop - (mat ? 12 : 0) : rat(t) - 1)),
      ...(mat ? [series("mixed_air_temp", (t) => rat(t) - 12)] : []),
    ]);
  };

  it("raises Action Needed for an 8 °F drop (the spec's fault floor), Watch for 12 °F, and measures from mixed air when it is trended", () => {
    const r = dxCoolingDelta([rtu("RTU-A", 8), rtu("RTU-B", 12), rtu("RTU-C", 8, true)], ctx());
    expect(only(r, "RTU-A")).toMatchObject({ issueCode: "dx_drop_fault", priority: "action_needed", evidence: expect.objectContaining({ averageF: 8, hoursJudged: 18.8, specCauses: "low charge, a failed compressor, or a dirty coil" }) });
    expect(only(r, "RTU-B")).toMatchObject({ issueCode: "dx_drop_low", priority: "watch", evidence: expect.objectContaining({ averageF: 12 }) });
    expect(only(r, "RTU-C").evidence.actual).toContain("below mixed air");
    expect(only(r, "RTU-C").evidence.averageF).toBe(8);
  });

  it("raises nothing for a 15.5 °F drop, or an 8 °F drop with compressors on for only 30 minutes once", () => {
    const short = unit("RTU-B", "rtu", [
      series("compressor_status", onOff((t) => between(t, 12, 12.5, [0]))),
      series("return_air_temp", (t) => 75 + noise(t)),
      series("supply_air_temp", (t) => (between(t, 12, 12.5, [0]) ? 67 : 74) + noise(t)),
    ]);
    const r = dxCoolingDelta([rtu("RTU-A", 15.5), short], ctx());
    expect(r.findings).toEqual([]);
    expect(r.metrics).toMatchObject({ judged: 2, lowest: { name: "RTU-B", averageF: 8 } });
  });

  it("a discharge air sensor reading 200 °F goes to Data Health and raises no DX finding", () => {
    const dat = series("supply_air_temp", (t) => 200 + noise(t));
    const u = unit("RTU-F", "rtu", [series("compressor_status", onOff(compressorOn)), series("return_air_temp", (t) => 75 + noise(t)), dat]);
    dataQuality("q16_dx_cooling_delta", dxCoolingDelta, u, dat, ["DAT"]);
  });
});

describe("Q17 compressors on below 55 °F with the economizer at minimum", () => {
  const rtu = (name: string, on: (t: number) => boolean, damper: (t: number) => number) =>
    unit(name, "rtu", [series("compressor_status", onOff(on)), series("oa_damper_cmd", damper)]);
  const weather = (oat: number) => [series("outside_air_temp", (t) => oat + noise(t, 0.5), { name: "OAT" })];

  it("raises Action Needed for 20 h and Watch for 2 h", () => {
    const a = rtu("RTU-A", (t) => between(t, 12, 16), (t) => (between(t, 12, 16) ? 10 : 30 + noise(t, 5)));
    const b = rtu("RTU-B", (t) => between(t, 12, 14, [0]), (t) => (between(t, 12, 14, [0]) ? 10 : 30 + noise(t, 5)));
    const r = compressorsDuringEconomizer([a, b], ctx({ station: weather(45) }));
    expect(only(r, "RTU-A")).toMatchObject({ issueCode: "compressors_with_economizer_closed", priority: "action_needed", evidence: expect.objectContaining({ hours: 20, days: 5 }) });
    expect(only(r, "RTU-B")).toMatchObject({ priority: "watch", evidence: expect.objectContaining({ hours: 2, days: 1 }) });
  });

  it("raises nothing at 56 °F outside, or with the damper at 25%", () => {
    const on = (t: number) => between(t, 12, 16);
    expect(compressorsDuringEconomizer([rtu("RTU-A", on, () => 10)], ctx({ station: weather(56) })).findings).toEqual([]);
    const r = compressorsDuringEconomizer([rtu("RTU-B", on, (t) => 25 + Math.abs(noise(t)))], ctx({ station: weather(45) }));
    expect(r.findings).toEqual([]);
    expect(positiveAnswer(answered("q17_compressors_during_economizer", r))).toBe(
      "The one unit judged never ran compressors below 55 °F outside with the economizer at minimum for 30 minutes at a stretch or on two days.",
    );
  });

  it("an OA damper reading -30% goes to Data Health and raises no DX finding", () => {
    // Out of physical range on the low side, which is also "at minimum": the
    // equipment question would have read it as a closed economizer.
    const damper = series("oa_damper_cmd", (t) => -30 + noise(t, 5));
    const u = unit("RTU-F", "rtu", [series("compressor_status", onOff((t) => between(t, 12, 16))), damper]);
    dataQuality("q17_compressors_during_economizer", compressorsDuringEconomizer, u, damper, ["OA damper"], weather(45));
  });
});

describe("Q18 DAT rise with heat stages on", () => {
  const heatOn = (t: number) => between(t, 6, 9);
  const rtu = (name: string, rise: (t: number) => number, step = 15 * MINUTE_MS, rat = (t: number) => 68 + noise(t)) =>
    unit(name, "rtu", [
      series("heating_stage_cmd", onOff(heatOn), {}, step),
      series("return_air_temp", rat, {}, step),
      series("supply_air_temp", (t) => rat(t) + (heatOn(t) ? rise(t) : 1), {}, step),
    ]);

  it("raises Watch for a 14 °F rise and Action Needed for 8 °F, after 10 minutes on", () => {
    const r = heatStageDelta([rtu("RTU-A", () => 14), rtu("RTU-B", () => 8)], ctx());
    expect(only(r, "RTU-A")).toMatchObject({ issueCode: "heat_rise_low", priority: "watch", evidence: expect.objectContaining({ averageF: 14, hoursJudged: 14.2 }) });
    expect(only(r, "RTU-B")).toMatchObject({ issueCode: "heat_rise_fault", priority: "action_needed", evidence: expect.objectContaining({ averageF: 8 }) });
  });

  it("raises nothing for a 21 °F rise, or a weak first 10 minutes before a 25 °F rise", () => {
    const warmup = rtu("RTU-B", (t) => (hourOf(t) < 6 + 10 / 60 ? 5 : 25), 5 * MINUTE_MS);
    const r = heatStageDelta([rtu("RTU-A", () => 21), warmup], ctx());
    expect(r.findings).toEqual([]);
    expect(r.metrics).toMatchObject({ judged: 2, lowest: { name: "RTU-A", averageF: 21 } });
    expect(positiveAnswer(answered("q18_heat_stage_delta", r))).toBe(
      "All 2 units judged raised DAT at least 20 °F above return or mixed air with heat stages on; the lowest average rise was 21.0 °F (RTU-A).",
    );
  });

  it("a flat-lined return air sensor goes to Data Health and raises no heat finding", () => {
    const rat = series("return_air_temp", () => 68);
    const u = unit("RTU-F", "rtu", [series("heating_stage_cmd", onOff(heatOn)), rat, series("supply_air_temp", (t) => 68 + (heatOn(t) ? 8 : 1) + noise(t))]);
    dataQuality("q18_heat_stage_delta", heatStageDelta, u, rat, ["RAT or MAT"]);
  });
});

// ------------------------------------------------------------------ Not Applicable / Not Monitored

describe("Not Applicable and Not Monitored for units lacking the type or the roles", () => {
  const p = (role: string) => series(role, (t) => 50 + noise(t, 5));
  const cases: Array<{ key: string; lacking: () => EquipmentUnit; missing: string[]; absent: () => EquipmentUnit }> = [
    { key: "q06_vav_starved_airflow", lacking: () => unit("VAV-1", "vav", [p("zone_temp")]), missing: ["airflow", "airflow setpoint"], absent: () => unit("RTU-1", "rtu", [p("zone_temp")]) },
    { key: "q07_vav_damper_full_missed_setpoint", lacking: () => unit("VAV-1", "vav", [p("zone_temp")]), missing: ["damper position", "active setpoint (or heating and cooling setpoints)"], absent: () => unit("RTU-1", "rtu", [p("zone_temp")]) },
    { key: "q08_reheat_open_above_cooling_sp", lacking: () => unit("VAV-1", "vav", [p("reheat_valve_cmd")]), missing: ["space temp", "cooling setpoint"], absent: () => unit("VAV-2", "vav", [p("zone_temp")]) },
    { key: "q09_dat_holds_setpoint", lacking: () => unit("RTU-1", "rtu", [p("zone_temp")]), missing: ["DAT", "DAT setpoint", "fan status"], absent: () => unit("VAV-1", "vav", [p("zone_temp")]) },
    { key: "q10_static_tracks_setpoint", lacking: () => unit("AHU-1", "ahu", [p("supply_air_temp")]), missing: ["duct static", "static setpoint", "fan status"], absent: () => unit("VAV-1", "vav", [p("zone_temp")]) },
    { key: "q11_simultaneous_heating_cooling", lacking: () => unit("AHU-1", "ahu", [p("supply_air_temp")]), missing: ["heating valve or heat stage", "cooling valve or compressor status"], absent: () => unit("B-1", "boiler", [p("hw_supply_temp")]) },
    { key: "q12_economizer_at_minimum", lacking: () => unit("RTU-1", "rtu", [p("oa_damper_cmd")]), missing: ["OAT", "RAT"], absent: () => unit("RTU-2", "rtu", [p("supply_air_temp")]) },
    { key: "q13_hw_supply_and_delta_t", lacking: () => unit("B-1", "boiler", [p("hw_supply_temp")]), missing: ["HWR temp", "HWS setpoint"], absent: () => unit("VAV-1", "vav", [p("zone_temp")]) },
    { key: "q14_chw_supply_and_delta_t", lacking: () => unit("CH-1", "chiller", [p("chw_supply_temp")]), missing: ["CHWR temp", "CHWS setpoint"], absent: () => unit("VAV-1", "vav", [p("zone_temp")]) },
    { key: "q15_compressor_short_cycling", lacking: () => unit("RTU-1", "rtu", [p("supply_air_temp")]), missing: ["compressor status or stage command"], absent: () => unit("VAV-1", "vav", [p("zone_temp")]) },
    { key: "q16_dx_cooling_delta", lacking: () => unit("RTU-1", "rtu", [p("supply_air_temp")]), missing: ["compressor status", "RAT or MAT"], absent: () => unit("VAV-1", "vav", [p("zone_temp")]) },
    { key: "q17_compressors_during_economizer", lacking: () => unit("RTU-1", "rtu", [p("oa_damper_cmd")]), missing: ["compressor status", "OAT"], absent: () => unit("RTU-2", "rtu", [p("supply_air_temp")]) },
    { key: "q18_heat_stage_delta", lacking: () => unit("RTU-1", "rtu", [p("zone_temp")]), missing: ["heat stage status", "DAT", "RAT or MAT"], absent: () => unit("VAV-1", "vav", [p("zone_temp")]) },
  ];

  it("does not apply the DX questions to a hydronic air handler, and does to one with a compressor", () => {
    const hydronic = unit("AHU-H", "ahu", [p("heating_valve_cmd"), p("cooling_valve_cmd"), p("oa_damper_cmd"), p("supply_air_temp")]);
    const dx = unit("AHU-D", "ahu", [series("compressor_status", () => 1), p("oa_damper_cmd"), series("heating_stage_cmd", () => 0)]);
    for (const key of ["q15_compressor_short_cycling", "q16_dx_cooling_delta", "q17_compressors_during_economizer", "q18_heat_stage_delta"]) {
      expect(decide(key, [hydronic]).outcome, key).toBe("not_applicable");
      expect(decide(key, [dx]).outcome, key).not.toBe("not_applicable");
    }
    // A rooftop unit is DX and gas heat by type, trended or not - the office's case.
    const rtu = unit("RV", "rtu", [p("supply_air_temp")]);
    for (const key of ["q15_compressor_short_cycling", "q16_dx_cooling_delta", "q18_heat_stage_delta"]) expect(decide(key, [rtu]).outcome, key).toBe("not_monitored");
  });

  it.each(cases)("$key: Not Monitored naming what is missing, Not Applicable with no unit of its type", ({ key, lacking, missing, absent }) => {
    const nm = decide(key, [lacking()]);
    expect(nm.outcome).toBe("not_monitored");
    expect(nm.missing).toEqual(missing);
    expect(decide(key, [absent()]).outcome).toBe("not_applicable");
    // The function itself never raises a finding over units the inventory refused.
    expect(EQUIPMENT_QUESTIONS[key]!([], ctx()).findings).toEqual([]);
  });
});

// ------------------------------------------------------------------ the registry, the library and the thresholds

describe("the registry, the library and the chosen thresholds", () => {
  it("has an analysis for every one of the twenty, and a function for every equipment question keyed to its library row", () => {
    expect(Object.values(ANALYSIS_AVAILABILITY).every((a) => a !== "not_built")).toBe(true);
    for (const q of BAS_LIBRARY_QUESTIONS) expect(ANALYSIS_AVAILABILITY[q.analysisFn], q.key).toBeDefined();
    const equipment = BAS_LIBRARY_QUESTIONS.filter((q) => q.position >= 6 && q.position <= 18);
    expect(Object.keys(EQUIPMENT_QUESTIONS).sort()).toEqual(equipment.map((q) => q.analysisFn).sort());
  });

  it("judges a unit carrying exactly the library's required roles (Q12 also needs a cooling call, the one documented exception)", () => {
    // For each question, a unit with the FIRST alternative of every required
    // group, plus the role that makes the sub-type apply. The inventory must
    // call it runnable, and the function must judge it rather than skip it.
    const subtype: Record<string, string[]> = {
      q08_reheat_open_above_cooling_sp: [],
      q12_economizer_at_minimum: ["compressor_status"],
      q17_compressors_during_economizer: [],
    };
    const typeOf: Record<string, string> = { vav: "vav", ahu: "ahu", rtu: "rtu", boiler: "boiler", chiller: "chiller" };
    for (const q of BAS_LIBRARY_QUESTIONS.filter((x) => x.position >= 6 && x.position <= 18)) {
      const type = typeOf[q.appliesToEquipment[0]!]!;
      const roles = new Set<string>([...q.requiredRoles.flatMap((r) => r.anyOf[0]!), ...(subtype[q.key] ?? [])]);
      roles.delete("occupancy_status");
      const station = roles.has("outside_air_temp") ? [series("outside_air_temp", (t) => 50 + noise(t))] : [];
      roles.delete("outside_air_temp");
      // Distinct levels per role, so a supply and its return are not the same reading.
      const points = [...roles].map((role, i) => series(role, (t) => 40 + 7 * i + noise(t, 5)));
      const u = unit(`U-${q.position}`, type, points);
      expect(decide(q.key, [u], new Set(), station).outcome, q.key).toBe("runnable");
      const r = EQUIPMENT_QUESTIONS[q.key]!([u], ctx({ station }));
      const coarse = q.key === "q15_compressor_short_cycling";
      expect(r.metrics.judged + (coarse ? 1 : 0), q.key).toBeGreaterThanOrEqual(1);
      if (!coarse) expect(r.skipped.filter((s) => !/never|no occupied|no hours/.test(s.reason)), q.key).toEqual([]);
    }
  });

  it("lists every CHOSEN constant in CHOSEN_THRESHOLDS, and nothing else", () => {
    const source = readFileSync("lib/modules/bas/reports/engine/analysis/thresholds.ts", "utf8").replace(/\r\n/g, "\n");
    const chosen = new Set<string>();
    for (const m of source.matchAll(/\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\n((?:export const \w+[^\n]*\n)+)/g)) {
      if (!/\bCHOSEN\b/.test(m[1]!)) continue;
      for (const name of m[2]!.matchAll(/export const (\w+)/g)) chosen.add(name[1]!);
    }
    chosen.delete("CHOSEN_THRESHOLDS");
    // PA_PER_INWC is a conversion, documented in the same block as the static band.
    chosen.delete("PA_PER_INWC");
    const listed = new Set(CHOSEN_THRESHOLDS.map((c) => c.name));
    expect([...listed].sort()).toEqual([...chosen].sort());
    for (const c of CHOSEN_THRESHOLDS) expect((thresholds as Record<string, unknown>)[c.name], c.name).toBeTypeOf("number");
  });

  it("assembles the template's DX table from Q15, Q16 and Q18", () => {
    const q = (key: string, units: unknown[]): QuestionResult => ({ key, position: 0, section: "dx", text: "", kind: "computed", outcome: "answered", needs: "", missing: [], reason: null, equipment: [], skipped: [], metrics: { units } });
    expect(
      dxTableRows([
        q("q15_compressor_short_cycling", [{ name: "RTU-2", peakStartsPerHour: 6 }]),
        q("q16_dx_cooling_delta", [{ name: "RTU-1", average: 17.25 }, { name: "RTU-2", average: 8 }]),
        q("q18_heat_stage_delta", [{ name: "RTU-1", average: 24 }]),
      ]),
    ).toEqual([
      { name: "RTU-1", peak: null, drop: 17.25, rise: 24 },
      { name: "RTU-2", peak: 6, drop: 8, rise: null },
    ]);
  });
});
