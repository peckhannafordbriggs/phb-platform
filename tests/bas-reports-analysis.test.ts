import { describe, expect, it } from "vitest";
import {
  ACTION_HOURS,
  ACTION_PERCENT,
  BAND_F,
  WATCH_PERCENT,
  dataHealth,
  manualOverrides,
  physicalRangeFor,
  runOutsideSchedule,
  zoneComfort,
} from "@/lib/modules/bas/reports/engine/analysis";
import { carriedForward, compareFindings, fingerprintOf, type PreviousFinding } from "@/lib/modules/bas/reports/engine/compare";
import { applicableUnits, checkRequirements, classify, decideQuestion, equipmentTypesFound, type LibraryRowForEngine } from "@/lib/modules/bas/reports/engine/inventory";
import { MODEL_PRICES, costOf, estimateCost } from "@/lib/modules/bas/reports/engine/pricing";
import { buildingStatus, sectionStatus, topFindings } from "@/lib/modules/bas/reports/engine/rollup";
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  busiestWindow,
  hourOfDayProfile,
  intersect,
  normalise,
  occupiedFromSchedule,
  occupiedFromSeries,
  persistence,
  segments,
  subtract,
  totalMs,
} from "@/lib/modules/bas/reports/engine/series";
import type { EquipmentUnit, Finding, Interval, OccupancySource, PointSeries, RawFinding } from "@/lib/modules/bas/reports/engine/types";
import { BAS_LIBRARY_QUESTIONS } from "@/lib/modules/bas/reports/library";

/**
 * The analysis functions (Reports, Phase 2) over synthetic series whose
 * answers are known. Pure: no database. Every threshold the functions apply
 * is exercised from both sides, and the spec's persistence rule - 30
 * minutes, or two days - is driven to accept and to refuse.
 */

const NY = "America/New_York";
/** Monday 2 November 2026 00:00 EST .. Monday 9 November 00:00 EST: a whole week, no clock change. */
const WEEK_START = Date.UTC(2026, 10, 2, 5, 0, 0);
const WEEK: Interval = { start: WEEK_START, end: WEEK_START + 7 * DAY_MS };
/** Weekdays 08:00-18:00 local. */
const HOURS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 8 * 60, endMinute: 18 * 60 }));
const OCCUPIED = occupiedFromSchedule(HOURS, WEEK, NY);

let nextId = 1;

/** A 15-minute interval series from a function of the instant. */
function series(
  over: Partial<PointSeries> & { role: string },
  value: (t: number) => number | null,
  range: Interval = WEEK,
  stepMs = 15 * MINUTE_MS,
): PointSeries {
  const samples: Array<{ t: number; v: number }> = [];
  for (let t = range.start; t < range.end; t += stepMs) {
    const v = value(t);
    if (v !== null) samples.push({ t, v });
  }
  const id = String(nextId++);
  return {
    pointId: id,
    name: over.name ?? `point-${id}`,
    role: over.role,
    measurement: over.measurement ?? (over.role.includes("temp") ? "temperature" : "status"),
    isSetpoint: over.isSetpoint ?? over.role.endsWith("_sp"),
    isStatus: over.isStatus ?? over.role.endsWith("_status"),
    isCommand: over.isCommand ?? over.role.endsWith("_cmd"),
    unit: over.unit ?? (over.role.includes("temp") ? "fahrenheit" : null),
    dataType: over.dataType ?? (over.role.endsWith("_status") || over.role.includes("occupancy") ? "bool" : "real"),
    equipmentId: over.equipmentId ?? null,
    equipmentName: over.equipmentName ?? null,
    stationId: over.stationId ?? "1",
    intervalS: over.intervalS === undefined ? stepMs / 1000 : over.intervalS,
    coverage: over.coverage ?? 1,
    carryIn: over.carryIn ?? null,
    carryInAt: over.carryInAt ?? null,
    samples,
    readingCount: samples.length,
    gaps: over.gaps ?? [],
    bucketMs: null,
  };
}

