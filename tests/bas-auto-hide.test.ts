import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import type { Viewer } from "@/lib/authz";
import { describeAuditEvent } from "@/lib/admin/audit-describe";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { runAutoAssignPass } from "@/lib/modules/bas/auto-assign";
import { runDuplicatePass } from "@/lib/modules/bas/auto-hide";
import { getPointExplorer, HIDDEN_POINT_MESSAGE } from "@/lib/modules/bas/service";
import { resolveScope, type DefinitionForRun } from "@/lib/modules/bas/reports/engine/scope";
import { duplicateCopiesLine, hiddenLine } from "@/lib/modules/bas/reports/engine/render";
import { renderReportHtml } from "@/lib/modules/bas/reports/engine/html";
import type { BasSettingsTree, StationAssignment, StationPointsList } from "@/lib/modules/bas/types";
import {
  describeAssignmentResult,
  describeCopyOf,
  describeHiddenDuplicateNote,
  describeHiddenDuplicates,
} from "@/app/(modules)/bas/health-client";
import { liveCopyHref } from "@/app/(modules)/bas/filters";
import { HiddenCopyNote } from "@/app/(modules)/bas/point-explorer";
import { NO_POINT_FILTERS, PointsTable, shownPoints } from "@/app/(modules)/bas/settings-points";
import { GET as settingsRoute } from "@/app/api/modules/bas/settings/route";
import { GET as pointsRoute } from "@/app/api/modules/bas/settings/stations/[stationId]/points/route";
import { POST as runNowRoute } from "@/app/api/modules/bas/settings/stations/[stationId]/auto-assign/route";
import { PATCH as pointRoute } from "@/app/api/modules/bas/settings/points/[pointId]/route";
import { reportDocument } from "./fixtures/bas-report-document";
import { CEI_COPY_TAILS, createCeiDuplicateFixture, type CeiDuplicateFixture } from "./bas-cei-fixture";
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
 * Dead duplicate copies hidden automatically (2026-11-23,
 * lib/modules/bas/auto-hide.ts over the rules in duplicate-copies.ts), on
 * CEI as it is: CEI_JCI_N2's 334 names, its AHU_7/* and AHU_8/* histories
 * logging 0 (or false), and the via-parent stations CEI_AHU_7 and CEI_AHU_8
 * holding the same measurements live under their bare names
 * (tests/bas-cei-fixture.ts -> createCeiDuplicateFixture).
 *
 * The pass runs as the scheduler runs it (runAutoAssignPass, and the step on
 * its own as runDuplicatePass) and as the Settings button does (the route);
 * a person's side goes through the real PATCH route, so "manual beats auto"
 * is a statement about the requests the UI makes.
 */

const NAMES = readFileSync(path.join(process.cwd(), "docs/fixtures/cei-point-names.txt"), "utf8")
  .split(/\r?\n/)
  .filter((n) => n.length > 0);

/** The numeric copies: what the numbers call dead copies of a live point. */
const NUMERIC_COPIES = (Object.entries(CEI_COPY_TAILS) as Array<["AHU_7" | "AHU_8", readonly string[]]>).flatMap(
  ([unit, tails]) => tails.filter((t) => t !== "RF_S" && t !== "SF_S").map((t) => ({ unit, tail: t, copy: `${unit}/${t}` })),
);

const authMock = vi.mocked(auth);
function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

let cei: CeiDuplicateFixture;
let viewer: Viewer;
let employeeId: string;

const id = (key: string) => cei.ids.get(key)!;
const copyId = (copy: string) => id(`CEI_JCI_N2:${copy}`);
const liveId = (unit: "AHU_7" | "AHU_8", tail: string) => id(`CEI_${unit}:${tail}`);

async function data<T>(pending: Promise<Response>): Promise<T> {
  const response = await pending;
  const body = (await response.json()) as { data?: T; error?: { code: string; message: string } };
  if (body.error !== undefined) throw new Error(`${response.status} ${body.error.code}: ${body.error.message}`);
  return body.data as T;
}
const stationParams = (stationId: bigint) => ({ params: Promise.resolve({ stationId: stationId.toString() }) });
const runNow = (stationId: bigint) =>
  data<StationAssignment>(runNowRoute(new Request("http://localhost", { method: "POST" }), stationParams(stationId)));
