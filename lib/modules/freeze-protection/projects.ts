import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { FREEZE_PROTECTION_MODULE_KEY as moduleKey } from "./constants";
import { fromDateOnly, toDateOnly, todayInNewYork } from "./dates";
import { type FpResult, cleanText, fail, isUniqueViolation, ok, parseId } from "./result";
import type { CreateProjectInput, UpdateProjectInput } from "./schemas";
import type { FpProject, FpProjectSummary, FpSignature } from "./types";

/**
 * Projects and their one freeze protection verification. A project is a
 * construction job, identified by its job number and linked to nothing else
 * in the platform. It is verified once (decision 2026-10-23), so the
 * verification date, step 7 signoff and transmittal are the project's own.
 *
 * Every write writes its audit row in the same transaction. The audit log is
 * also the history: "changed after review" and the self-review check read it.
 */

/** Unit actions that change what a reviewed report says. Signoff and transmittal do not. */
const REPORT_CHANGING = ["fp.equipment_created", "fp.equipment_updated", "fp.equipment_deleted", "fp.result_updated"];

const SIGNERS = {
  completedBy: { select: { firstName: true, lastName: true } },
  reviewedBy: { select: { firstName: true, lastName: true } },
  _count: { select: { equipment: true } },
} as const;

type ProjectRow = Prisma.FpProjectGetPayload<{ include: typeof SIGNERS }>;

function signature(signer: { firstName: string; lastName: string } | null, id: string | null, at: Date | null): FpSignature | null {
  if (at === null) return null;
  // The employee row can be gone (SET NULL); the time is still the fact.
  return { employeeId: id, name: signer ? `${signer.firstName} ${signer.lastName}` : "Former employee", at: at.toISOString() };
}

/** Audit rows for this project, by metadata.projectId. Every fp.* row carries it. */
const forProject = (id: bigint) => ({ moduleKey, metadata: { path: ["projectId"], equals: id.toString() } });

