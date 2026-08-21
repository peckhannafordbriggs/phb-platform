import { afterAll, describe, expect, it } from "vitest";
import { disconnectDb } from "./db";
import {
  EQUIPMENT_NAME,
  ROLES,
  SITE_NAME,
  countRows,
  createBasFixture,
  inRollback,
  type Tx,
} from "./bas-fixture";

/**
 * The six `bas_v_*` views.
 *
 * Existence is not the failure mode - a view that exists but no longer runs is.
 * `CREATE VIEW` binds to the columns it selected, so dropping or renaming a
 * column underneath one leaves it in `information_schema.views` while every
 * `SELECT` from it raises. So every test here actually queries the view and
 * reads a row out of it.
 *
 * Ported from `C:\dev\bas-db\scripts\verify.py`. The views are the layer B3, B4
 * and B5 are built on, and Prisma does not model them at all.
 */

afterAll(async () => {
  await disconnectDb();
});

/** Populates the fixture with the readings and checkpoint the views need. */
async function withData(tx: Tx) {
  const f = await createBasFixture(tx);

  // Two instants chosen for the DST assertion: one in EST, one in EDT.
  await tx.$executeRaw`
    INSERT INTO bas_readings (point_id, ts, value_num)
    VALUES (${f.sat}, '2026-01-15T17:00:00Z', 55.0)`;
  await tx.$executeRaw`
    INSERT INTO bas_readings (point_id, ts, value_num)
    VALUES (${f.sat}, '2026-07-15T17:00:00Z', 70.0)`;
  await tx.$executeRaw`
    INSERT INTO bas_readings (point_id, ts, value_bool)
    VALUES (${f.fanCmd}, '2026-01-15T17:00:00Z', true)`;

  // now() inside a transaction is the transaction's start time, so the offsets
  // are computed in SQL rather than in JS - a JS clock skew of a few
  // milliseconds against Postgres would make the at_risk boundary flaky.
  await tx.$executeRaw`
    INSERT INTO bas_sync_checkpoints (point_id, last_record_ts, last_run_at, last_status)
    VALUES (${f.sat}, now() - interval '10 minutes', now(), 'ok')`;

  return f;
}

