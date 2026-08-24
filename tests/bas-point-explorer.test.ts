import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Only the session is mocked. The guard, the wrapper, the service, the SQL and
// the views are real - the value of this file is that it runs the real queries
// against real rows.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import type { Viewer } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { BasError } from "@/lib/modules/bas/errors";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import {
  buildTrend,
  getPointExplorer,
  parsePointId,
} from "@/lib/modules/bas/service";
import type { PointExplorer } from "@/lib/modules/bas/types";
import { GET as pointExplorerRoute } from "@/app/api/modules/bas/point-explorer/route";
import {
  SITE_B_NAME,
  SITE_NAME,
  createHealthFixture,
  expectBasTablesEmpty,
  type HealthFixture,
} from "./bas-fixture";
import {
  createEmployee,
  disconnectDb,
  grantModule,
  resetDb,
  seedBasModule,
  seedChangeOrdersModule,
} from "./db";

const authMock = vi.mocked(auth);

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

const request = (query = "") =>
  new Request(`http://localhost/api/modules/bas/point-explorer${query}`);

let fixture: HealthFixture;
let viewer: Viewer;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetBasAvailabilityCache();

  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();
  await expectBasTablesEmpty();
  fixture = await createHealthFixture();

  const employee = await createEmployee({ entraOid: "oid-points" });
  await grantModule(employee.id, BAS_MODULE_KEY);
  signedInAs("oid-points");

  viewer = {
    id: employee.id,
    email: employee.email,
    firstName: employee.firstName,
    lastName: employee.lastName,
    profileCompleted: true,
    isPlatformAdmin: false,
  };
});

afterEach(async () => {
  await fixture.cleanup();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDb();
});

/** The fixture's supply-air-temp point: three readings, 5 / 20 / 35 min old. */
const explore = (options?: { windowDays?: number; pointId?: bigint }) =>
  getPointExplorer(viewer, {
    windowDays: options?.windowDays ?? 7,
    pointId: options?.pointId ?? fixture.sat,
  });

describe("the point picker", () => {
  it("offers every active point, and never the inactive ones", async () => {
    const result = await getPointExplorer(viewer, {});

    // Five active in site A, two in site B. The fixture creates no inactive
    // points, so this is the full active set.
    expect(result.points).toHaveLength(7);
  });

  it("scopes the picker to the building filter", async () => {
    const a = await getPointExplorer(viewer, { siteId: fixture.siteId });
    const b = await getPointExplorer(viewer, { siteId: fixture.siteBId });

    expect(a.points).toHaveLength(5);
    expect(b.points).toHaveLength(2);
    expect(new Set(a.points.map((p) => p.siteName))).toEqual(
      new Set([SITE_NAME]),
    );
    expect(new Set(b.points.map((p) => p.siteName))).toEqual(
      new Set([SITE_B_NAME]),
    );
  });

  it("orders stably, with a tie-break past the name", async () => {
    // display_name is not unique - only (station_id, niagara_history_name) is -
    // so two points can share one. Without the point_id tie-break the picker
    // reorders between refreshes while every entry stays correct. Same class of
    // bug as the per-point table's, found by the oracle on Collection Health.
    const first = await getPointExplorer(viewer, {});
    const second = await getPointExplorer(viewer, {});

    expect(second.points.map((p) => p.pointId)).toEqual(
      first.points.map((p) => p.pointId),
    );

    // Grouped by building, not interleaved - the other half of ORDER BY
    // site_name, point_name, point_id.
    //
    // Deliberately NOT asserted against a JavaScript sort. PostgreSQL orders by
    // the database collation and `localeCompare` does not agree with it about
    // underscores and hyphens, so that comparison tests the two collations
    // against each other rather than testing this query. See docs/runbook.md,
    // *Deployment: check this when the Azure database is created*.
    const sites = first.points.map((p) => p.siteName);
    const firstIndex = new Map<string, number>();
    sites.forEach((site, i) => {
      if (!firstIndex.has(site)) firstIndex.set(site, i);
    });
    for (const [site, start] of firstIndex) {
      const last = sites.lastIndexOf(site);
      const run = sites.slice(start, last + 1);
      expect(run.every((s) => s === site), `${site} is interleaved`).toBe(true);
    }
  });

  it("selects the first point when none is asked for", async () => {
    const result = await getPointExplorer(viewer, {});

    expect(result.selectedPoint).not.toBeNull();
    expect(result.selectedPoint?.pointId).toBe(result.points[0]?.pointId);
  });

  it("carries the unit through, including its absence", async () => {
    const result = await explore();

    expect(result.selectedPoint?.unit).toBe("fahrenheit");

    const unitless = await explore({ pointId: fixture.fanCmd });
    expect(unitless.selectedPoint?.unit).toBeNull();
  });
});

