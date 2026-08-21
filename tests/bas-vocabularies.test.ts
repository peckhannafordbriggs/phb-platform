import { afterAll, describe, expect, it } from "vitest";
import { disconnectDb } from "./db";
import { inRollback } from "./bas-fixture";
import {
  BAS_EQUIPMENT_TYPES,
  BAS_POINT_ROLES,
  seedBasVocabularies,
} from "@/prisma/bas-vocabularies";

/**
 * The BAS semantic vocabularies, and the seeder that installs them.
 *
 * These rows used to reach the development database only via
 * `scripts/bas-import.ts`. No migration and no seed created them, so a fresh
 * database came up with an empty vocabulary, every point read as unclassified,
 * both pairing views returned nothing, and nothing anywhere said so. They are
 * reference data and now live in the seed alongside positions and departments.
 *
 * The real seeder runs here against the real database, inside a transaction that
 * is always rolled back. That is the only way to test it without leaving 116
 * rows behind: `npm run db:test:setup` applies migrations and deliberately does
 * NOT seed, because tests/setup.ts truncates between files.
 */

afterAll(async () => {
  await disconnectDb();
});

describe("the declared vocabulary", () => {
  /** Checks on the data itself, which need no database at all. */
  it("declares 91 point roles and 25 equipment types", async () => {
    // The counts the standalone 002_vocabularies.sql declares, and the counts
    // the development database has carried since the import.
    expect(BAS_POINT_ROLES).toHaveLength(91);
    expect(BAS_EQUIPMENT_TYPES).toHaveLength(25);
  });

  it("has no duplicate keys", async () => {
    const roles = BAS_POINT_ROLES.map((r) => r.pointRole);
    const types = BAS_EQUIPMENT_TYPES.map((t) => t.equipType);

    // A duplicate would make the seeder silently write one row twice and the
    // count assertions above would still pass.
    expect(new Set(roles).size).toBe(roles.length);
    expect(new Set(types).size).toBe(types.length);
  });

  it("points every setpoint_for and status_of at a declared role", async () => {
    const declared = new Set(BAS_POINT_ROLES.map((r) => r.pointRole));

    // Caught here rather than as a foreign-key violation halfway through a
    // deploy. These are self-referencing FKs on bas_point_roles.
    for (const role of BAS_POINT_ROLES) {
      if (role.setpointFor !== undefined) {
        expect(declared, `${role.pointRole}.setpointFor`).toContain(
          role.setpointFor,
        );
      }
      if (role.statusOf !== undefined) {
        expect(declared, `${role.pointRole}.statusOf`).toContain(role.statusOf);
      }
    }
  });

  it("declares 12 setpoint links and 8 status links", async () => {
    expect(
      BAS_POINT_ROLES.filter((r) => r.setpointFor !== undefined),
    ).toHaveLength(12);
    expect(BAS_POINT_ROLES.filter((r) => r.statusOf !== undefined)).toHaveLength(
      8,
    );
  });

  it("never links a role to itself", async () => {
    for (const role of BAS_POINT_ROLES) {
      expect(role.setpointFor).not.toBe(role.pointRole);
      expect(role.statusOf).not.toBe(role.pointRole);
    }
  });

  it("flags a setpoint as a setpoint and a status as a status", async () => {
    // The flags and the links have to agree, or bas_v_setpoint_pair pairs on
    // one and the UI filters on the other.
    for (const role of BAS_POINT_ROLES) {
      if (role.setpointFor !== undefined) {
        expect(role.isSetpoint, `${role.pointRole} is a setpoint`).toBe(true);
      }
      if (role.statusOf !== undefined) {
        expect(role.isStatus, `${role.pointRole} is a status`).toBe(true);
      }
    }
  });

  it("gives every role and type a non-empty description", async () => {
    // These strings reach an LLM prompt through bas_v_point. An empty one is a
    // role the model has to guess the meaning of.
    for (const role of BAS_POINT_ROLES) {
      expect(role.displayName.trim().length, role.pointRole).toBeGreaterThan(2);
      expect(role.description.trim().length, role.pointRole).toBeGreaterThan(10);
    }
    for (const type of BAS_EQUIPMENT_TYPES) {
      expect(type.description.trim().length, type.equipType).toBeGreaterThan(10);
    }
  });

  it("uses only the documented equipment categories", async () => {
    const categories = new Set(BAS_EQUIPMENT_TYPES.map((t) => t.category));

    // The set named in the bas_equipment_types.category comment. A typo here
    // would silently create a category nothing groups by.
    expect([...categories].sort()).toEqual([
      "air_side",
      "metering",
      "other",
      "plant",
      "terminal",
      "water_side",
    ]);
  });

  it("keeps the unclassified escape hatch, which is not the same as NULL", async () => {
    const escape = BAS_POINT_ROLES.find((r) => r.pointRole === "unclassified");

    // NULL means nobody has looked. 'unclassified' means somebody looked and
    // could not map it - a different, and reportable, state.
    expect(escape).toBeDefined();
    expect(escape?.description).toContain("reviewed-but-not-mappable");
  });
});