function unit(name: string, equipType: string, points: PointSeries[]): EquipmentUnit {
  const id = String(nextId++);
  for (const p of points) {
    p.equipmentId = id;
    p.equipmentName = name;
  }
  return { equipmentId: id, name, equipType, parentEquipmentId: null, points, ...classify(points) };
}

/** Local hour of day in New York for an instant. */
function hourNY(t: number): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: NY, hour: "numeric", hourCycle: "h23" }).format(new Date(t)));
}
function weekdayNY(t: number): number {
  const w = new Intl.DateTimeFormat("en-US", { timeZone: NY, weekday: "short" }).format(new Date(t));
  return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(w) + 1;
}

describe("series arithmetic", () => {
  it("builds occupied intervals from a weekday schedule in the building's zone: 50 hours in the week", () => {
    expect(totalMs(OCCUPIED) / HOUR_MS).toBe(50);
    // Monday 08:00 EST is 13:00Z.
    expect(OCCUPIED[0]).toEqual({ start: Date.UTC(2026, 10, 2, 13), end: Date.UTC(2026, 10, 2, 23) });
  });

  it("makes the clock-change day 25 hours long rather than shifting the hours", () => {
    // Sunday 1 November 2026, occupied 00:00-24:00 local: 25 real hours.
    const sunday = { weekday: 7, startMinute: 0, endMinute: 1440 };
    const range: Interval = { start: Date.UTC(2026, 10, 1, 4), end: Date.UTC(2026, 10, 2, 5) };
    const occ = occupiedFromSchedule([sunday], range, NY);
    expect(totalMs(occ) / HOUR_MS).toBe(25);
  });

  it("holds a value until the next reading or the hold, cuts recorded gaps, and carries the start value in", () => {
    const p = series({ role: "zone_temp" }, (t) => (t < WEEK.start + DAY_MS ? 70 : null));
    p.carryIn = 65;
    p.carryInAt = WEEK.start - 5 * MINUTE_MS;
    p.gaps = [{ start: WEEK.start + 2 * HOUR_MS, end: WEEK.start + 3 * HOUR_MS }];
    const segs = segments(p, WEEK, 45 * MINUTE_MS);
    // Carry-in holds from the start to the first sample at the start: nothing to hold.
    expect(segs[0]).toMatchObject({ start: WEEK.start, v: 70 });
    // Known time: one day, plus the last sample's hold past it, minus the hour cut out.
    const knownMs = segs.reduce((s, x) => s + (x.end - x.start), 0);
    expect(knownMs).toBe(DAY_MS + 30 * MINUTE_MS - HOUR_MS);
    // Nothing is asserted past the last reading plus the hold.
    expect(Math.max(...segs.map((s) => s.end))).toBe(WEEK.start + DAY_MS - 15 * MINUTE_MS + 45 * MINUTE_MS);
  });

  it("interval set arithmetic", () => {
    const a: Interval[] = [{ start: 0, end: 10 }, { start: 20, end: 30 }];
    const b: Interval[] = [{ start: 5, end: 25 }];
    expect(intersect(a, b)).toEqual([{ start: 5, end: 10 }, { start: 20, end: 25 }]);
    expect(subtract(a, b)).toEqual([{ start: 0, end: 5 }, { start: 25, end: 30 }]);
    expect(normalise([{ start: 5, end: 8 }, { start: 0, end: 6 }, { start: 9, end: 9 }])).toEqual([{ start: 0, end: 8 }]);
  });

  it("applies the spec's persistence rule: 30 minutes once, or two days of more than a spike", () => {
    const t0 = WEEK.start + 13 * HOUR_MS;
    expect(persistence([{ start: t0, end: t0 + 29 * MINUTE_MS }], NY).qualifies).toBe(false);
    expect(persistence([{ start: t0, end: t0 + 30 * MINUTE_MS }], NY).qualifies).toBe(true);
    // Ten minutes on Monday and ten on Tuesday: recurring, qualifies.
    expect(persistence([{ start: t0, end: t0 + 10 * MINUTE_MS }, { start: t0 + DAY_MS, end: t0 + DAY_MS + 10 * MINUTE_MS }], NY).qualifies).toBe(true);
    // Two one-minute spikes on two days: spikes, ignored.
    expect(persistence([{ start: t0, end: t0 + MINUTE_MS }, { start: t0 + DAY_MS, end: t0 + DAY_MS + MINUTE_MS }], NY).qualifies).toBe(false);
  });

  it("finds the busiest two-hour window of the day", () => {
    const t0 = WEEK.start + 14 * HOUR_MS; // 14:00 EST: the week starts at local midnight
    const profile = hourOfDayProfile([{ start: t0, end: t0 + 90 * MINUTE_MS }], NY);
    expect(profile[14]).toBe(60);
    expect(profile[15]).toBe(30);
    expect(busiestWindow(profile)).toBe("14:00-16:00");
    expect(busiestWindow(new Array(24).fill(0))).toBeNull();
  });

  it("reads occupied intervals from a boolean point, carrying the state in", () => {
    const occ = series({ role: "occupancy_status", intervalS: null }, () => null);
    occ.carryIn = 1;
    occ.carryInAt = WEEK.start - DAY_MS;
    occ.samples = [{ t: WEEK.start + 10 * HOUR_MS, v: 0 }];
    expect(occupiedFromSeries(occ, WEEK)).toEqual([{ start: WEEK.start, end: WEEK.start + 10 * HOUR_MS }]);
  });
});