describe("the summary tiles", () => {
  it("counts readings in the window", async () => {
    const result = await explore();

    // Three readings, all inside seven days.
    expect(result.stats.readings).toBe(3);
  });

  it("keeps null RECORDS apart from missing rows", async () => {
    // The distinction docs/08 insists on. The fixture's sat point has three
    // rows, all carrying a value; fanStatus has no rows at all. Those are
    // different states and the tile must not merge them.
    const withRows = await explore();
    const withoutRows = await explore({ pointId: fixture.fanStatus });

    expect(withRows.stats.readings).toBe(3);
    expect(withRows.stats.nullRecords).toBe(0);

    expect(withoutRows.stats.readings).toBe(0);
    expect(withoutRows.stats.nullRecords).toBe(0);

    // Zero nulls means "every row had a value". Zero readings means "there were
    // no rows". Both report 0 nulls and they mean opposite things, which is why
    // the tile shows both numbers rather than one.
    expect(withoutRows.stats.readings).not.toBe(withRows.stats.readings);
  });

  it("counts a genuinely null-valued row as a reading, not as a gap", async () => {
    const { testDb } = await import("./db");
    await testDb.basReading.create({
      data: { pointId: fixture.sat, ts: new Date(), valueNum: null },
    });

    const result = await explore();

    // Four rows now, one of which carries no value at all.
    expect(result.stats.readings).toBe(4);
    expect(result.stats.nullRecords).toBe(1);
    // It is in the series with a null value - the line cannot cross it - but it
    // is NOT a synthetic break, because a record exists here.
    const nulls = result.trend.filter((p) => p.value === null);
    expect(nulls.some((p) => !p.isBreak)).toBe(true);
  });

  it("computes distinct values, average, min and max", async () => {
    const result = await explore();

    // 55.0, 56.5, 58.0 - three distinct values.
    expect(result.stats.distinctValues).toBe(3);
    expect(result.stats.minimum).toBeCloseTo(55, 2);
    expect(result.stats.maximum).toBeCloseTo(58, 2);
    expect(result.stats.average).toBeCloseTo(56.5, 2);
  });

  it("reports the latest value without windowing it", async () => {
    // Grafana's Latest panel carries no $__timeFilter, and it is right not to:
    // a window with no data in it does not make the last known value untrue.
    const narrow = await explore({ windowDays: 1 });

    expect(narrow.stats.latest).not.toBeNull();
    expect(narrow.stats.latestAt).not.toBeNull();
  });

  it("reports nothing rather than zero for a point with no readings", async () => {
    const result = await explore({ pointId: fixture.fanStatus });

    // Null, not 0. An average of zero is a claim about the data; there is none.
    expect(result.stats.average).toBeNull();
    expect(result.stats.minimum).toBeNull();
    expect(result.stats.maximum).toBeNull();
    expect(result.stats.latest).toBeNull();
    expect(result.stats.distinctValues).toBe(0);
  });
});

