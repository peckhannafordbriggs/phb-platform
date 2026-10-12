import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Only the session is mocked. The guards and the service are real.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { POST as create } from "@/app/api/modules/cost-intelligence/runs/route";
import { POST as act } from "@/app/api/modules/cost-intelligence/runs/[id]/route";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import {
  RUN_BUDGET_USD,
  answerCheckpoint,
  cancelRun,
  createRun,
  getRun,
  listLaunchOptions,
  listRuns,
} from "@/lib/modules/cost-intelligence/runs";
import { createEmployee, disconnectDb, grantModule, grantModuleAdmin, resetDb, testDb } from "./db";

const authMock = vi.mocked(auth);
let actor: string;
let workflowId: string;
let projectId: string;

async function skill(folderName: string) {
  await testDb.cipSkill.create({
    data: {
      name: `Skill ${folderName}`,
      description: "",
      version: 3,
      locationPath: `/skills/${folderName}`,
      folderName,
      lastModified: new Date(),
      lastSynced: new Date(),
    },
  });
}

async function project(folderName: string, removedAt: Date | null = null) {
  const row = await testDb.cipProject.create({
    data: {
      folderName,
      locationPath: `/bid-doc/${folderName}`,
      fileCount: 1,
      totalBytes: 1n,
      lastSynced: new Date(),
      removedAt,
    },
  });
  return row.id.toString();
}

async function workflow(status: string, steps: string[]) {
  const row = await testDb.cipWorkflow.create({
    data: {
      name: `Flow ${status} ${steps.join(",")}`,
      status,
      steps: { create: steps.map((skillFolderName, i) => ({ position: i + 1, skillFolderName })) },
    },
  });
  return row.id.toString();
}

/** Put a run in `waiting` with an open question, as the worker will. */
async function ask(runId: string, question = "Which phase?", options = ["Phase 1", "Phase 2"]) {
  await testDb.cipRun.update({ where: { id: BigInt(runId) }, data: { status: "waiting" } });
  await testDb.cipRunCheckpoint.create({ data: { runId: BigInt(runId), step: 0, question, options } });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await resetDb();
  actor = (await createEmployee()).id;
  await skill("phb-a");
  await skill("phb-b");
  workflowId = await workflow("active", ["phb-b", "phb-a"]);
  projectId = await project("Mercy Rookwood AHU");
});
afterEach(() => vi.restoreAllMocks());
afterAll(disconnectDb);

describe("createRun", () => {
  it("queues a run with the workflow's steps copied, the budget, a ledger line and an audit row", async () => {
    const result = await createRun(actor, { workflowId, projectId });
    if (!result.ok) throw new Error(result.message);

    const run = await testDb.cipRun.findUniqueOrThrow({ where: { id: BigInt(result.data.id) } });
    expect(run).toMatchObject({ status: "queued", startedById: actor, currentStep: 0 });
    expect(Number(run.budgetUsd)).toBe(RUN_BUDGET_USD);
    expect(run.steps).toEqual([
      { folderName: "phb-b", name: "Skill phb-b", version: 3 },
      { folderName: "phb-a", name: "Skill phb-a", version: 3 },
    ]);
    expect(await testDb.cipRunEvent.count({ where: { runId: run.id, type: "queued" } })).toBe(1);
    expect(await testDb.auditEvent.count({ where: { action: "cip.run_started" } })).toBe(1);
  });

  it("keeps the copied steps when the workflow changes later", async () => {
    const result = await createRun(actor, { workflowId, projectId });
    if (!result.ok) throw new Error(result.message);
    await testDb.cipWorkflowStep.deleteMany({ where: { workflowId: BigInt(workflowId) } });
    expect((await getRun(result.data.id))?.steps.map((s) => s.folderName)).toEqual(["phb-b", "phb-a"]);
  });

  it("refuses draft or paused workflows, and ones with missing skills", async () => {
    const draft = await workflow("draft", ["phb-a"]);
    const paused = await workflow("paused", ["phb-a"]);
    const broken = await workflow("active", ["phb-gone"]);
    for (const id of [draft, paused, broken, "999"]) {
      expect(await createRun(actor, { workflowId: id, projectId })).toMatchObject({ code: "workflow_not_runnable" });
    }
  });

  it("refuses removed or unknown projects", async () => {
    const gone = await project("Gone", new Date());
    for (const id of [gone, "999", "x"]) {
      expect(await createRun(actor, { workflowId, projectId: id })).toMatchObject({ code: "project_not_found" });
    }
  });

  it("allows one active run per project, and another once it is finished", async () => {
    const first = await createRun(actor, { workflowId, projectId });
    if (!first.ok) throw new Error(first.message);
    expect(await createRun(actor, { workflowId, projectId })).toMatchObject({ code: "project_busy" });

    const other = await project("Other job");
    expect((await createRun(actor, { workflowId, projectId: other })).ok).toBe(true);

    await cancelRun(actor, first.data.id);
    expect((await createRun(actor, { workflowId, projectId })).ok).toBe(true);
  });
});

