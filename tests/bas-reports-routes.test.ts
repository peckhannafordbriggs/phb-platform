import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Only the session is mocked. The guard, the wrapper, the Zod schemas, the
// service and the real Prisma queries all run - half this file is about a 404
// and a mocked guard would only prove the mock agrees with the test.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { REPORT_PRESETS, type PresetKey } from "@/lib/modules/bas/reports/presets";
import { computeNextRun, localParts, type ScheduleSpec } from "@/lib/modules/bas/reports/schedule";
import type {
  LibraryQuestionView,
  PersonalQuestionView,
  RecipientView,
  ReportDetail,
  ReportsList,
} from "@/lib/modules/bas/reports/types";
import type { QuestionSelection } from "@/lib/validation/bas-reports";
import { REMOVED_LIMITS_MESSAGE } from "@/lib/validation/bas-reports";
import { seedBasReportLibrary } from "@/prisma/bas-report-library";
import { GET as listRoute, POST as createRoute } from "@/app/api/modules/bas/reports/route";
import { GET as optionsRoute } from "@/app/api/modules/bas/reports/options/route";
import { GET as libraryRoute } from "@/app/api/modules/bas/reports/library/route";
import {
  GET as listPersonalRoute,
  POST as createPersonalRoute,
} from "@/app/api/modules/bas/reports/personal/route";
import {
  DELETE as deletePersonalRoute,
  PATCH as patchPersonalRoute,
} from "@/app/api/modules/bas/reports/personal/[questionId]/route";
import {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as patchRoute,
} from "@/app/api/modules/bas/reports/[reportId]/route";
import { POST as stateRoute } from "@/app/api/modules/bas/reports/[reportId]/state/route";
import { POST as addRecipientRoute } from "@/app/api/modules/bas/reports/[reportId]/recipients/route";
import { DELETE as removeRecipientRoute } from "@/app/api/modules/bas/reports/[reportId]/recipients/[email]/route";
import {
  createEmployee,
  disconnectDb,
  grantModule,
  grantModuleAdmin,
  resetDb,
  seedBasModule,
  seedChangeOrdersModule,
  testDb,
} from "./db";

/**
 * Reports (Phase 1), through the real routes.
 *
 * What the phase's done-when names, each as a test: the owner cannot be added
 * or removed as a recipient; an external address needs confirmation and is
 * audited as external; a non-owner non-admin gets 404 and an admin gets 200;
 * activation computes the next run in the building's zone; and every route
 * under app/api/modules/bas/reports goes through withBas.
 *
 * Since 2026-11-12 the questions are a SELECTION sent whole on create and
 * update (the editor's checklist), stored in library order, then the
 * owner's own, then typed; a preset is a label kept while the shared part
 * matches it; nothing is locked; and the two per-report limits are refused
 * with 400 so an old client fails loudly. A report made under Phase 1's
 * preset rows round-trips through the new save to the same question set.
 */

const authMock = vi.mocked(auth);
const NY = "America/New_York";
const LA = "America/Los_Angeles";

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

function json(body: unknown, method = "POST"): Request {
  return new Request("http://localhost/api/modules/bas/reports", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
const bare = (method = "GET") => new Request("http://localhost/api/modules/bas/reports", { method });

const report = (reportId: string) => ({ params: Promise.resolve({ reportId }) });
const recipient = (reportId: string, email: string) => ({
  params: Promise.resolve({ reportId, email: encodeURIComponent(email) }),
});
const personal = (questionId: string) => ({ params: Promise.resolve({ questionId }) });

async function body<T = Record<string, unknown>>(response: Response): Promise<T> {
  return ((await response.json()) as { data?: T }).data as T;
}
async function errorCode(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { error?: { code?: string } }).error?.code;
}
async function errorMessage(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { error?: { message?: string } }).error?.message;
}

const WEEKLY_MONDAY: ScheduleSpec = { kind: "weekly", weekdays: [1] };
const baseReport = (siteId: bigint, extra: Record<string, unknown> = {}) => ({
  name: "ZZTEST weekly",
  siteId: siteId.toString(),
  schedule: WEEKLY_MONDAY,
  timeOfDay: "06:00",
  ...extra,
});

interface People {
  owner: Awaited<ReturnType<typeof createEmployee>>;
  other: Awaited<ReturnType<typeof createEmployee>>;
  admin: Awaited<ReturnType<typeof createEmployee>>;
}

let people: People;
let nySite: bigint;
let laSite: bigint;
let nyStations: bigint[];
let laStation: bigint;

async function seedPeople(): Promise<People> {
  const owner = await createEmployee({ email: "zztest.owner@phb1899.com" });
  const other = await createEmployee({ email: "zztest.other@phb1899.com" });
  const admin = await createEmployee({ email: "zztest.admin@phb1899.com" });
  for (const e of [owner, other, admin]) await grantModule(e.id, BAS_MODULE_KEY);
  await grantModuleAdmin(admin.id, BAS_MODULE_KEY);
  return { owner, other, admin };
}

async function seedBuildings() {
  const org = await testDb.basOrg.create({ data: { name: "ZZTEST_RPT_ORG" } });
  const project = await testDb.basProject.create({ data: { orgId: org.orgId, name: "ZZTEST_RPT_PROJECT" } });
  const ny = await testDb.basSite.create({
    data: { orgId: org.orgId, projectId: project.projectId, name: "ZZTEST_RPT_NY", timezone: NY },
  });
  const la = await testDb.basSite.create({
    data: { orgId: org.orgId, projectId: project.projectId, name: "ZZTEST_RPT_LA", timezone: LA },
  });
  const s1 = await testDb.basStation.create({
    data: { siteId: ny.siteId, niagaraStationName: "ZZTestRptNy1", connectionMode: "direct", baseUrl: "https://198.51.100.11" },
  });
  const s2 = await testDb.basStation.create({
    data: { siteId: ny.siteId, niagaraStationName: "ZZTestRptNy2", connectionMode: "direct", baseUrl: "https://198.51.100.12" },
  });
  const s3 = await testDb.basStation.create({
    data: { siteId: la.siteId, niagaraStationName: "ZZTestRptLa1", connectionMode: "direct", baseUrl: "https://198.51.100.13" },
  });
  nySite = ny.siteId;
  laSite = la.siteId;
  nyStations = [s1.stationId, s2.stationId];
  laStation = s3.stationId;
}

