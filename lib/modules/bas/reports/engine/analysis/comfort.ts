import { unitSymbol } from "../../../units";
import {
  busiestWindow,
  holdMsFor,
  hourOfDayProfile,
  intersect,
  normalise,
  persistence,
  segments,
  type Segment,
} from "../series";
import type { EquipmentUnit, Interval, RawFinding, ZoneResult } from "../types";

/**
 * Questions 3 and 4, Space Comfort (Reports, Phase 2).
 *
 *   q03  What percent of occupied hours did each zone hold within ±2°F of
 *        setpoint?
 *   q04  Which 10 zones were out of range the most, how far off, and at what
 *        times of day?
 *
 * One computation answers both: per zone, the occupied minutes where both
 * the temperature and its setpoint were known, how many of those were in
 * band, the largest deviation, and which hours of the day the misses fell
 * in. The setpoint is the active one (zone_temp_sp) or the pair: in band is
 * then from two degrees under the heating setpoint to two degrees over the
 * cooling one, and the deviation is the distance outside that.
 *
 * "Judge comfort during occupied hours only": nothing here looks at an
 * unoccupied minute. "Every finding must include actual value, expected
 * value, and duration or percent of time": the evidence carries all four
 * and the table draws from it.
 *
 * Thresholds, named so they can be argued with:
 *   BAND_F             2 - the spec's ±2°F
 *   WATCH_PERCENT     10 - out of band for a tenth of occupied hours or more
 *   ACTION_PERCENT    50 - out of band for half of occupied hours or more
 *   ACTION_DEVIATION_F 5 - or five degrees off at any point that persisted
 * A zone under WATCH_PERCENT raises no finding: it is in tolerance.
 */

export const COMFORT_QUESTION = "q03_zone_comfort";
export const WORST_ZONES_QUESTION = "q04_worst_zones";
export const BAND_F = 2;
export const WATCH_PERCENT = 10;
export const ACTION_PERCENT = 50;
export const ACTION_DEVIATION_F = 5;
export const WORST_ZONES = 10;

interface Setpoint {
  kind: "single" | "dual";
  single: Segment[] | null;
  heating: Segment[] | null;
  cooling: Segment[] | null;
}

/** The sub-intervals of [range] on which every one of `lists` has a segment, with each list's value. */
function align(lists: Segment[][], within: Interval[]): Array<{ start: number; end: number; values: number[] }> {
  const breaks = new Set<number>();
  for (const list of lists) {
    for (const s of list) {
      breaks.add(s.start);
      breaks.add(s.end);
    }
  }
  for (const i of within) {
    breaks.add(i.start);
    breaks.add(i.end);
  }
  const points = [...breaks].sort((a, b) => a - b);
  const out: Array<{ start: number; end: number; values: number[] }> = [];
  const cursors = lists.map(() => 0);
  for (let i = 0; i + 1 < points.length; i += 1) {
    const start = points[i]!;
    const end = points[i + 1]!;
    if (end <= start) continue;
    if (!within.some((w) => w.start <= start && end <= w.end)) continue;
    const values: number[] = [];
    let ok = true;
    for (let k = 0; k < lists.length; k += 1) {
      const list = lists[k]!;
      let c = cursors[k]!;
      while (c < list.length && list[c]!.end <= start) c += 1;
      cursors[k] = c;
      const seg = list[c];
      if (seg === undefined || seg.start > start) {
        ok = false;
        break;
      }
      values.push(seg.v);
    }
    if (ok) out.push({ start, end, values });
  }
  return out;
}

export interface ComfortResult {
  zones: ZoneResult[];
  findings: RawFinding[];
  /** Minutes-weighted over every judged zone, or null when nothing was judged. */
  overallPercentInBand: number | null;
  worst: ZoneResult[];
  /** Zones that could not be judged, with why. */
  skipped: Array<{ name: string; reason: string }>;
}

