import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { Viewer } from "@/lib/authz";
import { describeAuditEvent } from "@/lib/admin/audit-describe";
import {
  RateLimited,
  analyzeQuestion,
  detectNoData,
  explainNoData,
  type Planner,
} from "@/lib/modules/bas/analyze/service";
import { QuestionRateLimiter } from "@/lib/modules/bas/analyze/rate-limit";
import { resetSchemaContextCache } from "@/lib/modules/bas/analyze/schema-context";
import type {
  AnalyzeResult,
  Attempt,
  Plan,
  ResultTable,
} from "@/lib/modules/bas/analyze/types";
import { PlannerError } from "@/lib/modules/bas/analyze/types";
import {
  createEmployee,
  disconnectDb,
  resetDb,
  seedBasModule,
  seedChangeOrdersModule,
  testDb,
} from "./db";
import {
  createTestRole,
  dropTestRole,
  testRolePool,
  testRoleUrl,
} from "./bas-analyze-role-fixture";

/**
 * The honesty paths, driven against the REAL test database through the REAL
 * read-only role, with the model replaced by a scripted planner.
 *
 * Only the model is faked. The guard, the cursor, the READ ONLY transaction,
 * the provenance queries, the audit write and the log line are all the real
 * ones. What is proved, in the order docs/BAS-B5.md ranks it:
 *
 *   1. zero rows is NOT zero - a `no_data` result and an `answered` result
 *      whose value is 0 are different kinds with different words, and an
 *      aggregate over nothing (one row, all NULL) is `no_data` too
 *   2. gap overlap is computed HERE, from bas_data_gaps, clipped to the
 *      queried range, whether or not the planner mentioned it
 *   3. a range before collection began, and a point never collected, are
 *      said in the explanation
 *   4. "I don't know" is a real path: clarify and cannot_answer pass through,
 *      an unusable plan is retried ONCE and the result says so, a timeout is
 *      not retried
 *   5. every question is recorded: one audit row with the question, the SQL,
 *      the row count and the duration, and one log line with the same
 */

const SITE = "ZZTEST_B5_SITE";
const PREFIX = "ZZB5_";

/** A fixed clock so "last week" is deterministic. */
const NOW = new Date("2026-09-21T12:00:00Z");
const RANGE = {
  start: "2026-09-14T00:00:00.000Z",
  end: "2026-09-21T00:00:00.000Z",
};

interface Seeded {
  temp: bigint;
  never: bigint;
}

let pool: Pool;
let viewer: Viewer;
let seeded: Seeded;
let logged: string[] = [];

function env(): Record<string, string | undefined> {
  return {
    ANTHROPIC_API_KEY: "test-key-never-used",
    BAS_ASK_DATABASE_URL: testRoleUrl(),
  };
}

function scriptedPlanner(
  plans: Plan[] | ((previous: Attempt | null) => Plan),
  summary = "The scripted summary.",
): Planner & { planCalls: Attempt[]; summariseCalls: number } {
  let call = 0;
  const planner = {
    planCalls: [] as Attempt[],
    summariseCalls: 0,
    async plan({ previous }: { previous: Attempt | null }) {
      planner.planCalls.push(previous ?? { sql: "", error: "(first)" });
      if (typeof plans === "function") return plans(previous);
      const plan = plans[Math.min(call, plans.length - 1)]!;
      call += 1;
      return plan;
    },
    async summarise() {
      planner.summariseCalls += 1;
      return summary;
    },
  };
  return planner;
}

function query(sql: string, over: Partial<Extract<Plan, { kind: "query" }>> = {}): Plan {
  return {
    kind: "query",
    sql,
    timeRange: RANGE,
    pointIds: [String(seeded.temp)],
    filtersByRole: false,
    interpretation: "Scripted interpretation.",
    ...over,
  };
}

