import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { FREEZE_PROTECTION_MODULE_KEY as moduleKey } from "./constants";
import { toDateOnly } from "./dates";
import { type FpResult, cleanText, fail, isUniqueViolation, ok, parseId } from "./result";
import type { CreateProjectInput, UpdateProjectInput } from "./schemas";
import type { FpBuilding, FpProject, FpProjectSummary } from "./types";

/**
 * Projects and their buildings. A project is a construction job, identified by
 * its job number and linked to nothing else in the platform (manager,
 * 2026-10-22). Everything in it is entered here, so the platform owns it.
 *
 * Every write writes its audit row in the same transaction.
 */

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Every project, newest job number first, for the picker. */
export async function listProjects(): Promise<FpProjectSummary[]> {
  const rows = await prisma.fpProject.findMany({
    orderBy: [{ jobNumber: "desc" }, { id: "desc" }],
    select: {
      id: true,
      jobNumber: true,
      name: true,
      buildings: { select: { _count: { select: { equipment: true } } } },
      verifications: {
        orderBy: [{ verificationDate: "desc" }, { id: "desc" }],
        take: 1,
        select: { verificationDate: true },
      },
    },
  });
  return rows.map((p) => ({
    id: p.id.toString(),
    jobNumber: p.jobNumber,
    name: p.name,
    equipmentCount: p.buildings.reduce((n, b) => n + b._count.equipment, 0),
    latestVerificationDate: toDateOnly(p.verifications[0]?.verificationDate ?? null),
  }));
}

