import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Only the session is mocked. The service, its SQL, the view and the screen
// helpers are the real ones: the point of this file is that they agree.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import type { Viewer } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { getCollectionHealth, getDashboard } from "@/lib/modules/bas/service";
import { basFigure } from "@/lib/home/bas-figure";
import {
  AT_RISK_ROLL_RISKS,
  atRiskCount,
  describeHiddenRisk,
  isAtRisk,
  type CollectionHealth,
  type PointHealthRow,
  type RollRisk,
} from "@/lib/modules/bas/types";
import {
  atRiskShape,
  atRiskTone,
  computeHeadroom,
  describeAtRisk,
  describeHeadroom,
  reportingPoints,
  riskBreakdown,
} from "@/app/(modules)/bas/health-client";
import {
  createEmployee,
  disconnectDb,
  grantModule,
  resetDb,
  seedBasModule,
  seedChangeOrdersModule,
  testDb,
} from "./db";

/**
 * ONE QUESTION, ONE ANSWER: is this point at risk of data loss?
 *
 * On 2026-09-18 the live Collection Health screen read, in one block, on one
 * set of rows:
 *
 *     "4 more points are at risk but hidden from the table below."
 *     "Points at risk of data loss - 0 - Nothing at risk"
 *
 * The four hidden points were OccupancyCommand, Occupied, OperatingState and
 * OperatingStateOR, all with a buffer below capacity. The tile counted at-risk
 * states from a list; the hidden-point sentence counted `roll_risk <> 'ok'` in
 * SQL. Two definitions of the same question, and the roll-horizon change moved
 * one of them. That they disagreed in the harmless direction was luck: the
 * sentence exists so that hiding a point cannot make the screen look healthier
 * than the system is, and the failure that matters is the other way round.
 *
 * Every surface that answers the question now answers it from
 * AT_RISK_ROLL_RISKS through `isAtRisk` / `atRiskCount`. This file drives all
 * of them from ONE fixture holding a point in every horizon state - configured,
 * measured, not full, unknown, plus never collected - with some hidden, and
 * asserts that:
 *
 *   1. they agree with each other, and
 *   2. each one gives the answer the list says, per state.
 *
 * (2) is what makes (1) worth having: mutate the list and every surface's
 * expectation fails together. If only one test in here fails after a change,
 * something has grown a second definition.
 */

const authMock = vi.mocked(auth);

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

const PREFIX = "ZZRISK_";
const HOUR = 3_600_000;

/**
 * One active point per state the view can produce, named for what it is.
 * `hidden` is the visibility the screen's table would apply.
 */
interface Shape {
  name: string;
  expectRisk: RollRisk;
  hidden: boolean;
  capacity: number | null;
  intervalS: number | null;
  /** null: no checkpoint row at all */
  checkpoint: null | {
    agoMs: number;
    stationCount?: number;
    observedSpanS?: number;
    shortestFullSpanS?: number;
  };
}

const SHAPES: Shape[] = [
  // configured: 500 x 900 s = 125 h; half is 62.5 h
  { name: "CfgOk", expectRisk: "ok", hidden: false, capacity: 500, intervalS: 900,
    checkpoint: { agoMs: 5 * 60_000 } },
  { name: "CfgAtRisk", expectRisk: "at_risk", hidden: false, capacity: 500, intervalS: 900,
    checkpoint: { agoMs: 100 * HOUR } },
  { name: "CfgLost", expectRisk: "data_lost", hidden: true, capacity: 500, intervalS: 900,
    checkpoint: { agoMs: 200 * HOUR } },
  // measured: Unit_Status_Mode's shape, full, shortest 2 h, today 10.1 h, fresh
  { name: "MeasuredOk", expectRisk: "ok", hidden: false, capacity: 500, intervalS: null,
    checkpoint: { agoMs: 10 * 60_000, stationCount: 500, observedSpanS: 36_470, shortestFullSpanS: 7200 } },
  // not full: OperatingState and OccupancyCommand. Nothing overwritten.
  { name: "NotFullHidden", expectRisk: "buffer_not_full", hidden: true, capacity: 500, intervalS: null,
    checkpoint: { agoMs: 400 * 24 * HOUR, stationCount: 320, observedSpanS: 78_000_000 } },
  { name: "NotFullShown", expectRisk: "buffer_not_full", hidden: false, capacity: 500, intervalS: null,
    checkpoint: { agoMs: 207 * 24 * HOUR, stationCount: 71, observedSpanS: 17_000_000 } },
  // unknown: no capacity, so the count cannot be judged
  { name: "Unknown", expectRisk: "roll_horizon_unknown", hidden: true, capacity: null, intervalS: null,
    checkpoint: { agoMs: 5 * 60_000, stationCount: 500, observedSpanS: 7200 } },
  // never collected: no checkpoint row
  { name: "Never", expectRisk: "never_collected", hidden: false, capacity: 500, intervalS: 900,
    checkpoint: null },
];

