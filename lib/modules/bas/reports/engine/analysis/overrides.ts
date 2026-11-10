import { describeDuration, holdMsFor, persistence, segments, whereTrue } from "../series";
import type { Interval, PointSeries, RawFinding } from "../types";

/**
 * Question 5, Space Comfort (Reports, Phase 2): "Which setpoints or outputs
 * are in manual override, and since when?"
 *
 * THE LIMIT, stated up front. The spec's required point is "override or
 * priority status" - Niagara's per-point priority array, which says a
 * setpoint or an output is being driven by hand rather than by its program.
 * The vocabulary (prisma/bas-vocabularies.ts) has one override role,
 * `occupancy_override` ("Manual after-hours override request"), and no
 * general override or priority status. So this question answers from that
 * one role: an occupancy override held for at least 30 minutes, with when it
 * began. A setpoint in manual override through its priority slots is NOT
 * detected here, because no role describes it; the library row says so
 * (`required_roles`), and widening it is a vocabulary decision, not a
 * report one.
 */

export const OVERRIDES_QUESTION = "q05_manual_overrides";
export const OVERRIDE_ROLES: readonly string[] = ["occupancy_override"];

export interface OverrideResult {
  findings: RawFinding[];
  judged: number;
}

export function manualOverrides(points: PointSeries[], range: Interval, timezone: string, excluded: Set<string>): OverrideResult {
  const findings: RawFinding[] = [];
  let judged = 0;

  for (const p of points) {
    if (p.role === null || !OVERRIDE_ROLES.includes(p.role) || excluded.has(p.pointId)) continue;
    judged += 1;
    const segs = segments(p, range, holdMsFor(p));
    const active = whereTrue(segs, (v) => v >= 0.5);
    const persisted = persistence(active, timezone);
    if (active.length === 0 || !persisted.qualifies) continue;

    const last = active[active.length - 1]!;
    const stillOn = last.end >= range.end;
    const since = stillOn ? last.start : active[0]!.start;
    findings.push({
      questionKey: OVERRIDES_QUESTION,
      section: "space_comfort",
      subjectKey: `point:${p.pointId}`,
      equipmentId: p.equipmentId,
      subjectName: p.equipmentName !== null ? `${p.equipmentName} · ${p.name}` : p.name,
      issueCode: stillOn ? "override_active" : "override_held",
      issue: stillOn ? "Override active" : "Override was held",
      priority: "watch",
      evidence: {
        actual: stillOn
          ? `override on, ${describeDuration(last.end - last.start)} and counting`
          : `override on for ${describeDuration(persisted.totalMs)} over ${persisted.days} day${persisted.days === 1 ? "" : "s"}`,
        expected: "no manual override",
        duration: describeDuration(persisted.totalMs),
        durationMs: persisted.totalMs,
        when: `since ${localTime(since, timezone)}`,
        sinceIso: new Date(since).toISOString(),
        stillActive: stillOn,
      },
    });
  }

  findings.sort((a, b) => a.subjectName.localeCompare(b.subjectName));
  return { findings, judged };
}

function localTime(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
}
