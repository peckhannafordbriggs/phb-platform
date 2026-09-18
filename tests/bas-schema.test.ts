import { afterAll, describe, expect, it } from "vitest";
import { INACTIVE_REASONS } from "@/lib/modules/bas/types";
import { disconnectDb, testDb } from "./db";
import {
  countRows,
  createBasFixture,
  expectRejection,
  inRollback,
} from "./bas-fixture";

/**
 * B1's invariants, ported from `C:\dev\bas-db\scripts\verify.py`.
 *
 * B1 shipped with no tests. The 416/416 it reported were green against a test
 * database that had none of these twelve tables - which is why
 * `tests/global-setup.ts` now refuses to let the suite start in that state.
 *
 * What is asserted here is the half of the schema Prisma cannot see: CHECK
 * constraints, the roll-horizon trigger, and the views. `schema.prisma` is not
 * the whole story (runbook.md, *The BAS schema lives in two places*), and
 * nothing else in the repo would notice if the hand-written half were dropped.
 *
 * The vocabularies are covered separately, in `tests/bas-vocabularies.test.ts`.
 * They are not present in the test database at all: `npm run db:test:setup`
 * applies migrations and deliberately does not seed, because tests/setup.ts
 * truncates between files. So the fixtures here build their own `zztest_`
 * vocabulary, which also means these tests never depend on a seed or an import
 * having run.
 */

afterAll(async () => {
  await disconnectDb();
});

