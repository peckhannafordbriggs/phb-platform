import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Only the session is mocked. The guard, the Zod schema, the service and the
// real Prisma queries all run.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { Pool } from "pg";
import { auth } from "@/auth";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { buildSchemaContext } from "@/lib/modules/bas/analyze/schema-context";
import { SYSTEM_RULES as PLANNER_RULES } from "@/lib/modules/bas/analyze/planner";
import { resolveScope, type DefinitionForRun } from "@/lib/modules/bas/reports/engine/scope";
import { hiddenLine } from "@/lib/modules/bas/reports/engine/render";
import type { Provenance } from "@/lib/modules/bas/analyze/types";
import { describeHiddenInScope } from "@/app/(modules)/bas/analyze-client";
import {
  describeBulkVisibilityPlan,
  describeBulkVisibilityResult,
} from "@/app/(modules)/bas/health-client";
import { POST as bulkVisibility } from "@/app/api/modules/bas/settings/points/bulk-visibility/route";
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
 * Hidden points (2026-11-20).
 *
 * On CEI_JCI_N2 the AHU_7/* histories are the JACE's local copies of
 * CEI_AHU_7's points and log a constant 0; the real data is collected on
 * CEI_AHU_7 itself, through the parent. Hiding them must keep them collected
 * and in every data-loss figure, and take them out of reports, Analyze and
 * the stuck-value check (that last one is tests/bas-plausibility.test.ts).
 *
 *   1. The bulk route: all or nothing, `is_visible` alone - never
 *      `is_active` - one audit row per point that changed, strict payload,
 *      module admins only.
 *   2. Reports: a hidden point is outside the scope and the Point Inventory
 *      says how many were left out.
 *   3. Analyze: the catalogue does not list a hidden point and says how many
 *      there are; the planner is told to keep only visible points; an answer
 *      that read one says so.
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

async function signInAs(admin: boolean) {
  const employee = await createEmployee();
  await grantModule(employee.id, BAS_MODULE_KEY);
  if (admin) await grantModuleAdmin(employee.id, BAS_MODULE_KEY);
  signedInAs(employee.entraOid!);
  return employee;
}

function post(body: unknown): Promise<Response> {
  return bulkVisibility(
    new Request("http://localhost/api/modules/bas/settings/points/bulk-visibility", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

interface Seeded {
  orgId: bigint;
  projectId: bigint;
  siteId: bigint;
  stationId: bigint;
  copies: bigint[];
  real: bigint;
}

let seeded: Seeded;

async function seed(): Promise<Seeded> {
  const org = await testDb.basOrg.create({ data: { name: "ZZTEST_HIDDEN_ORG" } });
  const project = await testDb.basProject.create({ data: { orgId: org.orgId, name: "ZZTEST_HIDDEN_PROJECT" } });
  const site = await testDb.basSite.create({
    data: { orgId: org.orgId, projectId: project.projectId, name: "ZZTEST_HIDDEN_SITE", timezone: "America/New_York" },
  });
  const station = await testDb.basStation.create({
    data: { siteId: site.siteId, niagaraStationName: "ZZ_CEI_JCI_N2", connectionMode: "direct", baseUrl: "https://198.51.100.149" },
  });
  const point = async (name: string) =>
    (await testDb.basPoint.create({ data: { stationId: station.stationId, niagaraHistoryName: name, dataType: "real" } })).pointId;
  return {
    orgId: org.orgId,
    projectId: project.projectId,
    siteId: site.siteId,
    stationId: station.stationId,
    copies: [await point("ZZ_AHU_7_DA_T"), await point("ZZ_AHU_7_RA_T")],
    real: await point("ZZ_XTM_109_FinalFilter"),
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetBasAvailabilityCache();
  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();
  seeded = await seed();
});

afterEach(async () => {
  await testDb.basPoint.deleteMany({ where: { stationId: seeded.stationId } });
  await testDb.basStation.deleteMany({ where: { stationId: seeded.stationId } });
  await testDb.basSite.deleteMany({ where: { siteId: seeded.siteId } });
  await testDb.basProject.deleteMany({ where: { projectId: seeded.projectId } });
  await testDb.basOrg.deleteMany({ where: { orgId: seeded.orgId } });
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDb();
});

const state = async () =>
  new Map(
    (
      await testDb.basPoint.findMany({
        where: { stationId: seeded.stationId },
        select: { pointId: true, isVisible: true, isActive: true },
      })
    ).map((p) => [p.pointId.toString(), p]),
  );

// ---------------------------------------------------------------------------
// 1. The bulk route
// ---------------------------------------------------------------------------

describe("Hide on a selection", () => {
  it("hides exactly the selection, never stops collection, and audits each point", async () => {
    await signInAs(true);
    const response = await post({ pointIds: seeded.copies.map(String), visible: false });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { points: number; changed: number; unchanged: number } };
    expect(body.data).toEqual({ points: 2, changed: 2, unchanged: 0 });

    const rows = await state();
    for (const id of seeded.copies) {
      expect(rows.get(id.toString())).toMatchObject({ isVisible: false, isActive: true });
    }
    expect(rows.get(seeded.real.toString())).toMatchObject({ isVisible: true, isActive: true });

    const audit = await testDb.auditEvent.findMany({ where: { action: "bas.point_visibility_changed" } });
    expect(audit).toHaveLength(2);
    for (const row of audit) {
      expect(row.metadata).toMatchObject({ visible: false, collected: true, viaBulk: true, selectionSize: 2 });
    }
  });

  it("writes nothing for a point already hidden, and says so", async () => {
    await signInAs(true);
    await post({ pointIds: seeded.copies.map(String), visible: false });
    const again = (await (await post({ pointIds: seeded.copies.map(String), visible: false })).json()) as {
      data: { changed: number; unchanged: number };
    };
    expect(again.data).toMatchObject({ changed: 0, unchanged: 2 });
    expect(await testDb.auditEvent.count({ where: { action: "bas.point_visibility_changed" } })).toBe(2);
    expect(describeBulkVisibilityResult({ points: 2, changed: 0, unchanged: 2 }, false)).toBe(
      "Hidden: 0 of 2 points (2 already hidden).",
    );
  });

  it("refuses the whole selection when one point is missing, and changes nothing", async () => {
    await signInAs(true);
    const response = await post({ pointIds: [...seeded.copies.map(String), "999999999"], visible: false });
    expect(response.status).toBe(404);
    const rows = await state();
    expect([...rows.values()].every((p) => p.isVisible)).toBe(true);
  });

  it("refuses isActive in the payload rather than ignoring it", async () => {
    await signInAs(true);
    const response = await post({ pointIds: [seeded.copies[0]!.toString()], visible: false, isActive: false });
    expect(response.status).toBe(422);
    expect([...(await state()).values()].every((p) => p.isVisible && p.isActive)).toBe(true);
  });

  it("is a module admin's action: a plain BAS user reads 404", async () => {
    await signInAs(false);
    const response = await post({ pointIds: seeded.copies.map(String), visible: false });
    expect(response.status).toBe(404);
  });

  it("confirms with the count and says collection goes on", () => {
    const plan = describeBulkVisibilityPlan(3, false);
    expect(plan).toContain("Hide 3 points?");
    expect(plan).toContain("keep being collected");
    expect(plan).toContain("reports, Analyze and the stuck-value check");
  });
});

// ---------------------------------------------------------------------------
// 2. Reports
// ---------------------------------------------------------------------------

describe("Reports leave a hidden point out, and say so", () => {
  it("drops it from the scope and counts it per station", async () => {
    await testDb.basPoint.updateMany({ where: { pointId: { in: seeded.copies } }, data: { isVisible: false } });
    const now = Date.now();
    const scope = await resolveScope(
      {
        site: { siteId: seeded.siteId, name: "ZZTEST_HIDDEN_SITE", timezone: "America/New_York" },
        stationIds: [],
      } as unknown as DefinitionForRun,
      { start: now - 86_400_000, end: now },
    );
    expect(scope.points.map((p) => p.pointId)).toEqual([seeded.real.toString()]);
    expect(scope.hiddenByStation.get(seeded.stationId.toString())).toBe(2);
    expect(hiddenLine({ stationName: "ZZ_CEI_JCI_N2", count: 2 })).toBe(
      "2 points on ZZ_CEI_JCI_N2 are hidden in Settings and were left out of this report; they are still collected.",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Analyze
// ---------------------------------------------------------------------------

describe("Analyze leaves a hidden point out, and says when an answer read one", () => {
  it("does not list it in the catalogue, and counts it", async () => {
    await testDb.basPoint.updateMany({ where: { pointId: { in: seeded.copies } }, data: { isVisible: false } });
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    try {
      const context = await buildSchemaContext(pool);
      expect(context.text).toContain("ZZ_XTM_109_FinalFilter");
      expect(context.text).not.toContain("ZZ_AHU_7_DA_T");
      expect(context.text).not.toContain("ZZ_AHU_7_RA_T");
      expect(context.text).toContain("## Hidden points: 2");
    } finally {
      await pool.end();
    }
  });

  it("tells the planner to keep only visible points - no longer to ignore the flag", () => {
    expect(PLANNER_RULES).toContain("add p.is_visible");
    expect(PLANNER_RULES).not.toContain("ignore is_visible");
  });

  it("names a hidden point the answer read, for a declared scope only", () => {
    const provenance = {
      scope: "declared",
      points: [
        { id: "1", name: "AHU_7/DA_T", site: "CEI", station: "CEI_JCI_N2", collected: true, hidden: true },
        { id: "2", name: "DA_T", site: "CEI", station: "CEI_AHU_7", collected: true, hidden: false },
      ],
    } as unknown as Provenance;
    expect(describeHiddenInScope(provenance)).toContain("This answer read 1 point hidden in Settings (AHU_7/DA_T)");
    expect(describeHiddenInScope({ ...provenance, scope: "all_points" })).toBe("");
  });
});
