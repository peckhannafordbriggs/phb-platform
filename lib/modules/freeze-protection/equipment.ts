import { describeAuditEvent } from "@/lib/admin/audit-describe";
import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { FREEZE_PROTECTION_MODULE_KEY as moduleKey, FREEZE_PROTECTION_MODULE_NAME } from "./constants";
import { fromDateOnly, toDateOnly } from "./dates";
import { disposition } from "./disposition";
import { type FpResult, cleanText, fail, isUniqueViolation, ok, parseId } from "./result";
import type { CreateEquipmentInput, UpdateEquipmentInput } from "./schemas";
import type { CoilType, ConfirmedWith, EquipmentStatus, Exposure, FpHistoryEntry, FpLine, Protection, YesNo } from "./types";

/**
 * Equipment: one line of the project's mechanical equipment schedule (from the
 * engineer of record's drawings) and its verification results. A project is
 * verified once, so the results are on the unit's own row.
 *
 * History is the audit log. Every write here leaves one row per kind of change
 * (`fp.equipment_*` for the schedule, `fp.result_updated` for steps 1 to 6),
 * each with before and after values and a timestamp, and `getHistory` reads
 * them back. There is no second copy to drift from it.
 */

const WITH_EDITOR = { updatedBy: { select: { firstName: true, lastName: true } } } as const;
type Row = Prisma.FpEquipmentGetPayload<{ include: typeof WITH_EDITOR }>;

