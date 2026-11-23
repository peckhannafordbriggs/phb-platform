import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Nothing here signs in; the module graph reaches @/auth, which cannot load under vitest.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { describeAuditEvent } from "@/lib/admin/audit-describe";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { runAutoAssignPass } from "@/lib/modules/bas/auto-assign";
import { runDuplicatePass } from "@/lib/modules/bas/auto-hide";
import { seedBasVocabularies } from "../prisma/bas-vocabularies";
import { createCeiControllerFixture, type CeiControllerFixture } from "./bas-cei-fixture";
import { disconnectDb, resetDb, seedBasModule, seedChangeOrdersModule, testDb } from "./db";

/**
 * Dead copies paired by EQUIPMENT AND ROLE (2026-11-23), on CEI as
 * production holds it: CEI_JCI_N2's 334 names beside its three controllers'
 * real names, units and data types (docs/fixtures/cei-controller-point-names.txt).
 *
 * No name rule pairs these: the JACE's copy is `AHU_7/MA_T` and the
 * controller's point `AHU_7_Ma_Temp`. One scheduler pass gives both halves
 * the same equipment (the station rule) and the same role (the suffix
 * tokens), and the duplicate step after it pairs them on that - the numbers
 * for a measurement, the on/off rule for a fan status.
 */

const JACE_NAMES = readFileSync(path.join(process.cwd(), "docs/fixtures/cei-point-names.txt"), "utf8")
  .split(/\r?\n/)
  .filter((n) => n.length > 0);
const CONTROLLERS = readFileSync(path.join(process.cwd(), "docs/fixtures/cei-controller-point-names.txt"), "utf8")
  .split(/\r?\n/)
  .filter((n) => n.length > 0)
  .map((line) => {
    const [station, name, unit, dataType] = line.split("\t");
    return { station: station!, name: name!, unit: unit === "" ? null : unit!, dataType: dataType! };
  });

/**
 * The JACE copies the pass hides, each with the controller point it copies.
 * `AHU_7/OA_T` has two live partners on CEI_AHU_7 (`AHU_7_Oa_Temp` and
 * `AHU_07_Oa_Temp`) and takes one.
 */
const EXPECTED: Record<string, string[]> = {
  "AHU_7/DA_SAP": ["CEI_AHU_7:AHU_7_Da_Press"],
  "AHU_7/DA_T": ["CEI_AHU_7:AHU_7_Da_Temp"],
  "AHU_7/MA_T": ["CEI_AHU_7:AHU_7_Ma_Temp"],
  "AHU_7/OA_T": ["CEI_AHU_7:AHU_07_Oa_Temp", "CEI_AHU_7:AHU_7_Oa_Temp"],
  "AHU_7/RA_HUM": ["CEI_AHU_7:AHU_7_Ra_Rh"],
  "AHU_7/RA_T": ["CEI_AHU_7:AHU_7_Ra_Temp"],
  "AHU_7/RF_S": ["CEI_AHU_7:AHU_7_Ra_Fan_Sts"],
  "AHU_7/SF_S": ["CEI_AHU_7:AHU_7_Sa_Fan_Sts"],
  "AHU_8/OA_H": ["CEI_AHU_8:AHU_8_Oa_Rh"],
  "AHU_8/RA_HUM": ["CEI_AHU_8:AHU_8_Ra_Rh"],
};

let cei: CeiControllerFixture;
const id = (key: string) => {
  const found = cei.ids.get(key);
  if (found === undefined) throw new Error(`no point ${key}`);
  return found;
};
const nameOf = () => new Map([...cei.ids.entries()].map(([k, v]) => [v.toString(), k]));

/** The copies the platform hid, by name (the JACE's without its station), and what each copies. */
async function hidden(): Promise<Map<string, string | null>> {
  const names = nameOf();
  const rows = await testDb.basPoint.findMany({
    where: { stationId: { in: [...cei.stationIds.values()] }, isVisible: false, hiddenReason: "duplicate_copy" },
    select: { pointId: true, duplicateOfId: true, hiddenSource: true, isActive: true },
  });
  for (const r of rows) {
    // Still collected, and the platform's.
    expect(r, names.get(r.pointId.toString())).toMatchObject({ hiddenSource: "auto", isActive: true });
  }
  return new Map(
    rows.map((r) => [
      names.get(r.pointId.toString())!.replace(/^CEI_JCI_N2:/, ""),
      r.duplicateOfId === null ? null : names.get(r.duplicateOfId.toString())!,
    ]),
  );
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetBasAvailabilityCache();
  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();
  cei = await createCeiControllerFixture(JACE_NAMES, CONTROLLERS);
  await seedBasVocabularies(testDb);
});