describe("every view runs and returns rows with the expected columns", () => {
  /**
   * The column lists are the ones B3, B4 and B5 will read. Asserted as a subset
   * rather than an exact match: adding a column to a view is normal, removing
   * one that a screen depends on is not.
   */
  const EXPECTED: Record<string, string[]> = {
    bas_v_point: [
      "point_id",
      "point_name",
      "point_role",
      "point_role_name",
      "measurement",
      "is_setpoint",
      "is_command",
      "is_status",
      "unit",
      "data_type",
      "equipment_id",
      "equipment_name",
      "site_id",
      "site_name",
      "site_timezone",
      "org_name",
      "station_id",
      "niagara_history_name",
      "collection_interval_s",
      "capacity",
      "full_policy",
      "roll_horizon_s",
      "is_active",
    ],
    bas_v_reading: [
      "ts",
      "ts_local",
      "local_hour",
      "local_dow",
      "value_num",
      "value_bool",
      "value_str",
      "status",
      "point_id",
      "point_name",
      "point_role",
      "unit",
      "equipment_name",
      "site_id",
      "site_name",
      "site_timezone",
    ],
    bas_v_setpoint_pair: [
      "equipment_id",
      "equipment_name",
      "site_id",
      "measured_point_id",
      "measured_role",
      "measured_unit",
      "setpoint_point_id",
      "setpoint_role",
      "setpoint_unit",
      "unit_mismatch",
    ],
    bas_v_command_status_pair: [
      "equipment_id",
      "equipment_name",
      "site_id",
      "command_point_id",
      "command_role",
      "status_point_id",
      "status_role",
    ],
    bas_v_collection_health: [
      "point_id",
      "point_name",
      "point_role",
      "equipment_name",
      "site_id",
      "site_name",
      "org_name",
      "station_id",
      "collection_interval_s",
      "capacity",
      "roll_horizon_s",
      "last_record_ts",
      "last_run_at",
      "last_status",
      "consecutive_failures",
      "seconds_since_last_record",
      "roll_risk",
    ],
    bas_v_data_dictionary: [
      "object_name",
      "object_type",
      "column_name",
      "data_type",
      "is_nullable",
      "column_description",
      "object_description",
    ],
  };

  for (const [view, columns] of Object.entries(EXPECTED)) {
    it(`${view} returns a row carrying its documented columns`, async () => {
      await inRollback(async (tx) => {
        await withData(tx);

        // SELECT *, so a column dropped out from under the view raises here
        // rather than being reported as absent.
        const rows = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
          `SELECT * FROM ${view} LIMIT 1`,
        );

        expect(rows.length, `${view} returned no rows`).toBe(1);
        for (const column of columns) {
          expect(
            Object.keys(rows[0] ?? {}),
            `${view} must expose ${column}`,
          ).toContain(column);
        }
      });
    });
  }

  it("bas_v_point carries the role vocabulary alongside the point", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      const rows = await tx.$queryRaw<
        Array<{
          point_name: string;
          point_role: string;
          measurement: string | null;
          is_setpoint: boolean;
          site_name: string;
          equipment_name: string | null;
          roll_horizon_s: number | null;
        }>
      >`SELECT point_name, point_role, measurement, is_setpoint, site_name,
               equipment_name, roll_horizon_s
          FROM bas_v_point WHERE point_id = ${f.satSp}`;

      // The join to bas_point_roles is what makes "compare supply air
      // temperature across all air handlers" a single generic query.
      expect(rows[0]?.point_role).toBe(ROLES.satSp);
      expect(rows[0]?.measurement).toBe("temperature");
      expect(rows[0]?.is_setpoint).toBe(true);
      expect(rows[0]?.site_name).toBe(SITE_NAME);
      expect(rows[0]?.equipment_name).toBe(EQUIPMENT_NAME);
      expect(rows[0]?.roll_horizon_s).toBe(450_000);
      // COALESCE(display_name, niagara_history_name) - the readable form.
      expect(rows[0]?.point_name).toBe("AHU-1_SupplyAirTempSp");
    });
  });
});

describe("bas_v_reading converts UTC to building-local time", () => {
  /**
   * docs/08's second invariant: every timestamp is `timestamptz` stored UTC, and
   * local time is display only, derived from the site's IANA zone. There is no
   * way to unwind a DST bug afterwards, so this is the test that matters most
   * about time.
   */
  it("renders a winter instant in EST (UTC-5)", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      const rows = await tx.$queryRaw<Array<{ local_hour: number }>>`
        SELECT local_hour FROM bas_v_reading
         WHERE point_id = ${f.sat} AND ts = '2026-01-15T17:00:00Z'`;

      expect(rows[0]?.local_hour).toBe(12);
    });
  });

  it("renders a summer instant in EDT (UTC-4), so DST is handled", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      const rows = await tx.$queryRaw<Array<{ local_hour: number }>>`
        SELECT local_hour FROM bas_v_reading
         WHERE point_id = ${f.sat} AND ts = '2026-07-15T17:00:00Z'`;

      // The same UTC hour, one hour later locally. A fixed offset would put both
      // at 12 and every occupancy question in July would be an hour out.
      expect(rows[0]?.local_hour).toBe(13);
    });
  });

  it("carries full context on every row, so a reading needs no joins", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      const rows = await tx.$queryRaw<
        Array<{
          site_name: string;
          equipment_name: string | null;
          point_role: string | null;
          unit: string | null;
        }>
      >`SELECT site_name, equipment_name, point_role, unit FROM bas_v_reading
         WHERE point_id = ${f.sat} LIMIT 1`;

      // The reason the view exists: an LLM asked to join six tables from a
      // reading to a building name gets it wrong routinely, and plausibly.
      expect(rows[0]).toEqual({
        site_name: SITE_NAME,
        equipment_name: EQUIPMENT_NAME,
        point_role: ROLES.sat,
        unit: "fahrenheit",
      });
    });
  });

  it("shows a null reading as a row with no value", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      await tx.$executeRaw`
        INSERT INTO bas_readings (point_id, ts, status)
        VALUES (${f.sat}, '2026-03-01T00:00:00Z', '{down}')`;

      const rows = await tx.$queryRaw<
        Array<{ value_num: number | null; status: string | null }>
      >`SELECT value_num, status FROM bas_v_reading
         WHERE point_id = ${f.sat} AND ts = '2026-03-01T00:00:00Z'`;

      // The view must not filter these out. "The station returned null" and "we
      // never collected" have to stay distinguishable all the way up.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.value_num).toBeNull();
      expect(rows[0]?.status).toBe("{down}");
    });
  });
});