let viewer: Viewer;
let siteId: bigint;
const pointIds = new Map<string, bigint>();

async function seed(): Promise<void> {
  const org = await testDb.basOrg.create({ data: { name: `${PREFIX}ORG` } });
  const project = await testDb.basProject.create({
    data: { orgId: org.orgId, name: `${PREFIX}PROJECT` },
  });
  const site = await testDb.basSite.create({
    data: { orgId: org.orgId, projectId: project.projectId, name: `${PREFIX}SITE`, timezone: "America/New_York" },
  });
  siteId = site.siteId;
  const station = await testDb.basStation.create({
    data: { siteId: site.siteId, niagaraStationName: `${PREFIX}Station`, connectionMode: "direct", baseUrl: "https://198.51.100.30" },
  });
  const now = Date.now();
  for (const shape of SHAPES) {
    const point = await testDb.basPoint.create({
      data: {
        stationId: station.stationId,
        niagaraHistoryName: `${PREFIX}${shape.name}`,
        niagaraDisplayName: shape.name,
        dataType: "real",
        capacity: shape.capacity,
        collectionIntervalS: shape.intervalS,
        fullPolicy: "roll",
        isVisible: !shape.hidden,
        ...(shape.checkpoint === null
          ? {}
          : {
              checkpoint: {
                create: {
                  lastRecordTs: new Date(now - shape.checkpoint.agoMs),
                  lastRunAt: new Date(now - shape.checkpoint.agoMs),
                  lastStatus: "ok",
                  stationCount: shape.checkpoint.stationCount ?? null,
                  observedSpanS: shape.checkpoint.observedSpanS ?? null,
                  shortestFullSpanS: shape.checkpoint.shortestFullSpanS ?? null,
                },
              },
            }),
      },
    });
    pointIds.set(shape.name, point.pointId);
  }
}

async function drop(): Promise<void> {
  await testDb.basPoint.deleteMany({ where: { niagaraHistoryName: { startsWith: PREFIX } } });
  await testDb.basStation.deleteMany({ where: { niagaraStationName: { startsWith: PREFIX } } });
  await testDb.basSite.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await testDb.basProject.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await testDb.basOrg.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetBasAvailabilityCache();
  await drop();
  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();
  await seed();

  const employee = await createEmployee({ entraOid: "oid-risk" });
  await grantModule(employee.id, BAS_MODULE_KEY);
  signedInAs("oid-risk");
  viewer = {
    id: employee.id,
    email: employee.email,
    firstName: employee.firstName,
    lastName: employee.lastName,
    profileCompleted: true,
    isPlatformAdmin: false,
  };
});

afterEach(async () => {
  await drop();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDb();
});

const health = () => getCollectionHealth(viewer, { siteId });
const byName = (h: CollectionHealth, name: string) =>
  h.points.find((p) => p.pointName === name) as PointHealthRow;

/** What the list says, computed here independently of every surface. */
const EXPECTED_AT_RISK = SHAPES.filter((s) => AT_RISK_ROLL_RISKS.includes(s.expectRisk));
const EXPECTED_HIDDEN_AT_RISK = EXPECTED_AT_RISK.filter((s) => s.hidden);

