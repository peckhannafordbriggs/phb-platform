import { afterFirst, align, normalise, slicesMean, slicesMs, slicesWhere } from "../series";
import type { EquipmentUnit, Interval, PointSeries, RawFinding } from "../types";
import {
  anyActive,
  celsiusIn,
  fmtDeltaF,
  fmtF,
  held,
  hoursOf,
  onDays,
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
  COMPRESSOR_SETTLE_MS,
  DX_FAULT_DROP_F,
  DX_MIN_DROP_F,
  ECON_MIN_POSITION_PCT,
  ECON_OAT_F,
  ENERGY_ACTION_HOURS,
  HEAT_FAULT_RISE_F,
  HEAT_MIN_RISE_F,
  HEAT_SETTLE_MS,
  MAX_STARTS_PER_HOUR,
  SHORT_CYCLE_ACTION_DAYS,
  SHORT_CYCLE_MAX_INTERVAL_S,
  STARTS_WINDOW_MS,
  VALVE_OPEN_PCT,
} from "./thresholds";

/**
 * Questions 15-18, DX Cooling and Heat Stages (Reports, Phase 5).
 *
 *   q15  Are compressors short cycling (more than 4 starts per hour on any
 *        stage)?
 *   q16  With compressors running 15 minutes or more, did DAT drop at least
 *        15°F below return or mixed air? Under 10°F points to low charge, a
 *        failed compressor, or a dirty coil.
 *   q17  Did compressors run while OAT was below 55°F with the economizer at
 *        minimum?
 *   q18  With heat stages on 10 minutes or more, did DAT rise at least 20°F
 *        above return or mixed air?
 *
 * Starts are counted from the held series, so they need the readings that
 * show them: a start is an off segment followed directly by an on one (a
 * gap between them is not a start - nothing says when it happened). A
 * staged command trended as a number (0, 1, 2) is read as that many stages,
 * and every stage is counted on its own: "on any stage". Q16 and Q18 compare
 * DAT with mixed air when it is trended and covered, else return air -
 * mixed air is what the coil actually sees.
 *
 * The template's DX table (Unit | starts/hr peak | avg DAT drop | avg DAT
 * rise) is drawn from the three questions' `units` metrics.
 */

export const SHORT_CYCLE_QUESTION = "q15_compressor_short_cycling";
export const DX_DELTA_QUESTION = "q16_dx_cooling_delta";
export const DX_ECONOMIZER_QUESTION = "q17_compressors_during_economizer";
export const HEAT_DELTA_QUESTION = "q18_heat_stage_delta";

const DAT_ROLES = ["supply_air_temp", "discharge_air_temp"];
const ENTERING_ROLES = ["mixed_air_temp", "return_air_temp"];
/** The spec's "compressor status" requirement (Q16, Q17). */
export const COMPRESSOR_ROLES: readonly string[] = ["compressor_status", "compressor_cmd"];

/**
 * The points Q15 counts starts on, in the spec's order of preference: a
 * compressor's own status (what actually ran), else its command, else the
 * unit's cooling stage command. One family, not a mix: a unit trending both
 * status and command for one compressor would otherwise count it twice.
 */
function stagePoints(unit: EquipmentUnit, ctx: AnalysisContext): PointSeries[] {
  for (const role of ["compressor_status", "compressor_cmd", "cooling_stage_cmd"]) {
    const points = pickAll(unit, [role], ctx);
    if (points.length > 0) return points;
  }
  return [];
}

/** Why a point's readings cannot show its starts, or null when they can. */
export function cannotCountStarts(p: PointSeries): string | null {
  if (p.bucketMs !== null) return `${p.name} readings were averaged into buckets`;
  if (p.intervalS !== null && p.intervalS > SHORT_CYCLE_MAX_INTERVAL_S) {
    return `${p.name} is trended every ${Math.round(p.intervalS / 60)} min, too coarse to count starts`;
  }
  return null;
}

