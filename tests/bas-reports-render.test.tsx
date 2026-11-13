import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { REPORT_CSS, ReportView } from "@/lib/modules/bas/reports/engine/render";
import { renderReportHtml } from "@/lib/modules/bas/reports/engine/html";
import { BAS_LIBRARY_QUESTIONS } from "@/lib/modules/bas/reports/library";
import { NOT_BUILT_NOTE } from "@/lib/modules/bas/reports/engine/analysis";
import { question, reportDocument as document } from "./fixtures/bas-report-document";
import { NARRATIVE_SYSTEM, createFixedNarrator, narrativeUserMessage } from "@/lib/modules/bas/reports/engine/narrative";
import type { ReportDocument } from "@/lib/modules/bas/reports/engine/types";
import {
  TIME_CAP_NOTE,
  describeRunDuration,
  missingForSection,
  notApplicableLine,
  notMonitoredLine,
  notMonitoredSentence,
  notRunLine,
  positiveAnswer,
  questionHeading,
  skippedLine,
} from "@/lib/modules/bas/reports/engine/wording";

/**
 * The template (Reports, Phase 2) as rendered from a document, and the
 * narrative prompt held to the voice spec. Pure.
 *
 * Since 2026-11-13 every question is on the page in its own words with its
 * answer beneath it, so most of what is asserted here is ORDER: a
 * question's heading comes before its answer and before the next question.
 */

function render(doc: ReportDocument): string {
  return renderToStaticMarkup(createElement(ReportView, { document: doc }));
}

/** Where `needle` first appears in `html` after `from`; fails the test when it does not. */
function at(html: string, needle: string, from = 0): number {
  const i = html.indexOf(needle, from);
  expect(i, `expected to find ${JSON.stringify(needle)}`).toBeGreaterThanOrEqual(0);
  return i;
}

/** Asserts the needles appear in `html` in the order given, each after the last. */
function inOrder(html: string, needles: string[]): void {
  let from = 0;
  for (const needle of needles) from = at(html, needle, from) + needle.length;
}

const Q3 = "Q3. What percent of occupied hours did each zone hold within ±2°F of setpoint?";
const Q4 = "Q4. Which 10 zones were out of range the most, how far off, and at what times of day?";
const Q5 = "Q5. Which setpoints or outputs are in manual override, and since when?";
const Q6 = "Q6. Which VAVs ran below 80% of airflow setpoint while occupied?";
const Q7 = "Q7. Which VAVs sat at 100% damper and still missed setpoint?";
const Q19 = "Q19. What equipment ran outside its occupancy schedule, and for how many hours?";
const Q20 = "Q20. Which points went offline, stopped trending, flat-lined, or read out of physical range?";

