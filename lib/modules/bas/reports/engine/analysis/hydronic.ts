import type { LibrarySection } from "../../library";
import { align, slicesMean, slicesMs, slicesWhere, type Slice } from "../series";
import type { EquipmentUnit, RawFinding } from "../types";
import {
  anyActive,
  celsiusIn,
  fmtDeltaF,
  fmtF,
  held,
  hoursOf,
  onDays,
  percentOf,
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
  CHW_MIN_DELTA_T_F,
  CHWS_BAND_F,
  HW_MIN_DELTA_T_F,
  HWS_BAND_F,
  LOOP_IN_SERVICE_DELTA_F,
  VALVE_OPEN_PCT,
} from "./thresholds";

/**
 * Questions 13 and 14, Hot Water and Chilled Water (Reports, Phase 5).
 *
 *   q13  Did HW supply temp hold setpoint or reset, and was delta T at least
 *        10°F?
 *   q14  Did CHW supply temp hold setpoint, and was delta T at least 8°F?
 *
 * One function, two loops. The setpoint point is the ACTIVE setpoint, which
 * is the reset value wherever the controller resets it - so "setpoint or
 * reset" is one comparison. Judged only while the loop is in service (see
 * LOOP_IN_SERVICE_DELTA_F in thresholds.ts): a plant off for the season is
 * not missing a setpoint it is not trying to meet.
 *
 * Two findings are possible per loop, kept apart because they have
 * different causes and different urgency: supply off setpoint (Watch, Action
 * Needed past half the in-service hours - the building cannot be heated or
 * cooled), and low delta T (Watch only: the spec's "minor efficiency loss").
 *
 * The template's headline line ("HWS on target: x% | Avg delta T: x°F") is
 * the metrics' `onTargetPercent` and `averageDeltaT`, time-weighted over
 * every in-service hour of every loop judged.
 */

export const HW_QUESTION = "q13_hw_supply_and_delta_t";
export const CHW_QUESTION = "q14_chw_supply_and_delta_t";

interface LoopSpec {
  questionKey: string;
  section: LibrarySection;
  label: "HWS" | "CHWS";
  supply: string;
  ret: string;
  setpoint: string;
  status: readonly string[];
  band: number;
  minDelta: number;
  /** Delta T from [supply, return]: positive when the loop is doing its job. */
  delta: (supply: number, ret: number) => number;
}

const HW: LoopSpec = {
  questionKey: HW_QUESTION,
  section: "hot_water",
  label: "HWS",
  supply: "hw_supply_temp",
  ret: "hw_return_temp",
  setpoint: "hw_supply_temp_sp",
  status: ["boiler_status", "pump_status"],
  band: HWS_BAND_F,
  minDelta: HW_MIN_DELTA_T_F,
  delta: (s, r) => s - r,
};

const CHW: LoopSpec = {
  questionKey: CHW_QUESTION,
  section: "chilled_water",
  label: "CHWS",
  supply: "chw_supply_temp",
  ret: "chw_return_temp",
  setpoint: "chw_supply_temp_sp",
  status: ["chiller_status", "pump_status"],
  band: CHWS_BAND_F,
  minDelta: CHW_MIN_DELTA_T_F,
  delta: (s, r) => r - s,
};

interface LoopRow {
  name: string;
  onTargetPercent: number;
  averageDeltaT: number;
  inServiceHours: number;
}

export function hotWaterLoop(units: EquipmentUnit[], ctx: AnalysisContext): QuestionAnalysis {
  return loop(HW, units, ctx);
}

export function chilledWaterLoop(units: EquipmentUnit[], ctx: AnalysisContext): QuestionAnalysis {
  return loop(CHW, units, ctx);
}