export function zoneComfort(
  units: EquipmentUnit[],
  occupied: Interval[],
  range: Interval,
  timezone: string,
  excluded: Set<string>,
): ComfortResult {
  const zones: ZoneResult[] = [];
  const findings: RawFinding[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const occupiedIn = normalise(intersect(occupied, [range]));

  for (const unit of units) {
    const temp = unit.points.find((p) => p.role === "zone_temp" && !excluded.has(p.pointId));
    if (temp === undefined) continue;

    const single = unit.points.find((p) => p.role === "zone_temp_sp" && !excluded.has(p.pointId)) ?? null;
    const heating = unit.points.find((p) => p.role === "zone_temp_heating_sp" && !excluded.has(p.pointId)) ?? null;
    const cooling = unit.points.find((p) => p.role === "zone_temp_cooling_sp" && !excluded.has(p.pointId)) ?? null;

    let setpoint: Setpoint;
    if (single !== null) {
      setpoint = { kind: "single", single: segments(single, range, holdMsFor(single)), heating: null, cooling: null };
    } else if (heating !== null && cooling !== null) {
      setpoint = {
        kind: "dual",
        single: null,
        heating: segments(heating, range, holdMsFor(heating)),
        cooling: segments(cooling, range, holdMsFor(cooling)),
      };
    } else {
      skipped.push({ name: unit.name, reason: "no setpoint trended" });
      zones.push({
        equipmentId: unit.equipmentId,
        name: unit.name,
        judgedMinutes: 0,
        inBandMinutes: 0,
        percentInBand: null,
        maxDeviationF: null,
        worstHour: null,
        setpointKind: "missing",
      });
      continue;
    }

    const tempSegs = segments(temp, range, holdMsFor(temp));
    const lists = setpoint.kind === "single" ? [tempSegs, setpoint.single!] : [tempSegs, setpoint.heating!, setpoint.cooling!];
    const aligned = align(lists, occupiedIn);

    let judgedMs = 0;
    let inBandMs = 0;
    let maxDev = 0;
    let maxDevAt: number | null = null;
    const outIntervals: Interval[] = [];
    let expectedText = "";

    for (const slice of aligned) {
      const ms = slice.end - slice.start;
      const t = slice.values[0]!;
      let deviation: number;
      if (setpoint.kind === "single") {
        const sp = slice.values[1]!;
        deviation = Math.abs(t - sp) <= BAND_F ? 0 : t - sp;
        expectedText = `within ±${BAND_F} °F of the ${fmtF(sp)} setpoint`;
      } else {
        const heat = slice.values[1]!;
        const cool = slice.values[2]!;
        deviation = t > cool + BAND_F ? t - cool : t < heat - BAND_F ? t - heat : 0;
        expectedText = `between ${fmtF(heat - BAND_F)} and ${fmtF(cool + BAND_F)} (the heating and cooling setpoints ±${BAND_F} °F)`;
      }
      judgedMs += ms;
      if (deviation === 0) {
        inBandMs += ms;
      } else {
        outIntervals.push({ start: slice.start, end: slice.end });
        if (Math.abs(deviation) > Math.abs(maxDev)) {
          maxDev = deviation;
          maxDevAt = slice.start;
        }
      }
    }

    const judgedMinutes = judgedMs / 60_000;
    const inBandMinutes = inBandMs / 60_000;
    const percentInBand = judgedMs > 0 ? Math.round((inBandMs / judgedMs) * 1000) / 10 : null;
    const profile = hourOfDayProfile(outIntervals, timezone);
    const worstHour = profile.some((m) => m > 0) ? profile.indexOf(Math.max(...profile)) : null;

    zones.push({
      equipmentId: unit.equipmentId,
      name: unit.name,
      judgedMinutes,
      inBandMinutes,
      percentInBand,
      maxDeviationF: maxDevAt === null ? null : Math.round(maxDev * 10) / 10,
      worstHour,
      setpointKind: setpoint.kind,
    });

    if (judgedMs === 0) {
      skipped.push({ name: unit.name, reason: "no occupied minutes with both temperature and setpoint known" });
      continue;
    }

    const percentOut = Math.round(((judgedMs - inBandMs) / judgedMs) * 100);
    const persisted = persistence(outIntervals, timezone);
    if (percentOut < WATCH_PERCENT || !persisted.qualifies) continue;

    const action = percentOut >= ACTION_PERCENT || Math.abs(maxDev) >= ACTION_DEVIATION_F;
    const direction = maxDev > 0 ? "warm" : "cold";
    findings.push({
      questionKey: COMFORT_QUESTION,
      section: "space_comfort",
      subjectKey: `equipment:${unit.equipmentId}`,
      equipmentId: unit.equipmentId,
      subjectName: unit.name,
      issueCode: `zone_${direction}`,
      issue: direction === "warm" ? "Zone above setpoint" : "Zone below setpoint",
      priority: action ? "action_needed" : "watch",
      evidence: {
        actual: `out of range ${percentOut}% of occupied hours, up to ${Math.abs(maxDev).toFixed(1)} °F ${maxDev > 0 ? "over" : "under"}`,
        expected: expectedText,
        percent: percentOut,
        duration: describeMinutes(persisted.totalMs / 60_000),
        durationMs: persisted.totalMs,
        when: busiestWindow(profile) ?? "across the day",
        maxDeviationF: Math.round(maxDev * 10) / 10,
        occupiedHoursJudged: Math.round(judgedMinutes / 6) / 10,
      },
    });
  }

  const totalJudged = zones.reduce((s, z) => s + z.judgedMinutes, 0);
  const totalIn = zones.reduce((s, z) => s + z.inBandMinutes, 0);
  const worst = zones
    .filter((z) => z.percentInBand !== null)
    .sort((a, b) => a.percentInBand! - b.percentInBand! || (b.maxDeviationF ?? 0) - (a.maxDeviationF ?? 0))
    .slice(0, WORST_ZONES);

  findings.sort((a, b) => (b.evidence.percent ?? 0) - (a.evidence.percent ?? 0) || a.subjectName.localeCompare(b.subjectName));

  return {
    zones,
    findings,
    overallPercentInBand: totalJudged > 0 ? Math.round((totalIn / totalJudged) * 1000) / 10 : null,
    worst,
    skipped,
  };
}

function fmtF(value: number): string {
  return `${value.toFixed(1)} ${unitSymbol("fahrenheit") ?? "°F"}`;
}

function describeMinutes(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}