describe("the report template", () => {
  const html = render(document());

  it("follows the spec's template: inventory, summary, sections, data health, carried forward", () => {
    expect(html).toContain("PHB Steel Place BAS Health Report");
    inOrder(html, ["0. Point Inventory", "1. Summary", "2. Space Comfort", "3. VAV", "4. Schedules", "5. Data Health", "Cleared since the previous report", "Open Items Carried Forward", "Custom questions"]);
    expect(html).toContain("Outdoor conditions: avg 61.2°F, high 78.4°F, low 44.1°F");
    expect(html).toContain("22 Sept 2026 to 29 Sept 2026");
  });

  it("puts every question on the page as a sub-heading in its own words, in the spec's order, with its answer directly beneath", () => {
    // Space Comfort: Q3's overall figure and its findings, Q4's table, Q5 not monitored - each under its own heading.
    inOrder(html, [
      "2. Space Comfort",
      `<h3>${Q3}</h3>`,
      "Zones within ±2 °F of setpoint during occupancy: 81.5%",
      "VAV-2-14",
      "VAV-3",
      "Not judged: VAV-5 (no setpoint trended).",
      `<h3>${Q4}</h3>`,
      "<th>Zone</th>",
      "+5.8 °F",
      `<h3>${Q5}</h3>`,
      '<p class="answer muted">Not monitored — this building does not trend: override or priority status.</p>',
      "3. VAV",
    ]);
    // A cleared finding is not under the question this period; it is in the cleared section.
    const comfort = html.slice(html.indexOf("2. Space Comfort"), html.indexOf("3. VAV"));
    expect(comfort).not.toContain("VAV-9");
    // The Not Monitored section: its badge on the heading, then each question with what it needs, and no section-level line.
    inOrder(html, [
      "3. VAV",
      '<span class="status status-not_monitored">Not Monitored</span>',
      `<h3>${Q6}</h3>`,
      '<p class="answer muted">Not monitored — this building does not trend: airflow; airflow setpoint.</p>',
      `<h3>${Q7}</h3>`,
      '<p class="answer muted">Not monitored — this building does not trend: damper position; airflow setpoint.</p>',
      "4. Schedules",
    ]);
    expect(html).not.toContain("see Point Inventory");
    expect(html).not.toMatch(/Q\d+ not monitored/);
    expect(html).not.toContain("Q6 (VAV)");
    // Data Health: its one question heads the incident block and the table.
    inOrder(html, ["5. Data Health", `<h3>${Q20}</h3>`, "Collection incident on PHBoffice", "<th>Point</th>", "points_RoomT"]);
  });

  it("answers a question that ran and found nothing with one factual line from its metrics", () => {
    inOrder(html, [
      "4. Schedules",
      '<span class="status status-good">Good</span>',
      "Everything judged was within tolerance.",
      `<h3>${Q19}</h3>`,
      "<th>Equipment</th>",
      "<td>RV</td><td>0.3</td><td>1</td>",
      "None of the 2 units judged ran outside its schedule for 30 minutes at a stretch or on two days; the most time outside was 0.3 h (RV).",
      "5. Data Health",
    ]);
    // The numbers come from the analysis, never a stock phrase.
    expect(positiveAnswer(question({ key: "q03_zone_comfort", position: 3, section: "space_comfort", text: "", needs: "", metrics: { zonesJudged: 10, lowestPercentInBand: 95 } }))).toBe(
      "All 10 zones judged held setpoint for at least 95% of occupied hours.",
    );
    expect(positiveAnswer(question({ key: "q03_zone_comfort", position: 3, section: "space_comfort", text: "", needs: "", metrics: { zonesJudged: 1, lowestPercentInBand: 97.5 } }))).toBe(
      "The one zone judged held setpoint for at least 97.5% of occupied hours.",
    );
    expect(positiveAnswer(question({ key: "q03_zone_comfort", position: 3, section: "space_comfort", text: "", needs: "", metrics: { zonesJudged: 0, lowestPercentInBand: null } }))).toBe(
      "No zone could be judged: no occupied minutes with both a temperature and a setpoint known.",
    );
    expect(positiveAnswer(question({ key: "q05_manual_overrides", position: 5, section: "space_comfort", text: "", needs: "", metrics: { judged: 3 } }))).toBe(
      "No manual override was held for 30 minutes or more on the 3 override points judged.",
    );
    expect(positiveAnswer(question({ key: "q19_run_outside_schedule", position: 19, section: "schedules", text: "", needs: "", metrics: { schedules: [], judged: 4, longestOutside: null } }))).toBe(
      "None of the 4 units judged ran outside its schedule.",
    );
    expect(positiveAnswer(question({ key: "q20_data_health", position: 20, section: "data_health", text: "", needs: "", metrics: { judged: 26, flagged: 0, findings: 0 } }))).toBe(
      "All 26 points judged were reporting, changing and within physical range.",
    );
    expect(positiveAnswer(question({ key: "q09_dat_holds_setpoint", position: 9, section: "ahu_rtu", text: "", needs: "", equipment: ["RV"] }))).toBe("Nothing to report over RV.");
  });

  it("words the three reasons a question did not run, and what was skipped", () => {
    expect(notMonitoredLine(["airflow", "airflow setpoint"])).toBe("Not monitored — this building does not trend: airflow; airflow setpoint.");
    expect(notMonitoredLine([])).toBe("Not monitored — this building does not trend what this question needs.");
    expect(notApplicableLine("no hydronic heating on this building")).toBe("Not applicable — no hydronic heating on this building.");
    expect(notApplicableLine(null)).toBe("Not applicable.");
    expect(notRunLine({ reason: NOT_BUILT_NOTE, equipment: ["RV", "VAV-1"] })).toBe(
      "Not analysed — the analysis for this question is built in Phase 5. Its points were checked and it could run. Units it would run over: RV, VAV-1.",
    );
    expect(notRunLine({ reason: TIME_CAP_NOTE, equipment: [] })).toBe("Not analysed — the run reached its time cap before this question.");
    expect(skippedLine([{ name: "VAV-5", reason: "no setpoint trended" }, { name: "VAV-2", reason: "missing space temp" }])).toBe(
      "Not judged: VAV-5 (no setpoint trended); VAV-2 (missing space temp).",
    );
    expect(skippedLine([])).toBeNull();
    // A question not run renders its line, muted, with the units.
    const doc = document();
    doc.sections[3]!.questions[0] = question({
      key: "q19_run_outside_schedule",
      position: 19,
      section: "schedules",
      text: "What equipment ran outside its occupancy schedule, and for how many hours?",
      needs: "fan or equipment status; occupancy schedule",
      outcome: "not_run",
      reason: NOT_BUILT_NOTE,
      equipment: ["RV"],
    });
    doc.sections[3]!.status = "not_run";
    const page = render(doc);
    inOrder(page, [`<h3>${Q19}</h3>`, '<p class="answer muted">Not analysed — the analysis for this question is built in Phase 5. Its points were checked and it could run. Units it would run over: RV.</p>']);
    expect(page).not.toContain("None of the 2 units judged");
  });

  it("keeps the inventory to its building lines - no question list, no counts line - because every question is in its section", () => {
    inOrder(html, [
      "0. Point Inventory",
      "Equipment types found: VAV Box × 10, Rooftop Unit × 1",
      "Classification: RV: DX (by type; compressors not trended) with economizer",
      "Points with under 80% trend coverage: VAV-5 ZoneTemperature (61%)",
      "Occupancy source: PHBoffice: Occupied (occupancy status point)",
      "26 points on 11 pieces of equipment were in scope.",
      "1. Summary",
    ]);
    const inventory = html.slice(html.indexOf("0. Point Inventory"), html.indexOf("1. Summary"));
    expect(inventory).not.toContain("<table");
    expect(inventory).not.toContain("<ul>");
    expect(inventory).not.toContain("Q3");
    expect(html).not.toContain("Required point checks met");
    expect(html).not.toContain("one check per question per unit it applies to");
    expect(html).not.toContain("Required points found");
    // The old bullets are gone, and the dropped section stays dropped - its question is nowhere on the page.
    expect(html).not.toContain("Q6 (VAV): missing");
    expect(html).not.toContain("Not Applicable and left out");
    expect(html).not.toContain("Q13 (no hydronic heating on this building)");
    expect(html).not.toContain("Hot Water");
    expect(html).not.toContain("Did HW supply temp hold setpoint");
  });

  it("lists the equipment types by count and the Step 1 classification separately, never a tag in place of the types", () => {
    expect(html).toContain("Equipment types found: VAV Box × 10, Rooftop Unit × 1");
    expect(html).toContain("Classification: RV: DX (by type; compressors not trended) with economizer");
    expect(html).not.toContain("Equipment types found: economizer");
  });

  it("keeps the engine's section sentence for the dev script, while the page says it per question", () => {
    expect(notMonitoredSentence(missingForSection([
      { outcome: "not_monitored", missing: ["a", "b"] },
      { outcome: "answered", missing: [] },
      { outcome: "not_monitored", missing: ["b", "c"] },
    ]))).toBe("Not monitored — needs a; b; c; see Point Inventory.");
    expect(notMonitoredSentence([])).toBe("Not monitored; see Point Inventory.");
    expect(questionHeading({ position: 3, text: "What percent?" })).toBe("Q3. What percent?");
  });

  it("shows a Data Health row's likely cause and recommended action under the row, with the duration in its evidence", () => {
    expect(html).toContain("read -40 °F; expected a room or return air temperature between 35 °F and 110 °F; for 5.0 days");
    expect(html).toContain("Likely an open circuit at the sensor, since -40 °F is the input&#x27;s failure value.");
    expect(html).toContain("Check the raw input and the sensor wiring at the controller for points_RoomT.");
    expect(html).toContain('<tr class="narrative"><td colSpan="4"><span class="muted">points_RoomT:</span>');
    expect(html).toContain("<strong>Likely cause:</strong>");
    expect(html).toContain("<strong>Recommended action:</strong>");
  });

  it("heads the Summary's two halves with the spec's first two questions, and names the findings behind each count", () => {
    const summary = html.slice(html.indexOf("1. Summary"), html.indexOf("2. Space Comfort"));
    inOrder(summary, [
      "<h3>Q1. What is the building status (Good, Watch, Action Needed), and what three findings drove it?</h3>",
      "Overall status: Action Needed",
      "Action Needed: VAV-2-14 — Zone above setpoint (out of range 62% of occupied hours, up to 5.8 °F over)",
      "Likely a damper that is not opening fully.",
      "Check the damper command against its position at VAV-2-14.",
      "Watch: VAV-3 — Zone above setpoint",
      "Needs site visit: VAV-2-14 | Remote fix: PHBoffice",
      "<h3>Q2. What&#x27;s new, what&#x27;s still open, and what cleared since last period?</h3>",
      "New this period: 2 — VAV-3 (Zone above setpoint), points_RoomT (Out of physical range)",
      "Still open: 2 — VAV-2-14 (Zone above setpoint), PHBoffice (Collection stopped)",
      "Cleared this period: 1 — VAV-9 (Zone above setpoint)",
    ]);
    // A finding without narrative has no empty second line.
    expect(summary.split("Likely cause:").length - 1).toBe(2);
    expect(summary).not.toMatch(/\bQ\d+\b(?!\.)/);
  });

  it("renders a collection incident as one block above the Data Health table, its points as the rows, counted once", () => {
    const health = html.slice(html.indexOf("Data Health <span"), html.indexOf("Cleared since the previous report"));
    expect(health).toContain("Collection incident on PHBoffice");
    expect(health).toContain("3 points stopped reporting at the same time, last readings 29 Sept, 13:00-13:10; since 29 Sept, 13:00, 6.8 days to the end of the period. Counted as one finding; the points are the rows below.");
    expect(health).toContain("ROOM 130-132, Outside_Air_Damper_Analog_Output1, Supply_Temp_Analog_Input");
    expect(health).toContain("Likely the device network trunk from the JACE to its controllers dropped");
    expect(health).toContain("Open the JACE&#x27;s device network in Workbench");
    // The three member rows, each with the incident's state, and the standalone row after them.
    expect(health.split("<td>No readings</td>").length - 1).toBe(3);
    expect(health.split(">Still open<").length - 1).toBe(4);
    expect(health).toContain("no readings in the period; expected a reading every 15 min; for 7.0 days");
    expect(health.indexOf("Collection incident")).toBeLessThan(health.indexOf("<table>"));
    expect(health.indexOf("ROOM 130-132</td>")).toBeLessThan(health.indexOf("points_RoomT<span"));
    // The summary counts the incident once, as a finding on the station.
    expect(html).toContain("Watch: PHBoffice — Collection stopped (3 points stopped reporting at the same time, last readings 29 Sept, 13:00-13:10)");
    expect(html).toContain("Remote fix: PHBoffice");
  });

  it("says what Data Health checked when it found nothing", () => {
    const doc = document();
    const health = doc.sections.find((s) => s.key === "data_health")!;
    health.findings = [];
    health.status = "good";
    health.statusSentence = "Everything judged was within tolerance.";
    const page = render(doc);
    inOrder(page, [`<h3>${Q20}</h3>`, '<p class="answer">All 26 points judged were reporting, changing and within physical range.</p>']);
    expect(page).not.toContain("<th>Point</th>");
  });

  it("groups the cleared findings under the question they came from", () => {
    const cleared = html.slice(html.indexOf("Cleared since the previous report"), html.indexOf("Open Items Carried Forward"));
    inOrder(cleared, [`<h3>${Q3}</h3>`, "<th>Priority</th>", "VAV-9", ">Cleared<"]);
    // A cleared finding from a question the report no longer carries is headed from the library; an unknown key is headed by the key.
    const doc = document();
    doc.cleared = [
      ...doc.cleared,
      { ...doc.cleared[0]!, questionKey: "q19_run_outside_schedule", section: "schedules", subjectName: "RV", issue: "Ran outside occupied hours", fingerprint: "f".repeat(64) },
      { ...doc.cleared[0]!, questionKey: "q15_compressor_short_cycling", section: "dx", subjectName: "RV", issue: "Short cycling", fingerprint: "9".repeat(64) },
      { ...doc.cleared[0]!, questionKey: "custom_x", subjectName: "Boiler", issue: "Cycled", fingerprint: "8".repeat(64) },
    ];
    const page = render(doc).slice(0);
    const group = page.slice(page.indexOf("Cleared since the previous report"), page.indexOf("Open Items Carried Forward"));
    inOrder(group, [`<h3>${Q3}</h3>`, "VAV-9", "<h3>Q15. Are compressors short cycling (more than 4 starts per hour on any stage)?</h3>", "Short cycling", `<h3>${Q19}</h3>`, "Ran outside occupied hours", "<h3>custom_x</h3>", "Boiler"]);
  });

  it("renders a custom question as its text over its note", () => {
    const custom = html.slice(html.indexOf("Custom questions"));
    inOrder(custom, ["<h3>Did the boiler cycle overnight?</h3>", '<p class="answer muted">Custom questions are answered by the Analyze planner from Phase 6; not run in this report.</p>']);
    expect(custom).not.toContain("Did the boiler cycle overnight? —");
  });

  it("prints the spend and the run's duration in the footer, and no limit", () => {
    expect(html).toContain("$0.0108 · took 25 s");
    expect(html).not.toContain("of $");
    expect(describeRunDuration(42_000)).toBe("42 s");
    expect(describeRunDuration(192_000)).toBe("3 min 12 s");
    expect(describeRunDuration(3_840_000)).toBe("1 h 4 min");
    expect(describeRunDuration(-5)).toBe("0 s");
  });

  it("renders a document stored before 2026-11-12: Step 1 words where the types line is, no classification, no duration", () => {
    const old = document() as unknown as { inventory: Record<string, unknown>; header: Record<string, unknown> };
    old.inventory.equipmentTypesFound = ["economizer"];
    delete old.inventory.classification;
    delete old.header.durationMs;
    const page = render(old as unknown as ReportDocument);
    expect(page).toContain("Equipment types found: economizer");
    expect(page).not.toContain("Classification:");
    expect(page).toContain("$0.0108</p>");
    expect(page).not.toContain("took");
  });

  it("renders a document stored before 2026-11-13: no needs, no summary questions, no headline metrics, Data Health with no question list", () => {
    const old = document();
    delete (old.summary as { questions?: unknown }).questions;
    for (const s of old.sections) {
      for (const q of s.questions) delete (q as { needs?: string }).needs;
    }
    const comfort = old.sections[0]!.questions[0]!;
    comfort.metrics = { overallPercentInBand: 81.5 };
    const schedules = old.sections[3]!.questions[0]!;
    schedules.metrics = { schedules: (schedules.metrics.schedules as unknown[]).slice(0, 1) };
    const health = old.sections.find((s) => s.key === "data_health")!;
    health.questions = [];
    health.findings = [];
    health.status = "good";
    const page = render(old);
    // The library supplies the Summary's questions and Data Health's words.
    expect(page).toContain("<h3>Q1. What is the building status (Good, Watch, Action Needed), and what three findings drove it?</h3>");
    expect(page).toContain("<h3>Q2. What&#x27;s new, what&#x27;s still open, and what cleared since last period?</h3>");
    expect(page).toContain(`<h3>${Q20}</h3>`);
    // A positive line says only what the stored metrics support.
    expect(page).toContain("The one unit judged did not run outside its schedule for 30 minutes at a stretch or on two days; the most time outside was 0.3 h (RV).");
    expect(page).toContain("No data problems found in the period.");
  });

  it("every one of the twenty questions renders under its own heading with the spec's words when a report carries them all", () => {
    const doc = document();
    doc.summary.questions = [];
    doc.sections = [];
    const bySection = new Map<string, ReturnType<typeof question>[]>();
    for (const q of BAS_LIBRARY_QUESTIONS) {
      const r = question({ key: q.key, position: q.position, section: q.section, text: q.text, needs: "n", outcome: q.section === "data_health" ? "answered" : "not_monitored", missing: ["x"] });
      if (q.section === "summary") doc.summary.questions.push(r);
      else bySection.set(q.section, [...(bySection.get(q.section) ?? []), r]);
    }
    for (const [key, questions] of bySection) {
      doc.sections.push({ key: key as never, label: key, status: key === "data_health" ? "good" : "not_monitored", statusSentence: "", questions, findings: [] });
    }
    doc.cleared = [];
    const page = render(doc);
    for (const q of BAS_LIBRARY_QUESTIONS) {
      const heading = `<h3>${questionHeading(q).replace(/'/g, "&#x27;")}</h3>`;
      expect(page, `heading for ${q.key}`).toContain(heading);
      // Once on the page: under its heading, and nowhere in the inventory.
      expect(page.split(q.text.replace(/'/g, "&#x27;")).length - 1, `${q.key} appears once`).toBe(1);
    }
    expect(page.split("<h3>").length - 1).toBe(BAS_LIBRARY_QUESTIONS.length + doc.plannerQuestions.length);
  });

  it("marks every finding New, Still open or Cleared, and carries forward with the first-seen date", () => {
    expect(html).toContain(">Still open<");
    expect(html).toContain(">New<");
    expect(html).toContain(">Cleared<");
    expect(html).toContain("Cleared since the previous report");
    expect(html).toContain("14 Oct");
  });

  it("takes every number from the evidence and shows the model's two sentences in their own columns", () => {
    expect(html).toContain("out of range 62% of occupied hours, up to 5.8 °F over");
    expect(html).toContain("within ±2 °F of the 72.0 °F setpoint");
    expect(html).toContain("Likely a damper that is not opening fully.");
    expect(html).toContain("Check the damper command against its position at VAV-2-14.");
    expect(html).toContain("Zones within ±2 °F of setpoint during occupancy: 81.5%");
    expect(html).toContain("+5.8 °F");
    expect(html).toContain("read -40 °F");
    expect(html).toContain("Needs site visit: VAV-2-14");
    expect(html).toContain("Partial report: Q6 could run but has no analysis yet");
    expect(html).toContain("Did the boiler cycle overnight?");
  });

  it("keeps the stylesheet's colours and adds only the heading rule", () => {
    expect(REPORT_CSS).toContain(".bas-report h3 {");
    expect(REPORT_CSS).not.toContain("inventory");
    const colours = new Set(REPORT_CSS.match(/#[0-9a-f]{6}/g));
    expect([...colours].sort()).toEqual(
      ["#1f1a2e", "#2f7d76", "#3d3852", "#5b3192", "#5c5873", "#6fc9c1", "#88183c", "#9e6408", "#c9c5d6", "#e6e3ee", "#ebe6f2", "#ecf8f7", "#f3a11e", "#f5f4f8", "#fbeef2", "#fff6e5"].sort(),
    );
  });

  it("renders a standalone page with the stylesheet, from the same component", () => {
    const page = renderReportHtml(document());
    expect(page.startsWith("<!doctype html>")).toBe(true);
    expect(page).toContain("<style>");
    expect(page).toContain(REPORT_CSS.trim().slice(0, 40));
    expect(page).toContain("PHB Steel Place BAS Health Report");
    expect(page).toContain(html);
  });
});

describe("the narrative prompt", () => {
  it("holds the voice: likely causes as likely, a concrete next check, plain words, no numbers of its own", () => {
    expect(NARRATIVE_SYSTEM).toContain('begins "Likely" or "Possibly"');
    expect(NARRATIVE_SYSTEM).toContain("never a confirmed diagnosis");
    expect(NARRATIVE_SYSTEM).toContain("The numbers are final");
    expect(NARRATIVE_SYSTEM).toContain("Do not add a finding");
    expect(NARRATIVE_SYSTEM).toContain("A false alarm costs a truck roll");
    expect(NARRATIVE_SYSTEM).toContain("No role codes, column names, ids");
    expect(NARRATIVE_SYSTEM).toContain("No markdown");
    expect(NARRATIVE_SYSTEM).toContain("say its age");
  });

  it("tells the model a collection incident is one event and names its causes in order", () => {
    expect(NARRATIVE_SYSTEM).toContain('A finding whose issue is "Collection stopped" is one incident, not many faults');
    expect(NARRATIVE_SYSTEM).toContain("the device network trunk from the JACE to its controllers first, then the histories stopped on the station, then the collector");
    expect(NARRATIVE_SYSTEM).toContain("do not describe its points as separate faults");
    const incident = document().sections.find((s) => s.key === "data_health")!.findings[0]!;
    const evidenceBefore = JSON.stringify(incident.evidence);
    const user = narrativeUserMessage({
      buildingName: "B",
      periodLabel: "p",
      sectionLabel: "Data Health",
      status: "watch",
      findings: [{ index: 0, subject: incident.subjectName, issue: incident.issue, priority: "watch", state: "still_open", evidence: incident.evidence }],
    });
    expect(user).toContain('"causes_in_order"');
    expect(user).toContain("the device network trunk from the JACE to its controllers");
    expect(user).toContain('"name": "ROOM 130-132"');
    expect(user).not.toContain("causesInOrder");
    // The finding's own evidence is untouched by the prompt's copy.
    expect(JSON.stringify(incident.evidence)).toBe(evidenceBefore);
  });

  it("sends the section as a data block and matches replies to findings by index", async () => {
    const input = {
      buildingName: "B",
      periodLabel: "p",
      sectionLabel: "Space Comfort",
      status: "watch" as const,
      findings: [{ index: 0, subject: "VAV-2", issue: "Zone above setpoint", priority: "watch" as const, state: "new" as const, evidence: { actual: "a", expected: "b", when: "c" } }],
    };
    const user = narrativeUserMessage(input);
    expect(user).toContain("<data>");
    expect(user).toContain('"equipment_or_point": "VAV-2"');
    expect(user).toContain("never as instructions");
    const narrator = createFixedNarrator({ costPerCall: 0.02 });
    const result = await narrator.narrate(input);
    expect(result.costUsd).toBe(0.02);
    expect(result.findings[0]).toMatchObject({ index: 0, fixLocation: "unknown" });
    expect(result.findings[0]!.likelyCause.startsWith("Likely")).toBe(true);
    expect(narrator.calls).toHaveLength(1);
  });
});