describe("q03/q04 zone comfort", () => {
  it("knows a zone that is 2 °F over for 40% of occupied hours: 60% in band, Watch, warm, at the afternoon hours", () => {
    // Over the cooling band 14:00-18:00 on weekdays (4 of 10 occupied hours), by 4 °F.
    const temp = series({ role: "zone_temp", name: "VAV-2 temp" }, (t) => {
      const h = hourNY(t);
      return weekdayNY(t) <= 5 && h >= 14 && h < 18 ? 76 : 72;
    });
    const sp = series({ role: "zone_temp_sp", name: "VAV-2 sp" }, () => 72);
    const vav = unit("VAV-2", "vav", [temp, sp]);
    const result = zoneComfort([vav], OCCUPIED, WEEK, NY, new Set());
    expect(result.zones).toHaveLength(1);
    expect(result.zones[0]).toMatchObject({ name: "VAV-2", percentInBand: 60, maxDeviationF: 4, worstHour: 14, setpointKind: "single" });
    expect(result.overallPercentInBand).toBe(60);
    expect(result.findings).toHaveLength(1);
    const f = result.findings[0]!;
    expect(f).toMatchObject({ questionKey: "q03_zone_comfort", subjectName: "VAV-2", issueCode: "zone_warm", priority: "watch" });
    expect(f.evidence.percent).toBe(40);
    expect(f.evidence.actual).toContain("40% of occupied hours");
    expect(f.evidence.actual).toContain("4.0 °F over");
    expect(f.evidence.expected).toContain(`±${BAND_F} °F of the 72.0 °F setpoint`);
    expect(f.evidence.when).toBe("14:00-16:00");
    expect(f.evidence.occupiedHoursJudged).toBe(50);
  });

  it("raises Action Needed at half the hours or five degrees, nothing under ten percent, and ignores unoccupied misses", () => {
    // 6 °F over for one occupied hour a day (10%): Action Needed by deviation.
    const hot = series({ role: "zone_temp" }, (t) => (weekdayNY(t) <= 5 && hourNY(t) === 9 ? 78 : 72));
    const hotSp = series({ role: "zone_temp_sp" }, () => 72);
    const hotUnit = unit("VAV-hot", "vav", [hot, hotSp]);
    // 3 °F over for 5% of occupied hours: within tolerance, no finding.
    const mild = series({ role: "zone_temp" }, (t) => (weekdayNY(t) <= 5 && hourNY(t) === 9 && new Date(t).getUTCMinutes() < 30 ? 75 : 72));
    const mildSp = series({ role: "zone_temp_sp" }, () => 72);
    const mildUnit = unit("VAV-mild", "vav", [mild, mildSp]);
    // 10 °F over all night, every night, but never while occupied: no finding.
    const night = series({ role: "zone_temp" }, (t) => (hourNY(t) >= 20 || hourNY(t) < 6 ? 82 : 72));
    const nightSp = series({ role: "zone_temp_sp" }, () => 72);
    const nightUnit = unit("VAV-night", "vav", [night, nightSp]);

    const result = zoneComfort([hotUnit, mildUnit, nightUnit], OCCUPIED, WEEK, NY, new Set());
    expect(result.findings.map((f) => [f.subjectName, f.priority])).toEqual([["VAV-hot", "action_needed"]]);
    expect(result.zones.find((z) => z.name === "VAV-night")?.percentInBand).toBe(100);
    expect(result.zones.find((z) => z.name === "VAV-mild")?.percentInBand).toBe(95);
    expect(ACTION_PERCENT).toBe(50);
    expect(WATCH_PERCENT).toBe(10);
  });

  it("uses the heating and cooling pair when there is no single setpoint, and skips a zone with none", () => {
    const temp = series({ role: "zone_temp" }, () => 66); // 4 under the 70 heating setpoint
    const heat = series({ role: "zone_temp_heating_sp" }, () => 70);
    const cool = series({ role: "zone_temp_cooling_sp" }, () => 75);
    const dual = unit("Zone-dual", "zone", [temp, heat, cool]);
    const bare = unit("Zone-bare", "zone", [series({ role: "zone_temp" }, () => 70)]);
    const result = zoneComfort([dual, bare], OCCUPIED, WEEK, NY, new Set());
    expect(result.zones.find((z) => z.name === "Zone-dual")).toMatchObject({ percentInBand: 0, maxDeviationF: -4, setpointKind: "dual" });
    expect(result.findings[0]).toMatchObject({ subjectName: "Zone-dual", issueCode: "zone_cold", priority: "action_needed" });
    expect(result.findings[0]!.evidence.expected).toContain("between 68.0 °F and 77.0 °F");
    expect(result.skipped).toEqual([{ name: "Zone-bare", reason: "no setpoint trended" }]);
    expect(result.zones.find((z) => z.name === "Zone-bare")?.setpointKind).toBe("missing");
  });

  it("never judges a point Data Health excluded", () => {
    const temp = series({ role: "zone_temp" }, () => -40);
    const sp = series({ role: "zone_temp_sp" }, () => 72);
    const dead = unit("VAV-dead", "vav", [temp, sp]);
    const result = zoneComfort([dead], OCCUPIED, WEEK, NY, new Set([temp.pointId]));
    expect(result.zones).toEqual([]);
    expect(result.findings).toEqual([]);
  });
});

