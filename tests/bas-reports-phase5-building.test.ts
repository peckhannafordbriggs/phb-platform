import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { Prisma } from "@/lib/generated/prisma/client";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { createFixedNarrator } from "@/lib/modules/bas/reports/engine/narrative";
import { executeReportRun } from "@/lib/modules/bas/reports/engine/run";
import type { QuestionResult, ReportDocument } from "@/lib/modules/bas/reports/engine/types";
import { BAS_LIBRARY_QUESTIONS } from "@/lib/modules/bas/reports/library";
import { REPORT_PRESETS } from "@/lib/modules/bas/reports/presets";
import { createReport } from "@/lib/modules/bas/reports/service";
import { seedBasReportLibrary } from "@/prisma/bas-report-library";
import { BAS_EQUIPMENT_TYPES, BAS_POINT_ROLES } from "@/prisma/bas-vocabularies";
import { createEmployee, disconnectDb, grantModule, resetDb, seedBasModule, seedChangeOrdersModule, testDb } from "./db";

/**
 * A full report on a synthetic building that has EVERY role the twenty
 * questions name (Reports, Phase 5), through the real engine against the
 * real test database: one station, one site in New York, a week with no
 * clock change.
 *
 *   WX     weather: outside air temperature, for the whole station
 *   RTU-1  DX, gas heat, economizer: fan, DAT and its setpoint, return and
 *          mixed air, OA damper, compressor (change-of-value, so its starts
 *          can be counted), heat stage, duct static and its setpoint, the
 *          building's occupancy point and an override point
 *   AHU-1  hydronic, economizer: fan, DAT and setpoint, return air, OA
 *          damper, heating and cooling valves, duct static and setpoint
 *   VAV-1, VAV-2  under AHU-1: space temp, heating and cooling setpoints,
 *          damper, airflow and its setpoint, reheat valve
 *   B-1    boiler: HWS, HWR, HWS setpoint, status
 *   CH-1   chiller: CHWS, CHWR, CHWS setpoint, status
 *
 * Every measured point moves (a held value is a Data Health finding and
 * takes its unit out of the questions), and four faults are planted, each
 * with a known answer: VAV-1 starved for air every weekday afternoon (Q6),
 * RTU-1's compressor short cycling on Monday and Tuesday (Q15), B-1 at a 6 °F
 * delta T (Q13), and RTU-1's fan running two hours before occupancy (Q19).
 * Everything else is healthy, so every other question ran and found nothing.
 *
 * What is proved: all twenty questions are ANSWERED on the standard preset -
 * none Not Applicable, Not Monitored or not run - the run succeeds rather
 * than partial, the four planted faults are exactly the findings, and the
 * page carries the template's Hot Water headline and DX table; and the daily
 * preset answers its six.
 */

const authMock = vi.mocked(auth);
const NY = "America/New_York";
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;
/** Monday 2 November 2026 00:00 EST. */
const START = Date.UTC(2026, 10, 2, 5);
const END = START + 7 * DAY;

const dayOf = (t: number) => Math.floor((t - START) / DAY);
const hourOf = (t: number) => ((t - START) % DAY) / HOUR;
const between = (t: number, from: number, to: number, days = [0, 1, 2, 3, 4]) => days.includes(dayOf(t)) && hourOf(t) >= from && hourOf(t) < to;
const wobble = (t: number, amp: number, phase = 0) => amp * Math.sin(t / HOUR + phase);

const fanOn = (t: number) => between(t, 6, 18);
const heatOn = (t: number) => between(t, 6, 8);
const occupied = (t: number) => between(t, 8, 18);
/** RTU-1's compressor runs continuously Wednesday-Friday afternoons. */
const compressorRun = (t: number) => between(t, 13, 16, [2, 3, 4]);
const chillerOn = (t: number) => between(t, 8, 18);

const ROLES = [
  ...new Set([
    ...BAS_LIBRARY_QUESTIONS.flatMap((q) => q.requiredRoles.flatMap((r) => r.anyOf.flat())),
    "mixed_air_temp",
    "boiler_status",
    "chiller_status",
  ]),
];
const TYPES = ["rtu", "ahu", "vav", "boiler", "chiller", "weather"];

let owner: Awaited<ReturnType<typeof createEmployee>>;
let siteId: bigint;
let stationId: bigint;
let weeklyId: string;
let dailyId: string;
const createdRoles: string[] = [];
const createdTypes: string[] = [];

type Row = [number, number | null, boolean | null];

