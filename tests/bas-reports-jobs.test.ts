import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { BasError } from "@/lib/modules/bas/errors";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { createFixedNarrator } from "@/lib/modules/bas/reports/engine/narrative";
import { TIME_CAP_NOTE, enqueueRun, executeReportRun } from "@/lib/modules/bas/reports/engine/run";
import type { ReportDocument } from "@/lib/modules/bas/reports/engine/types";
import { collapseMissedTicks, runSchedulerPass } from "@/lib/modules/bas/reports/scheduler";
import { computeNextRun, type ScheduleSpec } from "@/lib/modules/bas/reports/schedule";
import { DEFAULT_SAFETY_CEILING } from "@/lib/modules/bas/reports/ceiling";
import { readSafetyCeiling } from "@/lib/modules/bas/reports/ceiling-read";
import {
  changeReportState,
  createReport,
  listReportOptions,
  listReports,
  requestRun,
  setSafetyCeiling,
  transferReportOwner,
} from "@/lib/modules/bas/reports/service";
import {
  MAX_ATTEMPTS,
  STALE_AFTER_MS,
  STALLED_TWICE_ERROR,
  claimNextRun,
  drainQueue,
  failExhaustedStaleRuns,
  workOnce,
} from "@/lib/modules/bas/reports/worker";
import { seedBasReportLibrary } from "@/prisma/bas-report-library";
import { POST as runNowRoute } from "@/app/api/modules/bas/reports/[reportId]/runs/route";
import { PATCH as ownerRoute } from "@/app/api/modules/bas/reports/[reportId]/owner/route";
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
 * Reports, Phase 3: the jobs, against the real test database.
 *
 * What the phase's done-when names, each as a test: a definition that missed
 * several ticks gets ONE run and its next run advances past now; an active
 * report whose owner is disabled is paused with the reason, and a module
 * admin's transfer resumes it; two workers never claim the same run (FOR
 * UPDATE SKIP LOCKED, with one row held locked while the other worker
 * claims); a stalled run is reclaimed once and failed the second time with
 * the clear error; the time cap makes a run partial naming the cap and
 * the questions it skipped; Run now is refused while a run is in flight
 * and refused outright to a BAS user who is neither owner nor admin; the
 * worker executes a queued run end to end, in process and as the real
 * script under tsx - the worker's own loader, which is what
 * tests/bas-reports-worker-render.test.ts exists for.
 *
 * No readings are seeded: every question lands Not Monitored, which is
 * enough for every claim here except the cap's, and the cap is checked
 * before a question is looked at.
 */

const authMock = vi.mocked(auth);
const NY = "America/New_York";
const WEEKLY_MONDAY: ScheduleSpec = { kind: "weekly", weekdays: [1] };
const ROOT = path.resolve(process.cwd());
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

const viewerOf = (e: Awaited<ReturnType<typeof createEmployee>>) => ({ ...e, profileCompleted: true });
const report = (reportId: string) => ({ params: Promise.resolve({ reportId }) });
const bare = (method = "POST") => new Request("http://localhost/api/modules/bas/reports", { method });
const json = (body: unknown, method = "PATCH") =>
  new Request("http://localhost/api/modules/bas/reports", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function errorCode(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { error?: { code?: string } }).error?.code;
}
async function auditRows(action: string) {
  return testDb.auditEvent.findMany({ where: { action }, orderBy: { occurredAt: "asc" } });
}

let owner: Awaited<ReturnType<typeof createEmployee>>;
let other: Awaited<ReturnType<typeof createEmployee>>;
let admin: Awaited<ReturnType<typeof createEmployee>>;
let outsider: Awaited<ReturnType<typeof createEmployee>>;
let siteId: bigint;
let reportId: string;

async function seedBuilding() {
  const org = await testDb.basOrg.create({ data: { name: "ZZTEST_JOBS_ORG" } });
  const project = await testDb.basProject.create({ data: { orgId: org.orgId, name: "ZZTEST_JOBS_PROJECT" } });
  const site = await testDb.basSite.create({ data: { orgId: org.orgId, projectId: project.projectId, name: "ZZTEST_JOBS_SITE", timezone: NY } });
  await testDb.basStation.create({ data: { siteId: site.siteId, niagaraStationName: "ZZTestJobsStation", connectionMode: "direct", baseUrl: "https://198.51.100.31" } });
  siteId = site.siteId;
}

