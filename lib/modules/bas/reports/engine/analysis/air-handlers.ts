import { DX_TYPES } from "../inventory";
import { afterFirst, align, intersect, normalise, slicesMean, slicesMs, slicesWhere, subtract, type Segment } from "../series";
import type { EquipmentUnit, Interval, PointSeries, RawFinding } from "../types";
import {
  anyActive,
  celsiusIn,
  fmtF,
  held,
  hoursOf,
  onDays,
  onIntervals,
  openIntervals,
  percentOf,
  percentSegments,
  persists,
  pick,
  pickAll,
  unitFinding,
  worstOf,
  type AnalysisContext,
  type QuestionAnalysis,
} from "./common";
import {
  ACTION_SHARE_PERCENT,
  DAT_BAND_MODULATING_F,
  DAT_BAND_STAGED_F,
  ECON_DIFFERENTIAL_F,
  ECON_HIGH_LIMIT_F,
  ECON_MIN_POSITION_PCT,
  ENERGY_ACTION_HOURS,
  FAN_SETTLE_MS,
  PA_PER_INWC,
  STATIC_BAND_FRACTION,
  STATIC_BAND_INWC,
  VALVE_OPEN_PCT,
} from "./thresholds";

/**
 * Questions 9-12, Air Handlers / RTUs (Reports, Phase 5).
 *
 *   q09  Did discharge air temp hold setpoint? ±1.5°F on modulating valves,
 *        ±4°F on staged DX.
 *   q10  Did duct static pressure track setpoint?
 *   q11  Were heating and cooling on at the same time (valves open together,
 *        or heat stages and compressors on together)?
 *   q12  Was the economizer at minimum when free cooling was available?
 *
 * Q9 and Q10 are judged only while the supply fan is proven on (its status
 * is a required point), and not for the first FAN_SETTLE_MS after it
 * starts. Q11 and Q12 are energy waste and judged at any hour the unit
 * runs. None of the four needs occupancy, so none restricts to occupied
 * hours; the persistence rule then reads "30 minutes, or two days" over the
 * whole period, as Q19's does.
 */

export const DAT_QUESTION = "q09_dat_holds_setpoint";
export const STATIC_QUESTION = "q10_static_tracks_setpoint";
export const SIMULTANEOUS_QUESTION = "q11_simultaneous_heating_cooling";
export const ECONOMIZER_QUESTION = "q12_economizer_at_minimum";

export const HEATING_ROLES: readonly string[] = ["heating_valve_cmd", "heating_stage_cmd"];
export const COOLING_ROLES: readonly string[] = ["cooling_valve_cmd", "compressor_status", "compressor_cmd", "cooling_stage_cmd"];
const DAT_ROLES = ["supply_air_temp", "discharge_air_temp"];
const DAT_SP_ROLES = ["supply_air_temp_sp", "discharge_air_temp_sp"];

/**
 * Which of the spec's two bands a unit's discharge air is judged on. A unit
 * with compressor or cooling-stage points is staged DX, and gets ±4 °F even
 * if it also has a heating valve, because its cooling is what swings the
 * discharge air in steps. A unit with valves and no DX points modulates.
 * With neither trended, the type decides: a rooftop unit or split system is
 * staged DX, an air handler modulating.
 */
export function datBand(unit: Pick<EquipmentUnit, "dx" | "hydronic" | "equipType">): { band: number; kind: "staged DX" | "modulating" } {
  if (unit.dx) return { band: DAT_BAND_STAGED_F, kind: "staged DX" };
  if (unit.hydronic) return { band: DAT_BAND_MODULATING_F, kind: "modulating" };
  if (DX_TYPES.includes(unit.equipType ?? "")) return { band: DAT_BAND_STAGED_F, kind: "staged DX" };
  return { band: DAT_BAND_MODULATING_F, kind: "modulating" };
}

interface BandRow {
  name: string;
  percentInBand: number;
  band: number;
}

/** Fan proven on, minus its settle time after each start. */
function fanJudged(fan: PointSeries, ctx: AnalysisContext): Interval[] {
  return afterFirst(onIntervals(fan, ctx.range), FAN_SETTLE_MS);
}

