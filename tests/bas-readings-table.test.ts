import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

/**
 * The readings table and the CSV export, through the real database.
 *
 * What is held here:
 *  - pagination in SQL: first page, last page, exactly one page, a page past
 *    the end clamped, and the default page size wired;
 *  - a boolean point's rows are its state words, never 1 / 0;
 *  - the stored instant survives to the microsecond;
 *  - the CSV is the rows, byte for byte, with the label's comma and quote
 *    escaped and a null record present and empty;
 *  - the cap is honest: the headers say total and exported, the newest rows
 *    are the ones kept, and the keyset cursor loses nothing across chunks -
 *    including two rows inside one millisecond, which a Date cursor would
 *    skip;
 *  - a hidden point, an inactive point and a missing point are refused with
 *    the chart's own sentences, and nothing is served for them;
 *  - the request shape is validated the same way on both routes.
 *
 * The bucketed-versus-raw proof needs real readings and lives in
 * tests/bas-readings-raw.test.ts.
 *
 * MUTATION RECORD, 2026-10-09. Each applied by hand, the named test failed,
 * then reverted.
 *   - readings.ts: the keyset cursor made a JavaScript Date instead of the
 *     printed timestamp -> "two rows inside one millisecond both survive a
 *     chunk boundary" fails (the .412345 row is skipped).
 *   - readings.ts: `ORDER BY ts DESC` dropped from the page query -> "first
 *     page" and "last page" fail (rows arrive in insertion order).
 *   - point-explorer.tsx: the table mounted whatever the view -> "the chart
 *     view makes no request" fails in tests/bas-readings-table-ui.test.tsx
 *     (one fetch on render).
 */

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import type { Viewer } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { BasError } from "@/lib/modules/bas/errors";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import {
  CAP_HEADER,
  EXPORTED_HEADER,
  MAX_EXPORT_ROWS,
  READINGS_PAGE_SIZE,
  TOTAL_HEADER,
  exportPointReadings,
  getPointReadings,
} from "@/lib/modules/bas/readings";
import { HIDDEN_POINT_MESSAGE, POINT_NOT_AVAILABLE_MESSAGE } from "@/lib/modules/bas/service";
import { csvField, csvFilename } from "@/lib/modules/bas/csv";
import { GET as readingsRoute } from "@/app/api/modules/bas/point-readings/route";
import { GET as csvRoute } from "@/app/api/modules/bas/point-readings/csv/route";
import { renderStoredReading } from "@/app/(modules)/bas/readings-table";
import {
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
  testDb,
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

  const employee = await createEmployee({ entraOid: "oid-readings" });
  await grantModule(employee.id, BAS_MODULE_KEY);
  signedInAs("oid-readings");

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

const MINUTE = 60_000;
const ago = (minutes: number) => new Date(fixture.now.getTime() - minutes * MINUTE);
/** Two hours back to one minute past the fixture's now: every seeded row. */
const range = () => ({
  from: ago(120).toISOString(),
  to: new Date(fixture.now.getTime() + MINUTE).toISOString(),
});

/** Seven numeric readings on satSp (no fixture readings), newest at ago(10). */
async function seedSeven(pointId: bigint = fixture.satSp): Promise<Date[]> {
  const stamps = [70, 60, 50, 40, 30, 20, 10].map((m) => ago(m));
  await testDb.basReading.createMany({
    data: stamps.map((ts, i) => ({ pointId, ts, valueNum: 70 + i })),
  });
  return stamps;
}

const page = (pointId: bigint, extra: Record<string, unknown> = {}) =>
  getPointReadings(viewer, { pointId, ...range(), ...extra });

const request = (path: string, query: Record<string, string>) =>
  new Request(`http://localhost${path}?${new URLSearchParams(query).toString()}`);

// ------------------------------------------------------------ pagination

describe("pagination happens in SQL, newest first", () => {
  it("first page: the newest rows, the total and the page count", async () => {
    const stamps = await seedSeven();
    const result = await page(fixture.satSp, { pageSize: 3 });

    expect(result.total).toBe(7);
    expect(result.pages).toBe(3);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(3);
    expect(result.rows).toHaveLength(3);
    expect(result.rows.map((r) => Date.parse(r.ts))).toEqual(
      [stamps[6], stamps[5], stamps[4]].map((d) => d!.getTime()),
    );
    expect(result.rows.map((r) => r.valueNum)).toEqual([76, 75, 74]);
  });

  it("last page: the remainder, and only it", async () => {
    const stamps = await seedSeven();
    const result = await page(fixture.satSp, { pageSize: 3, page: 3 });

    expect(result.page).toBe(3);
    expect(result.rows).toHaveLength(1);
    expect(Date.parse(result.rows[0]!.ts)).toBe(stamps[0]!.getTime());
    expect(result.rows[0]!.valueNum).toBe(70);
  });

  it("exactly one page: pages is 1, and a second page is the first", async () => {
    await testDb.basReading.createMany({
      data: [10, 20, 30].map((m) => ({ pointId: fixture.satSp, ts: ago(m), valueNum: m })),
    });
    const only = await page(fixture.satSp, { pageSize: 3 });
    expect(only.pages).toBe(1);
    expect(only.rows).toHaveLength(3);

    const clamped = await page(fixture.satSp, { pageSize: 3, page: 2 });
    expect(clamped.page).toBe(1);
    expect(clamped.rows).toHaveLength(3);
  });

  it("a page past the end is clamped to the last page, not refused", async () => {
    await seedSeven();
    const result = await page(fixture.satSp, { pageSize: 3, page: 99 });
    expect(result.page).toBe(3);
    expect(result.rows).toHaveLength(1);
  });

  it("the default page size is READINGS_PAGE_SIZE, through the route", async () => {
    const count = READINGS_PAGE_SIZE + 1;
    await testDb.basReading.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        pointId: fixture.satSp,
        ts: new Date(fixture.now.getTime() - (i + 1) * 1000),
        valueNum: i,
      })),
    });

    const response = await readingsRoute(
      request("/api/modules/bas/point-readings", {
        point: fixture.satSp.toString(),
        ...range(),
      }),
    );
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as {
      data: { total: number; pages: number; page: number; pageSize: number; rows: unknown[] };
    };
    expect(data.total).toBe(count);
    expect(data.pageSize).toBe(READINGS_PAGE_SIZE);
    expect(data.pages).toBe(2);
    expect(data.rows).toHaveLength(READINGS_PAGE_SIZE);

    const last = await readingsRoute(
      request("/api/modules/bas/point-readings", {
        point: fixture.satSp.toString(),
        ...range(),
        page: "2",
      }),
    );
    const lastPage = (await last.json()) as { data: { rows: unknown[]; page: number } };
    expect(lastPage.data.page).toBe(2);
    expect(lastPage.data.rows).toHaveLength(1);
  });

  it("an empty range is total 0, one page, no rows", async () => {
    const result = await page(fixture.satSp);
    expect(result).toMatchObject({ total: 0, pages: 1, page: 1, rows: [] });
  });
});

