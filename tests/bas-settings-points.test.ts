import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Only the session is mocked, as in tests/bas-settings.test.ts. The guard, the
// wrapper, the queries and the route handler are the real ones.
vi.mock("@/auth", () => ({ auth: vi.fn() }));
// settings-view.tsx is a client component whose top-level hooks need a router;
// PointsTable itself calls none of them, but the module has to import.
vi.mock("next/navigation", () => ({
  usePathname: () => "/bas/settings",
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
  useSearchParams: () => new URLSearchParams(""),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { auth } from "@/auth";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { BasError } from "@/lib/modules/bas/errors";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import {
  getBasSettingsTree,
  getStationPoints,
} from "@/lib/modules/bas/settings-service";
import { pointsCountState } from "@/lib/modules/bas/types";
import { prisma } from "@/lib/db";
import type { StationPointsList } from "@/lib/modules/bas/types";
import { requireModuleAdmin } from "@/lib/authz";
import {
  INACTIVE_REASON_WORDS,
  REASON_NOT_RECORDED,
  describeCollected,
  describePointCompleteness,
} from "@/app/(modules)/bas/health-client";
import { PointsTable } from "@/app/(modules)/bas/settings-view";
import { GET as pointsRoute } from "@/app/api/modules/bas/settings/stations/[stationId]/points/route";
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
 * The Points level of the Settings tree (B8.2): every point on a station, with
 * the guard that proves it is every point.
 *
 * What is asserted here, in order of how much it matters:
 *
 *   1. The counting guard. `rendered` comes from the joined list query and
 *      `inDatabase` from a count with no joins. A point whose checkpoint row is
 *      DELETED, whose equipment is missing and whose role is unset must still
 *      be rendered, and the two numbers must agree. Making any of the three
 *      joins inner fails these tests - checked by doing exactly that, see the
 *      MUTATIONS note at the bottom.
 *   2. The screen SAYS so when the list falls short. The service cannot be made
 *      to fall short against the real schema without breaking the code, so the
 *      table is rendered with a payload whose counts disagree and the alarm is
 *      read off the HTML.
 *   3. Uncollected points are shown, and the reason is not invented.
 *   4. Access: module admin or 404; unknown or malformed station is 404.
 *
 * Fixtures are seeded with testDb and dropped by name, like the other settings
 * suites, because the service reads through the shared prisma client and a
 * transaction's rows are invisible to it.
 */

const authMock = vi.mocked(auth);

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

async function viewerFor(employeeId: string) {
  signedInAs(
    (
      await testDb.employee.findUniqueOrThrow({
        where: { id: employeeId },
        select: { entraOid: true },
      })
    ).entraOid!,
  );
  const access = await requireModuleAdmin(BAS_MODULE_KEY);
  if (!access.ok) throw new Error(`expected access, got ${access.denial}`);
  return access.viewer;
}

async function adminViewer() {
  const employee = await createEmployee();
  await grantModule(employee.id, BAS_MODULE_KEY);
  await grantModuleAdmin(employee.id, BAS_MODULE_KEY);
  return viewerFor(employee.id);
}

/** A BAS user with the module grant and NOT the admin flag. */
async function plainViewer() {
  const employee = await createEmployee();
  await grantModule(employee.id, BAS_MODULE_KEY);
  signedInAs(
    (
      await testDb.employee.findUniqueOrThrow({
        where: { id: employee.id },
        select: { entraOid: true },
      })
    ).entraOid!,
  );
}

function pointsRequest(stationId: string) {
  return pointsRoute(
    new Request(
      `http://localhost/api/modules/bas/settings/stations/${stationId}/points`,
    ),
    { params: Promise.resolve({ stationId }) },
  );
}

const ROLE = "zzb82_zone_temp";
const NAMES = {
  full: "ZZB82_VAV$2d1$20130_ZoneTemperature",
  bare: "ZZB82_Bare",
  inactive: "ZZB82_AuditHistory",
  hidden: "ZZB82_Hidden",
  other: "ZZB82_OnStationB",
} as const;

interface Seeded {
  stationA: bigint;
  stationB: bigint;
  siteId: bigint;
}

/**
 * Two stations in one building. Station A holds four points that between them
 * exercise every join and every state the list shows:
 *
 *   full      collected, role, equipment, checkpoint complete, station name;
 *             capacity 500 with the station reporting 320 - OperatingState's
 *             shape, a buffer that has never filled (2026-09-18)
 *   bare      collected, NO role, NO equipment, and its checkpoint row DELETED
 *             after being created - the row a wrong join drops
 *   inactive  not collected, checkpoint unknown - the row that must not be
 *             filtered out
 *   hidden    collected, labelled, is_visible false, checkpoint backfilling -
 *             the B8.1 columns, shown and never filtered on
 *
 * Station B holds one point, so the list is proved to be scoped by station.
 */
async function seed(): Promise<Seeded> {
  const org = await testDb.basOrg.create({ data: { name: "ZZTEST_B82_ORG" } });
  const project = await testDb.basProject.create({
    data: { orgId: org.orgId, name: "ZZTEST_B82_PROJECT" },
  });
  const site = await testDb.basSite.create({
    data: {
      orgId: org.orgId,
      projectId: project.projectId,
      name: "ZZTEST_B82_SITE",
      timezone: "America/New_York",
    },
  });
  const stationA = await testDb.basStation.create({
    data: {
      siteId: site.siteId,
      niagaraStationName: "ZZB82_StationA",
      connectionMode: "direct",
      baseUrl: "https://198.51.100.21",
    },
  });
  const stationB = await testDb.basStation.create({
    data: {
      siteId: site.siteId,
      niagaraStationName: "ZZB82_StationB",
      connectionMode: "direct",
      baseUrl: "https://198.51.100.22",
    },
  });
  await testDb.basPointRole.create({
    data: {
      pointRole: ROLE,
      displayName: "Zone Temperature (B8.2 test)",
      description: "test role",
      measurement: "temperature",
    },
  });
  const equipment = await testDb.basEquipment.create({
    data: { siteId: site.siteId, name: "ZZB82_VAV-1" },
  });

  const full = await testDb.basPoint.create({
    data: {
      stationId: stationA.stationId,
      niagaraHistoryName: NAMES.full,
      niagaraDisplayName: "VAV-1 130_ZoneTemperature",
      pointRole: ROLE,
      equipmentId: equipment.equipmentId,
      unit: "fahrenheit",
      dataType: "real",
      capacity: 500,
      checkpoint: {
        create: {
          completeness: "complete",
          lastRecordTs: new Date("2026-09-17T12:00:00Z"),
          stationCount: 320,
          observedSpanS: 78_000_000,
        },
      },
    },
  });
  const bare = await testDb.basPoint.create({
    data: {
      stationId: stationA.stationId,
      niagaraHistoryName: NAMES.bare,
      dataType: "real",
      checkpoint: { create: { completeness: "unknown" } },
    },
  });
  // The joined row, deleted. This is the case the guard exists for.
  await testDb.basSyncCheckpoint.delete({ where: { pointId: bare.pointId } });

  await testDb.basPoint.create({
    data: {
      stationId: stationA.stationId,
      niagaraHistoryName: NAMES.inactive,
      niagaraDisplayName: "AuditHistory",
      dataType: "str",
      isActive: false,
      checkpoint: { create: { completeness: "unknown" } },
    },
  });
  await testDb.basPoint.create({
    data: {
      stationId: stationA.stationId,
      niagaraHistoryName: NAMES.hidden,
      niagaraDisplayName: "Hidden_Point",
      label: "Zone Temp 104-105",
      isVisible: false,
      dataType: "real",
      checkpoint: { create: { completeness: "backfilling" } },
    },
  });
  await testDb.basPoint.create({
    data: {
      stationId: stationB.stationId,
      niagaraHistoryName: NAMES.other,
      dataType: "real",
    },
  });
  void full;

  return { stationA: stationA.stationId, stationB: stationB.stationId, siteId: site.siteId };
}

async function drop() {
  // Children before parents; checkpoints cascade from points.
  await testDb.basPoint.deleteMany({
    where: { niagaraHistoryName: { startsWith: "ZZB82_" } },
  });
  await testDb.basEquipment.deleteMany({ where: { name: { startsWith: "ZZB82_" } } });
  await testDb.basStation.deleteMany({
    where: { niagaraStationName: { startsWith: "ZZB82_" } },
  });
  await testDb.basSite.deleteMany({ where: { name: { startsWith: "ZZTEST_B82" } } });
  await testDb.basProject.deleteMany({ where: { name: { startsWith: "ZZTEST_B82" } } });
  await testDb.basOrg.deleteMany({ where: { name: { startsWith: "ZZTEST_B82" } } });
  await testDb.basPointRole.deleteMany({ where: { pointRole: { startsWith: "zzb82_" } } });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetBasAvailabilityCache();
  await drop();
  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();
});

afterAll(async () => {
  await drop();
  await disconnectDb();
});

/** count(*) on bas_points for one station, with no joins and not via Prisma's relation walk. */
async function directCount(stationId: bigint): Promise<number> {
  const rows = await testDb.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM bas_points WHERE station_id = ${stationId}`;
  return rows[0]?.n ?? -1;
}

// ---------------------------------------------------------------------------
// The counting guard. This is the part that matters most.
// ---------------------------------------------------------------------------

describe("the Points list accounts for every point on the station", () => {
  it("renders every point, including one whose checkpoint row was deleted", async () => {
    const { stationA } = await seed();
    const list = await getStationPoints(await adminViewer(), stationA.toString());

    expect(new Set(list.points.map((p) => p.niagaraHistoryName))).toEqual(
      new Set([NAMES.full, NAMES.bare, NAMES.inactive, NAMES.hidden]),
    );

    const bare = list.points.find((p) => p.niagaraHistoryName === NAMES.bare);
    expect(bare).toBeDefined();
    expect(bare?.completeness).toBeNull();
    expect(bare?.equipmentName).toBeNull();
    expect(bare?.roleName).toBeNull();
    expect(bare?.pointRole).toBeNull();
  });

  it("agrees with a count taken with no joins, and with the database directly", async () => {
    const { stationA } = await seed();
    const list = await getStationPoints(await adminViewer(), stationA.toString());

    const { rendered, inDatabase } = list.pointsAccountedFor;
    expect(rendered).toBe(inDatabase);
    expect(inDatabase).toBe(4);
    expect(inDatabase).toBe(await directCount(stationA));
    expect(pointsCountState(list.pointsAccountedFor).alarm).toBe(false);
  });

  it("puts the same joinless number on the station row, before anything is expanded", async () => {
    const { stationA, stationB } = await seed();
    const tree = await getBasSettingsTree(await adminViewer());
    const stations = tree.projects.flatMap((p) =>
      p.buildings.flatMap((b) => b.stations),
    );

    const a = stations.find((s) => s.stationId === stationA.toString());
    const b = stations.find((s) => s.stationId === stationB.toString());
    expect(a?.totalPoints).toBe(await directCount(stationA));
    expect(a?.totalPoints).toBe(4);
    // Three of the four are collected: `inactive` is not.
    expect(a?.activePoints).toBe(3);
    expect(b?.totalPoints).toBe(1);
    expect(b?.totalPoints).toBe(await directCount(stationB));
  });

  it("keeps station B's point out of station A's list", async () => {
    const { stationA, stationB } = await seed();
    const viewer = await adminViewer();

    const a = await getStationPoints(viewer, stationA.toString());
    const b = await getStationPoints(viewer, stationB.toString());

    expect(a.points.map((p) => p.niagaraHistoryName)).not.toContain(NAMES.other);
    expect(b.points.map((p) => p.niagaraHistoryName)).toEqual([NAMES.other]);
    expect(b.pointsAccountedFor).toEqual({ rendered: 1, inDatabase: 1 });
  });

  /**
   * THE TAUTOLOGY MUTATION, and why this test exists.
   *
   * Every other test here passes if `inDatabase` is quietly taken from
   * `rows.length` instead of the joinless count - because against the real
   * schema the LEFT JOINs never lose a row, so the two numbers agree whether or
   * not they were counted independently. Found by making exactly that change:
   * 19 of 19 passed. The guard was there and nothing proved it was wired.
   *
   * So the count query is stubbed to disagree with the rows, and the service
   * must report the DATABASE's number. Only the one count query is intercepted,
   * matched on its text; the station lookup and the list run against the real
   * database.
   */
  it("reports the database's count, not the rows', when the two disagree", async () => {
    const { stationA } = await seed();
    const viewer = await adminViewer();
    const original = prisma.$queryRaw;
    const spy = vi.spyOn(prisma, "$queryRaw").mockImplementation(((
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const sql = strings.join("?");
      if (sql.includes("count(*)") && sql.includes("FROM bas_points WHERE station_id")) {
        return Promise.resolve([{ n: 99n }]);
      }
      return Reflect.apply(original, prisma, [strings, ...values]);
    }) as never);

    try {
      const list = await getStationPoints(viewer, stationA.toString());
      expect(list.points).toHaveLength(4);
      expect(list.pointsAccountedFor).toEqual({ rendered: 4, inDatabase: 99 });
      expect(pointsCountState(list.pointsAccountedFor).alarm).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("is honest about a station with no points", async () => {
    const { stationB } = await seed();
    await testDb.basPoint.deleteMany({ where: { stationId: stationB } });

    const list = await getStationPoints(await adminViewer(), stationB.toString());
    expect(list.points).toEqual([]);
    expect(list.pointsAccountedFor).toEqual({ rendered: 0, inDatabase: 0 });
  });
});

describe("the screen says so when the list falls short", () => {
  /**
   * The service cannot be made to lose a point against the real schema without
   * changing its code - which is what the tests above catch. What is proved
   * here is the other half: given counts that disagree, the table SAYS it,
   * rather than drawing fewer rows and looking fine.
   */
  const point = (name: string): StationPointsList["points"][number] => ({
    pointId: name,
    label: null,
    niagaraHistoryName: name,
    niagaraDisplayName: null,
    pointRole: null,
    roleName: null,
    equipmentName: null,
    unit: null,
    horizon: { state: "unknown", hours: null, currentHours: null, stationCount: null, capacity: null },
    collected: true,
    inactiveReason: null,
    completeness: "complete",
    lastRecordAt: null,
    visible: true,
  });

  function render(list: StationPointsList, expectedTotal: number): string {
    return renderToStaticMarkup(createElement(PointsTable, { list, expectedTotal }));
  }

  it("renders a red alert naming the shortfall", () => {
    const html = render(
      {
        stationId: "1",
        points: [point("A"), point("B"), point("C")],
        pointsAccountedFor: { rendered: 3, inDatabase: 4 },
      },
      4,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("shows 3 of the 4 points");
    expect(html).toContain("1 could not be placed");
    expect(html).toContain("Report this");
  });

  it("renders no alert when the counts agree", () => {
    const html = render(
      {
        stationId: "1",
        points: [point("A"), point("B")],
        pointsAccountedFor: { rendered: 2, inDatabase: 2 },
      },
      2,
    );

    expect(html).not.toContain('role="alert"');
    expect(html).toContain("2 points in the database for this station");
  });

  it("names a stale tree count as stale, in plain text, never red", () => {
    const html = render(
      {
        stationId: "1",
        points: [point("A"), point("B")],
        pointsAccountedFor: { rendered: 2, inDatabase: 2 },
      },
      1,
    );

    expect(html).not.toContain('role="alert"');
    expect(html).toContain("The tree counted 1 point for this station");
    expect(html).toContain("the database now holds 2");
  });

  it("alarms on a shortfall and only a shortfall", () => {
    expect(pointsCountState({ rendered: 4, inDatabase: 4 }).alarm).toBe(false);
    expect(pointsCountState({ rendered: 3, inDatabase: 4 }).alarm).toBe(true);
    expect(pointsCountState({ rendered: 0, inDatabase: 0 }).alarm).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// What each row says
// ---------------------------------------------------------------------------

describe("every point is shown with its real state", () => {
  it("shows the uncollected point, says it is not collected, and invents no reason", async () => {
    const { stationA } = await seed();
    const list = await getStationPoints(await adminViewer(), stationA.toString());

    const inactive = list.points.find((p) => p.niagaraHistoryName === NAMES.inactive);
    expect(inactive).toBeDefined();
    expect(inactive?.collected).toBe(false);

    // The fixture's inactive point carries no reason, which is the state a
    // point deactivated by hand without one is in.
    expect(inactive?.inactiveReason).toBeNull();
    const said = describeCollected(inactive!);
    expect(said.label).toBe("Not collected");
    expect(said.detail).toBe(REASON_NOT_RECORDED);
    expect(REASON_NOT_RECORDED).toContain("not recorded");
    // No wording anywhere on the row claims to know WHY. The collector's
    // system-log list and the _cfg0 rule are not re-implemented here.
    expect(JSON.stringify(inactive)).not.toMatch(/system log|cfg0|reconfigured/i);
  });

  it("words a recorded reason plainly, never as the enum value", async () => {
    const { stationA } = await seed();
    await testDb.basPoint.updateMany({
      where: { stationId: stationA, niagaraHistoryName: NAMES.inactive },
      data: { inactiveReason: "niagara_system_log" },
    });
    const list = await getStationPoints(await adminViewer(), stationA.toString());
    const inactive = list.points.find((p) => p.niagaraHistoryName === NAMES.inactive);

    expect(inactive?.inactiveReason).toBe("niagara_system_log");
    const said = describeCollected(inactive!);
    expect(said.detail).toBe("Niagara system log, not building data");
    expect(said.detail).not.toContain("niagara_system_log");

    // Every value has words, and none of them is the value itself.
    for (const [value, words] of Object.entries(INACTIVE_REASON_WORDS)) {
      expect(words).not.toContain(value);
      expect(words.length).toBeGreaterThan(10);
    }
    // Global_Alarm is building data waiting for a table, and says so.
    expect(INACTIVE_REASON_WORDS.alarm_history).toContain("building data");
    expect(INACTIVE_REASON_WORDS.alarm_history).not.toMatch(/system log/i);

    const html = renderToStaticMarkup(
      createElement(PointsTable, { list, expectedTotal: list.pointsAccountedFor.inDatabase }),
    );
    expect(html).toContain("Niagara system log, not building data");
    expect(html).not.toContain("niagara_system_log");
  });

  it("carries the B8.1 columns and does not filter on is_visible", async () => {
    const { stationA } = await seed();
    const list = await getStationPoints(await adminViewer(), stationA.toString());

    const hidden = list.points.find((p) => p.niagaraHistoryName === NAMES.hidden);
    expect(hidden?.label).toBe("Zone Temp 104-105");
    expect(hidden?.visible).toBe(false);
    expect(hidden?.collected).toBe(true);
    expect(hidden?.completeness).toBe("backfilling");
  });

  it("keeps the three names apart: key, station's name, person's label", async () => {
    const { stationA } = await seed();
    const list = await getStationPoints(await adminViewer(), stationA.toString());

    const full = list.points.find((p) => p.niagaraHistoryName === NAMES.full);
    // The key, verbatim, escapes and all.
    expect(full?.niagaraHistoryName).toContain("$2d");
    // bas_points.display_name - what NIAGARA reports.
    expect(full?.niagaraDisplayName).toBe("VAV-1 130_ZoneTemperature");
    // Nobody has typed one.
    expect(full?.label).toBeNull();
    expect(full?.roleName).toBe("Zone Temperature (B8.2 test)");
    expect(full?.pointRole).toBe(ROLE);
    expect(full?.equipmentName).toBe("ZZB82_VAV-1");
    expect(full?.unit).toBe("fahrenheit");
    expect(full?.completeness).toBe("complete");
    expect(full?.lastRecordAt).toBe("2026-09-17T12:00:00.000Z");
  });

  it("renders the uncollected row's words into the HTML", async () => {
    const { stationA } = await seed();
    const list = await getStationPoints(await adminViewer(), stationA.toString());
    const html = renderToStaticMarkup(
      createElement(PointsTable, { list, expectedTotal: list.pointsAccountedFor.inDatabase }),
    );

    expect(html).toContain("Not collected");
    expect(html).toContain(REASON_NOT_RECORDED);
    expect(html).toContain("Zone Temp 104-105");
    expect(html).toContain("Hidden");
    expect(html).toContain(NAMES.full.replace(/\$/g, "$"));
    expect(html).toContain("VAV-1 130_ZoneTemperature");
  });

  it("carries the roll horizon in the view's three states, and never re-derives it", async () => {
    const { stationA } = await seed();
    const list = await getStationPoints(await adminViewer(), stationA.toString());
    const byName = (name: string) =>
      list.points.find((point) => point.niagaraHistoryName === name);

    // 320 of 500: not full, nothing overwritten, nothing to fill in.
    expect(byName(NAMES.full)?.horizon).toEqual({
      state: "not_full",
      hours: null,
      currentHours: null,
      stationCount: 320,
      capacity: 500,
    });
    // No capacity, no checkpoint: unknown, and it says so.
    expect(byName(NAMES.bare)?.horizon.state).toBe("unknown");
    expect(byName(NAMES.bare)?.horizon.capacity).toBeNull();
    // An uncollected point still carries the station's answer about its
    // buffer - the list filters nothing.
    expect(byName(NAMES.inactive)?.horizon.state).toBe("unknown");
  });

  it("renders the not-full state into the HTML, with how full", async () => {
    const { stationA } = await seed();
    const list = await getStationPoints(await adminViewer(), stationA.toString());
    const html = renderToStaticMarkup(
      createElement(PointsTable, { list, expectedTotal: list.pointsAccountedFor.inDatabase }),
    );

    expect(html).toContain("Not full yet");
    expect(html).toContain("320 of 500");
    expect(html).toContain("Roll horizon");
  });

  it("words completeness in the Collection Health tones", () => {
    expect(describePointCompleteness({ collected: true, completeness: "complete" })).toEqual({
      label: "Complete",
      tone: "ok",
    });
    expect(describePointCompleteness({ collected: true, completeness: "incomplete" }).tone).toBe("bad");
    expect(describePointCompleteness({ collected: true, completeness: "backfilling" }).tone).toBe("warn");
    // Unknown is never green for a collected point...
    expect(describePointCompleteness({ collected: true, completeness: "unknown" }).tone).toBe("warn");
    // ...and says nothing about one that is not collected.
    expect(describePointCompleteness({ collected: false, completeness: "unknown" }).tone).toBe("neutral");
    // No checkpoint row at all: never passed by the collector.
    expect(describePointCompleteness({ collected: true, completeness: null })).toEqual({
      label: "Never collected",
      tone: "warn",
    });
    expect(describePointCompleteness({ collected: false, completeness: null }).tone).toBe("neutral");
  });
});

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

describe("the points route is a settings route", () => {
  it("is 404 for a BAS user without the module-admin flag", async () => {
    const { stationA } = await seed();
    await plainViewer();

    const response = await pointsRequest(stationA.toString());
    expect(response.status).toBe(404);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("ZZB82");
  });

  it("is 200 with the list for a module admin", async () => {
    const { stationA } = await seed();
    await adminViewer();

    const response = await pointsRequest(stationA.toString());
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { data: StationPointsList };
    expect(payload.data.stationId).toBe(stationA.toString());
    expect(payload.data.points).toHaveLength(4);
    expect(payload.data.pointsAccountedFor).toEqual({ rendered: 4, inDatabase: 4 });
  });

  it("is 404 for a station that does not exist, and for an id that is not one", async () => {
    await seed();
    await adminViewer();

    expect((await pointsRequest("999999999")).status).toBe(404);
    expect((await pointsRequest("not-a-station")).status).toBe(404);
    expect((await pointsRequest("1e3")).status).toBe(404);
  });

  it("raises station_not_found from the service for both", async () => {
    await seed();
    const viewer = await adminViewer();

    for (const id of ["999999999", "abc", "-1", ""]) {
      const error = await getStationPoints(viewer, id).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error, id).toBeInstanceOf(BasError);
      expect((error as BasError).code, id).toBe("station_not_found");
    }
  });

  /**
   * Org scoping: a point must never be visible to someone outside its org.
   *
   * NOT PROVABLE AGAINST THE DATABASE TODAY. `basSiteScope` returns `entitled:
   * null` - everyone sees everything - so no viewer can be constructed who is
   * outside an org, and a test that tried would pass for the wrong reason. What
   * can be checked is that the query is written to scope the moment the
   * entitlement exists: the station lookup composes the shared entitlement
   * predicate, and takes it from `basSiteScope` rather than inventing one. This
   * is a source-text assertion and is recorded as a blind spot in
   * docs/testing-blind-spots.md.
   */
  it("scopes the station lookup through the shared entitlement (source text)", async () => {
    const source = await readFile(
      path.join(process.cwd(), "lib/modules/bas/settings-service.ts"),
      "utf8",
    );
    const start = source.indexOf("export async function getStationPoints(");
    const end = source.indexOf("// Mutations (B7.3)", start);
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, end);

    expect(body).toContain("basSiteScope(viewer)");
    expect(body).toContain("entitlementSql(entitled, Prisma.sql`st.site_id`)");
    // And the scope is applied BEFORE any point is read.
    expect(body.indexOf("entitlementSql(")).toBeLessThan(body.indexOf("FROM bas_points p"));
  });
});

// ---------------------------------------------------------------------------
// MUTATIONS - made against getStationPoints and the tree's station-row count
// by a script, run, reverted (2026-09-17). Recorded so the next person knows
// the guard can fail and which assertion catches what.
//
//   M1. LEFT JOIN bas_sync_checkpoints -> JOIN      7 failed: every test that
//       reads the `bare` point, the joinless-count agreement, station B's
//       list, and the route's 200 body
//   M2. LEFT JOIN bas_equipment        -> JOIN      7 failed, the same seven
//   M3. LEFT JOIN bas_point_roles      -> JOIN      7 failed, the same seven
//   M4. inDatabase taken as rows.length            19 PASSED on the first run.
//       The tautology is invisible to every database-state test, because
//       correct joins never lose a row. "reports the database's count, not
//       the rows', when the two disagree" was written for it and is the one
//       test that fails under it now.
//   M5. WHERE station_id = ? dropped from the count 4 failed: the agreement,
//       station B's list, the empty station, and the route's 200 body
//   M6. total_points on the station row counted through the checkpoint join
//       (count(ck.point_id)) instead of the joinless subquery
//                                                    1 failed: "puts the same
//       joinless number on the station row, before anything is expanded"
// ---------------------------------------------------------------------------