afterEach(async () => {
  await cei.cleanup();
  await testDb.$executeRaw`UPDATE bas_point_roles SET setpoint_for = NULL, status_of = NULL`;
  await testDb.basPointRole.deleteMany();
  await testDb.basEquipmentType.deleteMany();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDb();
});

describe("CEI's real names through one scheduler pass", () => {
  it("hides the JACE's AHU copies as copies of their AHU_7 and AHU_8 partners, and nothing else", async () => {
    const pass = await runAutoAssignPass();
    expect(pass.failed).toEqual([]);
    expect(pass.duplicates.failed).toEqual([]);

    const now = await hidden();
    expect([...now.keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [copy, partners] of Object.entries(EXPECTED)) {
      expect(partners, copy).toContain(now.get(copy));
    }
    // One partner each: of CEI_AHU_7's two outside air temperatures, the one
    // the copy did not take is still shown, and nothing names it.
    // Both carry the same readings here, so the tie goes by id: the fixture
    // inserts the file's sorted order, AHU_07_Oa_Temp first.
    expect(now.get("AHU_7/OA_T")).toBe("CEI_AHU_7:AHU_07_Oa_Temp");
    const taken = now.get("AHU_7/OA_T")!;
    const other = EXPECTED["AHU_7/OA_T"]!.find((p) => p !== taken)!;
    expect(await testDb.basPoint.findUniqueOrThrow({ where: { pointId: id(other) }, select: { isVisible: true } })).toEqual({ isVisible: true });

    // Every controller point is still shown.
    const shownControllers = await testDb.basPoint.count({
      where: { stationId: { in: ["CEI_AHU_7", "CEI_AHU_8", "CEI_PLANT"].map((n) => cei.stationIds.get(n)!) }, isVisible: true },
    });
    expect(shownControllers).toBe(CONTROLLERS.filter((c) => c.station !== "CEI_JCI_N2").length);

    // Not hidden, and why: no live partner on the same equipment with the same role.
    for (const copy of ["AHU_7/OA_H", "AHU_7/OA_Enth", "AHU_7/RA_Enth", "AHU_8/RA_Enth"]) expect(now.has(copy), copy).toBe(false);

    const rows = await testDb.auditEvent.findMany({ where: { action: "bas.point_auto_hidden" } });
    expect(rows).toHaveLength(Object.keys(EXPECTED).length);
    const byName = new Map(rows.map((r) => [(r.metadata as { pointName: string }).pointName, r]));
    expect(byName.get("AHU_7/MA_T")!.metadata).toMatchObject({
      rule: "equipment_role",
      test: "numbers",
      role: "mixed_air_temp",
      equipmentName: "AHU_7",
      duplicateOf: { pointName: "AHU_7_Ma_Temp", stationName: "CEI_AHU_7", role: "mixed_air_temp" },
    });
    expect(byName.get("AHU_7/SF_S")!.metadata).toMatchObject({ rule: "equipment_role", test: "on_off", readings: { changes: 0 } });
    const sentence = (action: string, metadata: unknown) =>
      describeAuditEvent({ action, moduleKey: "bas", metadata: metadata as never, actor: null, target: null }).sentence;
    expect(sentence("bas.point_auto_hidden", byName.get("AHU_7/MA_T")!.metadata)).toBe(
      "The platform hid the point AHU_7/MA_T on CEI_JCI_N2 as a dead copy of AHU_7_Ma_Temp on CEI_AHU_7: it read 0 for 7 days while that point varied (still collected)",
    );
    expect(sentence("bas.point_auto_hidden", byName.get("AHU_7/SF_S")!.metadata)).toBe(
      "The platform hid the point AHU_7/SF_S on CEI_JCI_N2 as a dead copy of AHU_7_Sa_Fan_Sts on CEI_AHU_7: it did not change state for 7 days while that point did (still collected)",
    );

    // Settled: the next pass writes nothing.
    const audit = await testDb.auditEvent.count();
    expect((await runDuplicatePass()).changes).toEqual([]);
    expect(await testDb.auditEvent.count()).toBe(audit);
  }, 240_000);

  it("never hides a real AHU_8 sensor as a copy of AHU_7's, however flat it reads", async () => {
    // CEI_AHU_8 sits off for the week: its mixed air, return air and fan
    // status read one value, while AHU_7's carry on.
    for (const name of ["AHU_8_Ma_Temp", "AHU_8_Ra_Temp", "AHU_8_Da_Temp"]) await cei.setSeries(id(`CEI_AHU_8:${name}`), "flat");
    await cei.setSeries(id("CEI_AHU_8:AHU_8_Sa_Fan_Sts"), "bool_flat");

    await runAutoAssignPass();
    const now = await hidden();
    for (const name of ["AHU_8_Ma_Temp", "AHU_8_Ra_Temp", "AHU_8_Da_Temp", "AHU_8_Sa_Fan_Sts"]) {
      expect([...now.keys()], name).not.toContain(`CEI_AHU_8:${name}`);
    }
    // Nothing on CEI_AHU_8 is hidden at all, and no copy names an AHU_7 point as AHU_8's partner.
    expect([...now.keys()].some((k) => k.startsWith("CEI_AHU_8:"))).toBe(false);
    expect(now.get("AHU_8/RA_HUM")).toBe("CEI_AHU_8:AHU_8_Ra_Rh");
    expect(now.get("AHU_8/OA_H")).toBe("CEI_AHU_8:AHU_8_Oa_Rh");
  }, 240_000);

  it("swaps a fan status when the controller's goes quiet and the JACE's starts switching", async () => {
    await runAutoAssignPass();
    const copy = id("CEI_JCI_N2:AHU_7/SF_S");
    const live = id("CEI_AHU_7:AHU_7_Sa_Fan_Sts");
    expect((await hidden()).get("AHU_7/SF_S")).toBe("CEI_AHU_7:AHU_7_Sa_Fan_Sts");

    await cei.setSeries(copy, "bool_cycle");
    await cei.setSeries(live, "bool_flat");
    const pass = await runDuplicatePass();
    expect(pass.changes.map((c) => [c.kind, c.pointName, c.swap])).toEqual([
      ["shown", "AHU_7/SF_S", true],
      ["hidden", "AHU_7_Sa_Fan_Sts", true],
    ]);
  }, 240_000);

  it("leaves a copy a person set alone, hidden or shown", async () => {
    await testDb.basPoint.update({ where: { pointId: id("CEI_JCI_N2:AHU_7/MA_T") }, data: { hiddenSource: "manual" } });
    await testDb.basPoint.update({
      where: { pointId: id("CEI_JCI_N2:AHU_7/RA_T") },
      data: { hiddenSource: "manual", isVisible: false },
    });
    await runAutoAssignPass();
    const now = await hidden();
    // RA_T is hidden by a person (no reason), MA_T shown by a person: neither is the platform's.
    const ma = await testDb.basPoint.findUniqueOrThrow({ where: { pointId: id("CEI_JCI_N2:AHU_7/MA_T") } });
    const ra = await testDb.basPoint.findUniqueOrThrow({ where: { pointId: id("CEI_JCI_N2:AHU_7/RA_T") } });
    expect(ma).toMatchObject({ isVisible: true, hiddenSource: "manual", hiddenReason: null, duplicateOfId: null });
    expect(ra).toMatchObject({ isVisible: false, hiddenSource: "manual", hiddenReason: null, duplicateOfId: null });
    expect(now.has("AHU_7/MA_T")).toBe(false);
    expect(now.has("AHU_7/RA_T")).toBe(false);
    const rows = await testDb.auditEvent.findMany({ where: { action: "bas.point_auto_hidden" } });
    expect(rows.map((r) => (r.metadata as { pointName: string }).pointName)).not.toContain("AHU_7/MA_T");
    expect(rows.map((r) => (r.metadata as { pointName: string }).pointName)).not.toContain("AHU_7/RA_T");
    expect(rows).toHaveLength(Object.keys(EXPECTED).length - 2);
  }, 240_000);
});
