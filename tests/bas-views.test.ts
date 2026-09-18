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
      // add_bas_measured_horizon_and_visibility (2026-09-17). The screen and
      // healthcheck.py read these; the collector writes what they read.
      "completeness",
      "completeness_note",
      "station_count",
      "held_count",
      "completeness_checked_at",
      "observed_span_s",
      "measured_horizon_s",
      "horizon_s",
      "horizon_source",
      // add_bas_shortest_full_span (2026-09-18). The guard reads the SHORTEST
      // full-buffer span, the screen shows the current one beside it, and
      // horizon_state is the four-way word both screens use.
      "shortest_full_span_s",
      "current_full_span_s",
      "horizon_state",
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

  /**
   * The measured horizon (2026-09-17). A change-of-value history has no
   * collection interval, so capacity x interval is NULL and the view used to
   * say roll_horizon_unknown for it forever. The station reports count, start
   * and end for every history, and when the buffer is FULL - count >= capacity
   * - the span from start to end is how long it retains. Unit_Status_Mode on
   * PHBoffice: 500 records over two hours, sixty times shorter than every
   * interval point beside it, and the most at-risk point on the station read
   * "unknown".
   */
  async function measured(
    tx: Tx,
    pointId: bigint,
    opts: {
      capacity: number | null;
      count: number;
      spanS: number;
      ago: string;
      /**
       * The stored shortest full span (add_bas_shortest_full_span). Omitted
       * means "whatever the row holds", which for a fresh row is NULL - the
       * shape of a point the collector has not yet passed with the new column.
       */
      shortestS?: number | null;
    },
  ) {
    await tx.$executeRawUnsafe(
      `UPDATE bas_points SET capacity = $1 WHERE point_id = $2`,
      opts.capacity,
      pointId,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO bas_sync_checkpoints
         (point_id, last_record_ts, last_status, station_count, observed_span_s)
       VALUES ($1, now() - interval '${opts.ago}', 'ok', $2, $3)
       ON CONFLICT (point_id) DO UPDATE
         SET last_record_ts = EXCLUDED.last_record_ts,
             station_count = EXCLUDED.station_count,
             observed_span_s = EXCLUDED.observed_span_s`,
      pointId,
      opts.count,
      opts.spanS,
    );
    if (opts.shortestS !== undefined) {
      await tx.$executeRawUnsafe(
        `UPDATE bas_sync_checkpoints SET shortest_full_span_s = $1 WHERE point_id = $2`,
        opts.shortestS,
        pointId,
      );
    }
    const rows = await tx.$queryRaw<
      Array<{
        roll_risk: string;
        horizon_s: number | null;
        measured_horizon_s: number | null;
        horizon_source: string | null;
        horizon_state: string;
        current_full_span_s: number | null;
        shortest_full_span_s: number | null;
      }>
    >`SELECT roll_risk, horizon_s, measured_horizon_s, horizon_source,
             horizon_state, current_full_span_s, shortest_full_span_s
        FROM bas_v_collection_health WHERE point_id = ${pointId}`;
    return rows[0];
  }

  it("uses the station's own span as the horizon when its buffer is full", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      // A COV point: capacity filled in, no interval, so roll_horizon_s is NULL.
      // The station says 500 records over 7200 s. Collected ten minutes ago.
      const row = await measured(tx, f.unknown, {
        capacity: 500, count: 500, spanS: 7200, ago: "10 minutes",
      });

      expect(row?.horizon_source).toBe("measured");
      expect(row?.measured_horizon_s).toBe(7200);
      expect(row?.horizon_s).toBe(7200);
      expect(row?.roll_risk).toBe("ok");
    });
  });

  it("judges at_risk and data_lost against the measured two hours, not against unknown", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      // 90 minutes against a 2-hour horizon: past half, short of all.
      expect(
        (await measured(tx, f.unknown, { capacity: 500, count: 500, spanS: 7200, ago: "90 minutes" }))
          ?.roll_risk,
      ).toBe("at_risk");
      // 3 hours: the station has rolled records we never collected.
      expect(
        (await measured(tx, f.unknown, { capacity: 500, count: 500, spanS: 7200, ago: "3 hours" }))
          ?.roll_risk,
      ).toBe("data_lost");
    });
  });

  it("does not call a half-full buffer's span a horizon, and does not call it unknown either", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      // 419 of 500: Occupied's shape. Its span is how much it holds so far,
      // not how long it retains - and a buffer below capacity has overwritten
      // NOTHING. Until 2026-09-18 this read roll_horizon_unknown and was
      // counted at risk beside six provably safe office points. It is its own
      // state now: not_full, informational, not a risk.
      const row = await measured(tx, f.unknown, {
        capacity: 500, count: 419, spanS: 78_000_000, ago: "10 minutes",
      });

      expect(row?.measured_horizon_s).toBeNull();
      expect(row?.horizon_s).toBeNull();
      expect(row?.horizon_source).toBeNull();
      expect(row?.horizon_state).toBe("not_full");
      expect(row?.roll_risk).toBe("buffer_not_full");
      expect(row?.roll_risk).not.toBe("roll_horizon_unknown");
    });
  });

  it("keeps a not-full buffer out of every horizon-judged state at any staleness", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      // OperatingState: 320 of 500 over 2.5 years, newest record long ago. No
      // amount of staleness turns "nothing overwritten" into at_risk or
      // data_lost, and none turns it into ok either - there is no horizon to
      // be inside of.
      for (const ago of ["10 minutes", "100 hours", "400 days"]) {
        const row = await measured(tx, f.unknown, {
          capacity: 500, count: 320, spanS: 78_000_000, ago,
        });
        expect(row?.roll_risk, `staleness ${ago}`).toBe("buffer_not_full");
      }
    });
  });

  /**
   * The shortest span, not the latest (2026-09-18). Unit_Status_Mode measured
   * about two hours on 2026-09-17 and ten hours the next day - a fivefold
   * swing, because a change-of-value point's horizon is how hard the
   * equipment is cycling. The guard has to hold the worst the buffer has been
   * seen to do, or a quiet afternoon erases the evidence.
   *
   * MUTATIONS, each applied to the TEST database's view by hand and restored
   * (38 passed clean afterwards), 2026-09-18:
   *   V1  measured_horizon_s := the CURRENT full span (the latest, the old
   *       behaviour)            -> "guards on the SHORTEST..." and "holds the
   *       shortest when the buffer is currently below capacity" fail (2)
   *   V2  measured_horizon_s := the STORED shortest only
   *                              -> 4 fail, including "lets a shorter CURRENT
   *       span govern" and "uses the station's own span as the horizon when
   *       its buffer is full" (a fresh row has no stored shortest yet)
   *   V3  the buffer_not_full branch removed from roll_risk
   *                              -> both not-full tests fail (2)
   * And in TypeScript, each restored: T1 computeHeadroom files a not-full
   * point as unknown -> 6 headroom tests; T2 pointsAtRisk counts
   * buffer_not_full -> 2 service tests; T3 the not-full cell borrows the
   * unknown explanation -> 1 UI test (the one that forbids "interval");
   * T4 basRiskTone("buffer_not_full") = "ok" -> 2 UI tests.
   */
  it("guards on the SHORTEST full-buffer span, and reports the current one beside it", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      // Stored shortest 2 h, station reporting 10 h today. Collected 3 h ago:
      // inside 10 h, past 2 h. The 2 h governs, so this is data_lost.
      const row = await measured(tx, f.unknown, {
        capacity: 500, count: 500, spanS: 36_470, ago: "3 hours", shortestS: 7200,
      });

      expect(row?.shortest_full_span_s).toBe(7200);
      expect(row?.current_full_span_s).toBe(36_470);
      expect(row?.measured_horizon_s).toBe(7200);
      expect(row?.horizon_s).toBe(7200);
      expect(row?.horizon_source).toBe("measured");
      expect(row?.horizon_state).toBe("measured");
      expect(row?.roll_risk).toBe("data_lost");
    });
  });

  it("lets a shorter CURRENT span govern even when the stored shortest is longer", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      // The collector maintains the shortest, so this shape should not occur -
      // but if some writer ever records a span without lowering the shortest,
      // the LEAST in the view still guards on the smaller number.
      const row = await measured(tx, f.unknown, {
        capacity: 500, count: 500, spanS: 3600, ago: "50 minutes", shortestS: 36_470,
      });

      expect(row?.measured_horizon_s).toBe(3600);
      expect(row?.horizon_s).toBe(3600);
      expect(row?.roll_risk).toBe("at_risk");
    });
  });

  it("holds the shortest when the buffer is currently below capacity", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      // Seen full at 2 h once; the station now reports 480 of 500 (a cleared
      // or trimmed history). The point has proven it can roll in two hours,
      // and the proof is what the guard keeps.
      const row = await measured(tx, f.unknown, {
        capacity: 500, count: 480, spanS: 5000, ago: "10 minutes", shortestS: 7200,
      });

      expect(row?.current_full_span_s).toBeNull();
      expect(row?.measured_horizon_s).toBe(7200);
      expect(row?.horizon_state).toBe("measured");
      expect(row?.roll_risk).toBe("ok");
    });
  });

  /**
   * The migration's backfill, run as the file states it. The migration itself
   * ran once against the test database and cannot be re-run to prove it, so
   * the statement is cut out between its markers and run against fixture rows
   * inside a rollback.
   */
  async function backfillStatement(): Promise<string> {
    const { readFile } = await import("node:fs/promises");
    const sql = await readFile(
      "prisma/migrations/20260918120000_add_bas_shortest_full_span/migration.sql",
      "utf8",
    );
    const statement = sql.split("-- BACKFILL BEGIN")[1]?.split("-- BACKFILL END")[0];
    expect(statement, "the backfill statement is delimited in the migration").toBeTruthy();
    return statement ?? "";
  }

  it("backfills the shortest from a FULL buffer's span and leaves a not-full one NULL", async () => {
    const backfill = await backfillStatement();

    await inRollback(async (tx) => {
      const f = await withData(tx);

      // Two rows the way live had them on 2026-09-18: one full at 36,470 s,
      // one at 320 of 500. Both start with the column NULL.
      await measured(tx, f.sat, {
        capacity: 500, count: 500, spanS: 36_470, ago: "10 minutes", shortestS: null,
      });
      await measured(tx, f.unknown, {
        capacity: 500, count: 320, spanS: 78_000_000, ago: "10 minutes", shortestS: null,
      });

      await tx.$executeRawUnsafe(backfill);

      const rows = await tx.$queryRaw<
        Array<{ point_id: bigint; shortest_full_span_s: number | null }>
      >`SELECT point_id, shortest_full_span_s FROM bas_sync_checkpoints
         WHERE point_id IN (${f.sat}, ${f.unknown})`;
      const byId = new Map(rows.map((r) => [r.point_id.toString(), r.shortest_full_span_s]));

      expect(byId.get(f.sat.toString())).toBe(36_470);
      expect(byId.get(f.unknown.toString())).toBeNull();
    });
  });

  it("does not let the backfill RAISE a shortest that is already recorded", async () => {
    const backfill = await backfillStatement();

    await inRollback(async (tx) => {
      const f = await withData(tx);
      await measured(tx, f.sat, {
        capacity: 500, count: 500, spanS: 36_470, ago: "10 minutes", shortestS: 7200,
      });

      await tx.$executeRawUnsafe(backfill);

      const rows = await tx.$queryRaw<Array<{ shortest_full_span_s: number | null }>>`
        SELECT shortest_full_span_s FROM bas_sync_checkpoints WHERE point_id = ${f.sat}`;
      expect(rows[0]?.shortest_full_span_s).toBe(7200);
    });
  });

  it("cannot know a buffer is full when nobody has filled in its capacity", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      // count 500 looks like Niagara's default capacity, and the view does not
      // guess: a 1000-record buffer at 500 is half full.
      const row = await measured(tx, f.unknown, {
        capacity: null, count: 500, spanS: 7200, ago: "10 minutes",
      });

      expect(row?.horizon_source).toBeNull();
      expect(row?.roll_risk).toBe("roll_horizon_unknown");
    });
  });

  it("prefers the measured horizon to the configured one when both exist", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      // sat is configured at 500 x 900 = 450000 s. The station says its full
      // buffer spans 7200 s - the interval in Workbench is wrong, or the point
      // was reconfigured. The measurement wins, and says so.
      const row = await measured(tx, f.sat, {
        capacity: 500, count: 500, spanS: 7200, ago: "3 hours",
      });

      expect(row?.horizon_source).toBe("measured");
      expect(row?.horizon_s).toBe(7200);
      expect(row?.roll_risk).toBe("data_lost");
    });
  });

  it("falls back to the configured horizon when the station reports no span", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      const rows = await tx.$queryRaw<Array<{ horizon_s: number | null; horizon_source: string | null }>>`
        SELECT horizon_s, horizon_source FROM bas_v_collection_health WHERE point_id = ${f.sat}`;

      expect(rows[0]?.horizon_source).toBe("configured");
      expect(rows[0]?.horizon_s).toBe(450_000);
    });
  });

  /**
   * The completeness verdict, passed through (2026-09-17). For a day the
   * collector wrote it and nothing read it. This is the first reader.
   */
  it("carries the completeness verdict and its numbers", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      await tx.$executeRaw`
        UPDATE bas_sync_checkpoints
           SET completeness = 'incomplete', station_count = 500, held_count = 430,
               completeness_note = 'ZZTEST station holds 70 we do not',
               completeness_checked_at = now()
         WHERE point_id = ${f.sat}`;

      const rows = await tx.$queryRaw<
        Array<{ completeness: string; station_count: number; held_count: number; completeness_note: string }>
      >`SELECT completeness, station_count, held_count, completeness_note
          FROM bas_v_collection_health WHERE point_id = ${f.sat}`;

      expect(rows[0]?.completeness).toBe("incomplete");
      expect(rows[0]?.station_count).toBe(500);
      expect(rows[0]?.held_count).toBe(430);
      expect(rows[0]?.completeness_note).toContain("70");
    });
  });

  it("reads NULL completeness for a point with no checkpoint, never 'complete'", async () => {
    await inRollback(async (tx) => {
      const f = await withData(tx);

      // fanCmd has no checkpoint row. A LEFT JOIN gives NULL, and the service
      // turns NULL into unknown. What it must never be is a value that reads
      // as checked.
      const rows = await tx.$queryRaw<Array<{ completeness: string | null }>>`
        SELECT completeness FROM bas_v_collection_health WHERE point_id = ${f.fanCmd}`;

      expect(rows[0]?.completeness).toBeNull();
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
