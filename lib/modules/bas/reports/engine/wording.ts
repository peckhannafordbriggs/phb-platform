import type { QuestionResult } from "./types";

/**
 * Sentences code writes on a report (Reports, 2026-11-12), shared by the
 * engine (which stores them on the document and prints them from the dev
 * script) and the template (which derives them again from a stored
 * document, so a run stored before a wording change renders the current
 * wording). No React here: run.ts imports this and must not pull the
 * renderer in.
 */

/** The missing requirement labels across a section's Not Monitored questions, in first-seen order, deduplicated. */
export function missingForSection(questions: ReadonlyArray<Pick<QuestionResult, "outcome" | "missing">>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of questions) {
    if (q.outcome !== "not_monitored") continue;
    for (const m of q.missing) {
      if (seen.has(m)) continue;
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}

/**
 * The one line a Not Monitored section shows under its badge. The full list
 * per question is in the Point Inventory, once; the section says what it
 * needs and points there rather than repeating the inventory.
 */
export function notMonitoredSentence(missing: readonly string[]): string {
  return missing.length === 0
    ? "Not monitored; see Point Inventory."
    : `Not monitored — needs ${missing.join("; ")}; see Point Inventory.`;
}

/** The same line for one question inside a section that otherwise ran. */
export function questionNotMonitoredSentence(position: number, missing: readonly string[]): string {
  return `Q${position} not monitored — needs ${missing.join("; ")}; see Point Inventory.`;
}

/** "42 s", "3 min 12 s", "1 h 4 min": how long a run took, from milliseconds. */
export function describeRunDuration(ms: number): string {
  const totalS = Math.max(0, Math.round(ms / 1000));
  if (totalS < 60) return `${totalS} s`;
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  if (h > 0) return m === 0 ? `${h} h` : `${h} h ${m} min`;
  return s === 0 ? `${m} min` : `${m} min ${s} s`;
}