async function ask(
  planner: Planner,
  question = "What was the average room temperature last week?",
  over: { run?: { statementTimeoutMs: number; rowCap: number }; rateLimiter?: QuestionRateLimiter } = {},
): Promise<AnalyzeResult> {
  return analyzeQuestion(viewer, question, {
    planner,
    env: env(),
    pool,
    now: () => NOW,
    rateLimiter: over.rateLimiter ?? new QuestionRateLimiter({ limit: 100, windowMs: 60_000 }),
    run: over.run,
  });
}

async function seed(): Promise<Seeded> {
  const org = await testDb.basOrg.create({ data: { name: "ZZTEST_B5_ORG" } });
  const project = await testDb.basProject.create({
    data: { orgId: org.orgId, name: "ZZTEST_B5_PROJECT" },
  });
  const site = await testDb.basSite.create({
    data: { orgId: org.orgId, projectId: project.projectId, name: SITE, timezone: "America/New_York" },
  });
  const station = await testDb.basStation.create({
    data: { siteId: site.siteId, niagaraStationName: `${PREFIX}Station` },
  });
  const temp = await testDb.basPoint.create({
    data: {
      stationId: station.stationId,
      niagaraHistoryName: `${PREFIX}ZoneTemp`,
      label: "Zone Temp B5",
      unit: "fahrenheit",
      dataType: "real",
      capacity: 500,
      // No interval, no measured horizon: horizon_state is 'unknown'.
      checkpoint: { create: { completeness: "complete" } },
    },
  });
  const never = await testDb.basPoint.create({
    data: {
      stationId: station.stationId,
      niagaraHistoryName: `${PREFIX}NeverCollected`,
      label: "Never Collected B5",
      dataType: "real",
      isActive: false,
      inactiveReason: "manual",
    },
  });

  // Readings inside the range, 70/72/74 -> avg 72. Collection begins on the
  // 15th, a day after RANGE.start, so the range is partly uncovered.
  await testDb.basReading.createMany({
    data: [
      { pointId: temp.pointId, ts: new Date("2026-09-15T00:00:00Z"), valueNum: 70 },
      { pointId: temp.pointId, ts: new Date("2026-09-16T00:00:00Z"), valueNum: 72 },
      { pointId: temp.pointId, ts: new Date("2026-09-17T00:00:00Z"), valueNum: 74 },
    ],
  });

  // A 64-hour gap from the 17th 12:00 to the 20th 04:00, entirely inside the
  // range; and a second gap that straddles the end of the range so clipping
  // is tested: the 20th 20:00 to the 22nd 20:00 = 48h, of which 4h are inside.
  //
  // Plus an OVERLAPPING record of the first: same start, earlier end, a
  // different cause. The shape the collector left behind on 2026-09-21 was an
  // exact duplicate (same cause too); add_bas_data_gaps_unique now refuses
  // that row outright, so an overlapping record with another cause stands in
  // - the index permits it, and the merge must still absorb it. Summing rows
  // would count 40 of those hours twice. The total below must still be 68.
  await testDb.basDataGap.createMany({
    data: [
      {
        pointId: temp.pointId,
        gapStart: new Date("2026-09-17T12:00:00Z"),
        gapEnd: new Date("2026-09-20T04:00:00Z"),
        cause: "collector_down",
      },
      {
        pointId: temp.pointId,
        gapStart: new Date("2026-09-17T12:00:00Z"),
        gapEnd: new Date("2026-09-19T04:00:00Z"),
        cause: "station_unreachable",
      },
      {
        pointId: temp.pointId,
        gapStart: new Date("2026-09-20T20:00:00Z"),
        gapEnd: new Date("2026-09-22T20:00:00Z"),
        cause: "roll_overwrite",
      },
    ],
  });

  return { temp: temp.pointId, never: never.pointId };
}