describe("bas_v_data_dictionary is scoped to bas_ objects", () => {
  /**
   * The single highest-value assertion in this file.
   *
   * This view exists to be pasted into an LLM prompt. The predicate was
   * `nspname = 'bas'` in the standalone database, and both obvious ways of
   * moving it to `public` fail silently: keeping `'bas'` returns zero rows and
   * the model starts guessing column names, while `nspname = 'public'` alone
   * hands it `employees`, `audit_events`, `module_grants` and `draft_locks`.
   * Neither raises an error. So both directions are asserted, and the ABSENT
   * half is the one that matters.
   */
  const BAS_TABLES = [
    "bas_data_gaps",
    "bas_equipment",
    "bas_equipment_types",
    "bas_ingest_runs",
    "bas_orgs",
    "bas_point_links",
    "bas_point_roles",
    "bas_points",
    "bas_projects",
    "bas_readings",
    "bas_sites",
    "bas_stations",
    "bas_sync_checkpoints",
  ];

  /**
   * The one bas_ table that must NOT be in the dictionary.
   *
   * The predicate matches `bas\_%`, so this table qualifies on its name and is
   * excluded by an explicit `<> 'bas_station_credentials'`. Without that, the
   * existence and column names of the credential store go into the prompt of
   * the AI whose SQL tool is supposed to be denied the table outright - which
   * is the entire reason the credentials are a separate table rather than
   * columns on bas_stations.
   *
   * No password leaks either way. That is not the bar: telling a model there is
   * a password_ciphertext column is the first half of asking for it.
   */
  const EXCLUDED_BAS_TABLES = ["bas_station_credentials"];

  const BAS_VIEWS = [
    "bas_v_collection_health",
    "bas_v_command_status_pair",
    "bas_v_data_dictionary",
    "bas_v_point",
    "bas_v_reading",
    "bas_v_setpoint_pair",
  ];

  /** Every platform table. None of these may ever appear in an LLM prompt. */
  const PLATFORM_TABLES = [
    "employees",
    "audit_events",
    "module_grants",
    "draft_locks",
    "modules",
    "positions",
    "departments",
    "_prisma_migrations",
  ];

  async function objectNames(): Promise<string[]> {
    const rows = await testDb.$queryRaw<Array<{ object_name: string }>>`
      SELECT DISTINCT object_name FROM bas_v_data_dictionary ORDER BY 1`;
    return rows.map((r) => r.object_name);
  }

  it("includes every bas_ table and every bas_v_ view", async () => {
    const names = await objectNames();

    // Present, not merely non-empty: a predicate returning zero rows is one of
    // the two documented ways to get this wrong.
    for (const expected of [...BAS_TABLES, ...BAS_VIEWS]) {
      expect(names, `${expected} must be in the dictionary`).toContain(expected);
    }
  });

  it("excludes the credentials table, which matches the bas_ prefix", async () => {
    const names = await objectNames();

    for (const forbidden of EXCLUDED_BAS_TABLES) {
      expect(names, `${forbidden} must NOT be in the dictionary`).not.toContain(
        forbidden,
      );
    }

    // The column names are the payload, so check for them directly rather than
    // trusting that excluding the object was enough.
    const rows = await testDb.$queryRaw<Array<{ column_name: string }>>`
      SELECT DISTINCT column_name FROM bas_v_data_dictionary`;
    const columns = new Set(rows.map((r) => r.column_name));
    for (const forbidden of ["password_ciphertext", "key_version"]) {
      expect(columns.has(forbidden), `${forbidden} must not be exposed`).toBe(
        false,
      );
    }
  });

  it("excludes the platform's own tables", async () => {
    const names = await objectNames();

    // The assertion that matters. A wrong predicate puts the platform's
    // employee and audit tables into an LLM prompt and nothing errors.
    for (const forbidden of PLATFORM_TABLES) {
      expect(names, `${forbidden} must NOT be in the dictionary`).not.toContain(
        forbidden,
      );
    }
  });

  it("contains nothing outside the bas_ prefix, whatever gets added later", async () => {
    const names = await objectNames();

    // Stronger than the deny-list above, which can only catch tables that exist
    // today. Any future platform table is caught by this one.
    const strays = names.filter((name) => !name.startsWith("bas_"));
    expect(strays).toEqual([]);

    // And the exact set, so adding a bas_ table is a deliberate decision to
    // expose it to the AI rather than something that happens silently.
    expect(names).toEqual([...BAS_TABLES, ...BAS_VIEWS].sort());
  });

  it("leaks no platform column names either", async () => {
    // Belt and braces: the object filter is what protects the schema, but a
    // future join mistake could surface columns without their table name.
    const rows = await testDb.$queryRaw<Array<{ column_name: string }>>`
      SELECT DISTINCT column_name FROM bas_v_data_dictionary`;
    const columns = new Set(rows.map((r) => r.column_name));

    for (const forbidden of [
      "entra_oid",
      "is_platform_admin",
      "sessions_valid_after",
      "profile_completed",
      "actor_employee_id",
      "held_by_id",
    ]) {
      expect(columns.has(forbidden), `${forbidden} must not be exposed`).toBe(
        false,
      );
    }
  });

  it("describes the whole schema, one row per column", async () => {
    const rows = await testDb.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM bas_v_data_dictionary`;

    // 211 today across 18 objects. A floor rather than an equality: adding a
    // column is normal, the view returning almost nothing is not.
    expect(rows[0]?.n ?? 0).toBeGreaterThan(150);
  });

  it("carries a description for EVERY object, table and view alike", async () => {
    const undescribed = await testDb.$queryRaw<Array<{ object_name: string }>>`
      SELECT DISTINCT object_name FROM bas_v_data_dictionary
       WHERE object_description IS NULL ORDER BY 1`;

    // All eighteen. The twelve table comments arrived with the
    // add_bas_comments migration; the six view comments survived the original
    // port. An object with no description is one the model has to guess about
    // from its name.
    expect(undescribed.map((r) => r.object_name)).toEqual([]);

    const described = await testDb.$queryRaw<Array<{ object_name: string }>>`
      SELECT DISTINCT object_name FROM bas_v_data_dictionary
       WHERE object_description IS NOT NULL ORDER BY 1`;
    expect(described.map((r) => r.object_name)).toEqual(
      [...BAS_TABLES, ...BAS_VIEWS].sort(),
    );
  });

  it("is annotated at the column level, which is the only reason it is worth pasting", async () => {
    const rows = await testDb.$queryRaw<
      Array<{ object_name: string; column_name: string; column_description: string }>
    >`SELECT object_name, column_name, column_description FROM bas_v_data_dictionary
       WHERE column_description IS NOT NULL
       ORDER BY object_name, column_name`;

    // verify.py used 20 as its floor against the standalone schema. This floor
    // was deliberately held at 2 for as long as that was the truth: the port to
    // Prisma dropped 20 of 22 COMMENT ON COLUMN and all 12 COMMENT ON TABLE,
    // because /// doc comments in schema.prisma are not emitted as SQL comments
    // and are invisible from inside a query. add_bas_comments restored them, so
    // the floor is now the one verify.py asserted.
    expect(rows.length).toBeGreaterThanOrEqual(20);

    const annotated = rows.map((r) => `${r.object_name}.${r.column_name}`);

    // The two that were never lost, and are the two most dangerous to get wrong.
    expect(annotated).toContain("bas_points.roll_horizon_s");
    expect(annotated).toContain("bas_v_reading.ts_local");

    // add_bas_comments must not have overwritten the roll_horizon_s wording with
    // the standalone version, which predates the trigger and does not name it.
    const horizon = rows.find((r) => r.column_name === "roll_horizon_s");
    expect(horizon?.column_description).toContain("never write it by hand");
    expect(horizon?.column_description).toContain("bas_points_roll_horizon");

    // A spread of the restored ones, chosen because each documents something a
    // reader cannot infer from the column name.
    for (const column of [
      "bas_points.niagara_history_name",
      "bas_points.capacity",
      "bas_points.full_policy",
      "bas_points.unit",
      "bas_readings.ts",
      "bas_readings.status",
      "bas_sites.timezone",
      "bas_point_roles.setpoint_for",
      "bas_point_roles.status_of",
      "bas_data_gaps.cause",
      // add_bas_point_label_and_visibility: the five columns whose NAME is
      // what misleads. Two display_name columns with opposite meanings, and
      // two booleans of which one costs data forever and one costs nothing.
      "bas_points.label",
      "bas_points.is_visible",
      "bas_points.inactive_reason",
      "bas_points.is_active",
      "bas_points.display_name",
      "bas_stations.display_name",
      // add_bas_shortest_full_span: the column whose direction of travel is
      // the whole point. A reader who sees it as "the span" will raise it.
      "bas_sync_checkpoints.shortest_full_span_s",
      "bas_sync_checkpoints.observed_span_s",
    ]) {
      expect(annotated, `${column} must be documented`).toContain(column);
    }

    // The shortest full span only ever gets shorter, and the comment has to
    // say so and say why - it is the main defence against a hand-run UPDATE
    // that "corrects" a two-hour value to today's ten.
    const shortest = rows.find((r) => r.column_name === "shortest_full_span_s");
    expect(shortest?.column_description).toContain("only ever gets shorter");
    expect(shortest?.column_description).toContain("Never raise it by hand");
    // And the current span's comment must not present itself as the guard.
    const current = rows.find(
      (r) => r.object_name === "bas_sync_checkpoints" && r.column_name === "observed_span_s",
    );
    expect(current?.column_description).toContain("shortest_full_span_s");
    expect(current?.column_description).toContain("overwritten nothing");

    // Showing is not collecting. The comments are the main defence against the
    // next person confusing the two, so the wording is asserted, not just its
    // presence.
    const described = (object: string, column: string) =>
      rows.find((r) => r.object_name === object && r.column_name === column)
        ?.column_description ?? "";
    expect(described("bas_points", "is_active")).toContain("PERMANENT");
    expect(described("bas_points", "is_active")).toContain("is_visible");
    expect(described("bas_points", "is_visible")).toContain("COSMETIC");
    expect(described("bas_points", "is_visible")).toContain("is_active");
    expect(described("bas_points", "is_visible")).toContain("risk");
    // Each display_name names the other table and says it means the opposite.
    expect(described("bas_points", "display_name")).toContain("NIAGARA");
    expect(described("bas_points", "display_name")).toContain("bas_stations.display_name");
    expect(described("bas_points", "display_name")).toContain("OPPOSITE");
    expect(described("bas_stations", "display_name")).toContain("PERSON");
    expect(described("bas_stations", "display_name")).toContain("bas_points.display_name");
    expect(described("bas_stations", "display_name")).toContain("OPPOSITE");
    expect(described("bas_points", "label")).toContain("discover");

    // Spot-check the prose itself, not just its presence: an empty string is a
    // non-null description and would satisfy every assertion above.
    const history = rows.find(
      (r) => r.column_name === "niagara_history_name" && r.object_name === "bas_points",
    );
    expect(history?.column_description).toContain("$-hex escapes");
    for (const row of rows) {
      expect(
        row.column_description.trim().length,
        `${row.object_name}.${row.column_name} has an empty description`,
      ).toBeGreaterThan(20);
    }
  });

  it("reports only tables and views", async () => {
    const rows = await testDb.$queryRaw<Array<{ object_type: string }>>`
      SELECT DISTINCT object_type FROM bas_v_data_dictionary ORDER BY 1`;

    expect(rows.map((r) => r.object_type).sort()).toEqual(["table", "view"]);
  });
});

describe("the roll_horizon_s trigger", () => {
  /**
   * `roll_horizon_s` is what every data-loss warning in this module is computed
   * from. It is a trigger rather than a generated column because Prisma cannot
   * tolerate `GENERATED ALWAYS AS` - see the runbook. Prisma does not model
   * triggers either, so nothing but this test would notice it being dropped.
   */
  const horizonOf = async (
    tx: Parameters<Parameters<typeof inRollback>[0]>[0],
    pointId: bigint,
  ) =>
    (
      await tx.basPoint.findUniqueOrThrow({
        where: { pointId },
        select: { rollHorizonS: true },
      })
    ).rollHorizonS;

  it("computes capacity x collection_interval_s on insert", async () => {
    await inRollback(async (tx) => {
      const f = await createBasFixture(tx);

      // 500 records at 900s = 450000s = 5.2 days.
      expect(await horizonOf(tx, f.sat)).toBe(450_000);
    });
  });

  it("recomputes when collection_interval_s changes", async () => {
    await inRollback(async (tx) => {
      const f = await createBasFixture(tx);

      await tx.basPoint.update({
        where: { pointId: f.sat },
        data: { collectionIntervalS: 60 },
      });

      // 500 x 60 = 30000s = 8.3 hours. The measured lab station is 500 x 300.
      expect(await horizonOf(tx, f.sat)).toBe(30_000);
    });
  });

  it("recomputes when capacity changes", async () => {
    await inRollback(async (tx) => {
      const f = await createBasFixture(tx);

      await tx.basPoint.update({
        where: { pointId: f.sat },
        data: { capacity: 100 },
      });

      expect(await horizonOf(tx, f.sat)).toBe(90_000);
    });
  });

  it("does not fire on an unrelated column, because the inputs cannot have changed", async () => {
    await inRollback(async (tx) => {
      const f = await createBasFixture(tx);

      await tx.basPoint.update({
        where: { pointId: f.sat },
        data: { notes: "touched" },
      });

      expect(await horizonOf(tx, f.sat)).toBe(450_000);
    });
  });

  describe("NULL in, NULL out - and NULL is not safe", () => {
    it("is NULL when capacity is unknown", async () => {
      await inRollback(async (tx) => {
        const f = await createBasFixture(tx);

        await tx.basPoint.update({
          where: { pointId: f.sat },
          data: { capacity: null },
        });

        expect(await horizonOf(tx, f.sat)).toBeNull();
      });
    });

    it("is NULL when collection_interval_s is unknown", async () => {
      await inRollback(async (tx) => {
        const f = await createBasFixture(tx);

        await tx.basPoint.update({
          where: { pointId: f.sat },
          data: { collectionIntervalS: null },
        });

        expect(await horizonOf(tx, f.sat)).toBeNull();
      });
    });

    it("is NULL when both are unknown, on insert", async () => {
      await inRollback(async (tx) => {
        const f = await createBasFixture(tx);

        // Capacity comes from Workbench or BQL, not from oBIX, so a discovered
        // point genuinely starts life like this.
        expect(await horizonOf(tx, f.unknown)).toBeNull();
      });
    });

    it("surfaces as roll_horizon_unknown, never as ok", async () => {
      await inRollback(async (tx) => {
        const f = await createBasFixture(tx);

        // A checkpoint exists and is recent, so the only thing stopping this
        // point reading "ok" is the unknown horizon. Without the checkpoint the
        // answer would be never_collected and the test would prove nothing.
        await tx.$executeRaw`
          INSERT INTO bas_sync_checkpoints (point_id, last_record_ts, last_status)
          VALUES (${f.unknown}, now() - interval '2 minutes', 'ok')`;

        const rows = await tx.$queryRaw<Array<{ roll_risk: string }>>`
          SELECT roll_risk FROM bas_v_collection_health WHERE point_id = ${f.unknown}`;

        expect(rows[0]?.roll_risk).toBe("roll_horizon_unknown");
        // The whole point: unknown must never be treated as safe or rendered
        // green. docs/08 states this and the view comment repeats it.
        expect(rows[0]?.roll_risk).not.toBe("ok");
        expect(rows[0]?.roll_risk).not.toBe("at_risk");
      });
    });
  });

  it("overwrites a direct write rather than accepting it", async () => {
    await inRollback(async (tx) => {
      const f = await createBasFixture(tx);

      // A generated column would have REJECTED this. The trigger silently
      // recomputes instead - a lost warning, not a lost guarantee, because
      // nothing writes the column. Asserted so the difference is on record.
      await tx.$executeRaw`
        UPDATE bas_points SET roll_horizon_s = 1 WHERE point_id = ${f.sat}`;

      expect(await horizonOf(tx, f.sat)).toBe(450_000);
    });
  });

  it("leaves no point whose stored horizon disagrees with its inputs", async () => {
    // The runbook's after-any-change query, as an assertion. Runs against every
    // row in the database, not just the fixture.
    const rows = await testDb.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM bas_points
       WHERE capacity IS NOT NULL AND collection_interval_s IS NOT NULL
         AND roll_horizon_s IS DISTINCT FROM capacity * collection_interval_s`;

    expect(rows[0]?.n).toBe(0);
  });
});

