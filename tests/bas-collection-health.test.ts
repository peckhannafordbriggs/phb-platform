import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Only the session is mocked, exactly as in bas-module.test.ts. The guard, the
// wrapper, the service, the SQL and the views are all the real ones - the whole
// value of this file is that it runs the real queries against real rows.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import type { Viewer } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import {
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  clampWindowDays,
  getCollectionHealth,
} from "@/lib/modules/bas/service";
import type { CollectionHealth } from "@/lib/modules/bas/types";
import { GET as collectionHealthRoute } from "@/app/api/modules/bas/collection-health/route";
import {
  ROLES,
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
  new Request(`http://localhost/api/modules/bas/collection-health${query}`);

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

  const employee = await createEmployee({ entraOid: "oid-health" });
  await grantModule(employee.id, BAS_MODULE_KEY);
  signedInAs("oid-health");

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

/** The service's own answer, so the assertions read as domain facts. */
const health = (options?: { windowDays?: number }) =>
  getCollectionHealth(viewer, options);

describe("the five tiles", () => {
  it("counts active points, ignoring the inactive ones", async () => {
    const result = await health();

    // Grafana: count(*) FROM v_collection_health WHERE is_active.
    expect(result.totals.activePoints).toBe(5);
  });

  it("counts every reading", async () => {
    const result = await health();

    expect(result.totals.totalReadings).toBe(3);
  });

  it("counts points with no role", async () => {
    const result = await health();

    // Four of the fixture's five points carry a zztest role; one does not.
    expect(result.totals.unclassifiedPoints).toBe(1);
  });

  it("counts every risk state except ok as at risk", async () => {
    const result = await health();

    // Grafana counts data_lost, at_risk, roll_horizon_unknown and
    // never_collected in one tile. One point of the fixture is in each.
    expect(result.totals.riskCounts).toEqual({
      ok: 1,
      at_risk: 1,
      data_lost: 1,
      roll_horizon_unknown: 1,
      never_collected: 1,
    });
    expect(result.totals.pointsAtRisk).toBe(4);
  });

  it("does not let an unknown roll horizon count as ok", async () => {
    const result = await health();

    // The point with no capacity and no interval. If this ever lands in `ok`,
    // the tile goes green while the station may be destroying data.
    const unknown = result.points.find(
      (point) => point.rollHorizonHours === null,
    );

    expect(unknown?.risk).toBe("roll_horizon_unknown");
    expect(result.totals.riskCounts.ok).toBe(1);
  });

  it("measures staleness from the newest reading", async () => {
    const result = await health();

    // The newest fixture reading is five minutes old.
    expect(result.totals.minutesSinceNewestReading).not.toBeNull();
    expect(result.totals.minutesSinceNewestReading ?? 0).toBeGreaterThan(4);
    expect(result.totals.minutesSinceNewestReading ?? 0).toBeLessThan(7);
  });
});

describe("the per-point table", () => {
  // Exact match, not `includes`. "AHU-1_SupplyAirTemp" is a prefix of
  // "AHU-1_SupplyAirTempSp", and a substring match silently answers with the
  // wrong point - which is how the first draft of this file passed a test that
  // was checking nothing.
  const byName = (result: CollectionHealth, name: string) =>
    result.points.find((point) => point.pointName === `AHU-1_${name}`);

  it("computes each risk state from the view, not from the fixture", async () => {
    const result = await health();

    // Horizon is 500 x 900 = 125 h, so half is 62.5 h.
    expect(byName(result, "SupplyAirTemp")?.risk).toBe("ok"); // 5 min
    expect(byName(result, "SupplyAirTempSp")?.risk).toBe("at_risk"); // 100 h
    expect(byName(result, "FanCmd")?.risk).toBe("data_lost"); // 200 h
    expect(byName(result, "FanStatus")?.risk).toBe("never_collected"); // none
    expect(byName(result, "Unknown")?.risk).toBe("roll_horizon_unknown");
  });

  it("puts the never-collected point first and the freshest last", async () => {
    const result = await health();

    // Grafana: ORDER BY seconds_since_last_record DESC NULLS FIRST. A point we
    // have never read outranks one that is merely late.
    expect(result.points[0]?.risk).toBe("never_collected");
    expect(result.points.at(-1)?.risk).not.toBe("never_collected");
  });

  it("reports the roll horizon in hours, and null when it cannot be computed", async () => {
    const result = await health();

    expect(byName(result, "SupplyAirTemp")?.rollHorizonHours).toBeCloseTo(125, 5);
    expect(byName(result, "Unknown")?.rollHorizonHours).toBeNull();
  });

  it("carries the site, the role and the unit through", async () => {
    const result = await health();
    const sat = byName(result, "SupplyAirTemp");

    expect(sat?.siteName).toBe(SITE_NAME);
    expect(sat?.pointRole).toBe(ROLES.sat);
    expect(sat?.unit).toBe("fahrenheit");
    expect(byName(result, "Unknown")?.pointRole).toBeNull();
  });

  it("carries point ids as strings, because a bigint cannot be serialised", async () => {
    const result = await health();

    // JSON.stringify throws on a BigInt. This is the assertion that the route
    // can actually answer at all.
    expect(typeof result.points[0]?.pointId).toBe("string");
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("excludes inactive points", async () => {
    const result = await health();

    expect(result.points).toHaveLength(5);
    expect(result.points.every((point) => point.pointName.length > 0)).toBe(true);
  });
});

describe("the collector runs", () => {
  it("lists the recent runs newest first", async () => {
    const result = await health();

    expect(result.runs).toHaveLength(4);
    expect(result.runs[0]?.recordsWritten).toBe(12);
    expect(result.runs[0]?.collectorHost).toBe("ZZTEST-HOST");

    const started = result.runs.map((run) => Date.parse(run.startedAt));
    expect(started).toEqual([...started].sort((a, b) => b - a));
  });

  it("counts a run's errors without returning the payloads", async () => {
    const result = await health();

    expect(result.runs.every((run) => run.errorCount === 0)).toBe(true);
  });

  it("plots records per run against real time, not run number", async () => {
    const result = await health({ windowDays: 30 });

    expect(result.runRecords).toHaveLength(4);
    // The backfill spike after the outage. A chart that hid this would hide the
    // outage that caused it.
    expect(Math.max(...result.runRecords.map((r) => r.recordsWritten))).toBe(
      2_000,
    );
    // Epoch milliseconds, so the axis can be a time axis.
    expect(typeof result.runRecords[0]?.startedAtMs).toBe("number");
  });

  it("only plots runs inside the requested window", async () => {
    // Two of the four fixture runs are 200 h and 190 h old - outside 7 days.
    const week = await health({ windowDays: 7 });
    const month = await health({ windowDays: 30 });

    expect(week.runRecords).toHaveLength(2);
    expect(month.runRecords).toHaveLength(4);
    // The runs TABLE has no window - Grafana's panel is LIMIT 30 and nothing
    // else - so it shows all four either way.
    expect(week.runs).toHaveLength(4);
  });
});

describe("a collector silence longer than the roll horizon", () => {
  it("is reported as a gap that destroyed data", async () => {
    const result = await health({ windowDays: 30 });

    // The fixture's hole: 190 h ago to 26 h ago is 164 h, against a 125 h
    // horizon. This is the shape of the real outage - the laptop closed over a
    // weekend - and the assertion that the screen cannot render it as calm.
    expect(result.longestRunGap).not.toBeNull();
    expect(result.longestRunGap?.hours ?? 0).toBeCloseTo(164, 1);
    expect(result.longestRunGap?.rollHorizonHours ?? 0).toBeCloseTo(125, 5);
    expect(result.longestRunGap?.exceedsRollHorizon).toBe(true);
  });

  it("is not raised when the silence fits inside the horizon", async () => {
    // Inside 7 days only the last two runs survive, 6.25 hours apart.
    const result = await health({ windowDays: 7 });

    expect(result.longestRunGap?.hours ?? 0).toBeCloseTo(6.25, 2);
    expect(result.longestRunGap?.exceedsRollHorizon).toBe(false);
  });

  it("has nothing to measure when fewer than two runs are in the window", async () => {
    // One run inside 24 hours. An interval needs two, and reporting a gap of
    // zero would read as "the collector never stopped".
    const result = await health({ windowDays: 1 });

    expect(result.runRecords).toHaveLength(1);
    expect(result.longestRunGap).toBeNull();
  });
});

describe("recorded data gaps", () => {
  it("reports the gap, its cause and how many hours it cost", async () => {
    const result = await health();

    expect(result.dataGaps).toHaveLength(1);
    expect(result.dataGaps[0]?.cause).toBe("roll_overwrite");
    expect(result.dataGaps[0]?.hoursLost).toBeCloseTo(23, 1);
    expect(result.dataGaps[0]?.siteName).toBe(SITE_NAME);
  });
});

describe("the window is bounded", () => {
  it("defaults to the Grafana dashboard's seven days", async () => {
    const result = await health();

    expect(result.windowDays).toBe(DEFAULT_WINDOW_DAYS);
  });

  it("clamps anything outside the range rather than trusting it", () => {
    expect(clampWindowDays(undefined)).toBe(DEFAULT_WINDOW_DAYS);
    expect(clampWindowDays(0)).toBe(1);
    expect(clampWindowDays(-5)).toBe(1);
    expect(clampWindowDays(10_000)).toBe(MAX_WINDOW_DAYS);
    expect(clampWindowDays(Number.NaN)).toBe(DEFAULT_WINDOW_DAYS);
    expect(clampWindowDays(7.9)).toBe(7);
  });
});

describe("every figure is measured from one instant", () => {
  it("reports the observation time the whole payload was computed at", async () => {
    const before = Date.now();
    const result = await health();
    const after = Date.now();

    const observed = Date.parse(result.observedAt);

    // now() is the transaction's start time in PostgreSQL, so this is also the
    // instant the tiles, the per-point minutes and the view's roll_risk were all
    // measured from. Allow a second either side for clock skew between the
    // application and the database.
    expect(observed).toBeGreaterThan(before - 1_000);
    expect(observed).toBeLessThan(after + 1_000);
  });
});

describe("the route is behind the module grant", () => {
  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null as never);

    expect((await collectionHealthRoute(request())).status).toBe(401);
  });

  it("returns 404 - not 403 - without the grant", async () => {
    await createEmployee({ entraOid: "oid-health-nogrant" });
    signedInAs("oid-health-nogrant");

    const response = await collectionHealthRoute(request());

    expect(response.status).toBe(404);
    expect(response.status).not.toBe(403);
  });

  it("tells an ungranted caller nothing about the building data", async () => {
    await createEmployee({ entraOid: "oid-health-quiet" });
    signedInAs("oid-health-quiet");

    const raw = JSON.stringify(
      await (await collectionHealthRoute(request())).json(),
    ).toLowerCase();

    for (const leak of ["bas", "niagara", "point", "collector", "roll"]) {
      expect(raw, `the denial must not mention "${leak}"`).not.toContain(leak);
    }
  });

  it("answers the granted caller with the whole screen in one payload", async () => {
    const response = await collectionHealthRoute(request());
    const body = (await response.json()) as { data: CollectionHealth };

    expect(response.status).toBe(200);
    expect(body.data.totals.activePoints).toBe(5);
    expect(body.data.points).toHaveLength(5);
    expect(body.data.runs).toHaveLength(4);
    expect(body.data.dataGaps).toHaveLength(1);
  });

  it("rejects a window it does not serve instead of quietly serving another", async () => {
    const response = await collectionHealthRoute(request("?days=400"));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "validation_failed",
        message: "days must be a whole number between 1 and 90.",
      },
    });
  });

  it("rejects a window that is not a number", async () => {
    expect((await collectionHealthRoute(request("?days=lots"))).status).toBe(422);
  });

  it("honours a valid window", async () => {
    const response = await collectionHealthRoute(request("?days=30"));
    const body = (await response.json()) as { data: CollectionHealth };

    expect(body.data.windowDays).toBe(30);
    expect(body.data.runRecords).toHaveLength(4);
  });
});

