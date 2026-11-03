import type { ImportEquipmentInput } from "../schemas";
import { type ImportCandidate, sourceLabel } from "./merge";
import type { AnalyzedSchedule } from "./types";

/**
 * The review screen's arithmetic, kept out of the component so it is tested
 * directly: units grouped under the schedule they were first found on, and
 * the ticked ones turned into the commit request.
 */

export interface ReviewGroup {
  label: string;
  isEquipment: boolean;
  reason: string;
  warnings: string[];
  /** Indexes into the candidate list, in schedule order. */
  items: number[];
}

/** One group per schedule (slices of a long schedule are one group), in the order the PDF has them. */
export function groupCandidates(schedules: AnalyzedSchedule[], candidates: ImportCandidate[]): ReviewGroup[] {
  const groups = new Map<string, ReviewGroup>();
  for (const s of schedules) {
    const label = sourceLabel(s);
    const g = groups.get(label);
    if (g) {
      g.isEquipment ||= s.isEquipment;
      g.warnings.push(...s.warnings);
    } else {
      groups.set(label, { label, isEquipment: s.isEquipment, reason: s.reason, warnings: [...s.warnings], items: [] });
    }
  }
  candidates.forEach((c, i) => groups.get(c.sources[0] ?? "")?.items.push(i));
  return [...groups.values()].filter((g) => g.items.length > 0 || g.warnings.length > 0);
}

/** Lower-cased names already in the register; an import never touches those. */
export const existingSet = (names: string[]) => new Set(names.map((n) => n.trim().toLowerCase()));

/** The ticked units that are not already in the register, as the commit request's rows. */
export function toCommitRows(candidates: ImportCandidate[], existing: Set<string>): ImportEquipmentInput["rows"] {
  return candidates
    .filter((c) => c.include && c.name.trim() !== "" && !existing.has(c.name.trim().toLowerCase()))
    .map((c) => ({
      name: c.name.trim(),
      equipmentType: c.equipmentType?.trim() || null,
      areaServed: c.areaServed?.trim() || null,
      coil: c.coil,
      exposureSuggestion: c.exposureSuggestion,
      exposureEvidence: c.exposureSuggestion ? c.exposureEvidence : null,
      source: (c.sources[0] ?? "").slice(0, 200) || null,
    }));
}