describe("bas_v_setpoint_pair pairs a measurement with its setpoint", () => {
  it("pairs them from point_role alone, with no per-point configuration", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      const rows = await tx.$queryRaw<
        Array<{
          measured_point_id: bigint;
          setpoint_point_id: bigint;
          unit_mismatch: boolean;
        }>
      >`SELECT measured_point_id, setpoint_point_id, unit_mismatch
          FROM bas_v_setpoint_pair WHERE equipment_id = ${f.equipmentId}`;

      expect(rows).toHaveLength(1);
      expect(rows[0]?.measured_point_id).toBe(f.sat);
      expect(rows[0]?.setpoint_point_id).toBe(f.satSp);
      expect(rows[0]?.unit_mismatch).toBe(false);
    });
  });

  it("flags a degF measurement against a degC setpoint", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      await tx.basPoint.update({
        where: { pointId: f.satSp },
        data: { unit: "celsius" },
      });

      const rows = await tx.$queryRaw<Array<{ unit_mismatch: boolean }>>`
        SELECT unit_mismatch FROM bas_v_setpoint_pair
         WHERE setpoint_point_id = ${f.satSp}`;

      // 55 degF against a setpoint of 12.8 degC is the same temperature. Compare
      // the numbers and you get a confident, wrong answer.
      expect(rows[0]?.unit_mismatch).toBe(true);
    });
  });

  it("cannot pair a point with no equipment, which is why equipment matters", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      await tx.basPoint.update({
        where: { pointId: f.satSp },
        data: { equipmentId: null },
      });

      expect(
        await countRows(
          tx,
          `bas_v_setpoint_pair WHERE setpoint_point_id = ${f.satSp}`,
        ),
      ).toBe(0);
    });
  });

  it("drops the pair when either point goes inactive", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      await tx.basPoint.update({
        where: { pointId: f.sat },
        data: { isActive: false },
      });

      expect(
        await countRows(
          tx,
          `bas_v_setpoint_pair WHERE equipment_id = ${f.equipmentId}`,
        ),
      ).toBe(0);
    });
  });
});

describe("bas_v_command_status_pair pairs a command with its proof of running", () => {
  it("pairs them from status_of alone", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      const rows = await tx.$queryRaw<
        Array<{ command_point_id: bigint; status_point_id: bigint }>
      >`SELECT command_point_id, status_point_id FROM bas_v_command_status_pair
         WHERE equipment_id = ${f.equipmentId}`;

      // Commanded on but not running is one of the most expensive faults in a
      // building and is invisible on an alarm screen. This view is what makes
      // detecting it generic rather than per-building.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.command_point_id).toBe(f.fanCmd);
      expect(rows[0]?.status_point_id).toBe(f.fanStatus);
    });
  });
});