describe("the trend breaks across gaps rather than crossing them", () => {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

  it("inserts no break for readings at the expected cadence", () => {
    // Five-minute interval, samples five minutes apart.
    const rows = [30, 25, 20, 15, 10].map((m) => ({
      ts: at(m),
      value_num: 55,
    }));

    const { trend, gaps } = buildTrend(rows, 300);

    expect(gaps).toHaveLength(0);
    expect(trend.filter((p) => p.isBreak)).toHaveLength(0);
    expect(trend).toHaveLength(5);
  });

  it("breaks the line where readings stop, and reports the gap", () => {
    // The shape of the real hole: readings, then nothing for 22.7 hours, then
    // readings again. A line drawn across that asserts a steady temperature
    // through data the station destroyed.
    const rows = [
      { ts: at(24 * 60 + 40), value_num: 55 },
      { ts: at(24 * 60 + 35), value_num: 55.2 },
      { ts: at(10), value_num: 61 },
      { ts: at(5), value_num: 61.2 },
    ];

    const { trend, gaps } = buildTrend(rows, 300);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.hours ?? 0).toBeCloseTo((24 * 60 + 25) / 60, 1);

    const breaks = trend.filter((p) => p.isBreak);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]?.value).toBeNull();

    // The break sits BETWEEN the two real samples, so neither is displaced.
    const index = trend.findIndex((p) => p.isBreak);
    expect(trend[index - 1]?.value).toBe(55.2);
    expect(trend[index + 1]?.value).toBe(61);
  });

  it("scales the threshold to the point's own collection interval", () => {
    // Twenty minutes between samples is normal for a point logged every fifteen
    // minutes and a hole for one logged every minute.
    const rows = [
      { ts: at(40), value_num: 1 },
      { ts: at(20), value_num: 2 },
    ];

    expect(buildTrend(rows, 900).gaps).toHaveLength(0);
    expect(buildTrend(rows, 60).gaps).toHaveLength(1);
  });

  it("still breaks when the interval is unknown", () => {
    // capacity and collection_interval_s not filled in from Workbench. The
    // floor applies rather than never breaking.
    const rows = [
      { ts: at(120), value_num: 1 },
      { ts: at(5), value_num: 2 },
    ];

    expect(buildTrend(rows, null).gaps).toHaveLength(1);
  });

  it("has nothing to break on an empty or single-sample series", () => {
    expect(buildTrend([], 300).gaps).toHaveLength(0);
    expect(buildTrend([{ ts: at(1), value_num: 1 }], 300).gaps).toHaveLength(0);
  });

  it("finds the fixture's own gap end to end, through the database", async () => {
    // The fixture writes sat readings 5, 20 and 35 minutes ago - no gap - and
    // the point has a 900 s interval, so the threshold is 45 minutes.
    const tight = await explore();
    expect(tight.trendGaps).toHaveLength(0);

    const { testDb } = await import("./db");
    await testDb.basReading.create({
      data: {
        pointId: fixture.sat,
        ts: new Date(Date.now() - 30 * 60 * 60 * 1000),
        valueNum: 50,
      },
    });

    const withGap = await explore();

    expect(withGap.trendGaps).toHaveLength(1);
    expect(withGap.trendGaps[0]?.hours ?? 0).toBeGreaterThan(29);
    expect(withGap.trend.filter((p) => p.isBreak)).toHaveLength(1);
  });

  it("orders the series oldest first, so a chart reads left to right", async () => {
    const result = await explore();
    const stamps = result.trend.map((p) => p.tsMs);

    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
  });
});

describe("recorded gaps are per point", () => {
  it("returns only this point's gaps, with the cause", async () => {
    const onGap = await explore({ pointId: fixture.sat });
    const withoutGap = await explore({ pointId: fixture.satSp });

    expect(onGap.dataGaps).toHaveLength(1);
    expect(onGap.dataGaps[0]?.cause).toBe("roll_overwrite");
    expect(withoutGap.dataGaps).toHaveLength(0);
  });

  it("is separate from the gaps derived from the readings", async () => {
    // bas_data_gaps says "we know we missed this, and why". trendGaps says "the
    // chart has nothing to draw here". A hole can exist without being recorded,
    // which is exactly the case worth seeing, so they are not merged.
    const result = await explore();

    expect(result.dataGaps).toHaveLength(1);
    expect(result.trendGaps).toHaveLength(0);
  });
});

