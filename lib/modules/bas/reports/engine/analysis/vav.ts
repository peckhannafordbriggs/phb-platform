import { intersect, slicesMean, slicesMs, slicesWhere, align, type Slice } from "../series";
import type { EquipmentUnit, RawFinding } from "../types";
import {
  celsiusIn,
  fmtF,
  fmtNumber,
  held,
  hoursOf,
  onDays,
  percentOf,
  percentSegments,
  persists,
  pick,
  unitFinding,
  worstOf,
  type AnalysisContext,
  type QuestionAnalysis,
} from "./common";
import {
  ABOVE_COOLING_MARGIN_F,
  ACTION_SHARE_PERCENT,
  AIRFLOW_FRACTION,
  DAMPER_FULL_PCT,
  ENERGY_ACTION_HOURS,
  MISSED_SETPOINT_F,
  VALVE_OPEN_PCT,
} from "./thresholds";

/**
 * Questions 6-8, VAV Terminal Units (Reports, Phase 5).
 *
 *   q06  Which VAVs ran below 80% of airflow setpoint while occupied?
 *   q07  Which VAVs sat at 100% damper and still missed setpoint?
 *   q08  Which reheat valves were open while the zone was above cooling
 *        setpoint?
 *
 * Occupied hours: Q6 says "while occupied" and requires occupancy, so it
 * judges occupied hours only. Q7 compares a zone with its setpoint, which
 * is comfort, and the spec judges comfort during occupied hours only - so
 * it judges occupied hours where the station has an occupancy source, and
 * every hour where it has none (its required points do not include
 * occupancy), and its metrics say which. Q8 is energy waste - heating a
 * room that is asking for cooling - which is wrong at any hour, so it
 * judges the whole period.
 */

export const VAV_AIRFLOW_QUESTION = "q06_vav_starved_airflow";
export const VAV_DAMPER_QUESTION = "q07_vav_damper_full_missed_setpoint";
export const VAV_REHEAT_QUESTION = "q08_reheat_open_above_cooling_sp";

interface UnitRow {
  name: string;
  hours: number;
  percent: number;
}

/** Q6. */
export function vavStarvedAirflow(units: EquipmentUnit[], ctx: AnalysisContext): QuestionAnalysis {
  const findings: RawFinding[] = [];
  const skipped: QuestionAnalysis["skipped"] = [];
  const rows: UnitRow[] = [];

  for (const unit of units) {
    const flow = pick(unit, ["supply_air_flow"], ctx);
    const sp = pick(unit, ["supply_air_flow_sp"], ctx);
    if (flow === null || sp === null) {
      skipped.push({ name: unit.name, reason: "airflow or airflow setpoint not usable" });
      continue;
    }
    const occupied = ctx.occupiedFor(unit);
    if (occupied === null) {
      skipped.push({ name: unit.name, reason: "no occupancy source" });
      continue;
    }
    const slices = align([held(flow, ctx.range), held(sp, ctx.range)], intersect(occupied, [ctx.range]));
    const judgedMs = slicesMs(slices);
    if (judgedMs === 0) {
      skipped.push({ name: unit.name, reason: "no occupied hours with airflow and setpoint both known" });
      continue;
    }
    const starved = (v: number[]) => v[1]! > 0 && v[0]! < AIRFLOW_FRACTION * v[1]!;
    const short = slices.filter((s) => starved(s.values));
    const below = slicesWhere(slices, starved);
    const belowMs = slicesMs(short);
    const percent = percentOf(belowMs, judgedMs);
    rows.push({ name: unit.name, hours: hoursOf(belowMs), percent });

    const persisted = persists(below, ctx.timezone);
    if (below.length === 0 || !persisted.qualifies) continue;

    const avgFlow = slicesMean(short, (v) => v[0]!)!;
    const avgSp = slicesMean(short, (v) => v[1]!)!;
    findings.push(
      unitFinding({
        questionKey: VAV_AIRFLOW_QUESTION,
        section: "vav",
        unit,
        issueCode: "starved_airflow",
        issue: "Starved for air",
        priority: percent >= ACTION_SHARE_PERCENT ? "action_needed" : "watch",
        actual: `airflow ${fmtNumber(avgFlow, flow.unit)} vs ${fmtNumber(avgSp, sp.unit)} setpoint when short (${Math.round((avgFlow / avgSp) * 100)}% of setpoint), ${percent}% of occupied hours, ${onDays(persisted.days)}`,
        expected: `at least ${Math.round(AIRFLOW_FRACTION * 100)}% of airflow setpoint`,
        intervals: below,
        timezone: ctx.timezone,
        percent,
        extra: { averageAirflow: round1(avgFlow), averageSetpoint: round1(avgSp), occupiedHoursJudged: hoursOf(judgedMs) },
      }),
    );
  }

  return finish(findings, skipped, rows, {});
}