describe("cancelRun", () => {
  it("cancels an active run, drops its open question, and refuses a finished one", async () => {
    const result = await createRun(actor, { workflowId, projectId });
    if (!result.ok) throw new Error(result.message);
    await ask(result.data.id);

    expect(await cancelRun(actor, result.data.id)).toEqual({ ok: true, data: { cancelled: true } });
    expect((await getRun(result.data.id))?.status).toBe("cancelled");
    expect(await testDb.cipRunCheckpoint.count()).toBe(0);
    expect(await cancelRun(actor, result.data.id)).toMatchObject({ code: "not_cancellable" });
    expect(await cancelRun(actor, "999")).toMatchObject({ code: "not_found" });
  });
});

describe("answerCheckpoint", () => {
  it("records the answer and who gave it, and puts the run back in the queue", async () => {
    const result = await createRun(actor, { workflowId, projectId });
    if (!result.ok) throw new Error(result.message);
    await ask(result.data.id);
    expect((await getRun(result.data.id))?.checkpoint).toMatchObject({ question: "Which phase?", options: ["Phase 1", "Phase 2"] });

    expect(await answerCheckpoint(actor, result.data.id, "  Phase 2 ")).toEqual({ ok: true, data: { resumed: true } });

    const run = await getRun(result.data.id);
    expect(run).toMatchObject({ status: "queued", checkpoint: null });
    expect(await testDb.cipRunCheckpoint.findFirstOrThrow()).toMatchObject({ answer: "Phase 2", answeredById: actor });
    expect(run?.events.at(-1)).toMatchObject({ type: "answered", message: "Phase 2" });
    expect(await testDb.auditEvent.count({ where: { action: "cip.checkpoint_answered" } })).toBe(1);
  });

  it("refuses an empty answer, or a run that is not waiting", async () => {
    const result = await createRun(actor, { workflowId, projectId });
    if (!result.ok) throw new Error(result.message);
    expect(await answerCheckpoint(actor, result.data.id, "x")).toMatchObject({ code: "no_open_checkpoint" });
    await ask(result.data.id);
    expect(await answerCheckpoint(actor, result.data.id, "   ")).toMatchObject({ code: "invalid_answer" });
  });
});

describe("reads", () => {
  it("lists runs newest first and offers only runnable workflows, with busy projects marked", async () => {
    await workflow("draft", ["phb-a"]);
    const result = await createRun(actor, { workflowId, projectId });
    if (!result.ok) throw new Error(result.message);
    await project("Another");

    expect((await listRuns()).map((r) => [r.projectName, r.status])).toEqual([["Mercy Rookwood AHU", "queued"]]);
    const options = await listLaunchOptions();
    expect(options.workflows.map((w) => w.value)).toEqual([workflowId]);
    expect(options.projects).toEqual([
      { value: expect.any(String), label: "Another", busy: false },
      { value: projectId, label: "Mercy Rookwood AHU", busy: true },
    ]);
  });

  it("shows steps done, current and pending from the run's position", async () => {
    const result = await createRun(actor, { workflowId, projectId });
    if (!result.ok) throw new Error(result.message);
    await testDb.cipRun.update({ where: { id: BigInt(result.data.id) }, data: { status: "running", currentStep: 1 } });
    expect((await getRun(result.data.id))?.steps.map((s) => s.state)).toEqual(["done", "current"]);
  });
});

describe("routes", () => {
  async function signIn(admin: boolean, grant = true) {
    await testDb.module.upsert({
      where: { key: COST_INTELLIGENCE_MODULE_KEY },
      create: { key: COST_INTELLIGENCE_MODULE_KEY, displayName: "Cost Intelligence", sortOrder: 300 },
      update: {},
    });
    const employee = await createEmployee();
    if (grant) await grantModule(employee.id, COST_INTELLIGENCE_MODULE_KEY);
    if (admin) await grantModuleAdmin(employee.id, COST_INTELLIGENCE_MODULE_KEY);
    authMock.mockResolvedValue({
      entraOid: employee.entraOid,
      issuedAt: Math.floor(Date.now() / 1000),
      user: {},
      expires: new Date(Date.now() + 3_600_000).toISOString(),
    } as unknown as Session as never);
    return employee;
  }
  const json = (body: unknown) =>
    new Request("http://localhost/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it("a Member (not only a PCE) can start, answer and cancel", async () => {
    const me = await signIn(false);

    const res = await create(json({ workflowId, projectId }));
    expect(res.status).toBe(201);
    const { id } = ((await res.json()) as { data: { id: string } }).data;
    expect(await testDb.cipRun.findFirstOrThrow()).toMatchObject({ startedById: me.id });

    await ask(id);
    expect((await act(json({ action: "answer", answer: "Phase 1" }), ctx(id))).status).toBe(200);
    expect((await act(json({ action: "cancel" }), ctx(id))).status).toBe(200);
  });

  it("404 without the module, 409 for a busy project, 422 for a bad body", async () => {
    await signIn(false, false);
    expect((await create(json({ workflowId, projectId }))).status).toBe(404);

    await signIn(false);
    expect((await create(json({ workflowId, projectId }))).status).toBe(201);
    const busy = await create(json({ workflowId, projectId }));
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: { code: "project_busy" } });
    expect((await create(json({ workflowId }))).status).toBe(422);
    expect((await act(json({ action: "pause" }), ctx("1"))).status).toBe(422);
  });
});