async function dropBuilding() {
  await testDb.basStation.deleteMany({ where: { niagaraStationName: "ZZTestJobsStation" } });
  await testDb.basSite.deleteMany({ where: { name: "ZZTEST_JOBS_SITE" } });
  await testDb.basProject.deleteMany({ where: { name: "ZZTEST_JOBS_PROJECT" } });
  await testDb.basOrg.deleteMany({ where: { name: "ZZTEST_JOBS_ORG" } });
}

/** A weekly Monday 06:00 report with the standard weekly's twenty questions, owned by `owner`, activated. */
async function activeReport(name = "ZZTEST jobs weekly"): Promise<string> {
  const library = await testDb.basLibraryQuestion.findMany({ select: { libraryQuestionId: true }, orderBy: { position: "asc" } });
  const created = await createReport(viewerOf(owner), {
    name,
    siteId: siteId.toString(),
    presetKey: "health_weekly",
    analysisWindow: "7d",
    schedule: WEEKLY_MONDAY,
    timeOfDay: "06:00",
    questions: library.map((q) => ({ kind: "library" as const, libraryQuestionId: q.libraryQuestionId.toString() })),
  });
  await changeReportState(viewerOf(owner), created.reportId, "activate");
  return created.reportId;
}

const definition = (id: string) => testDb.basReportDefinition.findUniqueOrThrow({ where: { reportId: BigInt(id) } });
const runsOf = (id: string) => testDb.basReportRun.findMany({ where: { reportId: BigInt(id) }, orderBy: { runId: "asc" } });