async function dropBuildings() {
  await testDb.basStation.deleteMany({ where: { niagaraStationName: { startsWith: "ZZTestRpt" } } });
  await testDb.basSite.deleteMany({ where: { name: { startsWith: "ZZTEST_RPT" } } });
  await testDb.basProject.deleteMany({ where: { name: { startsWith: "ZZTEST_RPT" } } });
  await testDb.basOrg.deleteMany({ where: { name: { startsWith: "ZZTEST_RPT" } } });
}

/** A draft owned by `people.owner`, created through the route. */
async function createDraft(extra: Record<string, unknown> = {}): Promise<string> {
  signedInAs(people.owner.entraOid!);
  const response = await createRoute(json(baseReport(nySite, extra)));
  const text = await response.text();
  expect(response.status, text).toBe(201);
  return (JSON.parse(text) as { data: { reportId: string } }).data.reportId;
}

async function detail(reportId: string): Promise<ReportDetail> {
  const response = await getRoute(bare(), report(reportId));
  expect(response.status).toBe(200);
  return body<ReportDetail>(response);
}

/** The shared library's rows, read from the database so no test's signed-in state is disturbed. */
async function library(): Promise<Array<Pick<LibraryQuestionView, "libraryQuestionId" | "key" | "text">>> {
  const rows = await testDb.basLibraryQuestion.findMany({ select: { libraryQuestionId: true, key: true, text: true }, orderBy: { position: "asc" } });
  return rows.map((r) => ({ libraryQuestionId: r.libraryQuestionId.toString(), key: r.key, text: r.text }));
}

/** The selection a preset button produces: its library rows, ticked. */
async function presetSelection(key: PresetKey): Promise<QuestionSelection> {
  const lib = await library();
  const wanted = new Set(REPORT_PRESETS[key].questionKeys);
  return lib.filter((q) => wanted.has(q.key)).map((q) => ({ kind: "library" as const, libraryQuestionId: q.libraryQuestionId }));
}

/** Save a selection on a report through the update route, as the editor's Save does. */
async function saveQuestions(reportId: string, questions: QuestionSelection, presetKey?: PresetKey | null): Promise<Response> {
  return patchRoute(json({ questions, ...(presetKey === undefined ? {} : { presetKey }) }, "PATCH"), report(reportId));
}

async function auditRows(action: string) {
  return testDb.auditEvent.findMany({ where: { action }, orderBy: { occurredAt: "asc" } });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetBasAvailabilityCache();
  // resetDb FIRST: it truncates the report tables, whose site_id references
  // the buildings dropBuildings removes. The other order trips the foreign
  // key and leaves ZZTEST_RPT rows behind for the next file to find.
  await resetDb();
  await dropBuildings();
  await seedChangeOrdersModule();
  await seedBasModule();
  // resetDb truncates employees CASCADE, which empties the library (its
  // added_by column references employees). Re-installed as the seed would.
  await seedBasReportLibrary(testDb);
  people = await seedPeople();
  await seedBuildings();
});

afterAll(async () => {
  await resetDb();
  await dropBuildings();
  await disconnectDb();
});

// ---------------------------------------------------------------------------
// Visibility: owner or module admin, everyone else 404
// ---------------------------------------------------------------------------