describe("re-collecting the same records is a no-op", () => {
  /**
   * The collector's entire self-healing story. It has no memory beyond
   * `bas_sync_checkpoints`, so a crashed run is recovered by simply running
   * again over an overlapping window. That is only safe because the primary key
   * is `(point_id, ts)` and the writes are `ON CONFLICT DO NOTHING`.
   */
  const READINGS = [
    "2026-01-15T17:00:00Z",
    "2026-01-15T17:15:00Z",
    "2026-01-15T17:30:00Z",
    "2026-01-15T17:45:00Z",
  ];

  it("writes zero rows the second time, rather than duplicating", async () => {
    await inRollback(async (tx) => {
      const f = await createBasFixture(tx);

      const insert = async () => {
        let written = 0;
        for (const [i, ts] of READINGS.entries()) {
          written += await tx.$executeRaw`
            INSERT INTO bas_readings (point_id, ts, value_num)
            VALUES (${f.sat}, ${new Date(ts)}, ${55 + i})
            ON CONFLICT (point_id, ts) DO NOTHING`;
        }
        return written;
      };

      const first = await insert();
      const afterFirst = await countRows(
        tx,
        `bas_readings WHERE point_id = ${f.sat}`,
      );

      const second = await insert();
      const afterSecond = await countRows(
        tx,
        `bas_readings WHERE point_id = ${f.sat}`,
      );

      expect(first).toBe(4);
      expect(afterFirst).toBe(4);
      // Rows affected, not just the total: a total that happens to match could
      // also mean the second pass replaced the first.
      expect(second).toBe(0);
      expect(afterSecond).toBe(4);
    });
  });

  it("keeps the first value when the station reports a different one for the same instant", async () => {
    await inRollback(async (tx) => {
      const f = await createBasFixture(tx);

      await tx.$executeRaw`
        INSERT INTO bas_readings (point_id, ts, value_num)
        VALUES (${f.sat}, '2026-01-15T17:00:00Z', 55.0)
        ON CONFLICT (point_id, ts) DO NOTHING`;
      await tx.$executeRaw`
        INSERT INTO bas_readings (point_id, ts, value_num)
        VALUES (${f.sat}, '2026-01-15T17:00:00Z', 99.0)
        ON CONFLICT (point_id, ts) DO NOTHING`;

      const rows = await tx.$queryRaw<Array<{ value_num: number }>>`
        SELECT value_num FROM bas_readings
         WHERE point_id = ${f.sat} AND ts = '2026-01-15T17:00:00Z'`;

      // DO NOTHING, not DO UPDATE. History is append-only; a second answer for
      // an instant we already recorded is discarded rather than overwriting it.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.value_num).toBe(55);
    });
  });

  it("rejects a genuine duplicate when the conflict clause is left off", async () => {
    const error = await expectRejection(async (tx) => {
      const f = await createBasFixture(tx);

      await tx.$executeRaw`
        INSERT INTO bas_readings (point_id, ts, value_num)
        VALUES (${f.sat}, '2026-01-15T17:00:00Z', 55.0)`;
      await tx.$executeRaw`
        INSERT INTO bas_readings (point_id, ts, value_num)
        VALUES (${f.sat}, '2026-01-15T17:00:00Z', 55.0)`;
    });

    // 23505 unique_violation. The key IS the dedup mechanism - if this ever
    // stops raising, the primary key has been weakened.
    expect(error.message).toContain("23505");
    expect(error.message).toContain("bas_readings_pkey");
  });
});