async function drop() {
  await testDb.basReading.deleteMany({ where: { point: { niagaraHistoryName: { startsWith: PREFIX } } } });
  await testDb.basDataGap.deleteMany({ where: { point: { niagaraHistoryName: { startsWith: PREFIX } } } });
  await testDb.basSyncCheckpoint.deleteMany({ where: { point: { niagaraHistoryName: { startsWith: PREFIX } } } });
  await testDb.basPoint.deleteMany({ where: { niagaraHistoryName: { startsWith: PREFIX } } });
  await testDb.basStation.deleteMany({ where: { niagaraStationName: { startsWith: PREFIX } } });
  await testDb.basSite.deleteMany({ where: { name: { startsWith: "ZZTEST_B5" } } });
  await testDb.basProject.deleteMany({ where: { name: { startsWith: "ZZTEST_B5" } } });
  await testDb.basOrg.deleteMany({ where: { name: { startsWith: "ZZTEST_B5" } } });
}

beforeAll(async () => {
  await createTestRole();
  pool = testRolePool(true);
});

beforeEach(async () => {
  vi.restoreAllMocks();
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetSchemaContextCache();
  await drop();
  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();
  seeded = await seed();
  const employee = await createEmployee();
  viewer = {
    id: employee.id,
    email: employee.email,
    firstName: employee.firstName ?? "Test",
    lastName: employee.lastName ?? "Person",
    profileCompleted: true,
    isPlatformAdmin: false,
  };
});

afterAll(async () => {
  await drop();
  await pool.end().catch(() => undefined);
  await dropTestRole();
  await disconnectDb();
});

const AVG_SQL = () =>
  `SELECT avg(value_num) AS avg_temp FROM bas_readings WHERE point_id = ${seeded.temp} AND ts >= '${RANGE.start}' AND ts < '${RANGE.end}'`;

describe("zero rows is not zero", () => {
  it("renders a query that matches nothing as no_data, and never calls the summariser", async () => {
    const planner = scriptedPlanner([
      query(`SELECT ts, value_num FROM bas_readings WHERE point_id = ${seeded.temp} AND value_num > 1000`),
    ]);

    const result = await ask(planner);

    expect(result.kind).toBe("no_data");
    if (result.kind !== "no_data") return;
    expect(result.reason).toBe("no_rows");
    expect(result.table.rowCount).toBe(0);
    expect(result.explanation).toContain("not an answer of zero");
    expect(planner.summariseCalls).toBe(0);
  });

  it("renders an aggregate over nothing - one row, all NULL - as no_data too", async () => {
    const planner = scriptedPlanner([
      query(`SELECT avg(value_num) AS avg_temp FROM bas_readings WHERE point_id = ${seeded.temp} AND value_num > 1000`),
    ]);

    const result = await ask(planner);

    expect(result.kind).toBe("no_data");
    if (result.kind !== "no_data") return;
    expect(result.reason).toBe("all_null");
    expect(result.table.rowCount).toBe(1);
    expect(result.table.rows[0]).toEqual([null]);
    expect(planner.summariseCalls).toBe(0);
  });

  it("renders a genuine zero as answered, with the 0 in the rows", async () => {
    await testDb.basReading.updateMany({
      where: { pointId: seeded.temp },
      data: { valueNum: 0 },
    });
    const planner = scriptedPlanner([query(AVG_SQL())]);

    const result = await ask(planner);

    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") return;
    expect(result.table.rows[0]).toEqual([0]);
    expect(planner.summariseCalls).toBe(1);
  });

  it("detectNoData: the two shapes, and a zero", () => {
    const table = (rows: ResultTable["rows"]): ResultTable => ({
      columns: ["v"],
      rows,
      rowCount: rows.length,
      truncated: false,
      rowCap: 200,
    });
    expect(detectNoData(table([]))).toBe("no_rows");
    expect(detectNoData(table([[null]]))).toBe("all_null");
    expect(detectNoData(table([[null, null], [null, null]]))).toBe("all_null");
    expect(detectNoData(table([[0]]))).toBeNull();
    expect(detectNoData(table([[null], [1]]))).toBeNull();
  });
});