async function insertReadings(pointId: bigint, rows: Row[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    const values = rows.slice(i, i + 500).map(([t, num, bool]) => Prisma.sql`(${pointId}, ${new Date(t)}, ${num}::float8, ${bool}::boolean)`);
    await testDb.$executeRaw`INSERT INTO bas_readings (point_id, ts, value_num, value_bool) VALUES ${Prisma.join(values)}`;
  }
}

const every15 = (value: (t: number) => number): Row[] => {
  const out: Row[] = [];
  for (let t = START; t < END; t += 15 * MIN) out.push([t, value(t), null]);
  return out;
};
const every15Bool = (on: (t: number) => boolean): Row[] => {
  const out: Row[] = [];
  for (let t = START; t < END; t += 15 * MIN) out.push([t, null, on(t)]);
  return out;
};

/** RTU-1's compressor as change-of-value: 6 cycles of 5 on / 5 off from 13:00 Monday and Tuesday, then the long afternoon runs. */
function compressorRows(): Row[] {
  const rows: Row[] = [[START - DAY, null, false]];
  for (const d of [0, 1]) {
    for (let k = 0; k < 6; k += 1) {
      const t = START + d * DAY + 13 * HOUR + k * 10 * MIN;
      rows.push([t, null, true], [t + 5 * MIN, null, false]);
    }
  }
  for (const d of [2, 3, 4]) rows.push([START + d * DAY + 13 * HOUR, null, true], [START + d * DAY + 16 * HOUR, null, false]);
  return rows;
}
const compressorOn = (t: number) => compressorRun(t) || ([0, 1].includes(dayOf(t)) && hourOf(t) >= 13 && hourOf(t) < 14 && Math.floor(((hourOf(t) - 13) * 60) / 5) % 2 === 0);

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetBasAvailabilityCache();
  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();
  await seedBasReportLibrary(testDb);
  owner = await createEmployee({ email: "zztest.phase5.owner@phb1899.com" });
  await grantModule(owner.id, BAS_MODULE_KEY);

  for (const key of ROLES) {
    const seed = BAS_POINT_ROLES.find((r) => r.pointRole === key)!;
    if ((await testDb.basPointRole.findUnique({ where: { pointRole: key } })) === null) {
      await testDb.basPointRole.create({
        data: { pointRole: key, displayName: seed.displayName, description: seed.description, measurement: seed.measurement, typicalUnit: seed.typicalUnit, isSetpoint: seed.isSetpoint ?? false, isStatus: seed.isStatus ?? false, isCommand: seed.isCommand ?? false },
      });
      createdRoles.push(key);
    }
  }
  for (const key of TYPES) {
    const seed = BAS_EQUIPMENT_TYPES.find((t) => t.equipType === key)!;
    if ((await testDb.basEquipmentType.findUnique({ where: { equipType: key } })) === null) {
      await testDb.basEquipmentType.create({ data: { equipType: key, displayName: seed.displayName, description: seed.description, category: seed.category } });
      createdTypes.push(key);
    }
  }

  const org = await testDb.basOrg.create({ data: { name: "ZZTEST_P5_ORG" } });
  const project = await testDb.basProject.create({ data: { orgId: org.orgId, name: "ZZTEST_P5_PROJECT" } });
  const site = await testDb.basSite.create({ data: { orgId: org.orgId, projectId: project.projectId, name: "ZZTEST_P5_SITE", timezone: NY } });
  siteId = site.siteId;
  stationId = (await testDb.basStation.create({ data: { siteId, niagaraStationName: "ZZTestPhase5Station", connectionMode: "direct", baseUrl: "https://198.51.100.55" } })).stationId;
  const equip = async (name: string, equipType: string, parentEquipmentId: bigint | null = null) =>
    (await testDb.basEquipment.create({ data: { siteId, name, equipType, parentEquipmentId } })).equipmentId;
  const wx = await equip("WX", "weather");
  const rtu = await equip("RTU-1", "rtu");
  const ahu = await equip("AHU-1", "ahu");
  const vav1 = await equip("VAV-1", "vav", ahu);
  const vav2 = await equip("VAV-2", "vav", ahu);
  const boiler = await equip("B-1", "boiler");
  const chiller = await equip("CH-1", "chiller");

  const point = async (equipmentId: bigint, name: string, role: string, rows: Row[], over: { unit?: string; dataType?: string; intervalS?: number | null } = {}) => {
    const id = (
      await testDb.basPoint.create({
        data: {
          stationId,
          equipmentId,
          niagaraHistoryName: name,
          pointRole: role,
          unit: over.unit ?? "fahrenheit",
          dataType: over.dataType ?? "real",
          collectionIntervalS: over.intervalS === undefined ? 900 : over.intervalS,
          capacity: 5000,
          fullPolicy: "roll",
        },
      })
    ).pointId;
    await insertReadings(id, rows);
  };
  const bool = { unit: "", dataType: "bool" };
  const pct = { unit: "percent" };
  const inwc = { unit: "inches of water" };
  const cfm = { unit: "cubic feet per minute" };

  // Weather.
  await point(wx, "OAT", "outside_air_temp", every15((t) => 60 + 8 * Math.sin(t / (6 * HOUR))));

  // RTU-1: DX, gas heat, economizer; the station's occupancy and override points.
  const occRows: Row[] = [[START - DAY, null, false]];
  for (let d = 0; d < 5; d += 1) occRows.push([START + d * DAY + 8 * HOUR, null, true], [START + d * DAY + 18 * HOUR, null, false]);
  await point(rtu, "RTU1_Occupied", "occupancy_status", occRows, { ...bool, intervalS: null });
  await point(rtu, "RTU1_OccOverride", "occupancy_override", every15Bool(() => false), bool);
  await point(rtu, "RTU1_SF_Status", "supply_fan_status", every15Bool(fanOn), bool);
  const rtuMat = (t: number) => 73 + wobble(t, 0.3);
  await point(rtu, "RTU1_RAT", "return_air_temp", every15((t) => 72 + wobble(t, 0.3, 1)));
  await point(rtu, "RTU1_MAT", "mixed_air_temp", every15(rtuMat));
  await point(rtu, "RTU1_DAT", "supply_air_temp", every15((t) => (!fanOn(t) ? 70 + wobble(t, 0.5) : heatOn(t) ? rtuMat(t) + 25 : compressorOn(t) ? rtuMat(t) - 18 : 56 + wobble(t, 0.4))));
  await point(rtu, "RTU1_DAT_SP", "supply_air_temp_sp", every15((t) => (heatOn(t) ? 96 : 55)));
  await point(rtu, "RTU1_OAD", "oa_damper_cmd", every15((t) => (fanOn(t) ? 60 + wobble(t, 5) : 0.2 + wobble(t, 0.1))), pct);
  await point(rtu, "RTU1_Comp1", "compressor_status", compressorRows(), { ...bool, intervalS: null });
  await point(rtu, "RTU1_Heat1", "heating_stage_cmd", every15Bool(heatOn), bool);
  await point(rtu, "RTU1_DSP", "duct_static_pressure", every15((t) => (fanOn(t) ? 1 + wobble(t, 0.02) : wobble(t, 0.005))), inwc);
  await point(rtu, "RTU1_DSP_SP", "duct_static_pressure_sp", every15(() => 1), inwc);

  // AHU-1: hydronic, economizer.
  await point(ahu, "AHU1_SF_Status", "supply_fan_status", every15Bool((t) => between(t, 8, 18)), bool);
  await point(ahu, "AHU1_SAT", "supply_air_temp", every15((t) => (between(t, 8, 18) ? 55 + wobble(t, 0.4) : 68 + wobble(t, 0.5))));
  await point(ahu, "AHU1_SAT_SP", "supply_air_temp_sp", every15(() => 55));
  await point(ahu, "AHU1_RAT", "return_air_temp", every15((t) => 72 + wobble(t, 0.3, 2)));
  await point(ahu, "AHU1_OAD", "oa_damper_cmd", every15((t) => (between(t, 8, 18) ? 70 + wobble(t, 5) : 0.2 + wobble(t, 0.1))), pct);
  await point(ahu, "AHU1_HWV", "heating_valve_cmd", every15((t) => (between(t, 8, 9) ? 40 + wobble(t, 5) : 0)), pct);
  await point(ahu, "AHU1_CHWV", "cooling_valve_cmd", every15((t) => (between(t, 10, 17) ? 50 + wobble(t, 5) : 0)), pct);
  await point(ahu, "AHU1_DSP", "duct_static_pressure", every15((t) => (between(t, 8, 18) ? 1.2 + wobble(t, 0.02) : wobble(t, 0.005))), inwc);
  await point(ahu, "AHU1_DSP_SP", "duct_static_pressure_sp", every15(() => 1.2), inwc);

  // The VAVs. VAV-1 is starved for air every weekday afternoon.
  for (const [equipmentId, name, starved] of [[vav1, "VAV-1", true], [vav2, "VAV-2", false]] as const) {
    await point(equipmentId, `${name}_ZoneTemp`, "zone_temp", every15((t) => 72 + wobble(t, 0.5, name === "VAV-1" ? 0 : 1)));
    await point(equipmentId, `${name}_HtgSP`, "zone_temp_heating_sp", every15(() => 70));
    await point(equipmentId, `${name}_ClgSP`, "zone_temp_cooling_sp", every15(() => 74));
    await point(equipmentId, `${name}_Damper`, "vav_damper_cmd", every15((t) => 40 + wobble(t, 10)), pct);
    await point(equipmentId, `${name}_Flow`, "supply_air_flow", every15((t) => (starved && between(t, 14, 18) ? 300 : 480) + wobble(t, 10)), cfm);
    await point(equipmentId, `${name}_FlowSP`, "supply_air_flow_sp", every15(() => 500), cfm);
    await point(equipmentId, `${name}_Reheat`, "reheat_valve_cmd", every15((t) => (between(t, 6, 8) ? 30 + wobble(t, 5) : 0)), pct);
  }

  // B-1: a 6 °F delta T whenever it runs, which is with occupancy.
  await point(boiler, "B1_HWS", "hw_supply_temp", every15((t) => 180 + wobble(t, 0.5)));
  await point(boiler, "B1_HWR", "hw_return_temp", every15((t) => 174 + wobble(t, 0.5)));
  await point(boiler, "B1_HWS_SP", "hw_supply_temp_sp", every15(() => 180));
  await point(boiler, "B1_Status", "boiler_status", every15Bool(occupied), bool);

  // CH-1: healthy, on with occupancy.
  await point(chiller, "CH1_CHWS", "chw_supply_temp", every15((t) => (chillerOn(t) ? 44 + wobble(t, 0.2) : 55 + wobble(t, 0.3))));
  await point(chiller, "CH1_CHWR", "chw_return_temp", every15((t) => (chillerOn(t) ? 54 + wobble(t, 0.2) : 55.5 + wobble(t, 0.3))));
  await point(chiller, "CH1_CHWS_SP", "chw_supply_temp_sp", every15(() => 44));
  await point(chiller, "CH1_Status", "chiller_status", every15Bool(chillerOn), bool);

  signedInAs(owner.entraOid!);
  const library = await testDb.basLibraryQuestion.findMany({ select: { libraryQuestionId: true, key: true }, orderBy: { position: "asc" } });
  const pick = (keys: readonly string[]) => library.filter((q) => keys.includes(q.key)).map((q) => ({ kind: "library" as const, libraryQuestionId: q.libraryQuestionId.toString() }));
  const base = { siteId: siteId.toString(), schedule: { kind: "weekly" as const, weekdays: [1] }, timeOfDay: "06:00" };
  weeklyId = (await createReport({ ...owner, profileCompleted: true }, { ...base, name: "ZZTEST phase 5 weekly", presetKey: "health_weekly", analysisWindow: "7d", questions: pick(REPORT_PRESETS.health_weekly.questionKeys) })).reportId;
  dailyId = (await createReport({ ...owner, profileCompleted: true }, { ...base, name: "ZZTEST phase 5 daily", presetKey: "health_daily", analysisWindow: "24h", questions: pick(REPORT_PRESETS.health_daily.questionKeys) })).reportId;
}, 180_000);