describe("q19 schedules", () => {
  it("counts the hours a fan ran outside occupied hours and the days it did: 6.5 h on 2 days, Watch", () => {
    // Fan on Mon 05:00-08:00 (3 h before occupancy) and Wed 18:00-21:30 (3.5 h after).
    const fan = series({ role: "supply_fan_status", name: "RTU-1 fan" }, (t) => {
      const d = weekdayNY(t);
      const h = hourNY(t) + new Date(t).getUTCMinutes() / 60;
      if (d === 1 && h >= 5 && h < 8) return 1;
      if (d === 3 && h >= 18 && h < 21.5) return 1;
      if (d <= 5 && h >= 8 && h < 18) return 1; // and on while occupied
      return 0;
    });
    const rtu = unit("RTU-1", "rtu", [fan]);
    const result = runOutsideSchedule([rtu], OCCUPIED, WEEK, NY, new Set());
    expect(result.results).toEqual([{ equipmentId: rtu.equipmentId, name: "RTU-1", statusPoint: "RTU-1 fan", hoursOutside: 6.5, days: 2 }]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ questionKey: "q19_run_outside_schedule", subjectName: "RTU-1", priority: "watch" });
    expect(result.findings[0]!.evidence).toMatchObject({ hoursOutside: 6.5, days: 2, expected: "off outside occupied hours" });
  });

  it("raises Action Needed past twenty hours, and raises nothing for a fan that follows the schedule", () => {
    const always = unit("RTU-always", "rtu", [series({ role: "supply_fan_status" }, () => 1)]);
    const scheduled = unit("RTU-sched", "rtu", [series({ role: "supply_fan_status" }, (t) => (weekdayNY(t) <= 5 && hourNY(t) >= 8 && hourNY(t) < 18 ? 1 : 0))]);
    const result = runOutsideSchedule([always, scheduled], OCCUPIED, WEEK, NY, new Set());
    expect(result.findings.map((f) => [f.subjectName, f.priority])).toEqual([["RTU-always", "action_needed"]]);
    expect(result.results.find((r) => r.name === "RTU-always")?.hoursOutside).toBe(168 - 50);
    expect(result.results.find((r) => r.name === "RTU-sched")?.hoursOutside).toBe(0);
    expect(ACTION_HOURS).toBe(20);
  });
});

