import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import {
  REPORTS_PAGE_SIZE,
  describePageRange,
  pageWindow,
  parseIdFilter,
  parsePage,
} from "@/lib/modules/bas/reports/paging";
import { listRuns, type RunsList } from "@/lib/modules/bas/reports/runs-service";
import { listReports } from "@/lib/modules/bas/reports/service";
import type { ReportsList } from "@/lib/modules/bas/reports/types";
import { GET as runsRoute } from "@/app/api/modules/bas/reports/runs/route";
import { GET as reportsRoute } from "@/app/api/modules/bas/reports/route";
import { RunsFilterBar, RunsTable, hasRunFilters, lostRowsSentence, runsQueryFrom } from "@/app/(modules)/bas/reports-generated";
import { ReportsTable } from "@/app/(modules)/bas/reports-list";
import { ListPager } from "@/app/(modules)/bas/reports-pager";
import { runsQueryString } from "@/app/(modules)/bas/reports-client";
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
 * Paging the Reports runs list and the Scheduled list (2026-11-23): 25 rows
 * a page, newest first with an id tiebreak, "1–25 of N" with Previous and
 * Next, a page past the end served as the last page, and - on the runs -
 * Report, Building and Status filters whose options do not narrow with the
 * choice. Against the real test database, through the service and the
 * routes, and the pager and filter bar rendered.
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
async function dataOf<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: T }).data;
}

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

describe("the paging rules", () => {
  it("serves 25 a page, holds a page past the end to the last one, and words the range with an en dash", () => {
    expect(REPORTS_PAGE_SIZE).toBe(25);
    expect(pageWindow(1, 30)).toEqual({ page: 1, pageSize: 25, offset: 0, expectedRows: 25, lastPage: 2 });
    expect(pageWindow(2, 30)).toEqual({ page: 2, pageSize: 25, offset: 25, expectedRows: 5, lastPage: 2 });
    expect(pageWindow(9, 30).page).toBe(2);
    expect(pageWindow(0, 30).page).toBe(1);
    expect(pageWindow(3, 0)).toEqual({ page: 1, pageSize: 25, offset: 0, expectedRows: 0, lastPage: 1 });
    expect(pageWindow(2, 50)).toMatchObject({ page: 2, expectedRows: 25, lastPage: 2 });
    expect(describePageRange(1, 25, 30)).toBe("1–25 of 30");
    expect(describePageRange(2, 25, 30)).toBe("26–30 of 30");
    expect(describePageRange(1, 25, 7)).toBe("1–7 of 7");
    expect(describePageRange(1, 25, 0)).toBe("0 of 0");
  });

  it("reads a page and an id from a query string, and anything else as the default", () => {
    expect(parsePage("2")).toBe(2);
    expect(parsePage(null)).toBe(1);
    for (const bad of ["0", "-3", "x", ""]) expect(parsePage(bad), bad).toBe(1);
    expect(parsePage(3)).toBe(3);
    expect(parseIdFilter("42")).toBe("42");
    expect(parseIdFilter("4x")).toBeNull();
    expect(parseIdFilter(null)).toBeNull();
  });

  it("writes the URL's query in one order, leaves out what is unset and page 1, and reads it back", () => {
    expect(runsQueryString(null)).toBe("");
    expect(runsQueryString({ page: "1" })).toBe("");
    expect(runsQueryString({ status: "failed", page: 3, report: "7", building: null })).toBe("?report=7&status=failed&page=3");
    const back = runsQueryFrom(new URLSearchParams("?report=7&status=failed&page=3"));
    expect(back).toEqual({ page: "3", report: "7", building: null, status: "failed" });
    expect(runsQueryString(back)).toBe("?report=7&status=failed&page=3");
    expect(hasRunFilters({ report: null, building: null, status: null })).toBe(false);
    expect(hasRunFilters({ report: null, building: "3", status: null })).toBe(true);
  });

  it("the guard's sentence: the old one when everything fits on one page, a page's own otherwise", () => {
    expect(lostRowsSentence(3, 4, 4, "reports")).toBe("This list shows 3 of the 4 reports you may see.");
    expect(lostRowsSentence(24, 25, 30, "runs")).toBe("This page shows 24 of the 25 runs it should, of 30 in all.");
  });
});

// ---------------------------------------------------------------------------
// The database, the service and the routes
// ---------------------------------------------------------------------------

let owner: Awaited<ReturnType<typeof createEmployee>>;
let other: Awaited<ReturnType<typeof createEmployee>>;
let admin: Awaited<ReturnType<typeof createEmployee>>;
let office: bigint;
let lab: bigint;

