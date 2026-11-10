import {
  HOUR_MS,
  busiestWindow,
  daysTouched,
  describeDuration,
  holdMsFor,
  hourOfDayProfile,
  intersect,
  known,
  persistence,
  segments,
  subtract,
  totalMs,
  whereTrue,
} from "../series";
import type { EquipmentUnit, Interval, RawFinding, ScheduleResult } from "../types";

/**
 * Question 19, Schedules (Reports, Phase 2): "What equipment ran outside its
 * occupancy schedule, and for how many hours?"
 *
 * For each unit with a status point, the hours its status read "running"
 * while the building was unoccupied, and on how many days. Unoccupied means
 * the known hours minus the occupied ones - time the occupancy source could
 * not speak for is neither. A unit qualifies under the spec's persistence
 * rule (a stretch of 30 minutes, or two days); below ACTION_HOURS it is
 * Watch, at or above it Action Needed, because twenty hours of a fan running
 * to an empty building in a week is the "major energy waste" the spec's
 * status words name.
 */

export const SCHEDULES_QUESTION = "q19_run_outside_schedule";
export const STATUS_ROLES: readonly string[] = [
  "supply_fan_status",
  "return_fan_status",
  "exhaust_fan_status",
  "pump_status",
  "chiller_status",
  "boiler_status",
  "compressor_status",
  "tower_fan_status",
];
export const ACTION_HOURS = 20;

export interface SchedulesResult {
  results: ScheduleResult[];
  findings: RawFinding[];
  judged: number;
}

export function runOutsideSchedule(
  units: EquipmentUnit[],
  occupied: Interval[],
  range: Interval,
  timezone: string,
  excluded: Set<string>,
): SchedulesResult {
  const results: ScheduleResult[] = [];
  const findings: RawFinding[] = [];
  let judged = 0;

  for (const unit of units) {
    const status = unit.points.find((p) => p.role !== null && STATUS_ROLES.includes(p.role) && !excluded.has(p.pointId));
    if (status === undefined) continue;
    judged += 1;

    const segs = segments(status, range, holdMsFor(status));
    const running = whereTrue(segs, (v) => v >= 0.5);
    const unoccupiedKnown = subtract(known(segs), occupied);
    const outside = intersect(running, unoccupiedKnown);
    const hours = Math.round((totalMs(outside) / HOUR_MS) * 10) / 10;
    const days = daysTouched(outside, timezone).size;

    results.push({ equipmentId: unit.equipmentId, name: unit.name, statusPoint: status.name, hoursOutside: hours, days });

    const persisted = persistence(outside, timezone);
    if (outside.length === 0 || !persisted.qualifies) continue;

    findings.push({
      questionKey: SCHEDULES_QUESTION,
      section: "schedules",
      subjectKey: `equipment:${unit.equipmentId}`,
      equipmentId: unit.equipmentId,
      subjectName: unit.name,
      issueCode: "ran_unoccupied",
      issue: "Ran outside occupied hours",
      priority: hours >= ACTION_HOURS ? "action_needed" : "watch",
      evidence: {
        actual: `${status.name} on for ${describeDuration(totalMs(outside))} while unoccupied, on ${days} day${days === 1 ? "" : "s"}`,
        expected: "off outside occupied hours",
        duration: describeDuration(totalMs(outside)),
        durationMs: totalMs(outside),
        when: busiestWindow(hourOfDayProfile(outside, timezone)) ?? "across the day",
        hoursOutside: hours,
        days,
      },
    });
  }

  results.sort((a, b) => b.hoursOutside - a.hoursOutside || a.name.localeCompare(b.name));
  findings.sort((a, b) => ((b.evidence.hoursOutside as number) ?? 0) - ((a.evidence.hoursOutside as number) ?? 0));
  return { results, findings, judged };
}
