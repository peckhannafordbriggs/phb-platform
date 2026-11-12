import type { Finding, ReportDocument } from "@/lib/modules/bas/reports/engine/types";

/**
 * One report document, as the engine stores it on a run (Reports, Phase 2):
 * a building with one Space Comfort finding still open, one new, one
 * cleared, a Data Health finding at -40 °F with its two model sentences, a
 * collection incident of three points stopped together, a Not Monitored
 * section and a Not Applicable one, a partial reason, a cost and a
 * duration. Shared by the template test (tests/bas-reports-render.test.tsx)
 * and the loader test (tests/bas-reports-worker-render.test.ts), so the two
 * render the same document.
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
    equipmentId: null,
    subjectName: "points_RoomT",
    issueCode: "out_of_range",
    issue: "Out of physical range",
    priority: "watch",
    state: "new",
    fingerprint: "d".repeat(64),
    evidence: { actual: "read -40 °F", expected: "a room or return air temperature between 35 °F and 110 °F", percent: 100, duration: "5.0 days", when: "00:00-02:00" },
    likelyCause: "Likely an open circuit at the sensor, since -40 °F is the input's failure value.",
    recommendedAction: "Check the raw input and the sensor wiring at the controller for points_RoomT.",
    fixLocation: "site",
  });
  const incident = finding({
    questionKey: "q20_data_health",
    section: "data_health",
    subjectKey: "station:6@2026-09-29T17:00Z",
    equipmentId: null,
    subjectName: "PHBoffice",
    issueCode: "collection_stopped",
    issue: "Collection stopped",
    priority: "watch",
    state: "still_open",
    fingerprint: "e".repeat(64),
    firstSeenRunId: "7",
    firstSeenAt: "2026-11-04T10:00:00Z",
    evidence: {
      actual: "3 points stopped reporting at the same time, last readings 29 Sept, 13:00-13:10",
      expected: "each point reporting at its interval",
      duration: "6.8 days",
      durationMs: 6.8 * 86_400_000,
      when: "since 29 Sept, 13:00",
      stationId: "6",
      stationName: "PHBoffice",
      stoppedAt: "2026-09-29T17:00:00.000Z",
      count: 3,
      points: [
        { pointId: "67", name: "ROOM 130-132", issueCode: "offline", issue: "No readings", actual: "no readings in the period", expected: "a reading every 15 min", duration: "7.0 days", when: "last reading 29 Sept, 13:00", lastAt: 1790701200000 },
        { pointId: "53", name: "Outside_Air_Damper_Analog_Output1", issueCode: "offline", issue: "No readings", actual: "no readings in the period", expected: "a reading every 15 min", duration: "7.0 days", when: "last reading 29 Sept, 13:10", lastAt: 1790701800000 },
        { pointId: "62", name: "Supply_Temp_Analog_Input", issueCode: "offline", issue: "No readings", actual: "no readings in the period", expected: "a reading every 15 min", duration: "7.0 days", when: "last reading 29 Sept, 13:00", lastAt: 1790701200000 },
      ],
      causesInOrder: ["the device network trunk from the JACE to its controllers", "the histories stopped on the station", "the collector"],
    },
    likelyCause: "Likely the device network trunk from the JACE to its controllers dropped; possibly the histories stopped on the station, or the collector stopped reading it.",
    recommendedAction: "Open the JACE's device network in Workbench and check whether the controllers are online.",
    fixLocation: "remote",
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
      durationMs: 25_400,
      status: "partial",
      partialReason: "Q6 could run but has no analysis yet",
    },
    inventory: {
      equipmentTypesFound: [
        { equipType: "vav", label: "VAV Box", count: 10 },
        { equipType: "rtu", label: "Rooftop Unit", count: 1 },
      ],
      classification: [{ equipmentId: "1", name: "RV", equipType: "rtu", text: "DX (by type; compressors not trended) with economizer" }],
      requiredPointsFound: 3,
      requiredPointsTotal: 9,
      lowCoverage: [{ name: "VAV-5 ZoneTemperature", coverage: 0.61 }],
      notMonitored: [{ position: 6, key: "q06_vav_starved_airflow", text: "Which VAVs ran below 80% of airflow setpoint while occupied?", missing: ["airflow", "airflow setpoint"] }],
      notApplicable: [{ position: 13, key: "q13_hw_supply_and_delta_t", text: "Did HW supply temp hold setpoint?", reason: "no hydronic heating on this building" }],
      occupancy: [{ stationName: "PHBoffice", kind: "point", detail: "Occupied (occupancy status point)" }],
      pointsInScope: 26,
      equipmentInScope: 11,
    },
    summary: { status: "action_needed", topFindings: [open, fresh, incident], counts: { new: 2, stillOpen: 2, cleared: 1 }, siteVisit: ["VAV-2-14"], remoteFix: ["PHBoffice"] },
    sections: [
      {
        key: "space_comfort",
        label: "Space Comfort",
        status: "action_needed",
        statusSentence: "VAV-2-14 was above setpoint for most of the occupied hours.",
        questions: [
          { key: "q03_zone_comfort", position: 3, section: "space_comfort", text: "q3", kind: "computed", outcome: "answered", missing: [], reason: null, equipment: ["VAV-2-14"], skipped: [], metrics: { overallPercentInBand: 81.5 } },
          { key: "q04_worst_zones", position: 4, section: "space_comfort", text: "q4", kind: "computed", outcome: "answered", missing: [], reason: null, equipment: [], skipped: [], metrics: { worstZones: [{ equipmentId: "7", name: "VAV-2-14", judgedMinutes: 3000, inBandMinutes: 1140, percentInBand: 38, maxDeviationF: 5.8, worstHour: 14, setpointKind: "single" }] } },
          { key: "q05_manual_overrides", position: 5, section: "space_comfort", text: "q5", kind: "computed", outcome: "not_monitored", missing: ["override or priority status"], reason: null, equipment: [], skipped: [], metrics: {} },
        ],
        findings: [open, fresh, cleared],
      },
      {
        key: "vav",
        label: "VAV",
        status: "not_monitored",
        statusSentence: "Not monitored — needs airflow; airflow setpoint; see Point Inventory.",
        questions: [
          { key: "q06_vav_starved_airflow", position: 6, section: "vav", text: "q6", kind: "computed", outcome: "not_monitored", missing: ["airflow", "airflow setpoint"], reason: null, equipment: [], skipped: [], metrics: {} },
          { key: "q07_vav_damper_full_missed_setpoint", position: 7, section: "vav", text: "q7", kind: "computed", outcome: "not_monitored", missing: ["damper position", "airflow setpoint"], reason: null, equipment: [], skipped: [], metrics: {} },
        ],
        findings: [],
      },
      { key: "hot_water", label: "Hot Water", status: "not_applicable", statusSentence: "", questions: [], findings: [] },
      { key: "data_health", label: "Data Health", status: "watch", statusSentence: "Data Health is on watch because three points on PHBoffice stopped together and points_RoomT reads -40 °F.", questions: [], findings: [incident, flat] },
    ],
    cleared: [cleared],
    carriedForward: [open],
    plannerQuestions: [{ text: "Did the boiler cycle overnight?", note: "Custom questions are answered by the Analyze planner from Phase 6; not run in this report." }],
    cost: { inputTokens: 1200, outputTokens: 300, costUsd: 0.0108, budgetUsd: 2, model: "claude-opus-5-5", calls: 1 },
  };
}