describe("the fixture holds every state the view can produce", () => {
  it("classifies each point as its shape says, through the real view", async () => {
    const result = await health();
    for (const shape of SHAPES) {
      expect(byName(result, shape.name)?.risk, shape.name).toBe(shape.expectRisk);
      expect(byName(result, shape.name)?.visible, shape.name).toBe(!shape.hidden);
    }
    expect(result.totals.activePoints).toBe(SHAPES.length);
  });
});

describe("the one predicate", () => {
  it("says what each state is, absolutely", () => {
    // These are the answers. Every surface below is held to them, so a change
    // to the list fails here AND on every surface, together.
    expect(isAtRisk("data_lost")).toBe(true);
    expect(isAtRisk("at_risk")).toBe(true);
    expect(isAtRisk("roll_horizon_unknown")).toBe(true);
    expect(isAtRisk("never_collected")).toBe(true);
    expect(isAtRisk("ok")).toBe(false);
    expect(isAtRisk("buffer_not_full")).toBe(false);
  });

  it("is defined exactly once in the application source", async () => {
    // The literal list must appear in lib/modules/bas/types.ts and nowhere
    // else, and no source may re-derive at-risk-ness from `ok`. This is the
    // guard against the next second definition.
    const files = [
      "lib/modules/bas/types.ts",
      "lib/modules/bas/service.ts",
      "lib/modules/bas/settings-service.ts",
      "lib/home/service.ts",
      "app/(modules)/bas/health-client.ts",
      "app/(modules)/bas/collection-health.tsx",
      "app/(modules)/bas/settings-view.tsx",
      "app/(modules)/bas/point-explorer.tsx",
      "app/(modules)/bas/dashboard.tsx",
      "lib/home/bas-figure.ts",
    ];
    const sources = await Promise.all(
      files.map(async (f) => [f, await readFile(path.join(process.cwd(), f), "utf8")] as const),
    );
    const listLiteral = /"data_lost",\s*"at_risk",\s*"roll_horizon_unknown",\s*"never_collected"/g;
    const definitions = sources.flatMap(([f, s]) => (s.match(listLiteral) ?? []).map(() => f));
    expect(definitions).toEqual(["lib/modules/bas/types.ts"]);

    for (const [f, s] of sources) {
      expect(s, `${f} decides at-risk from 'ok' in SQL`).not.toMatch(/roll_risk\s*<>\s*'ok'/);
      expect(s, `${f} decides at-risk from "ok" in TypeScript`).not.toMatch(/\.risk\s*[!=]==\s*"ok"/);
    }
  });
});

