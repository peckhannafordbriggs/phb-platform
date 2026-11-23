import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { fingerprintOf } from "@/lib/modules/bas/reports/engine/compare";
import { createFixedNarrator } from "@/lib/modules/bas/reports/engine/narrative";
import { executeReportRun } from "@/lib/modules/bas/reports/engine/run";
import { enqueueRunDeliveries } from "@/lib/modules/bas/reports/deliveries";
import {
  DELETE_CONFIRM_SENTENCE,
  DELIVERY_DELETED_SENTENCE,
  PDF_DELETED_SENTENCE,
  RECYCLE_DAYS,
  REPORT_DELETE_IN_FLIGHT_TITLE,
  SCHEDULE_DELETED_LABEL,
  reportDeleteHeading,
  reportDeleteSentence,
  daysRemaining,
  deleteConfirmHeading,
  describeDaysRemaining,
  describeRunRetention,
  monthsBefore,
} from "@/lib/modules/bas/reports/deletion-words";
import { drainDeliveries } from "@/lib/modules/bas/reports/email/send";
import type { ReportMail, ReportMailer } from "@/lib/modules/bas/reports/email/mailer";
import { applyRunRetention, purgeDeletedRuns, runRetentionPass } from "@/lib/modules/bas/reports/run-deletion";
import { deleteRuns, getRun, listDeletedRuns, listRuns, restoreRuns, type DeletedRunsList, type RunSummary } from "@/lib/modules/bas/reports/runs-service";
import { changeReportState, createReport, deletePersonalQuestion, deleteReport, getReport, listReports } from "@/lib/modules/bas/reports/service";
import { enqueueRun } from "@/lib/modules/bas/reports/engine/queue";
import { runSchedulerPass } from "@/lib/modules/bas/reports/scheduler";
import { seedBasReportLibrary } from "@/prisma/bas-report-library";
import { GET as listRoute } from "@/app/api/modules/bas/reports/runs/route";
import { GET as runRoute } from "@/app/api/modules/bas/reports/runs/[runId]/route";
import { GET as pdfRoute } from "@/app/api/modules/bas/reports/runs/[runId]/pdf/route";
import { POST as retryRoute } from "@/app/api/modules/bas/reports/runs/[runId]/pdf/retry/route";
import { POST as resendRoute } from "@/app/api/modules/bas/reports/runs/[runId]/deliveries/resend/route";
import { POST as sendToMeRoute } from "@/app/api/modules/bas/reports/runs/[runId]/deliveries/send-to-me/route";
import { POST as deleteRoute } from "@/app/api/modules/bas/reports/runs/delete/route";
import { POST as restoreRoute } from "@/app/api/modules/bas/reports/runs/restore/route";
import { GET as deletedRoute } from "@/app/api/modules/bas/reports/runs/deleted/route";
import { DELETE as deleteReportRoute, GET as getReportRoute, PATCH as patchReportRoute } from "@/app/api/modules/bas/reports/[reportId]/route";
import { POST as runNowRoute } from "@/app/api/modules/bas/reports/[reportId]/runs/route";
import { DeleteRunsDialog, RunsTable, RunsToolbar } from "@/app/(modules)/bas/reports-generated";
import { DeletedRunsTable } from "@/app/(modules)/bas/reports-deleted";
import { ReportsTable } from "@/app/(modules)/bas/reports-list";
import { describeRetentionChoice } from "@/app/(modules)/bas/reports-editor";
import { ConfirmDialog } from "@/app/(modules)/bas/reports-confirm";
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
 * Deleting report runs, Recently deleted, the purge and retention
 * (2026-11-20), against the real test database and through the routes.
 *
 * Who may delete (the owner and a module admin; anyone else is told the run
 * does not exist), that a deleted run leaves the list and answers 404 to
 * everything a run offers until it is restored, that Recently deleted lists
 * it with the right days left, that the scheduler's purge removes it - with
 * its findings, deliveries and PDF - after RECYCLE_DAYS and not a minute
 * before, that retention deletes only runs older than the report keeps and
 * never under "never", that a deleted run is never the previous run of a
 * comparison, and that no email goes out for one.
 */

const authMock = vi.mocked(auth);
const NY = "America/New_York";
const DAY = 24 * 60 * 60 * 1000;

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