describe("gap overlap is computed here, not by the model", () => {
  it("reports the hours of recorded gaps inside the range, clipped, from a plan that said nothing about gaps", async () => {
    const planner = scriptedPlanner([query(AVG_SQL())]);

    const result = await ask(planner);

    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") return;

    const gaps = result.provenance.gaps;
    expect(gaps).not.toBeNull();
    // 64h fully inside + 4h of the straddling gap clipped to RANGE.end. The
    // duplicate row for the first outage is merged, not added: three rows in
    // the table, two intervals, one merge reported.
    expect(gaps!.totalHours).toBe(68);
    expect(gaps!.items).toHaveLength(2);
    expect(gaps!.mergedRows).toBe(1);
    expect(gaps!.items[0]).toMatchObject({ hours: 64, pointName: "Zone Temp B5" });
    // Both causes survive the merge; neither is silently dropped.
    expect(gaps!.items[0]!.cause.split(" + ").sort()).toEqual(["collector_down", "station_unreachable"]);
    expect(gaps!.items[1]).toMatchObject({
      hours: 4,
      cause: "roll_overwrite",
      start: "2026-09-20T20:00:00.000Z",
      end: "2026-09-21T00:00:00.000Z",
    });
    expect(result.provenance.scope).toBe("declared");
    expect(result.provenance.points.map((p) => p.name)).toEqual(["Zone Temp B5"]);
    // The point has capacity but no interval and no measured horizon.
    expect(result.provenance.unknownHorizon).toEqual({ count: 1, names: ["Zone Temp B5"] });

    // The dangerous case, on an ANSWERED result: the range is seven days, the
    // readings held span the 15th to the 17th. The number is real and it
    // describes three days of seven, and the platform says so - live on
    // 2026-09-21 a 30-day average over ten days of readings went out with
    // only the model mentioning it.
    expect(result.provenance.coverageShortfall).toContain("only partly covered");
    expect(result.provenance.coverageShortfall).toContain("the first 24 hours and the last 4 days");
    // 15th 00:00 to 17th 00:00 is 48 hours: two days, not three.
    expect(result.provenance.coverageShortfall).toContain("2 days of the 7 days asked about");
  });

  it("reports no coverage shortfall when the readings span the whole range", async () => {
    await testDb.basReading.createMany({
      data: [
        { pointId: seeded.temp, ts: new Date("2026-09-14T00:00:00Z"), valueNum: 70 },
        { pointId: seeded.temp, ts: new Date("2026-09-20T23:30:00Z"), valueNum: 70 },
      ],
    });
    const result = await ask(scriptedPlanner([query(AVG_SQL())]));

    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") return;
    // Half an hour short at the end is the collector's cadence, not a shortfall.
    expect(result.provenance.coverageShortfall).toBeNull();
  });

  it("widens to every point when the SQL reads readings and the plan names none", async () => {
    const planner = scriptedPlanner([query(AVG_SQL(), { pointIds: [] })]);

    const result = await ask(planner);

    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") return;
    expect(result.provenance.scope).toBe("all_points");
    expect(result.provenance.points.length).toBeGreaterThanOrEqual(2);
    // Still counted, over the superset.
    expect(result.provenance.gaps?.totalHours).toBe(68);
  });

  it("widens when a declared id does not exist rather than trusting the rest", async () => {
    const planner = scriptedPlanner([
      query(AVG_SQL(), { pointIds: [String(seeded.temp), "999999999"] }),
    ]);

    const result = await ask(planner);

    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") return;
    expect(result.provenance.scope).toBe("all_points");
  });

  it("cannot compute gaps without a time range, and says null rather than zero", async () => {
    const planner = scriptedPlanner([
      query(`SELECT count(*) FROM bas_readings WHERE point_id = ${seeded.temp}`, { timeRange: null }),
    ]);

    const result = await ask(planner);

    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") return;
    expect(result.provenance.gaps).toBeNull();
    expect(result.provenance.timeRange).toBeNull();
  });

  it("widens to every point on a declared time range alone, even when the SQL reads no readings", async () => {
    // Found live on 2026-09-21: "gap hours in the last 30 days, by point"
    // reads bas_data_gaps, not bas_readings. The plan declared the range and
    // no point ids, and the provenance said "Scope: none, Gaps: NOT
    // COMPUTED" beside a resolved range. A period is a claim about that
    // period, whatever table the SQL happens to read.
    const planner = scriptedPlanner([
      query(
        `SELECT g.point_id, count(*) AS gaps FROM bas_data_gaps g WHERE g.gap_start < '${RANGE.end}' AND g.gap_end > '${RANGE.start}' GROUP BY 1`,
        { pointIds: [] },
      ),
    ]);

    const result = await ask(planner, "gap hours by point?");

    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") return;
    expect(result.provenance.scope).toBe("all_points");
    expect(result.provenance.points.length).toBeGreaterThanOrEqual(2);
    expect(result.provenance.gaps).not.toBeNull();
    expect(result.provenance.gaps?.totalHours).toBe(68);
    // Coverage is about readings and stays off for a query that reads none.
    expect(result.provenance.coverage).toBeNull();
  });

  it("sends a plan back ONCE when its SQL filters by time and declares no range, then computes gaps from the declared one", async () => {
    // Found live on 2026-09-21: `now() - interval '30 days'` in the SQL and
    // `time_range: null` beside it, so nothing widened and nothing was
    // computed. The retry is what asks for the range.
    const relative = `SELECT count(*) AS gaps FROM bas_data_gaps WHERE gap_end > now() - interval '30 days'`;
    const planner = scriptedPlanner((previous) =>
      previous === null
        ? query(relative, { timeRange: null, pointIds: [] })
        : query(relative, { timeRange: RANGE, pointIds: [] }),
    );

    const result = await ask(planner, "gap hours in the last 30 days?");

    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") return;
    expect(result.retried).toBe(true);
    expect(planner.planCalls).toHaveLength(2);
    expect(planner.planCalls[1]!.error).toContain("time_range was null");
    expect(result.provenance.periodUndeclared).toBe(false);
    expect(result.provenance.timeRange).toEqual(RANGE);
    expect(result.provenance.scope).toBe("all_points");
    expect(result.provenance.gaps?.totalHours).toBe(68);
  });

  it("runs anyway when the second plan still omits the range, and flags the period as undeclared", async () => {
    const relative = `SELECT count(*) AS gaps FROM bas_data_gaps WHERE gap_end > now() - interval '30 days'`;
    const planner = scriptedPlanner([query(relative, { timeRange: null, pointIds: [] })]);

    const result = await ask(planner, "gap hours in the last 30 days?");

    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") return;
    expect(result.retried).toBe(true);
    expect(result.provenance.periodUndeclared).toBe(true);
    expect(result.provenance.gaps).toBeNull();
    // The flag is what turns "does not apply" into "period not stated" on
    // screen; the sentence is asserted in tests/bas-analyze-ui.test.tsx.
  });

  it("does not ask for a range when the SQL has no time expression at all", async () => {
    const planner = scriptedPlanner([
      query(`SELECT count(*) AS stations FROM bas_stations`, { timeRange: null, pointIds: [] }),
    ]);

    const result = await ask(planner, "how many stations?");

    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") return;
    expect(result.retried).toBe(false);
    expect(planner.planCalls).toHaveLength(1);
    expect(result.provenance.periodUndeclared).toBe(false);
  });

  it("does not compute gaps for a query that reads no readings AND states no period", async () => {
    const planner = scriptedPlanner([
      query(`SELECT count(*) AS stations FROM bas_stations`, { timeRange: null, pointIds: [] }),
    ]);

    const result = await ask(planner);

    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") return;
    expect(result.provenance.scope).toBe("none");
    expect(result.provenance.gaps).toBeNull();
    expect(result.provenance.coverage).toBeNull();
  });
});