/** Q9. */
export function datHoldsSetpoint(units: EquipmentUnit[], ctx: AnalysisContext): QuestionAnalysis {
  const findings: RawFinding[] = [];
  const skipped: QuestionAnalysis["skipped"] = [];
  const rows: BandRow[] = [];

  for (const unit of units) {
    const dat = pick(unit, DAT_ROLES, ctx);
    const sp = pick(unit, DAT_SP_ROLES, ctx);
    const fan = pick(unit, ["supply_fan_status"], ctx);
    if (dat === null || sp === null || fan === null) {
      skipped.push({ name: unit.name, reason: "DAT, DAT setpoint or fan status not usable" });
      continue;
    }
    const celsius = celsiusIn([dat, sp]);
    if (celsius !== null) {
      skipped.push({ name: unit.name, reason: celsius });
      continue;
    }
    const { band, kind } = datBand(unit);
    const slices = align([held(dat, ctx.range), held(sp, ctx.range)], fanJudged(fan, ctx));
    const judgedMs = slicesMs(slices);
    if (judgedMs === 0) {
      skipped.push({ name: unit.name, reason: "fan never ran long enough to judge discharge air" });
      continue;
    }
    const outSlices = slices.filter((s) => Math.abs(s.values[0]! - s.values[1]!) > band);
    const out = slicesWhere(outSlices, () => true);
    const outMs = slicesMs(outSlices);
    const percentOut = percentOf(outMs, judgedMs);
    rows.push({ name: unit.name, percentInBand: 100 - percentOut, band });

    const persisted = persists(out, ctx.timezone);
    if (out.length === 0 || !persisted.qualifies) continue;

    const high = slicesMs(outSlices.filter((s) => s.values[0]! > s.values[1]!));
    const warm = high >= outMs / 2;
    let maxDev = 0;
    for (const s of outSlices) {
      const d = s.values[0]! - s.values[1]!;
      if (Math.abs(d) > Math.abs(maxDev)) maxDev = d;
    }
    const avgSp = slicesMean(slices, (v) => v[1]!)!;
    findings.push(
      unitFinding({
        questionKey: DAT_QUESTION,
        section: "ahu_rtu",
        unit,
        issueCode: warm ? "dat_above_setpoint" : "dat_below_setpoint",
        issue: warm ? "Discharge air above setpoint" : "Discharge air below setpoint",
        priority: percentOut >= ACTION_SHARE_PERCENT ? "action_needed" : "watch",
        actual: `${dat.name} off setpoint ${percentOut}% of fan-on hours, up to ${Math.abs(maxDev).toFixed(1)} °F ${maxDev > 0 ? "over" : "under"}, ${onDays(persisted.days)}`,
        expected: `within ±${band} °F of the ${fmtF(avgSp)} setpoint (${kind})`,
        intervals: out,
        timezone: ctx.timezone,
        percent: percentOut,
        extra: { bandF: band, bandKind: kind, maxDeviationF: Math.round(maxDev * 10) / 10, fanOnHoursJudged: hoursOf(judgedMs) },
      }),
    );
  }

  return finishBand(findings, skipped, rows);
}

/** A static pressure in inches of water column, from a point trended in in. w.c., Pa or kPa. */
function toInWc(p: PointSeries, segs: Segment[]): Segment[] {
  const u = (p.unit ?? "").toLowerCase();
  const factor = /kilopascal|kpa/.test(u) ? 1000 / PA_PER_INWC : /pascal|^pa$/.test(u) ? 1 / PA_PER_INWC : 1;
  return factor === 1 ? segs : segs.map((s) => ({ ...s, v: s.v * factor }));
}

export function staticTolerance(setpointInWc: number): number {
  return Math.max(STATIC_BAND_INWC, STATIC_BAND_FRACTION * Math.abs(setpointInWc));
}

