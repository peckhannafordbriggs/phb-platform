import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { COST_INTELLIGENCE_MODULE_KEY } from "./constants";

/**
 * Workflows: a named, ordered list of skills from the catalog, built by PCEs
 * in Settings.
 *
 * Steps point at a skill by folder name, not by foreign key, so a skill that
 * drops out of the folder shows as "missing" here instead of blocking the sync
 * or silently vanishing from the workflow. A workflow cannot be activated while
 * any step is missing.
 *
 * Every write returns a result instead of throwing, the same shape as
 * lib/admin/service.ts, and writes its audit row in the same transaction.
 */

export type WorkflowStatus = "draft" | "active" | "paused";

export type WorkflowErrorCode =
  | "not_found"
  | "invalid_name"
  | "invalid_description"
  | "name_taken"
  | "invalid_status_change"
  | "no_steps"
  | "missing_skills"
  | "duplicate_skill"
  | "unknown_skill"
  | "not_draft";

export type WorkflowResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: WorkflowErrorCode; message: string };

/** The only place a workflow refusal becomes a status code. Read by the routes. */
export const WORKFLOW_ERROR_STATUS: Record<WorkflowErrorCode, number> = {
  not_found: 404,
  invalid_name: 422,
  invalid_description: 422,
  name_taken: 409,
  invalid_status_change: 409,
  no_steps: 409,
  missing_skills: 409,
  duplicate_skill: 422,
  unknown_skill: 422,
  not_draft: 409,
};

export type WorkflowStepView = {
  position: number;
  folderName: string;
  /** The skill's name and version from the catalog; null when the skill is missing. */
  name: string | null;
  version: number | null;
  missing: boolean;
};

export type WorkflowView = {
  id: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  createdAt: Date;
  updatedAt: Date;
  steps: WorkflowStepView[];
};

export const NAME_MAX = 120;
export const DESCRIPTION_MAX = 2000;

/** Allowed status changes. A workflow never goes back to draft. */
const NEXT_STATUS: Record<WorkflowStatus, WorkflowStatus[]> = {
  draft: ["active"],
  active: ["paused"],
  paused: ["active"],
};

const fail = <T>(code: WorkflowErrorCode, message: string): WorkflowResult<T> => ({ ok: false, code, message });

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