/** One project with its buildings, or null if the id is malformed or missing. */
export async function getProject(rawId: string): Promise<FpProject | null> {
  const id = parseId(rawId);
  if (id === null) return null;
  const p = await prisma.fpProject.findUnique({
    where: { id },
    select: {
      id: true,
      jobNumber: true,
      name: true,
      buildings: {
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
        select: { id: true, name: true, _count: { select: { equipment: true } } },
      },
    },
  });
  if (p === null) return null;
  return {
    id: p.id.toString(),
    jobNumber: p.jobNumber,
    name: p.name,
    buildings: p.buildings.map(
      (b): FpBuilding => ({ id: b.id.toString(), name: b.name, equipmentCount: b._count.equipment }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Project writes
// ---------------------------------------------------------------------------

function requireName(value: string | undefined, what: string): FpResult<string> {
  const v = cleanText(value);
  return v === null ? fail("invalid", `Enter a ${what}.`) : ok(v);
}

/** Building names must be distinct within the project, ignoring case. */
function duplicateIn(names: string[]): string | null {
  const seen = new Set<string>();
  for (const n of names) {
    const k = n.toLowerCase();
    if (seen.has(k)) return n;
    seen.add(k);
  }
  return null;
}

export async function createProject(actorId: string, input: CreateProjectInput): Promise<FpResult<FpProject>> {
  const job = requireName(input.jobNumber, "job number");
  if (!job.ok) return job;
  const name = requireName(input.name, "project name");
  if (!name.ok) return name;
  const buildings = input.buildings.map((b) => cleanText(b));
  if (buildings.some((b) => b === null)) return fail("invalid", "Every building needs a name.");
  const names = buildings as string[];
  const dup = duplicateIn(names);
  if (dup !== null) return fail("building_name_taken", `There are two buildings named "${dup}".`);

  try {
    const created = await prisma.$transaction(async (tx) => {
      const project = await tx.fpProject.create({
        data: {
          jobNumber: job.data,
          name: name.data,
          createdById: actorId,
          buildings: { create: names.map((n, i) => ({ name: n, sortOrder: i })) },
        },
      });
      await writeAuditEvent(tx, {
        action: "fp.project_created",
        actorEmployeeId: actorId,
        moduleKey,
        metadata: { projectId: project.id.toString(), jobNumber: project.jobNumber, name: project.name, buildings: names },
      });
      return project.id;
    });
    return ok((await getProject(created.toString()))!);
  } catch (error) {
    if (isUniqueViolation(error)) return fail("job_number_taken", `Job number ${job.data} is already a project.`);
    throw error;
  }
}

export async function updateProject(
  actorId: string,
  rawId: string,
  input: UpdateProjectInput,
): Promise<FpResult<FpProject>> {
  const id = parseId(rawId);
  if (id === null) return fail("not_found", "Project not found.");
  const before = await prisma.fpProject.findUnique({ where: { id } });
  if (before === null) return fail("not_found", "Project not found.");

  const data: { jobNumber?: string; name?: string } = {};
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

  try {
    await prisma.$transaction(async (tx) => {
      const after = await tx.fpProject.update({ where: { id }, data });
      await writeAuditEvent(tx, {
        action: "fp.project_updated",
        actorEmployeeId: actorId,
        moduleKey,
        metadata: {
          projectId: id.toString(),
          jobNumber: after.jobNumber,
          name: after.name,
          ...(after.jobNumber !== before.jobNumber && { previousJobNumber: before.jobNumber }),
          ...(after.name !== before.name && { previousName: before.name }),
        },
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) return fail("job_number_taken", `Job number ${data.jobNumber} is already a project.`);
    throw error;
  }
  return ok((await getProject(rawId))!);
}

/** Removes the project and everything in it. The audit row keeps what it held. */
export async function deleteProject(actorId: string, rawId: string): Promise<FpResult<{ id: string }>> {
  const id = parseId(rawId);
  if (id === null) return fail("not_found", "Project not found.");
  const p = await prisma.fpProject.findUnique({
    where: { id },
    select: {
      jobNumber: true,
      name: true,
      _count: { select: { buildings: true, verifications: true } },
      buildings: { select: { _count: { select: { equipment: true } } } },
    },
  });
  if (p === null) return fail("not_found", "Project not found.");

  await prisma.$transaction(async (tx) => {
    await tx.fpProject.delete({ where: { id } });
    await writeAuditEvent(tx, {
      action: "fp.project_deleted",
      actorEmployeeId: actorId,
      moduleKey,
      metadata: {
        projectId: rawId,
        jobNumber: p.jobNumber,
        name: p.name,
        buildings: p._count.buildings,
        equipment: p.buildings.reduce((n, b) => n + b._count.equipment, 0),
        verifications: p._count.verifications,
      },
    });
  });
  return ok({ id: rawId });
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

export async function addBuilding(actorId: string, rawProjectId: string, rawName: string): Promise<FpResult<FpProject>> {
  const projectId = parseId(rawProjectId);
  if (projectId === null) return fail("not_found", "Project not found.");
  const name = requireName(rawName, "building name");
  if (!name.ok) return name;
  const project = await prisma.fpProject.findUnique({
    where: { id: projectId },
    select: { jobNumber: true, _count: { select: { buildings: true } } },
  });
  if (project === null) return fail("not_found", "Project not found.");

  try {
    await prisma.$transaction(async (tx) => {
      const b = await tx.fpBuilding.create({
        data: { projectId, name: name.data, sortOrder: project._count.buildings },
      });
      await writeAuditEvent(tx, {
        action: "fp.building_created",
        actorEmployeeId: actorId,
        moduleKey,
        metadata: { projectId: rawProjectId, jobNumber: project.jobNumber, buildingId: b.id.toString(), name: b.name },
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) return fail("building_name_taken", `This project already has a building named "${name.data}".`);
    throw error;
  }
  return ok((await getProject(rawProjectId))!);
}

export async function renameBuilding(actorId: string, rawId: string, rawName: string): Promise<FpResult<FpProject>> {
  const id = parseId(rawId);
  if (id === null) return fail("not_found", "Building not found.");
  const name = requireName(rawName, "building name");
  if (!name.ok) return name;
  const before = await prisma.fpBuilding.findUnique({ where: { id }, include: { project: { select: { jobNumber: true } } } });
  if (before === null) return fail("not_found", "Building not found.");

  try {
    await prisma.$transaction(async (tx) => {
      await tx.fpBuilding.update({ where: { id }, data: { name: name.data } });
      await writeAuditEvent(tx, {
        action: "fp.building_updated",
        actorEmployeeId: actorId,
        moduleKey,
        metadata: {
          projectId: before.projectId.toString(),
          jobNumber: before.project.jobNumber,
          buildingId: rawId,
          name: name.data,
          previousName: before.name,
        },
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) return fail("building_name_taken", `This project already has a building named "${name.data}".`);
    throw error;
  }
  return ok((await getProject(before.projectId.toString()))!);
}

/**
 * Refused while the building holds equipment, so a unit's history is never
 * removed as a side effect. Move or remove the units first. The last building
 * stays, because every unit needs one.
 */
export async function deleteBuilding(actorId: string, rawId: string): Promise<FpResult<FpProject>> {
  const id = parseId(rawId);
  if (id === null) return fail("not_found", "Building not found.");
  const b = await prisma.fpBuilding.findUnique({
    where: { id },
    include: {
      _count: { select: { equipment: true } },
      project: { select: { jobNumber: true, _count: { select: { buildings: true } } } },
    },
  });
  if (b === null) return fail("not_found", "Building not found.");
  if (b._count.equipment > 0)
    return fail(
      "building_not_empty",
      `${b.name} has ${b._count.equipment} unit${b._count.equipment === 1 ? "" : "s"}. Move or remove them first.`,
    );
  if (b.project._count.buildings <= 1) return fail("last_building", "A project needs at least one building.");

  await prisma.$transaction(async (tx) => {
    await tx.fpBuilding.delete({ where: { id } });
    await writeAuditEvent(tx, {
      action: "fp.building_deleted",
      actorEmployeeId: actorId,
      moduleKey,
      metadata: { projectId: b.projectId.toString(), jobNumber: b.project.jobNumber, buildingId: rawId, name: b.name },
    });
  });
  return ok((await getProject(b.projectId.toString()))!);
}