describe("a reading carries at most one typed value", () => {
  /**
   * `bas_readings_at_most_one_value` is a CHECK constraint, so Prisma neither
   * creates it nor reports it as drift. If it were dropped, bad rows would
   * accumulate in silence.
   */
  it("refuses a row with two typed values", async () => {
    const error = await expectRejection(async (tx) => {
      const f = await createBasFixture(tx);

      await tx.$executeRaw`
        INSERT INTO bas_readings (point_id, ts, value_num, value_bool)
        VALUES (${f.sat}, '2026-01-15T17:00:00Z', 1.0, true)`;
    });

    // 23514 check_violation, named, so a different constraint failing cannot
    // make this test pass by accident.
    expect(error.message).toContain("23514");
    expect(error.message).toContain("bas_readings_at_most_one_value");
  });

  it("refuses a row with all three", async () => {
    const error = await expectRejection(async (tx) => {
      const f = await createBasFixture(tx);

      await tx.$executeRaw`
        INSERT INTO bas_readings (point_id, ts, value_num, value_bool, value_str)
        VALUES (${f.sat}, '2026-01-15T17:00:00Z', 1.0, true, 'x')`;
    });

    expect(error.message).toContain("bas_readings_at_most_one_value");
  });

  it("accepts each typed value on its own", async () => {
    await inRollback(async (tx) => {
      const f = await createBasFixture(tx);

      await tx.$executeRaw`
        INSERT INTO bas_readings (point_id, ts, value_num)
        VALUES (${f.sat}, '2026-01-15T17:00:00Z', 55.0)`;
      await tx.$executeRaw`
        INSERT INTO bas_readings (point_id, ts, value_bool)
        VALUES (${f.fanCmd}, '2026-01-15T17:00:00Z', true)`;
      await tx.$executeRaw`
        INSERT INTO bas_readings (point_id, ts, value_str)
        VALUES (${f.unknown}, '2026-01-15T17:00:00Z', 'occupied')`;

      expect(await countRows(tx, "bas_readings")).toBe(3);
    });
  });

  it("accepts a row with ZERO typed values, which is not the same as no row", async () => {
    await inRollback(async (tx) => {
      const f = await createBasFixture(tx);

      // A record the station returned as null: a sensor fault, or a genuine gap
      // in the trend. Analysis that conflates this with "no row" will
      // confidently report equipment shutdowns that never happened.
      await tx.$executeRaw`
        INSERT INTO bas_readings (point_id, ts, status)
        VALUES (${f.sat}, '2026-03-01T00:00:00Z', '{down}')`;

      const rows = await tx.$queryRaw<
        Array<{
          value_num: number | null;
          value_bool: boolean | null;
          value_str: string | null;
          status: string | null;
        }>
      >`SELECT value_num, value_bool, value_str, status FROM bas_readings
         WHERE point_id = ${f.sat} AND ts = '2026-03-01T00:00:00Z'`;

      expect(rows).toHaveLength(1);
      expect(rows[0]?.value_num).toBeNull();
      expect(rows[0]?.value_bool).toBeNull();
      expect(rows[0]?.value_str).toBeNull();
      // The status flag is the only thing distinguishing it, and it survived.
      expect(rows[0]?.status).toBe("{down}");

      // And the contrast: an instant we never collected has no row at all.
      const missing = await countRows(
        tx,
        `bas_readings WHERE point_id = ${f.sat} AND ts = '2026-03-02T00:00:00Z'`,
      );
      expect(missing).toBe(0);
    });
  });
});

