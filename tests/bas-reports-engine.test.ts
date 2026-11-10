import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { Prisma } from "@/lib/generated/prisma/client";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { createFixedNarrator } from "@/lib/modules/bas/reports/engine/narrative";
import { executeReportRun } from "@/lib/modules/bas/reports/engine/run";
import type { ReportDocument } from "@/lib/modules/bas/reports/engine/types";
import { createReport } from "@/lib/modules/bas/reports/service";
import { seedBasReportLibrary } from "@/prisma/bas-report-library";
import { BAS_EQUIPMENT_TYPES, BAS_POINT_ROLES } from "@/prisma/bas-vocabularies";
import { GET as listRunsRoute } from "@/app/api/modules/bas/reports/runs/route";
import { GET as getRunRoute } from "@/app/api/modules/bas/reports/runs/[runId]/route";
import { DELETE as deleteReportRoute } from "@/app/api/modules/bas/reports/[reportId]/route";
import { PUT as occupancyRoute } from "@/app/api/modules/bas/settings/buildings/[siteId]/occupancy/route";
import { GET as settingsTreeRoute } from "@/app/api/modules/bas/settings/route";
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
 * The engine end to end (Reports, Phase 2), against the real test database
 * with a synthetic building whose answers are known: one rooftop unit with
 * an occupancy point, an outdoor temperature and a fan status; two VAVs with
 * a room temperature and a setpoint, one of them warm every afternoon and
 * the other flat at 70.5 all week.
 *
 * What is proved: a run stores its row and its findings; the hydronic
 * sections are Not Applicable; the questions needing airflow or compressor
 * roles are Not Monitored naming them; the flat point is a Data Health row
 * and raises no comfort finding; the second run marks everything still open
 * and the third marks a fixed zone cleared; the budget cap and a missing key
 * each make the run partial with the reason; the occupancy fallback works
 * and the Settings route that sets it is audited and admin-only; and runs
 * are visible to the owner and a module admin, and to nobody else.
 */

const authMock = vi.mocked(auth);
const NY = "America/New_York";
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;
/** Monday 2 November 2026 00:00 EST, a week with no clock change. */
const START = Date.UTC(2026, 10, 2, 5);
const END = START + 7 * DAY;
const PERIOD_END = new Date(END);

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

const hourNY = (t: number) => Number(new Intl.DateTimeFormat("en-US", { timeZone: NY, hour: "numeric", hourCycle: "h23" }).format(new Date(t)));
const weekdayNY = (t: number) => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(new Intl.DateTimeFormat("en-US", { timeZone: NY, weekday: "short" }).format(new Date(t))) + 1;

const ROLES = ["zone_temp", "zone_temp_sp", "occupancy_status", "outside_air_temp", "supply_fan_status", "supply_air_temp"];
const TYPES = ["rtu", "vav"];

let owner: Awaited<ReturnType<typeof createEmployee>>;
let other: Awaited<ReturnType<typeof createEmployee>>;
let admin: Awaited<ReturnType<typeof createEmployee>>;
let siteId: bigint;
let stationId: bigint;
let reportId: string;
let occupancyPointId: bigint;
let warmPointId: bigint;
const createdRoles: string[] = [];
const createdTypes: string[] = [];

async function insertReadings(pointId: bigint, rows: Array<[number, number | null, boolean | null]>): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    const values = rows.slice(i, i + 500).map(([t, num, bool]) => Prisma.sql`(${pointId}, ${new Date(t)}, ${num}::float8, ${bool}::boolean)`);
    await testDb.$executeRaw`INSERT INTO bas_readings (point_id, ts, value_num, value_bool) VALUES ${Prisma.join(values)}`;
  }
}