const viewerOf = (e: Awaited<ReturnType<typeof createEmployee>>) => ({ ...e, profileCompleted: true });
const runParam = (runId: string | bigint) => ({ params: Promise.resolve({ runId: runId.toString() }) });
const reportParam = (reportId: string) => ({ params: Promise.resolve({ reportId }) });
const get = (url = "http://localhost/api/modules/bas/reports/runs") => new Request(url);
const post = (body?: unknown) =>
  new Request("http://localhost/api/modules/bas/reports/runs/x", {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
const patch = (body: unknown) =>
  new Request("http://localhost/api/modules/bas/reports/1", { method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
async function errorBody(response: Response): Promise<{ code?: string; message?: string }> {
  return ((await response.json()) as { error?: { code?: string; message?: string } }).error ?? {};
}
async function dataOf<T>(response: Response): Promise<T> {
  return ((await response.json()) as { data: T }).data;
}

// ---------------------------------------------------------------------------
// Pure: the numbers and the words
// ---------------------------------------------------------------------------

describe("the recycle period and retention, as numbers and words", () => {
  it("days left are whole days rounded up: 15 on the day, 1 in the last day, 0 once due", () => {
    const deleted = new Date("2026-11-20T15:00:00.000Z");
    expect(RECYCLE_DAYS).toBe(15);
    expect(daysRemaining(deleted, deleted)).toBe(15);
    expect(daysRemaining(deleted, new Date(deleted.getTime() + 1))).toBe(15);
    expect(daysRemaining(deleted, new Date(deleted.getTime() + DAY))).toBe(14);
    expect(daysRemaining(deleted, new Date(deleted.getTime() + 14 * DAY + 1))).toBe(1);
    expect(daysRemaining(deleted, new Date(deleted.getTime() + 15 * DAY - 1))).toBe(1);
    expect(daysRemaining(deleted, new Date(deleted.getTime() + 15 * DAY))).toBe(0);
    expect(daysRemaining(deleted, new Date(deleted.getTime() + 40 * DAY))).toBe(0);
    expect(describeDaysRemaining(15)).toBe("15 days left");
    expect(describeDaysRemaining(1)).toBe("1 day left");
    expect(describeDaysRemaining(0)).toBe("Purged at the next pass");
  });

  it("months are calendar months in UTC, the day clamped to the month's end", () => {
    expect(monthsBefore(new Date("2026-11-20T15:30:00.000Z"), 3).toISOString()).toBe("2026-08-20T15:30:00.000Z");
    expect(monthsBefore(new Date("2026-11-20T15:30:00.000Z"), 12).toISOString()).toBe("2025-11-20T15:30:00.000Z");
    expect(monthsBefore(new Date("2026-05-31T00:00:00.000Z"), 3).toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(monthsBefore(new Date("2028-05-31T00:00:00.000Z"), 3).toISOString()).toBe("2028-02-29T00:00:00.000Z");
    expect(monthsBefore(new Date("2026-02-15T08:00:00.000Z"), 6).toISOString()).toBe("2025-08-15T08:00:00.000Z");
  });

  it("the confirmation names the count, and the Scheduled summary says nothing for never", () => {
    expect(deleteConfirmHeading(1)).toBe("Delete 1 run?");
    expect(deleteConfirmHeading(3)).toBe("Delete 3 runs?");
    expect(DELETE_CONFIRM_SENTENCE).toContain("15 days");
    expect(describeRunRetention(null)).toBeNull();
    expect(describeRunRetention(6)).toBe("Keeps runs 6 months");
    expect(describeRetentionChoice("never")).toBe("Every run is kept until someone deletes it.");
    expect(describeRetentionChoice("12")).toMatch(/^Runs older than 12 months move to Recently deleted, where they can be restored for 15 days/);
  });
});

// ---------------------------------------------------------------------------
// Rendered
// ---------------------------------------------------------------------------

describe("the screens, rendered", () => {
  const summary = (over: Partial<RunSummary>): RunSummary => ({
    runId: "1",
    reportId: "1",
    reportName: "ZZTEST weekly",
    reportDeleted: false,
    buildingName: "Office",
    status: "succeeded",
    trigger: "manual",
    periodStart: "2026-11-05T11:00:00.000Z",
    periodEnd: "2026-11-12T11:00:00.000Z",
    timezone: NY,
    startedAt: null,
    finishedAt: null,
    durationS: 12,
    costUsd: 0.01,
    budgetUsd: 10,
    inputTokens: 0,
    outputTokens: 0,
    partialReason: null,
    error: null,
    findings: 0,
    buildingStatus: "good",
    startedBy: null,
    pdf: { status: "none", error: null, bytes: null, queuedAt: null, renderedAt: null },
    delivery: { total: 0, sent: 0, failed: 0, pending: 0, notSent: 0, emptyReason: "none" },
    ...over,
  });

  it("the runs list draws a box and a Delete per finished row, none for a queued or running one, and the header box ticks the finished rows shown", () => {
    const html = renderToStaticMarkup(
      createElement(RunsTable, {
        data: { runs: [summary({ runId: "1" }), summary({ runId: "2", status: "running" }), summary({ runId: "3", status: "failed", error: "boom" })], runsInDatabase: 3 },
        selection: { selected: new Set(["1"]), onToggle: () => undefined, onToggleAll: () => undefined },
        onDelete: () => undefined,
      }),
    );
    expect(html.match(/data-testid="run-select"/g)).toHaveLength(3);
    expect(html.match(/data-testid="run-delete"/g)).toHaveLength(3);
    expect(html.match(/data-testid="run-select-all"/g)).toHaveLength(1);
    // The running row's box and Delete are disabled with the reason.
    expect(html.match(/A queued or running run can be deleted once it has finished\./g)).toHaveLength(2);
    // Without the handlers, the list is as it was: no box, no Delete.
    const bare = renderToStaticMarkup(createElement(RunsTable, { data: { runs: [summary({ runId: "1" })], runsInDatabase: 1 } }));
    expect(bare).not.toContain("run-select");
    expect(bare).not.toContain("run-delete");
  });

  it("the toolbar shows Recently deleted always and Delete with the count once something is ticked; the dialog names the count", () => {
    const none = renderToStaticMarkup(createElement(RunsToolbar, { selectedCount: 0 }));
    expect(none).toContain("Recently deleted");
    expect(none).toContain('href="/bas/reports/deleted"');
    expect(none).not.toContain("runs-delete-selected");
    const three = renderToStaticMarkup(createElement(RunsToolbar, { selectedCount: 3 }));
    expect(three).toContain("3 selected");
    expect(three).toContain("Delete 3 runs");
    const dialog = renderToStaticMarkup(createElement(DeleteRunsDialog, { count: 3 }));
    expect(dialog).toContain('role="dialog"');
    expect(dialog).toContain("Delete 3 runs?");
    expect(dialog).toContain(DELETE_CONFIRM_SENTENCE);
    expect(dialog).toMatch(/data-testid="runs-delete-confirm"[^>]*>Delete 3 runs</);
    expect(renderToStaticMarkup(createElement(DeleteRunsDialog, { count: 1 }))).toContain("Delete 1 run?");
  });

  it("Recently deleted shows when, by whom and the days left, and says so when it is empty", () => {
    const list: DeletedRunsList = {
      runs: [
        {
          runId: "7", reportId: "1", reportName: "ZZTEST weekly", reportDeleted: false, buildingName: "Office", status: "succeeded", trigger: "scheduled",
          periodStart: "2026-11-05T11:00:00.000Z", periodEnd: "2026-11-12T11:00:00.000Z", timezone: NY, finishedAt: null,
          deletedAt: "2026-11-20T15:00:00.000Z", deletedBy: "person", deletedByEmail: "jim@phb1899.com", retentionMonths: null,
          purgeAt: "2026-12-05T15:00:00.000Z", daysRemaining: 12,
        },
        {
          runId: "3", reportId: "1", reportName: "ZZTEST weekly", reportDeleted: false, buildingName: "Office", status: "partial", trigger: "scheduled",
          periodStart: "2026-05-05T11:00:00.000Z", periodEnd: "2026-05-12T11:00:00.000Z", timezone: NY, finishedAt: null,
          deletedAt: "2026-11-06T15:00:00.000Z", deletedBy: "retention", deletedByEmail: null, retentionMonths: 6,
          purgeAt: "2026-11-21T15:00:00.000Z", daysRemaining: 1,
        },
      ],
      runsInDatabase: 2,
    };
    const html = renderToStaticMarkup(createElement(DeletedRunsTable, { data: list, onToggle: () => undefined, onToggleAll: () => undefined, onRestore: () => undefined }));
    expect(html).toContain("by jim@phb1899.com");
    expect(html).toContain("by Retention (6 months)");
    expect(html).toContain("12 days left");
    expect(html).toContain("1 day left");
    expect(html.match(/data-testid="deleted-restore"/g)).toHaveLength(2);
    // A deleted run has no page: the name is not a link.
    expect(html).not.toContain("/bas/reports/generated/");
    const empty = renderToStaticMarkup(createElement(DeletedRunsTable, { data: { runs: [], runsInDatabase: 0 } }));
    expect(empty).toContain("Nothing in Recently deleted");
  });
});

// ---------------------------------------------------------------------------
// The database, the service and the routes
// ---------------------------------------------------------------------------

let owner: Awaited<ReturnType<typeof createEmployee>>;
let other: Awaited<ReturnType<typeof createEmployee>>;
let admin: Awaited<ReturnType<typeof createEmployee>>;
let siteId: bigint;
let reportId: string;
const REPORT_NAME = "ZZTEST deletion weekly";

async function seedBuilding() {
  const org = await testDb.basOrg.create({ data: { name: "ZZTEST_DEL_ORG" } });
  const project = await testDb.basProject.create({ data: { orgId: org.orgId, name: "ZZTEST_DEL_PROJECT" } });
  const site = await testDb.basSite.create({ data: { orgId: org.orgId, projectId: project.projectId, name: "ZZTEST_DEL_SITE", timezone: NY } });
  await testDb.basStation.create({ data: { siteId: site.siteId, niagaraStationName: "ZZTestDelStation", connectionMode: "direct", baseUrl: "https://198.51.100.33" } });
  siteId = site.siteId;
}

async function dropBuilding() {
  await testDb.basStation.deleteMany({ where: { niagaraStationName: "ZZTestDelStation" } });
  await testDb.basSite.deleteMany({ where: { name: "ZZTEST_DEL_SITE" } });
  await testDb.basProject.deleteMany({ where: { name: "ZZTEST_DEL_PROJECT" } });
  await testDb.basOrg.deleteMany({ where: { name: "ZZTEST_DEL_ORG" } });
}

async function activeReport(name = REPORT_NAME, by = owner): Promise<string> {
  const library = await testDb.basLibraryQuestion.findMany({ select: { libraryQuestionId: true }, orderBy: { position: "asc" }, take: 2 });
  const created = await createReport(viewerOf(by), {
    name,
    siteId: siteId.toString(),
    analysisWindow: "7d",
    schedule: { kind: "weekly", weekdays: [1] },
    timeOfDay: "06:00",
    questions: library.map((q) => ({ kind: "library" as const, libraryQuestionId: q.libraryQuestionId.toString() })),
  });
  await changeReportState(viewerOf(by), created.reportId, "activate");
  return created.reportId;
}

/** A finished run, as the engine leaves it: page stored, PDF queued. */
async function finishedRun(forReport = reportId): Promise<bigint> {
  const outcome = await executeReportRun(forReport, { periodEnd: new Date(), trigger: "manual", startedById: owner.id, narrator: createFixedNarrator() });
  return BigInt(outcome.runId);
}

const run = (runId: bigint) => testDb.basReportRun.findUniqueOrThrow({ where: { runId }, select: { deletedAt: true, deletedBy: true, deletedByEmployeeId: true, restoredAt: true, pdfStatus: true, pdfError: true, previousRunId: true } });

/** One open Data Health finding on a run, as a previous run would hold it. */
async function plantFinding(runId: bigint, subject: string, firstSeen: { runId: bigint | null; at: Date | null }) {
  await testDb.basReportFinding.create({
    data: {
      runId,
      position: 0,
      questionKey: "q20",
      section: "data_health",
      subjectKey: subject,
      subjectName: `ZZTEST point ${subject}`,
      issueCode: "flat",
      priority: "action_needed",
      evidence: { issue: "Flat" },
      fingerprint: fingerprintOf("q20", subject, "flat"),
      state: "new",
      firstSeenRunId: firstSeen.runId,
      firstSeenAt: firstSeen.at,
    },
  });
}

describe("deleting runs, Recently deleted, the purge and retention", () => {
  beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    resetBasAvailabilityCache();
    await resetDb();
    await dropBuilding();
    await seedChangeOrdersModule();
    await seedBasModule();
    await seedBasReportLibrary(testDb);
    owner = await createEmployee({ email: "zztest.del.owner@phb1899.com" });
    other = await createEmployee({ email: "zztest.del.other@phb1899.com" });
    admin = await createEmployee({ email: "zztest.del.admin@phb1899.com" });
    for (const e of [owner, other, admin]) await grantModule(e.id, BAS_MODULE_KEY);
    await grantModuleAdmin(admin.id, BAS_MODULE_KEY);
    await seedBuilding();
    reportId = await activeReport();
  });

  afterAll(async () => {
    await resetDb();
    await dropBuilding();
    await disconnectDb();
  });

  it("the owner deletes a run: it leaves the list at once, keeps its findings, page and PDF columns, and is not audited", async () => {
    const runId = await finishedRun();
    await plantFinding(runId, "point:1", { runId, at: new Date() });
    const auditsBefore = await testDb.auditEvent.count();

    signedInAs(owner.entraOid!);
    const response = await deleteRoute(post({ runIds: [runId.toString()] }));
    expect(response.status).toBe(200);
    expect(await dataOf(response)).toEqual({ deleted: 1 });

    const row = await run(runId);
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedBy).toBe("person");
    expect(row.deletedByEmployeeId).toBe(owner.id);
    // Still in the database, whole.
    expect(await testDb.basReportFinding.count({ where: { runId } })).toBe(1);
    const stored = await testDb.basReportRun.findUniqueOrThrow({ where: { runId }, select: { reportHtml: true, reportJson: true } });
    expect(stored.reportHtml).not.toBeNull();
    expect(stored.reportJson).not.toBeNull();
    // Gone from the list and the count beside it.
    const listed = await dataOf<{ runs: RunSummary[]; runsInDatabase: number }>(await listRoute(get()));
    expect(listed.runs).toEqual([]);
    expect(listed.runsInDatabase).toBe(0);
    // No audit row for the delete.
    expect(await testDb.auditEvent.count()).toBe(auditsBefore);
  });

  it("a module admin deletes another person's run; a BAS user who is neither is told it does not exist and nothing changes", async () => {
    const mine = await finishedRun();
    signedInAs(other.entraOid!);
    const refused = await deleteRoute(post({ runIds: [mine.toString()] }));
    expect(refused.status).toBe(404);
    expect((await errorBody(refused)).code).toBe("run_not_found");
    expect((await run(mine)).deletedAt).toBeNull();
    // Nor can they see it in Recently deleted, or restore it, once it is there.
    signedInAs(admin.entraOid!);
    expect((await deleteRoute(post({ runIds: [mine.toString()] }))).status).toBe(200);
    const row = await run(mine);
    expect(row.deletedByEmployeeId).toBe(admin.id);
    signedInAs(other.entraOid!);
    expect((await dataOf<DeletedRunsList>(await deletedRoute())).runs).toEqual([]);
    expect((await restoreRoute(post({ runIds: [mine.toString()] }))).status).toBe(404);
    expect((await run(mine)).deletedAt).not.toBeNull();
    // Signed out: 401 before anything is looked up.
    authMock.mockResolvedValue(null as never);
    expect((await deleteRoute(post({ runIds: [mine.toString()] }))).status).toBe(401);
  });

  it("a selection is all or nothing: one run not the viewer's, or one still running, refuses the whole of it", async () => {
    const a = await finishedRun();
    const b = await finishedRun();
    const theirs = await finishedRun(await activeReport("ZZTEST deletion admin's", admin));

    signedInAs(owner.entraOid!);
    const mixed = await deleteRoute(post({ runIds: [a.toString(), theirs.toString()] }));
    expect(mixed.status).toBe(404);
    expect((await run(a)).deletedAt).toBeNull();

    await testDb.basReportRun.update({ where: { runId: b }, data: { status: "running", finishedAt: null } });
    const unfinished = await deleteRoute(post({ runIds: [a.toString(), b.toString()] }));
    expect(unfinished.status).toBe(409);
    const body = await errorBody(unfinished);
    expect(body.code).toBe("run_not_finished");
    expect(body.message).toMatch(/1 of these runs is still queued or running/);
    expect((await run(a)).deletedAt).toBeNull();
    // The database refuses a running run as deleted too.
    await expect(testDb.$executeRaw`UPDATE bas_report_runs SET deleted_at = now(), deleted_by = 'person' WHERE run_id = ${b}`).rejects.toThrow(/bas_report_runs_deleted_only_finished/);

    // Shape: no ids, or not digits, is 422.
    expect((await deleteRoute(post({ runIds: [] }))).status).toBe(422);
    expect((await deleteRoute(post({ runIds: ["x"] }))).status).toBe(422);
    // Twice is 404 the second time: it is already deleted.
    expect((await deleteRoute(post({ runIds: [a.toString()] }))).status).toBe(200);
    expect((await deleteRoute(post({ runIds: [a.toString()] }))).status).toBe(404);
  });

  it("a deleted run answers 404 to opening it, its PDF, Retry PDF, Resend and Send to me, until it is restored", async () => {
    const runId = await finishedRun();
    // A ready PDF and a failed delivery, so every action would otherwise work.
    await testDb.basReportRun.update({
      where: { runId },
      data: { pdfStatus: "ready", pdf: new TextEncoder().encode("%PDF-1.4\n%%EOF\n"), pdfBytes: 15, pdfRenderedAt: new Date(), pdfQueuedAt: null },
    });
    await testDb.basReportDelivery.create({ data: { runId, email: owner.email, source: "owner", position: 0, status: "failed", lastError: "boom", attempts: 3 } });

    signedInAs(owner.entraOid!);
    expect((await pdfRoute(get(), runParam(runId))).status).toBe(200);
    expect((await deleteRoute(post({ runIds: [runId.toString()] }))).status).toBe(200);

    for (const [name, call] of [
      ["open", () => runRoute(get(), runParam(runId))],
      ["download", () => pdfRoute(get(), runParam(runId))],
      ["retry PDF", () => retryRoute(post(), runParam(runId))],
      ["resend", () => resendRoute(post(), runParam(runId))],
      ["send to me", () => sendToMeRoute(post(), runParam(runId))],
    ] as const) {
      const response = await call();
      expect(response.status, name).toBe(404);
      expect((await errorBody(response)).code, name).toBe("run_not_found");
    }
    await expect(getRun(viewerOf(admin), runId.toString())).rejects.toMatchObject({ code: "run_not_found" });
    // Nothing was queued by the refused actions.
    expect((await testDb.basReportDelivery.findFirstOrThrow({ where: { runId } })).status).toBe("failed");

    // Restored: everything answers again, and the run is on the list.
    const restored = await restoreRoute(post({ runIds: [runId.toString()] }));
    expect(restored.status).toBe(200);
    expect(await dataOf(restored)).toEqual({ restored: 1 });
    expect((await pdfRoute(get(), runParam(runId))).status).toBe(200);
    expect((await runRoute(get(), runParam(runId))).status).toBe(200);
    expect((await listRuns(viewerOf(owner), null)).runs.map((r) => r.runId)).toEqual([runId.toString()]);
    const row = await run(runId);
    expect(row).toMatchObject({ deletedAt: null, deletedBy: null, deletedByEmployeeId: null });
    expect(row.restoredAt).not.toBeNull();
  });

  it("Recently deleted lists the viewer's deleted runs, newest deletion first, with the days left; an admin sees every report's", async () => {
    const a = await finishedRun();
    const b = await finishedRun();
    const theirs = await finishedRun(await activeReport("ZZTEST deletion admin's", admin));
    const now = new Date();
    await testDb.basReportRun.update({ where: { runId: a }, data: { deletedAt: new Date(now.getTime() - 3 * DAY - 60_000), deletedBy: "person", deletedByEmployeeId: owner.id } });
    await testDb.basReportRun.update({ where: { runId: b }, data: { deletedAt: new Date(now.getTime() - 14 * DAY - 3_600_000), deletedBy: "retention" } });
    await testDb.basReportRun.update({ where: { runId: theirs }, data: { deletedAt: now, deletedBy: "person", deletedByEmployeeId: admin.id } });

    const mine = await listDeletedRuns(viewerOf(owner), now);
    expect(mine.runsInDatabase).toBe(2);
    expect(mine.runs.map((r) => [r.runId, r.deletedBy, r.deletedByEmail, r.daysRemaining])).toEqual([
      [a.toString(), "person", owner.email, 12],
      [b.toString(), "retention", null, 1],
    ]);
    expect(mine.runs[0]!.purgeAt).toBe(new Date(now.getTime() - 3 * DAY - 60_000 + 15 * DAY).toISOString());
    expect(JSON.stringify(mine)).not.toContain('"type":"Buffer"');

    const everyone = await listDeletedRuns(viewerOf(admin), now);
    expect(everyone.runs.map((r) => r.runId)).toEqual([theirs.toString(), a.toString(), b.toString()]);
    expect(everyone.runs[0]!.daysRemaining).toBe(15);

    // The list beside it holds none of them.
    expect((await listRuns(viewerOf(admin), null)).runs).toEqual([]);

    // Restore on a selection brings both back; a second restore is 404.
    signedInAs(owner.entraOid!);
    expect((await restoreRoute(post({ runIds: [a.toString(), b.toString()] }))).status).toBe(200);
    expect((await listDeletedRuns(viewerOf(owner), now)).runs).toEqual([]);
    expect((await restoreRoute(post({ runIds: [a.toString()] }))).status).toBe(404);
  });

  it("the purge removes a run 15 days after it was deleted, with its findings, deliveries and PDF - and not a minute before", async () => {
    const due = await finishedRun();
    const early = await finishedRun();
    const kept = await finishedRun();
    for (const id of [due, early]) {
      await plantFinding(id, "point:1", { runId: id, at: new Date() });
      await testDb.basReportDelivery.create({ data: { runId: id, email: owner.email, source: "owner", position: 0, status: "sent", sentAt: new Date() } });
    }
    const now = new Date();
    await testDb.basReportRun.update({ where: { runId: due }, data: { deletedAt: new Date(now.getTime() - 15 * DAY - 60_000), deletedBy: "person", deletedByEmployeeId: owner.id } });
    await testDb.basReportRun.update({ where: { runId: early }, data: { deletedAt: new Date(now.getTime() - 15 * DAY + 60_000), deletedBy: "person", deletedByEmployeeId: owner.id } });

    const purged = await purgeDeletedRuns(now);
    expect(purged.map((p) => p.runId)).toEqual([due.toString()]);
    expect(await testDb.basReportRun.count({ where: { runId: due } })).toBe(0);
    expect(await testDb.basReportFinding.count({ where: { runId: due } })).toBe(0);
    expect(await testDb.basReportDelivery.count({ where: { runId: due } })).toBe(0);
    // A minute short of 15 days: still there, whole.
    expect(await testDb.basReportRun.count({ where: { runId: early } })).toBe(1);
    expect(await testDb.basReportFinding.count({ where: { runId: early } })).toBe(1);
    expect(await testDb.basReportDelivery.count({ where: { runId: early } })).toBe(1);
    // A run never deleted is never purged.
    expect(await testDb.basReportRun.count({ where: { runId: kept } })).toBe(1);
    // Two minutes later the second one goes.
    expect((await purgeDeletedRuns(new Date(now.getTime() + 120_000))).map((p) => p.runId)).toEqual([early.toString()]);
    // Logged, not audited per run.
    expect(await testDb.auditEvent.count({ where: { action: { contains: "purge" } } })).toBe(0);
  });

  it("retention deletes only runs older than the report keeps, to Recently deleted as 'retention'; never under never; never a run a person restored", async () => {
    const now = new Date();
    const old = await finishedRun();
    const recent = await finishedRun();
    const restoredOld = await finishedRun();
    await testDb.basReportRun.update({ where: { runId: old }, data: { createdAt: new Date(monthsBefore(now, 3).getTime() - 60_000) } });
    await testDb.basReportRun.update({ where: { runId: recent }, data: { createdAt: new Date(monthsBefore(now, 3).getTime() + 60_000) } });
    await testDb.basReportRun.update({ where: { runId: restoredOld }, data: { createdAt: new Date(monthsBefore(now, 3).getTime() - DAY), restoredAt: new Date(now.getTime() - DAY) } });

    // Never (the default): nothing moves, however old.
    expect((await getReport(viewerOf(owner), reportId)).runRetentionMonths).toBeNull();
    expect(await applyRunRetention(now)).toEqual([]);
    expect((await run(old)).deletedAt).toBeNull();

    // Three months, through the editor's route.
    signedInAs(owner.entraOid!);
    expect((await patchReportRoute(patch({ runRetentionMonths: 3 }), reportParam(reportId))).status).toBe(200);
    const audit = await testDb.auditEvent.findFirstOrThrow({ where: { action: "bas.report_updated" }, orderBy: { occurredAt: "desc" } });
    expect((audit.metadata as { changes: Record<string, unknown> }).changes.runRetentionMonths).toEqual({ from: null, to: 3 });
    expect((await patchReportRoute(patch({ runRetentionMonths: 4 }), reportParam(reportId))).status).toBe(422);

    const pass = await runRetentionPass(now);
    expect(pass.retained.map((r) => [r.runId, r.months])).toEqual([[old.toString(), 3]]);
    expect(pass.purged).toEqual([]);
    expect(await run(old)).toMatchObject({ deletedBy: "retention", deletedByEmployeeId: null });
    expect((await run(old)).deletedAt?.toISOString()).toBe(now.toISOString());
    expect((await run(recent)).deletedAt).toBeNull();
    expect((await run(restoredOld)).deletedAt).toBeNull();
    // It went to Recently deleted, where the 15-day undo applies.
    const deleted = await listDeletedRuns(viewerOf(owner), now);
    expect(deleted.runs.map((r) => [r.runId, r.deletedBy, r.retentionMonths, r.daysRemaining])).toEqual([[old.toString(), "retention", 3, 15]]);
    // A second pass moves nothing more; fifteen days on, the purge takes it.
    expect(await applyRunRetention(new Date(now.getTime() + 60_000))).toEqual([]);
    const later = await runRetentionPass(new Date(now.getTime() + 15 * DAY));
    expect(later.purged.map((p) => [p.runId, p.deletedBy])).toEqual([[old.toString(), "retention"]]);
    // Fifteen days on, the recent run is past three months too, and goes the same way.
    expect(later.retained.map((r) => r.runId)).toEqual([recent.toString()]);

    // A run retention took and a person restored is kept from then on,
    // however old: a year on, with three months still set, retention passes it by.
    await restoreRuns(viewerOf(owner), [recent.toString()]);
    expect(await applyRunRetention(new Date(now.getTime() + 365 * DAY))).toEqual([]);
    expect((await run(recent)).deletedAt).toBeNull();

    // Back to never: a run nobody restored, old enough, stays too.
    const another = await finishedRun();
    await testDb.basReportRun.update({ where: { runId: another }, data: { createdAt: new Date(now.getTime() - 400 * DAY) } });
    expect((await patchReportRoute(patch({ runRetentionMonths: null }), reportParam(reportId))).status).toBe(200);
    expect(await applyRunRetention(now)).toEqual([]);
    expect((await run(another)).deletedAt).toBeNull();
  });

  it("the comparison uses the newest run that is not deleted: a deleted run is never the previous run", async () => {
    const first = await finishedRun();
    const second = await finishedRun();
    await plantFinding(first, "point:1", { runId: first, at: new Date("2026-10-14T10:00:00.000Z") });
    await plantFinding(second, "point:2", { runId: second, at: new Date("2026-10-21T10:00:00.000Z") });
    await deleteRuns(viewerOf(owner), [second.toString()]);

    const third = await finishedRun();
    expect((await run(third)).previousRunId).toBe(first);
    // The empty building finds nothing, so the previous run's open item is
    // carried as cleared - the first run's, never the deleted one's.
    const cleared = await testDb.basReportFinding.findMany({ where: { runId: third, state: "cleared" }, select: { subjectKey: true } });
    expect(cleared.map((f) => f.subjectKey)).toEqual(["point:1"]);
  });

  it("an item's first-seen date survives the purge of the run that first saw it", async () => {
    const first = await finishedRun();
    const second = await finishedRun();
    const since = new Date("2026-10-14T10:00:00.000Z");
    await plantFinding(second, "point:9", { runId: first, at: since });
    // The first run is deleted and purged; the second's finding loses its link.
    await testDb.basReportRun.update({ where: { runId: first }, data: { deletedAt: new Date(Date.now() - 16 * DAY), deletedBy: "person" } });
    await purgeDeletedRuns();
    const orphan = await testDb.basReportFinding.findFirstOrThrow({ where: { runId: second } });
    expect(orphan.firstSeenRunId).toBeNull();
    expect(orphan.firstSeenAt?.toISOString()).toBe(since.toISOString());

    const third = await finishedRun();
    const carried = await testDb.basReportFinding.findFirstOrThrow({ where: { runId: third, subjectKey: "point:9" } });
    expect(carried.firstSeenAt?.toISOString()).toBe(since.toISOString());
    const doc = (await getRun(viewerOf(owner), third.toString())).document!;
    expect(JSON.stringify(doc)).toContain(since.toISOString());
  });

  it("no email goes out for a deleted run: its queued PDF and waiting deliveries are settled, no rows are written later, and the sender refuses at the last moment", async () => {
    // Queued PDF and a pending delivery at the moment of the delete.
    const runId = await finishedRun();
    await testDb.basReportDelivery.create({ data: { runId, email: owner.email, source: "owner", position: 0, status: "pending" } });
    expect((await run(runId)).pdfStatus).toBe("queued");
    await deleteRuns(viewerOf(owner), [runId.toString()]);
    expect(await run(runId)).toMatchObject({ pdfStatus: "failed", pdfError: PDF_DELETED_SENTENCE });
    expect(await testDb.basReportDelivery.findFirstOrThrow({ where: { runId } })).toMatchObject({ status: "failed", lastError: DELIVERY_DELETED_SENTENCE });
    // The worker's scaler would count nothing for it.
    const counted = await testDb.$queryRaw<Array<{ n: bigint }>>`
      SELECT (SELECT count(*) FROM bas_report_runs WHERE run_id = ${runId} AND (status = 'queued' OR pdf_status = 'queued'))
           + (SELECT count(*) FROM bas_report_deliveries WHERE run_id = ${runId} AND status = 'pending') AS n`;
    expect(Number(counted[0]!.n)).toBe(0);

    // A render that was already in progress stores its PDF, and writes no deliveries.
    expect(await enqueueRunDeliveries(testDb, runId)).toBe(0);

    // A delivery an attempt was holding, on a run deleted under it: the sender refuses before Graph.
    const raced = await finishedRun();
    await testDb.basReportRun.update({ where: { runId: raced }, data: { pdfStatus: "ready", pdf: new TextEncoder().encode("%PDF-1.4\n%%EOF\n"), pdfBytes: 15, pdfRenderedAt: new Date(), pdfQueuedAt: null } });
    await enqueueRunDeliveries(testDb, raced);
    await testDb.basReportRun.update({ where: { runId: raced }, data: { deletedAt: new Date(), deletedBy: "person", deletedByEmployeeId: owner.id } });
    const sent: ReportMail[] = [];
    const mailer: ReportMailer = { mailbox: "controlls@phb1899.com", allowSend: true, send: async (mail) => { sent.push(mail); return { requestId: "r" }; } };
    const outcomes = await drainDeliveries({ mailer, platformUrl: null });
    expect(sent).toEqual([]);
    expect(outcomes.map((o) => [o.runId, o.status])).toEqual([[raced, "failed"]]);
    expect(await testDb.basReportDelivery.findFirstOrThrow({ where: { runId: raced } })).toMatchObject({ status: "failed", lastError: DELIVERY_DELETED_SENTENCE });
  });

  it("the Scheduled list's last run is never a deleted one, and shows the retention in the summary line when it is not never", async () => {
    const first = await finishedRun();
    const second = await finishedRun();
    await deleteRuns(viewerOf(owner), [second.toString()]);
    const list = await listReports(viewerOf(owner));
    expect(list.reports[0]!.lastRun?.runId).toBe(first.toString());

    await testDb.basReportDefinition.update({ where: { reportId: BigInt(reportId) }, data: { runRetentionMonths: 6 } });
    const withRetention = await listReports(viewerOf(owner));
    expect(withRetention.reports[0]!.runRetentionMonths).toBe(6);
    const html = renderToStaticMarkup(createElement(ReportsTable, { data: withRetention }));
    expect(html).toContain("Keeps runs 6 months");
    await testDb.basReportDefinition.update({ where: { reportId: BigInt(reportId) }, data: { runRetentionMonths: null } });
    const never = renderToStaticMarkup(createElement(ReportsTable, { data: await listReports(viewerOf(owner)) }));
    expect(never).not.toContain("Keeps runs");
    // The database refuses any other number of months.
    await expect(testDb.$executeRaw`UPDATE bas_report_definitions SET run_retention_months = 4 WHERE report_id = ${BigInt(reportId)}`).rejects.toThrow(/run_retention_months_valid/);
  });

  it("deleting a report with runs stops future runs and takes it off every Scheduled list, for everyone; its runs stay, open, download and email, labelled schedule deleted", async () => {
    const first = await finishedRun();
    const second = await finishedRun();
    await testDb.basReportRun.update({
      where: { runId: first },
      data: { pdfStatus: "ready", pdf: new TextEncoder().encode("%PDF-1.4\n%%EOF\n"), pdfBytes: 15, pdfRenderedAt: new Date(), pdfQueuedAt: null },
    });
    // One run already in Recently deleted: it stays there, still restorable.
    await deleteRuns(viewerOf(owner), [second.toString()]);
    // A personal question on the report, and a recipient.
    const personal = await testDb.basPersonalQuestion.create({ data: { employeeId: owner.id, text: "ZZTEST my question" }, select: { personalQuestionId: true } });
    await testDb.basReportQuestion.create({ data: { reportId: BigInt(reportId), position: 99, kind: "personal", personalQuestionId: personal.personalQuestionId } });
    await testDb.basReportRecipient.create({ data: { reportId: BigInt(reportId), email: "zztest.colleague@phb1899.com", isExternal: false } });
    // Due to run, so the scheduler would queue it if it could.
    await testDb.basReportDefinition.update({ where: { reportId: BigInt(reportId) }, data: { nextRunAt: new Date(Date.now() - 60_000) } });

    // The confirmation's count is every run, on the list or in Recently deleted.
    expect((await getReport(viewerOf(owner), reportId)).runCount).toBe(2);

    signedInAs(owner.entraOid!);
    const response = await deleteReportRoute(new Request("http://localhost", { method: "DELETE" }), reportParam(reportId));
    expect(response.status).toBe(200);
    expect(await dataOf(response)).toEqual({ deleted: true, runsKept: 2 });

    // Off every Scheduled list - the owner's and an admin's, rows and count - and no editor.
    for (const who of [owner, admin]) {
      const list = await listReports(viewerOf(who));
      expect(list.reports.map((r) => r.reportId)).not.toContain(reportId);
      expect(list.reportsInDatabase).toBe(0);
    }
    signedInAs(admin.entraOid!);
    expect((await getReportRoute(get(), reportParam(reportId))).status).toBe(404);
    expect((await patchReportRoute(patch({ name: "ZZTEST revived" }), reportParam(reportId))).status).toBe(404);
    expect((await runNowRoute(post(), reportParam(reportId))).status).toBe(404);
    expect((await deleteReportRoute(new Request("http://localhost", { method: "DELETE" }), reportParam(reportId))).status).toBe(404);

    // The scheduler never queues it again, and nothing else can.
    const pass = await runSchedulerPass();
    expect(pass.enqueued).toEqual([]);
    expect(await testDb.basReportRun.count({ where: { reportId: BigInt(reportId), status: { in: ["queued", "running"] } } })).toBe(0);
    await expect(enqueueRun(testDb, { reportId: BigInt(reportId), trigger: "manual", periodEnd: new Date(), startedById: owner.id })).rejects.toMatchObject({ code: "report_not_found" });

    // The runs are untouched: on the list labelled, opening, downloading, emailing.
    signedInAs(owner.entraOid!);
    const listed = await dataOf<{ runs: RunSummary[] }>(await listRoute(get()));
    expect(listed.runs.map((r) => [r.runId, r.reportName, r.reportDeleted])).toEqual([[first.toString(), REPORT_NAME, true]]);
    expect(renderToStaticMarkup(createElement(RunsTable, { data: { runs: listed.runs, runsInDatabase: 1 } }))).toContain(SCHEDULE_DELETED_LABEL);
    expect((await runRoute(get(), runParam(first))).status).toBe(200);
    expect((await pdfRoute(get(), runParam(first))).status).toBe(200);
    expect((await sendToMeRoute(post(), runParam(first))).status).toBe(202);
    expect((await run(first)).deletedAt).toBeNull();
    // The one in Recently deleted is still there, labelled, and restores.
    const deleted = await listDeletedRuns(viewerOf(owner));
    expect(deleted.runs.map((r) => [r.runId, r.reportDeleted])).toEqual([[second.toString(), true]]);
    expect((await restoreRoute(post({ runIds: [second.toString()] }))).status).toBe(200);

    // Its questions went (so the personal question can go); its recipients stayed.
    expect(await testDb.basReportQuestion.count({ where: { reportId: BigInt(reportId) } })).toBe(0);
    expect(await testDb.basReportRecipient.count({ where: { reportId: BigInt(reportId) } })).toBe(1);
    expect(await deletePersonalQuestion(viewerOf(owner), personal.personalQuestionId.toString())).toEqual({ deleted: true });

    // Retention no longer touches its runs: they go only by their own Delete.
    await testDb.basReportDefinition.update({ where: { reportId: BigInt(reportId) }, data: { runRetentionMonths: 3 } });
    await testDb.basReportRun.updateMany({ where: { reportId: BigInt(reportId) }, data: { createdAt: new Date(Date.now() - 400 * DAY) } });
    expect(await applyRunRetention()).toEqual([]);

    // Audited, with the runs kept, in words.
    const audit = await testDb.auditEvent.findFirstOrThrow({ where: { action: "bas.report_deleted" } });
    expect(audit.metadata).toMatchObject({ reportId, name: REPORT_NAME, runsKept: 2 });
    expect(audit.actorEmployeeId).toBe(owner.id);

    // Its name is free: the owner can make a new report called the same.
    const again = await activeReport(REPORT_NAME);
    expect(again).not.toBe(reportId);
    // Two LIVE reports of one owner with one name are still refused, by the service and by the database.
    await expect(activeReport(REPORT_NAME)).rejects.toMatchObject({ code: "name_taken" });
    await expect(
      testDb.basReportDefinition.create({
        data: { ownerEmployeeId: owner.id, name: REPORT_NAME, siteId, scheduleKind: "daily", timeOfDay: "06:00" },
      }),
    ).rejects.toThrow();
  });

  it("deleting a report is refused while one of its runs is queued or running, and allowed once it finishes", async () => {
    const runId = await finishedRun();
    for (const status of ["queued", "running"] as const) {
      await testDb.basReportRun.update({ where: { runId }, data: { status } });
      signedInAs(admin.entraOid!);
      const refused = await deleteReportRoute(new Request("http://localhost", { method: "DELETE" }), reportParam(reportId));
      expect(refused.status, status).toBe(409);
      const body = await errorBody(refused);
      expect(body.code).toBe("run_in_flight");
      expect(body.message).toContain(`A run of this report is ${status}`);
      expect((await testDb.basReportDefinition.findUniqueOrThrow({ where: { reportId: BigInt(reportId) } })).deletedAt).toBeNull();
    }
    // The button says so before the server does.
    const list = await listReports(viewerOf(admin));
    const html = renderToStaticMarkup(createElement(ReportsTable, { data: list, onDelete: () => undefined }));
    expect(html).toMatch(/data-testid="report-delete"[^>]*disabled|disabled[^>]*data-testid="report-delete"/);
    expect(html).toContain(REPORT_DELETE_IN_FLIGHT_TITLE);

    await testDb.basReportRun.update({ where: { runId }, data: { status: "succeeded" } });
    // A BAS user who is neither owner nor admin is told the report does not exist.
    signedInAs(other.entraOid!);
    expect((await deleteReportRoute(new Request("http://localhost", { method: "DELETE" }), reportParam(reportId))).status).toBe(404);
    // The admin may.
    signedInAs(admin.entraOid!);
    expect(await dataOf(await deleteReportRoute(new Request("http://localhost", { method: "DELETE" }), reportParam(reportId)))).toEqual({ deleted: true, runsKept: 1 });
    expect((await testDb.basReportDefinition.findUniqueOrThrow({ where: { reportId: BigInt(reportId) } })).deletedByEmployeeId).toBe(admin.id);
  });

  it("a report that never made a run is removed outright, as before", async () => {
    expect(await deleteReport(viewerOf(owner), reportId)).toEqual({ deleted: true, runsKept: 0 });
    expect(await testDb.basReportDefinition.count({ where: { reportId: BigInt(reportId) } })).toBe(0);
  });

  it("the confirmation says future runs stop and how many generated reports stay", () => {
    expect(reportDeleteSentence(4)).toBe("This stops future runs. The 4 generated reports stay.");
    expect(reportDeleteSentence(1)).toBe("This stops future runs. The 1 generated report stays.");
    expect(reportDeleteSentence(0)).toBe("This stops future runs. It has no generated reports.");
    const html = renderToStaticMarkup(
      createElement(ConfirmDialog, {
        heading: reportDeleteHeading("Office weekly"),
        sentence: reportDeleteSentence(4),
        confirmLabel: "Delete report",
        busyLabel: "Deleting…",
        testIdPrefix: "report-delete",
      }),
    );
    expect(html).toContain("Delete the report &quot;Office weekly&quot;?");
    expect(html).toContain("This stops future runs. The 4 generated reports stay.");
  });
});

describe("no migration drops the live-name index Prisma cannot see", () => {
  it("keeps bas_report_definitions_owner_name_live_key", async () => {
    const dir = path.resolve(process.cwd(), "prisma/migrations");
    const entries = await readdir(dir, { withFileTypes: true });
    const offenders: string[] = [];
    for (const entry of entries.filter((e) => e.isDirectory())) {
      const raw = await readFile(path.join(dir, entry.name, "migration.sql"), "utf8");
      // Comments can name the statement they warn about; only SQL counts.
      const sql = raw.replace(/--.*$/gm, "");
      if (/DROP\s+INDEX[^;]*bas_report_definitions_owner_name_live_key/i.test(sql)) offenders.push(entry.name);
    }
    expect(offenders).toEqual([]);
    const rows = await testDb.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'bas_report_definitions' AND indexname = 'bas_report_definitions_owner_name_live_key'`;
    expect(rows[0]?.indexdef).toMatch(/UNIQUE INDEX .* \(owner_employee_id, name\) WHERE \(deleted_at IS NULL\)/);
  });
});