async function toView(p: ProjectRow): Promise<FpProject> {
  const changedAfterReview =
    p.reviewedAt !== null &&
    (await prisma.auditEvent.count({
      where: { ...forProject(p.id), action: { in: REPORT_CHANGING }, occurredAt: { gt: p.reviewedAt } },
    })) > 0;
  return {
    id: p.id.toString(),
    jobNumber: p.jobNumber,
    name: p.name,
    verificationDate: toDateOnly(p.verificationDate),
    completed: signature(p.completedBy, p.completedById, p.completedAt),
    reviewed: signature(p.reviewedBy, p.reviewedById, p.reviewedAt),
    transmittedTo: p.transmittedTo,
    transmittedDate: toDateOnly(p.transmittedDate),
    changedAfterReview,
    equipmentCount: p._count.equipment,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Every project, newest job number first, for the picker. */
export async function listProjects(): Promise<FpProjectSummary[]> {
  const rows = await prisma.fpProject.findMany({
    orderBy: [{ jobNumber: "desc" }, { id: "desc" }],
    select: { id: true, jobNumber: true, name: true, _count: { select: { equipment: true } } },
  });
  return rows.map((p) => ({ id: p.id.toString(), jobNumber: p.jobNumber, name: p.name, equipmentCount: p._count.equipment }));
}

/** One project and its verification, or null if the id is malformed or missing. */
export async function getProject(rawId: string): Promise<FpProject | null> {
  const id = parseId(rawId);
  if (id === null) return null;
  const row = await prisma.fpProject.findUnique({ where: { id }, include: SIGNERS });
  return row === null ? null : toView(row);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function requireName(value: string | undefined, what: string): FpResult<string> {
  const v = cleanText(value);
  return v === null ? fail("invalid", `Enter a ${what}.`) : ok(v);
}

export async function createProject(actorId: string, input: CreateProjectInput): Promise<FpResult<FpProject>> {
  const job = requireName(input.jobNumber, "job number");
  if (!job.ok) return job;
  const name = requireName(input.name, "project name");
  if (!name.ok) return name;
  const verificationDate = input.verificationDate ?? todayInNewYork();

  try {
    const id = await prisma.$transaction(async (tx) => {
      const p = await tx.fpProject.create({
        data: { jobNumber: job.data, name: name.data, verificationDate: fromDateOnly(verificationDate), createdById: actorId },
      });
      await writeAuditEvent(tx, {
        action: "fp.project_created",
        actorEmployeeId: actorId,
        moduleKey,
        metadata: { projectId: p.id.toString(), jobNumber: p.jobNumber, name: p.name, verificationDate },
      });
      return p.id;
    });
    return ok((await getProject(id.toString()))!);
  } catch (error) {
    if (isUniqueViolation(error)) return fail("job_number_taken", `Job number ${job.data} is already a project.`);
    throw error;
  }
}

/**
 * Identity (job number, name) and the verification's date and transmittal.
 * Identity changes are `fp.project_updated`; verification changes are
 * `fp.verification_updated`, so the history reads as what happened.
 */
export async function updateProject(actorId: string, rawId: string, input: UpdateProjectInput): Promise<FpResult<FpProject>> {
  const id = parseId(rawId);
  if (id === null) return fail("not_found", "Project not found.");
  const before = await prisma.fpProject.findUnique({ where: { id } });
  if (before === null) return fail("not_found", "Project not found.");

  const data: Prisma.FpProjectUpdateInput = {};
  if (input.jobNumber !== undefined) {
    const v = requireName(input.jobNumber, "job number");
    if (!v.ok) return v;
    data.jobNumber = v.data;
  }
  if (input.name !== undefined) {
    const v = requireName(input.name, "project name");
    if (!v.ok) return v;
    data.name = v.data;
  }

  const verificationChanges: Record<string, { from: unknown; to: unknown }> = {};
  const note = (field: string, from: unknown, to: unknown) => {
    if (from !== to) verificationChanges[field] = { from, to };
  };
  if (input.verificationDate !== undefined) {
    data.verificationDate = fromDateOnly(input.verificationDate);
    note("verificationDate", toDateOnly(before.verificationDate), input.verificationDate);
  }
  if (input.transmittedTo !== undefined) {
    data.transmittedTo = cleanText(input.transmittedTo);
    note("transmittedTo", before.transmittedTo, data.transmittedTo);
  }
  if (input.transmittedDate !== undefined) {
    data.transmittedDate = fromDateOnly(input.transmittedDate);
    note("transmittedDate", toDateOnly(before.transmittedDate), input.transmittedDate);
  }

  const jobChanged = data.jobNumber !== undefined && data.jobNumber !== before.jobNumber;
  const nameChanged = data.name !== undefined && data.name !== before.name;
  if (!jobChanged && !nameChanged && Object.keys(verificationChanges).length === 0) return ok((await getProject(rawId))!);

  try {
    await prisma.$transaction(async (tx) => {
      const after = await tx.fpProject.update({ where: { id }, data });
      const base = { projectId: rawId, jobNumber: after.jobNumber };
      if (jobChanged || nameChanged) {
        await writeAuditEvent(tx, {
          action: "fp.project_updated",
          actorEmployeeId: actorId,
          moduleKey,
          metadata: {
            ...base,
            name: after.name,
            ...(jobChanged && { previousJobNumber: before.jobNumber }),
            ...(nameChanged && { previousName: before.name }),
          },
        });
      }
      if (Object.keys(verificationChanges).length > 0) {
        await writeAuditEvent(tx, {
          action: "fp.verification_updated",
          actorEmployeeId: actorId,
          moduleKey,
          metadata: { ...base, changes: verificationChanges },
        });
      }
    });
  } catch (error) {
    if (isUniqueViolation(error)) return fail("job_number_taken", `Job number ${data.jobNumber as string} is already a project.`);
    throw error;
  }
  return ok((await getProject(rawId))!);
}

/** Removes the project and its equipment. The audit log keeps every row it ever wrote. */
export async function deleteProject(actorId: string, rawId: string): Promise<FpResult<{ id: string }>> {
  const id = parseId(rawId);
  if (id === null) return fail("not_found", "Project not found.");
  const p = await prisma.fpProject.findUnique({ where: { id }, include: { _count: { select: { equipment: true } } } });
  if (p === null) return fail("not_found", "Project not found.");

  await prisma.$transaction(async (tx) => {
    await tx.fpProject.delete({ where: { id } });
    await writeAuditEvent(tx, {
      action: "fp.project_deleted",
      actorEmployeeId: actorId,
      moduleKey,
      metadata: { projectId: rawId, jobNumber: p.jobNumber, name: p.name, equipment: p._count.equipment, wasReviewed: p.reviewedAt !== null },
    });
  });
  return ok({ id: rawId });
}

/**
 * Step 7. The signer is always the signed-in employee.
 *
 * `completed` is the person who carried out the verification. `reviewed` is a
 * different engineer who did not perform steps 3 to 6: refused when the
 * reviewer completed it, or recorded any result on the project (from the audit
 * log, so every edit counts, not only the last). Removing the completion
 * removes the review with it.
 */
export async function signProject(
  actorId: string,
  rawId: string,
  role: "completed" | "reviewed",
  signed: boolean,
): Promise<FpResult<FpProject>> {
  const id = parseId(rawId);
  if (id === null) return fail("not_found", "Project not found.");
  const p = await prisma.fpProject.findUnique({ where: { id } });
  if (p === null) return fail("not_found", "Project not found.");

  let data: Prisma.FpProjectUncheckedUpdateInput;
  if (role === "completed" && signed) {
    if (p.completedAt !== null) return fail("already_signed", "This verification is already marked completed. Remove that first.");
    data = { completedById: actorId, completedAt: new Date() };
  } else if (role === "completed") {
    data = { completedById: null, completedAt: null, reviewedById: null, reviewedAt: null };
  } else if (signed) {
    if (p.completedAt === null) return fail("not_completed", "Mark the verification completed before it is reviewed.");
    if (p.reviewedAt !== null) return fail("already_signed", "This verification is already reviewed. Remove that first.");
    if (p.completedById === actorId) return fail("self_review", "You completed this verification. A different engineer has to review it.");
    const recorded = await prisma.auditEvent.count({
      where: { ...forProject(id), action: "fp.result_updated", actorEmployeeId: actorId },
    });
    if (recorded > 0) return fail("self_review", "You recorded results in this verification. A different engineer has to review it.");
    data = { reviewedById: actorId, reviewedAt: new Date() };
  } else {
    data = { reviewedById: null, reviewedAt: null };
  }

  await prisma.$transaction(async (tx) => {
    await tx.fpProject.update({ where: { id }, data });
    await writeAuditEvent(tx, {
      action: signed ? "fp.verification_signed" : "fp.verification_unsigned",
      actorEmployeeId: actorId,
      moduleKey,
      metadata: { projectId: rawId, jobNumber: p.jobNumber, verificationDate: toDateOnly(p.verificationDate), role },
    });
  });
  return ok((await getProject(rawId))!);
}
