import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  parseWorkflowId,
  setWorkflowSteps,
  updateWorkflow,
} from "@/lib/modules/cost-intelligence/workflows";
import { createEmployee, disconnectDb, resetDb, testDb } from "./db";

let actor: string;

beforeEach(async () => {
  await resetDb();
  actor = (await createEmployee()).id;
  await testDb.cipSkill.createMany({
    data: ["estimate", "takeoff", "review"].map((folderName) => ({
      name: `Skill ${folderName}`,
      description: "",
      version: 2,
      locationPath: `/skills/${folderName}`,
      folderName,
      lastModified: new Date(),
      lastSynced: new Date(),
    })),
  });
});
afterAll(disconnectDb);

async function create(name = "Bid prep"): Promise<string> {
  const result = await createWorkflow(actor, { name });
  if (!result.ok) throw new Error(result.message);
  return result.data.id;
}

const audits = (action: string) => testDb.auditEvent.findMany({ where: { action }, orderBy: [{ occurredAt: "asc" }, { id: "asc" }] });

describe("parseWorkflowId", () => {
  it("accepts positive whole numbers only", () => {
    expect(parseWorkflowId("42")).toBe(42n);
    for (const bad of ["0", "-1", "1.5", "abc", "01", ""]) expect(parseWorkflowId(bad)).toBeNull();
  });
});

describe("createWorkflow", () => {
  it("creates a draft with no steps, trims the name and writes one audit row", async () => {
    const result = await createWorkflow(actor, { name: "  Bid   prep ", description: "  " });
    expect(result.ok).toBe(true);
    const [wf] = await listWorkflows();
    expect(wf).toMatchObject({ name: "Bid prep", description: null, status: "draft", steps: [] });
    expect(await audits("cip.workflow_created")).toHaveLength(1);
  });

  it("rejects a blank or too long name", async () => {
    expect(await createWorkflow(actor, { name: "   " })).toMatchObject({ ok: false, code: "invalid_name" });
    expect(await createWorkflow(actor, { name: "x".repeat(121) })).toMatchObject({ ok: false, code: "invalid_name" });
  });

  it("treats names case-insensitively", async () => {
    await create("Bid prep");
    expect(await createWorkflow(actor, { name: "BID PREP" })).toMatchObject({ ok: false, code: "name_taken" });
    expect(await audits("cip.workflow_created")).toHaveLength(1);
  });
});

describe("setWorkflowSteps", () => {
  it("stores steps in the order given and reports missing skills", async () => {
    const id = await create();
    expect(await setWorkflowSteps(actor, id, ["review", "estimate"])).toEqual({ ok: true, data: { changed: true } });

    await testDb.cipSkill.delete({ where: { folderName: "review" } });
    const wf = await getWorkflow(id);
    expect(wf?.steps).toEqual([
      { position: 1, folderName: "review", name: null, version: null, missing: true },
      { position: 2, folderName: "estimate", name: "Skill estimate", version: 2, missing: false },
    ]);
  });

  it("rejects duplicates and unknown skills", async () => {
    const id = await create();
    expect(await setWorkflowSteps(actor, id, ["estimate", "estimate"])).toMatchObject({ code: "duplicate_skill" });
    expect(await setWorkflowSteps(actor, id, ["estimate", "nope"])).toMatchObject({ code: "unknown_skill" });
    expect((await getWorkflow(id))?.steps).toEqual([]);
  });

  it("does nothing when the order is unchanged", async () => {
    const id = await create();
    await setWorkflowSteps(actor, id, ["estimate", "takeoff"]);
    expect(await setWorkflowSteps(actor, id, ["estimate", "takeoff"])).toEqual({ ok: true, data: { changed: false } });
    expect(await audits("cip.workflow_steps_changed")).toHaveLength(1);
  });

  it("refuses to empty an active workflow", async () => {
    const id = await create();
    await setWorkflowSteps(actor, id, ["estimate"]);
    await updateWorkflow(actor, id, { status: "active" });
    expect(await setWorkflowSteps(actor, id, [])).toMatchObject({ code: "no_steps" });
  });

  it("returns not_found for an unknown id", async () => {
    expect(await setWorkflowSteps(actor, "999", ["estimate"])).toMatchObject({ code: "not_found" });
  });
});

describe("updateWorkflow", () => {
  it("needs at least one step and no missing skills to activate", async () => {
    const id = await create();
    expect(await updateWorkflow(actor, id, { status: "active" })).toMatchObject({ code: "no_steps" });

    await setWorkflowSteps(actor, id, ["takeoff"]);
    await testDb.cipSkill.delete({ where: { folderName: "takeoff" } });
    expect(await updateWorkflow(actor, id, { status: "active" })).toMatchObject({ code: "missing_skills" });
  });

  it("moves draft to active to paused to active, never back to draft", async () => {
    const id = await create();
    await setWorkflowSteps(actor, id, ["estimate"]);
    expect(await updateWorkflow(actor, id, { status: "paused" })).toMatchObject({ code: "invalid_status_change" });
    expect((await updateWorkflow(actor, id, { status: "active" })).ok).toBe(true);
    expect((await updateWorkflow(actor, id, { status: "paused" })).ok).toBe(true);
    expect(await updateWorkflow(actor, id, { status: "draft" })).toMatchObject({ code: "invalid_status_change" });
    expect((await updateWorkflow(actor, id, { status: "active" })).ok).toBe(true);

    const rows = await audits("cip.workflow_updated");
    expect(rows.map((r) => (r.metadata as { status: string }).status)).toEqual(["active", "paused", "active"]);
  });

  it("renames, rejects a taken name, and skips no-op patches", async () => {
    const id = await create("One");
    await create("Two");
    expect(await updateWorkflow(actor, id, { name: "two" })).toMatchObject({ code: "name_taken" });
    expect(await updateWorkflow(actor, id, { name: " One ", description: "" })).toEqual({
      ok: true,
      data: { changed: false },
    });
    expect(await updateWorkflow(actor, id, { name: "Uno" })).toEqual({ ok: true, data: { changed: true } });

    const [row] = await audits("cip.workflow_updated");
    expect(row?.metadata).toMatchObject({ name: "Uno", previousName: "One" });
  });
});

describe("deleteWorkflow", () => {
  it("deletes drafts with their steps", async () => {
    const id = await create();
    await setWorkflowSteps(actor, id, ["estimate"]);
    expect(await deleteWorkflow(actor, id)).toEqual({ ok: true, data: { deleted: true } });
    expect(await testDb.cipWorkflowStep.count()).toBe(0);
    expect(await audits("cip.workflow_deleted")).toHaveLength(1);
  });

  it("refuses anything that is not a draft", async () => {
    const id = await create();
    await setWorkflowSteps(actor, id, ["estimate"]);
    await updateWorkflow(actor, id, { status: "active" });
    expect(await deleteWorkflow(actor, id)).toMatchObject({ code: "not_draft" });
    expect(await getWorkflow(id)).not.toBeNull();
  });
});
