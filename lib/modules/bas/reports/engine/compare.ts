import { createHash } from "node:crypto";
import type { Finding, RawFinding } from "./types";

/**
 * New, still open, cleared (Reports, Phase 2).
 *
 * A finding is the same finding as last time when it is about the same thing
 * for the same reason: the question, the subject (an equipment or a point)
 * and the issue code. That triple is hashed into a fingerprint, so two runs
 * are compared without the prose and without the numbers - a VAV starved for
 * air at 62% of occupied hours and the same VAV at 70% next week are one
 * open item, not a cleared one and a new one.
 *
 * A collection incident's subject is `station:<id>@<minute>` (Data Health,
 * 2026-11-12), so its fingerprint keys on the station and the minute the
 * first point stopped: the same stop is Still open next week however many
 * of its points are still out, and a later stop on the same station is a
 * new incident.
 */

export function fingerprintOf(questionKey: string, subjectKey: string, issueCode: string): string {
  return createHash("sha256").update(`${questionKey}|${subjectKey}|${issueCode}`).digest("hex");
}

export interface PreviousFinding {
  fingerprint: string;
  state: string;
  priority: Finding["priority"];
  firstSeenRunId: string | null;
  firstSeenAt: string | null;
  /** The previous run's finding, whole, for a cleared row. */
  finding: Omit<Finding, "state" | "fingerprint">;
}

export interface Comparison {
  findings: Finding[];
  cleared: Finding[];
  counts: { new: number; stillOpen: number; cleared: number };
}

/**
 * Mark each current finding against the previous run's open findings, and
 * carry the ones that are gone as cleared.
 *
 * `thisRunId` and `now` stamp a new finding's first-seen; a still-open one
 * keeps the previous run's first-seen, which is how "since 10/14" survives
 * five weekly reports. A previous finding that was itself cleared is not an
 * open item and does not clear again.
 */
export function compareFindings(
  current: RawFinding[],
  previous: PreviousFinding[],
  thisRunId: string,
  now: string,
): Comparison {
  const open = new Map<string, PreviousFinding>();
  for (const p of previous) {
    if (p.state !== "cleared") open.set(p.fingerprint, p);
  }

  const findings: Finding[] = [];
  const seen = new Set<string>();
  let fresh = 0;
  let still = 0;

  for (const raw of current) {
    const fingerprint = fingerprintOf(raw.questionKey, raw.subjectKey, raw.issueCode);
    seen.add(fingerprint);
    const before = open.get(fingerprint);
    if (before !== undefined) {
      still += 1;
      findings.push({
        ...raw,
        fingerprint,
        state: "still_open",
        firstSeenRunId: before.firstSeenRunId,
        firstSeenAt: before.firstSeenAt,
        likelyCause: null,
        recommendedAction: null,
        fixLocation: null,
      });
    } else {
      fresh += 1;
      findings.push({
        ...raw,
        fingerprint,
        state: "new",
        firstSeenRunId: thisRunId,
        firstSeenAt: now,
        likelyCause: null,
        recommendedAction: null,
        fixLocation: null,
      });
    }
  }

  const cleared: Finding[] = [];
  for (const [fingerprint, p] of open) {
    if (seen.has(fingerprint)) continue;
    cleared.push({
      ...p.finding,
      fingerprint,
      state: "cleared",
      firstSeenRunId: p.firstSeenRunId,
      firstSeenAt: p.firstSeenAt,
    });
  }

  return { findings, cleared, counts: { new: fresh, stillOpen: still, cleared: cleared.length } };
}

/** Action Needed items still open, oldest first: the "Open Items Carried Forward" list. */
export function carriedForward(findings: Finding[]): Finding[] {
  return findings
    .filter((f) => f.state === "still_open" && f.priority === "action_needed")
    .sort((a, b) => (a.firstSeenAt ?? "").localeCompare(b.firstSeenAt ?? ""));
}