describe("the controlled vocabularies are enforced by the database", () => {
  /** All CHECK constraints, all invisible to Prisma in both directions. */
  const CASES: Array<{ what: string; constraint: string; sql: (id: bigint) => string }> =
    [
      {
        what: "an undeclared data_type",
        constraint: "bas_points_data_type_check",
        sql: (station) =>
          `INSERT INTO bas_points (station_id, niagara_history_name, data_type)
           VALUES (${station}, 'ZZTEST_BadType', 'float64')`,
      },
      {
        what: "an undeclared full_policy",
        constraint: "bas_points_full_policy_check",
        sql: (station) =>
          `INSERT INTO bas_points (station_id, niagara_history_name, full_policy)
           VALUES (${station}, 'ZZTEST_BadPolicy', 'wrap')`,
      },
      {
        what: "a zero collection interval",
        constraint: "bas_points_collection_interval_positive",
        sql: (station) =>
          `INSERT INTO bas_points (station_id, niagara_history_name, collection_interval_s)
           VALUES (${station}, 'ZZTEST_ZeroInterval', 0)`,
      },
      {
        what: "a zero capacity",
        constraint: "bas_points_capacity_positive",
        sql: (station) =>
          `INSERT INTO bas_points (station_id, niagara_history_name, capacity)
           VALUES (${station}, 'ZZTEST_ZeroCapacity', 0)`,
      },
      {
        // add_bas_completeness (2026-09-17). The collector writes this column
        // and the platform reads it; a fifth spelling would render as nothing
        // in particular on a screen whose whole job is to be noticed.
        what: "an undeclared completeness state",
        constraint: "bas_sync_checkpoints_completeness_check",
        sql: (station) =>
          `WITH p AS (
             INSERT INTO bas_points (station_id, niagara_history_name)
             VALUES (${station}, 'ZZTEST_BadCompleteness') RETURNING point_id)
           INSERT INTO bas_sync_checkpoints (point_id, completeness)
           SELECT point_id, 'mostly' FROM p`,
      },
      {
        // add_bas_point_label_and_visibility (2026-09-17). "No label" has one
        // spelling, NULL. A screen that falls back to the Niagara name on NULL
        // would render an empty row for '' or '   '.
        what: "a blank label",
        constraint: "bas_points_label_not_blank",
        sql: (station) =>
          `INSERT INTO bas_points (station_id, niagara_history_name, label)
           VALUES (${station}, 'ZZTEST_BlankLabel', '   ')`,
      },
      {
        // add_bas_inactive_reason (2026-09-17). The set is closed so the
        // collector's copy and this schema cannot drift apart unnoticed.
        what: "an inactive_reason outside the set",
        constraint: "bas_points_inactive_reason_check",
        sql: (station) =>
          `INSERT INTO bas_points (station_id, niagara_history_name, is_active, inactive_reason)
           VALUES (${station}, 'ZZTEST_BadReason', false, 'because')`,
      },
      {
        // The important one: a row must not claim a reason for being off
        // while it is on.
        what: "an inactive_reason on a point that is still collected",
        constraint: "bas_points_inactive_reason_only_when_inactive",
        sql: (station) =>
          `INSERT INTO bas_points (station_id, niagara_history_name, is_active, inactive_reason)
           VALUES (${station}, 'ZZTEST_ReasonWhileActive', true, 'manual')`,
      },
    ];

  for (const testCase of CASES) {
    it(`rejects ${testCase.what}`, async () => {
      const error = await expectRejection(async (tx) => {
        const f = await createBasFixture(tx);
        await tx.$executeRawUnsafe(testCase.sql(f.stationId));
      });

      expect(error.message).toContain("23514");
      expect(error.message).toContain(testCase.constraint);
    });
  }

  it("rejects a gap that ends before it starts", async () => {
    const error = await expectRejection(async (tx) => {
      const f = await createBasFixture(tx);

      await tx.$executeRaw`
        INSERT INTO bas_data_gaps (point_id, gap_start, gap_end, cause)
        VALUES (${f.sat}, '2026-03-02T00:00:00Z', '2026-03-01T00:00:00Z', 'roll_overwrite')`;
    });

    expect(error.message).toContain("bas_data_gaps_ordered");
  });

  it("rejects an undeclared gap cause", async () => {
    const error = await expectRejection(async (tx) => {
      const f = await createBasFixture(tx);

      await tx.$executeRaw`
        INSERT INTO bas_data_gaps (point_id, gap_start, gap_end, cause)
        VALUES (${f.sat}, '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z', 'oops')`;
    });

    expect(error.message).toContain("bas_data_gaps_cause_check");
  });

  it("accepts roll_overwrite, the cause that means data is permanently gone", async () => {
    await inRollback(async (tx) => {
      const f = await createBasFixture(tx);

      await tx.$executeRaw`
        INSERT INTO bas_data_gaps (point_id, gap_start, gap_end, cause)
        VALUES (${f.sat}, '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z', 'roll_overwrite')`;

      expect(
        await countRows(
          tx,
          `bas_data_gaps WHERE point_id = ${f.sat} AND cause = 'roll_overwrite'`,
        ),
      ).toBe(1);
    });
  });
});

