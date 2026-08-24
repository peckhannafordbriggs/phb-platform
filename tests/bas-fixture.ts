import { testDb } from "./db";

/**
 * Fixtures for the BAS schema tests.
 *
 * Every test runs inside a transaction that is always rolled back. That is not
 * tidiness - `bas_readings` is the one table in this database whose rows cannot
 * be re-fetched from anywhere (docs/runbook.md, *BAS irreplaceability*), so the
 * BAS suite is written so that it cannot leave a row behind even if it throws
 * halfway through. It also means the tests do not care what is already in the
 * database, and `tests/db.ts` `resetDb()` is not involved at all.
 *
 * The vocabulary rows are prefixed `zztest_` rather than reusing the real role
 * names. Two reasons: the test database has **no** point roles at all (the
 * vocabulary is imported by `scripts/bas-import.ts`, not created by a migration
 * or the seed), and a fixture that invented `supply_air_temp` would collide the
 * day someone imports the real vocabulary here. Nothing in the views keys on a
 * role NAME - they follow `setpoint_for` and `status_of` - so a made-up
 * vocabulary exercises them exactly as a real one would.
 */

/** Thrown to roll a fixture transaction back. Never escapes `inRollback`. */
class Rollback extends Error {
  constructor() {
    super("bas fixture rollback");
    this.name = "Rollback";
  }
}

export type Tx = Parameters<Parameters<typeof testDb.$transaction>[0]>[0];

/**
 * Runs `fn` in a transaction and rolls it back, whatever happens.
 *
 * Assertions belong INSIDE `fn`: a failing expectation propagates out after the
 * rollback, so the test fails with its own message and the database is still
 * untouched.
 */
