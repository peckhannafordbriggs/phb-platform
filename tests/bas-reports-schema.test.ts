import { afterAll, describe, expect, it } from "vitest";
import { Prisma } from "@/lib/generated/prisma/client";
import { readSafetyCeiling } from "@/lib/modules/bas/reports/ceiling-read";
import { disconnectDb } from "./db";
import { createBasFixture, expectRejection, inRollback, type Tx } from "./bas-fixture";

/**
 * The half of the Reports schema Prisma cannot see (Phase 1): the CHECK
 * constraints the add_bas_reports migration writes by hand. Each is driven to
 * refuse, by name, so a constraint quietly dropped from a future migration
 * fails here rather than letting a row through that the service assumes
 * cannot exist.
 */

afterAll(async () => {
  await disconnectDb();
});

async function owner(tx: Tx) {
  return tx.employee.create({
    data: {
      email: "zztest.reports.schema@phb1899.com",
      firstName: "ZZ",
      lastName: "Schema",
      profileCompleted: true,
    },
  });
}

async function definition(tx: Tx, siteId: bigint, ownerId: string, over: Record<string, unknown> = {}) {
  return tx.basReportDefinition.create({
    data: {
      ownerEmployeeId: ownerId,
      name: "ZZTEST schema",
      siteId,
      scheduleKind: "weekly",
      scheduleParams: { weekdays: [1] },
      timeOfDay: "06:00",
      ...over,
    },
  });
}

describe("bas_report_definitions", () => {
  it("accepts a sound draft, and refuses the states a column cannot hold on its own", async () => {
    await inRollback(async (tx) => {
      const f = await createBasFixture(tx);
      const o = await owner(tx);
      const d = await definition(tx, f.siteId, o.id);
      expect(d.state).toBe("draft");
      expect(d.stationIds).toEqual([]);
      expect(d.analysisWindow).toBe("7d");
    });

    const cases: Array<{ constraint: string; over: Record<string, unknown> }> = [
      { constraint: "bas_report_definitions_name_not_blank", over: { name: "   " } },
      { constraint: "bas_report_definitions_preset_key_check", over: { presetKey: "health_hourly" } },
      { constraint: "bas_report_definitions_analysis_window_check", over: { analysisWindow: "2d" } },
      { constraint: "bas_report_definitions_schedule_kind_check", over: { scheduleKind: "hourly" } },
      { constraint: "bas_report_definitions_time_of_day_check", over: { timeOfDay: "6:00" } },
      { constraint: "bas_report_definitions_state_check", over: { state: "running" } },
      // The one that matters most: active means scheduled, and scheduled means a next run.
      { constraint: "bas_report_definitions_active_has_next_run", over: { state: "active", nextRunAt: null } },
      // Phase 3: a pause reason only in the state the scheduler pauses into.
      { constraint: "bas_report_definitions_paused_reason_matches_state", over: { pausedReason: "owner disabled" } },
    ];
    for (const c of cases) {
      const error = await expectRejection(async (tx) => {
        const f = await createBasFixture(tx);
        const o = await owner(tx);
        await definition(tx, f.siteId, o.id, c.over);
      });
      expect(error.message, c.constraint).toContain(c.constraint);
    }
  });

  it("holds the list columns NOT NULL through a CHECK Prisma cannot see", async () => {
    const error = await expectRejection(async (tx) => {
      const f = await createBasFixture(tx);
      const o = await owner(tx);
      const d = await definition(tx, f.siteId, o.id);
      await tx.$executeRawUnsafe(`UPDATE bas_report_definitions SET station_ids = NULL WHERE report_id = ${d.reportId}`);
    });
    expect(error.message).toContain("bas_report_definitions_station_ids_not_null");
  });
});