const setVisible = (pointId: bigint, visible: boolean) =>
  data<unknown>(
    pointRoute(
      new Request("http://localhost", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visible }),
      }),
      { params: Promise.resolve({ pointId: pointId.toString() }) },
    ),
  );

interface PointState {
  visible: boolean;
  active: boolean;
  source: string | null;
  reason: string | null;
  duplicateOf: bigint | null;
}
async function stateOf(pointId: bigint): Promise<PointState> {
  const p = await testDb.basPoint.findUniqueOrThrow({
    where: { pointId },
    select: { isVisible: true, isActive: true, hiddenSource: true, hiddenReason: true, duplicateOfId: true },
  });
  return { visible: p.isVisible, active: p.isActive, source: p.hiddenSource, reason: p.hiddenReason, duplicateOf: p.duplicateOfId };
}
/** Every point in the building that is hidden, by "station:name". */
async function hiddenNow(): Promise<string[]> {
  const byId = new Map([...cei.ids.entries()].map(([k, v]) => [v.toString(), k]));
  const rows = await testDb.basPoint.findMany({
    where: { stationId: { in: [cei.jaceId, cei.ahu7Id, cei.ahu8Id] }, isVisible: false },
    select: { pointId: true },
  });
  return rows.map((r) => byId.get(r.pointId.toString())!).sort();
}
const audits = (action: string) => testDb.auditEvent.findMany({ where: { action }, orderBy: { occurredAt: "asc" } });
const sentence = (row: { action: string; moduleKey: string | null; metadata: unknown }) =>
  describeAuditEvent({ action: row.action, moduleKey: row.moduleKey, metadata: row.metadata as never, actor: null, target: null }).sentence;

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetBasAvailabilityCache();
  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();
  cei = await createCeiDuplicateFixture(NAMES);

  const employee = await createEmployee({ entraOid: "oid-auto-hide" });
  employeeId = employee.id;
  await grantModule(employee.id, BAS_MODULE_KEY);
  await grantModuleAdmin(employee.id, BAS_MODULE_KEY);
  signedInAs("oid-auto-hide");
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
  await cei.cleanup();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDb();
});

// ---------------------------------------------------------------------------