describe("who may see a report", () => {
  it("the owner creates a draft, reads it back, and sees it in the list", async () => {
    const reportId = await createDraft({ description: "first" });
    const d = await detail(reportId);
    expect(d).toMatchObject({
      name: "ZZTEST weekly",
      description: "first",
      state: "draft",
      nextRunAt: null,
      isOwner: true,
      ownerEmail: people.owner.email,
      presetKey: null,
      analysisWindow: "7d",
      timeOfDay: "06:00",
      stationsSelected: 0,
      stationsOnSite: 2,
      questionCount: 0,
      recipientCount: 0,
      lastRun: null,
    });
    expect(d.site).toMatchObject({ siteId: nySite.toString(), name: "ZZTEST_RPT_NY", timezone: NY });
    expect(d.scheduleText).toBe("Every Monday at 06:00 (America/New_York) · last 7 days");
    expect(d.stations.map((s) => s.selected)).toEqual([false, false]);

    const list = await body<ReportsList>(await listRoute());
    expect(list.reports.map((r) => r.reportId)).toEqual([reportId]);
    expect(list.reportsInDatabase).toBe(1);
    expect(list.canAdminister).toBe(false);

    const created = await auditRows("bas.report_created");
    expect(created).toHaveLength(1);
    expect(created[0]?.actorEmployeeId).toBe(people.owner.id);
    expect(created[0]?.metadata).toMatchObject({ reportId, name: "ZZTEST weekly", siteName: "ZZTEST_RPT_NY" });
  });

  it("a BAS user who is neither owner nor admin is told nothing exists, on every route", async () => {
    const reportId = await createDraft();
    signedInAs(people.other.entraOid!);

    const responses = await Promise.all([
      getRoute(bare(), report(reportId)),
      patchRoute(json({ name: "ZZTEST stolen" }, "PATCH"), report(reportId)),
      deleteRoute(bare("DELETE"), report(reportId)),
      stateRoute(json({ action: "activate" }), report(reportId)),
      patchRoute(json({ questions: [{ kind: "inline", text: "sneaky" }] }, "PATCH"), report(reportId)),
      addRecipientRoute(json({ email: "zztest.other@phb1899.com" }), report(reportId)),
      removeRecipientRoute(bare("DELETE"), recipient(reportId, "zztest.other@phb1899.com")),
    ]);
    for (const r of responses) {
      expect(r.status).toBe(404);
      expect(r.status).not.toBe(403);
      expect(await r.text()).not.toContain("ZZTEST weekly");
    }

    const list = await body<ReportsList>(await listRoute());
    expect(list.reports).toEqual([]);
    expect(list.reportsInDatabase).toBe(0);

    // Nothing changed.
    signedInAs(people.owner.entraOid!);
    expect((await detail(reportId)).name).toBe("ZZTEST weekly");
  });

  it("a module admin sees it, may edit it, and the audit row names the admin", async () => {
    const reportId = await createDraft();
    signedInAs(people.admin.entraOid!);

    const d = await detail(reportId);
    expect(d.isOwner).toBe(false);
    expect(d.ownerEmail).toBe(people.owner.email);

    const list = await body<ReportsList>(await listRoute());
    expect(list.reports.map((r) => r.reportId)).toEqual([reportId]);
    expect(list.canAdminister).toBe(true);

    const patched = await patchRoute(json({ name: "ZZTEST renamed by admin" }, "PATCH"), report(reportId));
    expect(patched.status).toBe(200);
    expect((await detail(reportId)).name).toBe("ZZTEST renamed by admin");
    const updated = await auditRows("bas.report_updated");
    expect(updated.at(-1)?.actorEmployeeId).toBe(people.admin.id);
    expect(updated.at(-1)?.metadata).toMatchObject({ previousName: "ZZTEST weekly", name: "ZZTEST renamed by admin" });
  });

  it("an employee without the BAS grant gets 404 from the list and the options", async () => {
    const nobody = await createEmployee({ email: "zztest.nobody@phb1899.com" });
    signedInAs(nobody.entraOid!);
    expect((await listRoute()).status).toBe(404);
    expect((await optionsRoute()).status).toBe(404);
    expect((await libraryRoute()).status).toBe(404);
  });

  it("refuses bad input as 422, a stray key included, and a station on another building as 409", async () => {
    signedInAs(people.owner.entraOid!);
    expect((await createRoute(json(baseReport(nySite, { name: "   " })))).status).toBe(422);
    expect((await createRoute(json(baseReport(nySite, { extra: 1 })))).status).toBe(422);
    expect((await createRoute(json(baseReport(nySite, { timeOfDay: "6:00" })))).status).toBe(422);
    expect((await createRoute(json(baseReport(nySite, { schedule: { kind: "weekly", weekdays: [] } })))).status).toBe(422);

    const wrongStation = await createRoute(json(baseReport(nySite, { stationIds: [laStation.toString()] })));
    expect(wrongStation.status).toBe(409);
    expect(await errorCode(wrongStation)).toBe("station_other_building");

    const subset = await createRoute(json(baseReport(nySite, { stationIds: [nyStations[0]!.toString()] })));
    expect(subset.status).toBe(201);
    const d = await detail((await body<{ reportId: string }>(subset)).reportId);
    expect(d.stationsSelected).toBe(1);
    expect(d.stations.filter((s) => s.selected).map((s) => s.stationId)).toEqual([nyStations[0]!.toString()]);
  });

  it("one person's reports cannot share a name, case-insensitively", async () => {
    await createDraft();
    signedInAs(people.owner.entraOid!);
    const clash = await createRoute(json(baseReport(nySite, { name: "zztest WEEKLY" })));
    expect(clash.status).toBe(409);
    expect(await errorCode(clash)).toBe("name_taken");
    // Another person may use the same name.
    signedInAs(people.other.entraOid!);
    expect((await createRoute(json(baseReport(nySite)))).status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// The owner is always a recipient and never a row
// ---------------------------------------------------------------------------

describe("the owner is always a recipient and never a row", () => {
  it("adding the owner's address is refused, however it is spelled", async () => {
    const reportId = await createDraft();
    for (const email of [people.owner.email, people.owner.email.toUpperCase(), ` ${people.owner.email} `]) {
      const response = await addRecipientRoute(json({ email, confirmed: true }), report(reportId));
      expect(response.status, email).toBe(409);
      expect(await errorCode(response)).toBe("owner_is_recipient");
    }
    expect((await detail(reportId)).recipients).toEqual([]);
    expect(await testDb.basReportRecipient.count()).toBe(0);
    expect(await auditRows("bas.report_recipient_added")).toEqual([]);
  });

  it("removing the owner's address is refused rather than reported as not found", async () => {
    const reportId = await createDraft();
    const response = await removeRecipientRoute(bare("DELETE"), recipient(reportId, people.owner.email.toUpperCase()));
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("owner_is_recipient");
    // A module admin is refused the same way: the rule is about the owner, not the caller.
    signedInAs(people.admin.entraOid!);
    const byAdmin = await removeRecipientRoute(bare("DELETE"), recipient(reportId, people.owner.email));
    expect(await errorCode(byAdmin)).toBe("owner_is_recipient");
  });

  it("the recipient count is the additional recipients only", async () => {
    const reportId = await createDraft();
    expect((await detail(reportId)).recipientCount).toBe(0);
    await addRecipientRoute(json({ email: "zztest.colleague@phb1899.com" }), report(reportId));
    expect((await detail(reportId)).recipientCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// External recipients: warn, confirm, audit
// ---------------------------------------------------------------------------

describe("external recipients", () => {
  it("an address outside phb1899.com is refused until confirmed, then stored and audited as external", async () => {
    const reportId = await createDraft();

    const refused = await addRecipientRoute(json({ email: "Vendor@Example.com" }), report(reportId));
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe("external_unconfirmed");
    expect(await testDb.basReportRecipient.count()).toBe(0);
    expect(await auditRows("bas.report_recipient_added")).toEqual([]);

    const added = await addRecipientRoute(json({ email: "Vendor@Example.com", confirmed: true }), report(reportId));
    expect(added.status).toBe(201);
    const view = await body<RecipientView>(added);
    expect(view.email).toBe("vendor@example.com");
    expect(view.isExternal).toBe(true);
    expect(view.confirmedAt).not.toBeNull();
    expect(view.addedBy).toBe(people.owner.email);

    const rows = await auditRows("bas.report_recipient_added");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorEmployeeId).toBe(people.owner.id);
    expect(rows[0]?.metadata).toMatchObject({
      reportId,
      name: "ZZTEST weekly",
      email: "vendor@example.com",
      isExternal: true,
      confirmed: true,
    });

    const stored = await testDb.basReportRecipient.findFirstOrThrow();
    expect(stored.isExternal).toBe(true);
    expect(stored.confirmedById).toBe(people.owner.id);
  });

  it("a company address needs no confirmation and is audited as internal", async () => {
    const reportId = await createDraft();
    const added = await addRecipientRoute(json({ email: "Jim.Schwarz@PHB1899.com" }), report(reportId));
    expect(added.status).toBe(201);
    const view = await body<RecipientView>(added);
    expect(view).toMatchObject({ email: "jim.schwarz@phb1899.com", isExternal: false, confirmedAt: null });
    const rows = await auditRows("bas.report_recipient_added");
    expect(rows[0]?.metadata).toMatchObject({ email: "jim.schwarz@phb1899.com", isExternal: false, confirmed: false });
  });

  it("the same address twice is refused, removal is audited with the external flag, and a second removal is 404", async () => {
    const reportId = await createDraft();
    await addRecipientRoute(json({ email: "vendor@example.com", confirmed: true }), report(reportId));
    const twice = await addRecipientRoute(json({ email: "VENDOR@example.com", confirmed: true }), report(reportId));
    expect(twice.status).toBe(409);
    expect(await errorCode(twice)).toBe("recipient_exists");

    const removed = await removeRecipientRoute(bare("DELETE"), recipient(reportId, "vendor@example.com"));
    expect(removed.status).toBe(200);
    expect((await detail(reportId)).recipients).toEqual([]);
    const rows = await auditRows("bas.report_recipient_removed");
    expect(rows[0]?.metadata).toMatchObject({ email: "vendor@example.com", isExternal: true });

    const again = await removeRecipientRoute(bare("DELETE"), recipient(reportId, "vendor@example.com"));
    expect(again.status).toBe(404);
    expect(await errorCode(again)).toBe("recipient_not_found");
  });

  it("an address that is not an address is 422", async () => {
    const reportId = await createDraft();
    expect((await addRecipientRoute(json({ email: "not an address" }), report(reportId))).status).toBe(422);
    expect((await addRecipientRoute(json({ email: "a@b.c", stray: 1 }), report(reportId))).status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Presets: buttons that tick a set, and a label that follows the selection
// ---------------------------------------------------------------------------

describe("the presets are labels, not locks", () => {
  it("health_weekly sent as a selection stores the twenty in position order and keeps the label; untick one and the label goes, tick it back and it returns", async () => {
    const weekly = await presetSelection("health_weekly");
    // The editor's order is irrelevant: the server stores library order.
    const reportId = await createDraft({ questions: [...weekly].reverse(), presetKey: "health_weekly" });
    const d = await detail(reportId);
    expect(d.presetKey).toBe("health_weekly");
    expect(d.presetLabel).toBe("Standard weekly health report");
    expect(d.questions).toHaveLength(20);
    expect(d.questions.map((q) => q.libraryKey)).toEqual([...REPORT_PRESETS.health_weekly.questionKeys]);
    expect(d.questions.map((q) => q.position)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(d.questions.every((q) => q.kind === "library" && q.libraryKind === "computed")).toBe(true);
    expect(d.questions[0]).toMatchObject({ section: "summary", sectionLabel: "Summary", appliesToLabel: "All" });
    expect((await auditRows("bas.report_created"))[0]?.metadata).toMatchObject({ presetKey: "health_weekly", questions: 20, library: 20, personal: 0, inline: 0 });

    // Untick q03: nothing is locked, and the label no longer applies.
    const q03Id = (await library()).find((l) => l.key === "q03_zone_comfort")!.libraryQuestionId;
    const nineteen = weekly.filter((q) => q.kind === "library" && q.libraryQuestionId !== q03Id);
    expect((await saveQuestions(reportId, nineteen)).status).toBe(200);
    let after = await detail(reportId);
    expect(after.questions).toHaveLength(19);
    expect(after.questions.map((q) => q.libraryKey)).not.toContain("q03_zone_comfort");
    expect(after.presetKey).toBeNull();
    expect(after.presetLabel).toBeNull();
    const set = (await auditRows("bas.report_questions_changed")).at(-1);
    expect(set?.metadata).toMatchObject({ change: "set", count: 19, presetKey: null, library: 19 });
    expect((await auditRows("bas.report_updated")).at(-1)?.metadata).toMatchObject({ changes: { presetKey: { from: "health_weekly", to: null } } });

    // Tick it back with the button: the label returns.
    expect((await saveQuestions(reportId, weekly, "health_weekly")).status).toBe(200);
    after = await detail(reportId);
    expect(after.questions.map((q) => q.libraryKey)).toEqual([...REPORT_PRESETS.health_weekly.questionKeys]);
    expect(after.presetKey).toBe("health_weekly");

    // The same twenty without the button (Select all) is not labelled: the label says what was clicked.
    expect((await saveQuestions(reportId, weekly, null)).status).toBe(200);
    expect((await detail(reportId)).presetKey).toBeNull();
    // And a preset sent alone never changes the questions; it is stored only when the set matches.
    expect((await patchRoute(json({ presetKey: "health_daily" }, "PATCH"), report(reportId))).status).toBe(200);
    after = await detail(reportId);
    expect(after.questions).toHaveLength(20);
    expect(after.presetKey).toBeNull();
    expect((await patchRoute(json({ presetKey: "health_weekly" }, "PATCH"), report(reportId))).status).toBe(200);
    expect((await detail(reportId)).presetKey).toBe("health_weekly");
  });

  it("health_daily is Summary, Space Comfort and Data Health; mixing in custom questions keeps the label", async () => {
    const daily = await presetSelection("health_daily");
    const reportId = await createDraft({ questions: daily, presetKey: "health_daily" });
    expect((await detail(reportId)).questions.map((q) => q.libraryKey)).toEqual([...REPORT_PRESETS.health_daily.questionKeys]);
    expect((await detail(reportId)).presetLabel).toBe("Daily critical-site report");

    // The daily set plus two of the person's own: still the daily report, with two more.
    const mixed: QuestionSelection = [
      { kind: "inline", text: "Did the chiller short-cycle overnight?" },
      ...daily,
      { kind: "inline", text: "Which VAVs were warm while occupied?", saveToLibrary: true },
    ];
    expect((await saveQuestions(reportId, mixed, "health_daily")).status).toBe(200);
    const d = await detail(reportId);
    expect(d.presetKey).toBe("health_daily");
    expect(d.questions).toHaveLength(8);
    expect(d.questions.map((q) => q.kind)).toEqual(["library", "library", "library", "library", "library", "library", "personal", "inline"]);
    expect(d.questions[6]?.text).toBe("Which VAVs were warm while occupied?");
    expect(d.questions[7]?.text).toBe("Did the chiller short-cycle overnight?");

    // Switching to the weekly button replaces the shared part and leaves the custom ones.
    const weekly = await presetSelection("health_weekly");
    expect((await saveQuestions(reportId, [...weekly, { kind: "personal", personalQuestionId: d.questions[6]!.personalQuestionId! }, { kind: "inline", text: "Did the chiller short-cycle overnight?" }], "health_weekly")).status).toBe(200);
    const switched = await detail(reportId);
    expect(switched.questions).toHaveLength(22);
    expect(switched.presetLabel).toBe("Standard weekly health report");
    expect(switched.questions.slice(20).map((q) => q.kind)).toEqual(["personal", "inline"]);
  });

  it("a report made under Phase 1's preset rows round-trips through the new save to the same question set", async () => {
    // What Phase 1 wrote: preset_key set, twenty library rows in the preset's order, no API in between.
    const lib = await library();
    const byKey = new Map(lib.map((q) => [q.key, q.libraryQuestionId]));
    const created = await testDb.basReportDefinition.create({
      data: {
        ownerEmployeeId: people.owner.id,
        name: "ZZTEST phase one",
        siteId: nySite,
        presetKey: "health_weekly",
        scheduleKind: "weekly",
        scheduleParams: { weekdays: [1] },
        timeOfDay: "06:00",
        questions: {
          create: REPORT_PRESETS.health_weekly.questionKeys.map((key, position) => ({ position, kind: "library", libraryQuestionId: BigInt(byKey.get(key)!) })),
        },
      },
      select: { reportId: true },
    });
    const reportId = created.reportId.toString();
    signedInAs(people.owner.entraOid!);
    const before = await detail(reportId);
    expect(before.presetKey).toBe("health_weekly");
    expect(before.questions.map((q) => q.libraryKey)).toEqual([...REPORT_PRESETS.health_weekly.questionKeys]);

    // The editor loads the detail into its checklist and saves it unchanged.
    const asLoaded: QuestionSelection = before.questions.map((q) => ({ kind: "library" as const, libraryQuestionId: q.libraryQuestionId! }));
    const saved = await patchRoute(json({ name: before.name, questions: asLoaded, presetKey: before.presetKey }, "PATCH"), report(reportId));
    expect(saved.status).toBe(200);
    expect(await body<{ changed: boolean }>(saved)).toMatchObject({ changed: false });
    const after = await detail(reportId);
    expect(after.questions.map((q) => [q.libraryKey, q.position])).toEqual(before.questions.map((q) => [q.libraryKey, q.position]));
    expect(after.questions.map((q) => q.questionId)).toEqual(before.questions.map((q) => q.questionId));
    expect(after.presetKey).toBe("health_weekly");
    expect(await auditRows("bas.report_questions_changed")).toEqual([]);
    expect(await auditRows("bas.report_updated")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The selection: library, mine, typed; order; duplicates; whose questions
// ---------------------------------------------------------------------------

describe("the question selection", () => {
  it("stores shared questions in library order, then mine, then typed; a typed one saved for reuse becomes mine; a question twice is refused", async () => {
    const lib = await library();
    const q20 = lib.find((q) => q.key === "q20_data_health")!;
    const q03 = lib.find((q) => q.key === "q03_zone_comfort")!;
    const reportId = await createDraft({
      questions: [
        { kind: "inline", text: "Which VAVs were warm while occupied?" },
        { kind: "library", libraryQuestionId: q20.libraryQuestionId },
        { kind: "inline", text: "Did the boiler cycle overnight?", saveToLibrary: true },
        { kind: "library", libraryQuestionId: q03.libraryQuestionId },
      ],
    });

    const d = await detail(reportId);
    expect(d.questions.map((q) => [q.kind, q.position, q.libraryKey ?? q.text])).toEqual([
      ["library", 0, "q03_zone_comfort"],
      ["library", 1, "q20_data_health"],
      ["personal", 2, "Did the boiler cycle overnight?"],
      ["inline", 3, "Which VAVs were warm while occupied?"],
    ]);
    expect(d.presetKey).toBeNull();

    const mine = await body<PersonalQuestionView[]>(await listPersonalRoute());
    expect(mine.map((p) => [p.text, p.usedInReports])).toEqual([["Did the boiler cycle overnight?", 1]]);
    expect(d.questions[2]?.personalQuestionId).toBe(mine[0]!.personalQuestionId);
    expect((await auditRows("bas.personal_question_created"))[0]?.metadata).toMatchObject({ fromReportId: reportId });

    // The same shared question twice, or the same personal one twice: refused, nothing written.
    const dup = await saveQuestions(reportId, [
      { kind: "library", libraryQuestionId: q20.libraryQuestionId },
      { kind: "library", libraryQuestionId: q20.libraryQuestionId },
    ]);
    expect(dup.status).toBe(409);
    expect(await errorCode(dup)).toBe("question_exists");
    const dupMine = await saveQuestions(reportId, [
      { kind: "personal", personalQuestionId: mine[0]!.personalQuestionId },
      { kind: "personal", personalQuestionId: mine[0]!.personalQuestionId },
    ]);
    expect(await errorCode(dupMine)).toBe("question_exists");
    expect((await detail(reportId)).questions).toHaveLength(4);

    // Unticking is saving without it; the rest close up.
    expect((await saveQuestions(reportId, [{ kind: "library", libraryQuestionId: q20.libraryQuestionId }, { kind: "personal", personalQuestionId: mine[0]!.personalQuestionId }])).status).toBe(200);
    const fewer = await detail(reportId);
    expect(fewer.questions.map((q) => [q.kind, q.position])).toEqual([["library", 0], ["personal", 1]]);
    // Clearing everything is allowed on a draft; activation is what needs a question.
    expect((await saveQuestions(reportId, [])).status).toBe(200);
    expect((await detail(reportId)).questions).toEqual([]);

    const changes = await auditRows("bas.report_questions_changed");
    expect(changes.map((r) => (r.metadata as { change: string; count: number }).count)).toEqual([2, 0]);
    expect(changes.every((r) => (r.metadata as { change: string }).change === "set")).toBe(true);

    // A library id that does not exist, and a disabled one, are refused by name.
    const missing = await saveQuestions(reportId, [{ kind: "library", libraryQuestionId: "999999" }]);
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe("library_question_not_found");
    await testDb.basLibraryQuestion.update({ where: { libraryQuestionId: BigInt(q03.libraryQuestionId) }, data: { enabled: false } });
    const off = await saveQuestions(reportId, [{ kind: "library", libraryQuestionId: q03.libraryQuestionId }]);
    expect(off.status).toBe(409);
    expect(await errorCode(off)).toBe("library_question_disabled");
  });

  it("a shared question turned off after it was saved stays on the report when saved again, and only then", async () => {
    const lib = await library();
    const q03 = lib.find((q) => q.key === "q03_zone_comfort")!;
    const q20 = lib.find((q) => q.key === "q20_data_health")!;
    const reportId = await createDraft({ questions: [{ kind: "library", libraryQuestionId: q03.libraryQuestionId }] });
    await testDb.basLibraryQuestion.update({ where: { libraryQuestionId: BigInt(q03.libraryQuestionId) }, data: { enabled: false } });
    // Saved with it still ticked: kept.
    expect((await saveQuestions(reportId, [{ kind: "library", libraryQuestionId: q03.libraryQuestionId }, { kind: "library", libraryQuestionId: q20.libraryQuestionId }])).status).toBe(200);
    expect((await detail(reportId)).questions.map((q) => q.libraryKey)).toEqual(["q03_zone_comfort", "q20_data_health"]);
    // Unticked and saved: gone, and it cannot come back while it is off.
    expect((await saveQuestions(reportId, [{ kind: "library", libraryQuestionId: q20.libraryQuestionId }])).status).toBe(200);
    expect(await errorCode(await saveQuestions(reportId, [{ kind: "library", libraryQuestionId: q03.libraryQuestionId }]))).toBe("library_question_disabled");
  });

  it("a personal question is its owner's: another person's id is not found, an admin cannot put theirs on someone else's report, and an admin's save keeps the owner's", async () => {
    const reportId = await createDraft();
    // `other` saves a question; the owner cannot use it.
    signedInAs(people.other.entraOid!);
    const theirs = await body<{ personalQuestionId: string }>(
      await createPersonalRoute(json({ text: "other's question" })),
    );
    signedInAs(people.owner.entraOid!);
    const notMine = await saveQuestions(reportId, [{ kind: "personal", personalQuestionId: theirs.personalQuestionId }]);
    expect(notMine.status).toBe(404);
    expect(await errorCode(notMine)).toBe("personal_question_not_found");

    // The owner puts one of their own on it.
    const mine = await body<{ personalQuestionId: string }>(await createPersonalRoute(json({ text: "owner's question" })));
    expect((await saveQuestions(reportId, [{ kind: "personal", personalQuestionId: mine.personalQuestionId }])).status).toBe(200);

    // The admin has a question of their own and works on the owner's report.
    signedInAs(people.admin.entraOid!);
    const admins = await body<{ personalQuestionId: string }>(await createPersonalRoute(json({ text: "admin's question" })));
    const onOthers = await saveQuestions(reportId, [
      { kind: "personal", personalQuestionId: mine.personalQuestionId },
      { kind: "personal", personalQuestionId: admins.personalQuestionId },
    ]);
    expect(onOthers.status).toBe(409);
    expect(await errorCode(onOthers)).toBe("personal_question_not_owner");
    const saveOnOthers = await saveQuestions(reportId, [{ kind: "personal", personalQuestionId: mine.personalQuestionId }, { kind: "inline", text: "x", saveToLibrary: true }]);
    expect(await errorCode(saveOnOthers)).toBe("personal_question_not_owner");
    // The admin's save with the owner's question still ticked, plus typed text, is fine: the owner's question is kept.
    const lib = await library();
    const kept = await saveQuestions(reportId, [
      { kind: "library", libraryQuestionId: lib.find((q) => q.key === "q20_data_health")!.libraryQuestionId },
      { kind: "personal", personalQuestionId: mine.personalQuestionId },
      { kind: "inline", text: "typed by the admin" },
    ]);
    expect(kept.status).toBe(200);
    const d = await detail(reportId);
    expect(d.questions.map((q) => [q.kind, q.text])).toEqual([
      ["library", lib.find((q) => q.key === "q20_data_health")!.text],
      ["personal", "owner's question"],
      ["inline", "typed by the admin"],
    ]);
    expect((await auditRows("bas.report_questions_changed")).at(-1)?.actorEmployeeId).toBe(people.admin.id);
  });

  it("refuses the removed per-report limits with 400 and a sentence saying where the ceiling went, on create and on update", async () => {
    signedInAs(people.owner.entraOid!);
    for (const extra of [{ budgetUsd: 2 }, { maxMinutes: 20 }, { budgetUsd: 2, maxMinutes: 20 }]) {
      const response = await createRoute(json(baseReport(nySite, extra)));
      expect(response.status, JSON.stringify(extra)).toBe(400);
      expect(await errorCode(response)).toBe("limits_removed");
    }
    expect(await errorMessage(await createRoute(json(baseReport(nySite, { budgetUsd: 2 }))))).toBe(REMOVED_LIMITS_MESSAGE);
    expect(await testDb.basReportDefinition.count()).toBe(0);

    const reportId = await createDraft();
    const patched = await patchRoute(json({ name: "ZZTEST renamed", maxMinutes: 5 }, "PATCH"), report(reportId));
    expect(patched.status).toBe(400);
    expect(await errorCode(patched)).toBe("limits_removed");
    expect((await detail(reportId)).name).toBe("ZZTEST weekly");
    // The options no longer offer a default for either.
    const options = await body<Record<string, unknown>>(await optionsRoute());
    expect(options).not.toHaveProperty("defaultBudgetUsd");
    expect(options).not.toHaveProperty("defaultMaxMinutes");
    expect(options).not.toHaveProperty("maxMinutesLimit");
  });
});

// ---------------------------------------------------------------------------
// The personal library
// ---------------------------------------------------------------------------

describe("the personal library", () => {
  it("creates, lists, edits and deletes the caller's own questions, refusing to delete one in use", async () => {
    signedInAs(people.owner.entraOid!);
    const created = await createPersonalRoute(json({ text: "  Is the chiller short cycling?  " }));
    expect(created.status).toBe(201);
    const { personalQuestionId } = await body<{ personalQuestionId: string }>(created);

    let mine = await body<PersonalQuestionView[]>(await listPersonalRoute());
    expect(mine.map((p) => p.text)).toEqual(["Is the chiller short cycling?"]);

    expect((await patchPersonalRoute(json({ text: "Is the chiller cycling?" }, "PATCH"), personal(personalQuestionId))).status).toBe(200);
    mine = await body<PersonalQuestionView[]>(await listPersonalRoute());
    expect(mine[0]?.text).toBe("Is the chiller cycling?");

    // Used on a report: cannot be deleted.
    const reportId = await createDraft({ questions: [{ kind: "personal", personalQuestionId }] });
    const inUse = await deletePersonalRoute(bare("DELETE"), personal(personalQuestionId));
    expect(inUse.status).toBe(409);
    expect(await errorCode(inUse)).toBe("personal_question_in_use");

    // Nobody else sees it, and nobody else can edit it.
    signedInAs(people.other.entraOid!);
    expect(await body<PersonalQuestionView[]>(await listPersonalRoute())).toEqual([]);
    expect((await patchPersonalRoute(json({ text: "hijack" }, "PATCH"), personal(personalQuestionId))).status).toBe(404);
    expect((await deletePersonalRoute(bare("DELETE"), personal(personalQuestionId))).status).toBe(404);

    // Off the report, it can go.
    signedInAs(people.owner.entraOid!);
    expect((await saveQuestions(reportId, [])).status).toBe(200);
    expect((await deletePersonalRoute(bare("DELETE"), personal(personalQuestionId))).status).toBe(200);
    expect(await body<PersonalQuestionView[]>(await listPersonalRoute())).toEqual([]);
    expect((await auditRows("bas.personal_question_deleted")).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// State machine and the next run
// ---------------------------------------------------------------------------

describe("draft -> active <-> paused, with the next run in the building's zone", () => {
  it("refuses to activate with no questions, then activates with the next Monday 06:00 New York as the next run", async () => {
    const reportId = await createDraft();
    const empty = await stateRoute(json({ action: "activate" }), report(reportId));
    expect(empty.status).toBe(409);
    expect(await errorCode(empty)).toBe("report_not_ready");

    expect((await saveQuestions(reportId, await presetSelection("health_daily"), "health_daily")).status).toBe(200);
    const before = new Date();
    const activated = await stateRoute(json({ action: "activate" }), report(reportId));
    expect(activated.status).toBe(200);
    const { state, nextRunAt } = await body<{ state: string; nextRunAt: string | null }>(activated);
    expect(state).toBe("active");
    expect(nextRunAt).not.toBeNull();
    const next = new Date(nextRunAt!);
    expect(next.getTime()).toBeGreaterThan(before.getTime());
    expect(localParts(next, NY)).toMatchObject({ hour: 6, minute: 0, weekday: 1 });
    expect(next.toISOString()).toBe(computeNextRun(WEEKLY_MONDAY, "06:00", NY, before).toISOString());

    const stored = await testDb.basReportDefinition.findUniqueOrThrow({ where: { reportId: BigInt(reportId) } });
    expect(stored.state).toBe("active");
    expect(stored.nextRunAt?.toISOString()).toBe(nextRunAt);

    const again = await stateRoute(json({ action: "activate" }), report(reportId));
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("invalid_state");

    const paused = await stateRoute(json({ action: "pause" }), report(reportId));
    expect(await body<{ state: string; nextRunAt: string | null }>(paused)).toEqual({ state: "paused", nextRunAt: null });
    const resumed = await body<{ state: string; nextRunAt: string | null }>(await stateRoute(json({ action: "resume" }), report(reportId)));
    expect(resumed.state).toBe("active");
    expect(localParts(new Date(resumed.nextRunAt!), NY)).toMatchObject({ hour: 6, weekday: 1 });

    const transitions = (await auditRows("bas.report_state_changed")).map((r) => {
      const m = r.metadata as { from: string; to: string };
      return `${m.from}->${m.to}`;
    });
    expect(transitions).toEqual(["draft->active", "active->paused", "paused->active"]);
  });

  it("a draft cannot be paused or resumed, and the list shows the state and the next run", async () => {
    const reportId = await createDraft();
    for (const action of ["pause", "resume"]) {
      const r = await stateRoute(json({ action }), report(reportId));
      expect(r.status, action).toBe(409);
      expect(await errorCode(r)).toBe("invalid_state");
    }
    const list = await body<ReportsList>(await listRoute());
    expect(list.reports[0]).toMatchObject({ state: "draft", nextRunAt: null });
  });

  it("changing an active report's schedule or building recomputes the next run from the local time, in the new zone", async () => {
    const reportId = await createDraft({ questions: await presetSelection("health_daily"), presetKey: "health_daily" });
    await stateRoute(json({ action: "activate" }), report(reportId));

    const daily18 = await patchRoute(json({ schedule: { kind: "daily" }, timeOfDay: "18:00" }, "PATCH"), report(reportId));
    expect(daily18.status).toBe(200);
    const { nextRunAt } = await body<{ nextRunAt: string | null }>(daily18);
    expect(localParts(new Date(nextRunAt!), NY)).toMatchObject({ hour: 18, minute: 0 });

    // Half a schedule is refused: the cadence without its time.
    expect((await patchRoute(json({ schedule: { kind: "daily" } }, "PATCH"), report(reportId))).status).toBe(422);

    // Los Angeles: the same 18:00, on that building's clock.
    const moved = await patchRoute(json({ siteId: laSite.toString() }, "PATCH"), report(reportId));
    expect(moved.status).toBe(200);
    const d = await detail(reportId);
    expect(d.site.timezone).toBe(LA);
    expect(d.stationsSelected).toBe(0);
    expect(localParts(new Date(d.nextRunAt!), LA)).toMatchObject({ hour: 18, minute: 0 });
    expect(d.scheduleText).toBe("Every day at 18:00 (America/Los_Angeles) · last 7 days");
  });

  it("deletes a report with everything on it, and audits what went", async () => {
    const reportId = await createDraft({ questions: await presetSelection("health_weekly"), presetKey: "health_weekly" });
    await addRecipientRoute(json({ email: "zztest.colleague@phb1899.com" }), report(reportId));
    expect((await deleteRoute(bare("DELETE"), report(reportId))).status).toBe(200);
    expect((await getRoute(bare(), report(reportId))).status).toBe(404);
    expect(await testDb.basReportQuestion.count()).toBe(0);
    expect(await testDb.basReportRecipient.count()).toBe(0);
    const deleted = await auditRows("bas.report_deleted");
    expect(deleted[0]?.metadata).toMatchObject({ reportId, name: "ZZTEST weekly", questions: 20, recipients: 1 });
  });
});

// ---------------------------------------------------------------------------
// Every route is guarded by the wrapper
// ---------------------------------------------------------------------------

describe("the Reports routes go through withBas", () => {
  const ROOT = "app/api/modules/bas/reports";

  async function routeFiles(): Promise<string[]> {
    const found: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name === "route.ts") found.push(full);
      }
    }
    await walk(path.join(process.cwd(), ROOT));
    return found;
  }

  it("finds the routes at all, and every one uses withBas - not the settings wrapper, not a guard directly", async () => {
    const files = await routeFiles();
    // Eleven route files shipped with Phase 1; the per-question ones went on
    // 2026-11-12 and the ceiling and usage ones came. A floor, so adding one
    // is not a chore and a walker that stopped seeing them is caught.
    expect(files.length).toBeGreaterThanOrEqual(13);
    expect(files.some((f) => f.includes("questions"))).toBe(false);
    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, `${file} must use withBas`).toContain("withBas(");
      // Reports are for every BAS user; the admin wrapper would hide the whole
      // tab from everyone but module admins.
      expect(source, `${file} must not use withBasSettings`).not.toContain("withBasSettings(");
      expect(source, `${file} must not call the guard itself`).not.toContain("requireModuleAccess(");
      expect(source, `${file} must not call the admin guard itself`).not.toContain("requireModuleAdmin(");
      expect(source, `${file} must map refusals through reportsResult or answer a plain read`).toMatch(/reportsResult\(|ok\(await/);
    }
  });
});