export async function inRollback(
  fn: (tx: Tx) => Promise<void>,
): Promise<void> {
  try {
    await testDb.$transaction(
      async (tx) => {
        await fn(tx);
        throw new Rollback();
      },
      { timeout: 25_000, maxWait: 10_000 },
    );
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

/**
 * Runs `fn` in a transaction that is expected to fail, and hands back the error.
 *
 * A constraint violation aborts the whole transaction in PostgreSQL, so the
 * failing statement has to be the last one - which is why this is separate from
 * `inRollback` rather than a flag on it.
 *
 * The Rollback throw is not redundant. Without it, a body that unexpectedly
 * SUCCEEDS commits its fixture, and the next test's fixture then fails on a
 * unique constraint - so one real regression becomes a dozen confusing failures
 * and the test database keeps `bas_readings` rows it should never have kept.
 * Found by deliberately dropping bas_readings_at_most_one_value and watching
 * fifteen tests fail instead of four.
 */
export async function expectRejection(
  fn: (tx: Tx) => Promise<void>,
): Promise<Error> {
  const unexpectedSuccess = new Error(
    "Expected the transaction to fail, and it succeeded. " +
      "The constraint or trigger under test is probably missing.",
  );

  try {
    await testDb.$transaction(
      async (tx) => {
        await fn(tx);
        throw new Rollback();
      },
      { timeout: 25_000, maxWait: 10_000 },
    );
  } catch (error) {
    if (error instanceof Rollback) throw unexpectedSuccess;
    return error as Error;
  }

  throw unexpectedSuccess;
}

export interface BasFixture {
  orgId: bigint;
  siteId: bigint;
  stationId: bigint;
  equipmentId: bigint;
  /** Supply air temperature. capacity 500 x interval 900 = 450000s horizon. */
  sat: bigint;
  /** Its setpoint, same equipment, same unit. */
  satSp: bigint;
  fanCmd: bigint;
  fanStatus: bigint;
  /** No role, no capacity, no interval - so no roll horizon either. */
  unknown: bigint;
}

const ROLE_SAT = "zztest_supply_air_temp";
const ROLE_SAT_SP = "zztest_supply_air_temp_sp";
const ROLE_FAN_CMD = "zztest_supply_fan_cmd";
const ROLE_FAN_STATUS = "zztest_supply_fan_status";
const EQUIP_TYPE = "zztest_ahu";

export const ROLES = {
  sat: ROLE_SAT,
  satSp: ROLE_SAT_SP,
  fanCmd: ROLE_FAN_CMD,
  fanStatus: ROLE_FAN_STATUS,
  equipType: EQUIP_TYPE,
} as const;

/** America/New_York, so the DST assertions in bas-views.test.ts have teeth. */
export const SITE_TIMEZONE = "America/New_York";
export const SITE_NAME = "ZZTEST_SITE";
export const EQUIPMENT_NAME = "AHU-ZZTEST";

export async function createBasFixture(tx: Tx): Promise<BasFixture> {
  const org = await tx.basOrg.create({ data: { name: "ZZTEST_ORG" } });
  const site = await tx.basSite.create({
    data: { orgId: org.orgId, name: SITE_NAME, timezone: SITE_TIMEZONE },
  });
  const station = await tx.basStation.create({
    data: { siteId: site.siteId, niagaraStationName: "ZZTestStation" },
  });

  await tx.basEquipmentType.create({
    data: {
      equipType: EQUIP_TYPE,
      displayName: "Air Handling Unit (test)",
      description: "Fixture equipment type.",
      category: "air_side",
    },
  });
  const equipment = await tx.basEquipment.create({
    data: {
      siteId: site.siteId,
      name: EQUIPMENT_NAME,
      equipType: EQUIP_TYPE,
    },
  });

  // Order matters: the referenced role has to exist before the role that points
  // at it, because setpoint_for and status_of are self-referencing FKs.
  await tx.basPointRole.create({
    data: {
      pointRole: ROLE_SAT,
      displayName: "Supply air temperature (test)",
      description: "Fixture measurement.",
      measurement: "temperature",
      typicalUnit: "fahrenheit",
    },
  });
  await tx.basPointRole.create({
    data: {
      pointRole: ROLE_SAT_SP,
      displayName: "Supply air temperature setpoint (test)",
      description: "Fixture setpoint.",
      measurement: "temperature",
      typicalUnit: "fahrenheit",
      isSetpoint: true,
      setpointFor: ROLE_SAT,
    },
  });
  await tx.basPointRole.create({
    data: {
      pointRole: ROLE_FAN_CMD,
      displayName: "Supply fan command (test)",
      description: "Fixture command.",
      measurement: "status",
      isCommand: true,
    },
  });
  await tx.basPointRole.create({
    data: {
      pointRole: ROLE_FAN_STATUS,
      displayName: "Supply fan status (test)",
      description: "Fixture proof-of-running.",
      measurement: "status",
      isStatus: true,
      statusOf: ROLE_FAN_CMD,
    },
  });

  const point = async (
    historyName: string,
    role: string | null,
    unit: string | null,
    dataType: string,
    capacity: number | null = 500,
    intervalS: number | null = 900,
  ) =>
    (
      await tx.basPoint.create({
        data: {
          stationId: station.stationId,
          equipmentId: equipment.equipmentId,
          // $2d is a Niagara hex escape for a dash, stored verbatim. Decoding it
          // is not round-trippable and produces 404s - see docs/08.
          niagaraHistoryName: historyName,
          displayName: historyName.replace(/\$2d/g, "-"),
          pointRole: role,
          unit,
          dataType,
          capacity,
          collectionIntervalS: intervalS,
          fullPolicy: "roll",
        },
      })
    ).pointId;

  return {
    orgId: org.orgId,
    siteId: site.siteId,
    stationId: station.stationId,
    equipmentId: equipment.equipmentId,
    sat: await point("AHU$2d1_SupplyAirTemp", ROLE_SAT, "fahrenheit", "real"),
    satSp: await point(
      "AHU$2d1_SupplyAirTempSp",
      ROLE_SAT_SP,
      "fahrenheit",
      "real",
    ),
    fanCmd: await point("AHU$2d1_FanCmd", ROLE_FAN_CMD, null, "bool"),
    fanStatus: await point("AHU$2d1_FanStatus", ROLE_FAN_STATUS, null, "bool"),
    unknown: await point("AHU$2d1_Unknown", null, null, "real", null, null),
  };
}

/** `SELECT count(*)::int` - raw count(*) comes back as a BigInt. */
export async function countRows(tx: Tx, sql: string): Promise<number> {
  const rows = await tx.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM ${sql}`,
  );
  return rows[0]?.n ?? -1;
}

/**
 * The same fixture, COMMITTED, plus the operational rows Collection Health
 * reads: checkpoints, readings, collector runs and a recorded gap.
 *
 * Committed rather than rolled back, and that is a deliberate exception to the
 * rule at the top of this file. `lib/modules/bas/service.ts` reads through the
 * application's own `prisma` client on its own connection, so a fixture held
 * open inside an uncommitted transaction is invisible to it - a service test
 * built on `inRollback` would assert against an empty database and pass.
 *
 * The safety the rollback bought is replaced by `cleanup()` in a `finally`, and
 * by `expectBasTablesEmpty()`, which refuses to start if a previous run left
 * anything behind. `bas_readings` in the TEST database is not irreplaceable -
 * it is five rows this function wrote - but leaving rows there would silently
 * corrupt every count the next test asserts.
 */
export interface HealthFixture extends BasFixture {
  /** now(), captured once so every offset below is relative to one instant. */
  now: Date;
  runIds: bigint[];
  cleanup: () => Promise<void>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Fails loudly rather than letting leftover rows corrupt a count. */
export async function expectBasTablesEmpty(): Promise<void> {
  const rows = await testDb.$queryRaw<Array<{ n: number }>>`
    SELECT
      (SELECT count(*) FROM bas_points)
    + (SELECT count(*) FROM bas_readings)
    + (SELECT count(*) FROM bas_ingest_runs)
    + (SELECT count(*) FROM bas_data_gaps)
    + (SELECT count(*) FROM bas_orgs) AS n
  `;

  const n = Number(rows[0]?.n ?? -1);
  if (n !== 0) {
    throw new Error(
      `The test database has ${n} leftover bas_* rows. A previous run did not ` +
        `clean up, and every count in this file would be wrong. Clear them ` +
        `before re-running.`,
    );
  }
}

/**
 * Five active points, one per `roll_risk` state, plus four collector runs with
 * a deliberate hole in the middle.
 *
 * The risk states are produced by moving `last_record_ts`, never by writing
 * `roll_risk` - that column is computed by `bas_v_collection_health` and the
 * whole point of these tests is to check the view's arithmetic, not to restate
 * it. Horizon is capacity 500 x interval 900 = 450,000 s = 125 h, so half is
 * 62.5 h.
 */
export async function createHealthFixture(): Promise<HealthFixture> {
  const base = await testDb.$transaction(
    async (tx) => createBasFixture(tx as unknown as Tx),
    { timeout: 25_000, maxWait: 10_000 },
  );

  const now = new Date();
  const ago = (ms: number) => new Date(now.getTime() - ms);

  const checkpoint = (pointId: bigint, lastRecordTs: Date) =>
    testDb.basSyncCheckpoint.create({
      data: { pointId, lastRecordTs, lastRunAt: lastRecordTs, lastStatus: "ok" },
    });

  await checkpoint(base.sat, ago(5 * MINUTE)); // ok
  await checkpoint(base.satSp, ago(100 * HOUR)); // at_risk: past half of 125 h
  await checkpoint(base.fanCmd, ago(200 * HOUR)); // data_lost: past 125 h
  await checkpoint(base.unknown, ago(5 * MINUTE)); // roll_horizon_unknown
  // base.fanStatus gets no checkpoint at all -> never_collected.

  await testDb.basReading.createMany({
    data: [0, 15, 30].map((minutes) => ({
      pointId: base.sat,
      ts: ago(minutes * MINUTE + 5 * MINUTE),
      valueNum: 55 + minutes / 10,
    })),
  });

  const run = async (startedAgoMs: number, recordsWritten: number) =>
    (
      await testDb.basIngestRun.create({
        data: {
          stationId: base.stationId,
          startedAt: ago(startedAgoMs),
          finishedAt: ago(startedAgoMs - 30_000),
          status: "ok",
          pointsAttempted: 5,
          pointsSucceeded: 5,
          recordsWritten,
          collectorHost: "ZZTEST-HOST",
        },
      })
    ).runId;

  // 200 h and 190 h ago, then nothing for 164 h, then a backfill and a normal
  // run. The 164 h hole is longer than the 125 h horizon: the shape of the real
  // outage in the development database, where a closed laptop cost 64 h against
  // a 41.7 h horizon and the next run wrote 2,000 records catching up.
  //
  // The spacing is chosen so that each window says something different:
  //   1 day  -> one run, so there is no interval to measure at all
  //   7 days -> two runs, 6.25 h apart, comfortably inside the horizon
  //  30 days -> all four, and the 164 h hole
  const runIds = [
    await run(200 * HOUR, 12),
    await run(190 * HOUR, 12),
    await run(26 * HOUR, 2_000),
    await run(19 * HOUR + 45 * MINUTE, 12),
  ];

  await testDb.basDataGap.create({
    data: {
      pointId: base.sat,
      gapStart: ago(190 * HOUR),
      gapEnd: ago(167 * HOUR),
      cause: "roll_overwrite",
      notes: "ZZTEST fixture gap.",
    },
  });

  const cleanup = async () => {
    await testDb.basIngestRun.deleteMany({
      where: { stationId: base.stationId },
    });
    // Readings, checkpoints, gaps and links all cascade from bas_points.
    await testDb.basPoint.deleteMany({ where: { stationId: base.stationId } });
    await testDb.basStation.deleteMany({ where: { siteId: base.siteId } });
    await testDb.basEquipment.deleteMany({ where: { siteId: base.siteId } });
    await testDb.basSite.deleteMany({ where: { siteId: base.siteId } });
    await testDb.basOrg.deleteMany({ where: { orgId: base.orgId } });
    await testDb.basEquipmentType.deleteMany({
      where: { equipType: ROLES.equipType },
    });
    // setpoint_for and status_of are RESTRICT self-references, so the roles
    // that point at another role have to go first.
    await testDb.basPointRole.deleteMany({
      where: { pointRole: { in: [ROLES.satSp, ROLES.fanStatus] } },
    });
    await testDb.basPointRole.deleteMany({
      where: { pointRole: { in: [ROLES.sat, ROLES.fanCmd] } },
    });
  };

  return { ...base, now, runIds, cleanup };
}
