import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { COST_INTELLIGENCE_MODULE_KEY } from "./constants";
import { listProjects } from "./project-sync";
import { getWorkflow, listWorkflows, parseWorkflowId } from "./workflows";

/**
 * Runs: one workflow against one project. The run row is also the job: the
 * worker claims `queued` runs, so there is no separate queue table.
 *
 *   queued -> running -> succeeded | failed
 *                     -> waiting (a checkpoint) -> queued (answered) -> running ...
 *   queued | running | waiting -> cancelled
 *
 * The workflow's steps are copied onto the run when it starts, so editing a
 * workflow never changes a run already going. One active run per project
 * (cip_runs_one_active_per_project_key) so two runs never write the same
 * _revN into AI FILES.
 */

/** Overridable for a different model id; the SDK also accepts the alias "sonnet". */
export const RUN_MODEL = process.env.CIP_RUN_MODEL?.trim() || "claude-sonnet-5-5";
/** The run stops when Claude spend passes this. */
export const RUN_BUDGET_USD = 5;

export type RunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
export const ACTIVE_STATUSES: RunStatus[] = ["queued", "running", "waiting"];

export type RunErrorCode =
  | "not_found"
  | "workflow_not_runnable"
  | "project_not_found"
  | "project_busy"
  | "not_cancellable"
  | "no_open_checkpoint"
  | "invalid_answer";

export type RunResult<T> = { ok: true; data: T } | { ok: false; code: RunErrorCode; message: string };

/** The only place a run refusal becomes a status code. Read by the routes. */
export const RUN_ERROR_STATUS: Record<RunErrorCode, number> = {
  not_found: 404,
  workflow_not_runnable: 409,
  project_not_found: 404,
  project_busy: 409,
  not_cancellable: 409,
  no_open_checkpoint: 409,
  invalid_answer: 422,
};

/** One step as copied from the workflow when the run started. */
export type RunStepSnapshot = { folderName: string; name: string; version: number };

const fail = <T>(code: RunErrorCode, message: string): RunResult<T> => ({ ok: false, code, message });
const parseId = parseWorkflowId; // same rule: a positive whole number

export const ANSWER_MAX = 4000;

// ---------------------------------------------------------------------------
// Writes from the app
// ---------------------------------------------------------------------------

/** Queue a run of an Active workflow on a project. Any Cost Intelligence member may. */
export async function createRun(
  actorId: string,
  input: { workflowId: string; projectId: string },
): Promise<RunResult<{ id: string }>> {
  const workflow = await getWorkflow(input.workflowId);
  if (workflow === null) return fail("workflow_not_runnable", "That workflow no longer exists.");
  if (workflow.status !== "active") return fail("workflow_not_runnable", "Only active workflows can be run.");
  if (workflow.steps.length === 0 || workflow.steps.some((s) => s.missing)) {
    return fail("workflow_not_runnable", "This workflow has skills missing from the catalog. A PCE has to fix it first.");
  }

  const projectId = parseId(input.projectId);
  const project =
    projectId === null ? null : await prisma.cipProject.findFirst({ where: { id: projectId, removedAt: null } });
  if (project === null) return fail("project_not_found", "That project is not in BID-DOC any more.");

  const steps: RunStepSnapshot[] = workflow.steps.map((s) => ({
    folderName: s.folderName,
    name: s.name ?? s.folderName,
    version: s.version ?? 1,
  }));

  try {
    const id = await prisma.$transaction(async (tx) => {
      const run = await tx.cipRun.create({
        data: {
          workflowId: BigInt(workflow.id),
          workflowName: workflow.name,
          projectId: project.id,
          steps,
          model: RUN_MODEL,
          budgetUsd: RUN_BUDGET_USD,
          startedById: actorId,
        },
        select: { id: true },
      });
      await tx.cipRunEvent.create({
        data: { runId: run.id, type: "queued", message: `Queued ${workflow.name} on ${project.folderName}` },
      });
      await writeAuditEvent(tx, {
        action: "cip.run_started",
        actorEmployeeId: actorId,
        moduleKey: COST_INTELLIGENCE_MODULE_KEY,
        metadata: {
          runId: run.id.toString(),
          workflowId: workflow.id,
          workflowName: workflow.name,
          projectId: project.id.toString(),
          projectName: project.folderName,
        },
      });
      return run.id;
    });
    return { ok: true, data: { id: id.toString() } };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return fail("project_busy", `${project.folderName} already has a run going. Wait for it or cancel it.`);
    }
    throw error;
  }
}

