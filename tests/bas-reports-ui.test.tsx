import { describe, expect, it, vi } from "vitest";

/**
 * The Reports screens as RENDERED (Phase 1), in a node environment with the
 * router stubbed - the bas-tab-bar pattern. What is asserted is the HTML: the
 * owner row and its wording, the external chip, the honest empty states, the
 * Reports bar and its Back item (2026-11-11), the two clocks beside a next
 * run, the questions checklist - three tabs, one selection (2026-11-12) -
 * and the Usage page drawn from a run rather than a placeholder (2026-11-12).
 */
/** The router the shell sees; each bar test sets the path it renders for. */
const nav = vi.hoisted(() => ({ pathname: "/bas/reports/library", search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describeAuditEvent } from "@/lib/admin/audit-describe";
import { DEFAULT_SAFETY_CEILING } from "@/lib/modules/bas/reports/ceiling";
import { BAS_LIBRARY_QUESTIONS, sectionLabel } from "@/lib/modules/bas/reports/library";
import { REPORT_PRESETS } from "@/lib/modules/bas/reports/presets";
import type { LibraryQuestionView, PersonalQuestionView, ReportsList } from "@/lib/modules/bas/reports/types";
import type { ReportsUsage } from "@/lib/modules/bas/reports/usage";
import { BasShell } from "@/app/(modules)/bas/bas-shell";
import { activeReportsItemHref } from "@/app/(modules)/bas/reports/bar";

/**
 * `children` is supplied positionally, which React accepts and the prop type
 * does not describe - the bas-tab-bar test's cast, for the same reason: the
 * component is right, and react/no-children-prop refuses `children:` in props.
 */
const Shell = BasShell as unknown as (props: { blurb: string; canAdminister?: boolean }) => React.ReactNode;
import { ReportsTable } from "@/app/(modules)/bas/reports-list";
import { OwnerRow, QuestionsChecklist, SelectedQuestionsList, StateChip, initialQuestionsTab, type QuestionsTab } from "@/app/(modules)/bas/reports-editor";
import { SharedLibraryTable } from "@/app/(modules)/bas/reports-library";
import { GeneratedPlaceholder } from "@/app/(modules)/bas/reports-placeholders";
import { ReportsUsageView, SafetyCeilingCard } from "@/app/(modules)/bas/reports-usage";
import {
  EXTERNAL_CHIP,
  OWNER_ROW_LABEL,
  addInline,
  clearTab,
  describeNextRun,
  describeRecipients,
  describeSelection,
  describeStations,
  emptySelection,
  orderedSelection,
  presetLabelFor,
  questionMeta,
  reportStateTone,
  scheduleFromForm,
  selectTab,
  selectionBody,
  selectionFromDetail,
  setInlineSave,
  toggleLibrary,
  togglePersonal,
  formFromSchedule,
} from "@/app/(modules)/bas/reports-client";

const NY = "America/New_York";

function list0(over: Partial<ReportsList> = {}): ReportsList {
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
    pausedReason: null,
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
    const html = renderToStaticMarkup(createElement(ReportsTable, { data: list0() }));
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
    const empty = renderToStaticMarkup(createElement(ReportsTable, { data: list0({ reports: [], reportsInDatabase: 0 }) }));
    expect(empty).toContain("No reports yet");
    const lost = renderToStaticMarkup(createElement(ReportsTable, { data: list0({ reportsInDatabase: 4 }) }));
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

describe("the placeholder", () => {
  it("says there are no runs rather than promising any", () => {
    const generated = renderToStaticMarkup(createElement(GeneratedPlaceholder));
    expect(generated).toContain("No reports have been generated yet");
    expect(generated).toContain("nothing fires");
  });
});

// ---------------------------------------------------------------------------
// The Usage page (2026-11-12): drawn from runs, with the safety ceiling
// ---------------------------------------------------------------------------

function usage(over: Partial<ReportsUsage> = {}): ReportsUsage {
  const days = Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-0${6 + i}`, label: `Nov ${6 + i}`, spend: 0 }));
  days[5]!.spend = 0.0397;
  return {
    range: "7d",
    totals: { runs: 1, tokens: 4_310, spend: 0.0397 },
    thisMonth: { label: "November", spend: 0.0397 },
    days,
    byReport: [{ label: "Weekly health", runs: 1, tokens: 4_310, spend: 0.0397 }],
    byBuilding: [{ label: "Steel Place", runs: 1, tokens: 4_310, spend: 0.0397 }],
    topRuns: [
      { runId: "7", reportId: "1", reportName: "Weekly health", buildingName: "Steel Place", status: "succeeded", startedAt: "2026-11-11T14:00:00.000Z", finishedAt: "2026-11-11T14:01:00.000Z", tokens: 4_310, spend: 0.0397 },
    ],
    runsInDatabase: 1,
    ceiling: { ...DEFAULT_SAFETY_CEILING, updatedAt: null, updatedBy: null },
    ...over,
  };
}

describe("the Usage page", () => {
  it("shows the run the Reports list shows - never 'there have been no runs' - with the five tiles, the breakdown, the run row and the ceiling", () => {
    const html = renderToStaticMarkup(createElement(ReportsUsageView, { usage: usage(), canAdminister: false }));
    expect(html).not.toContain("There have been no runs");
    expect(html).not.toContain("No usage to show");
    for (const tile of ["Spend", "Runs", "Average per run", "Tokens", "November so far"]) expect(html).toContain(tile);
    // $0.0397 rounds to the cent on a tile, as Cost Intelligence's does; the tokens are 4k.
    expect(html).toContain("$0.04");
    expect(html).toContain(">4k<");
    expect(html).toContain("Spend per day");
    expect(html).toContain("Nov 11: $0.04");
    expect(html).toContain("By report");
    expect(html).toContain("By building");
    expect(html).toContain("Weekly health");
    expect(html).toContain("Most expensive runs");
    expect(html).toContain("#7");
    expect(html).toContain(">Succeeded<");
    // The ceiling, read-only for a plain BAS user.
    expect(html).toContain("Safety ceiling");
    expect(html).toContain("$10.00 and 25 minutes per run");
    expect(html).toContain("finishes partial and says so");
    expect(html).not.toContain("Save ceiling");
    // No red note when the figures and the count agree.
    expect(html).not.toContain("Report this");
  });

  it("offers the ceiling inputs to a module admin, is honest about an empty range, and loud when a row was lost", () => {
    const admin = renderToStaticMarkup(createElement(SafetyCeilingCard, { ceiling: { usd: 5.25, minutes: 10, updatedAt: "2026-11-12T10:00:00.000Z", updatedBy: "jim@phb1899.com" }, canAdminister: true }));
    expect(admin).toContain("$5.25 and 10 minutes per run");
    expect(admin).toContain("Save ceiling");
    expect(admin).toContain("Last set by jim@phb1899.com on 2026-11-12");
    expect(admin).toContain("Minutes per run (1 to 25)");

    const empty = renderToStaticMarkup(createElement(ReportsUsageView, {
      usage: usage({ totals: { runs: 0, tokens: 0, spend: 0 }, days: usage().days.map((d) => ({ ...d, spend: 0 })), byReport: [], byBuilding: [], topRuns: [], runsInDatabase: 0 }),
      canAdminister: false,
    }));
    expect(empty).toContain("No spend in this range");
    expect(empty).toContain("No finished runs in this range");
    expect(empty).toContain("$0.00");

    const lost = renderToStaticMarkup(createElement(ReportsUsageView, { usage: usage({ runsInDatabase: 2 }), canAdminister: false }));
    expect(lost).toContain("These figures cover 1 of the 2 finished runs");
  });
});

// ---------------------------------------------------------------------------
// The questions checklist (2026-11-12): three tabs, one selection
// ---------------------------------------------------------------------------

/** The seeded library as the editor receives it, ids 1..20 in position order. */
const LIBRARY: LibraryQuestionView[] = [...BAS_LIBRARY_QUESTIONS]
  .sort((a, b) => a.position - b.position)
  .map((q, i) => ({
    libraryQuestionId: String(i + 1),
    key: q.key,
    section: q.section,
    sectionLabel: sectionLabel(q.section),
    position: q.position,
    text: q.text,
    kind: q.kind,
    analysisFn: q.analysisFn ?? null,
    appliesToLabel: q.appliesToLabel,
    appliesToEquipment: [...q.appliesToEquipment],
    requiredRoles: [],
    requiredRolesText: "",
    minCoverage: 0.8,
    enabled: true,
    addedBy: null,
    createdAt: "2026-11-10T00:00:00.000Z",
  }));
const MINE: PersonalQuestionView[] = [
  { personalQuestionId: "41", text: "Did the boiler cycle overnight?", usedInReports: 0, createdAt: "2026-11-10T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z" },
];
const DAILY_IDS = idsOfKeys(REPORT_PRESETS.health_daily.questionKeys);
function idsOfKeys(keys: readonly string[]): string[] {
  return LIBRARY.filter((q) => keys.includes(q.key)).map((q) => q.libraryQuestionId);
}
const checklist = (selection: ReturnType<typeof emptySelection>, tab: QuestionsTab, extra: { canUsePersonal?: boolean; showSelected?: boolean } = {}) =>
  renderToStaticMarkup(
    createElement(QuestionsChecklist, {
      library: LIBRARY,
      personal: MINE,
      selection,
      onChange: () => undefined,
      canUsePersonal: extra.canUsePersonal ?? true,
      initialTab: tab,
      initialShowSelected: extra.showSelected ?? false,
    }),
  );
const checkedBoxes = (html: string) => (html.match(/<input type="checkbox"[^>]*checked=""/g) ?? []).length;
const boxes = (html: string) => (html.match(/<input type="checkbox"/g) ?? []).length;
/** React escapes text as HTML; the spec's questions carry apostrophes. */
const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const tabRadios = (html: string) => [...html.matchAll(/<button[^>]*role="radio"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
const checkedTab = (html: string) => /<button[^>]*role="radio"[^>]*aria-checked="true"[^>]*>([^<]*)<\/button>/.exec(html)?.[1] ?? null;

describe("the questions checklist", () => {
  it("is three tabs in the segmented control, the count at the right, and nothing ticked on a new report", () => {
    const html = checklist(emptySelection(), "standard");
    expect(tabRadios(html)).toEqual(["Standard weekly", "Daily critical-site", "Custom"]);
    expect(checkedTab(html)).toBe("Standard weekly");
    expect(html).toContain("0 questions ticked");
    expect(html).toContain(">Show selected<");
    expect(html).not.toMatch(/locked/i);
    expect(html).not.toContain("Save the draft");
    // Standard: the twenty with boxes, their number and meta, grouped by section.
    expect(boxes(html)).toBe(20);
    expect(checkedBoxes(html)).toBe(0);
    for (const q of LIBRARY) {
      expect(html).toContain(esc(q.text));
      expect(html).toContain(esc(questionMeta(q)));
    }
    expect(questionMeta(LIBRARY[2]!)).toBe("Space Comfort · computed · All");
    for (const section of ["Summary", "Space Comfort", "VAV", "Data Health"]) expect(html).toContain(`>${section}<`);
    for (const button of ["Select all", "Clear"]) expect(html).toContain(`>${button}<`);
    expect(html).toContain("The spec&#x27;s twenty questions");
    // Daily: its six, and nothing else's.
    const daily = checklist(emptySelection(), "daily");
    expect(checkedTab(daily)).toBe("Daily critical-site");
    expect(boxes(daily)).toBe(6);
    expect(daily).toContain(esc(LIBRARY[19]!.text));
    expect(daily).not.toContain(esc(LIBRARY[5]!.text));
    // Custom: My questions with a box, the custom list, the box to type one with its save tick.
    const custom = checklist(emptySelection(), "custom");
    expect(checkedTab(custom)).toBe("Custom");
    expect(boxes(custom)).toBe(2);
    expect(custom).toContain(">My questions<");
    expect(custom).toContain("Did the boiler cycle overnight?");
    expect(custom).toContain("Add a custom question to this report");
    expect(custom).toContain("save for reuse");
    expect(custom).toContain("This report only unless saved for reuse");
    // Which tab opens: the saved label's, Custom for a custom-only report, Standard otherwise.
    expect(initialQuestionsTab(emptySelection())).toBe("standard");
    expect(initialQuestionsTab({ ...emptySelection(), presetClicked: "health_daily" })).toBe("daily");
    expect(initialQuestionsTab({ ...emptySelection(), personal: ["41"] })).toBe("custom");
    expect(initialQuestionsTab({ ...emptySelection(), library: ["3"], personal: ["41"] })).toBe("standard");
  });

  it("holds ONE selection across the tabs: ticks made on Standard show on Daily, Select all and Clear act on their tab only, and switching never clears", () => {
    let state = emptySelection();
    state = togglePersonal(state, "41", true);
    state = addInline(state, "Which VAVs were warm while occupied?");
    // Q1, Q3 (both on Daily), Q7, Q10 (Standard only) ticked on the Standard tab.
    for (const id of idsOfKeys(["q01_building_status", "q03_zone_comfort", "q07_vav_damper_full_missed_setpoint", "q10_static_tracks_setpoint"])) state = toggleLibrary(state, id, true);
    expect(state.library).toHaveLength(4);
    const standard = checklist(state, "standard");
    expect(checkedBoxes(standard)).toBe(4);
    expect(standard).toContain("6 questions ticked");
    // The Daily tab shows the two it shares, ticked, and nothing was cleared by looking.
    const daily = checklist(state, "daily");
    expect(boxes(daily)).toBe(6);
    expect(checkedBoxes(daily)).toBe(2);
    expect(daily).toContain("6 questions ticked");
    expect(checkedBoxes(checklist(state, "custom"))).toBe(1);

    // Select all on Daily adds Daily's other four and keeps Q7 and Q10; it names Daily as the label candidate.
    const dailyAll = selectTab(state, "health_daily", LIBRARY);
    expect(dailyAll.library).toHaveLength(8);
    expect(dailyAll.presetClicked).toBe("health_daily");
    expect(presetLabelFor(dailyAll, LIBRARY)).toBeNull(); // eight shared is not the daily six
    expect(dailyAll.personal).toEqual(["41"]);
    expect(dailyAll.inline).toHaveLength(1);
    // Clear on Daily unticks Daily's six and nothing else.
    const dailyCleared = clearTab(dailyAll, "health_daily", LIBRARY);
    expect(dailyCleared.library.sort()).toEqual(idsOfKeys(["q07_vav_damper_full_missed_setpoint", "q10_static_tracks_setpoint"]).sort());
    expect(dailyCleared.presetClicked).toBeNull();
    expect(dailyCleared.personal).toEqual(["41"]);
    expect(dailyCleared.inline).toHaveLength(1);

    // Select all on Standard is the standard twenty, and the label follows; untick one and it goes.
    const weekly = selectTab(dailyCleared, "health_weekly", LIBRARY);
    expect(weekly.library).toHaveLength(20);
    expect(presetLabelFor(weekly, LIBRARY)).toBe("health_weekly");
    expect(describeSelection(weekly, LIBRARY)).toBe("22 questions · Standard weekly health report + 2 custom");
    expect(checkedBoxes(checklist(weekly, "daily"))).toBe(6);
    const varied = toggleLibrary(weekly, DAILY_IDS[2]!, false);
    expect(varied.presetClicked).toBe("health_weekly");
    expect(presetLabelFor(varied, LIBRARY)).toBeNull();
    expect(describeSelection(varied, LIBRARY)).toBe("21 questions · 19 shared + 2 custom");
    // Clear on Standard from the full twenty leaves only the custom ones; Select all skips a turned-off question.
    const cleared = clearTab(weekly, "health_weekly", LIBRARY);
    expect(cleared.library).toEqual([]);
    expect(cleared.personal).toEqual(["41"]);
    expect(describeSelection(cleared, LIBRARY)).toBe("2 questions · 2 custom");
    const withOneOff = LIBRARY.map((q, i) => (i === 0 ? { ...q, enabled: false } : q));
    expect(selectTab(emptySelection(), "health_weekly", withOneOff).library).toHaveLength(19);
  });

  it("lists the whole selection in report order under Show selected, and produces the body the API takes", () => {
    let state = emptySelection();
    state = addInline(state, "Typed one");
    state = toggleLibrary(state, "20", true);
    state = togglePersonal(state, "41", true);
    state = toggleLibrary(state, "3", true);
    state = setInlineSave(state, state.inline[0]!.key, true);
    expect(orderedSelection(state, LIBRARY, MINE).map((s) => [s.kind, s.text.slice(0, 12), s.meta])).toEqual([
      ["library", "What percent", "Q3 · Space Comfort · computed · All"],
      ["library", "Which points", "Q20 · Data Health · computed · All"],
      ["personal", "Did the boil", "my question · planner"],
      ["inline", "Typed one", "this report only · planner · saved for reuse on save"],
    ]);
    const shown = checklist(state, "daily", { showSelected: true });
    expect(shown).toContain(">Hide selected<");
    expect(shown).toContain('aria-label="Selected questions"');
    expect(shown).toContain("Typed one");
    expect(shown).toContain("4 questions ticked");
    const list = renderToStaticMarkup(createElement(SelectedQuestionsList, { items: [] }));
    expect(list).toContain("Nothing ticked yet");
    expect(selectionBody(state, LIBRARY)).toEqual([
      { kind: "library", libraryQuestionId: "3" },
      { kind: "library", libraryQuestionId: "20" },
      { kind: "personal", personalQuestionId: "41" },
      { kind: "inline", text: "Typed one", saveToLibrary: true },
    ]);
    const custom = checklist(state, "custom");
    expect(custom).toContain("Typed one");
    expect(custom).toContain("this report only");

    // A module admin on somebody else's report: no My questions, no save for reuse, the owner's kept and named.
    const adminHtml = renderToStaticMarkup(createElement(QuestionsChecklist, {
      library: LIBRARY, personal: [], selection: state, onChange: () => undefined, canUsePersonal: false, initialTab: "custom",
      ownerQuestionsOnReport: [{ questionId: "9", position: 2, kind: "personal", text: "Did the boiler cycle overnight?", libraryQuestionId: null, libraryKey: null, section: null, sectionLabel: null, libraryKind: null, appliesToLabel: null, personalQuestionId: "41" }],
    }));
    expect(adminHtml).not.toContain("save for reuse");
    expect(adminHtml).not.toContain(">My questions<");
    expect(adminHtml).toContain("The owner&#x27;s questions on this report");
    expect(adminHtml).toContain("kept when you save");

    // From a saved report: the detail becomes the same selection, label included.
    const detail = {
      ...list0().reports[0]!,
      stationIds: [], stations: [], recipients: [],
      questions: [
        { questionId: "1", position: 0, kind: "library" as const, text: "t", libraryQuestionId: "3", libraryKey: "q03_zone_comfort", section: "space_comfort", sectionLabel: "Space Comfort", libraryKind: "computed" as const, appliesToLabel: "All", personalQuestionId: null },
        { questionId: "2", position: 1, kind: "personal" as const, text: "mine", libraryQuestionId: null, libraryKey: null, section: null, sectionLabel: null, libraryKind: null, appliesToLabel: null, personalQuestionId: "41" },
        { questionId: "3", position: 2, kind: "inline" as const, text: "typed", libraryQuestionId: null, libraryKey: null, section: null, sectionLabel: null, libraryKind: null, appliesToLabel: null, personalQuestionId: null },
      ],
    };
    const loaded = selectionFromDetail(detail);
    expect(loaded).toMatchObject({ library: ["3"], personal: ["41"], presetClicked: "health_weekly" });
    expect(loaded.inline.map((d) => [d.text, d.save])).toEqual([["typed", false]]);
    expect(selectionBody(loaded, LIBRARY)).toEqual([
      { kind: "library", libraryQuestionId: "3" },
      { kind: "personal", personalQuestionId: "41" },
      { kind: "inline", text: "typed" },
    ]);
  });
});

describe("the Reports bar", () => {
  const shell = () => renderToStaticMarkup(createElement(Shell, { blurb: "", canAdminister: true }, "body"));
  const reportsBar = (html: string): string => {
    const bar = /<nav[^>]*aria-label="Reports sections"[\s\S]*?<\/nav>/.exec(html);
    expect(bar).not.toBeNull();
    return bar![0];
  };
  const anchors = (bar: string) => [...bar.matchAll(/<a[^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
  const labels = (bar: string) => anchors(bar).map((a) => a.replace(/<[^>]+>/g, "").trim());
  // next/link writes href last; the active item carries aria-current.
  const activeHref = (bar: string) => /<a[^>]*aria-current="page"[^>]*href="([^"]+)"/.exec(bar)?.[1] ?? null;

  it("replaces the module bar while Reports is open: Back, Reports, Scheduled, Questions, Usage, in one row", () => {
    nav.pathname = "/bas/reports/library";
    nav.search = "";
    const html = shell();
    const bar = reportsBar(html);
    expect(labels(bar)).toEqual(["Back", "Reports", "Scheduled", "Questions", "Usage"]);
    // Never a second row: the module bar is not in the markup at all.
    expect(html).not.toContain('aria-label="Building Automation sections"');
    expect(html.match(/<nav /g)).toHaveLength(1);
    expect(activeHref(bar)).toBe("/bas/reports/library");
    // Back is a quiet item: the arrow, never active, the module's default tab.
    const back = anchors(bar)[0]!;
    expect(back).toContain("<svg");
    expect(back).toContain('href="/bas"');
    expect(back).not.toContain("aria-current");
  });

  it("keeps every deep link: the path still selects the view, and opening Reports lands on the Reports bar", () => {
    const activeFor = (pathname: string) => {
      nav.pathname = pathname;
      return activeHref(reportsBar(shell()));
    };
    expect(activeFor("/bas/reports")).toBe("/bas/reports");
    expect(activeFor("/bas/reports/generated/7")).toBe("/bas/reports");
    expect(activeFor("/bas/reports/scheduled")).toBe("/bas/reports/scheduled");
    expect(activeFor("/bas/reports/new")).toBe("/bas/reports/scheduled");
    expect(activeFor("/bas/reports/42")).toBe("/bas/reports/scheduled");
    expect(activeFor("/bas/reports/library")).toBe("/bas/reports/library");
    expect(activeFor("/bas/reports/usage")).toBe("/bas/reports/usage");
  });

  it("resolves the item as a pure function, and nothing outside Reports", () => {
    expect(activeReportsItemHref("/bas/reports/generated")).toBe("/bas/reports");
    expect(activeReportsItemHref("/bas/reports/42/anything")).toBe("/bas/reports/scheduled");
    expect(activeReportsItemHref("/bas/reportsx")).toBeNull();
    expect(activeReportsItemHref("/bas")).toBeNull();
    expect(activeReportsItemHref("/bas/points")).toBeNull();
  });

  it("Back restores the module bar with Projects selected, carrying the query string both ways", () => {
    nav.pathname = "/bas/reports";
    nav.search = "site=5";
    const bar = reportsBar(shell());
    expect(anchors(bar)[0]).toContain('href="/bas?site=5"');
    expect(activeHref(bar)).toBe("/bas/reports?site=5");

    // Where Back lands: the module bar, Projects active, and no Reports bar.
    nav.pathname = "/bas";
    const html = shell();
    expect(html).not.toContain('aria-label="Reports sections"');
    const moduleBar = /<nav[^>]*aria-label="Building Automation sections"[\s\S]*?<\/nav>/.exec(html);
    expect(moduleBar).not.toBeNull();
    expect(labels(moduleBar![0])).toEqual(["Projects", "Point Explorer", "Analyze", "Reports", "Collection Health", "Settings"]);
    expect(activeHref(moduleBar![0])).toBe("/bas?site=5");
    nav.search = "";
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
    expect(html).toContain("Shared questions (2)");
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
    // The checklist's one row per save (2026-11-12), and the ceiling's.
    const set = describeAuditEvent(
      { action: "bas.report_questions_changed", moduleKey: "bas", actor: jim, target: null,
        metadata: { reportId: "1", name: "Weekly health", change: "set", count: 22, presetKey: "health_weekly", library: 20, personal: 1, inline: 1 } },
      MODULES,
    );
    expect(set.sentence).toBe("Jim Schwarz set the questions on the report Weekly health (22 questions, health_weekly)");
    const setNoPreset = describeAuditEvent(
      { action: "bas.report_questions_changed", moduleKey: "bas", actor: jim, target: null,
        metadata: { reportId: "1", name: "Weekly health", change: "set", count: 1, presetKey: null } },
      MODULES,
    );
    expect(setNoPreset.sentence).toBe("Jim Schwarz set the questions on the report Weekly health (1 question)");
    const ceiling = describeAuditEvent(
      { action: "bas.report_ceiling_changed", moduleKey: "bas", actor: jim, target: null,
        metadata: { from: { usd: 10, minutes: 25 }, to: { usd: 5.5, minutes: 20 } } },
      MODULES,
    );
    expect(ceiling.known).toBe(true);
    expect(ceiling.sentence).toBe("Jim Schwarz set the Reports safety ceiling to $5.50 and 20 minutes per run (was $10.00 and 25 minutes)");
  });
});