/** A route param to an id, or null for anything that is not a positive whole number. */
export function parseWorkflowId(raw: string): bigint | null {
  return /^[1-9]\d{0,18}$/.test(raw) ? BigInt(raw) : null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const WITH_STEPS = { steps: { orderBy: { position: "asc" } } } as const;

type WorkflowRow = Prisma.CipWorkflowGetPayload<{ include: typeof WITH_STEPS }>;

async function toViews(rows: WorkflowRow[]): Promise<WorkflowView[]> {
  const folders = [...new Set(rows.flatMap((w) => w.steps.map((s) => s.skillFolderName)))];
  const skills = await prisma.cipSkill.findMany({
    where: { folderName: { in: folders } },
    select: { folderName: true, name: true, version: true },
  });
  const byFolder = new Map(skills.map((s) => [s.folderName, s]));

  return rows.map((w) => ({
    id: w.id.toString(),
    name: w.name,
    description: w.description,
    status: w.status as WorkflowStatus,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    steps: w.steps.map((s) => {
      const skill = byFolder.get(s.skillFolderName);
      return {
        position: s.position,
        folderName: s.skillFolderName,
        name: skill?.name ?? null,
        version: skill?.version ?? null,
        missing: skill === undefined,
      };
    }),
  }));
}

/** Every workflow with its steps, by name. */
export async function listWorkflows(): Promise<WorkflowView[]> {
  return toViews(await prisma.cipWorkflow.findMany({ include: WITH_STEPS, orderBy: { name: "asc" } }));
}

/** One workflow, or null if the id is malformed or does not exist. */
export async function getWorkflow(rawId: string): Promise<WorkflowView | null> {
  const id = parseWorkflowId(rawId);
  if (id === null) return null;
  const row = await prisma.cipWorkflow.findUnique({ where: { id }, include: WITH_STEPS });
  return row === null ? null : ((await toViews([row]))[0] ?? null);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function cleanName(raw: string): WorkflowResult<string> {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length === 0) return fail("invalid_name", "Give the workflow a name.");
  if (name.length > NAME_MAX) return fail("invalid_name", `Keep the name to ${NAME_MAX} characters.`);
  return { ok: true, data: name };
}

function cleanDescription(raw: string | null | undefined): WorkflowResult<string | null> {
  const description = raw?.trim() ?? "";
  if (description.length > DESCRIPTION_MAX) {
    return fail("invalid_description", `Keep the description to ${DESCRIPTION_MAX} characters.`);
  }
  return { ok: true, data: description.length === 0 ? null : description };
}

const NAME_TAKEN = "Another workflow already has that name.";

/** A new Draft with no steps. */
export async function createWorkflow(
  actorId: string,
  input: { name: string; description?: string | null },
): Promise<WorkflowResult<{ id: string }>> {
  const name = cleanName(input.name);
  if (!name.ok) return name;
  const description = cleanDescription(input.description);
  if (!description.ok) return description;

  try {
    const id = await prisma.$transaction(async (tx) => {
      const row = await tx.cipWorkflow.create({
        data: { name: name.data, description: description.data, createdById: actorId },
        select: { id: true },
      });
      await writeAuditEvent(tx, {
        action: "cip.workflow_created",
        actorEmployeeId: actorId,
        moduleKey: COST_INTELLIGENCE_MODULE_KEY,
        metadata: { workflowId: row.id.toString(), name: name.data },
      });
      return row.id;
    });
    return { ok: true, data: { id: id.toString() } };
  } catch (error) {
    if (isUniqueViolation(error)) return fail("name_taken", NAME_TAKEN);
    throw error;
  }
}

/** Rename, edit the description, or change status. Only what is passed changes. */
export async function updateWorkflow(
  actorId: string,
  rawId: string,
  patch: { name?: string; description?: string | null; status?: WorkflowStatus },
): Promise<WorkflowResult<{ changed: boolean }>> {
  const current = await getWorkflow(rawId);
  if (current === null) return fail("not_found", "Workflow not found.");

  const data: { name?: string; description?: string | null; status?: WorkflowStatus } = {};

  if (patch.name !== undefined) {
    const name = cleanName(patch.name);
    if (!name.ok) return name;
    if (name.data !== current.name) data.name = name.data;
  }

  if (patch.description !== undefined) {
    const description = cleanDescription(patch.description);
    if (!description.ok) return description;
    if (description.data !== current.description) data.description = description.data;
  }

  if (patch.status !== undefined && patch.status !== current.status) {
    if (!NEXT_STATUS[current.status].includes(patch.status)) {
      return fail("invalid_status_change", `A ${current.status} workflow cannot become ${patch.status}.`);
    }
    if (patch.status === "active") {
      if (current.steps.length === 0) return fail("no_steps", "Add at least one skill before activating.");
      const missing = current.steps.filter((s) => s.missing).map((s) => s.folderName);
      if (missing.length > 0) {
        return fail("missing_skills", `These skills are no longer in the catalog: ${missing.join(", ")}.`);
      }
    }
    data.status = patch.status;
  }

  if (Object.keys(data).length === 0) return { ok: true, data: { changed: false } };

  try {
    await prisma.$transaction(async (tx) => {
      await tx.cipWorkflow.update({ where: { id: BigInt(current.id) }, data });
      await writeAuditEvent(tx, {
        action: "cip.workflow_updated",
        actorEmployeeId: actorId,
        moduleKey: COST_INTELLIGENCE_MODULE_KEY,
        metadata: {
          workflowId: current.id,
          name: data.name ?? current.name,
          ...(data.name !== undefined && { previousName: current.name }),
          ...(data.status !== undefined && { status: data.status, previousStatus: current.status }),
          ...(data.description !== undefined && { descriptionChanged: true }),
        },
      });
    });
    return { ok: true, data: { changed: true } };
  } catch (error) {
    if (isUniqueViolation(error)) return fail("name_taken", NAME_TAKEN);
    throw error;
  }
}

/**
 * Replace the whole step list, numbered 1, 2, 3... in the order given. One
 * transaction, so the order can never be half-updated.
 *
 * Every skill must be in the catalog, and none twice. A workflow that is not a
 * Draft must keep at least one step: an Active workflow with no steps would be
 * offered to a run that can do nothing.
 */
export async function setWorkflowSteps(
  actorId: string,
  rawId: string,
  folderNames: string[],
): Promise<WorkflowResult<{ changed: boolean }>> {
  const current = await getWorkflow(rawId);
  if (current === null) return fail("not_found", "Workflow not found.");

  const seen = new Set<string>();
  for (const folder of folderNames) {
    if (seen.has(folder)) return fail("duplicate_skill", `${folder} is in the workflow twice.`);
    seen.add(folder);
  }

  if (folderNames.length === 0 && current.status !== "draft") {
    return fail("no_steps", "An active or paused workflow needs at least one skill. Pause it before editing if needed.");
  }

  const known = await prisma.cipSkill.findMany({
    where: { folderName: { in: folderNames } },
    select: { folderName: true },
  });
  const knownSet = new Set(known.map((s) => s.folderName));
  const unknown = folderNames.filter((f) => !knownSet.has(f));
  if (unknown.length > 0) return fail("unknown_skill", `Not in the skill catalog: ${unknown.join(", ")}.`);

  const previous = current.steps.map((s) => s.folderName);
  if (previous.length === folderNames.length && previous.every((f, i) => f === folderNames[i])) {
    return { ok: true, data: { changed: false } };
  }

  const id = BigInt(current.id);
  await prisma.$transaction(async (tx) => {
    await tx.cipWorkflowStep.deleteMany({ where: { workflowId: id } });
    if (folderNames.length > 0) {
      await tx.cipWorkflowStep.createMany({
        data: folderNames.map((skillFolderName, i) => ({ workflowId: id, position: i + 1, skillFolderName })),
      });
    }
    // Touch the workflow so updatedAt reflects a step change too.
    await tx.cipWorkflow.update({ where: { id }, data: { updatedAt: new Date() } });
    await writeAuditEvent(tx, {
      action: "cip.workflow_steps_changed",
      actorEmployeeId: actorId,
      moduleKey: COST_INTELLIGENCE_MODULE_KEY,
      metadata: { workflowId: current.id, name: current.name, steps: folderNames, previousSteps: previous },
    });
  });
  return { ok: true, data: { changed: true } };
}

/** Drafts only. Active and Paused workflows are paused, never deleted. */
export async function deleteWorkflow(actorId: string, rawId: string): Promise<WorkflowResult<{ deleted: true }>> {
  const current = await getWorkflow(rawId);
  if (current === null) return fail("not_found", "Workflow not found.");
  if (current.status !== "draft") {
    return fail("not_draft", "Only draft workflows can be deleted. Pause this one instead.");
  }

  await prisma.$transaction(async (tx) => {
    await tx.cipWorkflow.delete({ where: { id: BigInt(current.id) } });
    await writeAuditEvent(tx, {
      action: "cip.workflow_deleted",
      actorEmployeeId: actorId,
      moduleKey: COST_INTELLIGENCE_MODULE_KEY,
      metadata: { workflowId: current.id, name: current.name, steps: current.steps.map((s) => s.folderName) },
    });
  });
  return { ok: true, data: { deleted: true } };
}