function toLine(r: Row): FpLine {
  const any = (...values: (string | null)[]) => values.some((v) => v !== null);
  return {
    id: r.id.toString(),
    name: r.name,
    equipmentType: r.equipmentType,
    areaServed: r.areaServed,
    coil: r.coil as CoilType | null,
    status: r.status as EquipmentStatus,
    exposure: r.exposure as Exposure | null,
    protection: r.protection as Protection | null,
    test: {
      answers: {
        ...(r.testFanStops && { fanStops: r.testFanStops as YesNo }),
        ...(r.testDamperCloses && { damperCloses: r.testDamperCloses as YesNo }),
        ...(r.testValveFullFlow && { valveFullFlow: r.testValveFullFlow as YesNo }),
        ...(r.testManualReset && { manualReset: r.testManualReset as YesNo }),
      },
      tripTempF: r.tripTempF === null ? null : String(r.tripTempF),
      testedBy: r.testedBy,
      testDate: toDateOnly(r.testDate),
      elements: r.elements,
    },
    notification:
      any(r.notifyWho, r.notifyMethod, r.notifyResponse) || r.notifyDate
        ? { who: r.notifyWho, date: toDateOnly(r.notifyDate), method: r.notifyMethod, response: r.notifyResponse }
        : null,
    deficiency:
      any(r.deficiencyDescription, r.deficiencyOwner) || r.deficiencyDue
        ? { description: r.deficiencyDescription, owner: r.deficiencyOwner, due: toDateOnly(r.deficiencyDue) }
        : null,
    documentation:
      any(r.documentedWith, r.documentedName, r.documentedMethod) || r.documentedDate
        ? {
            with: r.documentedWith as ConfirmedWith | null,
            name: r.documentedName,
            date: toDateOnly(r.documentedDate),
            method: r.documentedMethod,
          }
        : null,
    notes: r.notes,
    updatedAt: r.updatedAt.toISOString(),
    updatedBy: r.updatedBy ? `${r.updatedBy.firstName} ${r.updatedBy.lastName}` : null,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** A project's register: every unit, in schedule order (AHU-2 before AHU-10). */
export async function listEquipment(rawProjectId: string): Promise<FpLine[]> {
  const projectId = parseId(rawProjectId);
  if (projectId === null) return [];
  const rows = await prisma.fpEquipment.findMany({ where: { projectId }, include: WITH_EDITOR });
  return rows
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map(toLine);
}

const MODULE_NAMES = new Map([[moduleKey, FREEZE_PROTECTION_MODULE_NAME]]);
const PARTY = { select: { id: true, firstName: true, lastName: true, email: true } } as const;

/** A unit's history, newest first: every audited change to it, with who and when. */
export async function getHistory(rawId: string): Promise<FpHistoryEntry[]> {
  if (parseId(rawId) === null) return [];
  const rows = await prisma.auditEvent.findMany({
    where: { moduleKey, metadata: { path: ["equipmentId"], equals: rawId } },
    orderBy: { occurredAt: "desc" },
    take: 200,
    select: { id: true, action: true, moduleKey: true, metadata: true, occurredAt: true, actor: PARTY, target: PARTY },
  });
  return rows.map((r) => ({ id: r.id, at: r.occurredAt.toISOString(), sentence: describeAuditEvent(r, MODULE_NAMES).sentence }));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

const SCHEDULE_FIELDS = new Set(["name", "equipmentType", "areaServed", "coil", "notes", "sortOrder"]);
const DATE_FIELDS = new Set(["testDate", "notifyDate", "deficiencyDue", "documentedDate"]);
const FREE_TEXT = new Set([
  "name",
  "equipmentType",
  "areaServed",
  "notes",
  "testedBy",
  "elements",
  "notifyWho",
  "notifyMethod",
  "notifyResponse",
  "deficiencyDescription",
  "deficiencyOwner",
  "documentedName",
  "documentedMethod",
]);

export async function addEquipment(actorId: string, input: CreateEquipmentInput): Promise<FpResult<FpLine>> {
  const projectId = parseId(input.projectId);
  if (projectId === null) return fail("not_found", "Project not found.");
  const name = cleanText(input.name);
  if (name === null) return fail("invalid", "Enter the equipment name from the schedule, e.g. AHU-1.");
  const project = await prisma.fpProject.findUnique({
    where: { id: projectId },
    select: { jobNumber: true, _count: { select: { equipment: true } } },
  });
  if (project === null) return fail("not_found", "Project not found.");

  try {
    const created = await prisma.$transaction(async (tx) => {
      const e = await tx.fpEquipment.create({
        data: {
          projectId,
          name,
          equipmentType: cleanText(input.equipmentType),
          areaServed: cleanText(input.areaServed),
          coil: input.coil ?? null,
          notes: cleanText(input.notes),
          sortOrder: project._count.equipment,
          updatedById: actorId,
        },
        include: WITH_EDITOR,
      });
      await writeAuditEvent(tx, {
        action: "fp.equipment_created",
        actorEmployeeId: actorId,
        moduleKey,
        metadata: { projectId: input.projectId, jobNumber: project.jobNumber, equipmentId: e.id.toString(), name: e.name },
      });
      return e;
    });
    return ok(toLine(created));
  } catch (error) {
    if (isUniqueViolation(error)) return fail("name_taken", `This project already has a unit named ${name}.`);
    throw error;
  }
}

/**
 * One save: any subset of the unit's schedule fields and verification answers.
 * Schedule changes are audited as `fp.equipment_updated` and answers as
 * `fp.result_updated` (with the disposition after the change), so the history
 * and the self-review check can tell recording a result from fixing a typo.
 */
export async function updateEquipment(actorId: string, rawId: string, input: UpdateEquipmentInput): Promise<FpResult<FpLine>> {
  const id = parseId(rawId);
  if (id === null) return fail("not_found", "Equipment not found.");
  const before = await prisma.fpEquipment.findUnique({
    where: { id },
    include: { ...WITH_EDITOR, project: { select: { jobNumber: true } } },
  });
  if (before === null) return fail("not_found", "Equipment not found.");

  const data: Record<string, unknown> = {};
  const schedule: Record<string, { from: unknown; to: unknown }> = {};
  const answers: Record<string, { from: unknown; to: unknown }> = {};
  for (const [field, raw] of Object.entries(input)) {
    if (raw === undefined) continue;
    const value = FREE_TEXT.has(field) ? cleanText(raw as string | null) : raw;
    if (field === "name" && value === null) return fail("invalid", "Enter the equipment name from the schedule, e.g. AHU-1.");
    const stored = (before as unknown as Record<string, unknown>)[field];
    const from = DATE_FIELDS.has(field) ? toDateOnly(stored as Date | null) : stored;
    if (from === value) continue;
    data[field] = DATE_FIELDS.has(field) ? fromDateOnly(value as string | null) : value;
    (SCHEDULE_FIELDS.has(field) ? schedule : answers)[field] = { from, to: value };
  }
  if (Object.keys(data).length === 0) return ok(toLine(before));

  try {
    const after = await prisma.$transaction(async (tx) => {
      const r = await tx.fpEquipment.update({
        where: { id },
        data: { ...(data as Prisma.FpEquipmentUncheckedUpdateInput), updatedById: actorId },
        include: WITH_EDITOR,
      });
      const line = toLine(r);
      const base = { projectId: before.projectId.toString(), jobNumber: before.project.jobNumber, equipmentId: rawId, name: r.name };
      if (Object.keys(schedule).length > 0) {
        await writeAuditEvent(tx, { action: "fp.equipment_updated", actorEmployeeId: actorId, moduleKey, metadata: { ...base, changes: schedule } });
      }
      if (Object.keys(answers).length > 0) {
        await writeAuditEvent(tx, {
          action: "fp.result_updated",
          actorEmployeeId: actorId,
          moduleKey,
          metadata: { ...base, changes: answers, disposition: disposition(line).code },
        });
      }
      return line;
    });
    return ok(after);
  } catch (error) {
    if (isUniqueViolation(error)) return fail("name_taken", `This project already has a unit named ${data.name as string}.`);
    throw error;
  }
}

/** Removes the unit and its results. Its history stays in the audit log. */
export async function deleteEquipment(actorId: string, rawId: string): Promise<FpResult<{ id: string }>> {
  const id = parseId(rawId);
  if (id === null) return fail("not_found", "Equipment not found.");
  const e = await prisma.fpEquipment.findUnique({ where: { id }, include: { project: { select: { jobNumber: true } } } });
  if (e === null) return fail("not_found", "Equipment not found.");

  await prisma.$transaction(async (tx) => {
    await tx.fpEquipment.delete({ where: { id } });
    await writeAuditEvent(tx, {
      action: "fp.equipment_deleted",
      actorEmployeeId: actorId,
      moduleKey,
      metadata: {
        projectId: e.projectId.toString(),
        jobNumber: e.project.jobNumber,
        equipmentId: rawId,
        name: e.name,
        disposition: disposition(toLine({ ...e, updatedBy: null })).code,
      },
    });
  });
  return ok({ id: rawId });
}
