import type { ImportEquipmentInput } from "../schemas";
import type { ImportCandidate } from "./merge";
import { FLAG_NOT_FOUND } from "./types";

/**
 * Which units an import adds, with no review step: only freeze protection
 * equipment, meaning a coil that can freeze AND that outside air can reach
 * (Karthik, 2026-11-03).
 *
 * - The coil carries water, glycol or steam. Glycol and steam count: a glycol
 *   coil freezes when the mix is weak (the sheet's step 4 has a glycol
 *   option), and a steam coil freezes on its condensate.
 * - Outside air can reach it: the schedule's reading is "likely", or the
 *   schedule does not say. Only a unit the schedule shows recirculating room
 *   air or fed conditioned air ("unlikely") is skipped, so a vague schedule
 *   never silently drops a unit at risk; the engineer settles exposure at
 *   step 3.
 *
 * Names must also be found in the PDF and not already be in the equipment
 * list. Everything left out is counted, so the summary can say why.
 */

export interface ImportSelection {
  rows: ImportEquipmentInput["rows"];
  /** Units on schedules of accessories (diffusers, valves, attenuators). */
  notEquipment: number;
  /** Equipment with no water, glycol or steam coil: nothing to freeze. */
  noCoil: number;
  /** A coil the schedule shows outside air cannot reach (recirculating, or fed conditioned air). */
  notExposed: number;
  /** Already in the register; never changed by an import. */
  existing: string[];
  /** Names the checks could not find in the PDF text, so possibly misread. */
  notFound: string[];
}

export function selectForImport(candidates: ImportCandidate[], existingNames: string[]): ImportSelection {
  const existingSet = new Set(existingNames.map((n) => n.trim().toLowerCase()));
  const out: ImportSelection = { rows: [], notEquipment: 0, noCoil: 0, notExposed: 0, existing: [], notFound: [] };
  for (const c of candidates) {
    const name = c.name.trim();
    if (name === "") continue;
    if (!c.isEquipment) out.notEquipment++;
    else if (c.coil === "none") out.noCoil++;
    else if (c.exposureSuggestion === "unlikely") out.notExposed++;
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