/** Q10. */
export function staticTracksSetpoint(units: EquipmentUnit[], ctx: AnalysisContext): QuestionAnalysis {
  const findings: RawFinding[] = [];
  const skipped: QuestionAnalysis["skipped"] = [];
  const rows: BandRow[] = [];

  for (const unit of units) {
    const sp = pick(unit, ["duct_static_pressure_sp"], ctx);
    const pv = pick(unit, ["duct_static_pressure"], ctx);
    const fan = pick(unit, ["supply_fan_status"], ctx);
    if (pv === null || sp === null || fan === null) {
      skipped.push({ name: unit.name, reason: "duct static, static setpoint or fan status not usable" });
      continue;
    }
    const slices = align([toInWc(pv, held(pv, ctx.range)), toInWc(sp, held(sp, ctx.range))], fanJudged(fan, ctx));
    const judgedMs = slicesMs(slices);
    if (judgedMs === 0) {
      skipped.push({ name: unit.name, reason: "fan never ran long enough to judge duct static" });
      continue;
    }
    const outSlices = slices.filter((s) => Math.abs(s.values[0]! - s.values[1]!) > staticTolerance(s.values[1]!));
    const out = slicesWhere(outSlices, () => true);
    const outMs = slicesMs(outSlices);
    const percentOut = percentOf(outMs, judgedMs);
    const avgSp = slicesMean(slices, (v) => v[1]!)!;
    rows.push({ name: unit.name, percentInBand: 100 - percentOut, band: Math.round(staticTolerance(avgSp) * 100) / 100 });

    const persisted = persists(out, ctx.timezone);
    if (out.length === 0 || !persisted.qualifies) continue;

    const lowMs = slicesMs(outSlices.filter((s) => s.values[0]! < s.values[1]!));
    const low = lowMs >= outMs / 2;
    const avgOut = slicesMean(outSlices, (v) => v[0]!)!;
    const avgSpOut = slicesMean(outSlices, (v) => v[1]!)!;
    findings.push(
      unitFinding({
        questionKey: STATIC_QUESTION,
        section: "ahu_rtu",
        unit,
        issueCode: low ? "static_below_setpoint" : "static_above_setpoint",
        issue: low ? "Duct static below setpoint" : "Duct static above setpoint",
        priority: percentOut >= ACTION_SHARE_PERCENT ? "action_needed" : "watch",
        actual: `static ${avgOut.toFixed(2)} in. w.c. vs ${avgSpOut.toFixed(2)} setpoint when off, ${percentOut}% of fan-on hours, ${onDays(persisted.days)}`,
        expected: `within ±${staticTolerance(avgSp).toFixed(2)} in. w.c. of setpoint`,
        intervals: out,
        timezone: ctx.timezone,
        percent: percentOut,
        extra: { averageStaticInWc: Math.round(avgOut * 100) / 100, averageSetpointInWc: Math.round(avgSpOut * 100) / 100, fanOnHoursJudged: hoursOf(judgedMs) },
      }),
    );
  }

  return finishBand(findings, skipped, rows);
}

interface HoursRow {
  name: string;
  hours: number;
}

/** Q11. */
export function simultaneousHeatingCooling(units: EquipmentUnit[], ctx: AnalysisContext): QuestionAnalysis {
  const findings: RawFinding[] = [];
  const skipped: QuestionAnalysis["skipped"] = [];
  const rows: HoursRow[] = [];

  for (const unit of units) {
    const heat = pickAll(unit, HEATING_ROLES, ctx);
    const cool = pickAll(unit, COOLING_ROLES, ctx);
    if (heat.length === 0 || cool.length === 0) {
      skipped.push({ name: unit.name, reason: "heating or cooling point not usable" });
      continue;
    }
    const both = intersect(anyActive(heat, ctx.range, VALVE_OPEN_PCT), anyActive(cool, ctx.range, VALVE_OPEN_PCT));
    const ms = both.reduce((s, i) => s + (i.end - i.start), 0);
    rows.push({ name: unit.name, hours: hoursOf(ms) });

    const persisted = persists(both, ctx.timezone);
    if (both.length === 0 || !persisted.qualifies) continue;

    const hours = hoursOf(ms);
    const names = (points: PointSeries[]) => points.map((p) => p.name).join(", ");
    findings.push(
      unitFinding({
        questionKey: SIMULTANEOUS_QUESTION,
        section: "ahu_rtu",
        unit,
        issueCode: "heating_and_cooling_together",
        issue: "Heating and cooling on together",
        priority: hours >= ENERGY_ACTION_HOURS ? "action_needed" : "watch",
        actual: `heating (${names(heat)}) and cooling (${names(cool)}) on together for ${hours} h, ${onDays(persisted.days)}`,
        expected: "heating and cooling never on at the same time",
        intervals: both,
        timezone: ctx.timezone,
        extra: { days: persisted.days },
      }),
    );
  }

  return finishHours(findings, skipped, rows, {});
}

