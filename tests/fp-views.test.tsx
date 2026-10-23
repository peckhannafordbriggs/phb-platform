import { describe, expect, it, vi } from "vitest";

/**
 * The Register and Report as they actually RENDER, for every branch of the
 * procedure. The service tests prove the data; these prove each state reaches
 * the screen as words (the module's colour rule: orange is both identity and
 * warning, so no state may be colour alone).
 *
 * next/navigation is stubbed because the views are client components and the
 * hooks need a router. Nothing else is mocked.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/freeze-protection",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RegisterView } from "@/app/(modules)/freeze-protection/views/register-view";
import { ReportView } from "@/app/(modules)/freeze-protection/views/report-view";
import type { FpHistoryEntry, FpLine, FpProject } from "@/lib/modules/freeze-protection/types";

const PROJECT: FpProject = {
  id: "1",
  jobNumber: "26-104A",
  name: "Riverside MOB",
  verificationDate: "2026-11-01",
  completed: { employeeId: "a", name: "Dana Whitfield", at: "2026-11-01T15:00:00.000Z" },
  reviewed: { employeeId: "b", name: "Lee Park", at: "2026-11-02T15:00:00.000Z" },
  transmittedTo: "Turner CM",
  transmittedDate: "2026-11-03",
  changedAfterReview: false,
  equipmentCount: 5,
};

const PASSED = { fanStops: "yes", damperCloses: "yes", valveFullFlow: "yes", manualReset: "yes" } as const;

function line(id: string, overrides: Partial<FpLine> = {}): FpLine {
  return {
    id,
    name: `AHU-${id}`,
    equipmentType: "AHU",
    areaServed: "Level 1",
    coil: null,
    status: "service",
    exposure: null,
    protection: null,
    test: { answers: {}, tripTempF: null, testedBy: null, testDate: null, elements: null },
    notification: null,
    deficiency: null,
    documentation: null,
    notes: null,
    updatedAt: "2026-11-01T15:00:00.000Z",
    updatedBy: "Dana Whitfield",
    ...overrides,
  };
}

const NO_PROTECTION = line("1", { coil: "glycol", exposure: "yes", protection: "none" });
const FAILED = line("2", {
  coil: "water",
  exposure: "yes",
  protection: "manual",
  test: { answers: { ...PASSED, damperCloses: "no" }, tripTempF: "38", testedBy: "C. Moreno", testDate: "2026-10-30", elements: null },
  deficiency: { description: "OA damper actuator does not stroke closed.", owner: "PH+B controls", due: "2026-11-08" },
});
const VERIFIED = line("3", {
  coil: "water",
  exposure: "yes",
  protection: "manual",
  test: { answers: PASSED, tripTempF: "37", testedBy: "C. Moreno", testDate: "2026-10-30", elements: null },
  documentation: { with: "owner", name: "R. Patel", date: "2026-10-31", method: "Email" },
});
const NO_COIL = line("4", { coil: "none", name: "EF-1", equipmentType: null, areaServed: null });
const OPEN = line("5", { coil: "water" });
const LINES = [NO_PROTECTION, FAILED, VERIFIED, NO_COIL, OPEN];
const HISTORY: FpHistoryEntry[] = [
  { id: "h2", at: "2026-10-30T18:05:00.000Z", sentence: "Chris Moreno recorded the damper test for AHU-2 on job 26-104A" },
  { id: "h1", at: "2026-10-29T14:00:00.000Z", sentence: "Dana Whitfield added AHU-2 to the job 26-104A register" },
];

const register = (props: Partial<Parameters<typeof RegisterView>[0]>) =>
  renderToStaticMarkup(
    createElement(RegisterView, { project: PROJECT, lines: LINES, selected: null, history: [], panel: null, today: "2026-11-01", ...props }),
  );

describe("Register", () => {
  it("offers a new project when there are none", () => {
    const html = register({ project: null, lines: [] });
    expect(html).toContain("No projects yet");
    expect(html).toContain("New project");
  });

  it("asks for the schedule when the project has no equipment", () => {
    expect(register({ lines: [] })).toContain("List every unit on the mechanical equipment schedule");
  });

  it("lists every unit by name with its disposition in words, the funnel, and Add equipment; no buildings or rounds", () => {
    const html = register({});
    for (const label of ["No protection", "Test failed", "Verified", "Closed, no coil", "Step 3 open"]) expect(html).toContain(label);
    expect(html).toContain("Equipment · 5");
    expect(html).toContain("Add equipment");
    expect(html).toContain(">Name</span>");
    expect(html).not.toContain(">Tag</span>");
    expect(html).not.toContain("Building");
    expect(html).not.toContain("New verification");
  });

  it("shows the verification date and where the signoff stands", () => {
    expect(register({})).toContain("Reviewed");
    expect(register({ project: { ...PROJECT, reviewed: null } })).toContain("Completed, awaiting review");
    expect(register({ project: { ...PROJECT, changedAfterReview: true } })).toContain("Changed after review");
  });

  it("no protection: the stop and the notice fields, not the test", () => {
    const html = register({ selected: NO_PROTECTION });
    expect(html).toContain("Stop.");
    expect(html).toContain("Notified");
    expect(html).not.toContain("Test the safety");
  });

  it("failed test: the tests and the deficiency, not step 6", () => {
    const html = register({ selected: FAILED });
    expect(html).toContain("Outside air damper drives closed");
    expect(html).toContain("Deficiency.");
    expect(html).not.toContain("Documented with the owner");
  });

  it("verified: step 6 shows", () => {
    expect(register({ selected: VERIFIED })).toContain("Documented with the owner or controls vendor");
  });

  it("names the optional fields as optional", () => {
    const html = register({ selected: OPEN });
    expect(html).toContain("Equipment type (optional)");
    expect(html).toContain("Area served (optional)");
  });

  it("shows the unit's history with timestamps", () => {
    const html = register({ selected: FAILED, history: HISTORY });
    expect(html).toContain("History");
    expect(html).toContain("recorded the damper test for AHU-2");
    expect(html).toContain('dateTime="2026-10-30T18:05:00.000Z"');
    expect(register({ selected: OPEN })).toContain("No changes recorded yet.");
  });

  it("opens the forms from the URL", () => {
    expect(register({ panel: "project" })).toContain("Verification date");
    expect(register({ panel: "equipment" })).toContain("Add from the equipment schedule");
  });
});

describe("Report", () => {
  const report = (props: Partial<Parameters<typeof ReportView>[0]>) =>
    renderToStaticMarkup(createElement(ReportView, { project: PROJECT, lines: LINES, ...props }));

  it("says so when there is nothing to report", () => {
    expect(report({ project: null, lines: [] })).toContain("No projects yet");
  });

  it("entire project: speaks for its date, lists every unit, the action items and open items", () => {
    const html = report({});
    expect(html).toContain("Verification date November 1, 2026.");
    expect(html).toContain("between November 1 and March 1");
    expect(html).toContain("Equipment register · 5");
    expect(html).toContain("Items requiring action · 2");
    expect(html).toContain("OA damper actuator does not stroke closed.");
    expect(html).toContain("Open items · 1");
  });

  it("one unit: its full record and history, not the register; the project's signoff, said so", () => {
    const html = report({ unit: FAILED, history: HISTORY });
    expect(html).toContain("26-104A</span> · Riverside MOB");
    expect(html).toContain("AHU-2");
    expect(html).toContain("Test failed");
    expect(html).toContain("Outside air damper drives closed");
    expect(html).toContain("PH+B controls");
    expect(html).toContain("History · 2");
    expect(html).not.toContain("Equipment register");
    expect(html).not.toContain("AHU-3");
    expect(html).toContain("These signatures cover the whole project");
  });

  it("one unit with nothing recorded says Not answered", () => {
    expect(report({ unit: OPEN })).toContain("Not answered");
  });

  it("shows both signatures by name, and flags a change after review", () => {
    const html = report({});
    expect(html).toContain("Dana Whitfield");
    expect(html).toContain("Lee Park");
    expect(html).not.toContain("Changed after review.");
    expect(report({ project: { ...PROJECT, changedAfterReview: true } })).toContain("Changed after review.");
  });

  it("offers signing only where it applies", () => {
    const html = report({ project: { ...PROJECT, completed: null, reviewed: null } });
    expect(html.match(/Sign as me/g)).toHaveLength(2);
    expect(html).toContain("Not signed.");
  });
});