function every15(value: (t: number) => number): Array<[number, number | null, boolean | null]> {
  const out: Array<[number, number | null, boolean | null]> = [];
  for (let t = START; t < END; t += 15 * MIN) out.push([t, value(t), null]);
  return out;
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetBasAvailabilityCache();
  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();
  await seedBasReportLibrary(testDb);

  owner = await createEmployee({ email: "zztest.engine.owner@phb1899.com" });
  other = await createEmployee({ email: "zztest.engine.other@phb1899.com" });
  admin = await createEmployee({ email: "zztest.engine.admin@phb1899.com" });
  for (const e of [owner, other, admin]) await grantModule(e.id, BAS_MODULE_KEY);
  await grantModuleAdmin(admin.id, BAS_MODULE_KEY);

  // The vocabulary rows the library's requirements name. Real keys, created
  // only where absent and removed at the end, so no other file sees them.
  for (const key of ROLES) {
    const seed = BAS_POINT_ROLES.find((r) => r.pointRole === key)!;
    const exists = await testDb.basPointRole.findUnique({ where: { pointRole: key } });
    if (exists === null) {
      await testDb.basPointRole.create({
        data: { pointRole: key, displayName: seed.displayName, description: seed.description, measurement: seed.measurement, typicalUnit: seed.typicalUnit, isSetpoint: seed.isSetpoint ?? false, isStatus: seed.isStatus ?? false, isCommand: seed.isCommand ?? false },
      });
      createdRoles.push(key);
    }
  }
  for (const key of TYPES) {
    const seed = BAS_EQUIPMENT_TYPES.find((t) => t.equipType === key)!;
    const exists = await testDb.basEquipmentType.findUnique({ where: { equipType: key } });
    if (exists === null) {
      await testDb.basEquipmentType.create({ data: { equipType: key, displayName: seed.displayName, description: seed.description, category: seed.category } });
      createdTypes.push(key);
    }
  }

  const org = await testDb.basOrg.create({ data: { name: "ZZTEST_ENGINE_ORG" } });
  const project = await testDb.basProject.create({ data: { orgId: org.orgId, name: "ZZTEST_ENGINE_PROJECT" } });
  const site = await testDb.basSite.create({ data: { orgId: org.orgId, projectId: project.projectId, name: "ZZTEST_ENGINE_SITE", timezone: NY } });
  siteId = site.siteId;
  const station = await testDb.basStation.create({ data: { siteId, niagaraStationName: "ZZTestEngineStation", connectionMode: "direct", baseUrl: "https://198.51.100.21" } });
  stationId = station.stationId;
  const rv = await testDb.basEquipment.create({ data: { siteId, name: "RV", equipType: "rtu" } });
  const vav1 = await testDb.basEquipment.create({ data: { siteId, name: "VAV-1", equipType: "vav", parentEquipmentId: rv.equipmentId } });
  const vav2 = await testDb.basEquipment.create({ data: { siteId, name: "VAV-2", equipType: "vav", parentEquipmentId: rv.equipmentId } });

  const point = async (name: string, role: string, equipmentId: bigint, over: Partial<{ unit: string; dataType: string; intervalS: number | null }> = {}) =>
    (
      await testDb.basPoint.create({
        data: {
          stationId,
          equipmentId,
          niagaraHistoryName: name,
          pointRole: role,
          unit: over.unit ?? "fahrenheit",
          dataType: over.dataType ?? "real",
          collectionIntervalS: over.intervalS === undefined ? 900 : over.intervalS,
          capacity: 500,
          fullPolicy: "roll",
        },
      })
    ).pointId;

  const occ = await point("Occupied", "occupancy_status", rv.equipmentId, { unit: "", dataType: "bool", intervalS: null });
  occupancyPointId = occ;
  const oat = await point("Outside_Air_Temp", "outside_air_temp", rv.equipmentId);
  const fan = await point("Supply_Fan_Status", "supply_fan_status", rv.equipmentId, { unit: "", dataType: "bool" });
  const t1 = await point("VAV-1_ZoneTemperature", "zone_temp", vav1.equipmentId);
  warmPointId = t1;
  const sp1 = await point("VAV-1_Setpoint", "zone_temp_sp", vav1.equipmentId);
  const t2 = await point("VAV-2_ZoneTemperature", "zone_temp", vav2.equipmentId);
  const sp2 = await point("VAV-2_Setpoint", "zone_temp_sp", vav2.equipmentId);

  // Occupancy: a change-of-value point, carried in from before the period,
  // then on at 08:00 and off at 18:00 each weekday.
  const occRows: Array<[number, number | null, boolean | null]> = [[START - DAY, null, false]];
  for (let d = 0; d < 7; d += 1) {
    const dayStart = START + d * DAY;
    if (weekdayNY(dayStart + 12 * HOUR) <= 5) {
      occRows.push([dayStart + 8 * HOUR, null, true], [dayStart + 18 * HOUR, null, false]);
    }
  }
  await insertReadings(occ, occRows);
  await insertReadings(oat, every15((t) => 50 + 10 * Math.sin(t / (6 * HOUR))));
  // Fan on 05:00-18:00 on weekdays: three hours a day before occupancy, 15 h in the week.
  await insertReadings(fan, every15((t) => (weekdayNY(t) <= 5 && hourNY(t) >= 5 && hourNY(t) < 18 ? 1 : 0)).map(([t, v]) => [t, null, v === 1]));
  // VAV-1: 4 °F over the 72 setpoint every weekday afternoon 14:00-18:00 (40%
  // of occupied hours), wandering a little the rest of the time the way a real
  // room does - held at exactly 72 all weekend it would be flat-lined, and
  // rightly so.
  await insertReadings(t1, every15((t) => (weekdayNY(t) <= 5 && hourNY(t) >= 14 && hourNY(t) < 18 ? 76 : 72 + 0.3 * Math.sin(t / HOUR))));
  await insertReadings(sp1, every15(() => 72));
  // VAV-2: exactly 70.5 all week.
  await insertReadings(t2, every15(() => 70.5));
  await insertReadings(sp2, every15(() => 72));

  signedInAs(owner.entraOid!);
  const created = await createReport({ ...owner, profileCompleted: true }, {
    name: "ZZTEST engine weekly",
    siteId: siteId.toString(),
    presetKey: "health_weekly",
    analysisWindow: "7d",
    schedule: { kind: "weekly", weekdays: [1] },
    timeOfDay: "06:00",
  });
  reportId = created.reportId;
}, 120_000);

