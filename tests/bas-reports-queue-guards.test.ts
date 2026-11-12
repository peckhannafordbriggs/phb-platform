import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { createFixedNarrator } from "@/lib/modules/bas/reports/engine/narrative";
import { enqueueRun, executeReportRun } from "@/lib/modules/bas/reports/engine/run";
import {
  MAX_ATTEMPTS,
  STALE_AFTER_MS,
  STALLED_TWICE_ERROR,
  UNCLAIMED_AFTER_MS,
  failAbandonedWork,
  unclaimedPdfError,
  unclaimedRunError,
} from "@/lib/modules/bas/reports/queue-guards";
import { abandonedCount, runSchedulerPass } from "@/lib/modules/bas/reports/scheduler";
import { changeReportState, createReport } from "@/lib/modules/bas/reports/service";
import { claimNextRun } from "@/lib/modules/bas/reports/worker";
import { seedBasReportLibrary } from "@/prisma/bas-report-library";
import { POST as retryRoute } from "@/app/api/modules/bas/reports/runs/[runId]/pdf/retry/route";
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
 * The spin guard (2026-11-13). On the night of 2026-11-12 the worker job's
 * scaler restarted a worker that crashed at startup every 45 seconds all
 * night, against one queued run the worker never reached: the scaler's
 * count never fell, so the restarts never stopped. The scheduler's pass now
 * takes abandoned work out of that count - a run queued for an hour and
 * never claimed, a run claimed and lost twice, a PDF render queued for an
 * hour - each failed with an error saying what happened and what to do.
 *
 * The scaler's own predicate is read out of infra/main.bicep and run against
 * the test database before and after each pass, so "the count returns to
 * zero" is the template's query, not a copy of it.
 */

const authMock = vi.mocked(auth);
const NY = "America/New_York";
const ROOT = path.resolve(process.cwd());
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const MINUTE = 60_000;

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

const viewerOf = (e: Awaited<ReturnType<typeof createEmployee>>) => ({ ...e, profileCompleted: true });

/** The worker job's KEDA query, exactly as the template carries it. */
function scalerQuery(): string {
  const bicep = readFileSync(path.join(ROOT, "infra/main.bicep"), "utf8");
  const start = bicep.indexOf("resource basReportsWorkerJob ");
  expect(start).toBeGreaterThan(-1);
  const block = bicep.slice(start);
  const m = /query: '((?:[^'\\]|\\.)*)'/.exec(block);
  expect(m, "the worker job's scaler query").not.toBeNull();
  return m![1]!.replace(/\\'/g, "'");
}

async function scalerCount(): Promise<number> {
  const rows = await testDb.$queryRawUnsafe<Array<{ count: bigint }>>(scalerQuery());
  return Number(rows[0]!.count);
}

let owner: Awaited<ReturnType<typeof createEmployee>>;
let siteId: bigint;
let reportId: string;

async function seedBuilding() {
  const org = await testDb.basOrg.create({ data: { name: "ZZTEST_GUARD_ORG" } });
  const project = await testDb.basProject.create({ data: { orgId: org.orgId, name: "ZZTEST_GUARD_PROJECT" } });
  const site = await testDb.basSite.create({ data: { orgId: org.orgId, projectId: project.projectId, name: "ZZTEST_GUARD_SITE", timezone: NY } });
  await testDb.basStation.create({ data: { siteId: site.siteId, niagaraStationName: "ZZTestGuardStation", connectionMode: "direct", baseUrl: "https://198.51.100.33" } });
  siteId = site.siteId;
}

async function dropBuilding() {
  await testDb.basStation.deleteMany({ where: { niagaraStationName: "ZZTestGuardStation" } });
  await testDb.basSite.deleteMany({ where: { name: "ZZTEST_GUARD_SITE" } });
  await testDb.basProject.deleteMany({ where: { name: "ZZTEST_GUARD_PROJECT" } });
  await testDb.basOrg.deleteMany({ where: { name: "ZZTEST_GUARD_ORG" } });
}

