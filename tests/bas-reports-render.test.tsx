import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { REPORT_CSS, ReportView } from "@/lib/modules/bas/reports/engine/render";
import { renderReportHtml } from "@/lib/modules/bas/reports/engine/html";
import { reportDocument as document } from "./fixtures/bas-report-document";
import { NARRATIVE_SYSTEM, createFixedNarrator, narrativeUserMessage } from "@/lib/modules/bas/reports/engine/narrative";

/**
 * The template (Reports, Phase 2) as rendered from a document, and the
 * narrative prompt held to the voice spec. Pure.
 */

describe("the report template", () => {
  const html = renderToStaticMarkup(createElement(ReportView, { document: document() }));

  it("follows the spec's template: inventory, summary, sections, data health, carried forward", () => {
    expect(html).toContain("PHB Steel Place BAS Health Report");
    expect(html).toContain("0. Point Inventory");
    expect(html).toContain("1. Summary");
    expect(html).toContain("Space Comfort");
    expect(html).toContain("Data Health");
    expect(html).toContain("Open Items Carried Forward");
    expect(html).toContain("Outdoor conditions: avg 61.2°F, high 78.4°F, low 44.1°F");
    expect(html).toContain("22 Sept 2026 to 29 Sept 2026");
  });

  it("drops a Not Applicable section, lists Not Monitored with the missing points, and names low coverage", () => {
    expect(html).not.toContain("Hot Water");
    expect(html).toContain("Q6: missing airflow; airflow setpoint");
    expect(html).toContain("Not Monitored");
    expect(html).toContain("Q13 (no hydronic heating on this building)");
    expect(html).toContain("VAV-5 ZoneTemperature (61%)");
    expect(html).toContain("Required points found: 3 of 9");
    expect(html).toContain("Occupied (occupancy status point)");
  });

  it("marks every finding New, Still open or Cleared, and carries forward with the first-seen date", () => {
    expect(html).toContain(">Still open<");
    expect(html).toContain(">New<");
    expect(html).toContain(">Cleared<");
    expect(html).toContain("Cleared since the previous report");
    expect(html).toContain("14 Oct");
    expect(html).toContain("New this period: 2 / Cleared this period: 1 / Still open: 1");
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
    expect(html).toContain("$0.0108 of $2.00");
    expect(html).toContain("Did the boiler cycle overnight?");
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