/** The instants each stage of a point started: off directly followed by on. Stage k is on at a value of k or more. */
export function stageStarts(p: PointSeries, range: Interval): Array<{ stage: number; starts: number[] }> {
  const segs = held(p, range);
  const top = Math.max(1, ...segs.map((s) => Math.round(s.v)));
  const out: Array<{ stage: number; starts: number[] }> = [];
  for (let k = 1; k <= top; k += 1) {
    const threshold = k - 0.5;
    const starts: number[] = [];
    for (let i = 1; i < segs.length; i += 1) {
      const prev = segs[i - 1]!;
      const cur = segs[i]!;
      if (prev.end === cur.start && prev.v < threshold && cur.v >= threshold) starts.push(cur.start);
    }
    out.push({ stage: k, starts });
  }
  return out;
}

/** The most starts in any sliding hour, and the hours (as intervals) that held more than the limit. */
export function slidingStarts(starts: number[], range: Interval): { peak: number; over: Interval[] } {
  let peak = 0;
  const over: Interval[] = [];
  let j = 0;
  for (let i = 0; i < starts.length; i += 1) {
    while (j < starts.length && starts[j]! < starts[i]! + STARTS_WINDOW_MS) j += 1;
    const count = j - i;
    peak = Math.max(peak, count);
    if (count > MAX_STARTS_PER_HOUR) over.push({ start: starts[i]!, end: Math.min(starts[i]! + STARTS_WINDOW_MS, range.end) });
  }
  return { peak, over: normalise(over) };
}

/** Q15. */
export function compressorShortCycling(units: EquipmentUnit[], ctx: AnalysisContext): QuestionAnalysis {
  const findings: RawFinding[] = [];
  const skipped: QuestionAnalysis["skipped"] = [];
  const rows: Array<{ name: string; peakStartsPerHour: number }> = [];

  for (const unit of units) {
    const points = stagePoints(unit, ctx);
    const usable = points.filter((p) => cannotCountStarts(p) === null);
    if (usable.length === 0) {
      skipped.push({ name: unit.name, reason: points.map(cannotCountStarts).filter((r) => r !== null).join("; ") || "compressor status or stage command not usable" });
      continue;
    }
    let peak = 0;
    let peakStage = "";
    let total = 0;
    const over: Interval[] = [];
    for (const p of usable) {
      for (const { stage, starts } of stageStarts(p, ctx.range)) {
        total += starts.length;
        const s = slidingStarts(starts, ctx.range);
        over.push(...s.over);
        if (s.peak > peak) {
          peak = s.peak;
          peakStage = stage === 1 && p.samples.every((x) => x.v <= 1) ? p.name : `${p.name} stage ${stage}`;
        }
      }
    }
    rows.push({ name: unit.name, peakStartsPerHour: peak });
    const cycling = normalise(over);
    const persisted = persists(cycling, ctx.timezone);
    if (cycling.length === 0 || !persisted.qualifies) continue;

    findings.push(
      unitFinding({
        questionKey: SHORT_CYCLE_QUESTION,
        section: "dx",
        unit,
        issueCode: "short_cycling",
        issue: "Compressor short cycling",
        priority: persisted.days >= SHORT_CYCLE_ACTION_DAYS ? "action_needed" : "watch",
        actual: `${peak} starts in one hour on ${peakStage}, more than ${MAX_STARTS_PER_HOUR} an hour for ${hoursOf(persisted.totalMs)} h, ${onDays(persisted.days)}`,
        expected: `no more than ${MAX_STARTS_PER_HOUR} starts per hour on any stage`,
        intervals: cycling,
        timezone: ctx.timezone,
        extra: { peakStartsPerHour: peak, peakStage, startsInPeriod: total, days: persisted.days },
      }),
    );
  }

  findings.sort((a, b) => ((b.evidence.peakStartsPerHour as number) ?? 0) - ((a.evidence.peakStartsPerHour as number) ?? 0) || a.subjectName.localeCompare(b.subjectName));
  const worst = worstOf(rows, (r) => r.peakStartsPerHour);
  return { findings, skipped, metrics: { judged: rows.length, units: rows, peak: worst === null ? null : { name: worst.name, startsPerHour: worst.peakStartsPerHour } } };
}