describe("seedBasVocabularies", () => {
  it("installs the whole vocabulary on a database that has none", async () => {
    await inRollback(async (tx) => {
      // The test database is migrated but never seeded, so this is genuinely the
      // fresh-database case rather than a re-run.
      expect(await tx.basPointRole.count()).toBe(0);
      expect(await tx.basEquipmentType.count()).toBe(0);

      const result = await seedBasVocabularies(tx);

      expect(result.pointRoles).toBe(91);
      expect(result.equipmentTypes).toBe(25);
      expect(result.setpointLinks).toBe(12);
      expect(result.statusLinks).toBe(8);
      expect(result.undeclared).toEqual([]);

      // Counted from the database, not from the return value - the return value
      // is what the seeder believes, these are the rows it actually wrote.
      expect(await tx.basPointRole.count()).toBe(91);
      expect(await tx.basEquipmentType.count()).toBe(25);
    });
  });

  it("resolves every link to a real row", async () => {
    await inRollback(async (tx) => {
      await seedBasVocabularies(tx);

      const dangling = await tx.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM bas_point_roles r
         WHERE (r.setpoint_for IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM bas_point_roles t
                                 WHERE t.point_role = r.setpoint_for))
            OR (r.status_of IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM bas_point_roles t
                                 WHERE t.point_role = r.status_of))`;

      // The foreign key would have refused a dangling link, so this really
      // asserts that the two-pass write got far enough to set them at all.
      expect(dangling[0]?.n).toBe(0);

      const linked = await tx.$queryRaw<Array<{ sp: number; st: number }>>`
        SELECT count(*) FILTER (WHERE setpoint_for IS NOT NULL)::int AS sp,
               count(*) FILTER (WHERE status_of IS NOT NULL)::int AS st
          FROM bas_point_roles`;
      expect(linked[0]?.sp).toBe(12);
      expect(linked[0]?.st).toBe(8);
    });
  });

  it("wires the two links the fault rules are built on", async () => {
    await inRollback(async (tx) => {
      await seedBasVocabularies(tx);

      const sat = await tx.basPointRole.findUniqueOrThrow({
        where: { pointRole: "supply_air_temp_sp" },
      });
      const fan = await tx.basPointRole.findUniqueOrThrow({
        where: { pointRole: "supply_fan_status" },
      });

      // "which units never reached setpoint" and "commanded on but not running".
      expect(sat.setpointFor).toBe("supply_air_temp");
      expect(sat.isSetpoint).toBe(true);
      expect(fan.statusOf).toBe("supply_fan_cmd");
      expect(fan.isStatus).toBe(true);
    });
  });

  it("is idempotent - a second run changes no value and adds no row", async () => {
    await inRollback(async (tx) => {
      await seedBasVocabularies(tx);

      const snapshot = async () =>
        JSON.stringify([
          await tx.basPointRole.findMany({ orderBy: { pointRole: "asc" } }),
          await tx.basEquipmentType.findMany({ orderBy: { equipType: "asc" } }),
        ]);

      const first = await snapshot();
      const second = await seedBasVocabularies(tx);
      const after = await snapshot();

      expect(after).toBe(first);
      expect(second.pointRoles).toBe(91);
      expect(await tx.basPointRole.count()).toBe(91);
      expect(await tx.basEquipmentType.count()).toBe(25);
    });
  });

  it("corrects a row that was edited by hand", async () => {
    await inRollback(async (tx) => {
      await seedBasVocabularies(tx);

      await tx.basPointRole.update({
        where: { pointRole: "supply_air_temp" },
        data: { displayName: "WRONG", isSetpoint: true, measurement: "flow" },
      });

      await seedBasVocabularies(tx);

      const fixed = await tx.basPointRole.findUniqueOrThrow({
        where: { pointRole: "supply_air_temp" },
      });

      // The flags are written explicitly rather than left to the column default,
      // so a wrong value is corrected rather than preserved.
      expect(fixed.displayName).toBe("Supply Air Temperature");
      expect(fixed.isSetpoint).toBe(false);
      expect(fixed.measurement).toBe("temperature");
    });
  });

  it("clears a link that has been removed from the declaration", async () => {
    await inRollback(async (tx) => {
      await seedBasVocabularies(tx);

      // zone_temp declares no links, so pass two must have written NULL rather
      // than skipping it. Set one by hand and confirm the next run clears it.
      await tx.basPointRole.update({
        where: { pointRole: "zone_temp" },
        data: { setpointFor: "supply_air_temp" },
      });

      await seedBasVocabularies(tx);

      const cleared = await tx.basPointRole.findUniqueOrThrow({
        where: { pointRole: "zone_temp" },
      });
      expect(cleared.setpointFor).toBeNull();
    });
  });

  it("reports a role the database has and this repo does not declare", async () => {
    await inRollback(async (tx) => {
      await seedBasVocabularies(tx);

      await tx.basPointRole.create({
        data: {
          pointRole: "zztest_invented_by_hand",
          displayName: "Invented",
          description: "Added outside the declaration.",
        },
      });

      const result = await seedBasVocabularies(tx);

      // Reported, never deleted: a role a point already references cannot be
      // removed (the FK is RESTRICT), and dropping vocabulary out from under
      // existing data would be worse than saying so.
      expect(result.undeclared).toEqual(["zztest_invented_by_hand"]);
      expect(
        await tx.basPointRole.findUnique({
          where: { pointRole: "zztest_invented_by_hand" },
        }),
      ).not.toBeNull();
    });
  });

  it("makes the pairing views work, which is the whole point", async () => {
    await inRollback(async (tx) => {
      await seedBasVocabularies(tx);

      // A minimal real fixture using the SEEDED vocabulary rather than the
      // zztest_ one, so this exercises the shipped role names end to end.
      const org = await tx.basOrg.create({ data: { name: "ZZTEST_VOCAB_ORG" } });
      const site = await tx.basSite.create({
        data: {
          orgId: org.orgId,
          name: "ZZTEST_VOCAB_SITE",
          timezone: "America/New_York",
        },
      });
      const station = await tx.basStation.create({
        data: { siteId: site.siteId, niagaraStationName: "ZZTestVocab" },
      });
      const equipment = await tx.basEquipment.create({
        data: { siteId: site.siteId, name: "AHU-VOCAB", equipType: "ahu" },
      });

      const point = (name: string, role: string, unit: string | null) =>
        tx.basPoint.create({
          data: {
            stationId: station.stationId,
            equipmentId: equipment.equipmentId,
            niagaraHistoryName: name,
            pointRole: role,
            unit,
          },
        });

      const sat = await point("AHU_SAT", "supply_air_temp", "degF");
      const satSp = await point("AHU_SAT_SP", "supply_air_temp_sp", "degF");
      const cmd = await point("AHU_FAN_CMD", "supply_fan_cmd", null);
      const status = await point("AHU_FAN_ST", "supply_fan_status", null);

      const pairs = await tx.$queryRaw<
        Array<{ measured_point_id: bigint; setpoint_point_id: bigint }>
      >`SELECT measured_point_id, setpoint_point_id FROM bas_v_setpoint_pair
         WHERE equipment_id = ${equipment.equipmentId}`;
      expect(pairs).toHaveLength(1);
      expect(pairs[0]?.measured_point_id).toBe(sat.pointId);
      expect(pairs[0]?.setpoint_point_id).toBe(satSp.pointId);

      const cs = await tx.$queryRaw<
        Array<{ command_point_id: bigint; status_point_id: bigint }>
      >`SELECT command_point_id, status_point_id FROM bas_v_command_status_pair
         WHERE equipment_id = ${equipment.equipmentId}`;
      expect(cs).toHaveLength(1);
      expect(cs[0]?.command_point_id).toBe(cmd.pointId);
      expect(cs[0]?.status_point_id).toBe(status.pointId);

      // Without the vocabulary all four of those points exist and both views
      // return nothing. That silence is what this whole file is about.
    });
  });
});