/** The zone's setpoint as one or two series, and the deviation outside the band at one instant. */
function zoneSetpoint(unit: EquipmentUnit, ctx: AnalysisContext) {
  const single = pick(unit, ["zone_temp_sp"], ctx);
  if (single !== null) {
    return {
      points: [single],
      lists: [held(single, ctx.range)],
      /** values: [temp, sp] */
      deviation: (v: number[]) => (Math.abs(v[0]! - v[1]!) <= MISSED_SETPOINT_F ? 0 : v[0]! - v[1]!),
      expected: (slices: Slice[]) => `within ±${MISSED_SETPOINT_F} °F of the ${fmtF(slicesMean(slices, (v) => v[1]!) ?? 0)} setpoint`,
    };
  }
  const heating = pick(unit, ["zone_temp_heating_sp"], ctx);
  const cooling = pick(unit, ["zone_temp_cooling_sp"], ctx);
  if (heating === null || cooling === null) return null;
  return {
    points: [heating, cooling],
    lists: [held(heating, ctx.range), held(cooling, ctx.range)],
    /** values: [temp, heating, cooling] */
    deviation: (v: number[]) =>
      v[0]! > v[2]! + MISSED_SETPOINT_F ? v[0]! - v[2]! : v[0]! < v[1]! - MISSED_SETPOINT_F ? v[0]! - v[1]! : 0,
    expected: (slices: Slice[]) =>
      `between ${fmtF((slicesMean(slices, (v) => v[1]!) ?? 0) - MISSED_SETPOINT_F)} and ${fmtF((slicesMean(slices, (v) => v[2]!) ?? 0) + MISSED_SETPOINT_F)} (the heating and cooling setpoints ±${MISSED_SETPOINT_F} °F)`,
  };
}

/** Q7. */
export function vavDamperFullMissedSetpoint(units: EquipmentUnit[], ctx: AnalysisContext): QuestionAnalysis {
  const findings: RawFinding[] = [];
  const skipped: QuestionAnalysis["skipped"] = [];
  const rows: UnitRow[] = [];
  let occupiedOnly = 0;
  let allHours = 0;

  for (const unit of units) {
    const damper = pick(unit, ["vav_damper_cmd"], ctx);
    const temp = pick(unit, ["zone_temp"], ctx);
    const setpoint = zoneSetpoint(unit, ctx);
    if (damper === null || temp === null || setpoint === null) {
      skipped.push({ name: unit.name, reason: "damper, space temp or setpoint not usable" });
      continue;
    }
    const celsius = celsiusIn([temp, ...setpoint.points]);
    if (celsius !== null) {
      skipped.push({ name: unit.name, reason: celsius });
      continue;
    }
    const occupied = ctx.occupiedFor(unit);
    const within = occupied === null ? [ctx.range] : intersect(occupied, [ctx.range]);
    const hoursWord = occupied === null ? "hours" : "occupied hours";

    // values: [damper %, temp, ...setpoint]
    const slices = align([percentSegments(damper, ctx.range), held(temp, ctx.range), ...setpoint.lists], within);
    const judgedMs = slicesMs(slices);
    if (judgedMs === 0) {
      skipped.push({ name: unit.name, reason: `no ${hoursWord} with damper, space temp and setpoint all known` });
      continue;
    }
    if (occupied === null) allHours += 1;
    else occupiedOnly += 1;
    const devOf = (v: number[]) => setpoint.deviation(v.slice(1));
    const missedSlices = slices.filter((s) => s.values[0]! >= DAMPER_FULL_PCT && devOf(s.values) !== 0);
    const missed = slicesWhere(missedSlices, () => true);
    const missedMs = slicesMs(missedSlices);
    const percent = percentOf(missedMs, judgedMs);
    rows.push({ name: unit.name, hours: hoursOf(missedMs), percent });

    const persisted = persists(missed, ctx.timezone);
    if (missed.length === 0 || !persisted.qualifies) continue;

    let maxDev = 0;
    for (const s of missedSlices) {
      const d = devOf(s.values);
      if (Math.abs(d) > Math.abs(maxDev)) maxDev = d;
    }
    const avgDamper = slicesMean(missedSlices, (v) => v[0]!)!;
    findings.push(
      unitFinding({
        questionKey: VAV_DAMPER_QUESTION,
        section: "vav",
        unit,
        issueCode: maxDev > 0 ? "damper_full_zone_warm" : "damper_full_zone_cold",
        issue: maxDev > 0 ? "Damper wide open, zone still warm" : "Damper wide open, zone still cold",
        priority: percent >= ACTION_SHARE_PERCENT ? "action_needed" : "watch",
        actual: `damper ${Math.round(avgDamper)}% with the zone up to ${Math.abs(maxDev).toFixed(1)} °F ${maxDev > 0 ? "over" : "under"} setpoint, ${percent}% of ${hoursWord}, ${onDays(persisted.days)}`,
        expected: setpoint.expected(missedSlices.map((s) => ({ ...s, values: s.values.slice(1) }))),
        intervals: missed,
        timezone: ctx.timezone,
        percent,
        extra: { averageDamperPercent: Math.round(avgDamper), maxDeviationF: Math.round(maxDev * 10) / 10, hoursJudged: hoursOf(judgedMs) },
      }),
    );
  }

  return finish(findings, skipped, rows, { hoursJudged: occupiedOnly > 0 && allHours === 0 ? "occupied" : allHours > 0 && occupiedOnly === 0 ? "all" : "mixed" });
}

