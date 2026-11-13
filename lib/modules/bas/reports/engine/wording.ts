import { BAS_LIBRARY_QUESTIONS, describeRequiredRoles } from "../library";
import type { QuestionResult, ScheduleResult, ZoneResult } from "./types";

/**
 * Sentences code writes on a report (Reports, 2026-11-12), shared by the
 * engine (which stores them on the document and prints them from the dev
 * script) and the template (which derives them again from a stored
 * document, so a run stored before a wording change renders the current
 * wording). No React here: run.ts imports this and must not pull the
 * renderer in.
 *
 * Since 2026-11-13 every question is on the page in its own words, with
 * its answer beneath it, so the functions below word the four answers a
 * question can have: a factual line when it ran and found nothing (from
 * the numbers the analysis returned), and the three reasons it did not run.
 */

/** A question the time cap stopped before it was analysed: its `reason`, and the section's sentence when every question was. */
export const TIME_CAP_NOTE = "Not analysed: the run reached its time cap before this question.";

/** "Q3": how the report refers to a question by number - the inventory's first column, the partial reason. */
export function questionLabel(position: number): string {
  return `Q${position}`;
}

/** "Q3. What percent of occupied hours did each zone hold within ±2°F of setpoint?": the sub-heading every question gets. */
export function questionHeading(q: Pick<QuestionResult, "position" | "text">): string {
  return `${questionLabel(q.position)}. ${q.text}`;
}

/**
 * What a question needs - the spec's Points-required column, as the engine
 * read it from the library row when it ran. A document stored before the
 * column was kept on the result falls back to the library's row for the
 * same key, and a key the library does not know reads as nothing required.
 */
export function questionNeeds(q: Pick<QuestionResult, "key"> & { needs?: string }): string {
  if (typeof q.needs === "string") return q.needs;
  const row = BAS_LIBRARY_QUESTIONS.find((x) => x.key === q.key);
  return row === undefined ? "—" : describeRequiredRoles(row.requiredRoles);
}

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
 * A Not Monitored section's status sentence, as the engine stores it and
 * the dev script prints it. The page itself no longer shows it (since
 * 2026-11-13 each question under the section says what it needs).
 */
export function notMonitoredSentence(missing: readonly string[]): string {
  return missing.length === 0
    ? "Not monitored; see Point Inventory."
    : `Not monitored — needs ${missing.join("; ")}; see Point Inventory.`;
}

/** Under a question that could not run because the building does not trend what it needs. */
export function notMonitoredLine(missing: readonly string[]): string {
  return missing.length === 0
    ? "Not monitored — this building does not trend what this question needs."
    : `Not monitored — this building does not trend: ${missing.join("; ")}.`;
}

/** Under a question that does not apply to this building. */
export function notApplicableLine(reason: string | null): string {
  return reason === null || reason.trim() === "" ? "Not applicable." : `Not applicable — ${reason.replace(/\.$/, "")}.`;
}

/**
 * Under a question that could have run and was not analysed - no function
 * for it yet (Phase 5), or the run's time cap - with the units it would
 * have run over, so the reader knows the building qualifies.
 */
export function notRunLine(q: Pick<QuestionResult, "reason" | "equipment">): string {
  const reason = (q.reason ?? "it was not analysed in this run.").replace(/^Not analysed:\s*/i, "");
  const text = withFullStop(`Not analysed — ${lowerFirst(reason)}`);
  return q.equipment.length === 0 ? text : `${text} Units it would run over: ${q.equipment.join(", ")}.`;
}

/** "Not judged: VAV-5 (no setpoint trended); VAV-2 (missing space temp)." */
export function skippedLine(skipped: ReadonlyArray<{ name: string; reason: string }>): string | null {
  if (skipped.length === 0) return null;
  return `Not judged: ${skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}.`;
}

/**
 * The one line under a question that ran and found nothing, written from
 * the numbers the analysis returned in the result's metrics - how many
 * zones, the lowest share in band, the most hours outside schedule - so
 * the line is a fact about this period and not a stock phrase. A document
 * stored before a number was kept gets the nearest line the stored metrics
 * support, never an invented figure.
 */
export function positiveAnswer(q: Pick<QuestionResult, "key" | "metrics" | "equipment">): string {
  const m = q.metrics;
  switch (q.key) {
    case "q03_zone_comfort": {
      const zones = ((m.zones as ZoneResult[] | undefined) ?? []).filter((z) => z.percentInBand !== null);
      const judged = typeof m.zonesJudged === "number" ? m.zonesJudged : zones.length;
      const lowest =
        typeof m.lowestPercentInBand === "number"
          ? m.lowestPercentInBand
          : zones.length === 0
            ? null
            : Math.min(...zones.map((z) => z.percentInBand as number));
      if (judged === 0 || lowest === null) return "No zone could be judged: no occupied minutes with both a temperature and a setpoint known.";
      return `${judged === 1 ? "The one zone judged" : `All ${judged} zones judged`} held setpoint for at least ${formatPercent(lowest)}% of occupied hours.`;
    }
    case "q04_worst_zones": {
      const worst = (m.worstZones as ZoneResult[] | undefined) ?? [];
      return worst.length === 0 ? "No zone could be judged." : `The ${worst.length} zones most out of range are in the table.`;
    }
    case "q05_manual_overrides": {
      const judged = typeof m.judged === "number" ? m.judged : null;
      if (judged === null) return "No manual override was held for 30 minutes or more.";
      if (judged === 0) return "No override point could be judged.";
      return `No manual override was held for 30 minutes or more on the ${judged} override point${judged === 1 ? "" : "s"} judged.`;
    }
    case "q19_run_outside_schedule": {
      const rows = (m.schedules as ScheduleResult[] | undefined) ?? [];
      const judged = typeof m.judged === "number" ? m.judged : rows.length;
      const longest =
        (m.longestOutside as { name: string; hours: number } | null | undefined) ??
        (rows.length === 0 ? null : rows.reduce((a, b) => (b.hoursOutside > a.hoursOutside ? b : a)));
      if (judged === 0) return "No unit with a status point could be judged.";
      const units = judged === 1 ? "The one unit judged did not run" : `None of the ${judged} units judged ran`;
      if (longest === null || hoursOf(longest) === 0) return `${units} outside its schedule.`;
      return `${units} outside its schedule for 30 minutes at a stretch or on two days; the most time outside was ${hoursOf(longest).toFixed(1)} h (${longest.name}).`;
    }
    case "q20_data_health": {
      const judged = typeof m.judged === "number" ? m.judged : null;
      if (judged === null) return "No data problems found in the period.";
      return `All ${judged} points judged were reporting, changing and within physical range.`;
    }
    default:
      return q.equipment.length === 0 ? "Nothing to report." : `Nothing to report over ${q.equipment.join(", ")}.`;
  }
}

function hoursOf(longest: { hours?: number; hoursOutside?: number }): number {
  return typeof longest.hours === "number" ? longest.hours : (longest.hoursOutside ?? 0);
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function lowerFirst(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

function withFullStop(s: string): string {
  return /[.!?]$/.test(s) ? s : `${s}.`;
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