describe("q05 overrides", () => {
  it("reports an override held long enough, with since when, and not a five-minute one", () => {
    const start = WEEK.start + 2 * DAY_MS + 10 * HOUR_MS; // Wed 10:00 EST
    const held = series({ role: "occupancy_override", name: "AHU-1 override", intervalS: null }, () => null);
    held.carryIn = 0;
    held.carryInAt = WEEK.start - HOUR_MS;
    held.samples = [{ t: start, v: 1 }, { t: start + 3 * HOUR_MS, v: 0 }];
    const brief = series({ role: "occupancy_override", name: "AHU-2 override", intervalS: null }, () => null);
    brief.carryIn = 0;
    brief.carryInAt = WEEK.start - HOUR_MS;
    brief.samples = [{ t: start, v: 1 }, { t: start + 5 * MINUTE_MS, v: 0 }];
    const result = manualOverrides([held, brief], WEEK, NY, new Set());
    expect(result.judged).toBe(2);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ subjectName: "AHU-1 override", issueCode: "override_held", priority: "watch" });
    expect(result.findings[0]!.evidence.when).toBe("since 4 Nov, 10:00");
    expect(result.findings[0]!.evidence.stillActive).toBe(false);
  });

  it("says an override still on at the period's end is active and counting", () => {
    const start = WEEK.end - 2 * HOUR_MS;
    const on = series({ role: "occupancy_override", intervalS: null }, () => null);
    on.carryIn = 0;
    on.carryInAt = WEEK.start;
    on.samples = [{ t: start, v: 1 }];
    const result = manualOverrides([on], WEEK, NY, new Set());
    expect(result.findings[0]).toMatchObject({ issueCode: "override_active" });
    expect(result.findings[0]!.evidence.actual).toContain("and counting");
  });
});