async function seedBuildings() {
  const org = await testDb.basOrg.create({ data: { name: "ZZTEST_PAGE_ORG" } });
  const project = await testDb.basProject.create({ data: { orgId: org.orgId, name: "ZZTEST_PAGE_PROJECT" } });
  office = (await testDb.basSite.create({ data: { orgId: org.orgId, projectId: project.projectId, name: "ZZTEST_PAGE_OFFICE", timezone: NY } })).siteId;
  lab = (await testDb.basSite.create({ data: { orgId: org.orgId, projectId: project.projectId, name: "ZZTEST_PAGE_LAB", timezone: NY } })).siteId;
}

async function dropBuildings() {
  await testDb.basSite.deleteMany({ where: { name: { in: ["ZZTEST_PAGE_OFFICE", "ZZTEST_PAGE_LAB"] } } });
  await testDb.basProject.deleteMany({ where: { name: "ZZTEST_PAGE_PROJECT" } });
  await testDb.basOrg.deleteMany({ where: { name: "ZZTEST_PAGE_ORG" } });
}

async function report(name: string, siteId: bigint, by = owner, createdAt = new Date(), deleted = false): Promise<bigint> {
  const row = await testDb.basReportDefinition.create({
    data: {
      ownerEmployeeId: by.id,
      name,
      siteId,
      scheduleKind: "weekly",
      scheduleParams: { weekdays: [1] },
      timeOfDay: "06:00",
      createdAt,
      ...(deleted ? { deletedAt: new Date(), deletedByEmployeeId: by.id } : {}),
    },
    select: { reportId: true },
  });
  return row.reportId;
}

async function run(reportId: bigint, createdAt: Date, status: "succeeded" | "partial" | "failed" | "queued" = "succeeded", deleted = false): Promise<bigint> {
  const finished = status !== "queued";
  const row = await testDb.basReportRun.create({
    data: {
      reportId,
      status,
      trigger: "scheduled",
      periodStart: new Date(createdAt.getTime() - 7 * DAY),
      periodEnd: createdAt,
      timezone: NY,
      budgetUsd: "10.00",
      reportJson: status === "succeeded" || status === "partial" ? { summary: { status: "Good" } } : undefined,
      finishedAt: finished ? createdAt : null,
      error: status === "failed" ? "ZZTEST boom" : null,
      partialReason: status === "partial" ? "ZZTEST partial" : null,
      createdAt,
      ...(deleted ? { deletedAt: new Date(), deletedBy: "person", deletedByEmployeeId: owner.id } : {}),
    },
    select: { runId: true },
  });
  return row.runId;
}

const runsUrl = (query = "") => new Request(`http://localhost/api/modules/bas/reports/runs${query}`);
const reportsUrl = (query = "") => new Request(`http://localhost/api/modules/bas/reports${query}`);