describe("every surface answers from the one predicate, and they agree", () => {
  it("the tile: pointsAtRisk is the list applied to the per-point rows", async () => {
    const result = await health();
    const fromRows = result.points.filter((p) => isAtRisk(p.risk)).length;

    expect(result.totals.pointsAtRisk).toBe(EXPECTED_AT_RISK.length);
    expect(result.totals.pointsAtRisk).toBe(fromRows);
    expect(result.totals.pointsAtRisk).toBe(atRiskCount(result.totals.riskCounts));
    // Two not-full points are active, hidden or not, and neither is counted.
    expect(result.totals.riskCounts.buffer_not_full).toBe(2);
    expect(result.totals.pointsAtRisk).toBe(4);
  });

  it("the breakdown: sums to the tile and names only states the list names", async () => {
    const result = await health();
    const breakdown = riskBreakdown(result.totals.riskCounts);

    expect(breakdown.reduce((sum, e) => sum + e.count, 0)).toBe(result.totals.pointsAtRisk);
    expect(breakdown.map((e) => e.risk).sort()).toEqual(
      [...new Set(EXPECTED_AT_RISK.map((s) => s.expectRisk))].sort(),
    );
    expect(breakdown.map((e) => e.risk)).not.toContain("buffer_not_full");
    expect(atRiskShape(result.totals.riskCounts)).toBe("losing");
    expect(describeAtRisk(result.totals.riskCounts)).toBe("1 of 4 points losing data");
  });

  it("the hidden-point sentence: counts hidden points by the same predicate", async () => {
    const result = await health();
    const fromRows = result.points.filter((p) => !p.visible && isAtRisk(p.risk)).length;

    // Three points are hidden: one lost, one unknown, one not full. Two are at risk.
    expect(result.totals.hiddenPoints).toBe(3);
    expect(result.totals.hiddenPointsAtRisk).toBe(EXPECTED_HIDDEN_AT_RISK.length);
    expect(result.totals.hiddenPointsAtRisk).toBe(2);
    expect(result.totals.hiddenPointsAtRisk).toBe(fromRows);
    expect(result.totals.hiddenPointsAtRisk).toBeLessThanOrEqual(result.totals.pointsAtRisk);
    expect(describeHiddenRisk(result)).toBe(
      "2 more points are at risk but hidden from the table below.",
    );
  });

  it("the headroom badge: the unknown share is the at-risk points with no number", async () => {
    const result = await health();
    const headroom = computeHeadroom(result.points);
    const noNumber = (p: PointHealthRow) => p.rollHorizonHours === null || p.minutesAgo === null;

    expect(headroom.unknown).toBe(result.points.filter((p) => noNumber(p) && isAtRisk(p.risk)).length);
    expect(headroom.notFull).toBe(result.points.filter((p) => noNumber(p) && !isAtRisk(p.risk)).length);
    // Absolutely: unknown + never collected are the unknown share; the two
    // not-full points are named as not full, never as unknown.
    expect(headroom).toMatchObject({ known: 4, unknown: 2, notFull: 2, total: 8 });
    expect(describeHeadroom(headroom)).toMatch(/across 4 of 8 points, 2 unknown, 2 not full yet$/);
  });

  it("the reporting ratio: reporting is not-at-risk, the tile inverted", async () => {
    const result = await health();

    expect(reportingPoints(result.points)).toBe(result.totals.activePoints - result.totals.pointsAtRisk);
    expect(reportingPoints(result.points)).toBe(4);
  });

  it("the Dashboard card: the project's figure is Collection Health filtered to that project", async () => {
    /**
     * The fifth surface (2026-09-30). The card has its own SQL - per-project
     * per-state counts - and its own opportunity to grow a private
     * definition, which is exactly what this holds it against: the card's
     * number must be the number Collection Health shows when filtered to the
     * same project, and both must be the list applied to the same rows.
     * Hidden points are in it, as everywhere - CfgLost is hidden and lost.
     */
    const dashboard = await getDashboard(viewer);
    const card = dashboard.projects.find((p) => p.name === `${PREFIX}PROJECT`);
    expect(card).toBeDefined();
    expect(card!.health).not.toBeNull();

    const filtered = await getCollectionHealth(viewer, {
      projectId: BigInt(card!.projectId),
    });
    expect(filtered.scope.filtered).toBe(true);

    expect(card!.health!.pointsAtRisk).toBe(filtered.totals.pointsAtRisk);
    expect(card!.health!.riskCounts).toEqual(filtered.totals.riskCounts);
    expect(card!.health!.activePoints).toBe(filtered.totals.activePoints);
    // By the one list, and absolutely: the four at-risk shapes, not the two
    // not-full ones.
    expect(card!.health!.pointsAtRisk).toBe(atRiskCount(card!.health!.riskCounts));
    expect(card!.health!.pointsAtRisk).toBe(EXPECTED_AT_RISK.length);
    expect(card!.health!.pointsAtRisk).toBe(4);
    // And the words on the card are the Home tile's words for the same number.
    expect(basFigure(card!.health!)).toMatchObject({
      value: "4 points at risk",
      alarm: true,
    });
  });
});

