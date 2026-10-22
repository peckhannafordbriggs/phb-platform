import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { FREEZE_PROTECTION_MODULE_KEY as moduleKey } from "./constants";
import { type FpResult, cleanText, fail, isUniqueViolation, ok, parseId } from "./result";
import type { CreateEquipmentInput, UpdateEquipmentInput } from "./schemas";

/**
 * Equipment: one line of the mechanical equipment schedule from the engineer
 * of record's drawings. What the unit is and where (steps 1 to 2). Its results
 * are per verification round, in fp_results.
 */

export type EquipmentView = {
  id: string;
  buildingId: string;
  tag: string;
  equipmentType: string | null;
  areaServed: string | null;
  coil: string | null;
  notes: string | null;
};

type Row = {
  id: bigint;
  buildingId: bigint;
  tag: string;
  equipmentType: string | null;
  areaServed: string | null;
  coil: string | null;
  notes: string | null;
};

const view = (e: Row): EquipmentView => ({
  id: e.id.toString(),
  buildingId: e.buildingId.toString(),
  tag: e.tag,
  equipmentType: e.equipmentType,
  areaServed: e.areaServed,
  coil: e.coil,
  notes: e.notes,
});

/**
 * Adds a unit to a building. If the project has verification rounds, the unit
 * joins the NEWEST one with nothing answered; older rounds are history and keep
 * the register they had.
 */
export async function addEquipment(actorId: string, input: CreateEquipmentInput): Promise<FpResult<EquipmentView>> {
  const buildingId = parseId(input.buildingId);
  if (buildingId === null) return fail("not_found", "Building not found.");
  const tag = cleanText(input.tag);
  if (tag === null) return fail("invalid", "Enter the equipment tag from the schedule, e.g. AHU-1.");
  const building = await prisma.fpBuilding.findUnique({
    where: { id: buildingId },
    include: { project: { select: { id: true, jobNumber: true } }, _count: { select: { equipment: true } } },
  });
  if (building === null) return fail("not_found", "Building not found.");

  try {
    const created = await prisma.$transaction(async (tx) => {
      const latest = await tx.fpVerification.findFirst({
        where: { projectId: building.projectId },
        orderBy: [{ verificationDate: "desc" }, { id: "desc" }],
        select: { id: true },
      });
      const e = await tx.fpEquipment.create({
        data: {
          buildingId,
          tag,
          equipmentType: cleanText(input.equipmentType),
          areaServed: cleanText(input.areaServed),
          coil: input.coil ?? null,
          coilUpdatedAt: input.coil ? new Date() : null,
          notes: cleanText(input.notes),
          sortOrder: building._count.equipment,
          ...(latest && { results: { create: { verificationId: latest.id, updatedById: actorId } } }),
        },
      });
      await writeAuditEvent(tx, {
        action: "fp.equipment_created",
        actorEmployeeId: actorId,
        moduleKey,
        metadata: {
          projectId: building.projectId.toString(),
          jobNumber: building.project.jobNumber,
          building: building.name,
          equipmentId: e.id.toString(),
          tag: e.tag,
        },
      });
      return e;
    });
    return ok(view(created));
  } catch (error) {
    if (isUniqueViolation(error)) return fail("tag_taken", `${building.name} already has a unit tagged ${tag}.`);
    throw error;
  }
}

const EQUIPMENT_FIELDS = ["tag", "equipmentType", "areaServed", "coil", "notes", "buildingId", "sortOrder"] as const;

export async function updateEquipment(
  actorId: string,
  rawId: string,
  input: UpdateEquipmentInput,
): Promise<FpResult<EquipmentView>> {
  const id = parseId(rawId);
  if (id === null) return fail("not_found", "Equipment not found.");
  const before = await prisma.fpEquipment.findUnique({
    where: { id },
    include: { building: { select: { projectId: true, name: true, project: { select: { jobNumber: true } } } } },
  });
  if (before === null) return fail("not_found", "Equipment not found.");

  const data: Partial<Row> & { coilUpdatedAt?: Date; sortOrder?: number } = {};
  if (input.tag !== undefined) {
    const tag = cleanText(input.tag);
    if (tag === null) return fail("invalid", "Enter the equipment tag from the schedule, e.g. AHU-1.");
    data.tag = tag;
  }
  if (input.equipmentType !== undefined) data.equipmentType = cleanText(input.equipmentType);
  if (input.areaServed !== undefined) data.areaServed = cleanText(input.areaServed);
  if (input.notes !== undefined) data.notes = cleanText(input.notes);
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
  if (input.coil !== undefined && input.coil !== before.coil) {
    data.coil = input.coil;
    data.coilUpdatedAt = new Date();
  }
  if (input.buildingId !== undefined) {
    const buildingId = parseId(input.buildingId);
    const target =
      buildingId === null ? null : await prisma.fpBuilding.findUnique({ where: { id: buildingId }, select: { projectId: true } });
    // A unit moves between buildings of its own project only: its results belong to that project's rounds.
    if (target === null || target.projectId !== before.building.projectId)
      return fail("invalid", "Pick a building on this project.");
    data.buildingId = buildingId!;
  }

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of EQUIPMENT_FIELDS) {
    if (data[f] !== undefined && data[f] !== before[f]) {
      const from = before[f];
      const to = data[f];
      changes[f] = { from: typeof from === "bigint" ? from.toString() : from, to: typeof to === "bigint" ? to.toString() : to };
    }
  }
  if (Object.keys(changes).length === 0) return ok(view(before));

  try {
    const after = await prisma.$transaction(async (tx) => {
      const e = await tx.fpEquipment.update({ where: { id }, data });
      await writeAuditEvent(tx, {
        action: "fp.equipment_updated",
        actorEmployeeId: actorId,
        moduleKey,
        metadata: {
          projectId: before.building.projectId.toString(),
          jobNumber: before.building.project.jobNumber,
          equipmentId: rawId,
          tag: e.tag,
          changes,
        },
      });
      return e;
    });
    return ok(view(after));
  } catch (error) {
    if (isUniqueViolation(error)) return fail("tag_taken", `That building already has a unit tagged ${data.tag ?? before.tag}.`);
    throw error;
  }
}

/** Removes the unit and its results in every round. The audit row records how many rounds it was in. */
export async function deleteEquipment(actorId: string, rawId: string): Promise<FpResult<{ id: string }>> {
  const id = parseId(rawId);
  if (id === null) return fail("not_found", "Equipment not found.");
  const e = await prisma.fpEquipment.findUnique({
    where: { id },
    include: {
      _count: { select: { results: true } },
      building: { select: { name: true, projectId: true, project: { select: { jobNumber: true } } } },
    },
  });
  if (e === null) return fail("not_found", "Equipment not found.");

  await prisma.$transaction(async (tx) => {
    await tx.fpEquipment.delete({ where: { id } });
    await writeAuditEvent(tx, {
      action: "fp.equipment_deleted",
      actorEmployeeId: actorId,
      moduleKey,
      metadata: {
        projectId: e.building.projectId.toString(),
        jobNumber: e.building.project.jobNumber,
        building: e.building.name,
        equipmentId: rawId,
        tag: e.tag,
        rounds: e._count.results,
      },
    });
  });
  return ok({ id: rawId });
}
