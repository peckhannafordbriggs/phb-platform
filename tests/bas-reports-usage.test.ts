import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { DEFAULT_SAFETY_CEILING } from "@/lib/modules/bas/reports/ceiling";
import { createReport } from "@/lib/modules/bas/reports/service";
import { getReportsUsage, type ReportsUsage } from "@/lib/modules/bas/reports/usage";
import { seedBasReportLibrary } from "@/prisma/bas-report-library";
import { GET as usageRoute } from "@/app/api/modules/bas/reports/usage/route";
import { GET as readCeilingRoute, PATCH as ceilingRoute } from "@/app/api/modules/bas/reports/ceiling/route";
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
 * The Reports Usage page's figures (2026-11-12), against the real test
 * database.
 *
 * THE BUG THIS FILE EXISTS FOR. The Usage item read "There have been no
 * runs" while the Reports list beside it showed a succeeded run costing
 * $0.0397 on 4,310 tokens. The cause was not a filter: the page was the
 * Phase 1 placeholder, a static component that never queried anything,
 * left in place when Phase 2 began recording runs. The first test seeds
 * exactly that run and asserts the figures come back from the database.
 *
 * Then what the page promises: the 7 / 30 / 90-day cut on the finished
 * instant in New York, the month so far whatever the range, the two
 * breakdowns, the most expensive runs, the runs-list visibility (owner or
 * module admin, nobody else), the joinless count beside the figures, and
 * the safety ceiling riding in the same payload.
 */