describe("saying I don't know", () => {
  it("says a range ends before collection began", async () => {
    const before = { start: "2026-08-01T00:00:00.000Z", end: "2026-08-08T00:00:00.000Z" };
    const planner = scriptedPlanner([
      query(
        `SELECT avg(value_num) AS avg_temp FROM bas_readings WHERE point_id = ${seeded.temp} AND ts >= '${before.start}' AND ts < '${before.end}'`,
        { timeRange: before },
      ),
    ]);

    const result = await ask(planner);

    expect(result.kind).toBe("no_data");
    if (result.kind !== "no_data") return;
    expect(result.explanation).toContain("ends before collection began");
    expect(result.explanation).toContain("2026-09-15T00:00:00.000Z");
  });

  it("says a point was never collected", async () => {
    const planner = scriptedPlanner([
      query(
        `SELECT avg(value_num) FROM bas_readings WHERE point_id = ${seeded.never} AND ts >= '${RANGE.start}'`,
        { pointIds: [String(seeded.never)] },
      ),
    ]);

    const result = await ask(planner);

    expect(result.kind).toBe("no_data");
    if (result.kind !== "no_data") return;
    expect(result.explanation).toContain("Never Collected B5 has never had a reading collected");
    expect(result.provenance.points[0]).toMatchObject({ name: "Never Collected B5", collected: false });
  });

  it("says the range is only partly covered, in explainNoData, when rows are empty for another reason", () => {
    const explanation = explainNoData("no_rows", RANGE, {
      timeRange: RANGE,
      scope: "declared",
      points: [{ id: "1", name: "P", site: "S", station: "St", collected: true }],
      gaps: { totalHours: 0, items: [], mergedRows: 0 },
      unknownHorizon: { count: 0, names: [] },
      coverage: {
        earliest: "2026-09-15T00:00:00.000Z",
        latest: "2026-09-17T00:00:00.000Z",
        readings: 3,
        neverCollected: [],
      },
      unclassifiedExcluded: 2,
      periodUndeclared: false,
      // explainNoData repeats the shared sentence rather than recomputing it.
      coverageShortfall: "The period asked about is only partly covered: (fixture).",
    });
    expect(explanation).toContain("only partly covered");
    expect(explanation).toContain("2 points have no role");
  });

  it("passes a clarifying question through, and queries nothing", async () => {
    const planner = scriptedPlanner([
      { kind: "clarify", question: "Which building?", interpretation: "Two sites match." },
    ]);

    const result = await ask(planner, "What is the temperature?");

    expect(result).toEqual({
      kind: "clarify",
      question: "Which building?",
      interpretation: "Two sites match.",
    });
    expect(planner.summariseCalls).toBe(0);
  });

  it("passes a refusal to guess through as cannot_answer", async () => {
    const planner = scriptedPlanner([
      { kind: "cannot_answer", reason: "bas_equipment is empty; nothing has set equipment relationships." },
    ]);

    const result = await ask(planner, "Which AHU serves zone 4?");

    expect(result.kind).toBe("cannot_answer");
    if (result.kind !== "cannot_answer") return;
    expect(result.reason).toContain("bas_equipment is empty");
    expect(result.attempts).toEqual([]);
    expect(result.retried).toBe(false);
  });

  it("retries ONCE after the guard refuses, tells the planner why, and says it retried", async () => {
    const planner = scriptedPlanner((previous) =>
      previous === null
        ? query("DELETE FROM bas_orgs")
        : query(AVG_SQL()),
    );

    const result = await ask(planner);

    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") return;
    expect(result.retried).toBe(true);
    expect(planner.planCalls).toHaveLength(2);
    expect(planner.planCalls[1]).toMatchObject({ sql: "DELETE FROM bas_orgs" });
    expect(planner.planCalls[1]!.error).toContain("Only a SELECT");
  });

  it("retries ONCE after the database refuses, then gives up showing both attempts", async () => {
    const planner = scriptedPlanner([
      query("SELECT count(*) FROM employees"),
      query("SELECT count(*) FROM audit_events"),
    ]);

    const result = await ask(planner);

    expect(result.kind).toBe("cannot_answer");
    if (result.kind !== "cannot_answer") return;
    expect(result.retried).toBe(true);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({ sql: "SELECT count(*) FROM employees" });
    expect(result.attempts[0]!.error).toContain("permission denied");
    expect(result.attempts[1]!.error).toContain("permission denied");
    expect(result.reason).toContain("Two attempts");
  });

  it("does not retry a timeout", async () => {
    // pg_sleep is refused by the guard, so a slow join is used instead.
    const planner = scriptedPlanner([
      query("SELECT count(*) FROM generate_series(1, 20000000) a, generate_series(1, 20000000) b"),
    ]);

    const result = await ask(planner, "how many?", { run: { statementTimeoutMs: 200, rowCap: 10 } });

    expect(result.kind).toBe("cannot_answer");
    if (result.kind !== "cannot_answer") return;
    expect(result.retried).toBe(false);
    expect(result.attempts).toHaveLength(1);
    expect(result.reason).toContain("took too long");
    expect(planner.planCalls).toHaveLength(1);
  });

  it("retries an unparseable plan once, then reports it honestly", async () => {
    const planner: Planner = {
      async plan() {
        throw new PlannerError("unparseable", "no JSON");
      },
      async summarise() {
        return "";
      },
    };

    const result = await ask(planner);

    expect(result.kind).toBe("cannot_answer");
    if (result.kind !== "cannot_answer") return;
    expect(result.reason).toContain("twice");
    expect(result.retried).toBe(true);
  });

  it("does not retry a refusal or an outage", async () => {
    let calls = 0;
    const planner: Planner = {
      async plan() {
        calls += 1;
        throw new PlannerError("unavailable", "down");
      },
      async summarise() {
        return "";
      },
    };

    const result = await ask(planner);

    expect(result.kind).toBe("cannot_answer");
    if (result.kind !== "cannot_answer") return;
    // The planner's own words reach the screen. On the first live run a
    // rejected API key rendered as "could not be reached", which sends the
    // reader to wait for a network that was fine.
    expect(result.reason).toBe("down Nothing was queried.");
    expect(calls).toBe(1);
  });

  it("shows the rows even when the summariser fails", async () => {
    const planner: Planner = {
      async plan() {
        return query(AVG_SQL());
      },
      async summarise() {
        throw new PlannerError("unavailable", "down");
      },
    };

    const result = await ask(planner);

    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") return;
    expect(result.answer).toContain("no summary could be written");
    expect(result.table.rows[0]).toEqual([72]);
  });
});