describe("bas_v_collection_health classifies roll risk", () => {
  /**
   * The *Points at risk* tile on the B3 screen reads this column. The two
   * classifications that matter are `data_lost` - the station overwrote records
   * before we collected them, permanently - and `roll_horizon_unknown`, which is
   * an absence of knowledge and must never render green.
   *
   * The fixture horizon is 500 x 900 = 450000s = 5.2 days, so the boundaries are
   * 2.6 days (at_risk) and 5.2 days (data_lost).
   */
  async function riskAfter(tx: Tx, pointId: bigint, interval: string) {
    await tx.$executeRawUnsafe(
      `UPDATE bas_sync_checkpoints
          SET last_record_ts = now() - interval '${interval}'
        WHERE point_id = $1`,
      pointId,
    );
    const rows = await tx.$queryRaw<Array<{ roll_risk: string }>>`
      SELECT roll_risk FROM bas_v_collection_health WHERE point_id = ${pointId}`;
    return rows[0]?.roll_risk;
  }

  it("reads ok for a point collected minutes ago", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      expect(await riskAfter(tx, f.sat, "10 minutes")).toBe("ok");
    });
  });

  it("reads at_risk past half the horizon", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      // 4 days: past 2.6, short of 5.2.
      expect(await riskAfter(tx, f.sat, "4 days")).toBe("at_risk");
    });
  });

  it("reads data_lost past the whole horizon", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      // 10 days against a 5.2-day horizon. Those records are gone from the
      // station and exist nowhere - no alarm, no log entry, no gap marker.
      expect(await riskAfter(tx, f.sat, "10 days")).toBe("data_lost");
    });
  });

  it("reads never_collected when there is no checkpoint at all", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      // fanCmd has readings but no checkpoint row, which is the state of a point
      // discovered by the collector but not yet collected from.
      const rows = await tx.$queryRaw<Array<{ roll_risk: string }>>`
        SELECT roll_risk FROM bas_v_collection_health WHERE point_id = ${f.fanCmd}`;

      expect(rows[0]?.roll_risk).toBe("never_collected");
    });
  });

  it("reads roll_horizon_unknown when capacity has not been filled in", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      await tx.$executeRaw`
        INSERT INTO bas_sync_checkpoints (point_id, last_record_ts, last_status)
        VALUES (${f.unknown}, now() - interval '10 minutes', 'ok')`;

      const rows = await tx.$queryRaw<Array<{ roll_risk: string }>>`
        SELECT roll_risk FROM bas_v_collection_health WHERE point_id = ${f.unknown}`;

      // Collected ten minutes ago, so on recency alone this would be "ok". It is
      // not ok - we cannot tell, and unknown is not safe.
      expect(rows[0]?.roll_risk).toBe("roll_horizon_unknown");
    });
  });

  it("never reports ok or at_risk for a point with no horizon, at any staleness", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      await tx.$executeRaw`
        INSERT INTO bas_sync_checkpoints (point_id, last_record_ts, last_status)
        VALUES (${f.unknown}, now(), 'ok')`;

      for (const interval of ["1 minute", "4 days", "10 days", "400 days"]) {
        const risk = await riskAfter(tx, f.unknown, interval);
        expect(risk, `staleness ${interval}`).toBe("roll_horizon_unknown");
      }
    });
  });

  it("lists every point, including unclassified ones", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      const rows = await tx.$queryRaw<Array<{ point_id: bigint }>>`
        SELECT point_id FROM bas_v_collection_health
         WHERE station_id = ${f.stationId} ORDER BY point_id`;

      // A point with no role is an explicit, visible backlog item rather than a
      // hidden one - so the health view must not filter on point_role.
      expect(rows.map((r) => r.point_id)).toEqual([
        f.sat,
        f.satSp,
        f.fanCmd,
        f.fanStatus,
        f.unknown,
      ]);
    });
  });

  it("reports the checkpoint's own status and failure count", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      await tx.$executeRaw`
        UPDATE bas_sync_checkpoints
           SET last_status = 'error', consecutive_failures = 3,
               last_error = 'connection refused'
         WHERE point_id = ${f.sat}`;

      const rows = await tx.$queryRaw<
        Array<{
          last_status: string;
          consecutive_failures: number;
          seconds_since_last_record: bigint;
        }>
      >`SELECT last_status, consecutive_failures, seconds_since_last_record
          FROM bas_v_collection_health WHERE point_id = ${f.sat}`;

      expect(rows[0]?.last_status).toBe("error");
      expect(rows[0]?.consecutive_failures).toBe(3);
      // 10 minutes, give or take the transaction's own duration.
      expect(Number(rows[0]?.seconds_since_last_record)).toBeGreaterThanOrEqual(
        590,
      );
    });
  });
});
