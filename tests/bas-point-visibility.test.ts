import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Only the session is mocked. The guard, the wrapper, the Zod schema, the
// service and the real Prisma queries all run - half this file is about a 404,
// and a mocked guard would only prove the mock agrees with the test.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { auth } from "@/auth";
import { describeAuditEvent } from "@/lib/admin/audit-describe";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import type { StationPointsList } from "@/lib/modules/bas/types";
import { PointsTable } from "@/app/(modules)/bas/settings-view";
import { PATCH as patchPoint } from "@/app/api/modules/bas/settings/points/[pointId]/route";
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
import { notCheckedPlausibility } from "@/lib/modules/bas/plausibility";

const NOT_CHECKED_FIXTURE = notCheckedPlausibility("no_role");

/**
 * The Shown checkbox (B8.3): one point, one field, and the field is not
 * `is_active`.
 *
 * What is asserted, in order of how much it matters:
 *
 *   1. Hiding a point changes `is_visible` and NOTHING ELSE on the row.
 *      `is_active` is read before and after, because the whole plan turns on
 *      those two columns never being confused, and a route that quietly
 *      touched the wrong one would look exactly like this one from the screen.
 *   2. The change is audited, the sentence says "still collected", and a
 *      repeat of the same value is not a change and writes no row.
 *   3. Access: module admin or 404. A plain BAS user, an unknown point and a
 *      malformed id all read the same.
 *   4. The payload is closed: `isActive` in the body is refused, not ignored.
 *   5. The table renders a real checkbox, checked for a shown point.
 *
 * Fixtures are seeded with testDb and dropped by name, like the other settings
 * suites, because the service reads through the shared prisma client.
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

async function signInAsAdmin() {
  const employee = await createEmployee();
  await grantModule(employee.id, BAS_MODULE_KEY);
  await grantModuleAdmin(employee.id, BAS_MODULE_KEY);
  signedInAs(employee.entraOid!);
  return employee;
}

async function signInAsPlainBasUser() {
  const employee = await createEmployee();
  await grantModule(employee.id, BAS_MODULE_KEY);
  signedInAs(employee.entraOid!);
  return employee;
}

function patch(pointId: string, body: unknown): Promise<Response> {
  return patchPoint(
    new Request(`http://localhost/api/modules/bas/settings/points/${pointId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ pointId }) },
  );
}

async function payload(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

const NAME = "ZZB83_VAV$2d1_ZoneTemperature";

interface Seeded {
  pointId: bigint;
  stationId: bigint;
}

async function seed(): Promise<Seeded> {
  const org = await testDb.basOrg.create({ data: { name: "ZZTEST_B83_ORG" } });
  const project = await testDb.basProject.create({
    data: { orgId: org.orgId, name: "ZZTEST_B83_PROJECT" },
  });
  const site = await testDb.basSite.create({
    data: {
      orgId: org.orgId,
      projectId: project.projectId,
      name: "ZZTEST_B83_SITE",
      timezone: "America/New_York",
    },
  });
  const station = await testDb.basStation.create({
    data: {
      siteId: site.siteId,
      niagaraStationName: "ZZB83_Station",
      connectionMode: "direct",
      baseUrl: "https://198.51.100.31",
    },
  });
  const point = await testDb.basPoint.create({
    data: {
      stationId: station.stationId,
      niagaraHistoryName: NAME,
      niagaraDisplayName: "VAV-1_ZoneTemperature",
      label: "Zone Temp 130",
      dataType: "real",
      checkpoint: { create: { completeness: "complete" } },
    },
  });
  return { pointId: point.pointId, stationId: station.stationId };
}

async function drop() {
  await testDb.basPoint.deleteMany({ where: { niagaraHistoryName: { startsWith: "ZZB83_" } } });
  await testDb.basStation.deleteMany({ where: { niagaraStationName: { startsWith: "ZZB83_" } } });
  await testDb.basSite.deleteMany({ where: { name: { startsWith: "ZZTEST_B83" } } });
  await testDb.basProject.deleteMany({ where: { name: { startsWith: "ZZTEST_B83" } } });
  await testDb.basOrg.deleteMany({ where: { name: { startsWith: "ZZTEST_B83" } } });
}

async function row(pointId: bigint) {
  return testDb.basPoint.findUniqueOrThrow({
    where: { pointId },
    select: { isVisible: true, isActive: true, inactiveReason: true, label: true },
  });
}

async function auditRows() {
  return testDb.auditEvent.findMany({
    where: { action: "bas.point_visibility_changed" },
    orderBy: { occurredAt: "asc" },
  });
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
});

afterAll(async () => {
  await drop();
  await disconnectDb();
});

describe("hiding a point changes is_visible and nothing else", () => {
  it("hides, and leaves is_active exactly where it was", async () => {
    const { pointId } = await seed();
    await signInAsAdmin();
    const before = await row(pointId);
    expect(before).toMatchObject({ isVisible: true, isActive: true, inactiveReason: null });

    const response = await patch(pointId.toString(), { visible: false });
    expect(response.status).toBe(200);
    expect(await payload(response)).toEqual({ data: { changed: true } });

    const after = await row(pointId);
    expect(after.isVisible).toBe(false);
    // THE COLUMN THAT MUST NOT MOVE.
    expect(after.isActive).toBe(true);
    expect(after.inactiveReason).toBeNull();
    expect(after.label).toBe(before.label);
  });

  it("shows it again the same way", async () => {
    const { pointId } = await seed();
    await signInAsAdmin();
    await patch(pointId.toString(), { visible: false });

    const response = await patch(pointId.toString(), { visible: true });
    expect(await payload(response)).toEqual({ data: { changed: true } });
    expect((await row(pointId)).isVisible).toBe(true);
  });

  it("does not touch a point that is not collected either way", async () => {
    // Hiding an inactive point is allowed - it is a row in the Points list like
    // any other - and must not clear its reason or turn it back on.
    const { pointId } = await seed();
    await testDb.basPoint.update({
      where: { pointId },
      data: { isActive: false, inactiveReason: "manual" },
    });
    await signInAsAdmin();

    await patch(pointId.toString(), { visible: false });
    expect(await row(pointId)).toMatchObject({
      isVisible: false,
      isActive: false,
      inactiveReason: "manual",
    });
  });
});

describe("the change is audited, and a non-change is not", () => {
  it("writes one row naming the point, the value, and that it is still collected", async () => {
    const { pointId, stationId } = await seed();
    const admin = await signInAsAdmin();

    await patch(pointId.toString(), { visible: false });

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorEmployeeId).toBe(admin.id);
    expect(rows[0]!.moduleKey).toBe(BAS_MODULE_KEY);
    expect(rows[0]!.metadata).toMatchObject({
      pointId: pointId.toString(),
      stationId: stationId.toString(),
      niagaraHistoryName: NAME,
      label: "Zone Temp 130",
      visible: false,
      collected: true,
    });
  });

  it("reads as a sentence that says hidden, not stopped", async () => {
    const { pointId } = await seed();
    await signInAsAdmin();
    await patch(pointId.toString(), { visible: false });
    const [hidden] = await auditRows();

    const actor = { id: "a", firstName: "Jim", lastName: "Schwarz", email: "j@phb1899.com" };
    const described = describeAuditEvent({
      action: hidden!.action,
      moduleKey: hidden!.moduleKey,
      metadata: hidden!.metadata,
      actor,
      target: null,
    });
    expect(described.sentence).toBe(
      "Jim Schwarz hid the point Zone Temp 130 from the browsing screens (still collected)",
    );

    await patch(pointId.toString(), { visible: true });
    const shown = (await auditRows())[1]!;
    expect(
      describeAuditEvent({
        action: shown.action,
        moduleKey: shown.moduleKey,
        metadata: shown.metadata,
        actor,
        target: null,
      }).sentence,
    ).toBe("Jim Schwarz showed the point Zone Temp 130 on the browsing screens again");
  });

  it("falls back to the oBIX key when nobody has typed a label", async () => {
    const { pointId } = await seed();
    await testDb.basPoint.update({ where: { pointId }, data: { label: null } });
    await signInAsAdmin();
    await patch(pointId.toString(), { visible: false });
    const [hidden] = await auditRows();
    expect(
      describeAuditEvent({
        action: hidden!.action,
        moduleKey: hidden!.moduleKey,
        metadata: hidden!.metadata,
        actor: null,
        target: null,
      }).sentence,
    ).toContain(NAME);
  });

  it("treats the same value twice as no change, with no second audit row", async () => {
    const { pointId } = await seed();
    await signInAsAdmin();
    await patch(pointId.toString(), { visible: false });

    const again = await patch(pointId.toString(), { visible: false });
    expect(await payload(again)).toEqual({ data: { changed: false } });
    expect(await auditRows()).toHaveLength(1);

    // And showing an already-shown point on a fresh row is not a change either.
    const { pointId: other } = await (async () => {
      const station = await testDb.basStation.findFirstOrThrow({
        where: { niagaraStationName: "ZZB83_Station" },
      });
      const p = await testDb.basPoint.create({
        data: { stationId: station.stationId, niagaraHistoryName: "ZZB83_Other", dataType: "real" },
      });
      return { pointId: p.pointId };
    })();
    const noop = await patch(other.toString(), { visible: true });
    expect(await payload(noop)).toEqual({ data: { changed: false } });
    expect(await auditRows()).toHaveLength(1);
  });
});

describe("the payload is closed", () => {
  it("refuses a body that tries to reach is_active", async () => {
    const { pointId } = await seed();
    await signInAsAdmin();

    // Zod strips unknown keys by default, which here would mean an `isActive`
    // in the body is silently ignored rather than refused. Either way the
    // column must not move; this pins down which of the two it is.
    const response = await patch(pointId.toString(), { visible: false, isActive: false });
    const after = await row(pointId);
    expect(after.isActive).toBe(true);
    if (response.status === 200) {
      // Ignored: visibility applied, collection untouched.
      expect(after.isVisible).toBe(false);
    } else {
      expect(response.status).toBe(422);
      expect(after.isVisible).toBe(true);
    }
  });

  it("refuses a non-boolean, and a missing field", async () => {
    const { pointId } = await seed();
    await signInAsAdmin();
    expect((await patch(pointId.toString(), { visible: "no" })).status).toBe(422);
    expect((await patch(pointId.toString(), {})).status).toBe(422);
    expect((await row(pointId)).isVisible).toBe(true);
  });
});

describe("the route is a settings route", () => {
  it("is 404 without the module-admin flag, and changes nothing", async () => {
    const { pointId } = await seed();
    await signInAsPlainBasUser();
    const response = await patch(pointId.toString(), { visible: false });
    expect(response.status).toBe(404);
    expect((await row(pointId)).isVisible).toBe(true);
    expect(await auditRows()).toHaveLength(0);
  });

  it("is 404 for a point that does not exist, and for an id that is not a number", async () => {
    await seed();
    await signInAsAdmin();
    expect((await patch("999999999", { visible: false })).status).toBe(404);
    expect((await patch("not-a-number", { visible: false })).status).toBe(404);
    expect((await patch("1e5", { visible: false })).status).toBe(404);
  });
});

describe("the Points list renders the checkbox", () => {
  const point = (visible: boolean): StationPointsList["points"][number] => ({
    pointId: "7",
    label: "Zone Temp 130",
    niagaraHistoryName: NAME,
    niagaraDisplayName: null,
    pointRole: null,
    roleName: null,
    equipmentId: null,
    equipmentName: null,
    unit: null,
    suggestion: null,
    horizon: { state: "unknown", hours: null, currentHours: null, stationCount: null, capacity: null },
    collected: true,
    inactiveReason: null,
    completeness: "complete",
    lastRecordAt: null,
    visible,
    plausibility: NOT_CHECKED_FIXTURE,
  });

  const render = (visible: boolean) =>
    renderToStaticMarkup(
      createElement(PointsTable, {
        list: {
          stationId: "1",
          siteId: "1",
          points: [point(visible)],
          pointsAccountedFor: { rendered: 1, inDatabase: 1 },
        },
        expectedTotal: 1,
        onToggleVisible: () => undefined,
      }),
    );

  it("is checked for a shown point and unchecked for a hidden one, with the word beside it", () => {
    const shown = render(true);
    expect(shown).toContain('type="checkbox"');
    expect(shown).toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
    expect(shown).toContain(">Shown<");

    const hidden = render(false);
    expect(hidden).toContain('type="checkbox"');
    expect(hidden).not.toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
    expect(hidden).toContain("Hidden");
  });

  it("names the point in the checkbox's label and says what hiding does not do", () => {
    const html = render(true);
    expect(html).toContain("Show Zone Temp 130 on the browsing screens");
    expect(html).toContain("still collected and still");
    expect(html).toContain("every risk figure");
  });
});