async function activeReport(): Promise<string> {
  const library = await testDb.basLibraryQuestion.findMany({ select: { libraryQuestionId: true }, orderBy: { position: "asc" } });
  const created = await createReport(viewerOf(owner), {
    name: "ZZTEST guard weekly",
    siteId: siteId.toString(),
    presetKey: "health_weekly",
    analysisWindow: "7d",
    schedule: { kind: "weekly", weekdays: [1] },
    timeOfDay: "06:00",
    questions: library.map((q) => ({ kind: "library" as const, libraryQuestionId: q.libraryQuestionId.toString() })),
  });
  await changeReportState(viewerOf(owner), created.reportId, "activate");
  return created.reportId;
}

const queuedAgo = (ms: number) =>
  enqueueRun(testDb, { reportId: BigInt(reportId), trigger: "scheduled", periodEnd: new Date(), startedById: null, now: new Date(Date.now() - ms) });
const row = (runId: bigint) => testDb.basReportRun.findUniqueOrThrow({ where: { runId } });
const finishedAudits = () => testDb.auditEvent.findMany({ where: { action: "bas.report_run_finished" }, orderBy: { occurredAt: "asc" } });

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
  owner = await createEmployee({ email: "zztest.guard.owner@phb1899.com" });
  await grantModule(owner.id, BAS_MODULE_KEY);
  await grantModuleAdmin(owner.id, BAS_MODULE_KEY);
  await seedBuilding();
  reportId = await activeReport();
});

afterAll(async () => {
  await resetDb();
  await dropBuilding();
  await disconnectDb();
});