function loop(spec: LoopSpec, units: EquipmentUnit[], ctx: AnalysisContext): QuestionAnalysis {
  const findings: RawFinding[] = [];
  const skipped: QuestionAnalysis["skipped"] = [];
  const rows: LoopRow[] = [];
  const all: Slice[] = [];

  for (const unit of units) {
    const supply = pick(unit, [spec.supply], ctx);
    const ret = pick(unit, [spec.ret], ctx);
    const sp = pick(unit, [spec.setpoint], ctx);
    if (supply === null || ret === null || sp === null) {
      skipped.push({ name: unit.name, reason: `${spec.label} temp, return temp or setpoint not usable` });
      continue;
    }
    const celsius = celsiusIn([supply, ret, sp]);
    if (celsius !== null) {
      skipped.push({ name: unit.name, reason: celsius });
      continue;
    }
    // In service: the plant's own status where trended, else water moving through it.
    const status = pickAll(unit, spec.status, ctx);
    const within = status.length > 0 ? anyActive(status, ctx.range, VALVE_OPEN_PCT) : [ctx.range];
    let slices = align([held(supply, ctx.range), held(ret, ctx.range), held(sp, ctx.range)], within);
    if (status.length === 0) slices = slices.filter((s) => Math.abs(s.values[0]! - s.values[1]!) >= LOOP_IN_SERVICE_DELTA_F);
    const judgedMs = slicesMs(slices);
    if (judgedMs === 0) {
      skipped.push({ name: unit.name, reason: status.length > 0 ? "plant never ran in the period" : "loop never in service in the period" });
      continue;
    }
    all.push(...slices);

    const offSlices = slices.filter((s) => Math.abs(s.values[0]! - s.values[2]!) > spec.band);
    const offMs = slicesMs(offSlices);
    const onTarget = 100 - percentOf(offMs, judgedMs);
    const avgDelta = slicesMean(slices, (v) => spec.delta(v[0]!, v[1]!))!;
    rows.push({ name: unit.name, onTargetPercent: onTarget, averageDeltaT: round1(avgDelta), inServiceHours: hoursOf(judgedMs) });

    const off = slicesWhere(offSlices, () => true);
    const offPersisted = persists(off, ctx.timezone);
    if (off.length > 0 && offPersisted.qualifies) {
      const lowMs = slicesMs(offSlices.filter((s) => s.values[0]! < s.values[2]!));
      const below = lowMs >= offMs / 2;
      const percentOff = percentOf(offMs, judgedMs);
      findings.push(
        unitFinding({
          questionKey: spec.questionKey,
          section: spec.section,
          unit,
          issueCode: below ? "supply_below_setpoint" : "supply_above_setpoint",
          issue: `${spec.label} ${below ? "below" : "above"} setpoint`,
          priority: percentOff >= ACTION_SHARE_PERCENT ? "action_needed" : "watch",
          actual: `${supply.name} averaged ${fmtF(slicesMean(offSlices, (v) => v[0]!)!)} vs ${fmtF(slicesMean(offSlices, (v) => v[2]!)!)} setpoint when off target, ${percentOff}% of in-service hours, ${onDays(offPersisted.days)}`,
          expected: `within ±${spec.band} °F of setpoint`,
          intervals: off,
          timezone: ctx.timezone,
          percent: percentOff,
          extra: { inServiceHours: hoursOf(judgedMs) },
        }),
      );
    }

    const lowSlices = slices.filter((s) => spec.delta(s.values[0]!, s.values[1]!) < spec.minDelta);
    const low = slicesWhere(lowSlices, () => true);
    const lowPersisted = persists(low, ctx.timezone);
    if (avgDelta < spec.minDelta && low.length > 0 && lowPersisted.qualifies) {
      const percentLow = percentOf(slicesMs(lowSlices), judgedMs);
      findings.push(
        unitFinding({
          questionKey: spec.questionKey,
          section: spec.section,
          unit,
          issueCode: "low_delta_t",
          issue: "Low delta T",
          priority: "watch",
          actual: `delta T averaged ${fmtDeltaF(avgDelta)}, under ${spec.minDelta} °F for ${percentLow}% of in-service hours`,
          expected: `delta T of at least ${spec.minDelta} °F`,
          intervals: low,
          timezone: ctx.timezone,
          percent: percentLow,
          extra: { averageDeltaT: round1(avgDelta), inServiceHours: hoursOf(judgedMs) },
        }),
      );
    }
  }

  findings.sort((a, b) => (b.priority === "action_needed" ? 1 : 0) - (a.priority === "action_needed" ? 1 : 0) || a.subjectName.localeCompare(b.subjectName));
  const allMs = slicesMs(all);
  const offAll = slicesMs(all.filter((s) => {
    const sp = s.values[2]!;
    return Math.abs(s.values[0]! - sp) > spec.band;
  }));
  const worst = worstOf(rows, (r) => -r.onTargetPercent);
  return {
    findings,
    skipped,
    metrics: {
      judged: rows.length,
      loops: rows,
      label: spec.label,
      onTargetPercent: allMs === 0 ? null : 100 - percentOf(offAll, allMs),
      averageDeltaT: allMs === 0 ? null : round1(slicesMean(all, (v) => spec.delta(v[0]!, v[1]!))!),
      minDeltaT: spec.minDelta,
      lowest: worst === null ? null : { name: worst.name, onTargetPercent: worst.onTargetPercent },
    },
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