describe("CEI through one scheduler pass", () => {
  it("hides the JACE's flat AHU copies as copies of the via-parent stations' live points, and nothing else", async () => {
    const pass = await runAutoAssignPass();
    expect(pass.failed).toEqual([]);
    expect(pass.duplicates.failed).toEqual([]);
    expect(pass.duplicates.buildings).toBe(1);

    for (const { unit, tail, copy } of NUMERIC_COPIES) {
      expect(await stateOf(copyId(copy)), copy).toEqual({
        visible: false,
        active: true, // still collected
        source: "auto",
        reason: "duplicate_copy",
        duplicateOf: liveId(unit, tail),
      });
      // The live half is untouched.
      expect(await stateOf(liveId(unit, tail)), `CEI_${unit}:${tail}`).toEqual({
        visible: true,
        active: true,
        source: null,
        reason: null,
        duplicateOf: null,
      });
    }

    const hidden = await hiddenNow();
    expect(hidden).toEqual(NUMERIC_COPIES.map((c) => `CEI_JCI_N2:${c.copy}`).sort());
    // The fan statuses log false on the JACE and cycle on the child, but a
    // cycling boolean has two values and the test asks for more than three:
    // they are left for a person, by the numbers.
    expect(hidden).not.toContain("CEI_JCI_N2:AHU_7/SF_S");
    expect(hidden).not.toContain("CEI_JCI_N2:AHU_7/RF_S");
    console.info(`CEI parent points hidden as dead copies (${hidden.length}):\n  ${hidden.join("\n  ")}`);

    // The station result says so, on the JACE's row.
    const jace = pass.stations.find((s) => s.stationId === cei.jaceId.toString())!;
    expect(jace).toMatchObject({ duplicatesHidden: NUMERIC_COPIES.length, duplicatesShown: 0 });
    expect(pass.duplicates.changes.every((c) => c.kind === "hidden" && !c.swap)).toBe(true);
  }, 180_000);

  it("audits each with both names and the numbers, with the platform as actor", async () => {
    await runDuplicatePass();
    const rows = await audits("bas.point_auto_hidden");
    expect(rows).toHaveLength(NUMERIC_COPIES.length);
    expect(rows.every((r) => r.actorEmployeeId === null)).toBe(true);
    const sap = rows.find((r) => (r.metadata as { pointName: string }).pointName === "AHU_7/DA_SAP")!;
    expect(sap.metadata).toMatchObject({
      pointId: copyId("AHU_7/DA_SAP").toString(),
      stationName: "CEI_JCI_N2",
      trigger: "scheduler",
      rule: "prefix",
      swap: false,
      collected: true,
      readings: { distinct: 1, modeValue: "0" },
      duplicateOf: { pointId: liveId("AHU_7", "DA_SAP").toString(), stationName: "CEI_AHU_7", pointName: "DA_SAP" },
    });
    expect(sentence(sap)).toBe(
      "The platform hid the point AHU_7/DA_SAP on CEI_JCI_N2 as a dead copy of DA_SAP on CEI_AHU_7: it read 0 for 7 days while that point varied (still collected)",
    );
  }, 120_000);

  it("is idempotent: a second pass writes nothing", async () => {
    await runDuplicatePass();
    const before = { audit: await testDb.auditEvent.count(), hidden: await hiddenNow() };
    const again = await runDuplicatePass();
    expect(again.changes).toEqual([]);
    expect(await testDb.auditEvent.count()).toBe(before.audit);
    expect(await hiddenNow()).toEqual(before.hidden);
  }, 120_000);
});

describe("pairs that are not a duplicate are left alone", () => {
  it("both flat, and both varying, stay shown", async () => {
    const bothFlatCopy = await cei.addPoint(cei.jaceId, "AHU_7/ZZ_BothFlat", "flat");
    const bothFlatLive = await cei.addPoint(cei.ahu7Id, "ZZ_BothFlat", "flat");
    const bothVaryCopy = await cei.addPoint(cei.jaceId, "AHU_7/ZZ_BothVary", "live");
    const bothVaryLive = await cei.addPoint(cei.ahu7Id, "ZZ_BothVary", "live");
    await runDuplicatePass();
    for (const pointId of [bothFlatCopy, bothFlatLive, bothVaryCopy, bothVaryLive]) {
      expect(await stateOf(pointId)).toMatchObject({ visible: true, source: null, reason: null });
    }
  }, 120_000);

  it("a flat AHU_8 point is not called a copy of AHU_7's live point with the same bare name", async () => {
    // CEI_AHU_8 sitting off for a week: its OA_H flat, CEI_AHU_7's live.
    await cei.setSeries(liveId("AHU_8", "OA_H"), "flat");
    await runDuplicatePass();
    expect(await stateOf(liveId("AHU_8", "OA_H"))).toMatchObject({ visible: true, source: null });
    // And the JACE's AHU_8/OA_H, flat beside a flat live half, is not hidden either.
    expect(await stateOf(copyId("AHU_8/OA_H"))).toMatchObject({ visible: true, source: null });
  }, 120_000);
});

