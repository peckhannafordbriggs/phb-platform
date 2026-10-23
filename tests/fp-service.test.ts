import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { FREEZE_PROTECTION_MODULE_KEY } from "@/lib/modules/freeze-protection/constants";
import { addEquipment, deleteEquipment, updateEquipment } from "@/lib/modules/freeze-protection/equipment";
import {
  addBuilding,
  createProject,
  deleteBuilding,
  deleteProject,
  listProjects,
  updateProject,
} from "@/lib/modules/freeze-protection/projects";
import {
  createVerification,
  getRegister,
  getVerification,
  signVerification,
  updateResult,
} from "@/lib/modules/freeze-protection/verifications";
import { createEmployee, disconnectDb, resetDb, testDb } from "./db";

/**
 * The service against the real test database. Each rule here is one the
 * screens rely on and the database alone would not explain.
 */

let pm: string;
let engineer: string;

beforeEach(async () => {
  await resetDb();
  await testDb.module.create({
    data: { key: FREEZE_PROTECTION_MODULE_KEY, displayName: "Freeze Protection", sortOrder: 500 },
  });
  pm = (await createEmployee()).id;
  engineer = (await createEmployee()).id;
});
afterAll(disconnectDb);

async function project(buildings = ["Main"]) {
  const r = await createProject(pm, { jobNumber: "26-104A", name: "Riverside MOB", buildings });
  if (!r.ok) throw new Error(r.message);
  return r.data;
}

async function unit(buildingId: string, tag = "AHU-1", coil: "water" | null = "water") {
  const r = await addEquipment(pm, { buildingId, tag, coil });
  if (!r.ok) throw new Error(r.message);
  return r.data;
}

async function round(projectId: string, date = "2026-10-22") {
  const r = await createVerification(pm, projectId, date);
  if (!r.ok) throw new Error(r.message);
  return r.data;
}

describe("projects and buildings", () => {
  it("creates a project with its buildings and one audit row", async () => {
    const p = await project(["Main", "Annex"]);
    expect(p.buildings.map((b) => b.name)).toEqual(["Main", "Annex"]);
    expect(await testDb.auditEvent.count({ where: { action: "fp.project_created" } })).toBe(1);
  });

  it("refuses a job number already in use, ignoring case", async () => {
    await project();
    const r = await createProject(pm, { jobNumber: "26-104a", name: "Other", buildings: ["Main"] });
    expect(r).toMatchObject({ ok: false, code: "job_number_taken" });
  });

  it("refuses two buildings with the same name", async () => {
    const r = await createProject(pm, { jobNumber: "26-1", name: "X", buildings: ["Main", "main"] });
    expect(r).toMatchObject({ ok: false, code: "building_name_taken" });
  });

  it("records the previous values when a project is renamed", async () => {
    const p = await project();
    await updateProject(pm, p.id, { name: "Riverside Medical" });
    const row = await testDb.auditEvent.findFirstOrThrow({ where: { action: "fp.project_updated" } });
    expect(row.metadata).toMatchObject({ previousName: "Riverside MOB", name: "Riverside Medical" });
  });

  it("refuses to remove a building that holds equipment, or the last building", async () => {
    const p = await project(["Main", "Annex"]);
    await unit(p.buildings[0]!.id);
    expect(await deleteBuilding(pm, p.buildings[0]!.id)).toMatchObject({ ok: false, code: "building_not_empty" });
    expect((await deleteBuilding(pm, p.buildings[1]!.id)).ok).toBe(true);
  });

  it("adds a building, refusing a name the project already has", async () => {
    const p = await project();
    const r = await addBuilding(pm, p.id, "Annex");
    expect(r.ok && r.data.buildings.map((b) => b.name)).toEqual(["Main", "Annex"]);
    expect(await addBuilding(pm, p.id, "MAIN")).toMatchObject({ ok: false, code: "building_name_taken" });
  });

  it("keeps the last building", async () => {
    const r = await createProject(pm, { jobNumber: "26-2", name: "Y", buildings: ["Only"] });
    if (!r.ok) throw new Error();
    expect(await deleteBuilding(pm, r.data.buildings[0]!.id)).toMatchObject({ ok: false, code: "last_building" });
  });

  it("deleting a project removes everything in it", async () => {
    const p = await project();
    await unit(p.buildings[0]!.id);
    await round(p.id);
    expect((await deleteProject(pm, p.id)).ok).toBe(true);
    expect(await testDb.fpResult.count()).toBe(0);
    expect(await testDb.fpEquipment.count()).toBe(0);
    expect(await listProjects()).toEqual([]);
  });
});