describe("the headroom badge asks the predicate, not the horizon", () => {
  /**
   * On real rows "not at risk and numberless" and "horizon state not_full" are
   * the same points, so a badge that decided from the horizon state would
   * pass every fixture above and still be a second definition - one refactor
   * away from disagreeing with the tile. These rows are deliberately
   * incoherent so that only the risk can decide.
   */
  const row = (over: Partial<PointHealthRow>): PointHealthRow => ({
    pointId: "x",
    pointName: "x",
    siteName: "s",
    pointRole: null,
    unit: null,
    risk: "ok",
    lastReadingAt: null,
    minutesAgo: 60,
    rollHorizonHours: null,
    horizonSource: null,
    horizon: { state: "unknown", hours: null, currentHours: null, stationCount: null, capacity: null },
    completeness: "unknown",
    stationCount: null,
    heldCount: null,
    visible: true,
    ...over,
  });

  it("files a numberless AT-RISK point as unknown even if its horizon state says not full", () => {
    const h = computeHeadroom([
      row({ risk: "roll_horizon_unknown", horizon: { state: "not_full", hours: null, currentHours: null, stationCount: 320, capacity: 500 } }),
    ]);
    expect(h.unknown).toBe(1);
    expect(h.notFull).toBe(0);
  });

  it("files a numberless NOT-at-risk point as not full even if its horizon state says unknown", () => {
    const h = computeHeadroom([row({ risk: "buffer_not_full" })]);
    expect(h.notFull).toBe(1);
    expect(h.unknown).toBe(0);
  });
});

describe("the live shape of 2026-09-18: only not-full points hidden, nothing at risk", () => {
  /**
   * Four not-full points hidden, everything else collecting inside its
   * horizon. Before the fix the sentence said four were at risk over a tile
   * saying none were. Reproduced against the live database inside a
   * rolled-back transaction before this file was written: tile 0, sentence 4.
   */
  beforeEach(async () => {
    // Take the at-risk points out of collection, so the only non-ok states
    // left are the two not-full ones - and hide both, like the live screen.
    for (const shape of EXPECTED_AT_RISK) {
      await testDb.basPoint.update({
        where: { pointId: pointIds.get(shape.name)! },
        data: { isActive: false, inactiveReason: "manual" },
      });
    }
    await testDb.basPoint.update({
      where: { pointId: pointIds.get("NotFullShown")! },
      data: { isVisible: false },
    });
  });

  it("says nothing about hidden risk, and the tile, badge and ratio agree", async () => {
    const result = await health();

    expect(result.totals.activePoints).toBe(4);
    expect(result.totals.hiddenPoints).toBe(2);
    expect(result.totals.riskCounts.buffer_not_full).toBe(2);

    // The tile.
    expect(result.totals.pointsAtRisk).toBe(0);
    expect(atRiskShape(result.totals.riskCounts)).toBe("none");
    expect(atRiskTone(result.totals.riskCounts)).toBe("ok");
    expect(describeAtRisk(result.totals.riskCounts)).toBe("None at risk");
    expect(riskBreakdown(result.totals.riskCounts)).toEqual([]);

    // The sentence: nothing at all, not "0 hidden points are at risk".
    expect(result.totals.hiddenPointsAtRisk).toBe(0);
    expect(describeHiddenRisk(result)).toBeNull();

    // The badge and the ratio.
    // MeasuredOk: a 2 h shortest span, collected 10 minutes ago -> 1.8 h left,
    // and it is the smaller of the two known points.
    expect(describeHeadroom(computeHeadroom(result.points))).toBe(
      "1.8 h headroom across 2 of 4 points, 2 not full yet",
    );
    expect(computeHeadroom(result.points).unknown).toBe(0);
    expect(reportingPoints(result.points)).toBe(4);

    // The Dashboard card, same shape: two not-full points, hidden, are not
    // at risk. The card reads calm and carries no mark.
    const card = (await getDashboard(viewer)).projects.find(
      (p) => p.name === `${PREFIX}PROJECT`,
    );
    expect(card?.health?.pointsAtRisk).toBe(0);
    expect(card?.health?.riskCounts.buffer_not_full).toBe(2);
    expect(basFigure(card!.health!)).toEqual({
      state: "none",
      value: "No points at risk",
      status: expect.stringMatching(/^(No readings yet|newest reading .* ago)$/),
    });
  });
});