interface DeltaSpec {
  questionKey: string;
  /** Roles whose being on starts the clock. */
  onRoles: readonly string[];
  settleMs: number;
  /** DAT relative to entering air: drop for cooling, rise for heat. */
  delta: (dat: number, entering: number) => number;
  min: number;
  fault: number;
  word: "drop" | "rise";
  running: string;
}

const COOLING_DELTA: DeltaSpec = {
  questionKey: DX_DELTA_QUESTION,
  onRoles: COMPRESSOR_ROLES,
  settleMs: COMPRESSOR_SETTLE_MS,
  delta: (dat, entering) => entering - dat,
  min: DX_MIN_DROP_F,
  fault: DX_FAULT_DROP_F,
  word: "drop",
  running: "compressors on 15 min or more",
};

const HEAT_DELTA: DeltaSpec = {
  questionKey: HEAT_DELTA_QUESTION,
  onRoles: ["heating_stage_cmd"],
  settleMs: HEAT_SETTLE_MS,
  delta: (dat, entering) => dat - entering,
  min: HEAT_MIN_RISE_F,
  fault: HEAT_FAULT_RISE_F,
  word: "rise",
  running: "heat stages on 10 min or more",
};

/** Q16. */
export function dxCoolingDelta(units: EquipmentUnit[], ctx: AnalysisContext): QuestionAnalysis {
  return deltaQuestion(COOLING_DELTA, units, ctx);
}

/** Q18. */
export function heatStageDelta(units: EquipmentUnit[], ctx: AnalysisContext): QuestionAnalysis {
  return deltaQuestion(HEAT_DELTA, units, ctx);
}

function deltaQuestion(spec: DeltaSpec, units: EquipmentUnit[], ctx: AnalysisContext): QuestionAnalysis {
  const findings: RawFinding[] = [];
  const skipped: QuestionAnalysis["skipped"] = [];
  const rows: Array<{ name: string; average: number; hoursJudged: number }> = [];

  for (const unit of units) {
    const on = pickAll(unit, spec.onRoles, ctx);
    const dat = pick(unit, DAT_ROLES, ctx);
    const entering = pick(unit, ENTERING_ROLES, ctx);
    if (on.length === 0 || dat === null || entering === null) {
      skipped.push({ name: unit.name, reason: `${spec.word === "drop" ? "compressor status" : "heat stage status"}, DAT or RAT/MAT not usable` });
      continue;
    }
    const celsius = celsiusIn([dat, entering]);
    if (celsius !== null) {
      skipped.push({ name: unit.name, reason: celsius });
      continue;
    }
    const judged = afterFirst(anyActive(on, ctx.range, VALVE_OPEN_PCT), spec.settleMs);
    const slices = align([held(dat, ctx.range), held(entering, ctx.range)], judged);
    const judgedMs = slicesMs(slices);
    if (judgedMs === 0) {
      skipped.push({ name: unit.name, reason: `never ran with ${spec.running}` });
      continue;
    }
    const avg = slicesMean(slices, (v) => spec.delta(v[0]!, v[1]!))!;
    rows.push({ name: unit.name, average: round1(avg), hoursJudged: hoursOf(judgedMs) });

    const shortSlices = slices.filter((s) => spec.delta(s.values[0]!, s.values[1]!) < spec.min);
    const short = slicesWhere(shortSlices, () => true);
    const persisted = persists(short, ctx.timezone);
    if (avg >= spec.min || short.length === 0 || !persisted.qualifies) continue;

    const fault = avg < spec.fault;
    const enteringLabel = entering.role === "mixed_air_temp" ? "mixed air" : "return air";
    findings.push(
      unitFinding({
        questionKey: spec.questionKey,
        section: "dx",
        unit,
        issueCode: spec.word === "drop" ? (fault ? "dx_drop_fault" : "dx_drop_low") : fault ? "heat_rise_fault" : "heat_rise_low",
        issue:
          spec.word === "drop"
            ? `Cooling drop under ${fault ? spec.fault : spec.min} °F`
            : `Heating rise under ${fault ? spec.fault : spec.min} °F`,
        priority: fault ? "action_needed" : "watch",
        actual: `DAT ${spec.word} averaged ${fmtDeltaF(avg)} ${spec.word === "drop" ? "below" : "above"} ${enteringLabel} (${dat.name} vs ${entering.name}) with ${spec.running}, over ${hoursOf(judgedMs)} h`,
        expected: `a ${spec.word} of at least ${spec.min} °F`,
        intervals: short,
        timezone: ctx.timezone,
        extra: {
          averageF: round1(avg),
          hoursJudged: hoursOf(judgedMs),
          // The spec's own list, for the narrative to word as likely, never as fact.
          ...(spec.word === "drop" && fault ? { specCauses: "low charge, a failed compressor, or a dirty coil" } : {}),
        },
      }),
    );
  }

  findings.sort((a, b) => ((a.evidence.averageF as number) ?? 0) - ((b.evidence.averageF as number) ?? 0) || a.subjectName.localeCompare(b.subjectName));
  const lowest = worstOf(rows, (r) => -r.average);
  return {
    findings,
    skipped,
    metrics: { judged: rows.length, units: rows, lowest: lowest === null ? null : { name: lowest.name, averageF: lowest.average }, minimumF: spec.min },
  };
}