describe("a person outranks the platform, hidden or shown", () => {
  it("leaves a copy a person hid by hand as theirs, and one a person showed stays shown", async () => {
    // Hidden by hand before the pass: theirs, with no reason.
    await setVisible(copyId("AHU_7/MA_T"), false);
    // Hidden and shown again by hand: a person decided it is shown.
    await setVisible(copyId("AHU_7/OA_T"), false);
    await setVisible(copyId("AHU_7/OA_T"), true);

    await runDuplicatePass();
    expect(await stateOf(copyId("AHU_7/MA_T"))).toEqual({ visible: false, active: true, source: "manual", reason: null, duplicateOf: null });
    expect(await stateOf(copyId("AHU_7/OA_T"))).toEqual({ visible: true, active: true, source: "manual", reason: null, duplicateOf: null });
    const rows = await audits("bas.point_auto_hidden");
    const named = rows.map((r) => (r.metadata as { pointName: string }).pointName);
    expect(named).not.toContain("AHU_7/MA_T");
    expect(named).not.toContain("AHU_7/OA_T");
    expect(rows).toHaveLength(NUMERIC_COPIES.length - 2);
  }, 120_000);

  it("Unhide makes a copy the person's, and the next pass leaves it shown", async () => {
    await runDuplicatePass();
    await setVisible(copyId("AHU_7/DA_SAP"), true);
    expect(await stateOf(copyId("AHU_7/DA_SAP"))).toEqual({ visible: true, active: true, source: "manual", reason: null, duplicateOf: null });
    const changed = await audits("bas.point_visibility_changed");
    expect(changed.at(-1)!.metadata).toMatchObject({ visible: true, wasDuplicateCopy: true });

    const again = await runDuplicatePass();
    expect(again.changes).toEqual([]);
    expect(await stateOf(copyId("AHU_7/DA_SAP"))).toMatchObject({ visible: true, source: "manual" });
  }, 120_000);

  it("does not hide a copy of a live point a person hid", async () => {
    await setVisible(liveId("AHU_7", "DA_T"), false);
    await runDuplicatePass();
    expect(await stateOf(copyId("AHU_7/DA_T"))).toMatchObject({ visible: true, source: null });
  }, 120_000);
});

describe("the swap, and a copy that varies again", () => {
  it("unhides the copy and hides the live point when they trade places, audited both ways", async () => {
    await runDuplicatePass();
    const copy = copyId("AHU_7/DA_SAP");
    const live = liveId("AHU_7", "DA_SAP");
    // A week later: the JACE's history varies, CEI_AHU_7's reads one value.
    await cei.setSeries(copy, "live");
    await cei.setSeries(live, "flat");

    const pass = await runDuplicatePass();
    expect(pass.changes.map((c) => [c.kind, c.pointName, c.swap])).toEqual([
      ["shown", "AHU_7/DA_SAP", true],
      ["hidden", "DA_SAP", true],
    ]);
    expect(await stateOf(copy)).toEqual({ visible: true, active: true, source: "auto", reason: null, duplicateOf: null });
    expect(await stateOf(live)).toEqual({ visible: false, active: true, source: "auto", reason: "duplicate_copy", duplicateOf: copy });

    const shown = (await audits("bas.point_auto_shown")).at(-1)!;
    expect(shown.metadata).toMatchObject({ reason: "swap", previousDuplicateOf: { pointId: live.toString() } });
    expect(sentence(shown)).toBe(
      "The platform showed the point AHU_7/DA_SAP on CEI_JCI_N2 again, no longer hidden as a duplicate copy: its readings vary again and DA_SAP on CEI_AHU_7 now reads one value, so that one is hidden instead",
    );
    const hidden = (await audits("bas.point_auto_hidden")).at(-1)!;
    expect(hidden.metadata).toMatchObject({ swap: true, pointName: "DA_SAP", duplicateOf: { pointName: "AHU_7/DA_SAP" } });

    // And it settles: nothing more on the next pass.
    expect((await runDuplicatePass()).changes).toEqual([]);
  }, 120_000);

  it("shows a copy again when it varies and its partner still does, and hides nothing", async () => {
    await runDuplicatePass();
    await cei.setSeries(copyId("AHU_7/MA_T"), "live");
    const pass = await runDuplicatePass();
    expect(pass.changes.map((c) => [c.kind, c.pointName, c.swap])).toEqual([["shown", "AHU_7/MA_T", false]]);
    expect(await stateOf(liveId("AHU_7", "MA_T"))).toMatchObject({ visible: true, source: null });
    const row = (await audits("bas.point_auto_shown")).at(-1)!;
    expect(row.metadata).toMatchObject({ reason: "readings_vary" });
  }, 120_000);
});

