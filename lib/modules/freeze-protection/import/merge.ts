import type { CoilType } from "../types";
import { type AnalyzedSchedule, type ExposureSuggestion, FLAG_NOT_FOUND } from "./types";

/**
 * Units across schedules, merged by name. A drawing set often lists one unit
 * on several schedules (AHU part A, B and C; a schedule and its "CONT'D"), and
 * the register holds it once. Pure, shared by the review screen and the tests.
 *
 * Merging keeps the first type and area served it finds, the coil most at risk
 * of freezing (water, steam, glycol, none), and "likely" over "unlikely" for
 * exposure. A unit starts ticked when any of its schedules is equipment and
 * none of its flags says the name was not found.
 */

export interface ImportCandidate {
  name: string;
  equipmentType: string | null;
  areaServed: string | null;
  coil: CoilType;
  exposureSuggestion: ExposureSuggestion | null;
  exposureEvidence: string | null;
  flags: string[];
  /** Sheet and title of each schedule the unit was found on. */
  sources: string[];
  isEquipment: boolean;
  include: boolean;
}

const COIL_RISK: Record<CoilType, number> = { water: 3, steam: 2, glycol: 1, none: 0 };
const EXPOSURE_RANK = { likely: 2, unlikely: 1 } as const;

export const sourceLabel = (s: Pick<AnalyzedSchedule, "sheet" | "title" | "page">) =>
  `${s.sheet ?? `Page ${s.page}`} · ${s.title}`;

export function mergeSchedules(schedules: AnalyzedSchedule[]): ImportCandidate[] {
  const notFoundFlag = FLAG_NOT_FOUND;
  const byName = new Map<string, ImportCandidate>();
  for (const s of schedules) {
    const source = sourceLabel(s);
    for (const r of s.rows) {
      const key = r.name.toUpperCase();
      const had = byName.get(key);
      if (!had) {
        byName.set(key, {
          name: r.name,
          equipmentType: r.equipmentType,
          areaServed: r.areaServed,
          coil: r.coil,
          exposureSuggestion: r.exposureSuggestion,
          exposureEvidence: r.exposureEvidence,
          flags: [...r.flags],
          sources: [source],
          isEquipment: s.isEquipment,
          include: false,
        });
        continue;
      }
      had.equipmentType ??= r.equipmentType;
      had.areaServed ??= r.areaServed;
      if (COIL_RISK[r.coil] > COIL_RISK[had.coil]) had.coil = r.coil;
      const rank = (e: ExposureSuggestion | null) => (e ? EXPOSURE_RANK[e] : 0);
      if (rank(r.exposureSuggestion) > rank(had.exposureSuggestion)) {
        had.exposureSuggestion = r.exposureSuggestion;
        had.exposureEvidence = r.exposureEvidence;
      }
      // Found verbatim on any schedule clears "not found" from another.
      if (!r.flags.includes(notFoundFlag)) had.flags = had.flags.filter((f) => f !== notFoundFlag);
      for (const f of r.flags) if (f !== notFoundFlag && !had.flags.includes(f)) had.flags.push(f);
      if (!had.sources.includes(source)) had.sources.push(source);
      had.isEquipment ||= s.isEquipment;
    }
  }
  const out = [...byName.values()];
  for (const c of out) {
    if (c.coil === "none") {
      c.exposureSuggestion = null;
      c.exposureEvidence = null;
    }
    c.include = c.isEquipment && !c.flags.includes(notFoundFlag);
  }
  return out;
}