// -------------------------------------------------------------- the rows

describe("rows are the stored rows", () => {
  it("a boolean point's rows carry value_bool and render as words, never digits", async () => {
    await testDb.basReading.createMany({
      data: [
        { pointId: fixture.fanStatus, ts: ago(50), valueBool: false },
        { pointId: fixture.fanStatus, ts: ago(35), valueBool: true },
        { pointId: fixture.fanStatus, ts: ago(20), valueBool: true },
        { pointId: fixture.fanStatus, ts: ago(5), valueBool: false },
      ],
    });
    const result = await page(fixture.fanStatus);

    expect(result.point.valueKind).toBe("boolean");
    expect(result.point.states).toEqual({ on: "On", off: "Off" });
    expect(result.rows.map((r) => r.valueBool)).toEqual([false, true, true, false]);
    expect(result.rows.every((r) => r.valueNum === null && r.valueStr === null)).toBe(true);

    const shown = result.rows.map((row) =>
      renderStoredReading(row, result.point.valueKind, result.point.unit, result.point.states),
    );
    expect(shown).toEqual(["Off", "On", "On", "Off"]);
    for (const text of shown) expect(text).not.toMatch(/\d/);
  });

  it("a numeric row is the stored number, whole, with the unit symbol", async () => {
    await testDb.basReading.create({
      data: { pointId: fixture.satSp, ts: ago(5), valueNum: 72.02734375 },
    });
    const result = await page(fixture.satSp);
    expect(result.rows[0]!.valueNum).toBe(72.02734375);
    expect(
      renderStoredReading(result.rows[0]!, result.point.valueKind, result.point.unit, null),
    ).toBe("72.02734375 °F");
  });

  it("a null record is in the table, as a dash", async () => {
    await testDb.basReading.create({ data: { pointId: fixture.satSp, ts: ago(5) } });
    const result = await page(fixture.satSp);
    expect(result.total).toBe(1);
    expect(result.rows[0]).toMatchObject({ valueNum: null, valueBool: null, valueStr: null });
    expect(renderStoredReading(result.rows[0]!, "numeric", "fahrenheit", null)).toBe("—");
  });

  it("the timestamp keeps its microseconds", async () => {
    await testDb.$executeRaw`
      INSERT INTO bas_readings (point_id, ts, value_num)
      VALUES (${fixture.sat}, '2026-09-11T14:05:03.412345Z'::timestamptz, 1)
    `;
    const result = await getPointReadings(viewer, {
      pointId: fixture.sat,
      from: "2026-09-11T00:00:00.000Z",
      to: "2026-09-12T00:00:00.000Z",
    });
    expect(result.rows[0]!.ts).toBe("2026-09-11T14:05:03.412345Z");
  });

  it("carries the building's zone and the station, for the screen and the file", async () => {
    const result = await page(fixture.sat);
    expect(result.timezone).toBe("America/New_York");
    expect(result.stationId).toBe(fixture.stationId.toString());
    expect(result.stationName).toBe("ZZTestStation");
    expect(result.niagaraHistoryName).toBe(
      (await testDb.basPoint.findUniqueOrThrow({ where: { pointId: fixture.sat } }))
        .niagaraHistoryName,
    );
  });
});