describe("Run assignment now", () => {
  it("runs the duplicate step for the station pressed, records it on the summary row, and says it", async () => {
    // Pressed on CEI_AHU_7: only AHU_7's copies, which pair with its points.
    // They sit on the JACE, and the press says what it did all the same.
    const result = await runNow(cei.ahu7Id);
    expect(result).toMatchObject({ duplicatesHidden: 9, duplicatesShown: 0 });
    expect(describeAssignmentResult(result)).toContain("Hid 9 dead duplicate copies.");
    const ahu7Copies = NUMERIC_COPIES.filter((c) => c.unit === "AHU_7").map((c) => `CEI_JCI_N2:${c.copy}`);
    expect(await hiddenNow()).toEqual(ahu7Copies.sort());

    const onJace = await runNow(cei.jaceId);
    expect(onJace.duplicatesHidden).toBe(NUMERIC_COPIES.filter((c) => c.unit === "AHU_8").length);
    expect(describeAssignmentResult(onJace)).toContain("Hid 3 dead duplicate copies.");
    const summary = (await audits("bas.auto_assignment_ran")).at(-1)!;
    expect(summary.actorEmployeeId).toBe(employeeId);
    expect(summary.metadata).toMatchObject({ trigger: "run_now", duplicatesHidden: 3 });
    expect(sentence(summary)).toContain("3 dead duplicate copies hidden");

    const rows = await audits("bas.point_auto_hidden");
    expect(rows).toHaveLength(NUMERIC_COPIES.length);
    expect(rows.every((r) => r.actorEmployeeId === employeeId && (r.metadata as { trigger: string }).trigger === "run_now")).toBe(true);
  }, 180_000);
});

// ---------------------------------------------------------------------------