describe("a point the employee cannot see", () => {
  it("is refused rather than silently swapped for the first one", async () => {
    // A silent swap would render one point's readings under another point's name
    // in the URL - wrong, and it looks fine.
    await expect(
      getPointExplorer(viewer, { pointId: 9_999_999n }),
    ).rejects.toThrow(BasError);
  });

  it("is refused when it belongs to a building outside the filter", async () => {
    // Site B's point exists and is active, but not within site A's filter.
    await expect(
      getPointExplorer(viewer, {
        siteId: fixture.siteId,
        pointId: fixture.bOk,
      }),
    ).rejects.toThrow(BasError);
  });

  it("answers 404 through the route", async () => {
    const response = await pointExplorerRoute(request("?point=9999999"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: "That point is not available." },
    });
  });

  it("rejects a point id that is not a number", async () => {
    expect((await pointExplorerRoute(request("?point=1;DROP"))).status).toBe(404);
    expect(() => parsePointId("nonsense")).toThrow(BasError);
  });

  it("reads a point id past 2^53 without rounding it", () => {
    expect(parsePointId("9007199254740993")).toBe(9_007_199_254_740_993n);
  });

  it("treats an absent or empty point as 'the first one'", () => {
    expect(parsePointId(undefined)).toBeNull();
    expect(parsePointId("")).toBeNull();
    expect(parsePointId("  ")).toBeNull();
  });
});

describe("the route is behind the module grant", () => {
  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null as never);

    expect((await pointExplorerRoute(request())).status).toBe(401);
  });

  it("returns 404 - not 403 - without the grant", async () => {
    await createEmployee({ entraOid: "oid-points-nogrant" });
    signedInAs("oid-points-nogrant");

    const response = await pointExplorerRoute(request());

    expect(response.status).toBe(404);
    expect(response.status).not.toBe(403);
  });

  it("tells an ungranted caller nothing about the building data", async () => {
    await createEmployee({ entraOid: "oid-points-quiet" });
    signedInAs("oid-points-quiet");

    const raw = JSON.stringify(
      await (await pointExplorerRoute(request())).json(),
    ).toLowerCase();

    for (const leak of ["bas", "niagara", "point", "reading", "trend"]) {
      expect(raw, `the denial must not mention "${leak}"`).not.toContain(leak);
    }
  });

  it("answers the granted caller with the whole screen in one payload", async () => {
    const response = await pointExplorerRoute(
      request(`?point=${fixture.sat}&days=7`),
    );
    const body = (await response.json()) as { data: PointExplorer };

    expect(response.status).toBe(200);
    expect(body.data.selectedPoint?.pointId).toBe(fixture.sat.toString());
    expect(body.data.stats.readings).toBe(3);
    expect(body.data.trend.length).toBeGreaterThan(0);
    expect(body.data.sites).toHaveLength(2);
  });

  it("carries ids as strings, because a bigint cannot be serialised", async () => {
    const result = await explore();

    expect(typeof result.selectedPoint?.pointId).toBe("string");
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("rejects a window it does not serve", async () => {
    expect((await pointExplorerRoute(request("?days=400"))).status).toBe(422);
  });
});

describe("every figure is measured from one instant", () => {
  it("reports the observation time the payload was computed at", async () => {
    const before = Date.now();
    const result = await explore();
    const after = Date.now();

    const observed = Date.parse(result.observedAt);

    expect(observed).toBeGreaterThan(before - 1_000);
    expect(observed).toBeLessThan(after + 1_000);
  });
});