// ---------------------------------------------------------------- the CSV

describe("the CSV is the rows, byte for byte", () => {
  /**
   * The label carries a comma and a quote, so the point_name field has to be
   * quoted and the quote doubled. One null record, one microsecond instant.
   */
  const LABEL = 'Room "North", lab';

  async function seedCsvRows(): Promise<void> {
    await testDb.basPoint.update({ where: { pointId: fixture.sat }, data: { label: LABEL } });
    await testDb.$executeRaw`
      INSERT INTO bas_readings (point_id, ts, value_num) VALUES
        (${fixture.sat}, '2026-09-11T14:00:00.000000Z'::timestamptz, 70.5),
        (${fixture.sat}, '2026-09-11T14:05:03.412345Z'::timestamptz, 72.02734375),
        (${fixture.sat}, '2026-09-11T14:10:00.000000Z'::timestamptz, NULL)
    `;
  }

  const CSV_RANGE = { from: "2026-09-11T00:00:00.000Z", to: "2026-09-12T00:00:00.000Z" };

  async function expected(): Promise<string> {
    const point = await testDb.basPoint.findUniqueOrThrow({ where: { pointId: fixture.sat } });
    const id = fixture.sat.toString();
    const station = fixture.stationId.toString();
    const name = '"Room ""North"", lab"';
    const tail = `,fahrenheit,${name},${point.niagaraHistoryName},${id},ZZTestStation,${station},\r\n`;
    return (
      "timestamp,value,unit,point_name,niagara_history_name,point_id,station,station_id,status\r\n" +
      `2026-09-11T14:10:00.000000Z,${tail}` +
      `2026-09-11T14:05:03.412345Z,72.02734375${tail}` +
      `2026-09-11T14:00:00.000000Z,70.5${tail}`
    );
  }

  it("through the service: header, newest first, escaped, null record empty", async () => {
    await seedCsvRows();
    const job = await exportPointReadings(viewer, { pointId: fixture.sat, ...CSV_RANGE });
    expect(job.total).toBe(3);
    expect(job.exported).toBe(3);
    expect(job.cap).toBe(MAX_EXPORT_ROWS);

    let text = "";
    for await (const chunk of job.chunks()) text += chunk;
    expect(text).toBe(await expected());
  });

  it("through the route: the same bytes, the headers and the filename", async () => {
    await seedCsvRows();
    const response = await csvRoute(
      request("/api/modules/bas/point-readings/csv", {
        point: fixture.sat.toString(),
        ...CSV_RANGE,
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get(TOTAL_HEADER)).toBe("3");
    expect(response.headers.get(EXPORTED_HEADER)).toBe("3");
    expect(response.headers.get(CAP_HEADER)).toBe(String(MAX_EXPORT_ROWS));
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="${csvFilename(LABEL, CSV_RANGE.from, CSV_RANGE.to)}"`,
    );
    expect(response.headers.get("content-disposition")).toContain(
      'filename="readings-Room_North_lab-20260911T0000Z-20260912T0000Z.csv"',
    );
    expect(await response.text()).toBe(await expected());
  });

  it("a boolean and a string value are written as stored", async () => {
    await testDb.basReading.create({
      data: { pointId: fixture.fanStatus, ts: ago(5), valueBool: true },
    });
    const job = await exportPointReadings(viewer, { pointId: fixture.fanStatus, ...range() });
    let text = "";
    for await (const chunk of job.chunks()) text += chunk;
    const [, line] = text.split("\r\n");
    expect(line!.split(",")[1]).toBe("true");

    const point = await testDb.basPoint.create({
      data: {
        stationId: fixture.stationId,
        niagaraHistoryName: "ZZTEST_OpState",
        dataType: "enum",
      },
    });
    await testDb.basReading.create({
      data: { pointId: point.pointId, ts: ago(5), valueStr: "Heat, stage 2" },
    });
    const strings = await exportPointReadings(viewer, { pointId: point.pointId, ...range() });
    text = "";
    for await (const chunk of strings.chunks()) text += chunk;
    expect(text.split("\r\n")[1]).toContain(',"Heat, stage 2",');
  });

  it("csvField quotes only what needs quoting", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
    expect(csvField(null)).toBe("");
    expect(csvField(1.5)).toBe("1.5");
    expect(csvField(false)).toBe("false");
  });
});

describe("the cap is honest", () => {
  it("keeps the newest rows, says the total, and loses nothing across chunks", async () => {
    const stamps = await seedSeven();
    const job = await exportPointReadings(viewer, {
      pointId: fixture.satSp,
      ...range(),
      maxRows: 5,
      chunkRows: 2,
    });
    expect(job.total).toBe(7);
    expect(job.exported).toBe(5);
    expect(job.cap).toBe(5);

    let text = "";
    for await (const chunk of job.chunks()) text += chunk;
    const lines = text.split("\r\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(6);
    const instants = lines.slice(1).map((line) => Date.parse(line.split(",")[0]!));
    // The five newest, descending, no repeats and no skips across the
    // three chunks (2 + 2 + 1).
    expect(instants).toEqual(
      [stamps[6], stamps[5], stamps[4], stamps[3], stamps[2]].map((d) => d!.getTime()),
    );
  });

  it("the route's headers say what the file holds against what the range holds", async () => {
    await seedSeven();
    // The seam is on the service, not the route; prove the route reads the
    // service's numbers by exporting uncapped and checking equality.
    const response = await csvRoute(
      request("/api/modules/bas/point-readings/csv", {
        point: fixture.satSp.toString(),
        ...range(),
      }),
    );
    expect(response.headers.get(TOTAL_HEADER)).toBe("7");
    expect(response.headers.get(EXPORTED_HEADER)).toBe("7");
    expect((await response.text()).split("\r\n").filter((l) => l.length > 0)).toHaveLength(8);
  });

  it("two rows inside one millisecond both survive a chunk boundary", async () => {
    // A Date cursor would truncate .412999 to .412 and `ts < .412` would
    // skip .412345. The cursor is the printed text, so it does not.
    await testDb.$executeRaw`
      INSERT INTO bas_readings (point_id, ts, value_num) VALUES
        (${fixture.sat}, '2026-09-11T14:05:03.412345Z'::timestamptz, 1),
        (${fixture.sat}, '2026-09-11T14:05:03.412999Z'::timestamptz, 2),
        (${fixture.sat}, '2026-09-11T14:05:04.000000Z'::timestamptz, 3)
    `;
    const job = await exportPointReadings(viewer, {
      pointId: fixture.sat,
      from: "2026-09-11T00:00:00.000Z",
      to: "2026-09-12T00:00:00.000Z",
      chunkRows: 1,
    });
    let text = "";
    for await (const chunk of job.chunks()) text += chunk;
    const stamps = text
      .split("\r\n")
      .slice(1)
      .filter((l) => l.length > 0)
      .map((l) => l.split(",")[0]);
    expect(stamps).toEqual([
      "2026-09-11T14:05:04.000000Z",
      "2026-09-11T14:05:03.412999Z",
      "2026-09-11T14:05:03.412345Z",
    ]);
  });
});

// -------------------------------------------------------------- refusals

describe("who may see what is the chart's rule", () => {
  it("a hidden point is refused with the chart's sentence, on both routes", async () => {
    await seedSeven();
    await testDb.basPoint.update({ where: { pointId: fixture.satSp }, data: { isVisible: false } });

    await expect(page(fixture.satSp)).rejects.toMatchObject({
      code: "point_not_found",
      message: HIDDEN_POINT_MESSAGE,
    });
    await expect(
      exportPointReadings(viewer, { pointId: fixture.satSp, ...range() }),
    ).rejects.toBeInstanceOf(BasError);

    for (const [route, path] of [
      [readingsRoute, "/api/modules/bas/point-readings"],
      [csvRoute, "/api/modules/bas/point-readings/csv"],
    ] as const) {
      const response = await route(request(path, { point: fixture.satSp.toString(), ...range() }));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: "not_found", message: HIDDEN_POINT_MESSAGE },
      });
    }
  });

  it("an inactive point and a point that does not exist are 'not available'", async () => {
    await testDb.basPoint.update({
      where: { pointId: fixture.satSp },
      data: { isActive: false, inactiveReason: "manual" },
    });
    await expect(page(fixture.satSp)).rejects.toMatchObject({
      message: POINT_NOT_AVAILABLE_MESSAGE,
    });
    await expect(page(BigInt("999999999"))).rejects.toMatchObject({
      message: POINT_NOT_AVAILABLE_MESSAGE,
    });
  });

  it("no module grant: 404 before any query, on both routes", async () => {
    await createEmployee({ entraOid: "oid-nobody" });
    signedInAs("oid-nobody");
    for (const [route, path] of [
      [readingsRoute, "/api/modules/bas/point-readings"],
      [csvRoute, "/api/modules/bas/point-readings/csv"],
    ] as const) {
      const response = await route(request(path, { point: fixture.satSp.toString(), ...range() }));
      expect(response.status).toBe(404);
    }
  });
});

describe("the request is validated", () => {
  it("an end not after the start is 422, with the instants named", async () => {
    const { from } = range();
    await expect(
      getPointReadings(viewer, { pointId: fixture.satSp, from, to: from }),
    ).rejects.toMatchObject({ code: "invalid_range" });

    const response = await readingsRoute(
      request("/api/modules/bas/point-readings", {
        point: fixture.satSp.toString(),
        from,
        to: from,
      }),
    );
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain(from);
  });

  it("a non-UTC or non-ISO instant, a missing point, or a bad page is 422", async () => {
    const cases: Array<Record<string, string>> = [
      { point: fixture.satSp.toString(), from: "2026-09-11", to: "2026-09-12" },
      { point: fixture.satSp.toString(), from: "2026-09-11T00:00:00+02:00", to: range().to },
      { point: fixture.satSp.toString(), from: range().from },
      { from: range().from, to: range().to },
      { point: "abc", from: range().from, to: range().to },
      { point: fixture.satSp.toString(), ...range(), page: "0" },
      { point: fixture.satSp.toString(), ...range(), page: "1.5" },
    ];
    for (const query of cases) {
      const response = await readingsRoute(request("/api/modules/bas/point-readings", query));
      expect(response.status, JSON.stringify(query)).toBe(422);
    }
    // The CSV route ignores page but shares every other rule.
    for (const query of cases.slice(0, 5)) {
      const response = await csvRoute(request("/api/modules/bas/point-readings/csv", query));
      expect(response.status, JSON.stringify(query)).toBe(422);
    }
  });
});