const authMock = vi.mocked(auth);
const NY = "America/New_York";
/** Noon in New York on 12 November 2026. */
const NOW = new Date("2026-11-12T17:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

const viewerOf = (e: Awaited<ReturnType<typeof createEmployee>>) => ({ ...e, profileCompleted: true });

let owner: Awaited<ReturnType<typeof createEmployee>>;
let other: Awaited<ReturnType<typeof createEmployee>>;
let admin: Awaited<ReturnType<typeof createEmployee>>;
let officeSite: bigint;
let labSite: bigint;
let officeReport: string;
let labReport: string;

async function seedBuildings() {
  const org = await testDb.basOrg.create({ data: { name: "ZZTEST_USAGE_ORG" } });
  const project = await testDb.basProject.create({ data: { orgId: org.orgId, name: "ZZTEST_USAGE_PROJECT" } });
  const office = await testDb.basSite.create({ data: { orgId: org.orgId, projectId: project.projectId, name: "ZZTEST_USAGE_OFFICE", timezone: NY } });
  const lab = await testDb.basSite.create({ data: { orgId: org.orgId, projectId: project.projectId, name: "ZZTEST_USAGE_LAB", timezone: NY } });
  officeSite = office.siteId;
  labSite = lab.siteId;
}

async function dropBuildings() {
  await testDb.basSite.deleteMany({ where: { name: { startsWith: "ZZTEST_USAGE" } } });
  await testDb.basProject.deleteMany({ where: { name: { startsWith: "ZZTEST_USAGE" } } });
  await testDb.basOrg.deleteMany({ where: { name: { startsWith: "ZZTEST_USAGE" } } });
}

async function reportFor(ownerOf: Awaited<ReturnType<typeof createEmployee>>, name: string, siteId: bigint): Promise<string> {
  const library = await testDb.basLibraryQuestion.findMany({ select: { libraryQuestionId: true }, orderBy: { position: "asc" } });
  const created = await createReport(viewerOf(ownerOf), {
    name,
    siteId: siteId.toString(),
    schedule: { kind: "weekly", weekdays: [1] },
    timeOfDay: "06:00",
    questions: library.slice(0, 3).map((q) => ({ kind: "library" as const, libraryQuestionId: q.libraryQuestionId.toString() })),
  });
  return created.reportId;
}

/** A finished run as the engine stores one: cost and tokens metered onto the row, a document, the ceiling that applied. */
async function finishedRun(reportId: string, over: { status?: string; costUsd: number; inputTokens: number; outputTokens: number; finishedAt: Date; startedAt?: Date }) {
  const row = await testDb.basReportRun.create({
    data: {
      reportId: BigInt(reportId),
      status: over.status ?? "succeeded",
      trigger: "manual",
      periodStart: new Date(over.finishedAt.getTime() - 7 * 86_400_000),
      periodEnd: over.finishedAt,
      timezone: NY,
      budgetUsd: DEFAULT_SAFETY_CEILING.usd.toFixed(2),
      costUsd: over.costUsd.toFixed(6),
      inputTokens: over.inputTokens,
      outputTokens: over.outputTokens,
      startedAt: over.startedAt ?? new Date(over.finishedAt.getTime() - 60_000),
      finishedAt: over.finishedAt,
      heartbeatAt: over.finishedAt,
      attempts: 1,
      reportJson: over.status === "failed" ? undefined : { version: 1 },
      reportHtml: over.status === "failed" ? undefined : "<!doctype html>",
      error: over.status === "failed" ? "test" : undefined,
      partialReason: over.status === "partial" ? "Safety ceiling of $10.00 reached after 1 of 2 sections had narrative; the rest show their evidence only" : undefined,
    },
    select: { runId: true },
  });
  return row.runId.toString();
}

const bare = (url: string) => new Request(url);
const json = (body: unknown, method = "PATCH") =>
  new Request("http://localhost/api/modules/bas/reports/ceiling", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function data<T>(r: Response): Promise<T> {
  return ((await r.json()) as { data: T }).data;
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetBasAvailabilityCache();
  await resetDb();
  await dropBuildings();
  await seedChangeOrdersModule();
  await seedBasModule();
  await seedBasReportLibrary(testDb);
  owner = await createEmployee({ email: "zztest.usage.owner@phb1899.com" });
  other = await createEmployee({ email: "zztest.usage.other@phb1899.com" });
  admin = await createEmployee({ email: "zztest.usage.admin@phb1899.com" });
  for (const e of [owner, other, admin]) await grantModule(e.id, BAS_MODULE_KEY);
  await grantModuleAdmin(admin.id, BAS_MODULE_KEY);
  await seedBuildings();
  officeReport = await reportFor(owner, "ZZTEST usage office", officeSite);
  labReport = await reportFor(other, "ZZTEST usage lab", labSite);
});

afterAll(async () => {
  await resetDb();
  await dropBuildings();
  await disconnectDb();
});

describe("the Usage figures come from the database", () => {
  it("shows the one succeeded run the Reports list shows - $0.0397 on 4,310 tokens - instead of saying there have been no runs", async () => {
    const runId = await finishedRun(officeReport, { costUsd: 0.0397, inputTokens: 3_500, outputTokens: 810, finishedAt: daysAgo(1) });
    const usage = await getReportsUsage(viewerOf(owner), "30d", NOW);
    expect(usage.totals).toEqual({ runs: 1, tokens: 4_310, spend: 0.0397 });
    expect(usage.runsInDatabase).toBe(1);
    expect(usage.byReport).toEqual([{ label: "ZZTEST usage office", runs: 1, tokens: 4_310, spend: 0.0397 }]);
    expect(usage.byBuilding).toEqual([{ label: "ZZTEST_USAGE_OFFICE", runs: 1, tokens: 4_310, spend: 0.0397 }]);
    expect(usage.topRuns).toHaveLength(1);
    expect(usage.topRuns[0]).toMatchObject({ runId, reportName: "ZZTEST usage office", buildingName: "ZZTEST_USAGE_OFFICE", status: "succeeded", tokens: 4_310, spend: 0.0397 });
    expect(usage.days.find((d) => d.date === "2026-11-11")?.spend).toBe(0.0397);
    expect(usage.thisMonth).toEqual({ label: "November", spend: 0.0397 });
    expect(usage.ceiling).toMatchObject({ usd: DEFAULT_SAFETY_CEILING.usd, minutes: DEFAULT_SAFETY_CEILING.minutes });
  });

  it("cuts on the finished instant in New York: 7 / 30 / 90 days, the month so far whatever the range, queued and running runs never counted", async () => {
    await finishedRun(officeReport, { costUsd: 1, inputTokens: 100, outputTokens: 10, finishedAt: daysAgo(2) });
    await finishedRun(officeReport, { costUsd: 2, inputTokens: 100, outputTokens: 10, finishedAt: daysAgo(20) });
    await finishedRun(officeReport, { costUsd: 4, inputTokens: 100, outputTokens: 10, finishedAt: daysAgo(60), status: "partial" });
    await finishedRun(officeReport, { costUsd: 8, inputTokens: 100, outputTokens: 10, finishedAt: daysAgo(100) });
    // 11pm on 11 November in New York is already the 12th in UTC; it belongs to the 11th.
    await finishedRun(officeReport, { costUsd: 0.5, inputTokens: 10, outputTokens: 1, finishedAt: new Date("2026-11-12T04:00:00Z") });
    // Queued and running: nothing spent yet.
    await testDb.basReportRun.create({ data: { reportId: BigInt(officeReport), status: "queued", trigger: "manual", periodStart: daysAgo(8), periodEnd: daysAgo(1), timezone: NY, budgetUsd: "10.00" } });
    await testDb.basReportRun.create({ data: { reportId: BigInt(officeReport), status: "running", trigger: "manual", periodStart: daysAgo(8), periodEnd: daysAgo(1), timezone: NY, budgetUsd: "10.00", startedAt: NOW, heartbeatAt: NOW, attempts: 1 } });

    const week = await getReportsUsage(viewerOf(owner), "7d", NOW);
    expect(week.totals).toEqual({ runs: 2, tokens: 121, spend: 1.5 });
    expect(week.runsInDatabase).toBe(2);
    expect(week.days).toHaveLength(7);
    expect(week.days[0]).toMatchObject({ date: "2026-11-06", label: "Nov 6" });
    expect(week.days.at(-1)).toMatchObject({ date: "2026-11-12", spend: 0 });
    expect(week.days.find((d) => d.date === "2026-11-11")?.spend).toBe(0.5);
    expect(week.days.find((d) => d.date === "2026-11-10")?.spend).toBe(1);
    expect(week.thisMonth.spend).toBe(1.5);

    const month = await getReportsUsage(viewerOf(owner), "30d", NOW);
    expect(month.totals.runs).toBe(3);
    expect(month.totals.spend).toBe(3.5);
    expect(month.thisMonth.spend).toBe(1.5);

    const quarter = await getReportsUsage(viewerOf(owner), "90d", NOW);
    expect(quarter.totals.runs).toBe(4);
    expect(quarter.totals.spend).toBe(7.5);
    expect(quarter.topRuns.map((r) => [r.spend, r.status])).toEqual([[4, "partial"], [2, "succeeded"], [1, "succeeded"], [0.5, "succeeded"]]);
    expect(quarter.days).toHaveLength(90);
  });

  it("is the runs list's visibility: a person sees their reports' spend, a module admin every report's, and a stranger nothing", async () => {
    await finishedRun(officeReport, { costUsd: 1, inputTokens: 100, outputTokens: 10, finishedAt: daysAgo(1) });
    await finishedRun(labReport, { costUsd: 3, inputTokens: 300, outputTokens: 30, finishedAt: daysAgo(1), status: "failed" });

    const mine = await getReportsUsage(viewerOf(owner), "30d", NOW);
    expect(mine.totals).toEqual({ runs: 1, tokens: 110, spend: 1 });
    expect(mine.byBuilding.map((r) => r.label)).toEqual(["ZZTEST_USAGE_OFFICE"]);

    const everyone = await getReportsUsage(viewerOf(admin), "30d", NOW);
    expect(everyone.totals).toEqual({ runs: 2, tokens: 440, spend: 4 });
    expect(everyone.runsInDatabase).toBe(2);
    expect(everyone.byReport.map((r) => [r.label, r.spend])).toEqual([["ZZTEST usage lab", 3], ["ZZTEST usage office", 1]]);
    expect(everyone.byBuilding.map((r) => [r.label, r.spend])).toEqual([["ZZTEST_USAGE_LAB", 3], ["ZZTEST_USAGE_OFFICE", 1]]);
    // A failed run that spent is still spend.
    expect(everyone.topRuns[0]).toMatchObject({ status: "failed", spend: 3 });

    const stranger = await createEmployee({ email: "zztest.usage.stranger@phb1899.com" });
    await grantModule(stranger.id, BAS_MODULE_KEY);
    const nothing = await getReportsUsage(viewerOf(stranger), "90d", NOW);
    expect(nothing.totals).toEqual({ runs: 0, tokens: 0, spend: 0 });
    expect(nothing.runsInDatabase).toBe(0);
    expect(nothing.topRuns).toEqual([]);
  });

  it("answers the same figures on the route, with the range from the query and 30 days for anything else", async () => {
    await finishedRun(officeReport, { costUsd: 1, inputTokens: 100, outputTokens: 10, finishedAt: new Date(Date.now() - 86_400_000) });
    signedInAs(owner.entraOid!);
    const week = await data<ReportsUsage>(await usageRoute(bare("http://localhost/api/modules/bas/reports/usage?range=7d")));
    expect(week.range).toBe("7d");
    expect(week.totals.runs).toBe(1);
    const fallback = await data<ReportsUsage>(await usageRoute(bare("http://localhost/api/modules/bas/reports/usage?range=year")));
    expect(fallback.range).toBe("30d");
    const nobody = await createEmployee({ email: "zztest.usage.nobody@phb1899.com" });
    signedInAs(nobody.entraOid!);
    expect((await usageRoute(bare("http://localhost/api/modules/bas/reports/usage"))).status).toBe(404);
  });
});

describe("the safety ceiling on the route", () => {
  it("is read by any BAS user and set by a module admin only, bounded, one half or both", async () => {
    signedInAs(owner.entraOid!);
    expect(await data<{ usd: number; minutes: number }>(await readCeilingRoute())).toMatchObject({ usd: 10, minutes: 25 });
    const refused = await ceilingRoute(json({ ceilingUsd: 5 }));
    expect(refused.status).toBe(403);

    signedInAs(admin.entraOid!);
    expect((await ceilingRoute(json({}))).status).toBe(422);
    expect((await ceilingRoute(json({ ceilingUsd: 0 }))).status).toBe(422);
    expect((await ceilingRoute(json({ ceilingUsd: 1000.5 }))).status).toBe(422);
    expect((await ceilingRoute(json({ ceilingMinutes: 26 }))).status).toBe(422);
    expect((await ceilingRoute(json({ ceilingMinutes: 2.5 }))).status).toBe(422);
    expect((await ceilingRoute(json({ ceilingUsd: 5, stray: 1 }))).status).toBe(422);

    const set = await data<{ changed: boolean; ceiling: { usd: number; minutes: number; updatedBy: string | null } }>(await ceilingRoute(json({ ceilingUsd: 5.25 })));
    expect(set).toMatchObject({ changed: true, ceiling: { usd: 5.25, minutes: 25, updatedBy: admin.email } });
    const both = await data<{ changed: boolean; ceiling: { usd: number; minutes: number } }>(await ceilingRoute(json({ ceilingUsd: 7, ceilingMinutes: 10 })));
    expect(both.ceiling).toMatchObject({ usd: 7, minutes: 10 });
    const same = await data<{ changed: boolean }>(await ceilingRoute(json({ ceilingMinutes: 10 })));
    expect(same.changed).toBe(false);

    // Everyone reads the new value; the usage payload carries it too.
    signedInAs(owner.entraOid!);
    expect(await data<{ usd: number; minutes: number }>(await readCeilingRoute())).toMatchObject({ usd: 7, minutes: 10 });
    expect((await getReportsUsage(viewerOf(owner), "7d", NOW)).ceiling).toMatchObject({ usd: 7, minutes: 10 });
  });
});