describe("equipment", () => {
  it("allows the same tag in two buildings, not twice in one", async () => {
    const p = await project(["Main", "Annex"]);
    await unit(p.buildings[0]!.id, "AHU-1");
    expect((await addEquipment(pm, { buildingId: p.buildings[1]!.id, tag: "AHU-1" })).ok).toBe(true);
    expect(await addEquipment(pm, { buildingId: p.buildings[0]!.id, tag: "ahu-1" })).toMatchObject({ ok: false, code: "tag_taken" });
  });

  it("joins only the newest round when added after rounds exist", async () => {
    const p = await project();
    await unit(p.buildings[0]!.id, "AHU-1");
    const older = await round(p.id, "2025-11-01");
    const newer = await round(p.id, "2026-10-22");
    await unit(p.buildings[0]!.id, "AHU-2");
    expect((await getRegister(older.id)).map((l) => l.tag)).toEqual(["AHU-1"]);
    expect((await getRegister(newer.id)).map((l) => l.tag)).toEqual(["AHU-1", "AHU-2"]);
  });

  it("will not move a unit to another project's building", async () => {
    const p = await project();
    const other = await createProject(pm, { jobNumber: "26-9", name: "Other", buildings: ["B"] });
    if (!other.ok) throw new Error();
    const e = await unit(p.buildings[0]!.id);
    expect(await updateEquipment(pm, e.id, { buildingId: other.data.buildings[0]!.id })).toMatchObject({ ok: false, code: "invalid" });
  });

  it("removing a unit removes its results and says how many rounds it was in", async () => {
    const p = await project();
    const e = await unit(p.buildings[0]!.id);
    await round(p.id, "2025-11-01");
    await round(p.id, "2026-10-22");
    await deleteEquipment(pm, e.id);
    expect(await testDb.fpResult.count()).toBe(0);
    const row = await testDb.auditEvent.findFirstOrThrow({ where: { action: "fp.equipment_deleted" } });
    expect(row.metadata).toMatchObject({ tag: "AHU-1", rounds: 2 });
  });
});

