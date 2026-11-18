import type { PlannerAnswer, ReportDocument } from "@/lib/modules/bas/reports/engine/types";
import { reportDocument } from "./bas-report-document";

/**
 * A planner answer as the office's run 18 stored it (2026-11-16), trimmed:
 * the warmest-zone question, its interpretation, SQL, points and cost - the
 * parts the page hides and the web view's panel shows.
 */
export const PLANNER_SQL = "SELECT zone_name, round(avg(value_num)::numeric, 2) AS avg_temp_f FROM bas_readings r JOIN bas_points p USING (point_id) WHERE p.station_id = 6 GROUP BY 1 ORDER BY 2 DESC";
export const PLANNER_INTERPRETATION = "Average of each zone temperature point on station PHBoffice (site 7) between 2026-09-22T13:00Z and 2026-09-29T13:00Z, restricted to occupied times.";

/** The summariser's coverage paragraph, which the page leaves out and the panel shows. */
export const PLANNER_COVERAGE =
  "This covers 22 September at 9:00 AM through 29 September at 9:00 AM, occupied hours only. The newest reading we hold is from 29 September at 1:00 PM, so these are not current conditions.";

/**
 * The two answers office run 18 stored (2026-11-16), verbatim, as the
 * summariser wrote them - what `splitPlannerAnswer` was measured against.
 */
export const RUN_18_ANSWERS: readonly string[] = [
  "VAV-7 serving rooms 111-112 was the warmest zone during occupied hours, averaging 73.91 °F, with a range of 69.55 °F to 77.60 °F.\n\nThe rest of the zones, warmest to coolest by occupied-hours average:\n- ROOM 107 — 73.37 °F (70.61 to 78.77 °F)\n- VAV-4, rooms 114-115 — 73.37 °F (69.83 to 77.68 °F)\n- VAV-9, room 106 — 72.96 °F (70.65 to 78.28 °F)\n- VAV-2, rooms 122-125 — 72.74 °F (71.12 to 76.68 °F)\n- VAV-3, rooms 120-121 — 72.71 °F (71.52 to 75.53 °F)\n- VAV-6, room 113 — 72.13 °F (68.83 to 77.83 °F)\n- VAV-5, rooms 117-118 — 72.11 °F (65.29 to 76.90 °F)\n- ROOM 130-132 — 71.93 °F (70.06 to 75.45 °F)\n- VAV-8, rooms 104-105 — 70.50 °F (70.50 to 70.50 °F)\n\nOne thing worth a look while you're in there: VAV-8 read exactly 70.50 °F for all 672 occupied readings — no movement at all over the week. Every other zone swings several degrees. That pattern often points to a sensor that isn't updating or a value stuck in the controller, but the readings alone don't confirm a cause. Worth checking that zone sensor against a handheld reading and confirming the point is actually refreshing at the controller.\n\nThis covers 22 September at 9:00 AM through 29 September at 9:00 AM, occupied hours only, taken from the building's trended Occupied point since no occupancy schedule is stored. No hours are missing in that window. Nine points that have no role assigned weren't included, so if a zone you expect is missing from the list, that's why. The newest reading we hold is from 29 September at 1:00 PM, so these are not current conditions.",
  "Here's what the collector stored per local day on station PHBoffice, from 22 September at 9:00 AM through 29 September at 9:00 AM:\n\n- 22 September: 1,742 readings from 20 points (partial day - the window starts at 9:00 AM)\n- 23 September: 2,654 readings from 20 points\n- 24 September: 2,384 readings from 22 points\n- 25 September: 1,598 readings from 16 points\n- 26 September: 2,040 readings from 20 points\n- 27 September: 2,694 readings from 20 points\n- 28 September: 2,844 readings from 20 points (the busiest full day)\n- 29 September: 1,088 readings from 20 points (partial day - the window ends at 9:00 AM)\n\nTwo things worth noting if you're judging collector health from this. The 25th stands out: only 16 points reported that day and the stored count is the lowest of the full days, while the 24th had 22 points reporting. That swing in how many points reported could be points dropping off line, a station communication issue, or points that only report on change - the numbers alone don't say which. Also, about 188 hours of point-time inside this window has no readings at all, so these daily counts are what did land, not a full picture of the week.\n\nThe newest reading held for this station is from 29 September at 1:10 PM, so this is historical data, not a live view."
];

export function plannerAnswer(over: Partial<PlannerAnswer> = {}): PlannerAnswer {
  return {
    position: 20,
    text: "Which zone was warmest on average during occupied hours?",
    source: "inline",
    libraryKey: null,
    sectionLabel: null,
    outcome: "answered",
    answer: [
      "VAV-7 serving rooms 111-112 was the warmest zone during occupied hours, averaging 73.91 °F.",
      "",
      "- ROOM 107 — 73.37 °F",
      "- VAV-8, rooms 104-105 — 70.50 °F",
      "",
      "VAV-8 did not move all week; worth checking that sensor.",
      "",
      PLANNER_COVERAGE,
    ].join("\n"),
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