afterAll(async () => {
  await resetDb();
  await testDb.basPoint.deleteMany({ where: { stationId } });
  await testDb.basEquipment.deleteMany({ where: { siteId } });
  await testDb.basStation.deleteMany({ where: { siteId } });
  await testDb.basSite.deleteMany({ where: { name: "ZZTEST_P5_SITE" } });
  await testDb.basProject.deleteMany({ where: { name: "ZZTEST_P5_PROJECT" } });
  await testDb.basOrg.deleteMany({ where: { name: "ZZTEST_P5_ORG" } });
  await testDb.basPointRole.deleteMany({ where: { pointRole: { in: createdRoles } } });
  await testDb.basEquipmentType.deleteMany({ where: { equipType: { in: createdTypes } } });
  await disconnectDb();
});

function allQuestions(doc: ReportDocument): QuestionResult[] {
  return [...doc.summary.questions, ...doc.sections.flatMap((s) => s.questions)].sort((a, b) => a.position - b.position);
}

describe("a full report on a building with every role", () => {
  let doc: ReportDocument;
  let html: string;

  it("answers all twenty questions on the standard preset, and the run succeeds", async () => {
    const outcome = await executeReportRun(weeklyId, { periodEnd: new Date(END), trigger: "manual", startedById: owner.id, narrator: createFixedNarrator() });
    doc = outcome.document;
    html = (await testDb.basReportRun.findUniqueOrThrow({ where: { runId: BigInt(outcome.runId) }, select: { reportHtml: true } })).reportHtml ?? "";

    const questions = allQuestions(doc);
    expect(questions.map((q) => q.position)).toEqual(BAS_LIBRARY_QUESTIONS.map((q) => q.position));
    expect(questions.filter((q) => q.outcome !== "answered").map((q) => `Q${q.position} ${q.outcome}: ${q.reason ?? q.missing.join("; ")}`)).toEqual([]);
    expect(outcome.status).toBe("succeeded");
    expect(outcome.partialReason).toBeNull();
    expect(doc.inventory.notMonitored).toEqual([]);
    expect(doc.inventory.notApplicable).toEqual([]);
    // Nothing was a data problem: every point moved and kept reporting.
    expect(doc.sections.find((s) => s.key === "data_health")!.findings).toEqual([]);
  });

  it("judged every unit it should, and nothing was skipped", () => {
    const q = (n: number) => allQuestions(doc).find((x) => x.position === n)!;
    const judged = (n: number) => q(n).metrics.judged;
    expect({ q6: judged(6), q7: judged(7), q8: judged(8) }).toEqual({ q6: 2, q7: 2, q8: 2 });
    expect({ q9: judged(9), q10: judged(10), q11: judged(11), q12: judged(12) }).toEqual({ q9: 2, q10: 2, q11: 2, q12: 2 });
    expect({ q13: judged(13), q14: judged(14) }).toEqual({ q13: 1, q14: 1 });
    expect({ q15: judged(15), q16: judged(16), q17: judged(17), q18: judged(18) }).toEqual({ q15: 1, q16: 1, q17: 1, q18: 1 });
    for (let n = 6; n <= 18; n += 1) expect(q(n).skipped, `Q${n}`).toEqual([]);
  });

  it("finds exactly the four planted faults, with their numbers", () => {
    const findings = doc.sections.flatMap((s) => s.findings).map((f) => [f.questionKey, f.subjectName, f.issueCode, f.priority]);
    expect(findings).toEqual([
      ["q06_vav_starved_airflow", "VAV-1", "starved_airflow", "watch"],
      ["q13_hw_supply_and_delta_t", "B-1", "low_delta_t", "watch"],
      ["q15_compressor_short_cycling", "RTU-1", "short_cycling", "action_needed"],
      ["q19_run_outside_schedule", "RTU-1", "ran_unoccupied", "watch"],
    ]);
    const evidence = (key: string) => doc.sections.flatMap((s) => s.findings).find((f) => f.questionKey === key)!.evidence;
    expect(evidence("q06_vav_starved_airflow")).toMatchObject({ percent: 40, hours: 20 });
    expect(evidence("q13_hw_supply_and_delta_t")).toMatchObject({ averageDeltaT: 6 });
    expect(evidence("q15_compressor_short_cycling")).toMatchObject({ peakStartsPerHour: 6, days: 2 });
    expect(evidence("q19_run_outside_schedule")).toMatchObject({ hoursOutside: 10, days: 5 });
    expect(doc.summary.status).toBe("action_needed");
  });

  it("renders the template's Hot Water headline, the DX table, and a factual line under every question that found nothing", () => {
    expect(html).toContain("HWS on target: 100% | Avg delta T: 6.0 °F");
    expect(html).toContain("CHWS on target: 100% | Avg delta T: 10.0 °F");
    expect(html).toContain("<th>Compressor starts/hr peak</th>");
    expect(html).toMatch(/<td>RTU-1<\/td><td>6<\/td><td>18\.0 °F<\/td><td>25\.0 °F<\/td>/);
    expect(html).toContain("None of the 2 units judged had heating and cooling on together for 30 minutes at a stretch or on two days.");
    expect(html).toMatch(/All 2 units judged held discharge air within its band/);
    expect(html).not.toContain("built in Phase 5");
  });

  it("answers the six questions of the daily preset over 24 hours", async () => {
    // Period: Tuesday 3 November, an occupied weekday.
    const outcome = await executeReportRun(dailyId, { periodEnd: new Date(START + 2 * DAY), trigger: "manual", startedById: owner.id, narrator: createFixedNarrator() });
    const questions = allQuestions(outcome.document);
    expect(questions.map((q) => q.key)).toEqual([...REPORT_PRESETS.health_daily.questionKeys]);
    expect(questions.every((q) => q.outcome === "answered")).toBe(true);
    expect(outcome.status).toBe("succeeded");
    expect(outcome.document.sections.map((s) => s.key)).toEqual(["space_comfort", "data_health"]);
  });
});