afterAll(async () => {
  await resetDb();
  await testDb.basPoint.deleteMany({ where: { stationId } });
  await testDb.basEquipment.deleteMany({ where: { siteId } });
  await testDb.basStation.deleteMany({ where: { siteId } });
  await testDb.basSiteOccupancy.deleteMany({ where: { siteId } });
  await testDb.basSite.deleteMany({ where: { name: "ZZTEST_ENGINE_SITE" } });
  await testDb.basProject.deleteMany({ where: { name: "ZZTEST_ENGINE_PROJECT" } });
  await testDb.basOrg.deleteMany({ where: { name: "ZZTEST_ENGINE_ORG" } });
  await testDb.basPointRole.deleteMany({ where: { pointRole: { in: createdRoles } } });
  await testDb.basEquipmentType.deleteMany({ where: { equipType: { in: createdTypes } } });
  await disconnectDb();
});

const bare = (url = "http://localhost/api/modules/bas/reports/runs") => new Request(url);
async function data<T>(r: Response): Promise<T> {
  return ((await r.json()) as { data: T }).data;
}

let firstRunId: string;
let firstDocument: ReportDocument;
/** Every run this file makes, so the visibility test knows how many to expect. */
let runsMade = 0;
const counted = <T extends { runId: string }>(outcome: T): T => {
  runsMade += 1;
  return outcome;
};