describe("inactive_reason is one closed set in two places", () => {
  /**
   * The list in lib/modules/bas/types.ts and the CHECK in the migration are
   * two copies of one set. This reads the constraint back out of the catalog
   * and compares, so a value added to one without the other fails here rather
   * than rendering as nothing on a screen. The collector's copy (phb-bas,
   * collector/reasons.py) is held to the same constraint by its own test.
   */
  it("matches the CHECK constraint, value for value", async () => {
    const rows = await testDb.$queryRaw<Array<{ def: string }>>`
      SELECT pg_get_constraintdef(oid) AS def
        FROM pg_constraint
       WHERE conname = 'bas_points_inactive_reason_check'`;
    const def = rows[0]?.def ?? "";
    expect(def).toContain("inactive_reason");

    const inDatabase = [...def.matchAll(/'([a-z0-9_]+)'/g)]
      .map((m) => m[1])
      .filter((v): v is string => v !== undefined && v !== "text")
      .sort();
    expect(inDatabase).toEqual([...INACTIVE_REASONS].sort());
  });

  it("accepts every value on an inactive point, and refuses reactivation that keeps one", async () => {
    await inRollback(async (tx) => {
      const f = await createBasFixture(tx);
      for (const reason of INACTIVE_REASONS) {
        await tx.$executeRaw`
          UPDATE bas_points SET is_active = false, inactive_reason = ${reason}
           WHERE point_id = ${f.sat}`;
      }
      // Clearing in the same statement is the rule every writer follows.
      await tx.$executeRaw`
        UPDATE bas_points SET is_active = true, inactive_reason = NULL
         WHERE point_id = ${f.sat}`;
    });

    const error = await expectRejection(async (tx) => {
      const f = await createBasFixture(tx);
      await tx.$executeRaw`
        UPDATE bas_points SET is_active = false, inactive_reason = 'manual'
         WHERE point_id = ${f.sat}`;
      // The hand-run reactivation that forgets the reason. Refused.
      await tx.$executeRaw`
        UPDATE bas_points SET is_active = true WHERE point_id = ${f.sat}`;
    });
    expect(error.message).toContain("23514");
    expect(error.message).toContain("bas_points_inactive_reason_only_when_inactive");
  });

  it("filed Global_Alarm as alarm history, never as a system log, in the backfill SQL", async () => {
    // The backfill has already run on the test database against zero rows, so
    // its effect cannot be observed here; phb-bas/test_inactive_reason.py
    // applies the migration over nine seeded rows and checks each. What can be
    // checked here is that the statement filing Global_Alarm names the right
    // value - the one mistake this migration exists to prevent.
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const sql = await readFile(
      path.join(
        process.cwd(),
        "prisma/migrations/20260917234000_add_bas_inactive_reason/migration.sql",
      ),
      "utf8",
    );
    const alarm = sql.slice(sql.indexOf("SET inactive_reason = 'alarm_history'"));
    expect(alarm.slice(0, 300)).toContain("niagara_history_name = 'Global_Alarm'");
    const systemLogs = sql.slice(sql.indexOf("SET inactive_reason = 'niagara_system_log'"));
    expect(systemLogs.slice(0, 300)).not.toContain("Global_Alarm");
  });
});