describe("a timestamp written through Prisma survives a comparison in SQL", () => {
  /**
   * The regression test for the defect this phase found. See docs/runbook.md,
   * *Timestamps written through Prisma were four hours out*.
   *
   * Prisma's driver adapter moves a `timestamptz` as a naive wall-clock string
   * with the offset dropped, and the session timezone supplies a new one. Writes
   * gained the offset and reads lost it, so a Prisma round trip was unchanged
   * and nothing caught it - while every `now()` comparison on this screen was
   * out by four hours. `lib/db/adapter.ts` pins the session to UTC.
   *
   * The assertion has to cross the boundary in BOTH directions to have teeth: a
   * JS Date written by Prisma, compared against `now()` inside PostgreSQL. A
   * test that only wrote and read back through Prisma passes either way.
   */
  it("agrees with now() to within a second, not within four hours", async () => {
    const result = await health();

    // The fixture wrote these readings five minutes ago, from JavaScript.
    // PostgreSQL did the subtraction.
    const minutes = result.totals.minutesSinceNewestReading ?? 0;

    expect(minutes).toBeGreaterThan(4.5);
    expect(minutes).toBeLessThan(6);
  });

  it("reads the server clock back as the same instant the process sees", async () => {
    const result = await health();

    const skewMinutes = Math.abs(
      (Date.now() - Date.parse(result.observedAt)) / 60_000,
    );

    // Under a minute. Before the fix this was 240 - the machine's UTC offset -
    // and it would have been 300 in winter.
    expect(skewMinutes).toBeLessThan(1);
  });
});