describe("bas_report_settings", () => {
  it("holds one row, bounded both ways, and reads as the defaults when the row is absent", async () => {
    // The test suite's truncation of employees CASCADEs through updated_by_id
    // and can take the migration's row with it, so the row is made here.
    const seeded = await expectRejection(async (tx) => {
      await tx.basReportSettings.upsert({ where: { settingsId: 1 }, create: { settingsId: 1 }, update: {} });
      await tx.basReportSettings.create({ data: { settingsId: 2 } });
    });
    expect(seeded.message).toContain("bas_report_settings_single_row");

    const usd = await expectRejection(async (tx) => {
      await tx.basReportSettings.upsert({ where: { settingsId: 1 }, create: { settingsId: 1, ceilingUsd: new Prisma.Decimal("0") }, update: { ceilingUsd: new Prisma.Decimal("0") } });
    });
    expect(usd.message).toContain("bas_report_settings_ceiling_usd_range");
    const tooMuch = await expectRejection(async (tx) => {
      await tx.basReportSettings.upsert({ where: { settingsId: 1 }, create: { settingsId: 1, ceilingUsd: new Prisma.Decimal("1000.01") }, update: { ceilingUsd: new Prisma.Decimal("1000.01") } });
    });
    expect(tooMuch.message).toContain("bas_report_settings_ceiling_usd_range");
    for (const minutes of [0, 26]) {
      const error = await expectRejection(async (tx) => {
        await tx.basReportSettings.upsert({ where: { settingsId: 1 }, create: { settingsId: 1, ceilingMinutes: minutes }, update: { ceilingMinutes: minutes } });
      });
      expect(error.message, String(minutes)).toContain("bas_report_settings_ceiling_minutes_range");
    }

    await inRollback(async (tx) => {
      const row = await tx.basReportSettings.upsert({ where: { settingsId: 1 }, create: { settingsId: 1 }, update: {} });
      expect(Number(row.ceilingUsd)).toBe(10);
      expect(row.ceilingMinutes).toBe(25);
      await tx.basReportSettings.delete({ where: { settingsId: 1 } });
      expect(await readSafetyCeiling(tx)).toMatchObject({ usd: 10, minutes: 25, updatedAt: null, updatedBy: null });
      // It is platform configuration: the model's dictionary never mentions it.
      const described = await tx.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM bas_v_data_dictionary WHERE object_name = 'bas_report_settings'`;
      expect(described[0]?.n).toBe(0);
    });
  });
});

describe("bas_report_questions", () => {
  it("has exactly one source per row, decided by kind", async () => {
    const lib = await expectRejection(async (tx) => {
      const f = await createBasFixture(tx);
      const o = await owner(tx);
      const d = await definition(tx, f.siteId, o.id);
      await tx.basReportQuestion.create({
        data: { reportId: d.reportId, position: 0, kind: "library", inlineText: "both" },
      });
    });
    expect(lib.message).toContain("bas_report_questions_one_source");

    const blank = await expectRejection(async (tx) => {
      const f = await createBasFixture(tx);
      const o = await owner(tx);
      const d = await definition(tx, f.siteId, o.id);
      await tx.basReportQuestion.create({ data: { reportId: d.reportId, position: 0, kind: "inline", inlineText: "  " } });
    });
    expect(blank.message).toContain("bas_report_questions_one_source");

    const kind = await expectRejection(async (tx) => {
      const f = await createBasFixture(tx);
      const o = await owner(tx);
      const d = await definition(tx, f.siteId, o.id);
      await tx.basReportQuestion.create({ data: { reportId: d.reportId, position: 0, kind: "shared", inlineText: "x" } });
    });
    expect(kind.message).toContain("bas_report_questions_kind_check");
  });
});

describe("bas_library_questions", () => {
  it("a computed question must name its function, and sections and kinds are closed", async () => {
    const fn = await expectRejection(async (tx) => {
      await tx.basLibraryQuestion.create({
        data: { key: "q99_test", section: "summary", position: 99, text: "t", kind: "computed", appliesToLabel: "All" },
      });
    });
    expect(fn.message).toContain("bas_library_questions_computed_has_fn");

    const section = await expectRejection(async (tx) => {
      await tx.basLibraryQuestion.create({
        data: { key: "q99_test", section: "plumbing", position: 99, text: "t", kind: "planner", appliesToLabel: "All" },
      });
    });
    expect(section.message).toContain("bas_library_questions_section_check");

    // A planner question needs no function.
    await inRollback(async (tx) => {
      const row = await tx.basLibraryQuestion.create({
        data: { key: "zz_planner", section: "schedules", position: 99, text: "t", kind: "planner", appliesToLabel: "All" },
      });
      expect(row.analysisFn).toBeNull();
      expect(Number(row.minCoverage)).toBe(0.8);
    });
  });
});

describe("bas_report_recipients", () => {
  it("an external row must carry a confirmation, and an address is stored lower-cased and shaped like one", async () => {
    const unconfirmed = await expectRejection(async (tx) => {
      const f = await createBasFixture(tx);
      const o = await owner(tx);
      const d = await definition(tx, f.siteId, o.id);
      await tx.basReportRecipient.create({ data: { reportId: d.reportId, email: "v@example.com", isExternal: true } });
    });
    expect(unconfirmed.message).toContain("bas_report_recipients_external_confirmed");

    const upper = await expectRejection(async (tx) => {
      const f = await createBasFixture(tx);
      const o = await owner(tx);
      const d = await definition(tx, f.siteId, o.id);
      await tx.basReportRecipient.create({ data: { reportId: d.reportId, email: "Jim@phb1899.com", isExternal: false } });
    });
    expect(upper.message).toContain("bas_report_recipients_email_lower");

    const shape = await expectRejection(async (tx) => {
      const f = await createBasFixture(tx);
      const o = await owner(tx);
      const d = await definition(tx, f.siteId, o.id);
      await tx.basReportRecipient.create({ data: { reportId: d.reportId, email: "not-an-address", isExternal: false } });
    });
    expect(shape.message).toContain("bas_report_recipients_email_shape");

    await inRollback(async (tx) => {
      const f = await createBasFixture(tx);
      const o = await owner(tx);
      const d = await definition(tx, f.siteId, o.id);
      const row = await tx.basReportRecipient.create({
        data: { reportId: d.reportId, email: "v@example.com", isExternal: true, confirmedById: o.id, confirmedAt: new Date() },
      });
      expect(row.isExternal).toBe(true);
      // Cascade: deleting the report takes its recipients with it.
      await tx.basReportDefinition.delete({ where: { reportId: d.reportId } });
      expect(await tx.basReportRecipient.count({ where: { reportId: d.reportId } })).toBe(0);
    });
  });
});

describe("bas_site_occupancy", () => {
  it("one range per ISO weekday, start before end, within the day", async () => {
    const weekday = await expectRejection(async (tx) => {
      const f = await createBasFixture(tx);
      await tx.basSiteOccupancy.create({ data: { siteId: f.siteId, weekday: 0, startMinute: 480, endMinute: 1080 } });
    });
    expect(weekday.message).toContain("bas_site_occupancy_weekday_check");

    const minutes = await expectRejection(async (tx) => {
      const f = await createBasFixture(tx);
      await tx.basSiteOccupancy.create({ data: { siteId: f.siteId, weekday: 1, startMinute: 1080, endMinute: 480 } });
    });
    expect(minutes.message).toContain("bas_site_occupancy_minutes_check");

    await inRollback(async (tx) => {
      const f = await createBasFixture(tx);
      await tx.basSiteOccupancy.create({ data: { siteId: f.siteId, weekday: 1, startMinute: 480, endMinute: 1080 } });
      await tx.basSiteOccupancy.create({ data: { siteId: f.siteId, weekday: 7, startMinute: 0, endMinute: 1440 } });
      expect(await tx.basSiteOccupancy.count({ where: { siteId: f.siteId } })).toBe(2);
      // It is building data: the model's dictionary describes it.
      const described = await tx.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM bas_v_data_dictionary
         WHERE object_name = 'bas_site_occupancy' AND column_description IS NOT NULL`;
      expect(described[0]?.n).toBe(4);
    });
  });
});