describe("showing is not collecting (B8.1)", () => {
  /**
   * `label` and `is_visible` were added by add_bas_point_label_and_visibility.
   * Nothing reads them yet - B8.1 is schema only - so what is asserted here is
   * that their existence changes nothing for a row that has not been touched,
   * and that touching them changes nothing about collection.
   */
  it("a point nobody has touched is visible and unlabelled, exactly as before", async () => {
    await inRollback(async (tx) => {
      const f = await createBasFixture(tx);

      const points = await tx.basPoint.findMany({
        where: { stationId: f.stationId },
        select: { label: true, isVisible: true, isActive: true },
      });
      expect(points.length).toBeGreaterThan(0);
      for (const p of points) {
        expect(p.label).toBeNull();
        expect(p.isVisible).toBe(true);
        expect(p.isActive).toBe(true);
      }
    });
  });

  it("hiding and labelling a point leaves is_active alone", async () => {
    await inRollback(async (tx) => {
      const f = await createBasFixture(tx);

      const after = await tx.basPoint.update({
        where: { pointId: f.sat },
        data: { label: "Zone Temp 104-105", isVisible: false },
        select: { label: true, isVisible: true, isActive: true, niagaraDisplayName: true },
      });

      expect(after.label).toBe("Zone Temp 104-105");
      expect(after.isVisible).toBe(false);
      // The whole point of the distinction. A hide must never stop collection.
      expect(after.isActive).toBe(true);
      // And the Niagara name is untouched: label is a third field, not an edit.
      expect(after.niagaraDisplayName).toBe("AHU-1_SupplyAirTemp");
    });
  });

  it("a hidden point is still in bas_v_collection_health - hidden must not hide risk", async () => {
    await inRollback(async (tx) => {
      const f = await createBasFixture(tx);

      await tx.basPoint.update({
        where: { pointId: f.sat },
        data: { isVisible: false },
      });

      // The view has no is_visible filter and must never gain one: a hidden
      // point that starts losing history and says nothing is the 28 August
      // failure again. Screens that honour is_visible do so in the table they
      // render, never in the figures (docs/B8_point_management_plan.md).
      const rows = await tx.$queryRaw<Array<{ point_id: bigint; is_active: boolean }>>`
        SELECT point_id, is_active FROM bas_v_collection_health
         WHERE point_id = ${f.sat}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.is_active).toBe(true);
    });
  });

  it("accepts a label with content and rejects one without", async () => {
    await inRollback(async (tx) => {
      const f = await createBasFixture(tx);

      await tx.$executeRaw`
        UPDATE bas_points SET label = 'Supply Air Temp' WHERE point_id = ${f.sat}`;
      await tx.$executeRaw`
        UPDATE bas_points SET label = NULL WHERE point_id = ${f.sat}`;
    });

    const error = await expectRejection(async (tx) => {
      const f = await createBasFixture(tx);
      await tx.$executeRaw`
        UPDATE bas_points SET label = '' WHERE point_id = ${f.sat}`;
    });
    expect(error.message).toContain("23514");
    expect(error.message).toContain("bas_points_label_not_blank");
  });
});

describe("point identity survives a rename", () => {
  /**
   * docs/08's first invariant: the natural key is
   * `(station_id, niagara_history_name)` and everything else references the
   * surrogate `point_id`, so a point renamed in Niagara appears as a NEW row
   * rather than silently reinterpreting years of history.
   */
  it("refuses the same history name twice on one station", async () => {
    const error = await expectRejection(async (tx) => {
      const f = await createBasFixture(tx);

      await tx.$executeRaw`
        INSERT INTO bas_points (station_id, niagara_history_name)
        VALUES (${f.stationId}, 'AHU$2d1_SupplyAirTemp')`;
    });

    expect(error.message).toContain("23505");
  });

  it("gives a renamed point a new id and leaves the old history intact", async () => {
    await inRollback(async (tx) => {
      const f = await createBasFixture(tx);

      for (const [i, ts] of [
        "2026-01-15T17:00:00Z",
        "2026-01-15T17:15:00Z",
        "2026-01-15T17:30:00Z",
      ].entries()) {
        await tx.$executeRaw`
          INSERT INTO bas_readings (point_id, ts, value_num)
          VALUES (${f.sat}, ${new Date(ts)}, ${55 + i})`;
      }

      const renamed = await tx.basPoint.create({
        data: {
          stationId: f.stationId,
          equipmentId: f.equipmentId,
          niagaraHistoryName: "AHU$2d1_SAT",
          pointRole: "zztest_supply_air_temp",
        },
      });

      expect(renamed.pointId).not.toBe(f.sat);
      // The old point keeps every row. Reusing the id would have silently
      // changed what three years of history meant.
      expect(
        await countRows(tx, `bas_readings WHERE point_id = ${f.sat}`),
      ).toBe(3);
      expect(
        await countRows(tx, `bas_readings WHERE point_id = ${renamed.pointId}`),
      ).toBe(0);
    });
  });

  it("stores the history name verbatim, hex escapes and all", async () => {
    await inRollback(async (tx) => {
      const f = await createBasFixture(tx);

      const point = await tx.basPoint.findUniqueOrThrow({
        where: { pointId: f.sat },
        select: { niagaraHistoryName: true, niagaraDisplayName: true },
      });

      // $2d is a dash. This string goes into the oBIX URL as-is; decoding and
      // re-encoding is not reliably round-trippable and produces 404s that look
      // exactly like a missing point.
      expect(point.niagaraHistoryName).toBe("AHU$2d1_SupplyAirTemp");
      expect(point.niagaraHistoryName).toContain("$2d");
      // The pretty form is a separate column, not a replacement - and it is
      // NIAGARA's pretty form, hence the field name. A person's is `label`.
      expect(point.niagaraDisplayName).toBe("AHU-1_SupplyAirTemp");
    });
  });
});

describe("readings cannot outlive or precede their point", () => {
  it("cascades to readings when a point is deleted", async () => {
    await inRollback(async (tx) => {
      const f = await createBasFixture(tx);

      await tx.$executeRaw`
        INSERT INTO bas_readings (point_id, ts, value_num)
        VALUES (${f.sat}, '2026-01-15T17:00:00Z', 55.0)`;
      const before = await countRows(
        tx,
        `bas_readings WHERE point_id = ${f.sat}`,
      );

      await tx.$executeRaw`DELETE FROM bas_points WHERE point_id = ${f.sat}`;

      expect(before).toBe(1);
      expect(
        await countRows(tx, `bas_readings WHERE point_id = ${f.sat}`),
      ).toBe(0);
    });
  });

  it("refuses a reading with no point", async () => {
    const error = await expectRejection(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO bas_readings (point_id, ts, value_num)
        VALUES (999999999, '2026-01-15T17:00:00Z', 1.0)`;
    });

    // 23503 foreign_key_violation.
    expect(error.message).toContain("23503");
  });
});