/** Q17. */
export function compressorsDuringEconomizer(units: EquipmentUnit[], ctx: AnalysisContext): QuestionAnalysis {
  const findings: RawFinding[] = [];
  const skipped: QuestionAnalysis["skipped"] = [];
  const rows: Array<{ name: string; hours: number }> = [];

  for (const unit of units) {
    const compressors = pickAll(unit, COMPRESSOR_ROLES, ctx);
    const oat = pick(unit, ["outside_air_temp"], ctx, { station: true });
    const damper = pick(unit, ["oa_damper_cmd"], ctx);
    if (compressors.length === 0 || oat === null || damper === null) {
      skipped.push({ name: unit.name, reason: "compressor status, OAT or OA damper not usable" });
      continue;
    }
    const celsius = celsiusIn([oat]);
    if (celsius !== null) {
      skipped.push({ name: unit.name, reason: celsius });
      continue;
    }
    const running = anyActive(compressors, ctx.range, VALVE_OPEN_PCT);
    // values: [damper %, oat]
    const slices = align([percentSegments(damper, ctx.range), held(oat, ctx.range)], running);
    const wrong = slices.filter((s) => s.values[1]! < ECON_OAT_F && s.values[0]! <= ECON_MIN_POSITION_PCT);
    const intervals = slicesWhere(wrong, () => true);
    const wrongMs = slicesMs(wrong);
    rows.push({ name: unit.name, hours: hoursOf(wrongMs) });

    const persisted = persists(intervals, ctx.timezone);
    if (intervals.length === 0 || !persisted.qualifies) continue;
    const hours = hoursOf(wrongMs);
    findings.push(
      unitFinding({
        questionKey: DX_ECONOMIZER_QUESTION,
        section: "dx",
        unit,
        issueCode: "compressors_with_economizer_closed",
        issue: "Compressors on with free cooling outside",
        priority: hours >= ENERGY_ACTION_HOURS ? "action_needed" : "watch",
        actual: `compressors on with OAT averaging ${fmtF(slicesMean(wrong, (v) => v[1]!)!)} and the OA damper at ${Math.round(slicesMean(wrong, (v) => v[0]!)!)}%, for ${hours} h, ${onDays(persisted.days)}`,
        expected: `below ${ECON_OAT_F} °F outside, the economizer open past its ${ECON_MIN_POSITION_PCT}% minimum before compressors run`,
        intervals,
        timezone: ctx.timezone,
        extra: { days: persisted.days, compressorHoursJudged: hoursOf(slicesMs(slices)) },
      }),
    );
  }

  findings.sort((a, b) => ((b.evidence.hours as number) ?? 0) - ((a.evidence.hours as number) ?? 0) || a.subjectName.localeCompare(b.subjectName));
  const worst = worstOf(rows, (r) => r.hours);
  return { findings, skipped, metrics: { judged: rows.length, units: rows, worst: worst === null ? null : { name: worst.name, hours: worst.hours } } };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
