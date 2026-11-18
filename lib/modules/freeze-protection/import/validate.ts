import type { CoilType } from "../types";
import { NAME_MAX } from "../result";
import type { RawSchedule } from "./analyze";
import { type AnalyzedSchedule, FLAG_FROM_LIST, FLAG_NOT_FOUND, type ImportRow, type ScheduleBlock } from "./types";

/**
 * The deterministic checks on one schedule's answer. Nothing the model says
 * reaches the review screen without passing through here.
 *
 * - Every name must appear in the schedule's own text (ignoring spaces and
 *   case). One that does not is flagged and starts unticked.
 * - Units expanded from a row naming several are flagged for a second look.
 * - A name listed twice in one schedule keeps the first.
 * - Fewer units than mark-like first cells is a schedule-level warning.
 * - Exposure is kept even where this schedule shows no coil: the coils may be
 *   on another part of the same schedule. mergeSchedules drops it if no part
 *   shows one.
 */


const squash = (s: string) => s.toUpperCase().replace(/\s+/g, "");
const tidy = (s: string | null, max = NAME_MAX) => {
  const t = s?.replace(/\s+/g, " ").trim() ?? "";
  return t.length === 0 ? null : t.slice(0, max);
};

export function checkSchedule(block: ScheduleBlock, raw: RawSchedule): AnalyzedSchedule {
  const text = squash(block.text);
  const scheduleType = tidy(raw.equipment_type);
  const seen = new Set<string>();
  const rows: ImportRow[] = [];
  const warnings: string[] = [];
  let dropped = 0;

  for (const r of raw.rows) {
    const name = tidy(r.name)?.replace(/\s+/g, "") ?? null;
    if (name === null || name.length > NAME_MAX) {
      dropped++;
      continue;
    }
    const key = squash(name);
    if (seen.has(key)) continue;
    seen.add(key);

    const flags: string[] = [];
    if (r.from_list) flags.push(FLAG_FROM_LIST);
    else if (!text.includes(key)) flags.push(FLAG_NOT_FOUND);

    const coil = r.coil as CoilType;
    const suggest = r.exposure === "unclear" ? null : r.exposure;
    rows.push({
      name,
      equipmentType: tidy(r.equipment_type) ?? scheduleType,
      areaServed: tidy(r.area_served),
      coil,
      exposureSuggestion: suggest,
      exposureEvidence: suggest ? tidy(r.exposure_evidence, 500) : null,
      flags,
    });
  }

  if (dropped > 0) warnings.push(`${dropped} row${dropped === 1 ? "" : "s"} without a usable name left out.`);
  if (raw.is_equipment && rows.length < block.marks) {
    warnings.push(`Found ${rows.length} unit${rows.length === 1 ? "" : "s"}, but the schedule has at least ${block.marks} marked rows. Check for missing units.`);
  }
  if (raw.is_equipment && rows.length === 0) warnings.push("No units found on this schedule.");

  return {
    key: block.key,
    page: block.page,
    sheet: block.sheet,
    title: block.title,
    part: block.part,
    isEquipment: raw.is_equipment,
    reason: tidy(raw.reason, 300) ?? "",
    rows,
    warnings,
  };
}