describe("q20 data health", () => {
  it("flags a flat room temperature, an out-of-range one, an offline trend and a stale one, and excludes all four", () => {
    const flat = series({ role: "zone_temp", name: "VAV-8 ZoneTemperature" }, () => 70.5);
    const dead = series({ role: "zone_temp", name: "points_RoomT" }, () => -40);
    const offline = series({ role: "zone_temp", name: "VAV-9 ZoneTemperature" }, () => null);
    offline.carryInAt = WEEK.start - 3 * DAY_MS;
    offline.carryIn = 71;
    const stale = series({ role: "zone_temp", name: "VAV-10 ZoneTemperature" }, (t) => (t < WEEK.end - 2 * DAY_MS ? 70 + Math.sin(t / HOUR_MS) : null));
    const fine = series({ role: "zone_temp", name: "VAV-1 ZoneTemperature" }, (t) => 70 + Math.sin(t / HOUR_MS));
    const result = dataHealth([flat, dead, offline, stale, fine], WEEK, NY);
    const byName = new Map(result.findings.map((f) => [f.subjectName, f]));
    expect(byName.get("VAV-8 ZoneTemperature")).toMatchObject({ issueCode: "flat", priority: "watch", section: "data_health" });
    expect(byName.get("VAV-8 ZoneTemperature")!.evidence.actual).toContain("exactly 70.5 °F for 7.0 days (672 readings)");
    expect(byName.get("points_RoomT")).toMatchObject({ issueCode: "out_of_range" });
    expect(byName.get("points_RoomT")!.evidence.actual).toBe("read -40 °F");
    expect(byName.get("points_RoomT")!.evidence.percent).toBe(100);
    expect(byName.get("VAV-9 ZoneTemperature")).toMatchObject({ issueCode: "offline" });
    expect(byName.get("VAV-10 ZoneTemperature")).toMatchObject({ issueCode: "stale" });
    expect(byName.has("VAV-1 ZoneTemperature")).toBe(false);
    expect([...result.excluded].sort()).toEqual([flat.pointId, dead.pointId, offline.pointId, stale.pointId].sort());
    expect(result.judged).toBe(5);
    // A dead sensor is one row, not two: out of range wins over flat.
    expect(result.findings.filter((f) => f.subjectName === "points_RoomT")).toHaveLength(1);
  });

  it("does not judge a setpoint, a status point, or a change-of-value point for flatness", () => {
    const sp = series({ role: "zone_temp_sp", name: "sp" }, () => 72);
    const status = series({ role: "supply_fan_status", name: "fan" }, () => 1);
    const cov = series({ role: "duct_static_pressure", name: "static", intervalS: null, unit: "inches of water", measurement: "pressure" }, () => null);
    cov.carryIn = 1.2;
    cov.carryInAt = WEEK.start - DAY_MS;
    const result = dataHealth([sp, status, cov], WEEK, NY);
    expect(result.findings).toEqual([]);
    expect(result.excluded.size).toBe(0);
  });

  it("knows the physical ranges by role and unit", () => {
    expect(physicalRangeFor("zone_temp", "fahrenheit")).toMatchObject({ min: 35, max: 110 });
    expect(physicalRangeFor("zone_temp", "celsius")).toBeNull();
    expect(physicalRangeFor("outside_air_temp", "degF")).toMatchObject({ min: -50 });
    expect(physicalRangeFor("oa_damper_cmd", "percent")).toMatchObject({ min: 0, max: 100 });
    expect(physicalRangeFor("duct_static_pressure", "inches of water")).toMatchObject({ max: 10 });
    expect(physicalRangeFor("occupancy_status", null)).toBeNull();
  });
});