describe("verification rounds", () => {
  it("gives every unit a result in a new round", async () => {
    const p = await project(["Main", "Annex"]);
    await unit(p.buildings[0]!.id, "AHU-1");
    await unit(p.buildings[1]!.id, "RTU-1");
    const v = await round(p.id);
    const lines = await getRegister(v.id);
    expect(lines.map((l) => `${l.buildingName} ${l.tag}`)).toEqual(["Main AHU-1", "Annex RTU-1"]);
  });

  it("carries status, exposure and protection forward, and not this round's evidence", async () => {
    const p = await project();
    await unit(p.buildings[0]!.id);
    const first = await round(p.id, "2025-11-01");
    const [line] = await getRegister(first.id);
    await updateResult(pm, line!.resultId, {
      status: "filled",
      exposure: "yes",
      protection: "manual",
      testFanStops: "yes",
      testedBy: "C. Moreno",
      documentedWith: "owner",
    });
    const second = await round(p.id, "2026-10-22");
    const [next] = await getRegister(second.id);
    expect(next).toMatchObject({ status: "filled", exposure: "yes", protection: "manual" });
    expect(next!.test.answers).toEqual({});
    expect(next!.test.testedBy).toBeNull();
    expect(next!.documentation).toBeNull();
  });

  it("stores date-only values without shifting the day", async () => {
    const p = await project();
    await unit(p.buildings[0]!.id);
    const v = await round(p.id, "2026-11-01");
    const [line] = await getRegister(v.id);
    const r = await updateResult(pm, line!.resultId, { testDate: "2026-11-01" });
    expect(r.ok && r.data.test.testDate).toBe("2026-11-01");
    expect((await getVerification(v.id))!.verificationDate).toBe("2026-11-01");
  });

  it("audits each saved field's before and after, with the disposition after", async () => {
    const p = await project();
    await unit(p.buildings[0]!.id);
    const v = await round(p.id);
    const [line] = await getRegister(v.id);
    await updateResult(pm, line!.resultId, { exposure: "no" });
    const row = await testDb.auditEvent.findFirstOrThrow({ where: { action: "fp.result_updated" } });
    expect(row.metadata).toMatchObject({
      tag: "AHU-1",
      changes: { exposure: { from: null, to: "no" } },
      disposition: "closed_no_exposure",
    });
  });

  it("writes nothing when a save changes nothing", async () => {
    const p = await project();
    await unit(p.buildings[0]!.id);
    const v = await round(p.id);
    const [line] = await getRegister(v.id);
    await updateResult(pm, line!.resultId, { status: "service", notes: "   " });
    expect(await testDb.auditEvent.count({ where: { action: "fp.result_updated" } })).toBe(0);
  });
});

describe("step 7 signoff", () => {
  async function completedRound() {
    const p = await project();
    await unit(p.buildings[0]!.id);
    const v = await round(p.id);
    const [line] = await getRegister(v.id);
    await updateResult(pm, line!.resultId, { exposure: "no" });
    const r = await signVerification(pm, v.id, "completed", true);
    if (!r.ok) throw new Error(r.message);
    return { v, line: line! };
  }

  it("records the signed-in employee, not a typed name", async () => {
    const { v } = await completedRound();
    const after = await getVerification(v.id);
    expect(after!.completed?.employeeId).toBe(pm);
  });

  it("refuses a review before completion", async () => {
    const p = await project();
    const v = await round(p.id);
    expect(await signVerification(engineer, v.id, "reviewed", true)).toMatchObject({ ok: false, code: "not_completed" });
  });

  it("refuses the person who completed it as reviewer", async () => {
    const { v } = await completedRound();
    expect(await signVerification(pm, v.id, "reviewed", true)).toMatchObject({ ok: false, code: "self_review" });
  });

  it("refuses a reviewer who recorded results in the round", async () => {
    const { v, line } = await completedRound();
    await updateResult(engineer, line.resultId, { notes: "Walked the unit" });
    expect(await signVerification(engineer, v.id, "reviewed", true)).toMatchObject({ ok: false, code: "self_review" });
  });

  it("accepts a different engineer, and flags a change made after the review", async () => {
    const { v, line } = await completedRound();
    expect((await signVerification(engineer, v.id, "reviewed", true)).ok).toBe(true);
    expect((await getVerification(v.id))!.changedAfterReview).toBe(false);

    await new Promise((r) => setTimeout(r, 5));
    await updateResult(pm, line.resultId, { notes: "Rechecked" });
    expect((await getVerification(v.id))!.changedAfterReview).toBe(true);
  });

  it("flags a coil change on the unit after the review", async () => {
    const { v, line } = await completedRound();
    await signVerification(engineer, v.id, "reviewed", true);
    await new Promise((r) => setTimeout(r, 5));
    await updateEquipment(pm, line.id, { coil: "glycol" });
    expect((await getVerification(v.id))!.changedAfterReview).toBe(true);
  });

  it("removing the completion removes the review with it", async () => {
    const { v } = await completedRound();
    await signVerification(engineer, v.id, "reviewed", true);
    await signVerification(pm, v.id, "completed", false);
    const after = await getVerification(v.id);
    expect(after!.completed).toBeNull();
    expect(after!.reviewed).toBeNull();
  });
});