beforeAll(async () => {
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
  owner = await createEmployee({ email: "zztest.jobs.owner@phb1899.com" });
  other = await createEmployee({ email: "zztest.jobs.other@phb1899.com" });
  admin = await createEmployee({ email: "zztest.jobs.admin@phb1899.com" });
  outsider = await createEmployee({ email: "zztest.jobs.outsider@phb1899.com" });
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

// ---------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------

describe("the scheduler", () => {
  it("collapses missed ticks into one run for the latest occurrence, with the next one after now", () => {
    // Monday 2 November 2026 06:00 New York, after the clock change: 11:00Z.
    const due = new Date(Date.UTC(2026, 10, 2, 11));
    const now = new Date(Date.UTC(2026, 10, 24, 15)); // Tuesday 24 November
    const r = collapseMissedTicks(WEEKLY_MONDAY, "06:00", NY, due, now);
    expect(r.periodEnd.toISOString()).toBe("2026-11-23T11:00:00.000Z");
    expect(r.nextRunAt.toISOString()).toBe("2026-11-30T11:00:00.000Z");
    expect(r.missedTicks).toBe(3);
    // Nothing missed: the due occurrence is the period end and the next is one week on.
    const fresh = collapseMissedTicks(WEEKLY_MONDAY, "06:00", NY, due, new Date(Date.UTC(2026, 10, 2, 11, 5)));
    expect(fresh).toMatchObject({ missedTicks: 0 });
    expect(fresh.periodEnd.toISOString()).toBe("2026-11-23T11:00:00.000Z".replace("23", "02"));
    expect(fresh.nextRunAt.toISOString()).toBe("2026-11-09T11:00:00.000Z");
  });

  it("queues exactly one run for a definition that missed several ticks, advances next_run_at, and does nothing on the next pass", async () => {
    const now = new Date();
    // An occurrence about a month ago, so three or four Mondays were missed.
    const due = computeNextRun(WEEKLY_MONDAY, "06:00", NY, new Date(now.getTime() - 30 * 86_400_000));
    await testDb.basReportDefinition.update({ where: { reportId: BigInt(reportId) }, data: { nextRunAt: due } });

    const pass = await runSchedulerPass(now);
    expect(pass.enqueued).toHaveLength(1);
    expect(pass.paused).toHaveLength(0);
    const expected = collapseMissedTicks(WEEKLY_MONDAY, "06:00", NY, due, now);
    expect(pass.enqueued[0]).toMatchObject({ reportId, missedTicks: expected.missedTicks, periodEnd: expected.periodEnd.toISOString() });
    expect(expected.missedTicks).toBeGreaterThanOrEqual(2);

    const runs = await runsOf(reportId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "queued", trigger: "scheduled", startedById: null, attempts: 0, timezone: NY });
    expect(runs[0]!.periodEnd.toISOString()).toBe(expected.periodEnd.toISOString());
    expect(runs[0]!.periodEnd.getTime() - runs[0]!.periodStart.getTime()).toBe(7 * 86_400_000);
    const def = await definition(reportId);
    expect(def.nextRunAt?.toISOString()).toBe(expected.nextRunAt.toISOString());
    expect(def.nextRunAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(def.nextRunAt?.toISOString()).toBe(computeNextRun(WEEKLY_MONDAY, "06:00", NY, now).toISOString());

    const requested = await auditRows("bas.report_run_requested");
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ actorEmployeeId: null, metadata: { reportId, trigger: "scheduled", missedTicks: expected.missedTicks } });

    // The next pass: nothing is due, nothing is queued.
    const again = await runSchedulerPass(new Date(now.getTime() + 60_000));
    expect(again.enqueued).toHaveLength(0);
    expect(await runsOf(reportId)).toHaveLength(1);
  });

  it("leaves a definition alone until its next run time passes, and a paused one always", async () => {
    const before = await definition(reportId);
    const pass = await runSchedulerPass(new Date(before.nextRunAt!.getTime() - 60_000));
    expect(pass.enqueued).toHaveLength(0);
    await changeReportState(viewerOf(owner), reportId, "pause");
    const paused = await runSchedulerPass(new Date(before.nextRunAt!.getTime() + 60_000));
    expect(paused.enqueued).toHaveLength(0);
    expect(await runsOf(reportId)).toHaveLength(0);
  });

  it("pauses an active report whose owner is disabled, with the reason and an audit row, and a module admin's transfer resumes it", async () => {
    await testDb.employee.update({ where: { id: owner.id }, data: { status: "disabled" } });
    const due = new Date(Date.now() - 86_400_000);
    await testDb.basReportDefinition.update({ where: { reportId: BigInt(reportId) }, data: { nextRunAt: due } });

    const pass = await runSchedulerPass();
    expect(pass.paused).toEqual([{ reportId, name: "ZZTEST jobs weekly", ownerEmail: owner.email }]);
    expect(pass.enqueued).toHaveLength(0);
    const paused = await definition(reportId);
    expect(paused).toMatchObject({ state: "paused_owner_disabled", nextRunAt: null });
    expect(paused.pausedReason).toContain(owner.email);
    expect(await runsOf(reportId)).toHaveLength(0);
    const changed = await auditRows("bas.report_state_changed");
    expect(changed.at(-1)).toMatchObject({ actorEmployeeId: null, metadata: { reportId, from: "active", to: "paused_owner_disabled", ownerEmail: owner.email } });

    // The list says why.
    const list = await listReports(viewerOf(admin));
    expect(list.reports[0]).toMatchObject({ state: "paused_owner_disabled" });
    expect(list.reports[0]!.pausedReason).toContain("disabled");

    // Resume is refused to everyone until the owner changes...
    await expect(changeReportState(viewerOf(admin), reportId, "resume")).rejects.toMatchObject({ code: "invalid_state" });

    // ...and the transfer, by a module admin, is what changes it.
    const transfer = await transferReportOwner(viewerOf(admin), reportId, { ownerEmployeeId: other.id });
    expect(transfer).toMatchObject({ ownerEmployeeId: other.id, ownerEmail: other.email, state: "active", resumed: true });
    expect(transfer.nextRunAt).not.toBeNull();
    const resumed = await definition(reportId);
    expect(resumed).toMatchObject({ ownerEmployeeId: other.id, state: "active", pausedReason: null });
    expect(resumed.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    const transferred = await auditRows("bas.report_owner_transferred");
    expect(transferred).toHaveLength(1);
    expect(transferred[0]).toMatchObject({ actorEmployeeId: admin.id, metadata: { reportId, fromEmail: owner.email, toEmail: other.email, resumed: true } });
  });

  it("refuses a transfer from an owner who is not a module admin (403), to an employee without the grant (409), and to a stranger (404)", async () => {
    signedInAs(owner.entraOid!);
    expect((await ownerRoute(json({ ownerEmployeeId: other.id }), report(reportId))).status).toBe(403);
    signedInAs(admin.entraOid!);
    const ineligible = await ownerRoute(json({ ownerEmployeeId: outsider.id }), report(reportId));
    expect(ineligible.status).toBe(409);
    expect(await errorCode(ineligible)).toBe("owner_not_eligible");
    signedInAs(other.entraOid!);
    expect((await ownerRoute(json({ ownerEmployeeId: other.id }), report(reportId))).status).toBe(404);
    // A plain transfer of an active report keeps it active and is audited as not resumed.
    signedInAs(admin.entraOid!);
    const ok = await ownerRoute(json({ ownerEmployeeId: other.id }), report(reportId));
    expect(ok.status).toBe(200);
    expect((await auditRows("bas.report_owner_transferred"))[0]).toMatchObject({ metadata: { resumed: false, fromState: "active", toState: "active" } });
    // The options for an admin list who can take a report; a plain owner gets none.
    expect((await listReportOptions(viewerOf(admin))).owners.map((o) => o.email).sort()).toEqual([admin.email, other.email, owner.email].sort());
    expect((await listReportOptions(viewerOf(owner))).owners).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Claiming: SKIP LOCKED, and the stall rules
// ---------------------------------------------------------------------------

describe("claiming runs", () => {
  async function queued(n: number): Promise<bigint[]> {
    const ids: bigint[] = [];
    for (let i = 0; i < n; i += 1) {
      const run = await enqueueRun(testDb, { reportId: BigInt(reportId), trigger: "manual", periodEnd: new Date(), startedById: owner.id, now: new Date(Date.now() - (n - i) * 1000) });
      ids.push(run.runId);
    }
    return ids;
  }

  it("never gives two workers the same run: a row one worker holds locked is skipped, and the third claim finds nothing", async () => {
    const [a, b] = await queued(2);
    // Worker 1 is holding run A inside its transaction; worker 2 claims meanwhile.
    const seenByWorker2 = await testDb.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT run_id FROM bas_report_runs WHERE run_id = ${a} FOR UPDATE`;
      return claimNextRun();
    });
    expect(seenByWorker2?.runId).toBe(b);
    expect(seenByWorker2).toMatchObject({ attempts: 1, reclaimed: false });
    // Worker 1's own claim, once free, takes A; nothing is left after that.
    expect((await claimNextRun())?.runId).toBe(a);
    expect(await claimNextRun()).toBeNull();
    const rows = await runsOf(reportId);
    expect(rows.map((r) => [r.status, r.attempts])).toEqual([["running", 1], ["running", 1]]);
    expect(rows.every((r) => r.startedAt !== null && r.heartbeatAt !== null)).toBe(true);
  });

  it("gives two simultaneous claims two different runs", async () => {
    await queued(2);
    const [x, y] = await Promise.all([claimNextRun(), claimNextRun()]);
    expect(x).not.toBeNull();
    expect(y).not.toBeNull();
    expect(x!.runId).not.toBe(y!.runId);
  });

  it("reclaims a stalled run once, then fails it with a clear error when it stalls again", async () => {
    const id = (await queued(1))[0]!;
    const first = await claimNextRun();
    expect(first?.runId).toBe(id);
    // Alive: not claimable by anyone else.
    expect(await claimNextRun()).toBeNull();
    // Stalled: the heartbeat stops for longer than the stale window.
    const stale = new Date(Date.now() - STALE_AFTER_MS - 1000);
    await testDb.basReportRun.update({ where: { runId: id }, data: { heartbeatAt: stale } });
    expect(await failExhaustedStaleRuns()).toBe(0);
    const second = await claimNextRun();
    expect(second).toMatchObject({ runId: id, attempts: MAX_ATTEMPTS, reclaimed: true });
    expect((await testDb.basReportRun.findUniqueOrThrow({ where: { runId: id } })).startedAt!.getTime()).toBeGreaterThan(stale.getTime());
    // Stalled a second time: failed, never claimed again.
    await testDb.basReportRun.update({ where: { runId: id }, data: { heartbeatAt: stale } });
    expect(await claimNextRun()).toBeNull();
    expect(await failExhaustedStaleRuns()).toBe(1);
    const failed = await testDb.basReportRun.findUniqueOrThrow({ where: { runId: id } });
    expect(failed).toMatchObject({ status: "failed", error: STALLED_TWICE_ERROR, attempts: MAX_ATTEMPTS });
    expect(failed.finishedAt).not.toBeNull();
    expect((await auditRows("bas.report_run_finished")).at(-1)).toMatchObject({ actorEmployeeId: null, metadata: { runId: id.toString(), status: "failed", error: STALLED_TWICE_ERROR, attempts: 2 } });
    expect(await failExhaustedStaleRuns()).toBe(0);
  });

  it("holds attempts to a count in the database", async () => {
    const id = (await queued(1))[0]!;
    await expect(testDb.$executeRaw`UPDATE bas_report_runs SET attempts = -1 WHERE run_id = ${id}`).rejects.toThrow(/bas_report_runs_attempts_nonnegative/);
  });
});

// ---------------------------------------------------------------------------
// The safety ceiling's minutes (the per-report time cap until 2026-11-12)
// ---------------------------------------------------------------------------

describe("the wall-clock half of the safety ceiling", () => {
  it("stops starting questions and narrative past the deadline, finishes partial, and names the cap and what was skipped", async () => {
    // The clock: the run starts at t0, the first few reads are still at t0,
    // then it is half an hour later.
    const t0 = Date.now();
    let reads = 0;
    const clock = () => {
      reads += 1;
      return reads <= 3 ? t0 : t0 + 30 * 60_000;
    };
    const outcome = await executeReportRun(reportId, { periodEnd: new Date(), trigger: "manual", startedById: owner.id, narrator: createFixedNarrator(), clock });
    expect(outcome.status).toBe("partial");
    expect(outcome.partialReason).toMatch(new RegExp(`^Safety ceiling of ${DEFAULT_SAFETY_CEILING.minutes} min reached after \\d+ min: Q\\d+`));
    const skipped = outcome.document.sections.flatMap((s) => s.questions).filter((q) => q.outcome === "not_run" && q.reason === TIME_CAP_NOTE);
    expect(skipped.length).toBeGreaterThan(0);
    for (const q of skipped) expect(outcome.partialReason).toContain(`Q${q.position}`);
    // Data Health is computed before the loop and is never the cap's victim.
    expect(outcome.document.sections.find((s) => s.key === "data_health")?.questions[0]?.outcome).toBe("answered");
    // Stored as partial, with the page saying so.
    const row = await testDb.basReportRun.findUniqueOrThrow({ where: { runId: BigInt(outcome.runId) } });
    expect(row).toMatchObject({ status: "partial", attempts: 1 });
    expect(row.partialReason).toBe(outcome.partialReason);
    expect(row.reportHtml).toContain("Partial report");
    expect((row.reportJson as unknown as ReportDocument).header.partialReason).toBe(outcome.partialReason);
  });

  it("is the module's setting: read by every run, set by a module admin only, bounded by the CHECK, audited with both halves, and stamped on the run", async () => {
    expect(await readSafetyCeiling()).toMatchObject({ usd: DEFAULT_SAFETY_CEILING.usd, minutes: DEFAULT_SAFETY_CEILING.minutes });
    // An owner is not an admin: the ceiling is every report's.
    await expect(setSafetyCeiling(viewerOf(owner), { ceilingMinutes: 5 })).rejects.toMatchObject({ code: "admin_required" });
    const set = await setSafetyCeiling(viewerOf(admin), { ceilingMinutes: 5 });
    expect(set).toMatchObject({ changed: true, ceiling: { usd: DEFAULT_SAFETY_CEILING.usd, minutes: 5, updatedBy: admin.email } });
    expect((await auditRows("bas.report_ceiling_changed")).at(-1)).toMatchObject({
      actorEmployeeId: admin.id,
      metadata: { from: { usd: DEFAULT_SAFETY_CEILING.usd, minutes: DEFAULT_SAFETY_CEILING.minutes }, to: { usd: DEFAULT_SAFETY_CEILING.usd, minutes: 5 } },
    });
    await expect(testDb.basReportSettings.update({ where: { settingsId: 1 }, data: { ceilingMinutes: 26 } })).rejects.toThrow(/bas_report_settings_ceiling_minutes_range/);
    // The definition no longer carries a cap of its own.
    const columns = await testDb.$queryRaw<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name = 'bas_report_definitions' AND column_name IN ('budget_usd', 'max_minutes')`;
    expect(columns).toEqual([]);
    // The reason column cannot outlive its state.
    await expect(testDb.basReportDefinition.update({ where: { reportId: BigInt(reportId) }, data: { pausedReason: "stale" } })).rejects.toThrow(/bas_report_definitions_paused_reason_matches_state/);
    // A run made under the lower ceiling carries on as before when nothing is slow, and records the ceiling that applied.
    const outcome = await executeReportRun(reportId, { periodEnd: new Date(), trigger: "manual", startedById: owner.id, narrator: createFixedNarrator() });
    expect(outcome.partialReason ?? "").not.toContain("Safety ceiling");
    expect(outcome.document.cost.budgetUsd).toBe(DEFAULT_SAFETY_CEILING.usd);
    const row = await testDb.basReportRun.findUniqueOrThrow({ where: { runId: BigInt(outcome.runId) } });
    expect(Number(row.budgetUsd)).toBe(DEFAULT_SAFETY_CEILING.usd);
    // Past the lower minutes: the reason names five.
    let reads = 0;
    const clock = () => (++reads <= 3 ? Date.now() : Date.now() + 6 * 60_000);
    const capped = await executeReportRun(reportId, { periodEnd: new Date(), trigger: "manual", startedById: owner.id, narrator: createFixedNarrator(), clock });
    expect(capped.partialReason).toMatch(/^Safety ceiling of 5 min reached/);
  });
});

// ---------------------------------------------------------------------------
// Run now
// ---------------------------------------------------------------------------

describe("Run now", () => {
  it("queues one manual run for the owner, refuses a second while it is in flight, and answers 404 to a stranger", async () => {
    const first = await requestRun(viewerOf(owner), reportId);
    const rows = await runsOf(reportId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId: BigInt(first.runId), status: "queued", trigger: "manual", startedById: owner.id });
    expect((await auditRows("bas.report_run_requested"))[0]).toMatchObject({ actorEmployeeId: owner.id, metadata: { reportId, runId: first.runId, trigger: "manual" } });

    await expect(requestRun(viewerOf(owner), reportId)).rejects.toMatchObject({ code: "run_in_flight" });
    await expect(requestRun(viewerOf(admin), reportId)).rejects.toMatchObject({ code: "run_in_flight" });
    // Running counts as in flight too.
    await claimNextRun();
    const inFlight = await requestRun(viewerOf(owner), reportId).catch((e: unknown) => e);
    expect(inFlight).toBeInstanceOf(BasError);
    expect((inFlight as BasError).message).toContain("running");

    // Through the route: 202 on success, 409 in flight, 404 for a BAS user who is neither owner nor admin.
    signedInAs(other.entraOid!);
    expect((await runNowRoute(bare(), report(reportId))).status).toBe(404);
    signedInAs(admin.entraOid!);
    const refused = await runNowRoute(bare(), report(reportId));
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe("run_in_flight");
    await testDb.basReportRun.update({ where: { runId: BigInt(first.runId) }, data: { status: "failed", error: "test", finishedAt: new Date() } });
    const accepted = await runNowRoute(bare(), report(reportId));
    expect(accepted.status).toBe(202);
    expect(await runsOf(reportId)).toHaveLength(2);

    // The Scheduled list shows the newest run, queued.
    const list = await listReports(viewerOf(admin));
    expect(list.reports[0]!.lastRun).toMatchObject({ status: "queued" });
  });

  it("refuses a report with no questions", async () => {
    const bare2 = await createReport(viewerOf(owner), { name: "ZZTEST jobs empty", siteId: siteId.toString(), schedule: WEEKLY_MONDAY, timeOfDay: "06:00" });
    await expect(requestRun(viewerOf(owner), bare2.reportId)).rejects.toMatchObject({ code: "report_not_ready" });
  });
});

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

describe("the worker", () => {
  it("executes a queued run end to end, heartbeating while it works, and leaves nothing to claim", async () => {
    const { runId } = await requestRun(viewerOf(owner), reportId);
    const beats: Date[] = [];
    const claim = await workOnce({ narrator: createFixedNarrator(), heartbeatMs: 20 });
    expect(claim).toMatchObject({ runId: BigInt(runId), attempts: 1, reclaimed: false });
    const row = await testDb.basReportRun.findUniqueOrThrow({ where: { runId: BigInt(runId) } });
    expect(["succeeded", "partial"]).toContain(row.status);
    expect(row.finishedAt).not.toBeNull();
    expect(row.reportHtml ?? "").toContain("<!doctype html>");
    expect(row.heartbeatAt!.getTime()).toBeGreaterThanOrEqual(row.startedAt!.getTime());
    beats.push(row.heartbeatAt!);
    expect(await workOnce({ narrator: createFixedNarrator() })).toBeNull();
    const list = await listReports(viewerOf(owner));
    expect(list.reports[0]!.lastRun).toMatchObject({ runId, status: row.status });
    expect((await auditRows("bas.report_run_started"))[0]).toMatchObject({ actorEmployeeId: owner.id, metadata: { runId, trigger: "manual", attempt: 1 } });
  });

  it("drains the queue in order and stops at --once", async () => {
    const a = await enqueueRun(testDb, { reportId: BigInt(reportId), trigger: "scheduled", periodEnd: new Date(), startedById: null, now: new Date(Date.now() - 2000) });
    const b = await enqueueRun(testDb, { reportId: BigInt(reportId), trigger: "scheduled", periodEnd: new Date(), startedById: null, now: new Date(Date.now() - 1000) });
    const once = await drainQueue({ narrator: createFixedNarrator() }, { maxRuns: 1 });
    expect(once.map((c) => c.runId)).toEqual([a.runId]);
    const rest = await drainQueue({ narrator: createFixedNarrator() });
    expect(rest.map((c) => c.runId)).toEqual([b.runId]);
    expect(await drainQueue({ narrator: createFixedNarrator() })).toEqual([]);
  });

  it("runs as the real script under tsx - the worker's loader - and finishes the run", async () => {
    const { runId } = await requestRun(viewerOf(owner), reportId);
    const result = spawnSync(process.execPath, [TSX_CLI, path.join("scripts", "bas-reports-worker.ts"), "--once", "--no-narrative"], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? "" },
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`run ${runId} of report ${reportId}: done`);
    expect(result.stdout).toContain("narrator: off (--no-narrative)");
    const row = await testDb.basReportRun.findUniqueOrThrow({ where: { runId: BigInt(runId) } });
    expect(["succeeded", "partial"]).toContain(row.status);
    expect(row.reportHtml ?? "").toContain("<!doctype html>");
    expect(row.error).toBeNull();
  }, 150_000);

  it("runs the scheduler as the real script under tsx, which queues the due run", async () => {
    const due = computeNextRun(WEEKLY_MONDAY, "06:00", NY, new Date(Date.now() - 15 * 86_400_000));
    await testDb.basReportDefinition.update({ where: { reportId: BigInt(reportId) }, data: { nextRunAt: due } });
    const result = spawnSync(process.execPath, [TSX_CLI, path.join("scripts", "bas-reports-scheduler.ts")], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? "" },
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("1 queued, 0 paused, 0 skipped");
    expect((await runsOf(reportId)).map((r) => [r.status, r.trigger])).toEqual([["queued", "scheduled"]]);
  }, 150_000);
});
