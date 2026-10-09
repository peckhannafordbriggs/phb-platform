import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Session } from "next-auth";

/**
 * The table never serves bucketed data.
 *
 * Over REAL readings (`points_RoomT`, 7,831 rows - see bas-live-fixture.ts)
 * with the chart's raw cap lowered to 2,000, the chart draws about 1,600
 * thirty-minute averages. The table and the CSV, asked for the very instants
 * the chart's response carries, come back with every one of the 7,600-odd
 * readings behind them - the same count, the same timestamps, the same
 * float32 values as the fixture file, in no way averaged. A fixture where
 * bucketed and raw would differ, which is the only fixture that can tell
 * the two apart.
 */

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import type { Viewer } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { getPointExplorer } from "@/lib/modules/bas/service";
import { exportPointReadings, getPointReadings } from "@/lib/modules/bas/readings";
import {
  ROOM_T,
  createLiveFixture,
  readingsBetween,
  type LiveFixture,
} from "./bas-live-fixture";
import {
  createEmployee,
  disconnectDb,
  grantModule,
  resetDb,
  seedBasModule,
  seedChangeOrdersModule,
} from "./db";

const authMock = vi.mocked(auth);

let fixture: LiveFixture;
let viewer: Viewer;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetBasAvailabilityCache();

  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();
  fixture = await createLiveFixture();

  const employee = await createEmployee({ entraOid: "oid-raw" });
  await grantModule(employee.id, BAS_MODULE_KEY);
  authMock.mockResolvedValue({
    entraOid: "oid-raw",
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);

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

describe("the chart is bucketed and the table is not", () => {
  const RANGE = { from: "2026-08-18", to: "2026-09-21" };

  it("every raw reading, by timestamp and by value, against the file", async () => {
    const chart = await getPointExplorer(viewer, {
      pointId: fixture.roomT,
      range: RANGE,
      maxRawTrendPoints: 2000,
    });
    expect(chart.sampling.kind).toBe("bucketed");
    if (chart.sampling.kind !== "bucketed") throw new Error("unreachable");
    expect(chart.sampling.buckets).toBeLessThan(chart.stats.readings);

    // The instants the chart's response carries, passed back exactly.
    const from = chart.range.from;
    const to = chart.range.to;
    const raw = readingsBetween(ROOM_T, Date.parse(from), Date.parse(to)).sort(
      (a, b) => b[0] - a[0],
    );
    expect(raw.length).toBe(chart.stats.readings);
    expect(raw.length).toBeGreaterThan(chart.sampling.buckets);

    // Walk every page. The pages together are the file.
    const pageSize = 2000;
    const first = await getPointReadings(viewer, {
      pointId: fixture.roomT,
      from,
      to,
      pageSize,
    });
    expect(first.total).toBe(raw.length);
    const rows = [...first.rows];
    for (let p = 2; p <= first.pages; p++) {
      const next = await getPointReadings(viewer, {
        pointId: fixture.roomT,
        from,
        to,
        page: p,
        pageSize,
      });
      rows.push(...next.rows);
    }
    expect(rows).toHaveLength(raw.length);
    expect(rows.map((r) => Date.parse(r.ts))).toEqual(raw.map(([ms]) => ms));
    expect(rows.map((r) => r.valueNum)).toEqual(raw.map(([, value]) => value));

    // The -40 fault of 24 August is a row, as it is in the file - not the
    // 4-degree day-average a bucketed table would have shown.
    const fault = rows.find((r) => r.valueNum === -40);
    expect(fault).toBeDefined();

    // The table's values are readings. A bucket's average is not, unless it
    // happens to coincide with one; the chart's trend here is the averages,
    // and most of them are not in the raw set.
    const rawValues = new Set(raw.map(([, value]) => value));
    const averages = chart.trend.filter((t) => !t.isBreak && t.value !== null);
    const coincidences = averages.filter((t) => rawValues.has(t.value)).length;
    expect(coincidences).toBeLessThan(averages.length);
  });

  it("the CSV holds the same rows, one line each", async () => {
    const chart = await getPointExplorer(viewer, {
      pointId: fixture.roomT,
      range: RANGE,
      maxRawTrendPoints: 2000,
    });
    const job = await exportPointReadings(viewer, {
      pointId: fixture.roomT,
      from: chart.range.from,
      to: chart.range.to,
    });
    expect(job.total).toBe(chart.stats.readings);
    expect(job.exported).toBe(chart.stats.readings);

    let text = "";
    for await (const chunk of job.chunks()) text += chunk;
    const lines = text.split("\r\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(chart.stats.readings + 1);

    const raw = readingsBetween(ROOM_T, Date.parse(chart.range.from), Date.parse(chart.range.to))
      .sort((a, b) => b[0] - a[0]);
    const values = lines.slice(1).map((line) => Number(line.split(",")[1]));
    expect(values).toEqual(raw.map(([, value]) => value));
  });
});

describe("the readings path has no bucket in it", () => {
  it("imports nothing from the chart's downsampler", () => {
    const source = readFileSync(
      path.join(process.cwd(), "lib", "modules", "bas", "readings.ts"),
      "utf8",
    );
    const body = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(body).not.toMatch(/from "\.\/range"/);
    expect(body).not.toContain("MAX_RAW_TREND_POINTS");
    expect(body).not.toContain("chooseBucketSeconds");
    expect(body).not.toContain("buildBucketedTrend");
    expect(body).not.toContain("date_bin");
    expect(body).not.toContain("avg(");
  });
});
