import type { ImportEquipmentInput } from "../schemas";
import type { ImportCandidate } from "./merge";
import { FLAG_NOT_FOUND } from "./types";

/**
 * Which units an import adds, with no review step: the units on equipment
 * schedules whose names were found in the PDF and are not already in the
 * register. Everything left out is counted, so the summary can say what was
 * skipped and why.
 */

export interface ImportSelection {
  rows: ImportEquipmentInput["rows"];
  /** Units on schedules of accessories (diffusers, valves, attenuators). */
  notEquipment: number;
  /** Already in the register; never changed by an import. */
  existing: string[];
  /** Names the checks could not find in the PDF text, so possibly misread. */
  notFound: string[];
}

export function selectForImport(candidates: ImportCandidate[], existingNames: string[]): ImportSelection {
  const existingSet = new Set(existingNames.map((n) => n.trim().toLowerCase()));
  const out: ImportSelection = { rows: [], notEquipment: 0, existing: [], notFound: [] };
  for (const c of candidates) {
    const name = c.name.trim();
    if (name === "") continue;
    if (!c.isEquipment) out.notEquipment++;
    else if (existingSet.has(name.toLowerCase())) out.existing.push(name);
    else if (c.flags.includes(FLAG_NOT_FOUND)) out.notFound.push(name);
    else
      out.rows.push({
        name,
        equipmentType: c.equipmentType?.trim() || null,
        areaServed: c.areaServed?.trim() || null,
        coil: c.coil,
        exposureSuggestion: c.exposureSuggestion,
        exposureEvidence: c.exposureSuggestion ? c.exposureEvidence : null,
        source: (c.sources[0] ?? "").slice(0, 200) || null,
      });
  }
  return out;
}
