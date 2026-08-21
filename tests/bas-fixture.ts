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