describe("the scheduler's pass takes abandoned work out of the scaler's count", () => {
  it("fails a run queued for more than an hour and never claimed, names the minutes and the runbook, audits it, and the count returns to zero", async () => {
    expect(UNCLAIMED_AFTER_MS).toBe(60 * MINUTE);
    const abandoned = await queuedAgo(61 * MINUTE);
    const recent = await queuedAgo(30 * MINUTE);
    expect(await scalerCount()).toBe(2);

    const now = new Date();
    const pass = await runSchedulerPass(now);
    expect(pass.enqueued).toEqual([]);
    expect(pass.abandoned.unclaimedRuns).toEqual([
      { runId: abandoned.runId.toString(), reportId, name: "ZZTEST guard weekly", error: unclaimedRunError(new Date(now.getTime() - 61 * MINUTE), now) },
    ]);
    expect(pass.abandoned.stalledRuns).toEqual([]);
    expect(pass.abandoned.unclaimedPdfs).toEqual([]);
    expect(abandonedCount(pass.abandoned)).toBe(1);

    const failed = await row(abandoned.runId);
    expect(failed).toMatchObject({ status: "failed", attempts: 0 });
    expect(failed.error).toMatch(/^Queued for 61 minutes and never picked up by a worker/);
    expect(failed.error).toContain('runbook entry "Reports: a run is stuck or failed"');
    expect(failed.finishedAt?.toISOString()).toBe(now.toISOString());
    expect(await row(recent.runId)).toMatchObject({ status: "queued" });
    const audits = await finishedAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorEmployeeId: null, metadata: { runId: abandoned.runId.toString(), status: "failed", queuedMinutes: 61, attempts: 0 } });
    // The scaler now counts the recent one alone; a later pass, past its hour, takes it too.
    expect(await scalerCount()).toBe(1);
    const later = await runSchedulerPass(new Date(now.getTime() + 31 * MINUTE));
    expect(later.abandoned.unclaimedRuns.map((r) => r.runId)).toEqual([recent.runId.toString()]);
    expect(await scalerCount()).toBe(0);
    expect(await runSchedulerPass(new Date(now.getTime() + 32 * MINUTE)).then((p) => abandonedCount(p.abandoned))).toBe(0);
  });

  it("leaves alone a run queued for 59 minutes, and one queued an hour ago that a worker has claimed and is heartbeating", async () => {
    const young = await queuedAgo(59 * MINUTE);
    const claimed = await queuedAgo(61 * MINUTE);
    const claim = await claimNextRun();
    expect(claim?.runId).toBe(claimed.runId);
    const pass = await runSchedulerPass();
    expect(abandonedCount(pass.abandoned)).toBe(0);
    expect(await row(young.runId)).toMatchObject({ status: "queued", attempts: 0 });
    expect(await row(claimed.runId)).toMatchObject({ status: "running", attempts: 1, error: null });
    // Counted while queued; a healthy running run is not.
    expect(await scalerCount()).toBe(1);
  });

  it("fails a run claimed and lost twice, as the worker would, so a worker that cannot start does not leave it counted forever", async () => {
    const id = (await queuedAgo(5 * MINUTE)).runId;
    const stale = new Date(Date.now() - STALE_AFTER_MS - 1000);
    await claimNextRun();
    await testDb.basReportRun.update({ where: { runId: id }, data: { heartbeatAt: stale } });
    const second = await claimNextRun();
    expect(second).toMatchObject({ runId: id, attempts: MAX_ATTEMPTS, reclaimed: true });
    await testDb.basReportRun.update({ where: { runId: id }, data: { heartbeatAt: stale } });
    expect(await scalerCount()).toBe(1);

    const pass = await runSchedulerPass();
    expect(pass.abandoned.stalledRuns).toEqual([{ runId: id.toString(), reportId, name: "ZZTEST guard weekly", error: STALLED_TWICE_ERROR }]);
    expect(await row(id)).toMatchObject({ status: "failed", error: STALLED_TWICE_ERROR, attempts: MAX_ATTEMPTS });
    expect(await scalerCount()).toBe(0);
    expect((await finishedAudits()).at(-1)).toMatchObject({ metadata: { runId: id.toString(), status: "failed", error: STALLED_TWICE_ERROR } });
  });

  it("fails a PDF render queued for more than an hour on its own columns, leaves the run alone, and Retry PDF reopens it", async () => {
    const outcome = await executeReportRun(reportId, { periodEnd: new Date(), trigger: "manual", startedById: owner.id, narrator: createFixedNarrator() });
    const id = BigInt(outcome.runId);
    const queuedAt = new Date(Date.now() - 61 * MINUTE);
    await testDb.basReportRun.update({ where: { runId: id }, data: { pdfQueuedAt: queuedAt } });
    // A finished run with a queued render is what the scaler counts.
    expect(await scalerCount()).toBe(1);

    const now = new Date();
    const pass = await runSchedulerPass(now);
    expect(pass.abandoned.unclaimedPdfs).toEqual([{ runId: outcome.runId, reportId, name: "ZZTEST guard weekly", error: unclaimedPdfError(queuedAt, now) }]);
    const r = await row(id);
    expect(r).toMatchObject({ status: outcome.status, error: null, pdfStatus: "failed", pdfQueuedAt: null });
    expect(r.pdfError).toMatch(/^The PDF render was queued for 61 minutes and never picked up by a worker/);
    expect(r.pdfError).toContain('runbook entry "Reports: the PDF"');
    expect(await scalerCount()).toBe(0);
    // No audit row: the run's outcome did not change.
    expect(await finishedAudits()).toHaveLength(1);
    expect((await finishedAudits())[0]).toMatchObject({ metadata: { status: outcome.status } });

    signedInAs(owner.entraOid!);
    const retry = await retryRoute(new Request("http://localhost/x", { method: "POST" }), { params: Promise.resolve({ runId: outcome.runId }) });
    expect(retry.status).toBe(202);
    expect(await row(id)).toMatchObject({ pdfStatus: "queued" });
    expect(await scalerCount()).toBe(1);
    // A fresh queue time: the guard leaves it alone for another hour.
    expect(abandonedCount((await runSchedulerPass()).abandoned)).toBe(0);
  });

  it("applies all three in one call, in order, and reports each by kind", async () => {
    const unclaimed = await queuedAgo(90 * MINUTE);
    const report = await failAbandonedWork();
    expect(report.unclaimedRuns.map((r) => r.runId)).toEqual([unclaimed.runId.toString()]);
    expect(report.stalledRuns).toEqual([]);
    expect(report.unclaimedPdfs).toEqual([]);
    expect(await failAbandonedWork()).toEqual({ unclaimedRuns: [], stalledRuns: [], unclaimedPdfs: [] });
  });

  it("the scheduler script prints what it failed and counts it", async () => {
    const abandoned = await queuedAgo(75 * MINUTE);
    const result = spawnSync(process.execPath, [TSX_CLI, path.join("scripts", "bas-reports-scheduler.ts")], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? "" },
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`[bas-reports-scheduler] failed run ${abandoned.runId} of report ${reportId} (ZZTEST guard weekly): never claimed - Queued for 75 minutes`);
    expect(result.stdout).toContain("0 queued, 0 paused, 0 skipped, 1 abandoned");
    expect(await row(abandoned.runId)).toMatchObject({ status: "failed" });
  }, 150_000);
});
