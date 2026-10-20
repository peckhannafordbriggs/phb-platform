import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
// Both screens are client components whose top-level hooks need a router;
// the two cards rendered here call none of them, but the modules must import.
vi.mock("next/navigation", () => ({
  usePathname: () => "/bas",
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
  useSearchParams: () => new URLSearchParams(""),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { auth } from "@/auth";
import type { Viewer } from "@/lib/authz";
import { requireModuleAdmin } from "@/lib/authz";
import { Prisma } from "@/lib/generated/prisma/client";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import {
  LOOKBACK_DAYS,
  MIN_READINGS,
  NOT_CHECKED_REASONS,
  PLAUSIBILITY_THRESHOLDS,
  STATE_DATA_TYPES,
  STATE_MEASUREMENTS,
  judgePlausibility,
  thresholdFor,
  type PlausibilityRow,
} from "@/lib/modules/bas/plausibility";
import { checkedRoleSql, checkedTypeSql } from "@/lib/modules/bas/plausibility-sql";
import { getCollectionHealth } from "@/lib/modules/bas/service";
import { getStationPoints } from "@/lib/modules/bas/settings-service";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import {
  NOT_CHECKED_WORDS,
  describePlausibility,
  describeStuck,
  describeThresholds,
} from "@/app/(modules)/bas/health-client";
import {
  FailedChecks,
  PassedChecks,
  StuckCard,
  evaluateChecks,
} from "@/app/(modules)/bas/collection-health";
import { PointsTable } from "@/app/(modules)/bas/settings-view";
import { BAS_POINT_ROLES } from "../prisma/bas-vocabularies";
import { ROLES, createHealthFixture, expectBasTablesEmpty, type HealthFixture } from "./bas-fixture";
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
 * The value-plausibility check (2026-09-28): a point whose value has not
 * changed when it should have.
 *
 * Two dead sensors sat green for a month - points_RoomT at exactly -40 for
 * 6,447 readings, VAV-8 at exactly 70.5 for its whole history. This file
 * proves the check that finds them, and - the half that decides whether
 * anyone uses it - that it does NOT flag the points that hold still by
 * design. In order of how much each matters:
 *
 *   1. The role exclusion. A flat setpoint, a flat status point and a flat
 *      point with no role are NOT flagged, and each says why. Mutation A
 *      (below) removes the exclusion and these fail.
 *   2. Both fault shapes are flagged: a step then a flat line (76 then -40),
 *      and a flat line with no step (70.5 forever).
 *   3. Thresholds are per kind: the same four-hour run is "changing" for a
 *      temperature and "flat" for a pressure.
 *   4. The minimum-readings guard: three readings are not a stuck sensor,
 *      however long they span.
 *   5. Change-of-value trends: "no change" is no new records, measured to the
 *      collector's last successful pass, never to now().
 *   6. Nothing is deactivated, nothing is modified, a flagged point stays in
 *      every collection figure, and a hidden flagged point is still listed.
 *   7. The SQL role decision and the TypeScript reason agree on every role in
 *      the vocabulary.
 *
 * Readings are seeded relative to one `now`, captured when the fixture is
 * built, and every expected span is computed from the same offsets.
 *
 * RE-LANDED 2026-10-01 onto a main that had moved: the card is now the loud
 * half of a check (`evaluateChecks`), the Value column lives in
 * settings-points.tsx, and values print through the unit-symbol formatter
 * (°F, inH₂O) - the expectations below say so.
 *
 * MUTATIONS RUN (2026-09-28), each reverted:
 *   A. drop `AND NOT pr.is_setpoint` from checkedRoleSql -> the judge throws
 *      "SQL evaluated a point TypeScript would not check" for the setpoint
 *      (the agreement guard); ALSO drop the setpoint branch of the judge ->
 *      "a flat setpoint is not flagged" fails: the setpoint is in `flat`.
 *   B. change the pressure threshold to 6 h -> "per kind" fails.
 *   C. set MIN_READINGS to 3 -> "three readings are not stuck" fails.
 *   D. measure a COV point to now() instead of last_run_at -> the stalled
 *      collector test fails: the point is flagged.
 *
 * MUTATIONS RUN (2026-10-06), the type gate, each reverted:
 *   E. drop `AND checkedTypeSql(p)` from the lateral -> the judge throws
 *      "SQL evaluated a point TypeScript would not check" for bool_as_temp;
 *      drop the STATE_DATA_TYPES branch of the judge instead -> it throws
 *      "SQL did not evaluate a point TypeScript expected to check". Either
 *      half alone fails "a boolean point given a temperature role is NOT
 *      judged" and the declared-type walk.
 */

const authMock = vi.mocked(auth);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const PREFIX = "ZZPL_";

const ROLE_PRESSURE = "zzpl_duct_static";
const ROLE_POSITION = "zzpl_damper_cmd";

interface Seeded {
  fixture: HealthFixture;
  now: Date;
  ids: Record<string, bigint>;
  covLastRunAt: Date;
}

let seeded: Seeded;
let viewer: Viewer;

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

async function adminViewer(): Promise<Viewer> {
  const employee = await createEmployee();
  await grantModule(employee.id, BAS_MODULE_KEY);
  await grantModuleAdmin(employee.id, BAS_MODULE_KEY);
  signedInAs(
    (
      await testDb.employee.findUniqueOrThrow({
        where: { id: employee.id },
        select: { entraOid: true },
      })
    ).entraOid!,
  );
  const access = await requireModuleAdmin(BAS_MODULE_KEY);
  if (!access.ok) throw new Error(`expected access, got ${access.denial}`);
  return access.viewer;
}

/**
 * The points, by name. Every one is on station A (site A) unless noted.
 *
 *   stuck_temp        temperature, interval. 76.1 at -8h15m, then -40 every 15
 *                     min from -8h to now: 33 identical readings, 8 h flat.
 *                     The points_RoomT shape.                       -> FLAT
 *   whole_temp        temperature, interval. 70.5 x 30 over 7.25 h and nothing
 *                     else. The VAV-8 shape.                        -> FLAT
 *   moving_temp       temperature, interval. Changes every reading. -> changing
 *   short_temp        temperature, interval. Flat 4 h (17 readings). -> changing (6 h)
 *   flat_pressure     pressure, interval. Flat 4 h (17 readings).    -> FLAT (3 h)
 *   few_temp          temperature. 3 identical readings, 30 min.     -> too few
 *   sparse_temp       temperature. 5 identical readings over 10 h.   -> too few
 *   satSp (fixture)   setpoint. 70 identical over 17 h.              -> not checked, setpoint
 *   fanCmd (fixture)  status, bool. 70 identical over 17 h.          -> not checked, state
 *   unknown (fixture) no role. 70 identical over 17 h.               -> not checked, role not set
 *   pos_5d            position, hourly. Flat 5 days.                 -> changing (168 h)
 *   pos_8d            position, hourly. Flat 8 days.                 -> FLAT
 *   cov_temp          temperature, NO interval. 20 changing readings over 30
 *                     days, the last at -10h; checkpoint ok at -5min. -> FLAT (cov), 10 h
 *   cov_stalled       as cov_temp, but the checkpoint's last status is error.
 *                                                                    -> changing (0 h known)
 *   cov_few           temperature, no interval, 3 readings.          -> too few
 *   hidden_temp       as whole_temp, is_visible false.               -> FLAT, listed, says hidden
 *   lookback_temp     temperature. A different value 100 days ago, then 15
 *                     identical readings every 6 days inside the lookback.
 *                                                                    -> FLAT, lookback exhausted
 *   empty_temp        temperature. 30 records with no value at all.  -> FLAT at "no value"
 *   off_temp          temperature, is_active false, flat readings.   -> not checked, not collected
 *   b_temp (site B)   temperature, flat 8 h.                         -> FLAT; outside a site-A filter
 */
async function seed(): Promise<Seeded> {
  const fixture = await createHealthFixture();
  const now = fixture.now;
  const ago = (ms: number) => new Date(now.getTime() - ms);

  await testDb.basPointRole.create({
    data: {
      pointRole: ROLE_PRESSURE,
      displayName: "Duct static (test)",
      description: "Fixture pressure.",
      measurement: "pressure",
    },
  });
  await testDb.basPointRole.create({
    data: {
      pointRole: ROLE_POSITION,
      displayName: "Damper command (test)",
      description: "Fixture position.",
      measurement: "position",
      isCommand: true,
    },
  });

  const ids: Record<string, bigint> = {};
  const point = async (
    name: string,
    role: string | null,
    options: {
      stationId?: bigint;
      intervalS?: number | null;
      visible?: boolean;
      active?: boolean;
      unit?: string | null;
      dataType?: string;
    } = {},
  ) => {
    const row = await testDb.basPoint.create({
      data: {
        stationId: options.stationId ?? fixture.stationId,
        niagaraHistoryName: `${PREFIX}${name}`,
        pointRole: role,
        unit: options.unit === undefined ? "fahrenheit" : options.unit,
        dataType: options.dataType ?? "real",
        capacity: 500,
        collectionIntervalS: options.intervalS === undefined ? 900 : options.intervalS,
        isVisible: options.visible ?? true,
        isActive: options.active ?? true,
        inactiveReason: options.active === false ? "manual" : null,
      },
    });
    ids[name] = row.pointId;
    return row.pointId;
  };

  const readings = (
    pointId: bigint,
    rows: Array<{ agoMs: number; value: number | null }>,
  ) =>
    testDb.basReading.createMany({
      data: rows.map((r) => ({ pointId, ts: ago(r.agoMs), valueNum: r.value })),
    });

  /** `count` identical readings, `stepMs` apart, the newest at `endAgoMs`. */
  const flat = (value: number | null, count: number, stepMs: number, endAgoMs = 0) =>
    Array.from({ length: count }, (_, i) => ({ agoMs: endAgoMs + i * stepMs, value }));

  // 1. The two fault shapes.
  await readings(await point("stuck_temp", ROLES.sat), [
    { agoMs: 8 * HOUR + 15 * MINUTE, value: 76.1 },
    ...flat(-40, 33, 15 * MINUTE),
  ]);
  await readings(await point("whole_temp", ROLES.sat), flat(70.5, 30, 15 * MINUTE));

  // 2. Alive, and flat-but-short.
  await readings(
    await point("moving_temp", ROLES.sat),
    Array.from({ length: 30 }, (_, i) => ({ agoMs: i * 15 * MINUTE, value: 70 + i * 0.1 })),
  );
  await readings(await point("short_temp", ROLES.sat), [
    { agoMs: 4 * HOUR + 15 * MINUTE, value: 69 },
    ...flat(71, 17, 15 * MINUTE),
  ]);

  // 3. The same four hours, a pressure.
  await readings(await point("flat_pressure", ROLE_PRESSURE, { unit: "inH2O" }), [
    { agoMs: 4 * HOUR + 15 * MINUTE, value: 1.1 },
    ...flat(1.25, 17, 15 * MINUTE),
  ]);

  // 4. Too few readings, however they are spread.
  await readings(await point("few_temp", ROLES.sat), flat(70, 3, 15 * MINUTE));
  await readings(await point("sparse_temp", ROLES.sat), flat(70, 5, 150 * MINUTE));

  // 5. The exclusions, all flat far past every threshold.
  await readings(fixture.satSp, flat(55, 70, 15 * MINUTE));
  await testDb.basReading.createMany({
    data: flat(null, 70, 15 * MINUTE).map((r) => ({
      pointId: fixture.fanCmd,
      ts: ago(r.agoMs),
      valueBool: true,
    })),
  });
  await readings(fixture.unknown, flat(1, 70, 15 * MINUTE));

  // 6. Outputs, a week apart.
  await readings(await point("pos_5d", ROLE_POSITION, { intervalS: 3600, unit: "percent" }), [
    { agoMs: 5 * DAY + HOUR, value: 42 },
    ...flat(10, 5 * 24 + 1, HOUR),
  ]);
  await readings(await point("pos_8d", ROLE_POSITION, { intervalS: 3600, unit: "percent" }), [
    { agoMs: 8 * DAY + HOUR, value: 42 },
    ...flat(10, 8 * 24 + 1, HOUR),
  ]);

  // 7. Change-of-value: readings only when the value changed.
  const covRows = Array.from({ length: 20 }, (_, i) => ({
    agoMs: 10 * HOUR + i * 36 * HOUR,
    value: 71 + (i % 5),
  }));
  const covLastRunAt = ago(5 * MINUTE);
  const cov = await point("cov_temp", ROLES.sat, { intervalS: null });
  await readings(cov, covRows);
  await testDb.basSyncCheckpoint.create({
    data: { pointId: cov, lastRecordTs: ago(10 * HOUR), lastRunAt: covLastRunAt, lastStatus: "ok" },
  });
  const covStalled = await point("cov_stalled", ROLES.sat, { intervalS: null });
  await readings(covStalled, covRows);
  await testDb.basSyncCheckpoint.create({
    data: { pointId: covStalled, lastRecordTs: ago(10 * HOUR), lastRunAt: covLastRunAt, lastStatus: "error" },
  });
  await readings(await point("cov_few", ROLES.sat, { intervalS: null }), [
    { agoMs: 10 * HOUR, value: 71 },
    { agoMs: 20 * HOUR, value: 72 },
    { agoMs: 30 * HOUR, value: 73 },
  ]);

  // 8. Hidden, still flagged.
  await readings(await point("hidden_temp", ROLES.sat, { visible: false }), flat(70.5, 30, 15 * MINUTE));

  // 9. The lookback bound.
  await readings(await point("lookback_temp", ROLES.sat), [
    { agoMs: 100 * DAY, value: 65 },
    ...flat(70, 15, 6 * DAY),
  ]);

  // 10. Records with nothing in them.
  await readings(await point("empty_temp", ROLES.sat), flat(null, 30, 15 * MINUTE));

  // 11. Not collected.
  await readings(await point("off_temp", ROLES.sat, { active: false }), flat(70, 30, 15 * MINUTE));

  // 12. The other building.
  await readings(
    await point("b_temp", ROLES.sat, { stationId: fixture.stationBId }),
    [{ agoMs: 8 * HOUR + 15 * MINUTE, value: 66 }, ...flat(72, 33, 15 * MINUTE)],
  );

  // 13. State-typed points GIVEN a measurement role, flat far past the
  // temperature threshold. The role says temperature; the type says the
  // readings are states. The type must win, or a misclassified fan status
  // is "stuck" after six hours of running.
  const boolAsTemp = await point("bool_as_temp", ROLES.sat, { dataType: "bool", unit: null });
  await testDb.basReading.createMany({
    data: flat(null, 70, 15 * MINUTE).map((r) => ({ pointId: boolAsTemp, ts: ago(r.agoMs), valueBool: true })),
  });
  const enumAsTemp = await point("enum_as_temp", ROLES.sat, { dataType: "enum", unit: null });
  await testDb.basReading.createMany({
    data: flat(null, 70, 15 * MINUTE).map((r) => ({ pointId: enumAsTemp, ts: ago(r.agoMs), valueStr: "3" })),
  });

  return { fixture, now, ids, covLastRunAt };
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetBasAvailabilityCache();
  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();
  await expectBasTablesEmpty();
  seeded = await seed();
  viewer = await adminViewer();
});

afterEach(async () => {
  await testDb.basPoint.deleteMany({ where: { niagaraHistoryName: { startsWith: PREFIX } } });
  await testDb.basPointRole.deleteMany({ where: { pointRole: { in: [ROLE_PRESSURE, ROLE_POSITION] } } });
  await seeded.fixture.cleanup();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDb();
});

const name = (key: string) => `${PREFIX}${key}`;
const health = (options: Parameters<typeof getCollectionHealth>[1] = {}) =>
  getCollectionHealth(viewer, options);

const FLAGGED = [
  "stuck_temp",
  "whole_temp",
  "flat_pressure",
  "pos_8d",
  "cov_temp",
  "hidden_temp",
  "lookback_temp",
  "empty_temp",
  "b_temp",
];

// ---------------------------------------------------------------------------
// 1. The role exclusion
// ---------------------------------------------------------------------------

describe("the role exclusion", () => {
  it("a flat setpoint is not flagged, and reads 'not checked, setpoint'", async () => {
    const result = await health();
    expect(result.plausibility.flat.map((p) => p.pointName)).not.toContain("AHU-1_SupplyAirTempSp");

    const list = await getStationPoints(viewer, seeded.fixture.stationId.toString());
    const sp = list.points.find((p) => p.niagaraHistoryName === "AHU$2d1_SupplyAirTempSp")!;
    expect(sp.plausibility.state).toBe("not_checked");
    expect(sp.plausibility.notCheckedReason).toBe("setpoint");
    expect(sp.plausibility.flatHours).toBeNull();
  });

  it("a flat status point is not flagged, and reads 'not checked, status or command point'", async () => {
    const result = await health();
    expect(result.plausibility.flat.map((p) => p.pointName)).not.toContain("AHU-1_FanCmd");

    const list = await getStationPoints(viewer, seeded.fixture.stationId.toString());
    const cmd = list.points.find((p) => p.niagaraHistoryName === "AHU$2d1_FanCmd")!;
    expect(cmd.plausibility).toMatchObject({ state: "not_checked", notCheckedReason: "state" });
    expect(NOT_CHECKED_WORDS.state).toBe("status or command point");
  });

  it("a flat point with no role is not flagged, and reads 'not checked, role not set'", async () => {
    const result = await health();
    expect(result.plausibility.flat.map((p) => p.pointName)).not.toContain("AHU-1_Unknown");

    const list = await getStationPoints(viewer, seeded.fixture.stationId.toString());
    const unknown = list.points.find((p) => p.niagaraHistoryName === "AHU$2d1_Unknown")!;
    expect(unknown.plausibility).toMatchObject({ state: "not_checked", notCheckedReason: "no_role" });
    expect(NOT_CHECKED_WORDS.no_role).toBe("role not set");
    expect(describePlausibility(unknown.plausibility, null)).toEqual({
      label: "Not checked",
      detail: "role not set",
      tone: "neutral",
    });
  });

  it("a boolean point given a temperature role is NOT judged, and reads 'not checked, state point'", async () => {
    // Seventy identical `true` readings, 15 minutes apart: seventeen hours
    // flat against a six-hour temperature threshold. Judged, it would be the
    // longest-flat point on the card.
    const result = await health();
    expect(result.plausibility.flat.map((p) => p.pointName)).not.toContain(name("bool_as_temp"));

    const list = await getStationPoints(viewer, seeded.fixture.stationId.toString());
    const bool = list.points.find((p) => p.niagaraHistoryName === name("bool_as_temp"))!;
    expect(bool.pointRole).toBe(ROLES.sat);
    expect(bool.plausibility).toMatchObject({ state: "not_checked", notCheckedReason: "state_type" });
    expect(bool.plausibility.thresholdHours).toBeNull();
    expect(bool.plausibility.flatHours).toBeNull();
    expect(NOT_CHECKED_WORDS.state_type).toBe("state point");
    expect(describePlausibility(bool.plausibility, null)).toEqual({
      label: "Not checked",
      detail: "state point",
      tone: "neutral",
    });
  });

  it("an enum point given a temperature role is not judged either", async () => {
    const result = await health();
    expect(result.plausibility.flat.map((p) => p.pointName)).not.toContain(name("enum_as_temp"));

    const list = await getStationPoints(viewer, seeded.fixture.stationId.toString());
    const text = list.points.find((p) => p.niagaraHistoryName === name("enum_as_temp"))!;
    expect(text.plausibility).toMatchObject({ state: "not_checked", notCheckedReason: "state_type" });
  });

  it("the type gate sits AFTER the role gates: a boolean with no role or a status role keeps its reason", async () => {
    // fanCmd is bool with a status role; fanStatus is bool with a status
    // role; neither changes. On live this is what keeps every existing
    // verdict's wording as it was, and "role not set" the door to the picker.
    const list = await getStationPoints(viewer, seeded.fixture.stationId.toString());
    const cmd = list.points.find((p) => p.niagaraHistoryName === "AHU$2d1_FanCmd")!;
    expect(cmd.plausibility.notCheckedReason).toBe("state");
    const status = list.points.find((p) => p.niagaraHistoryName === "AHU$2d1_FanStatus")!;
    expect(status.plausibility.notCheckedReason).toBe("state");
  });

  it("counts the exclusions by reason, over active points only", async () => {
    const result = await health();
    // satSp; fanCmd and fanStatus (fixture) plus site B's bOk is a role with
    // interval 900 - the fixture's roles: sat (temperature), satSp, fanCmd,
    // fanStatus (status). unknown and bUnknown have no role. bool_as_temp and
    // enum_as_temp carry a temperature role on a state type.
    expect(result.plausibility.notChecked.setpoint).toBe(1);
    expect(result.plausibility.notChecked.state).toBe(2);
    expect(result.plausibility.notChecked.state_type).toBe(2);
    expect(result.plausibility.notChecked.no_role).toBe(2);
    expect(result.plausibility.notChecked.no_threshold).toBe(0);
    // Inactive points are outside every active figure, this one included.
    expect(result.plausibility.notChecked.not_collected).toBe(0);
  });

  it("an uncollected point is 'not checked, not collected' on the Points list, and absent from the card", async () => {
    const list = await getStationPoints(viewer, seeded.fixture.stationId.toString());
    const off = list.points.find((p) => p.niagaraHistoryName === name("off_temp"))!;
    expect(off.plausibility).toMatchObject({ state: "not_checked", notCheckedReason: "not_collected" });

    const result = await health();
    expect(result.plausibility.flat.map((p) => p.pointName)).not.toContain(name("off_temp"));
  });
});

// ---------------------------------------------------------------------------
// 2. Both fault shapes
// ---------------------------------------------------------------------------

describe("the two fault shapes", () => {
  it("flags exactly the expected points, longest flat first", async () => {
    const result = await health();
    const flagged = result.plausibility.flat.map((p) => p.pointName);
    expect([...flagged].sort()).toEqual(FLAGGED.map(name).sort());
    expect(result.totals.pointsFlat).toBe(FLAGGED.length);

    const hours = result.plausibility.flat.map((p) => p.plausibility.flatHours ?? -1);
    expect(hours).toEqual([...hours].sort((a, b) => b - a));
    expect(flagged[0]).toBe(name("lookback_temp"));
  });

  it("a step then a flat line: -40 since 8 h ago, last different 76.1", async () => {
    const result = await health();
    const p = result.plausibility.flat.find((f) => f.pointName === name("stuck_temp"))!.plausibility;
    expect(p.state).toBe("flat");
    expect(p.trendKind).toBe("interval");
    expect(p.measurement).toBe("temperature");
    expect(p.thresholdHours).toBe(6);
    expect(p.value).toEqual({ num: -40, bool: null, str: null });
    expect(p.readings).toBe(33);
    expect(p.flatHours).toBeCloseTo(8, 3);
    expect(p.flatSince).toBe(new Date(seeded.now.getTime() - 8 * HOUR).toISOString());
    expect(p.flatUntil).toBe(seeded.now.toISOString());
    expect(p.lastDifferentAt).toBe(new Date(seeded.now.getTime() - (8 * HOUR + 15 * MINUTE)).toISOString());
    expect(p.lastDifferentValue).toEqual({ num: 76.1, bool: null, str: null });
    expect(p.runIsWholeHistory).toBe(false);
    expect(p.lookbackExhausted).toBe(false);
  });

  it("a flat line with no step: never different in the readings held", async () => {
    const result = await health();
    const p = result.plausibility.flat.find((f) => f.pointName === name("whole_temp"))!.plausibility;
    expect(p.state).toBe("flat");
    expect(p.value?.num).toBe(70.5);
    expect(p.readings).toBe(30);
    expect(p.flatHours).toBeCloseTo(7.25, 3);
    expect(p.lastDifferentAt).toBeNull();
    expect(p.lastDifferentValue).toBeNull();
    expect(p.runIsWholeHistory).toBe(true);
    expect(p.lookbackExhausted).toBe(false);
  });

  it("a run of empty records is flat at 'no value'", async () => {
    const result = await health();
    const p = result.plausibility.flat.find((f) => f.pointName === name("empty_temp"))!.plausibility;
    expect(p.state).toBe("flat");
    expect(p.value).toEqual({ num: null, bool: null, str: null });
    expect(p.readings).toBe(30);
  });

  it("a live sensor is 'changing' with the facts still carried", async () => {
    const list = await getStationPoints(viewer, seeded.fixture.stationId.toString());
    const p = list.points.find((x) => x.niagaraHistoryName === name("moving_temp"))!.plausibility;
    expect(p.state).toBe("moving");
    expect(p.readings).toBe(1);
    expect(p.flatHours).toBe(0);
    expect(p.thresholdHours).toBe(6);
    expect(describePlausibility(p, "fahrenheit").label).toBe("Changing");
  });
});

// ---------------------------------------------------------------------------
// 3. Per kind
// ---------------------------------------------------------------------------

describe("thresholds are per kind of measurement", () => {
  it("the same four-hour run is changing for a temperature and flat for a pressure", async () => {
    const list = await getStationPoints(viewer, seeded.fixture.stationId.toString());
    const temp = list.points.find((x) => x.niagaraHistoryName === name("short_temp"))!.plausibility;
    const pressure = list.points.find((x) => x.niagaraHistoryName === name("flat_pressure"))!.plausibility;

    expect(temp.flatHours).toBeCloseTo(4, 3);
    expect(pressure.flatHours).toBeCloseTo(4, 3);
    expect(temp).toMatchObject({ state: "moving", thresholdHours: 6, measurement: "temperature" });
    expect(pressure).toMatchObject({ state: "flat", thresholdHours: 3, measurement: "pressure" });
  });

  it("an output gets a week: five days flat is changing, eight is flat", async () => {
    const list = await getStationPoints(viewer, seeded.fixture.stationId.toString());
    const five = list.points.find((x) => x.niagaraHistoryName === name("pos_5d"))!.plausibility;
    const eight = list.points.find((x) => x.niagaraHistoryName === name("pos_8d"))!.plausibility;
    expect(five).toMatchObject({ state: "moving", thresholdHours: 168, measurement: "position" });
    expect(eight).toMatchObject({ state: "flat", thresholdHours: 168 });
    expect(eight.flatHours).toBeCloseTo(8 * 24, 3);
  });

  it("every threshold clears the longest healthy run measured live, and is visible on screen", () => {
    // The healthy maxima from the live survey of 2026-09-28 (docs/bas-plausibility-verification.md).
    expect(thresholdFor("temperature")!.hours).toBeGreaterThan(1.8);
    expect(thresholdFor("pressure")!.hours).toBeGreaterThan(0.1);
    expect(thresholdFor("speed")!.hours).toBeGreaterThan(2.2);
    // The brief: six hours flat is broken for a pressure, so the alarm is under it.
    expect(thresholdFor("pressure")!.hours).toBeLessThan(6);
    expect(thresholdFor("pressure")!.hours).toBeLessThan(thresholdFor("temperature")!.hours);

    const line = describeThresholds();
    for (const t of PLAUSIBILITY_THRESHOLDS) expect(line).toContain(t.measurement);
    expect(line).toContain(`at least ${MIN_READINGS} readings`);
    expect(line).toContain("Setpoints, status and command points, and points with no role are not judged");
    for (const t of PLAUSIBILITY_THRESHOLDS) expect(t.why.length).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// 4. Minimum readings
// ---------------------------------------------------------------------------

describe("the minimum-readings guard", () => {
  it("three readings are not stuck, and neither are five spread over ten hours", async () => {
    const list = await getStationPoints(viewer, seeded.fixture.stationId.toString());
    const few = list.points.find((x) => x.niagaraHistoryName === name("few_temp"))!.plausibility;
    const sparse = list.points.find((x) => x.niagaraHistoryName === name("sparse_temp"))!.plausibility;
    expect(few).toMatchObject({ state: "too_few_readings", readings: 3, flatHours: null });
    expect(sparse).toMatchObject({ state: "too_few_readings", readings: 5, flatHours: null });
    expect(describePlausibility(few, null)).toEqual({
      label: "Too few readings",
      detail: `3 of the ${MIN_READINGS} needed`,
      tone: "neutral",
    });

    const result = await health();
    expect(result.plausibility.flat.map((p) => p.pointName)).not.toContain(name("sparse_temp"));
  });

  it("the guard sits under every threshold, so it can never hide a point a threshold would flag", () => {
    // MIN_READINGS at the coarsest interval in use (15 min) is 3 h; the
    // shortest threshold is 3 h. Twelve readings at any interval up to 15
    // minutes span no more than the smallest threshold.
    const shortest = Math.min(...PLAUSIBILITY_THRESHOLDS.map((t) => t.hours));
    expect((MIN_READINGS * 900) / 3600).toBeLessThanOrEqual(shortest);
  });
});

// ---------------------------------------------------------------------------
// 5. Change-of-value
// ---------------------------------------------------------------------------

describe("change-of-value trends", () => {
  it("no new record since the last change, and the collector has passed since: flat to that pass", async () => {
    const result = await health();
    const p = result.plausibility.flat.find((f) => f.pointName === name("cov_temp"))!.plausibility;
    expect(p.trendKind).toBe("cov");
    expect(p.readings).toBe(MIN_READINGS);
    expect(p.flatSince).toBe(new Date(seeded.now.getTime() - 10 * HOUR).toISOString());
    expect(p.flatUntil).toBe(seeded.covLastRunAt.toISOString());
    expect(p.flatHours).toBeCloseTo(10 - 5 / 60, 3);
    expect(p.lastDifferentAt).toBe(new Date(seeded.now.getTime() - 46 * HOUR).toISOString());
  });

  it("a stalled collector is not a dead sensor: measured to the last record, never to now()", async () => {
    const list = await getStationPoints(viewer, seeded.fixture.stationId.toString());
    const p = list.points.find((x) => x.niagaraHistoryName === name("cov_stalled"))!.plausibility;
    expect(p.trendKind).toBe("cov");
    expect(p.state).toBe("moving");
    expect(p.flatUntil).toBe(new Date(seeded.now.getTime() - 10 * HOUR).toISOString());
    expect(p.flatHours).toBe(0);
  });

  it("the guard counts the window, not the run, for a change-of-value point", async () => {
    const list = await getStationPoints(viewer, seeded.fixture.stationId.toString());
    const p = list.points.find((x) => x.niagaraHistoryName === name("cov_few"))!.plausibility;
    expect(p).toMatchObject({ state: "too_few_readings", trendKind: "cov", readings: 3 });
  });
});

// ---------------------------------------------------------------------------
// 6. What it must not do
// ---------------------------------------------------------------------------

describe("what the check must not do", () => {
  it("deactivates nothing and modifies no reading", async () => {
    const before = await testDb.$queryRaw<Array<{ readings: bigint; active: bigint; sum: number }>>`
      SELECT (SELECT count(*) FROM bas_readings) AS readings,
             (SELECT count(*) FROM bas_points WHERE is_active) AS active,
             (SELECT coalesce(sum(value_num), 0)::float8 FROM bas_readings) AS sum`;
    await health();
    await getStationPoints(viewer, seeded.fixture.stationId.toString());
    const after = await testDb.$queryRaw<Array<{ readings: bigint; active: bigint; sum: number }>>`
      SELECT (SELECT count(*) FROM bas_readings) AS readings,
             (SELECT count(*) FROM bas_points WHERE is_active) AS active,
             (SELECT coalesce(sum(value_num), 0)::float8 FROM bas_readings) AS sum`;
    expect(after).toEqual(before);
  });

  it("contains no write, in the module or in the query that carries it (source text)", async () => {
    const moduleSource =
      (await readFile(path.join(process.cwd(), "lib/modules/bas/plausibility.ts"), "utf8")) +
      (await readFile(path.join(process.cwd(), "lib/modules/bas/plausibility-sql.ts"), "utf8"));
    const service = await readFile(path.join(process.cwd(), "lib/modules/bas/service.ts"), "utf8");
    const loader = service.slice(
      service.indexOf("async function loadPlausibilityRows"),
      service.indexOf("function summarisePlausibility"),
    );
    expect(loader.length).toBeGreaterThan(100);
    for (const [label, text] of [["plausibility.ts", moduleSource], ["loadPlausibilityRows", loader]] as const) {
      expect(text, `${label} writes`).not.toMatch(/\b(UPDATE|DELETE|INSERT|TRUNCATE)\b/);
      expect(text, `${label} touches is_active`).not.toMatch(/is_active\s*=/);
      expect(text, `${label} uses the Prisma write API`).not.toMatch(/\.(update|delete|create)(Many)?\(/);
    }
  });

  it("a flagged point stays in every collection figure", async () => {
    const result = await health();
    const flagged = new Set(result.plausibility.flat.map((p) => p.pointId));
    // Every flagged active point is still a row of the per-point list the
    // tiles are computed over, with its own risk and completeness untouched.
    for (const id of flagged) {
      const row = result.points.find((p) => p.pointId === id);
      expect(row, `flagged point ${id} left the per-point list`).toBeDefined();
    }
    const inDatabase = await testDb.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM bas_v_collection_health WHERE is_active`;
    expect(result.totals.activePoints).toBe(inDatabase[0]!.n);
    expect(result.points.length).toBe(inDatabase[0]!.n);
  });

  it("a hidden flagged point is listed, counted, and says it is hidden", async () => {
    const result = await health();
    const hidden = result.plausibility.flat.find((p) => p.pointName === name("hidden_temp"));
    expect(hidden).toBeDefined();
    expect(hidden!.visible).toBe(false);
    expect(result.totals.pointsFlat).toBe(FLAGGED.length);

    const html = renderToStaticMarkup(createElement(StuckCard, { health: result, suffix: "" }));
    expect(html).toContain(name("hidden_temp"));
    expect(html).toContain("hidden from the browsing screens, still collected");
  });

  it("presents a flag as something to look at, never as a confirmed fault", async () => {
    const result = await health();
    const sentence = describeStuck(result.plausibility, "");
    expect(sentence).toContain("This looks wrong and is not confirmed: go and look at the sensor.");
    expect(sentence).not.toMatch(/dead|broken|failed/i);
    const html = renderToStaticMarkup(createElement(StuckCard, { health: result, suffix: "" }));
    expect(html).not.toMatch(/confirmed fault|sensor is dead/i);
  });
});

// ---------------------------------------------------------------------------
// 7. SQL and TypeScript agree on every role in the vocabulary
// ---------------------------------------------------------------------------

describe("the SQL decision and the TypeScript reason agree", () => {
  it("on every role in prisma/bas-vocabularies.ts, and on the fixture's", async () => {
    const roles = [
      ...BAS_POINT_ROLES.map((r) => ({
        pointRole: r.pointRole,
        measurement: r.measurement,
        isSetpoint: r.isSetpoint ?? false,
      })),
      { pointRole: ROLES.sat, measurement: "temperature", isSetpoint: false },
      { pointRole: ROLES.satSp, measurement: "temperature", isSetpoint: true },
      { pointRole: ROLES.fanCmd, measurement: "status", isSetpoint: false },
      { pointRole: ROLE_PRESSURE, measurement: "pressure", isSetpoint: false },
      { pointRole: ROLE_POSITION, measurement: "position", isSetpoint: false },
    ];
    expect(roles.length).toBeGreaterThan(90);

    let checked = 0;
    for (const role of roles) {
      const sql = await testDb.$queryRaw<Array<{ checked: boolean | null }>>`
        SELECT ${checkedRoleSql(Prisma.sql`pr`)} AS checked
          FROM (VALUES (${role.measurement}::text, ${role.isSetpoint}::boolean)) AS pr(measurement, is_setpoint)`;
      const sqlChecked = sql[0]!.checked === true;

      const row: PlausibilityRow = {
        is_active: true,
        data_type: "real",
        point_role: role.pointRole,
        role_is_setpoint: role.isSetpoint,
        role_measurement: role.measurement,
        collection_interval_s: 900,
        last_run_at: null,
        last_status: null,
        pl_checked: sqlChecked ? true : null,
        pl_last_ts: null,
        pl_value_num: null,
        pl_value_bool: null,
        pl_value_str: null,
        pl_diff_ts: null,
        pl_diff_num: null,
        pl_diff_bool: null,
        pl_diff_str: null,
        pl_run_readings: null,
        pl_flat_since: null,
        pl_history_start: null,
        pl_window_readings: null,
      };
      // Must not throw: throwing is how the judge reports a disagreement.
      const verdict = judgePlausibility(row);
      expect(verdict.state === "not_checked", `${role.pointRole}: SQL ${sqlChecked}, TS ${verdict.state}`).toBe(
        !sqlChecked,
      );
      if (sqlChecked) checked += 1;
      else expect(NOT_CHECKED_REASONS).toContain(verdict.notCheckedReason);
    }
    // The office's checked roles are among them.
    expect(checked).toBeGreaterThan(30);
  });

  it("on every declared type: bool, str and enum are refused by both halves, real and int by neither", async () => {
    // Every value the CHECK on bas_points.data_type admits, each against a
    // role that WOULD be judged. The SQL half and the TypeScript half must
    // agree, and the state types must land on the one reason made for them.
    const types = ["real", "int", "bool", "str", "enum", "abstime", "unknown"];
    for (const dataType of types) {
      const sql = await testDb.$queryRaw<Array<{ checked: boolean | null }>>`
        SELECT ${checkedTypeSql(Prisma.sql`p`)} AS checked
          FROM (VALUES (${dataType}::text)) AS p(data_type)`;
      const sqlChecked = sql[0]!.checked === true;
      expect(sqlChecked, dataType).toBe(!STATE_DATA_TYPES.includes(dataType));

      const verdict = judgePlausibility({
        is_active: true,
        data_type: dataType,
        point_role: ROLES.sat,
        role_is_setpoint: false,
        role_measurement: "temperature",
        collection_interval_s: 900,
        last_run_at: null,
        last_status: null,
        pl_checked: sqlChecked ? true : null,
        pl_last_ts: null,
        pl_value_num: null,
        pl_value_bool: null,
        pl_value_str: null,
        pl_diff_ts: null,
        pl_diff_num: null,
        pl_diff_bool: null,
        pl_diff_str: null,
        pl_run_readings: null,
        pl_flat_since: null,
        pl_history_start: null,
        pl_window_readings: null,
      });
      if (STATE_DATA_TYPES.includes(dataType)) {
        expect(verdict, dataType).toMatchObject({ state: "not_checked", notCheckedReason: "state_type" });
      } else {
        // Checked, with nothing to judge yet: the role gate let it through.
        expect(verdict.state, dataType).toBe("too_few_readings");
      }
    }
    expect(STATE_DATA_TYPES).toEqual(["bool", "str", "enum"]);
  });

  it("every measurement kind in the vocabulary is either judged, a state word, or absent on purpose", () => {
    const kinds = new Set(BAS_POINT_ROLES.map((r) => r.measurement));
    const unaccounted = [...kinds].filter(
      (k) => k !== null && thresholdFor(k) === null && !STATE_MEASUREMENTS.includes(k),
    );
    // Add a kind to the vocabulary and it lands here until somebody decides
    // whether it moves - a decision, not a default.
    expect(unaccounted).toEqual([]);
    // The one role with no measurement at all is `unclassified`: reviewed and
    // not mappable, and never judged.
    expect(BAS_POINT_ROLES.filter((r) => r.measurement === null).map((r) => r.pointRole)).toEqual([
      "unclassified",
    ]);
  });

  it("the judge refuses a row the two halves disagree on", () => {
    const base: PlausibilityRow = {
      is_active: true,
      data_type: "real",
      point_role: "x",
      role_is_setpoint: true,
      role_measurement: "temperature",
      collection_interval_s: 900,
      last_run_at: null,
      last_status: null,
      pl_checked: true,
      pl_last_ts: null,
      pl_value_num: null,
      pl_value_bool: null,
      pl_value_str: null,
      pl_diff_ts: null,
      pl_diff_num: null,
      pl_diff_bool: null,
      pl_diff_str: null,
      pl_run_readings: null,
      pl_flat_since: null,
      pl_history_start: null,
      pl_window_readings: null,
    };
    expect(() => judgePlausibility(base)).toThrow(/SQL evaluated a point TypeScript would not check/);
    expect(() =>
      judgePlausibility({ ...base, role_is_setpoint: false, pl_checked: null }),
    ).toThrow(/SQL did not evaluate a point TypeScript expected to check/);
  });
});

// ---------------------------------------------------------------------------
// The lookback bound, the filter, and the two screens
// ---------------------------------------------------------------------------

describe("the lookback bound", () => {
  it("reports a floor, not a false precise figure, when no different value is inside it", async () => {
    const result = await health();
    const p = result.plausibility.flat.find((f) => f.pointName === name("lookback_temp"))!.plausibility;
    expect(p.lookbackExhausted).toBe(true);
    expect(p.runIsWholeHistory).toBe(false);
    expect(p.lastDifferentAt).toBeNull();
    expect(p.readings).toBe(15);
    expect(p.flatHours).toBeCloseTo(14 * 6 * 24, 3);
    expect(p.flatHours! / 24).toBeLessThan(LOOKBACK_DAYS);

    const html = renderToStaticMarkup(createElement(StuckCard, { health: result, suffix: "" }));
    expect(html).toContain("at least 84.0 days");
    expect(html).toContain(`no different value in the last ${LOOKBACK_DAYS} days of readings`);
  });
});

describe("the building filter", () => {
  it("scopes the card and still says what is outside it", async () => {
    const result = await health({ siteId: seeded.fixture.siteId });
    const flagged = result.plausibility.flat.map((p) => p.pointName);
    expect(flagged).not.toContain(name("b_temp"));
    expect(result.totals.pointsFlat).toBe(FLAGGED.length - 1);
    expect(result.unfiltered?.pointsFlat).toBe(FLAGGED.length);

    const html = renderToStaticMarkup(
      createElement(StuckCard, { health: result, suffix: ` in ${result.scope.label}` }),
    );
    expect(html).toContain("1 more outside");
  });
});

describe("the Collection Health card", () => {
  it("names each flagged point with how long, at what, since when, and last different", async () => {
    const result = await health();
    const html = renderToStaticMarkup(createElement(StuckCard, { health: result, suffix: "" }));

    expect(html).toContain("Values that have stopped changing");
    expect(html).toContain(`${FLAGGED.length} of ${result.plausibility.checked} checked points`);
    expect(html).toContain(name("stuck_temp"));
    expect(html).toContain("flat 8.0 h at -40.00 °F");
    expect(html).toContain("last different 76.10 °F at");
    expect(html).toContain("33 identical readings");
    expect(html).toContain("threshold 6.0 h for temperature");
    expect(html).toContain("never different in the 30 readings held");
    expect(html).toContain("threshold 3.0 h for pressure");
    expect(html).toContain("change-of-value trend: no new record since");
    expect(html).toContain("at no value");
    // The exclusions, counted and worded; the thresholds, on the card.
    expect(html).toContain("1 setpoint");
    expect(html).toContain("2 with no role");
    expect(html).toContain("2 status or command points");
    expect(html).toContain("Flat for at least");
  });

  it("is the loud half of a check: the full card from FailedChecks when something is flagged, and off the passed line", async () => {
    // Landed under the quiet-UI rules (2026-10-01): the card renders only
    // when the check fails, and the check is decided in one place.
    const result = await health();
    expect(evaluateChecks(result).stuckOk).toBe(false);
    const failed = renderToStaticMarkup(createElement(FailedChecks, { health: result, suffix: "" }));
    expect(failed).toContain("Values that have stopped changing");
    expect(failed).toContain(name("stuck_temp"));
    expect(failed).toContain("flat 8.0 h at -40.00 °F");
    const passed = renderToStaticMarkup(createElement(PassedChecks, { health: result, suffix: "" }));
    expect(passed).not.toContain("values still changing");
  });

  it("is rendered at zero, and says how many were judged", () => {
    const zero = {
      checked: 5,
      moving: 5,
      tooFewReadings: 0,
      notChecked: { not_collected: 0, no_role: 3, setpoint: 0, state: 0, state_type: 0, no_threshold: 0 },
      flat: [],
    };
    expect(describeStuck(zero, "")).toBe("Every checked point is still changing value - 5 points judged.");
    expect(describeStuck({ ...zero, checked: 0, moving: 0 }, "")).toContain("No point was checked");
  });
});

describe("the Points list", () => {
  it("shows the state per point, with the reason when not checked", async () => {
    const list = await getStationPoints(viewer, seeded.fixture.stationId.toString());
    const html = renderToStaticMarkup(
      createElement(PointsTable, { list, expectedTotal: list.pointsAccountedFor.inDatabase }),
    );
    expect(html).toContain(">Value<");
    expect(html).toContain("Flat 8.0 h at -40.00 °F");
    expect(html).toContain("threshold 6.0 h for temperature");
    expect(html).toContain("Flat 4.0 h at 1.25 inH₂O");
    expect(html).toContain("Not checked</span><span class=\"text-[var(--muted)]\"> · setpoint");
    expect(html).toContain("Not checked</span><span class=\"text-[var(--muted)]\"> · role not set");
    expect(html).toContain("Not checked</span><span class=\"text-[var(--muted)]\"> · status or command point");
    expect(html).toContain("Not checked</span><span class=\"text-[var(--muted)]\"> · not collected");
    expect(html).toContain(">Changing<");
    expect(html).toContain(`Too few readings</span><span class="text-[var(--muted)]"> · 3 of the ${MIN_READINGS} needed`);
    // Every row is still drawn: the column changes nothing about the list's guard.
    expect(list.pointsAccountedFor.rendered).toBe(list.pointsAccountedFor.inDatabase);
  });

  it("agrees with Collection Health on every point", async () => {
    const result = await health();
    const list = await getStationPoints(viewer, seeded.fixture.stationId.toString());
    const flaggedIds = new Set(result.plausibility.flat.map((p) => p.pointId));
    for (const point of list.points) {
      expect(point.plausibility.state === "flat", point.niagaraHistoryName).toBe(flaggedIds.has(point.pointId));
    }
  });
});
