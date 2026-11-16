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
    // Questions 6-18 (Phase 5): every function returns `judged` and the
    // headline figure its line needs - the worst hours, the lowest share in
    // band, the peak starts - so the line names a unit and a number.
    case "q06_vav_starved_airflow":
      return hoursLine(m, "VAV", "VAVs", "ran below 80% of airflow setpoint while occupied for 30 minutes at a stretch or on two days", "the most time below was");
    case "q07_vav_damper_full_missed_setpoint":
      return hoursLine(m, "VAV", "VAVs", "sat at full damper and missed setpoint for 30 minutes at a stretch or on two days", "the most time at full damper off setpoint was");
    case "q08_reheat_open_above_cooling_sp":
      return hoursLine(m, "reheat valve", "reheat valves", "opened while its zone was above cooling setpoint for 30 minutes at a stretch or on two days", "the most time was");
    case "q09_dat_holds_setpoint":
      return bandLine(m, "held discharge air within its band (±1.5 °F modulating, ±4 °F staged DX)", "of fan-on hours");
    case "q10_static_tracks_setpoint":
      return bandLine(m, "tracked duct static setpoint", "of fan-on hours");
    case "q11_simultaneous_heating_cooling":
      return hoursLine(m, "unit", "units", "had heating and cooling on together for 30 minutes at a stretch or on two days", "the most time together was");
    case "q12_economizer_at_minimum": {
      const free = typeof m.freeCoolingHours === "number" ? m.freeCoolingHours : null;
      const line = hoursLine(m, "unit", "units", "held the economizer at minimum while free cooling was available for 30 minutes at a stretch or on two days", "the most time at minimum was");
      return free === null || judgedOf(m) === 0 ? line : `${line} Free cooling was available with cooling called for ${free.toFixed(1)} h.`;
    }
    case "q13_hw_supply_and_delta_t":
    case "q14_chw_supply_and_delta_t": {
      const judged = judgedOf(m);
      const label = typeof m.label === "string" ? m.label : q.key.startsWith("q13") ? "HWS" : "CHWS";
      if (judged === 0) return "No loop was in service long enough to judge.";
      const onTarget = typeof m.onTargetPercent === "number" ? m.onTargetPercent : null;
      const delta = typeof m.averageDeltaT === "number" ? m.averageDeltaT : null;
      const loops = judged === 1 ? "the one loop judged" : `the ${judged} loops judged`;
      return `${label} held setpoint and delta T held its minimum on ${loops}${onTarget === null ? "" : `; ${label} on target ${onTarget}% of in-service hours`}${delta === null ? "" : `, average delta T ${delta.toFixed(1)} °F`}.`;
    }
    case "q15_compressor_short_cycling": {
      const judged = judgedOf(m);
      if (judged === 0) return "No compressor trend fine enough to count starts.";
      const peak = m.peak as { name: string; startsPerHour: number } | null | undefined;
      const units = judged === 1 ? "The one unit judged did not" : `None of the ${judged} units judged`;
      const verb = judged === 1 ? "" : " did";
      const base = `${units}${verb} start a compressor stage more than 4 times in an hour`;
      return peak === null || peak === undefined ? `${base}.` : `${base}; the peak was ${peak.startsPerHour} in an hour (${peak.name}).`;
    }
    case "q16_dx_cooling_delta":
      return deltaLine(m, "dropped DAT at least 15 °F below return or mixed air with compressors on", "lowest average drop");
    case "q17_compressors_during_economizer":
      return hoursLine(m, "unit", "units", "ran compressors below 55 °F outside with the economizer at minimum for 30 minutes at a stretch or on two days", "the most time was");
    case "q18_heat_stage_delta":
      return deltaLine(m, "raised DAT at least 20 °F above return or mixed air with heat stages on", "lowest average rise");
    case "q20_data_health": {
      const judged = typeof m.judged === "number" ? m.judged : null;
      if (judged === null) return "No data problems found in the period.";
      return `All ${judged} points judged were reporting, changing and within physical range.`;
    }
    default:
      return q.equipment.length === 0 ? "Nothing to report." : `Nothing to report over ${q.equipment.join(", ")}.`;
  }
}

function judgedOf(m: Record<string, unknown>): number {
  return typeof m.judged === "number" ? m.judged : 0;
}

/** "None of the 4 VAVs judged ran below …; the most time below was 0.3 h (VAV-2)." */
function hoursLine(m: Record<string, unknown>, one: string, many: string, did: string, mostWas: string): string {
  const judged = judgedOf(m);
  if (judged === 0) return `No ${one} could be judged.`;
  const worst = m.worst as { name: string; hours: number } | null | undefined;
  const sentence = judged === 1 ? `The one ${one} judged never ${did}` : `None of the ${judged} ${many} judged ${did}`;
  if (worst === null || worst === undefined || worst.hours === 0) return `${sentence}.`;
  return `${sentence}; ${mostWas} ${worst.hours.toFixed(1)} h (${worst.name}).`;
}

/** "All 2 units judged held … for at least 94% of fan-on hours." */
function bandLine(m: Record<string, unknown>, held: string, of: string): string {
  const judged = judgedOf(m);
  if (judged === 0) return "No unit ran long enough to be judged.";
  const lowest = m.lowest as { name: string; percentInBand: number } | null | undefined;
  const who = judged === 1 ? "The one unit judged" : `All ${judged} units judged`;
  if (lowest === null || lowest === undefined) return `${who} ${held}.`;
  return `${who} ${held} for at least ${formatPercent(lowest.percentInBand)}% ${of} (lowest: ${lowest.name}).`;
}

/** "All 2 units judged dropped DAT …; the lowest average drop was 17.2 °F (RTU-1)." */
function deltaLine(m: Record<string, unknown>, did: string, lowestWas: string): string {
  const judged = judgedOf(m);
  if (judged === 0) return "No unit ran long enough to be judged.";
  const lowest = m.lowest as { name: string; averageF: number } | null | undefined;
  const who = judged === 1 ? "The one unit judged" : `All ${judged} units judged`;
  if (lowest === null || lowest === undefined) return `${who} ${did}.`;
  return `${who} ${did}; the ${lowestWas} was ${lowest.averageF.toFixed(1)} °F (${lowest.name}).`;
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