describe("configuration and limits", () => {
  it("is not_configured with either variable missing, and names it", async () => {
    const planner = scriptedPlanner([query(AVG_SQL())]);

    const noKey = await analyzeQuestion(viewer, "q?", {
      planner,
      env: { BAS_ASK_DATABASE_URL: testRoleUrl() },
    });
    expect(noKey).toEqual({ kind: "not_configured", missing: ["ANTHROPIC_API_KEY"] });

    const noUrl = await analyzeQuestion(viewer, "q?", {
      planner,
      env: { ANTHROPIC_API_KEY: "k" },
    });
    expect(noUrl).toEqual({ kind: "not_configured", missing: ["BAS_ASK_DATABASE_URL"] });

    const blank = await analyzeQuestion(viewer, "q?", {
      planner,
      env: { ANTHROPIC_API_KEY: "", BAS_ASK_DATABASE_URL: "  " },
    });
    expect(blank).toEqual({
      kind: "not_configured",
      missing: ["ANTHROPIC_API_KEY", "BAS_ASK_DATABASE_URL"],
    });
    expect(planner.planCalls).toHaveLength(0);
  });

  it("rate limits per employee, before any token is spent", async () => {
    let now = 1_000_000;
    const limiter = new QuestionRateLimiter({ limit: 2, windowMs: 60_000, now: () => now });
    const planner = scriptedPlanner([query(AVG_SQL())]);

    await ask(planner, "one", { rateLimiter: limiter });
    await ask(planner, "two", { rateLimiter: limiter });
    await expect(ask(planner, "three", { rateLimiter: limiter })).rejects.toBeInstanceOf(RateLimited);
    expect(planner.planCalls).toHaveLength(2);

    // A different employee is a different window.
    const other = limiter.check("someone-else");
    expect(other.allowed).toBe(true);

    // Time passes; the window slides.
    now += 61_000;
    await ask(planner, "four", { rateLimiter: limiter });
    expect(planner.planCalls).toHaveLength(3);
  });
});

