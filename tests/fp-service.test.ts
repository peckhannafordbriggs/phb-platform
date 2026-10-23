import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { FREEZE_PROTECTION_MODULE_KEY } from "@/lib/modules/freeze-protection/constants";
import { addEquipment, deleteEquipment, getHistory, listEquipment, updateEquipment } from "@/lib/modules/freeze-protection/equipment";
import { createProject, deleteProject, getProject, listProjects, signProject, updateProject } from "@/lib/modules/freeze-protection/projects";
import { createEmployee, disconnectDb, resetDb, testDb } from "./db";

/**
 * The service against the real test database. Each rule here is one the
 * screens rely on and the database alone would not explain.
 */

let pm: string;
let engineer: string;

beforeEach(async () => {
  await resetDb();
  await testDb.module.create({ data: { key: FREEZE_PROTECTION_MODULE_KEY, displayName: "Freeze Protection", sortOrder: 500 } });
  pm = (await createEmployee()).id;
  engineer = (await createEmployee()).id;
});
afterAll(disconnectDb);

async function project(jobNumber = "26-104A") {
  const r = await createProject(pm, { jobNumber, name: "Riverside MOB", verificationDate: "2026-11-01" });
  if (!r.ok) throw new Error(r.message);
  return r.data;
}

async function unit(projectId: string, name = "AHU-1") {
  const r = await addEquipment(pm, { projectId, name, coil: "water" });
  if (!r.ok) throw new Error(r.message);
  return r.data;
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("projects", () => {
  it("creates a project with its verification date and one audit row", async () => {
    const p = await project();
    expect(p.verificationDate).toBe("2026-11-01");
    expect(p.completed).toBeNull();
    expect(await testDb.auditEvent.count({ where: { action: "fp.project_created" } })).toBe(1);
  });

  it("defaults the verification date to today", async () => {
    const r = await createProject(pm, { jobNumber: "26-2", name: "X" });
    expect(r.ok && /^\d{4}-\d{2}-\d{2}$/.test(r.data.verificationDate)).toBe(true);
  });

  it("refuses a job number already in use, ignoring case", async () => {
    await project();
    expect(await createProject(pm, { jobNumber: "26-104a", name: "Other" })).toMatchObject({ ok: false, code: "job_number_taken" });
  });

  it("audits identity and verification changes as separate actions", async () => {
    const p = await project();
    await updateProject(pm, p.id, { name: "Riverside Medical", verificationDate: "2026-11-02" });
    const identity = await testDb.auditEvent.findFirstOrThrow({ where: { action: "fp.project_updated" } });
    expect(identity.metadata).toMatchObject({ previousName: "Riverside MOB", name: "Riverside Medical" });
    const verification = await testDb.auditEvent.findFirstOrThrow({ where: { action: "fp.verification_updated" } });
    expect(verification.metadata).toMatchObject({ changes: { verificationDate: { from: "2026-11-01", to: "2026-11-02" } } });
  });

  it("stores date-only values without shifting the day", async () => {
    const p = await project();
    await updateProject(pm, p.id, { transmittedDate: "2026-11-01" });
    expect((await getProject(p.id))!.transmittedDate).toBe("2026-11-01");
  });

  it("deleting a project removes its equipment", async () => {
    const p = await project();
    await unit(p.id);
    expect((await deleteProject(pm, p.id)).ok).toBe(true);
    expect(await testDb.fpEquipment.count()).toBe(0);
    expect(await listProjects()).toEqual([]);
  });
});

describe("equipment", () => {
  it("needs only a name; type and area served are optional", async () => {
    const p = await project();
    const r = await addEquipment(pm, { projectId: p.id, name: "EF-1" });
    expect(r.ok && r.data).toMatchObject({ name: "EF-1", equipmentType: null, areaServed: null, status: "service" });
    expect(await addEquipment(pm, { projectId: p.id, name: "   " })).toMatchObject({ ok: false, code: "invalid" });
  });

  it("refuses a name already on the project, ignoring case; another project may reuse it", async () => {
    const p = await project();
    await unit(p.id, "AHU-1");
    expect(await addEquipment(pm, { projectId: p.id, name: "ahu-1" })).toMatchObject({ ok: false, code: "name_taken" });
    const other = await project("26-9");
    expect((await addEquipment(pm, { projectId: other.id, name: "AHU-1" })).ok).toBe(true);
  });

  it("lists in schedule order, AHU-2 before AHU-10", async () => {
    const p = await project();
    await unit(p.id, "AHU-10");
    await unit(p.id, "AHU-2");
    await testDb.fpEquipment.updateMany({ data: { sortOrder: 0 } });
    expect((await listEquipment(p.id)).map((l) => l.name)).toEqual(["AHU-2", "AHU-10"]);
  });

  it("audits a schedule fix and a recorded result as different actions", async () => {
    const p = await project();
    const e = await unit(p.id);
    await updateEquipment(pm, e.id, { areaServed: "Level 2", exposure: "no" });
    const schedule = await testDb.auditEvent.findFirstOrThrow({ where: { action: "fp.equipment_updated" } });
    expect(schedule.metadata).toMatchObject({ name: "AHU-1", changes: { areaServed: { from: null, to: "Level 2" } } });
    const result = await testDb.auditEvent.findFirstOrThrow({ where: { action: "fp.result_updated" } });
    expect(result.metadata).toMatchObject({ changes: { exposure: { from: null, to: "no" } }, disposition: "closed_no_exposure" });
  });

  it("writes nothing when a save changes nothing", async () => {
    const p = await project();
    const e = await unit(p.id);
    await updateEquipment(pm, e.id, { status: "service", notes: "   " });
    expect(await testDb.auditEvent.count({ where: { action: { in: ["fp.equipment_updated", "fp.result_updated"] } } })).toBe(0);
  });

  it("stores a test date without shifting the day", async () => {
    const p = await project();
    const e = await unit(p.id);
    const r = await updateEquipment(pm, e.id, { testDate: "2026-11-01" });
    expect(r.ok && r.data.test.testDate).toBe("2026-11-01");
  });

  it("removing a unit removes its results; its history survives in the audit log", async () => {
    const p = await project();
    const e = await unit(p.id);
    await updateEquipment(pm, e.id, { exposure: "yes" });
    await deleteEquipment(pm, e.id);
    expect(await testDb.fpEquipment.count()).toBe(0);
    expect((await getHistory(e.id)).length).toBe(3);
  });
});

describe("history", () => {
  it("is every change to the unit, newest first, with who and when", async () => {
    const p = await project();
    const e = await unit(p.id);
    await tick();
    await updateEquipment(engineer, e.id, { exposure: "yes" });
    const history = await getHistory(e.id);
    expect(history).toHaveLength(2);
    expect(history[0]!.sentence).toContain("recorded outside air exposure for AHU-1 on job 26-104A");
    expect(history[1]!.sentence).toContain("added AHU-1 to the job 26-104A register");
    expect(new Date(history[0]!.at) >= new Date(history[1]!.at)).toBe(true);
  });

  it("belongs to one unit only", async () => {
    const p = await project();
    const a = await unit(p.id, "AHU-1");
    const b = await unit(p.id, "AHU-2");
    await updateEquipment(pm, b.id, { exposure: "no" });
    expect((await getHistory(a.id)).every((h) => h.sentence.includes("AHU-1"))).toBe(true);
  });
});

describe("step 7 signoff", () => {
  async function completed() {
    const p = await project();
    const e = await unit(p.id);
    await updateEquipment(pm, e.id, { exposure: "no" });
    const r = await signProject(pm, p.id, "completed", true);
    if (!r.ok) throw new Error(r.message);
    return { p, e };
  }

  it("records the signed-in employee", async () => {
    const { p } = await completed();
    expect((await getProject(p.id))!.completed?.employeeId).toBe(pm);
  });

  it("refuses a review before completion", async () => {
    const p = await project();
    expect(await signProject(engineer, p.id, "reviewed", true)).toMatchObject({ ok: false, code: "not_completed" });
  });

  it("refuses the person who completed it as reviewer", async () => {
    const { p } = await completed();
    expect(await signProject(pm, p.id, "reviewed", true)).toMatchObject({ ok: false, code: "self_review" });
  });

  it("refuses a reviewer who recorded any result on the project, not only the last", async () => {
    const { p, e } = await completed();
    await updateEquipment(engineer, e.id, { protection: "manual" });
    await updateEquipment(pm, e.id, { protection: "auto" });
    expect(await signProject(engineer, p.id, "reviewed", true)).toMatchObject({ ok: false, code: "self_review" });
  });

  it("does not count a schedule fix as recording results", async () => {
    const { p, e } = await completed();
    await updateEquipment(engineer, e.id, { areaServed: "Level 2" });
    expect((await signProject(engineer, p.id, "reviewed", true)).ok).toBe(true);
  });

  it("flags a unit added, changed or removed after the review; signoff and transmittal do not", async () => {
    const { p, e } = await completed();
    await signProject(engineer, p.id, "reviewed", true);
    await tick();
    await updateProject(pm, p.id, { transmittedTo: "Turner CM" });
    expect((await getProject(p.id))!.changedAfterReview).toBe(false);
    await updateEquipment(pm, e.id, { notes: "Rechecked" });
    expect((await getProject(p.id))!.changedAfterReview).toBe(true);
  });

  it("flags a unit removed after the review", async () => {
    const { p, e } = await completed();
    await signProject(engineer, p.id, "reviewed", true);
    await tick();
    await deleteEquipment(pm, e.id);
    expect((await getProject(p.id))!.changedAfterReview).toBe(true);
  });

  it("removing the completion removes the review with it", async () => {
    const { p } = await completed();
    await signProject(engineer, p.id, "reviewed", true);
    await signProject(pm, p.id, "completed", false);
    const after = await getProject(p.id);
    expect(after!.completed).toBeNull();
    expect(after!.reviewed).toBeNull();
  });
});