describe("a run of the standard weekly preset on the synthetic building", () => {
  it("stores the run and its findings, decides every question, and keeps the flat point out of the comfort section", async () => {
    const narrator = createFixedNarrator({ costPerCall: 0.01 });
    const outcome = counted(await executeReportRun(reportId, { periodEnd: PERIOD_END, trigger: "manual", startedById: owner.id, narrator }));
    firstRunId = outcome.runId;
    firstDocument = outcome.document;
    const doc = outcome.document;

    expect(outcome.status).toBe("succeeded");
    expect(doc.summary.status).toBe("watch");
    expect(doc.summary.counts).toEqual({ new: 3, stillOpen: 0, cleared: 0 });
    expect(doc.inventory.equipmentTypesFound).toEqual([]);
    expect(doc.inventory.occupancy).toEqual([{ stationName: "ZZTestEngineStation", kind: "point", detail: "Occupied (occupancy status point)" }]);
    expect(doc.header.outdoor?.pointName).toBe("Outside_Air_Temp");

    const section = (key: string) => doc.sections.find((s) => s.key === key)!;
    expect(section("hot_water").status).toBe("not_applicable");
    expect(section("chilled_water").status).toBe("not_applicable");
    const q = (key: string) => doc.sections.flatMap((s) => s.questions).find((x) => x.key === key)!;
    expect(q("q06_vav_starved_airflow")).toMatchObject({ outcome: "not_monitored", missing: ["airflow", "airflow setpoint"] });
    expect(q("q15_compressor_short_cycling")).toMatchObject({ outcome: "not_monitored", missing: ["compressor status or stage command"] });
    expect(q("q09_dat_holds_setpoint").outcome).toBe("not_monitored");
    expect(q("q08_reheat_open_above_cooling_sp").outcome).toBe("not_applicable");
    expect(q("q03_zone_comfort")).toMatchObject({ outcome: "answered", equipment: ["VAV-1"] });
    // The flat zone is skipped by name, with the reason: its sensor was excluded.
    expect(q("q03_zone_comfort").skipped).toEqual([{ name: "VAV-2", reason: "missing space temp" }]);
    expect(q("q19_run_outside_schedule")).toMatchObject({ outcome: "answered", equipment: ["RV"] });

    const comfort = section("space_comfort");
    expect(comfort.status).toBe("watch");
    expect(comfort.findings.map((f) => [f.subjectName, f.issueCode, f.priority, f.state])).toEqual([["VAV-1", "zone_warm", "watch", "new"]]);
    expect(comfort.findings[0]!.evidence.percent).toBe(40);
    expect(comfort.findings[0]!.likelyCause).toMatch(/^Likely/);
    expect(q("q03_zone_comfort").metrics.overallPercentInBand).toBe(60);

    const health = section("data_health");
    expect(health.findings.map((f) => [f.subjectName, f.issueCode])).toEqual([["VAV-2_ZoneTemperature", "flat"]]);
    // The flat zone raises no comfort finding and is not a zone judged; it is
    // listed as skipped, by name and with the reason, so the reader can see why.
    expect(comfort.findings.map((f) => f.subjectName)).not.toContain("VAV-2");
    expect(JSON.stringify(comfort.questions.map((qq) => qq.metrics))).not.toContain("VAV-2");
    expect(comfort.questions.map((qq) => qq.skipped)).toEqual([
      [{ name: "VAV-2", reason: "missing space temp" }],
      [{ name: "VAV-2", reason: "missing space temp" }],
      [{ name: "RV", reason: "missing override or priority status" }, { name: "VAV-1", reason: "missing override or priority status" }, { name: "VAV-2", reason: "missing override or priority status" }],
    ]);

    const schedules = section("schedules");
    expect(schedules.findings[0]).toMatchObject({ subjectName: "RV", issueCode: "ran_unoccupied", priority: "watch" });
    expect(schedules.findings[0]!.evidence.hoursOutside).toBe(15);
    expect(schedules.findings[0]!.evidence.days).toBe(5);

    // Three sections had findings: three narrative calls at a cent each.
    expect(narrator.calls.map((c) => c.sectionLabel).sort()).toEqual(["Data Health", "Schedules", "Space Comfort"]);
    expect(doc.cost).toMatchObject({ calls: 3, costUsd: 0.03, budgetUsd: 2, model: "fixed" });

    const stored = await testDb.basReportRun.findUniqueOrThrow({ where: { runId: BigInt(firstRunId) }, include: { findings: true } });
    expect(stored.status).toBe("succeeded");
    expect(stored.previousRunId).toBeNull();
    expect(Number(stored.costUsd)).toBe(0.03);
    expect(stored.reportHtml).toContain("ZZTEST_ENGINE_SITE BAS Health Report");
    expect(stored.findings).toHaveLength(3);
    expect(stored.findings.every((f) => f.state === "new" && f.firstSeenRunId === stored.runId)).toBe(true);
    expect(stored.findings.find((f) => f.subjectName === "VAV-2_ZoneTemperature")?.section).toBe("data_health");

    const audit = await testDb.auditEvent.findMany({ where: { action: { in: ["bas.report_run_started", "bas.report_run_finished"] } }, orderBy: { occurredAt: "asc" } });
    expect(audit.map((a) => a.action)).toEqual(["bas.report_run_started", "bas.report_run_finished"]);
    expect(audit[1]?.metadata).toMatchObject({ status: "succeeded", findings: 3, costUsd: 0.03 });
    expect(audit[1]?.actorEmployeeId).toBe(owner.id);
  });

  it("marks every finding still open on a second run of the same period, keeping the first-seen run", async () => {
    const outcome = counted(await executeReportRun(reportId, { periodEnd: PERIOD_END, trigger: "manual", startedById: owner.id, narrator: createFixedNarrator() }));
    expect(outcome.status).toBe("succeeded");
    expect(outcome.document.summary.counts).toEqual({ new: 0, stillOpen: 3, cleared: 0 });
    const live = outcome.document.sections.flatMap((s) => s.findings);
    expect(live.every((f) => f.state === "still_open" && f.firstSeenRunId === firstRunId)).toBe(true);
    const stored = await testDb.basReportRun.findUniqueOrThrow({ where: { runId: BigInt(outcome.runId) } });
    expect(stored.previousRunId?.toString()).toBe(firstRunId);
    // Nothing is Action Needed, so nothing is carried forward.
    expect(outcome.document.carriedForward).toEqual([]);
  });

  it("marks a fixed zone cleared on the next run, with the previous run's evidence", async () => {
    // The zone fixed: in band all week, still moving.
    await testDb.$executeRaw`UPDATE bas_readings SET value_num = 72 + 0.3 * sin(EXTRACT(EPOCH FROM ts) / 3600) WHERE point_id = ${warmPointId}`;
    const outcome = counted(await executeReportRun(reportId, { periodEnd: PERIOD_END, trigger: "manual", startedById: owner.id, narrator: createFixedNarrator() }));
    expect(outcome.document.summary.counts).toEqual({ new: 0, stillOpen: 2, cleared: 1 });
    expect(outcome.document.cleared.map((f) => [f.subjectName, f.state])).toEqual([["VAV-1", "cleared"]]);
    expect(outcome.document.cleared[0]!.evidence.percent).toBe(40);
    const rows = await testDb.basReportFinding.findMany({ where: { runId: BigInt(outcome.runId) } });
    expect(rows.map((r) => r.state).sort()).toEqual(["cleared", "still_open", "still_open"]);
  });

  it("stops issuing narrative calls at the budget and finishes partial with the reason", async () => {
    const narrator = createFixedNarrator({ costPerCall: 1.5 });
    const outcome = counted(await executeReportRun(reportId, { periodEnd: PERIOD_END, trigger: "manual", startedById: owner.id, narrator }));
    expect(outcome.status).toBe("partial");
    expect(outcome.partialReason).toContain("Budget of $2.00 reached after 1 of 2 sections had narrative");
    expect(narrator.calls).toHaveLength(1);
    expect(outcome.document.cost.costUsd).toBe(1.5);
    const stored = await testDb.basReportRun.findUniqueOrThrow({ where: { runId: BigInt(outcome.runId) } });
    expect(stored.status).toBe("partial");
    expect(stored.partialReason).toContain("Budget");
  });

  it("finishes partial and says so when no model key is configured", async () => {
    const outcome = counted(await executeReportRun(reportId, { periodEnd: PERIOD_END, trigger: "manual", startedById: null, narrator: null }));
    expect(outcome.status).toBe("partial");
    expect(outcome.partialReason).toContain("Narrative not generated: no model key is configured");
    expect(outcome.document.cost).toMatchObject({ calls: 0, costUsd: 0, model: null });
    const health = outcome.document.sections.find((s) => s.key === "data_health")!;
    expect(health.findings[0]!.likelyCause).toBeNull();
    const audit = await testDb.auditEvent.findFirst({ where: { action: "bas.report_run_finished", actorEmployeeId: null }, orderBy: { occurredAt: "desc" } });
    expect(audit?.metadata).toMatchObject({ status: "partial" });
  });
});