describe("where a person sees them", () => {
  it("Settings -> General counts them per station, and Settings -> Points filters to them with the live point named", async () => {
    await runDuplicatePass();
    const tree = await data<BasSettingsTree>(settingsRoute(new Request("http://localhost/api/modules/bas/settings")));
    const stations = tree.projects.flatMap((p) => p.buildings.flatMap((b) => b.stations));
    const jace = stations.find((s) => s.stationId === cei.jaceId.toString())!;
    expect(jace.hiddenDuplicates).toBe(NUMERIC_COPIES.length);
    expect(stations.find((s) => s.stationId === cei.ahu7Id.toString())!.hiddenDuplicates).toBe(0);
    expect(describeHiddenDuplicates(jace.hiddenDuplicates)).toBe("12 hidden as duplicate copies");
    expect(describeHiddenDuplicates(1)).toBe("1 hidden as a duplicate copy");

    // A person's own hide is not counted as a duplicate copy.
    await setVisible(id("CEI_JCI_N2:V4_22/SpaceTemp"), false);
    const list = await data<StationPointsList>(pointsRoute(new Request("http://localhost"), stationParams(cei.jaceId)));
    const copies = shownPoints(list.points, "", { ...NO_POINT_FILTERS, visibility: "duplicate_copy" });
    expect(copies.map((p) => p.niagaraHistoryName).sort()).toEqual(NUMERIC_COPIES.map((c) => c.copy.replace("/", "$2f")).sort());
    expect(shownPoints(list.points, "", { ...NO_POINT_FILTERS, visibility: "hidden" })).toHaveLength(NUMERIC_COPIES.length + 1);
    const sap = copies.find((p) => p.niagaraHistoryName === "AHU_7$2fDA_SAP")!;
    expect(sap).toMatchObject({ hiddenSource: "auto", hiddenReason: "duplicate_copy", duplicateOf: { name: "DA_SAP", stationName: "CEI_AHU_7" } });
    expect(describeCopyOf(sap.duplicateOf!)).toBe("copy of CEI_AHU_7/DA_SAP");
    // The rows are still all there: nothing filters in SQL.
    expect(list.pointsAccountedFor.rendered).toBe(list.pointsAccountedFor.inDatabase);

    const html = renderToStaticMarkup(
      createElement(PointsTable, { list: { ...list, points: [sap] }, expectedTotal: list.pointsAccountedFor.inDatabase, onUnhide: async () => {} }),
    );
    expect(html).toContain("copy of CEI_AHU_7/DA_SAP");
    expect(html).toContain("Unhide");
  }, 120_000);

  it("Point Explorer notes a hidden copy and links to the live point; a person's hide is still refused", async () => {
    await runDuplicatePass();
    const explorer = await getPointExplorer(viewer, { pointId: copyId("AHU_7/DA_SAP") });
    expect(explorer.selectedPoint).toBeNull();
    expect(explorer.hiddenDuplicate).toMatchObject({
      pointId: copyId("AHU_7/DA_SAP").toString(),
      pointName: "AHU_7/DA_SAP",
      stationName: "CEI_JCI_N2",
      value: "0",
      constant: true,
      unit: "inches of water",
      live: { pointId: liveId("AHU_7", "DA_SAP").toString(), name: "DA_SAP", stationName: "CEI_AHU_7", siteId: cei.siteId.toString() },
    });
    const note = explorer.hiddenDuplicate!;
    expect(describeHiddenDuplicateNote(note)).toBe("Hidden automatically: reads a constant 0 inWC; the live reading is");
    expect(describeHiddenDuplicateNote({ ...note, constant: false, share: 0.996 })).toBe(
      "Hidden automatically: reads 0 inWC almost all the time (99.6% of its readings); the live reading is",
    );
    const href = liveCopyHref(note.live);
    expect(href).toBe(`/bas/points?site=${cei.siteId}&station=${cei.ahu7Id}&point=${liveId("AHU_7", "DA_SAP")}`);
    const html = renderToStaticMarkup(createElement(HiddenCopyNote, { note }));
    expect(html).toContain("Hidden automatically: reads a constant 0 inWC; the live reading is");
    expect(html).toContain(`href="${href.replace(/&/g, "&amp;")}"`);
    expect(html).toContain("CEI_AHU_7/DA_SAP");

    // The live point itself loads.
    const liveExplorer = await getPointExplorer(viewer, { pointId: liveId("AHU_7", "DA_SAP") });
    expect(liveExplorer.selectedPoint?.pointId).toBe(liveId("AHU_7", "DA_SAP").toString());
    expect(liveExplorer.hiddenDuplicate).toBeNull();

    // Hidden by a person: the red refusal, as before.
    await setVisible(id("CEI_JCI_N2:V4_22/SpaceTemp"), false);
    await expect(getPointExplorer(viewer, { pointId: id("CEI_JCI_N2:V4_22/SpaceTemp") })).rejects.toThrow(HIDDEN_POINT_MESSAGE);
  }, 120_000);

  it("the report leaves them out and counts them in one line, apart from the points a person hid", async () => {
    await runDuplicatePass();
    await setVisible(id("CEI_JCI_N2:V4_22/SpaceTemp"), false);
    const now = Date.now();
    const scope = await resolveScope(
      { site: { siteId: cei.siteId, name: "ZZTEST CEI", timezone: "America/New_York" }, stationIds: [] } as unknown as DefinitionForRun,
      { start: now - 86_400_000, end: now },
    );
    const inScope = new Set(scope.points.map((p) => p.pointId));
    for (const { copy } of NUMERIC_COPIES) expect(inScope.has(copyId(copy).toString()), copy).toBe(false);
    expect(scope.duplicateCopiesByStation.get(cei.jaceId.toString())).toBe(NUMERIC_COPIES.length);
    expect(scope.hiddenByStation.get(cei.jaceId.toString())).toBe(1);

    expect(duplicateCopiesLine([{ stationName: "CEI_JCI_N2", count: 12 }])).toBe(
      "12 points on CEI_JCI_N2 were hidden automatically as dead copies of live points on another station and left out of this report; they are still collected.",
    );
    expect(duplicateCopiesLine([{ stationName: "CEI_JCI_N2", count: 1 }])).toBe(
      "1 point on CEI_JCI_N2 was hidden automatically as a dead copy of a live point on another station and left out of this report; it is still collected.",
    );
    expect(duplicateCopiesLine([{ stationName: "A", count: 2 }, { stationName: "B", count: 1 }])).toBe(
      "3 points (2 on A, 1 on B) were hidden automatically as dead copies of live points on another station and left out of this report; they are still collected.",
    );
    expect(duplicateCopiesLine([])).toBeNull();
    expect(hiddenLine({ stationName: "CEI_JCI_N2", count: 1 })).toContain("hidden in Settings");

    const doc = reportDocument();
    const html = renderReportHtml({
      ...doc,
      inventory: { ...doc.inventory, duplicateCopies: [{ stationName: "CEI_JCI_N2", count: 12 }] },
    });
    expect(html).toContain("12 points on CEI_JCI_N2 were hidden automatically as dead copies");
    // A document stored before the line existed renders without it.
    expect(renderReportHtml(doc)).not.toContain("hidden automatically");
  }, 120_000);
});