describe("inventory: classification, applicability, requirements", () => {
  const lib = (key: string) => BAS_LIBRARY_QUESTIONS.find((q) => q.key === key)! as unknown as LibraryRowForEngine;

  it("classifies a unit from its roles, as the spec's Step 1 says", () => {
    const rtu = unit("RV", "rtu", [series({ role: "oa_damper_cmd" }, () => 10), series({ role: "supply_air_temp" }, () => 55)]);
    expect(rtu).toMatchObject({ hydronic: false, dx: false, stagedHeat: false, economizer: true, reheat: false });
    const ahu = unit("AHU-1", "ahu", [series({ role: "cooling_valve_cmd" }, () => 0), series({ role: "heating_stage_cmd" }, () => 0)]);
    expect(ahu).toMatchObject({ hydronic: true, dx: false, stagedHeat: true });
    expect(equipmentTypesFound([rtu, ahu])).toEqual(["hydronic", "gas or electric heat", "economizer"]);
  });

  it("applies the hydronic questions to nothing on a DX-only building, and the DX questions to its rooftop unit", () => {
    const rtu = unit("RV", "rtu", [series({ role: "supply_air_temp" }, () => 55)]);
    const vav = unit("VAV-1", "vav", [series({ role: "zone_temp" }, () => 70)]);
    expect(applicableUnits(lib("q13_hw_supply_and_delta_t"), [rtu, vav])).toEqual([]);
    expect(applicableUnits(lib("q14_chw_supply_and_delta_t"), [rtu, vav])).toEqual([]);
    expect(applicableUnits(lib("q15_compressor_short_cycling"), [rtu, vav]).map((u) => u.name)).toEqual(["RV"]);
    expect(applicableUnits(lib("q08_reheat_open_above_cooling_sp"), [rtu, vav])).toEqual([]);
    expect(applicableUnits(lib("q03_zone_comfort"), [rtu, vav]).map((u) => u.name)).toEqual(["VAV-1"]);
  });

  it("decides Not Applicable, Not Monitored with the missing labels, and runnable; a coverage shortfall is a miss", () => {
    const rtu = unit("RV", "rtu", [series({ role: "supply_air_temp" }, () => 55), series({ role: "supply_air_temp_sp" }, () => 55)]);
    const vavOk = unit("VAV-ok", "vav", [series({ role: "zone_temp" }, () => 70), series({ role: "zone_temp_sp" }, () => 72)]);
    const low = series({ role: "zone_temp", coverage: 0.5 }, () => 70);
    const vavLow = unit("VAV-low", "vav", [low, series({ role: "zone_temp_sp" }, () => 72)]);
    const pointsByStation = new Map([["1", [...rtu.points, ...vavOk.points, ...vavLow.points]]]);
    const occupancy = new Map<string, OccupancySource>([["1", { stationId: "1", stationName: "S", kind: "manual", intervals: OCCUPIED, detail: "hours" }]]);
    const none = new Map<string, OccupancySource>([["1", { stationId: "1", stationName: "S", kind: "none", intervals: null, detail: "none" }]]);
    const stationOf = () => "1";

    expect(decideQuestion(lib("q13_hw_supply_and_delta_t"), [rtu, vavOk], pointsByStation, occupancy, stationOf, new Set())).toMatchObject({
      outcome: "not_applicable",
      reason: "no hydronic heating on this building",
    });
    const dat = decideQuestion(lib("q09_dat_holds_setpoint"), [rtu], pointsByStation, occupancy, stationOf, new Set());
    expect(dat.outcome).toBe("not_monitored");
    expect(dat.missing).toEqual(["fan status"]);
    const comfort = decideQuestion(lib("q03_zone_comfort"), [rtu, vavOk, vavLow], pointsByStation, occupancy, stationOf, new Set());
    expect(comfort.outcome).toBe("runnable");
    expect(comfort.qualified.map((u) => u.name)).toEqual(["VAV-ok"]);
    // Present but under coverage is said as such.
    expect(comfort.skipped).toEqual([{ name: "VAV-low", reason: "missing space temp (coverage 50%)" }]);
    expect(comfort.lowCoverage).toEqual([{ name: low.name, coverage: 0.5 }]);
    // Without any occupancy source the comfort question is not monitored, naming occupancy.
    const noOcc = decideQuestion(lib("q03_zone_comfort"), [vavOk], pointsByStation, none, stationOf, new Set());
    expect(noOcc.outcome).toBe("not_monitored");
    expect(noOcc.missing).toEqual(["occupancy"]);
  });

  it("takes a building-level role from the station when the unit lacks it", () => {
    const oat = series({ role: "outside_air_temp" }, () => 60);
    const rtu = unit("RV", "rtu", [series({ role: "oa_damper_cmd" }, () => 10), series({ role: "return_air_temp" }, () => 72)]);
    const check = checkRequirements(lib("q12_economizer_at_minimum"), rtu, [oat], null, new Set());
    expect(check.met).toBe(true);
  });
});