/** Q8. */
export function reheatOpenAboveCoolingSetpoint(units: EquipmentUnit[], ctx: AnalysisContext): QuestionAnalysis {
  const findings: RawFinding[] = [];
  const skipped: QuestionAnalysis["skipped"] = [];
  const rows: UnitRow[] = [];

  for (const unit of units) {
    const reheat = pick(unit, ["reheat_valve_cmd"], ctx);
    const temp = pick(unit, ["zone_temp"], ctx);
    const cooling = pick(unit, ["zone_temp_cooling_sp"], ctx);
    if (reheat === null || temp === null || cooling === null) {
      skipped.push({ name: unit.name, reason: "reheat valve, space temp or cooling setpoint not usable" });
      continue;
    }
    const celsius = celsiusIn([temp, cooling]);
    if (celsius !== null) {
      skipped.push({ name: unit.name, reason: celsius });
      continue;
    }
    // values: [reheat %, temp, cooling sp]
    const slices = align([percentSegments(reheat, ctx.range), held(temp, ctx.range), held(cooling, ctx.range)], [ctx.range]);
    const judgedMs = slicesMs(slices);
    if (judgedMs === 0) {
      skipped.push({ name: unit.name, reason: "no hours with reheat, space temp and cooling setpoint all known" });
      continue;
    }
    const wrong = slices.filter((s) => s.values[0]! > VALVE_OPEN_PCT && s.values[1]! > s.values[2]! + ABOVE_COOLING_MARGIN_F);
    const intervals = slicesWhere(wrong, () => true);
    const wrongMs = slicesMs(wrong);
    rows.push({ name: unit.name, hours: hoursOf(wrongMs), percent: percentOf(wrongMs, judgedMs) });

    const persisted = persists(intervals, ctx.timezone);
    if (intervals.length === 0 || !persisted.qualifies) continue;

    const avgValve = slicesMean(wrong, (v) => v[0]!)!;
    const maxTemp = Math.max(...wrong.map((s) => s.values[1]!));
    const avgCooling = slicesMean(wrong, (v) => v[2]!)!;
    const hours = hoursOf(wrongMs);
    findings.push(
      unitFinding({
        questionKey: VAV_REHEAT_QUESTION,
        section: "vav",
        unit,
        issueCode: "reheat_against_cooling",
        issue: "Reheat open above cooling setpoint",
        priority: hours >= ENERGY_ACTION_HOURS ? "action_needed" : "watch",
        actual: `reheat valve ${Math.round(avgValve)}% open with the zone up to ${fmtF(maxTemp)}, for ${hours} h ${onDays(persisted.days)}`,
        expected: `reheat closed while the zone is above its ${fmtF(avgCooling)} cooling setpoint`,
        intervals,
        timezone: ctx.timezone,
        percent: percentOf(wrongMs, judgedMs),
        extra: { averageValvePercent: Math.round(avgValve), maxZoneTempF: Math.round(maxTemp * 10) / 10 },
      }),
    );
  }

  return finish(findings, skipped, rows, {});
}

function finish(
  findings: RawFinding[],
  skipped: QuestionAnalysis["skipped"],
  rows: UnitRow[],
  extra: Record<string, unknown>,
): QuestionAnalysis {
  findings.sort((a, b) => ((b.evidence.hours as number) ?? 0) - ((a.evidence.hours as number) ?? 0) || a.subjectName.localeCompare(b.subjectName));
  const worst = worstOf(rows, (r) => r.hours);
  return {
    findings,
    skipped,
    metrics: { judged: rows.length, units: rows, worst: worst === null ? null : { name: worst.name, hours: worst.hours, percent: worst.percent }, ...extra },
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