describe("every question is recorded", () => {
  it("writes one audit row with the question, the SQL, the row count and the duration", async () => {
    const planner = scriptedPlanner([query(AVG_SQL())]);
    const question = "What was the average room temperature last week?";

    await ask(planner, question);

    const rows = await testDb.auditEvent.findMany({ where: { action: "bas.question_asked" } });
    expect(rows).toHaveLength(1);
    const meta = rows[0]!.metadata as Record<string, unknown>;
    expect(rows[0]!.actorEmployeeId).toBe(viewer.id);
    expect(rows[0]!.moduleKey).toBe("bas");
    expect(meta.question).toBe(question);
    expect(meta.sql).toBe(AVG_SQL());
    expect(meta.rowCount).toBe(1);
    expect(meta.outcome).toBe("answered");
    expect(meta.gapHours).toBe(68);
    expect(typeof meta.durationMs).toBe("number");

    const described = describeAuditEvent(
      {
        action: "bas.question_asked",
        moduleKey: "bas",
        metadata: meta,
        actor: { id: viewer.id, firstName: "Jim", lastName: "Schwarz", email: "j@phb1899.com" },
        target: null,
      },
      new Map([["bas", "Building Automation"]]),
    );
    expect(described.known).toBe(true);
    expect(described.sentence).toBe(`Jim Schwarz asked Building Automation "${question}"`);
  });

  it("records a no_data outcome as such, and a refusal with the SQL that was tried", async () => {
    await ask(scriptedPlanner([query(`SELECT ts FROM bas_readings WHERE point_id = ${seeded.temp} AND value_num > 1000`)]), "anything?");
    await ask(scriptedPlanner([query("SELECT count(*) FROM employees"), query("SELECT 1 FROM employees")]), "sneaky?");

    const rows = await testDb.auditEvent.findMany({
      where: { action: "bas.question_asked" },
      orderBy: { occurredAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect((rows[0]!.metadata as Record<string, unknown>).outcome).toBe("no_data");
    expect((rows[0]!.metadata as Record<string, unknown>).rowCount).toBe(0);
    expect((rows[1]!.metadata as Record<string, unknown>).outcome).toBe("cannot_answer");
    expect((rows[1]!.metadata as Record<string, unknown>).sql).toBe("SELECT 1 FROM employees");
  });

  it("emits one structured log line carrying the question and the SQL", async () => {
    const question = "log me";
    await ask(scriptedPlanner([query(AVG_SQL())]), question);

    const lines = logged
      .filter((line) => line.includes('"event":"bas.analyze.question"'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "info",
      employeeId: viewer.id,
      moduleKey: "bas",
      outcome: "answered",
      question,
      sql: AVG_SQL(),
      count: 1,
    });
    expect(typeof lines[0]!.durationMs).toBe("number");
  });
});
