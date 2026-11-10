import { describe, expect, it, vi } from "vitest";

/**
 * The Reports screens as RENDERED (Phase 1), in a node environment with the
 * router stubbed - the bas-tab-bar pattern. What is asserted is the HTML: the
 * owner row and its wording, the external chip, the honest empty states, the
 * sub-tab bar, and the two clocks beside a next run.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/bas/reports/library",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describeAuditEvent } from "@/lib/admin/audit-describe";
import type { LibraryQuestionView, ReportsList } from "@/lib/modules/bas/reports/types";
import { ReportsShell } from "@/app/(modules)/bas/reports-shell";
import { ReportsTable } from "@/app/(modules)/bas/reports-list";
import { OwnerRow, StateChip } from "@/app/(modules)/bas/reports-editor";
import { SharedLibraryTable } from "@/app/(modules)/bas/reports-library";
import { GeneratedPlaceholder, UsagePlaceholder } from "@/app/(modules)/bas/reports-placeholders";
import {
  EXTERNAL_CHIP,
  OWNER_ROW_LABEL,
  describeNextRun,
  describeRecipients,
  describeStations,
  reportStateTone,
  scheduleFromForm,
  formFromSchedule,
} from "@/app/(modules)/bas/reports-client";

const NY = "America/New_York";

function list(over: Partial<ReportsList> = {}): ReportsList {
  const base = {
    reportId: "1",
    name: "Weekly health",
    description: null,
    ownerEmployeeId: "o",
    ownerName: "Jim Schwarz",
    ownerEmail: "jim@phb1899.com",
    isOwner: true,
    site: { siteId: "1", name: "Steel Place", timezone: NY },
    stationsSelected: 0,
    stationsOnSite: 1,
    presetKey: "health_weekly" as const,
    presetLabel: "Standard weekly health report",
    analysisWindow: "7d" as const,
    schedule: { kind: "weekly" as const, weekdays: [1] },
    timeOfDay: "06:00",
    scheduleText: "Every Monday at 06:00 (America/New_York) · last 7 days",
    nextRunAt: "2026-11-02T11:00:00.000Z",
    state: "active" as const,
    questionCount: 20,
    recipientCount: 2,
    lastRun: null,
    budgetUsd: 2,
    createdAt: "2026-11-10T00:00:00.000Z",
    updatedAt: "2026-11-10T00:00:00.000Z",
  };
  return {
    reports: [
      base,
      { ...base, reportId: "2", name: "Paused one", state: "paused", nextRunAt: null, recipientCount: 0, presetKey: null, presetLabel: null },
      { ...base, reportId: "3", name: "Someone else's draft", state: "draft", nextRunAt: null, isOwner: false },
    ],
    reportsInDatabase: 3,
    canAdminister: true,
    viewerEmployeeId: "o",
    ...over,
  };
}

describe("the list", () => {
  it("shows every column the plan names, never a run, and the owner-inclusive recipient count", () => {
    const html = renderToStaticMarkup(createElement(ReportsTable, { data: list() }));
    expect(html).toContain("Weekly health");
    expect(html).toContain("Steel Place");
    expect(html).toContain("Every Monday at 06:00 (America/New_York) · last 7 days");
    expect(html).toContain("Mon, 2 Nov 2026, 06:00 America/New_York (11:00 UTC)");
    expect(html).toContain("No runs yet");
    expect(html).toContain("2 + owner");
    expect(html).toContain("owner only");
    expect(html).toContain(">Active<");
    expect(html).toContain(">Paused<");
    expect(html).toContain(">Draft<");
    // An admin sees whose report it is when it is not theirs.
    expect(html).toContain("Owner: Jim Schwarz");
    // No Run now, no History: there is nothing to run.
    expect(html).not.toContain("Run now");
    expect(html).not.toContain("History");
  });

  it("is honest when empty, and loud when the list lost a row", () => {
    const empty = renderToStaticMarkup(createElement(ReportsTable, { data: list({ reports: [], reportsInDatabase: 0 }) }));
    expect(empty).toContain("No reports yet");
    const lost = renderToStaticMarkup(createElement(ReportsTable, { data: list({ reportsInDatabase: 4 }) }));
    expect(lost).toContain("This list shows 3 of the 4 reports you may see");
  });
});

describe("the editor's fixed pieces", () => {
  it("renders the owner first, locked, labelled required", () => {
    const html = renderToStaticMarkup(createElement(OwnerRow, { name: "Jim Schwarz", email: "jim@phb1899.com" }));
    expect(html).toContain("Jim Schwarz");
    expect(html).toContain("jim@phb1899.com");
    expect(html).toContain(OWNER_ROW_LABEL);
    expect(OWNER_ROW_LABEL).toBe("Report owner · required");
    // Nothing to click: the owner is not removable.
    expect(html).not.toContain("<button");
  });

  it("colours a state quietly when fine and loudly when broken", () => {
    expect(reportStateTone("active")).toBe("ok");
    expect(reportStateTone("draft")).toBe("neutral");
    expect(reportStateTone("paused")).toBe("warn");
    expect(reportStateTone("paused_owner_disabled")).toBe("bad");
    const html = renderToStaticMarkup(createElement(StateChip, { state: "paused_owner_disabled" }));
    expect(html).toContain("Paused — owner disabled");
  });

  it("names the external chip and both clocks", () => {
    expect(EXTERNAL_CHIP).toBe("external");
    expect(describeNextRun("2026-11-02T11:00:00Z", NY)).toBe("Mon, 2 Nov 2026, 06:00 America/New_York (11:00 UTC)");
    expect(describeNextRun(null, NY)).toBe("—");
    expect(describeNextRun("not a date", NY)).toBe("—");
    expect(describeStations(0, 1)).toBe("its 1 station");
    expect(describeStations(0, 3)).toBe("all 3 stations");
    expect(describeStations(2, 3)).toBe("2 of 3 stations");
    expect(describeRecipients(0)).toBe("owner only");
    expect(describeRecipients(3)).toBe("3 + owner");
  });

  it("round-trips the schedule form and refuses an incomplete one", () => {
    const weekly = formFromSchedule({ kind: "weekly", weekdays: [1, 4] }, "2026-11-10");
    expect(scheduleFromForm(weekly)).toEqual({ kind: "weekly", weekdays: [1, 4] });
    expect(scheduleFromForm({ ...weekly, weekdays: [] })).toBeNull();
    const every = formFromSchedule({ kind: "every_n_days", intervalDays: 3, anchorDate: "2026-11-01" }, "2026-11-10");
    expect(scheduleFromForm(every)).toEqual({ kind: "every_n_days", intervalDays: 3, anchorDate: "2026-11-01" });
    expect(scheduleFromForm({ ...every, intervalDays: "x" })).toBeNull();
    expect(scheduleFromForm(formFromSchedule({ kind: "monthly", dayOfMonth: 31 }, ""))).toEqual({ kind: "monthly", dayOfMonth: 31 });
    expect(scheduleFromForm(formFromSchedule({ kind: "daily" }, ""))).toEqual({ kind: "daily" });
    // No stored schedule: the form defaults to weekly Monday with today as anchor.
    expect(formFromSchedule(null, "2026-11-10")).toMatchObject({ kind: "weekly", weekdays: [1], anchorDate: "2026-11-10" });
  });
});

describe("the placeholders and the sub-tabs", () => {
  it("say there are no runs rather than promising any", () => {
    const generated = renderToStaticMarkup(createElement(GeneratedPlaceholder));
    expect(generated).toContain("No reports have been generated yet");
    expect(generated).toContain("nothing fires");
    const usage = renderToStaticMarkup(createElement(UsagePlaceholder));
    expect(usage).toContain("No usage to show");
    expect(usage).toContain("There have been no runs");
  });

  it("render the four sub-tabs with the current one marked", () => {
    const html = renderToStaticMarkup(createElement(ReportsShell, { pathname: "/bas/reports/library", children: "body" }));
    const nav = /<nav[^>]*aria-label="Reports sections"[\s\S]*?<\/nav>/.exec(html);
    expect(nav).not.toBeNull();
    const labels = [...nav![0].matchAll(/<a[^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
    expect(labels).toEqual(["Reports", "Generated", "Library", "Usage"]);
    // next/link writes href last; the active tab carries aria-current.
    expect(nav![0]).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/bas\/reports\/library"/);
    // An editor path belongs to the Reports sub-tab.
    const editor = renderToStaticMarkup(createElement(ReportsShell, { pathname: "/bas/reports/42", children: "body" }));
    expect(editor).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/bas\/reports"/);
  });
});

describe("the shared library table", () => {
  it("groups by section and shows the kind, the applies-to wording and the points required", () => {
    const rows: LibraryQuestionView[] = [
      {
        libraryQuestionId: "1", key: "q03_zone_comfort", section: "space_comfort", sectionLabel: "Space Comfort", position: 3,
        text: "What percent of occupied hours did each zone hold within ±2°F of setpoint?", kind: "computed",
        analysisFn: "q03_zone_comfort", appliesToLabel: "All", appliesToEquipment: [], requiredRoles: [],
        requiredRolesText: "space temp; active setpoint (or heating and cooling setpoints); occupancy", minCoverage: 0.8,
        enabled: true, addedBy: null, createdAt: "2026-11-10T00:00:00.000Z",
      },
      {
        libraryQuestionId: "2", key: "zz_planner", section: "schedules", sectionLabel: "Schedules", position: 99,
        text: "Did anything run on Sunday?", kind: "planner", analysisFn: null, appliesToLabel: "All", appliesToEquipment: [],
        requiredRoles: [], requiredRolesText: "No trended points required", minCoverage: 0.8, enabled: false, addedBy: "jim@phb1899.com",
        createdAt: "2026-11-10T00:00:00.000Z",
      },
    ];
    const html = renderToStaticMarkup(createElement(SharedLibraryTable, { library: rows }));
    expect(html).toContain("Shared library (2)");
    expect(html).toContain(">Space Comfort<");
    expect(html).toContain(">Schedules<");
    expect(html).toContain(">computed<");
    expect(html).toContain(">planner<");
    expect(html).toContain("space temp; active setpoint (or heating and cooling setpoints); occupancy");
    expect(html).toContain("80%");
    expect(html).toContain(">No<");
  });
});

describe("the audit sentences", () => {
  const MODULES = new Map([["bas", "Building Automation"]]);
  const jim = { id: "j", firstName: "Jim", lastName: "Schwarz", email: "jim@phb1899.com" };

  it("say when a recipient is outside the company, and name the report from metadata", () => {
    const external = describeAuditEvent(
      { action: "bas.report_recipient_added", moduleKey: "bas", actor: jim, target: null,
        metadata: { reportId: "1", name: "Weekly health", email: "v@example.com", isExternal: true, confirmed: true } },
      MODULES,
    );
    expect(external.known).toBe(true);
    expect(external.sentence).toBe("Jim Schwarz added v@example.com, an address outside the company, to the report Weekly health");
    const internal = describeAuditEvent(
      { action: "bas.report_recipient_added", moduleKey: "bas", actor: jim, target: null,
        metadata: { reportId: "1", name: "Weekly health", email: "a@phb1899.com", isExternal: false } },
      MODULES,
    );
    expect(internal.sentence).toBe("Jim Schwarz added a@phb1899.com to the report Weekly health");
    const resumed = describeAuditEvent(
      { action: "bas.report_state_changed", moduleKey: "bas", actor: jim, target: null,
        metadata: { reportId: "1", name: "Weekly health", from: "paused", to: "active" } },
      MODULES,
    );
    expect(resumed.sentence).toBe("Jim Schwarz resumed the report Weekly health");
    const preset = describeAuditEvent(
      { action: "bas.report_questions_changed", moduleKey: "bas", actor: jim, target: null,
        metadata: { reportId: "1", name: "Weekly health", change: "preset", presetKey: "health_daily", count: 6 } },
      MODULES,
    );
    expect(preset.sentence).toBe("Jim Schwarz set the report Weekly health to the preset health_daily (6 questions)");
  });
});
