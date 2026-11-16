import type { PlannerAnswer, ReportDocument } from "@/lib/modules/bas/reports/engine/types";
import { reportDocument } from "./bas-report-document";

/**
 * A planner answer as the office's run 18 stored it (2026-11-16), trimmed:
 * the warmest-zone question, its interpretation, SQL, points and cost - the
 * parts the page hides and the web view's panel shows.
 */
export const PLANNER_SQL = "SELECT zone_name, round(avg(value_num)::numeric, 2) AS avg_temp_f FROM bas_readings r JOIN bas_points p USING (point_id) WHERE p.station_id = 6 GROUP BY 1 ORDER BY 2 DESC";
export const PLANNER_INTERPRETATION = "Average of each zone temperature point on station PHBoffice (site 7) between 2026-09-22T13:00Z and 2026-09-29T13:00Z, restricted to occupied times.";

export function plannerAnswer(over: Partial<PlannerAnswer> = {}): PlannerAnswer {
  return {
    position: 20,
    text: "Which zone was warmest on average during occupied hours?",
    source: "inline",
    libraryKey: null,
    sectionLabel: null,
    outcome: "answered",
    answer: "VAV-7 serving rooms 111-112 was the warmest zone during occupied hours, averaging 73.91 °F.\n- ROOM 107 — 73.37 °F\n- VAV-8, rooms 104-105 — 70.50 °F",
    reason: null,
    interpretation: PLANNER_INTERPRETATION,
    sql: PLANNER_SQL,
    table: {
      columns: ["zone_name", "avg_temp_f", "first_reading"],
      rows: [
        ["VAV-7 111-112_ZoneTemperature", "73.91", "2026-09-22T13:00:00.000Z"],
        ["ROOM 107", "73.37", "2026-09-22T04:00:00.000Z"],
        ["VAV-8 104-105_ZoneTemperature", "70.50", "2026-09-23T00:00:00.000Z"],
      ],
      rowCount: 3,
      truncated: false,
      kept: 3,
    },
    provenance: {
      timeRange: { start: "2026-09-22T13:00:00.000Z", end: "2026-09-29T13:00:00.000Z" },
      periodUndeclared: false,
      points: ["Occupied", "ROOM 107", "VAV-7 111-112_ZoneTemperature", "VAV-8 104-105_ZoneTemperature"],
      pointCount: 11,
      gapHours: 0,
      coverageShortfall: null,
      unknownHorizonCount: 0,
      unclassifiedExcluded: 9,
      neverCollected: [],
    },
    notes: [],
    retried: false,
    costUsd: 0.2313,
    inputTokens: 26_032,
    outputTokens: 2_945,
    calls: 2,
    durationMs: 41_365,
    ...over,
  };
}

/** The sample report with planner answers in place of the old custom-question notes. */
export function reportWithPlanner(answers: PlannerAnswer[] = [plannerAnswer()]): ReportDocument {
  return { ...reportDocument(), plannerQuestions: [], plannerAnswers: answers };
}