describe("comparison, carry-forward and roll-up", () => {
  const raw = (subject: string, issue: string, priority: RawFinding["priority"] = "watch"): RawFinding => ({
    questionKey: "q03_zone_comfort",
    section: "space_comfort",
    subjectKey: `equipment:${subject}`,
    equipmentId: subject,
    subjectName: `VAV-${subject}`,
    issueCode: issue,
    issue,
    priority,
    evidence: { actual: "a", expected: "b", when: "c", percent: Number(subject) },
  });

  it("fingerprints on question, subject and issue only", () => {
    expect(fingerprintOf("q", "equipment:1", "zone_warm")).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintOf("q", "equipment:1", "zone_warm")).toBe(fingerprintOf("q", "equipment:1", "zone_warm"));
    expect(fingerprintOf("q", "equipment:1", "zone_warm")).not.toBe(fingerprintOf("q", "equipment:2", "zone_warm"));
  });

  it("marks new, still open and cleared, keeps first-seen across runs, and carries open Action Needed items forward", () => {
    const first = compareFindings([raw("1", "zone_warm", "action_needed"), raw("2", "zone_cold")], [], "10", "2026-11-02T00:00:00Z");
    expect(first.counts).toEqual({ new: 2, stillOpen: 0, cleared: 0 });
    expect(first.findings.every((f) => f.state === "new" && f.firstSeenRunId === "10")).toBe(true);

    const previous: PreviousFinding[] = first.findings.map((f) => ({
      fingerprint: f.fingerprint,
      state: f.state,
      priority: f.priority,
      firstSeenRunId: f.firstSeenRunId,
      firstSeenAt: f.firstSeenAt,
      finding: { ...f },
    }));
    const second = compareFindings([raw("1", "zone_warm", "action_needed"), raw("3", "zone_warm")], previous, "11", "2026-11-09T00:00:00Z");
    expect(second.counts).toEqual({ new: 1, stillOpen: 1, cleared: 1 });
    const still = second.findings.find((f) => f.subjectName === "VAV-1")!;
    expect(still).toMatchObject({ state: "still_open", firstSeenRunId: "10", firstSeenAt: "2026-11-02T00:00:00Z" });
    expect(second.cleared[0]).toMatchObject({ subjectName: "VAV-2", state: "cleared" });
    expect(carriedForward(second.findings).map((f) => f.subjectName)).toEqual(["VAV-1"]);

    // A cleared item does not clear again.
    const third = compareFindings([], [previous[0]!, { ...previous[1]!, state: "cleared" }], "12", "2026-11-16T00:00:00Z");
    expect(third.cleared.map((f) => f.subjectName)).toEqual(["VAV-1"]);
  });

  it("rolls status up from priorities, ignoring cleared, Not Applicable and Not Monitored", () => {
    const f = (priority: Finding["priority"], state: Finding["state"]): Finding => ({
      ...raw("1", "x", priority),
      fingerprint: "f",
      state,
      firstSeenRunId: null,
      firstSeenAt: null,
      likelyCause: null,
      recommendedAction: null,
      fixLocation: null,
    });
    expect(sectionStatus([])).toBe("good");
    expect(sectionStatus([f("watch", "new")])).toBe("watch");
    expect(sectionStatus([f("watch", "new"), f("action_needed", "still_open")])).toBe("action_needed");
    expect(sectionStatus([f("action_needed", "cleared")])).toBe("good");
    const section = (status: "good" | "watch" | "action_needed" | "not_applicable" | "not_monitored") => ({
      key: "vav" as const,
      label: "VAV",
      status,
      statusSentence: "",
      questions: [],
      findings: [],
    });
    expect(buildingStatus([section("good"), section("not_monitored"), section("not_applicable")])).toBe("good");
    expect(buildingStatus([section("watch"), section("not_monitored")])).toBe("watch");
    expect(buildingStatus([section("watch"), section("action_needed")])).toBe("action_needed");
    expect(topFindings([f("watch", "new"), f("action_needed", "new"), f("action_needed", "cleared")]).map((x) => x.priority)).toEqual(["action_needed", "watch"]);
  });
});

describe("pricing", () => {
  it("meters a call from the usage counts at the model's rates, and estimates before one", () => {
    expect(MODEL_PRICES["claude-opus-5-5"]).toMatchObject({ input: 4, output: 20 });
    const cost = costOf("claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(cost).toBe(6);
    expect(costOf("claude-opus-5-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 })).toBe(0.2);
    expect(estimateCost("claude-opus-5-5", 4000, 1000)).toBeCloseTo(0.004 + 0.02, 6);
    expect(() => costOf("claude-unpriced", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).toThrow(/No price/);
  });
});
