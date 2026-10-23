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
import type { FpLine, FpProject, FpVerification } from "@/lib/modules/freeze-protection/types";

const PROJECT: FpProject = {
  id: "1",
  jobNumber: "26-104A",
  name: "Riverside MOB",
  buildings: [
    { id: "10", name: "Main", equipmentCount: 2 },
    { id: "11", name: "Annex", equipmentCount: 1 },
  ],
};

const ROUND: FpVerification = {
  id: "7",
  projectId: "1",
  verificationDate: "2026-11-01",
  completed: { employeeId: "a", name: "Dana Whitfield", at: "2026-11-01T15:00:00.000Z" },
  reviewed: { employeeId: "b", name: "Lee Park", at: "2026-11-02T15:00:00.000Z" },
  transmittedTo: "Turner CM",
  transmittedDate: "2026-11-03",
  changedAfterReview: false,
};

const PASSED = { fanStops: "yes", damperCloses: "yes", valveFullFlow: "yes", manualReset: "yes" } as const;

function line(id: string, overrides: Partial<FpLine> = {}): FpLine {
  return {
    id,
    resultId: `r${id}`,
    buildingId: "10",
    buildingName: "Main",
    tag: `AHU-${id}`,
    equipmentType: "AHU",
    areaServed: "Level 1",
    coil: null,
    equipmentNotes: null,
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
const NO_COIL = line("4", { coil: "none", tag: "EF-1" });
const OPEN = line("5", { coil: "water" });
const LINES = [NO_PROTECTION, FAILED, VERIFIED, NO_COIL, OPEN];

const register = (props: Partial<Parameters<typeof RegisterView>[0]>) =>
  renderToStaticMarkup(
    createElement(RegisterView, {
      project: PROJECT,
      verifications: [ROUND],
      verification: ROUND,
      lines: LINES,
      selected: null,
      panel: null,
      today: "2026-11-01",
      ...props,
    }),
  );

describe("Register", () => {
  it("offers a new project when there are none", () => {
    const html = register({ project: null, verifications: [], verification: null, lines: [] });
    expect(html).toContain("No projects yet");
    expect(html).toContain("New project");
  });

  it("asks for a verification before showing the register", () => {
    expect(register({ verifications: [], verification: null, lines: [] })).toContain("Start a verification to see the register");
  });

  it("lists every unit with its disposition in words, and the funnel", () => {
    const html = register({});
    for (const label of ["No protection", "Test failed", "Verified", "Closed, no coil", "Step 3 open"]) expect(html).toContain(label);
    expect(html).toContain("Outside air exposure");
    expect(html).toContain("5 units in the 2026-11-01 verification");
  });

  it("no protection: the stop and the notice fields, not the test", () => {
    const html = register({ selected: NO_PROTECTION });
    expect(html).toContain("Stop.");
    expect(html).toContain("Notified");
    expect(html).not.toContain("Test the safety");
  });

  it("failed test: the four tests, the trip temperature, and the deficiency", () => {
    const html = register({ selected: FAILED });
    expect(html).toContain("Test the safety");
    expect(html).toContain("Outside air damper drives closed");
    expect(html).toContain("Deficiency.");
    expect(html).not.toContain("Documented with the owner");
  });

  it("verified: step 6 shows", () => {
    expect(register({ selected: VERIFIED })).toContain("Documented with the owner or controls vendor");
  });

  it("no coil: closed, nothing past step 2", () => {
    const html = register({ selected: NO_COIL });
    expect(html).toContain("Closed.");
    expect(html).not.toContain("Outside air exposure</h4>");
  });

  it("opens the forms from the URL", () => {
    expect(register({ panel: "project" })).toContain("Create project");
    expect(register({ panel: "equipment" })).toContain("Add from the equipment schedule");
  });
});

describe("Report", () => {
  const report = (props: Partial<Parameters<typeof ReportView>[0]>) =>
    renderToStaticMarkup(createElement(ReportView, { project: PROJECT, verification: ROUND, lines: LINES, ...props }));

  it("says so when there is nothing to report", () => {
    expect(report({ verification: null, lines: [] })).toContain("No verification on this project yet");
  });

  it("speaks for its date, in words, without shifting the day", () => {
    expect(report({})).toContain("Verification date November 1, 2026.");
    expect(report({})).toContain("between November 1 and March 1");
  });

  it("lists the action items with their owner and due date, and the open items", () => {
    const html = report({});
    expect(html).toContain("Items requiring action · 2");
    expect(html).toContain("OA damper actuator does not stroke closed.");
    expect(html).toContain("2026-11-08");
    expect(html).toContain("Open items · 1");
  });

  it("shows both signatures by name", () => {
    const html = report({});
    expect(html).toContain("Dana Whitfield");
    expect(html).toContain("Lee Park");
  });

  it("flags a change after review", () => {
    expect(report({})).not.toContain("Changed after review.");
    expect(report({ verification: { ...ROUND, changedAfterReview: true } })).toContain("Changed after review.");
  });

  it("offers signing only where it applies", () => {
    const html = report({ verification: { ...ROUND, completed: null, reviewed: null } });
    expect(html.match(/Sign as me/g)).toHaveLength(2);
    expect(html).toContain("Not signed.");
  });
});