// ---------------------------------------------------------------------------

describe("the migration's backfill", () => {
  it("marks every point a person hid, or ever showed or hid per the audit log, as manual, and nothing else", async () => {
    // The DO block from the migration itself, run over today's rows.
    const sql = readFileSync(path.join(process.cwd(), "prisma/migrations/20261123120000_bas_auto_hide_duplicate_copies/migration.sql"), "utf8");
    const start = sql.indexOf("DO $$");
    const block = sql.slice(start, sql.indexOf("END $$;", start) + "END $$;".length);
    expect(block).toContain("hidden_source = 'manual'");

    const hiddenByHand = copyId("AHU_7/MA_T");
    const shownAgain = copyId("AHU_7/OA_T");
    const untouched = copyId("AHU_7/DA_SAP");
    await testDb.basPoint.update({ where: { pointId: hiddenByHand }, data: { isVisible: false } });
    // Shown today, but a person hid and showed it: two audit rows, as the
    // B8.3 box and the bulk form write them.
    for (const visible of [false, true]) {
      await testDb.auditEvent.create({
        data: {
          action: "bas.point_visibility_changed",
          actorEmployeeId: employeeId,
          moduleKey: BAS_MODULE_KEY,
          metadata: { pointId: shownAgain.toString(), visible, collected: true },
        },
      });
    }
    // A malformed id in some old row must not break the cast.
    await testDb.auditEvent.create({
      data: { action: "bas.point_visibility_changed", actorEmployeeId: employeeId, moduleKey: BAS_MODULE_KEY, metadata: { pointId: "not-a-number" } },
    });
    await testDb.basPoint.updateMany({ where: { stationId: { in: [cei.jaceId, cei.ahu7Id, cei.ahu8Id] } }, data: { hiddenSource: null } });

    await testDb.$executeRawUnsafe(block);
    expect(await stateOf(hiddenByHand)).toMatchObject({ visible: false, source: "manual", reason: null });
    expect(await stateOf(shownAgain)).toMatchObject({ visible: true, source: "manual" });
    expect(await stateOf(untouched)).toMatchObject({ visible: true, source: null });
    expect(
      await testDb.basPoint.count({ where: { stationId: { in: [cei.jaceId, cei.ahu7Id, cei.ahu8Id] }, hiddenSource: "manual" } }),
    ).toBe(2);

    // And the pass then leaves both of them alone.
    await runDuplicatePass();
    expect(await stateOf(hiddenByHand)).toMatchObject({ visible: false, source: "manual", reason: null });
    expect(await stateOf(shownAgain)).toMatchObject({ visible: true, source: "manual" });
    expect(await stateOf(untouched)).toMatchObject({ visible: false, source: "auto", reason: "duplicate_copy" });
  }, 120_000);
});