/** Stop a run that has not finished. A running worker notices and stops at its next message. */
export async function cancelRun(actorId: string, rawId: string): Promise<RunResult<{ cancelled: true }>> {
  const id = parseId(rawId);
  if (id === null) return fail("not_found", "Run not found.");

  return prisma.$transaction(async (tx) => {
    const { count } = await tx.cipRun.updateMany({
      where: { id, status: { in: ACTIVE_STATUSES } },
      data: { status: "cancelled", finishedAt: new Date() },
    });
    if (count === 0) {
      const exists = await tx.cipRun.count({ where: { id } });
      return exists === 0 ? fail("not_found", "Run not found.") : fail("not_cancellable", "This run has already finished.");
    }
    // An open question goes with it.
    await tx.cipRunCheckpoint.deleteMany({ where: { runId: id, answeredAt: null } });
    await tx.cipRunEvent.create({ data: { runId: id, type: "cancelled", message: "Run cancelled" } });
    await writeAuditEvent(tx, {
      action: "cip.run_cancelled",
      actorEmployeeId: actorId,
      moduleKey: COST_INTELLIGENCE_MODULE_KEY,
      metadata: { runId: id.toString() },
    });
    return { ok: true as const, data: { cancelled: true as const } };
  });
}

/** Answer the run's open question and put it back in the queue to resume. */
export async function answerCheckpoint(
  actorId: string,
  rawId: string,
  rawAnswer: string,
): Promise<RunResult<{ resumed: true }>> {
  const id = parseId(rawId);
  if (id === null) return fail("not_found", "Run not found.");
  const answer = rawAnswer.trim();
  if (answer.length === 0) return fail("invalid_answer", "Pick or type an answer.");
  if (answer.length > ANSWER_MAX) return fail("invalid_answer", `Keep the answer to ${ANSWER_MAX} characters.`);

  return prisma.$transaction(async (tx) => {
    const checkpoint = await tx.cipRunCheckpoint.findFirst({
      where: { runId: id, answeredAt: null, run: { status: "waiting" } },
    });
    if (checkpoint === null) {
      const exists = await tx.cipRun.count({ where: { id } });
      return exists === 0
        ? fail("not_found", "Run not found.")
        : fail("no_open_checkpoint", "This run is not waiting on a question.");
    }
    const now = new Date();
    await tx.cipRunCheckpoint.update({
      where: { id: checkpoint.id },
      data: { answer, answeredById: actorId, answeredAt: now },
    });
    await tx.cipRun.update({ where: { id }, data: { status: "queued" } });
    await tx.cipRunEvent.create({
      data: { runId: id, step: checkpoint.step, type: "answered", message: answer, data: { checkpointId: checkpoint.id.toString() } },
    });
    await writeAuditEvent(tx, {
      action: "cip.checkpoint_answered",
      actorEmployeeId: actorId,
      moduleKey: COST_INTELLIGENCE_MODULE_KEY,
      metadata: { runId: id.toString(), checkpointId: checkpoint.id.toString(), question: checkpoint.question },
    });
    return { ok: true as const, data: { resumed: true as const } };
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type RunListItem = {
  id: string;
  workflowName: string;
  projectName: string;
  status: RunStatus;
  createdAt: Date;
  costUsd: number;
};

/** The newest runs first. */
export async function listRuns(limit = 200): Promise<RunListItem[]> {
  const rows = await prisma.cipRun.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { project: { select: { folderName: true } } },
  });
  return rows.map((r) => ({
    id: r.id.toString(),
    workflowName: r.workflowName,
    projectName: r.project.folderName,
    status: r.status as RunStatus,
    createdAt: r.createdAt,
    costUsd: Number(r.costUsd),
  }));
}

export type RunDetail = RunListItem & {
  model: string;
  budgetUsd: number;
  tokens: number;
  error: string | null;
  startedBy: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  steps: (RunStepSnapshot & { state: "done" | "current" | "pending" | "failed" })[];
  events: { id: string; at: Date; type: string; message: string; step: number | null }[];
  outputs: { path: string; at: Date }[];
  checkpoint: { id: string; question: string; options: string[]; step: number } | null;
};

/** One run with its ledger, or null. */
export async function getRun(rawId: string): Promise<RunDetail | null> {
  const id = parseId(rawId);
  if (id === null) return null;
  const run = await prisma.cipRun.findUnique({
    where: { id },
    include: {
      project: { select: { folderName: true } },
      startedBy: { select: { firstName: true, lastName: true, email: true } },
      // step_cost rows are the worker's cost bookkeeping, not ledger lines.
      events: { where: { type: { not: "step_cost" } }, orderBy: { id: "asc" } },
      checkpoints: { where: { answeredAt: null }, take: 1 },
    },
  });
  if (run === null) return null;

  const status = run.status as RunStatus;
  const snapshot = run.steps as RunStepSnapshot[];
  const open = run.checkpoints[0];

  return {
    id: run.id.toString(),
    workflowName: run.workflowName,
    projectName: run.project.folderName,
    status,
    createdAt: run.createdAt,
    costUsd: Number(run.costUsd),
    model: run.model,
    budgetUsd: Number(run.budgetUsd),
    tokens: Number(run.inputTokens + run.outputTokens),
    error: run.error,
    startedBy: run.startedBy
      ? `${run.startedBy.firstName} ${run.startedBy.lastName}`.trim() || run.startedBy.email
      : null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    steps: snapshot.map((s, i) => ({
      ...s,
      state:
        status === "succeeded" || i < run.currentStep
          ? "done"
          : i === run.currentStep
            ? status === "failed" || status === "cancelled"
              ? "failed"
              : "current"
            : "pending",
    })),
    events: run.events.map((e) => ({ id: e.id.toString(), at: e.at, type: e.type, message: e.message, step: e.step })),
    outputs: run.events
      .filter((e) => e.type === "output")
      .map((e) => ({ path: e.message, at: e.at })),
    checkpoint: open
      ? {
          id: open.id.toString(),
          question: open.question,
          options: Array.isArray(open.options) ? open.options.filter((o): o is string => typeof o === "string") : [],
          step: open.step,
        }
      : null,
  };
}

export type LaunchOption = { value: string; label: string; busy?: boolean };

/** What New run offers: runnable workflows, and projects (busy ones marked). */
export async function listLaunchOptions(): Promise<{ workflows: LaunchOption[]; projects: LaunchOption[] }> {
  const [workflows, projects, active] = await Promise.all([
    listWorkflows(),
    listProjects(),
    prisma.cipRun.findMany({ where: { status: { in: ACTIVE_STATUSES } }, select: { projectId: true } }),
  ]);
  const busy = new Set(active.map((r) => r.projectId.toString()));
  return {
    workflows: workflows
      .filter((w) => w.status === "active" && w.steps.length > 0 && !w.steps.some((s) => s.missing))
      .map((w) => ({ value: w.id, label: w.name })),
    projects: projects
      .slice()
      .sort((a, b) => a.folderName.localeCompare(b.folderName))
      .map((p) => ({ value: p.id.toString(), label: p.folderName, busy: busy.has(p.id.toString()) })),
  };
}