/** Q12. */
export function economizerAtMinimum(units: EquipmentUnit[], ctx: AnalysisContext): QuestionAnalysis {
  const findings: RawFinding[] = [];
  const skipped: QuestionAnalysis["skipped"] = [];
  const rows: HoursRow[] = [];
  let freeCoolingMs = 0;

  for (const unit of units) {
    const damper = pick(unit, ["oa_damper_cmd"], ctx);
    const oat = pick(unit, ["outside_air_temp"], ctx, { station: true });
    const rat = pick(unit, ["return_air_temp"], ctx);
    if (damper === null || oat === null || rat === null) {
      skipped.push({ name: unit.name, reason: "OA damper, OAT or RAT not usable" });
      continue;
    }
    const celsius = celsiusIn([oat, rat]);
    if (celsius !== null) {
      skipped.push({ name: unit.name, reason: celsius });
      continue;
    }
    const cooling = pickAll(unit, COOLING_ROLES, ctx);
    if (cooling.length === 0) {
      // Without a call for cooling, an economizer at minimum in its deadband is right.
      skipped.push({ name: unit.name, reason: "no cooling valve, compressor or cooling stage trended, so a call for cooling cannot be told from deadband" });
      continue;
    }
    const fan = pick(unit, ["supply_fan_status"], ctx);
    const running = fan !== null ? onIntervals(fan, ctx.range) : openIntervals(damper, ctx.range, 0.5);
    const heating = anyActive(pickAll(unit, HEATING_ROLES, ctx), ctx.range, VALVE_OPEN_PCT);
    const calling = subtract(intersect(running, anyActive(cooling, ctx.range, VALVE_OPEN_PCT)), heating);

    // values: [damper %, oat, rat]
    const slices = align([percentSegments(damper, ctx.range), held(oat, ctx.range), held(rat, ctx.range)], normalise(calling));
    const available = slices.filter((s) => s.values[1]! <= Math.min(ECON_HIGH_LIMIT_F, s.values[2]! - ECON_DIFFERENTIAL_F));
    const availableMs = slicesMs(available);
    freeCoolingMs += availableMs;
    const atMinSlices = available.filter((s) => s.values[0]! <= ECON_MIN_POSITION_PCT);
    const atMin = slicesWhere(atMinSlices, () => true);
    const atMinMs = slicesMs(atMinSlices);
    rows.push({ name: unit.name, hours: hoursOf(atMinMs) });

    const persisted = persists(atMin, ctx.timezone);
    if (atMin.length === 0 || !persisted.qualifies) continue;

    const hours = hoursOf(atMinMs);
    findings.push(
      unitFinding({
        questionKey: ECONOMIZER_QUESTION,
        section: "ahu_rtu",
        unit,
        issueCode: "economizer_at_minimum",
        issue: "Economizer shut with free cooling available",
        priority: hours >= ENERGY_ACTION_HOURS ? "action_needed" : "watch",
        actual: `OA damper at ${Math.round(slicesMean(atMinSlices, (v) => v[0]!)!)}% with OAT ${fmtF(slicesMean(atMinSlices, (v) => v[1]!)!)} vs RAT ${fmtF(slicesMean(atMinSlices, (v) => v[2]!)!)} while cooling ran, for ${hours} h (${percentOf(atMinMs, availableMs)}% of the free-cooling hours), ${onDays(persisted.days)}`,
        expected: `OA damper above its ${ECON_MIN_POSITION_PCT}% minimum while OAT is at least ${ECON_DIFFERENTIAL_F} °F below RAT and under ${ECON_HIGH_LIMIT_F} °F`,
        intervals: atMin,
        timezone: ctx.timezone,
        percent: percentOf(atMinMs, availableMs),
        extra: { freeCoolingHours: hoursOf(availableMs) },
      }),
    );
  }

  return finishHours(findings, skipped, rows, { freeCoolingHours: hoursOf(freeCoolingMs) });
}

function finishBand(findings: RawFinding[], skipped: QuestionAnalysis["skipped"], rows: BandRow[]): QuestionAnalysis {
  findings.sort((a, b) => (b.evidence.percent ?? 0) - (a.evidence.percent ?? 0) || a.subjectName.localeCompare(b.subjectName));
  const lowest = worstOf(rows, (r) => -r.percentInBand);
  return {
    findings,
    skipped,
    metrics: { judged: rows.length, units: rows, lowest: lowest === null ? null : { name: lowest.name, percentInBand: lowest.percentInBand } },
  };
}

function finishHours(findings: RawFinding[], skipped: QuestionAnalysis["skipped"], rows: HoursRow[], extra: Record<string, unknown>): QuestionAnalysis {
  findings.sort((a, b) => ((b.evidence.hours as number) ?? 0) - ((a.evidence.hours as number) ?? 0) || a.subjectName.localeCompare(b.subjectName));
  const worst = worstOf(rows, (r) => r.hours);
  return { findings, skipped, metrics: { judged: rows.length, units: rows, worst: worst === null ? null : { name: worst.name, hours: worst.hours }, ...extra } };
}