describe("the occupancy fallback", () => {
  it("falls back to the building's manual hours when the occupancy point is not collected, and to nothing when there are none", async () => {
    await testDb.basPoint.update({ where: { pointId: occupancyPointId }, data: { isActive: false, inactiveReason: "manual" } });

    // Nothing entered yet: no source, and the comfort question names occupancy.
    const none = counted(await executeReportRun(reportId, { periodEnd: PERIOD_END, trigger: "manual", startedById: null, narrator: createFixedNarrator() }));
    expect(none.document.inventory.occupancy[0]).toMatchObject({ kind: "none" });
    const q3 = none.document.sections.flatMap((s) => s.questions).find((q) => q.key === "q03_zone_comfort")!;
    expect(q3.outcome).toBe("not_monitored");
    expect(q3.missing).toEqual(["occupancy"]);

    // The Settings route: a module admin sets weekday hours; a plain BAS user is told nothing exists.
    const body = { days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: "08:00", end: "18:00" })) };
    const put = (b: unknown) =>
      occupancyRoute(new Request("http://localhost", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }), {
        params: Promise.resolve({ siteId: siteId.toString() }),
      });
    signedInAs(other.entraOid!);
    expect((await put(body)).status).toBe(404);
    signedInAs(admin.entraOid!);
    expect((await put({ days: [{ weekday: 1, start: "18:00", end: "08:00" }] })).status).toBe(422);
    expect((await put({ days: [{ weekday: 1, start: "08:00", end: "18:00" }, { weekday: 1, start: "08:00", end: "18:00" }] })).status).toBe(422);
    const saved = await put(body);
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(await testDb.basSiteOccupancy.count({ where: { siteId } })).toBe(5);
    const audit = await testDb.auditEvent.findFirst({ where: { action: "bas.building_occupancy_updated" }, orderBy: { occurredAt: "desc" } });
    expect(audit?.actorEmployeeId).toBe(admin.id);
    expect(audit?.metadata).toMatchObject({ name: "ZZTEST_ENGINE_SITE", hours: "Mon 08:00-18:00, Tue 08:00-18:00, Wed 08:00-18:00, Thu 08:00-18:00, Fri 08:00-18:00", previousHours: "none" });

    // The tree shows the hours and says the station has no occupancy point now.
    const tree = await data<{ projects: Array<{ buildings: Array<{ name: string; occupancy: unknown[]; stations: Array<{ hasOccupancyPoint: boolean }> }> }> }>(
      await settingsTreeRoute(new Request("http://localhost/api/modules/bas/settings?q=ZZTEST_ENGINE")),
    );
    const building = tree.projects.flatMap((p) => p.buildings).find((b) => b.name === "ZZTEST_ENGINE_SITE")!;
    expect(building.occupancy).toHaveLength(5);
    expect(building.stations[0]?.hasOccupancyPoint).toBe(false);

    // The same week judged against the manual hours gives the same comfort answer.
    const manual = counted(await executeReportRun(reportId, { periodEnd: PERIOD_END, trigger: "manual", startedById: null, narrator: createFixedNarrator() }));
    expect(manual.document.inventory.occupancy[0]).toMatchObject({ kind: "manual" });
    expect(manual.document.inventory.occupancy[0]!.detail).toContain("Mon 08:00-18:00");
    const comfort = manual.document.sections.find((s) => s.key === "space_comfort")!;
    expect(comfort.questions.find((q) => q.key === "q03_zone_comfort")?.outcome).toBe("answered");
    const schedules = manual.document.sections.find((s) => s.key === "schedules")!;
    expect(schedules.findings[0]!.evidence.hoursOutside).toBe(15);

    await testDb.basPoint.update({ where: { pointId: occupancyPointId }, data: { isActive: true, inactiveReason: null } });
  });
});

