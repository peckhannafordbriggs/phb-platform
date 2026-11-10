import type { Finding, SectionDocument, SectionStatus } from "./types";

/**
 * Status roll-up (Reports, Phase 2). The spec's three words, decided by code
 * from the findings' priorities and nothing else.
 *
 *   Good           every finding within tolerance - no findings
 *   Watch          at least one Watch finding and nothing worse
 *   Action Needed  at least one Action Needed finding
 *
 * Not Applicable and Not Monitored sections never affect the building
 * status: a section that could not be judged is not a good section and not a
 * bad one. Cleared findings are history, not status.
 */

export function sectionStatus(findings: Finding[]): SectionStatus {
  let status: SectionStatus = "good";
  for (const f of findings) {
    if (f.state === "cleared") continue;
    if (f.priority === "action_needed") return "action_needed";
    status = "watch";
  }
  return status;
}

export function buildingStatus(sections: SectionDocument[]): SectionStatus {
  let status: SectionStatus = "good";
  for (const s of sections) {
    if (s.status === "action_needed") return "action_needed";
    if (s.status === "watch") status = "watch";
  }
  return status;
}

export const STATUS_LABELS: Record<SectionStatus, string> = {
  good: "Good",
  watch: "Watch",
  action_needed: "Action Needed",
};

const PRIORITY_RANK: Record<Finding["priority"], number> = { action_needed: 0, watch: 1 };

/**
 * The three findings that drove the status: Action Needed before Watch, and
 * within a priority the larger percent or the longer duration first, so the
 * worst zone and the longest run lead.
 */
export function topFindings(findings: Finding[], n = 3): Finding[] {
  return findings
    .filter((f) => f.state !== "cleared")
    .sort((a, b) => {
      const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      if (p !== 0) return p;
      return magnitude(b) - magnitude(a);
    })
    .slice(0, n);
}

function magnitude(f: Finding): number {
  if (typeof f.evidence.percent === "number") return f.evidence.percent;
  const ms = f.evidence.durationMs;
  return typeof ms === "number" ? ms / 3_600_000 : 0;
}
