import type { Finding, ReportDocument } from "@/lib/modules/bas/reports/engine/types";

/**
 * One report document, as the engine stores it on a run (Reports, Phase 2):
 * a building with one Space Comfort finding still open, one new, one
 * cleared, a Data Health finding at -40 °F, a Not Monitored section and a
 * Not Applicable one, a partial reason and a cost. Shared by the template
 * test (tests/bas-reports-render.test.tsx) and the loader test
 * (tests/bas-reports-worker-render.test.ts), so the two render the same
 * document.
 */
export function finding(over: Partial<Finding> = {}): Finding {
  return {
    questionKey: "q03_zone_comfort",
    section: "space_comfort",
    subjectKey: "equipment:7",
    equipmentId: "7",
    subjectName: "VAV-2-14",
    issueCode: "zone_warm",
    issue: "Zone above setpoint",
    priority: "action_needed",
    evidence: { actual: "out of range 62% of occupied hours, up to 5.8 °F over", expected: "within ±2 °F of the 72.0 °F setpoint", percent: 62, when: "14:00-16:00" },
    fingerprint: "a".repeat(64),
    state: "still_open",
    firstSeenRunId: "1",
    firstSeenAt: "2026-10-14T10:00:00Z",
    likelyCause: "Likely a damper that is not opening fully.",
    recommendedAction: "Check the damper command against its position at VAV-2-14.",
    fixLocation: "site",
    ...over,
  };
}

export function reportDocument(): ReportDocument {
  const open = finding();
  const fresh = finding({ subjectKey: "equipment:8", equipmentId: "8", subjectName: "VAV-3", priority: "watch", state: "new", fingerprint: "b".repeat(64), likelyCause: null, recommendedAction: null });
  const cleared = finding({ subjectKey: "equipment:9", equipmentId: "9", subjectName: "VAV-9", state: "cleared", fingerprint: "c".repeat(64) });
  const flat = finding({
    questionKey: "q20_data_health",
    section: "data_health",
    subjectKey: "point:44",
    subjectName: "points_RoomT",
    issueCode: "out_of_range",
    issue: "Out of physical range",
    priority: "watch",
    state: "new",
    fingerprint: "d".repeat(64),
    evidence: { actual: "read -40 °F", expected: "a room or return air temperature between 35 °F and 110 °F", percent: 100, when: "00:00-02:00" },
    likelyCause: null,
    recommendedAction: null,
  });
  return {
    version: 1,
    header: {
      definitionName: "Weekly health",
      presetLabel: "Standard weekly health report",
      buildingName: "PHB Steel Place",
      stationNames: ["PHBoffice"],
      periodStart: "2026-09-22T13:00:00Z",
      periodEnd: "2026-09-29T13:00:00Z",
      timezone: "America/New_York",
      windowLabel: "last 7 days",
      outdoor: { avgF: 61.2, highF: 78.4, lowF: 44.1, pointName: "Outside_Air_Temp_Analog_Input1" },
      generatedAt: "2026-11-11T12:00:00Z",
      status: "partial",
      partialReason: "Q6 could run but has no analysis yet",
    },
    inventory: {
      equipmentTypesFound: ["economizer"],
      requiredPointsFound: 3,
      requiredPointsTotal: 9,
      lowCoverage: [{ name: "VAV-5 ZoneTemperature", coverage: 0.61 }],
      notMonitored: [{ position: 6, key: "q06_vav_starved_airflow", text: "Which VAVs ran below 80% of airflow setpoint while occupied?", missing: ["airflow", "airflow setpoint"] }],
      notApplicable: [{ position: 13, key: "q13_hw_supply_and_delta_t", text: "Did HW supply temp hold setpoint?", reason: "no hydronic heating on this building" }],
      occupancy: [{ stationName: "PHBoffice", kind: "point", detail: "Occupied (occupancy status point)" }],
      pointsInScope: 26,
      equipmentInScope: 11,
    },
    summary: { status: "action_needed", topFindings: [open, fresh], counts: { new: 2, stillOpen: 1, cleared: 1 }, siteVisit: ["VAV-2-14"], remoteFix: [] },
    sections: [
      {
        key: "space_comfort",
        label: "Space Comfort",
        status: "action_needed",
        statusSentence: "VAV-2-14 was above setpoint for most of the occupied hours.",
        questions: [
          { key: "q03_zone_comfort", position: 3, section: "space_comfort", text: "q3", kind: "computed", outcome: "answered", missing: [], reason: null, equipment: ["VAV-2-14"], skipped: [], metrics: { overallPercentInBand: 81.5 } },
          { key: "q04_worst_zones", position: 4, section: "space_comfort", text: "q4", kind: "computed", outcome: "answered", missing: [], reason: null, equipment: [], skipped: [], metrics: { worstZones: [{ equipmentId: "7", name: "VAV-2-14", judgedMinutes: 3000, inBandMinutes: 1140, percentInBand: 38, maxDeviationF: 5.8, worstHour: 14, setpointKind: "single" }] } },
        ],
        findings: [open, fresh, cleared],
      },
      { key: "vav", label: "VAV", status: "not_monitored", statusSentence: "The points this section needs are not trended.", questions: [{ key: "q06_vav_starved_airflow", position: 6, section: "vav", text: "q6", kind: "computed", outcome: "not_monitored", missing: ["airflow", "airflow setpoint"], reason: null, equipment: [], skipped: [], metrics: {} }], findings: [] },
      { key: "hot_water", label: "Hot Water", status: "not_applicable", statusSentence: "", questions: [], findings: [] },
      { key: "data_health", label: "Data Health", status: "watch", statusSentence: "", questions: [], findings: [flat] },
    ],
    cleared: [cleared],
    carriedForward: [open],
    plannerQuestions: [{ text: "Did the boiler cycle overnight?", note: "Custom questions are answered by the Analyze planner from Phase 6; not run in this report." }],
    cost: { inputTokens: 1200, outputTokens: 300, costUsd: 0.0108, budgetUsd: 2, model: "claude-opus-5-5", calls: 1 },
  };
}