describe("who sees a run", () => {
  it("the owner and a module admin see the runs; another BAS user sees none and is told a run does not exist", async () => {
    signedInAs(owner.entraOid!);
    const mine = await data<{ runs: Array<{ runId: string; reportName: string; status: string }>; runsInDatabase: number }>(await listRunsRoute(bare()));
    expect(mine.runsInDatabase).toBe(runsMade);
    expect(mine.runs[0]?.reportName).toBe("ZZTEST engine weekly");
    const detail = await getRunRoute(bare(), { params: Promise.resolve({ runId: firstRunId }) });
    expect(detail.status).toBe(200);
    const run = await data<{ document: ReportDocument; status: string }>(detail);
    expect(run.document.header.buildingName).toBe(firstDocument.header.buildingName);

    signedInAs(admin.entraOid!);
    expect((await data<{ runs: unknown[] }>(await listRunsRoute(bare(`http://localhost/api/modules/bas/reports/runs?report=${reportId}`)))).runs.length).toBe(runsMade);
    expect((await getRunRoute(bare(), { params: Promise.resolve({ runId: firstRunId }) })).status).toBe(200);

    signedInAs(other.entraOid!);
    expect(await data<{ runs: unknown[]; runsInDatabase: number }>(await listRunsRoute(bare()))).toEqual({ runs: [], runsInDatabase: 0 });
    const denied = await getRunRoute(bare(), { params: Promise.resolve({ runId: firstRunId }) });
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain("ZZTEST_ENGINE_SITE");
  });

  it("refuses to delete a report that has runs, with the count", async () => {
    signedInAs(owner.entraOid!);
    const response = await deleteReportRoute(new Request("http://localhost", { method: "DELETE" }), { params: Promise.resolve({ reportId }) });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("report_has_runs");
    expect(body.error.message).toMatch(/has \d+ runs and its history is kept/);
    expect(await testDb.basReportDefinition.count({ where: { reportId: BigInt(reportId) } })).toBe(1);
  });
});