describe("a hidden point that IS at risk is never silent", () => {
  /**
   * The failure that matters, the other way round: hiding the only at-risk
   * point must not make the screen read as all clear. Same predicate, so the
   * sentence and the tile move together.
   */
  it("keeps the count and the sentence when the only at-risk point is hidden", async () => {
    for (const shape of EXPECTED_AT_RISK.filter((s) => s.name !== "Unknown")) {
      await testDb.basPoint.update({
        where: { pointId: pointIds.get(shape.name)! },
        data: { isActive: false, inactiveReason: "manual" },
      });
    }
    const result = await health();

    expect(result.totals.pointsAtRisk).toBe(1);
    expect(result.totals.hiddenPointsAtRisk).toBe(1);
    expect(atRiskTone(result.totals.riskCounts)).toBe("warn");
    expect(describeHiddenRisk(result)).toContain(
      "No points at risk are listed in the table below, but 1 hidden point is at risk.",
    );
    // And the not-full hidden point beside it adds nothing to either number.
    expect(result.totals.hiddenPoints).toBe(2);

    // The Dashboard card counts the hidden at-risk point too: hiding is a
    // preference of the browsing screens and changes nothing about collection.
    const card = (await getDashboard(viewer)).projects.find(
      (p) => p.name === `${PREFIX}PROJECT`,
    );
    expect(card?.health?.pointsAtRisk).toBe(1);
    expect(basFigure(card!.health!)).toMatchObject({ value: "1 point at risk", alarm: true });
  });

  it("refuses to build prose over numbers that disagree", () => {
    // Cannot happen from the service any more; if it does, say so rather than
    // render "-4 more points".
    expect(
      describeHiddenRisk({
        totals: { pointsAtRisk: 0, hiddenPointsAtRisk: 4 },
        unfiltered: null,
        scope: { filtered: false, label: null },
      }),
    ).toMatch(/figures disagree/);
  });
});

// =============================================================================
// MUTATIONS - each applied to a clean tree on 2026-09-18 and restored; the
// suites run were this file, bas-collection-health, bas-health-ui,
// bas-headroom and bas-cascade (205 tests, all passing clean).
//
//   P1. AT_RISK_ROLL_RISKS gains "buffer_not_full" (the old sentence's answer)
//       -> 20 failures across FOUR files. In this file: the tile, the
//          breakdown, the hidden-point sentence, the headroom badge, the
//          reporting ratio, the live shape, the absolute predicate and the
//          badge-asks-the-predicate test - every surface, together.
//   P2. AT_RISK_ROLL_RISKS loses "roll_horizon_unknown" (unknown becomes safe)
//       -> 34 failures across four files, every surface in this file included,
//          plus the source-text guard ("defined exactly once") because the
//          literal no longer matches.
//   P3. A second definition: hiddenPointsAtRisk decided by `risk !== "ok"`
//       again -> 4 failures, all here: the sentence test, the live shape, the
//       hidden-at-risk test and the source-text guard. Nothing else moved,
//       which is the point - the other surfaces still shared the list.
//   P4. A second definition: the headroom badge decides its shares from
//       horizon.state instead of the predicate -> 0 failures on the first
//       run. On real rows the two coincide, so every fixture passed. The
//       "asks the predicate, not the horizon" block above was added for it,
//       with rows that are deliberately incoherent; re-run: 2 failures, both
//       there.
//
//   P5. (2026-09-30, the Dashboard card) A private definition on the new
//       screen: getDashboard's pointsAtRisk becomes `active_points - risk_ok`,
//       the 2026-09-18 sentence's answer -> 3 failures, ALL in this file: the
//       card test (6 vs 4), the live shape (2 vs 0) and hidden-at-risk (2 vs 1).
//       tests/bas-dashboard.test.tsx passed untouched, 31/31 - its fixture has
//       no not-full point, so it cannot tell. That is why the card is held HERE.
//   P6. (same day) The card forgets one state: roll_horizon_unknown zeroed in
//       the card's riskCounts -> 2 failures, both here: the card test (3 vs 4)
//       and hidden-at-risk, where Unknown is the only at-risk point (0 vs 1).
//
// Reproduced on the live database first, inside a rolled-back transaction,
// with the service's SQL verbatim from origin/main and the four office points
// hidden: tile 0, sentence 4. Same transaction, one predicate: tile 0,
// sentence 0, no sentence rendered.
// =============================================================================