describe("paging and filtering, against the database", () => {
  beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    resetBasAvailabilityCache();
    await resetDb();
    await dropBuildings();
    await seedChangeOrdersModule();
    await seedBasModule();
    owner = await createEmployee({ email: "zztest.page.owner@phb1899.com" });
    other = await createEmployee({ email: "zztest.page.other@phb1899.com" });
    admin = await createEmployee({ email: "zztest.page.admin@phb1899.com" });
    for (const e of [owner, other, admin]) await grantModule(e.id, BAS_MODULE_KEY);
    await grantModuleAdmin(admin.id, BAS_MODULE_KEY);
    await seedBuildings();
  });

  afterAll(async () => {
    await resetDb();
    await dropBuildings();
    await disconnectDb();
  });

  it("the runs list is 25 a page, newest first; runs that share a timestamp never repeat or vanish across the page boundary", async () => {
    const weekly = await report("ZZTEST page weekly", office);
    const base = Date.now() - 100 * DAY;
    const ids: bigint[] = [];
    // Twenty with their own instants, then ten in ONE instant, straddling
    // the boundary between rows 25 and 26 once sorted newest first.
    for (let i = 0; i < 20; i += 1) ids.push(await run(weekly, new Date(base + i * 60_000)));
    const tie = new Date(base + 30 * 60_000);
    for (let i = 0; i < 10; i += 1) ids.push(await run(weekly, tie));

    const first = await listRuns(viewerOf(owner), { page: 1 });
    const second = await listRuns(viewerOf(owner), { page: "2" });
    expect([first.runsInDatabase, first.page, first.pageSize, first.runs.length]).toEqual([30, 1, 25, 25]);
    expect([second.runsInDatabase, second.page, second.runs.length]).toEqual([30, 2, 5]);
    // Newest first, id descending inside the tie, and nothing twice or missing.
    const order = [...first.runs, ...second.runs].map((r) => BigInt(r.runId));
    const expected = [...ids.slice(20).sort((a, b) => Number(b - a)), ...ids.slice(0, 20).reverse()];
    expect(order).toEqual(expected);
    expect(new Set(order).size).toBe(30);

    // A page past the end is the last page; nonsense is page 1.
    expect((await listRuns(viewerOf(owner), { page: 7 })).page).toBe(2);
    expect((await listRuns(viewerOf(owner), { page: "x" })).page).toBe(1);

    // The same through the route.
    signedInAs(owner.entraOid!);
    const routed = await dataOf<RunsList>(await runsRoute(runsUrl("?page=2")));
    expect(routed.runs.map((r) => r.runId)).toEqual(second.runs.map((r) => r.runId));
    expect(routed).toMatchObject({ page: 2, pageSize: 25, runsInDatabase: 30 });

    // Rendered: the range and the ends of the pager.
    const one = renderToStaticMarkup(createElement(RunsTable, { data: first, onPage: () => undefined }));
    expect(one).toContain("1–25 of 30");
    expect(one).toMatch(/disabled=""[^>]*data-testid="list-pager-previous"/);
    expect(one).not.toMatch(/disabled=""[^>]*data-testid="list-pager-next"/);
    const two = renderToStaticMarkup(createElement(RunsTable, { data: second, onPage: () => undefined }));
    expect(two).toContain("26–30 of 30");
    expect(two).toMatch(/disabled=""[^>]*data-testid="list-pager-next"/);
    expect(two).not.toMatch(/disabled=""[^>]*data-testid="list-pager-previous"/);
    expect(two).not.toContain('role="alert"');
  });

  it("the runs list filters by report, building and status, and the options are every report and building with a run on the list", async () => {
    const weekly = await report("ZZTEST page weekly", office);
    const daily = await report("ZZTEST page daily", lab);
    const gone = await report("ZZTEST page retired", lab, owner, new Date(), true);
    const onlyDeletedRuns = await report("ZZTEST page emptied", office);
    const t = (n: number) => new Date(Date.now() - n * 3_600_000);
    for (let i = 0; i < 6; i += 1) await run(weekly, t(i), i % 3 === 0 ? "failed" : "succeeded");
    for (let i = 0; i < 4; i += 1) await run(daily, t(10 + i), i === 0 ? "partial" : "succeeded");
    await run(gone, t(20));
    await run(gone, t(21), "failed");
    await run(onlyDeletedRuns, t(22), "succeeded", true);

    const all = await listRuns(viewerOf(owner));
    expect(all.runsInDatabase).toBe(12);
    expect(all.filters).toEqual({ report: null, building: null, status: null });
    // Options: the deleted report says so; a report whose only runs are in Recently deleted is not offered.
    expect(all.options.reports).toEqual([
      { reportId: daily.toString(), name: "ZZTEST page daily", deleted: false },
      { reportId: gone.toString(), name: "ZZTEST page retired", deleted: true },
      { reportId: weekly.toString(), name: "ZZTEST page weekly", deleted: false },
    ]);
    expect(all.options.buildings).toEqual([
      { siteId: lab.toString(), name: "ZZTEST_PAGE_LAB" },
      { siteId: office.toString(), name: "ZZTEST_PAGE_OFFICE" },
    ]);

    const byReport = await listRuns(viewerOf(owner), { report: daily.toString() });
    expect(byReport.runsInDatabase).toBe(4);
    expect(new Set(byReport.runs.map((r) => r.reportId))).toEqual(new Set([daily.toString()]));
    const byBuilding = await listRuns(viewerOf(owner), { building: lab.toString() });
    expect(byBuilding.runsInDatabase).toBe(6);
    expect(new Set(byBuilding.runs.map((r) => r.buildingName))).toEqual(new Set(["ZZTEST_PAGE_LAB"]));
    const failed = await listRuns(viewerOf(owner), { status: "failed" });
    expect(failed.runsInDatabase).toBe(3);
    expect(failed.runs.every((r) => r.status === "failed")).toBe(true);
    const combined = await listRuns(viewerOf(owner), { building: lab.toString(), status: "failed" });
    expect(combined.runs.map((r) => r.reportName)).toEqual(["ZZTEST page retired"]);
    // The options do not narrow with the choice.
    expect(combined.options).toEqual(all.options);
    // An unreadable filter is no filter, and the response says so.
    const nonsense = await listRuns(viewerOf(owner), { status: "exploded", report: "x1" });
    expect(nonsense.filters).toEqual({ report: null, building: null, status: null });
    expect(nonsense.runsInDatabase).toBe(12);

    // Through the route, filters and page together.
    signedInAs(owner.entraOid!);
    const routed = await dataOf<RunsList>(await runsRoute(runsUrl(`?building=${office}&status=succeeded`)));
    expect(routed.runsInDatabase).toBe(4);
    expect(routed.filters).toEqual({ report: null, building: office.toString(), status: "succeeded" });

    // Nothing matches: its own empty state, not "no reports have been generated".
    const none = await listRuns(viewerOf(owner), { report: daily.toString(), status: "failed" });
    expect(none.runsInDatabase).toBe(0);
    const empty = renderToStaticMarkup(createElement(RunsTable, { data: none, onClearFilters: () => undefined }));
    expect(empty).toContain("No runs match these filters");
    expect(empty).toContain("runs-clear-filters");
    expect(empty).not.toContain("No reports have been generated yet");

    // The bar shows what is chosen, a deleted report labelled.
    const bar = renderToStaticMarkup(createElement(RunsFilterBar, { data: await listRuns(viewerOf(owner), { report: gone.toString() }) }));
    expect(bar).toContain("ZZTEST page retired (schedule deleted)");
    expect(bar).toContain("All buildings");
    expect(bar).toContain("All statuses");
  });

  it("paging and filters keep the run's visibility: another BAS user sees nothing, a module admin sees every report's", async () => {
    const mine = await report("ZZTEST page mine", office);
    const theirs = await report("ZZTEST page admin's", lab, admin);
    for (let i = 0; i < 3; i += 1) await run(mine, new Date(Date.now() - i * 60_000));
    await run(theirs, new Date());

    expect(await listRuns(viewerOf(other))).toMatchObject({ runs: [], runsInDatabase: 0, options: { reports: [], buildings: [] } });
    // A filter naming someone else's report finds nothing for the owner.
    expect((await listRuns(viewerOf(owner), { report: theirs.toString() })).runsInDatabase).toBe(0);
    const everything = await listRuns(viewerOf(admin));
    expect(everything.runsInDatabase).toBe(4);
    expect(everything.options.reports.map((r) => r.name)).toEqual(["ZZTEST page admin's", "ZZTEST page mine"]);
  });

  it("the Scheduled list is 25 a page, newest first, never a deleted report, and a page past the end is the last", async () => {
    const base = Date.now() - 50 * DAY;
    const ids: bigint[] = [];
    for (let i = 0; i < 22; i += 1) ids.push(await report(`ZZTEST page report ${String(i).padStart(2, "0")}`, office, owner, new Date(base + i * 60_000)));
    // Eight made in one instant, across the boundary.
    const tie = new Date(base + 60 * 60_000);
    for (let i = 0; i < 8; i += 1) ids.push(await report(`ZZTEST page tied ${i}`, lab, owner, tie));
    await report("ZZTEST page deleted", office, owner, new Date(), true);

    const first = await listReports(viewerOf(owner), 1);
    const second = await listReports(viewerOf(owner), "2");
    expect([first.reportsInDatabase, first.page, first.pageSize, first.reports.length]).toEqual([30, 1, 25, 25]);
    expect([second.page, second.reports.length]).toEqual([2, 5]);
    const order = [...first.reports, ...second.reports].map((r) => BigInt(r.reportId));
    expect(order).toEqual([...ids.slice(22).sort((a, b) => Number(b - a)), ...ids.slice(0, 22).reverse()]);
    expect([...first.reports, ...second.reports].some((r) => r.name === "ZZTEST page deleted")).toBe(false);
    expect((await listReports(viewerOf(owner), 9)).page).toBe(2);

    signedInAs(owner.entraOid!);
    const routed = await dataOf<ReportsList>(await reportsRoute(reportsUrl("?page=2")));
    expect(routed).toMatchObject({ page: 2, pageSize: 25, reportsInDatabase: 30 });
    expect(routed.reports.map((r) => r.reportId)).toEqual(second.reports.map((r) => r.reportId));

    const html = renderToStaticMarkup(createElement(ReportsTable, { data: first, onPage: () => undefined }));
    expect(html).toContain("1–25 of 30");
    expect(html).toMatch(/disabled=""[^>]*data-testid="list-pager-previous"/);
    expect(html).not.toContain('role="alert"');
    // A page that lost a row says so in the page's own words.
    const short = renderToStaticMarkup(createElement(ReportsTable, { data: { ...first, reports: first.reports.slice(1) } }));
    expect(short).toContain("This page shows 24 of the 25 reports it should, of 30 in all.");
  });
});

describe("the pager, rendered", () => {
  it("draws nothing for an empty list, and both buttons greyed on a single page", () => {
    expect(renderToStaticMarkup(createElement(ListPager, { page: 1, pageSize: 25, total: 0, label: "Runs pages", onPage: () => undefined }))).toBe("");
    const single = renderToStaticMarkup(createElement(ListPager, { page: 1, pageSize: 25, total: 7, label: "Runs pages", onPage: () => undefined }));
    expect(single).toContain("1–7 of 7");
    expect(single).toContain('aria-label="Runs pages"');
    expect(single.match(/disabled=""/g)).toHaveLength(2);
  });
});
