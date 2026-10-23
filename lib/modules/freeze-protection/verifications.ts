import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { FREEZE_PROTECTION_MODULE_KEY as moduleKey } from "./constants";
import { disposition } from "./disposition";
import { fromDateOnly, toDateOnly } from "./dates";
import { type FpResult, cleanText, fail, ok, parseId } from "./result";
import type { UpdateResultInput, UpdateVerificationInput } from "./schemas";
import type {
  CoilType,
  ConfirmedWith,
  EquipmentStatus,
  Exposure,
  FpLine,
  FpSignature,
  FpVerification,
  Protection,
  YesNo,
} from "./types";

/**
 * Verification rounds and their results.
 *
 * A unit is verified again each season or after a controls change, and the
 * history is kept (decision 2026-10-22). So a round is a row of its own, and a
 * unit's status and steps 3 to 6 live per round in fp_results. Name, tag and
 * coil type are the unit's and are read live by every round.
 *
 * Nothing is locked after signoff (manager, 2026-10-22). A round reviewed and
 * then changed says so (`changedAfterReview`), because the sheet requires a new
 * review after any later change.
 */

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const SIGNERS = {
  completedBy: { select: { id: true, firstName: true, lastName: true } },
  reviewedBy: { select: { id: true, firstName: true, lastName: true } },
} as const;

type VerificationRow = Prisma.FpVerificationGetPayload<{ include: typeof SIGNERS }>;
type Signer = { id: string; firstName: string; lastName: string } | null;

function signature(signer: Signer, id: string | null, at: Date | null): FpSignature | null {
  if (at === null) return null;
  // The employee row can be gone (SET NULL); the time is still the fact.
  return { employeeId: id, name: signer ? `${signer.firstName} ${signer.lastName}` : "Former employee", at: at.toISOString() };
}

async function lastChangeIn(verificationId: bigint): Promise<Date | null> {
  const [results, coil] = await Promise.all([
    prisma.fpResult.aggregate({ where: { verificationId }, _max: { updatedAt: true } }),
    prisma.fpEquipment.aggregate({
      where: { results: { some: { verificationId } } },
      _max: { coilUpdatedAt: true },
    }),
  ]);
  const a = results._max.updatedAt;
  const b = coil._max.coilUpdatedAt;
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

async function toView(v: VerificationRow): Promise<FpVerification> {
  const changed = v.reviewedAt === null ? null : await lastChangeIn(v.id);
  return {
    id: v.id.toString(),
    projectId: v.projectId.toString(),
    verificationDate: toDateOnly(v.verificationDate),
    completed: signature(v.completedBy, v.completedById, v.completedAt),
    reviewed: signature(v.reviewedBy, v.reviewedById, v.reviewedAt),
    transmittedTo: v.transmittedTo,
    transmittedDate: toDateOnly(v.transmittedDate),
    changedAfterReview: v.reviewedAt !== null && changed !== null && changed > v.reviewedAt,
  };
}

/** A project's rounds, newest first. */
export async function listVerifications(rawProjectId: string): Promise<FpVerification[]> {
  const projectId = parseId(rawProjectId);
  if (projectId === null) return [];
  const rows = await prisma.fpVerification.findMany({
    where: { projectId },
    include: SIGNERS,
    orderBy: [{ verificationDate: "desc" }, { id: "desc" }],
  });
  return Promise.all(rows.map(toView));
}

export async function getVerification(rawId: string): Promise<FpVerification | null> {
  const id = parseId(rawId);
  if (id === null) return null;
  const row = await prisma.fpVerification.findUnique({ where: { id }, include: SIGNERS });
  return row === null ? null : toView(row);
}

const LINE_INCLUDE = {
  equipment: { include: { building: { select: { id: true, name: true, sortOrder: true } } } },
  updatedBy: { select: { firstName: true, lastName: true } },
} as const;

type ResultRow = Prisma.FpResultGetPayload<{ include: typeof LINE_INCLUDE }>;

function toLine(r: ResultRow): FpLine {
  const e = r.equipment;
  const any = (...values: (string | null)[]) => values.some((v) => v !== null);
  return {
    id: e.id.toString(),
    resultId: r.id.toString(),
    buildingId: e.building.id.toString(),
    buildingName: e.building.name,
    tag: e.tag,
    equipmentType: e.equipmentType,
    areaServed: e.areaServed,
    coil: e.coil as CoilType | null,
    equipmentNotes: e.notes,
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
    notification: any(r.notifyWho, r.notifyMethod, r.notifyResponse) || r.notifyDate
      ? { who: r.notifyWho, date: toDateOnly(r.notifyDate), method: r.notifyMethod, response: r.notifyResponse }
      : null,
    deficiency: any(r.deficiencyDescription, r.deficiencyOwner) || r.deficiencyDue
      ? { description: r.deficiencyDescription, owner: r.deficiencyOwner, due: toDateOnly(r.deficiencyDue) }
      : null,
    documentation: any(r.documentedWith, r.documentedName, r.documentedMethod) || r.documentedDate
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

/** A round's register: every unit in it, by building then schedule order. */
export async function getRegister(rawVerificationId: string): Promise<FpLine[]> {
  const verificationId = parseId(rawVerificationId);
  if (verificationId === null) return [];
  const rows = await prisma.fpResult.findMany({ where: { verificationId }, include: LINE_INCLUDE });
  return rows
    .sort(
      (a, b) =>
        a.equipment.building.sortOrder - b.equipment.building.sortOrder ||
        a.equipment.building.name.localeCompare(b.equipment.building.name) ||
        a.equipment.sortOrder - b.equipment.sortOrder ||
        a.equipment.tag.localeCompare(b.equipment.tag, undefined, { numeric: true }),
    )
    .map(toLine);
}

// ---------------------------------------------------------------------------
// Round writes
// ---------------------------------------------------------------------------

/**
 * Starts a round. Every unit on the project gets a result. Status, exposure and
 * protection carry forward from the unit's newest earlier result, because they
 * are facts about the installation that rarely change; tests, notices,
 * deficiencies and documentation do not, because they are this round's evidence.
 */
export async function createVerification(
  actorId: string,
  rawProjectId: string,
  verificationDate: string,
): Promise<FpResult<FpVerification>> {
  const projectId = parseId(rawProjectId);
  if (projectId === null) return fail("not_found", "Project not found.");
  const project = await prisma.fpProject.findUnique({ where: { id: projectId }, select: { jobNumber: true } });
  if (project === null) return fail("not_found", "Project not found.");

  const id = await prisma.$transaction(async (tx) => {
    const previous = await tx.fpVerification.findFirst({
      where: { projectId },
      orderBy: [{ verificationDate: "desc" }, { id: "desc" }],
      select: { id: true, results: { select: { equipmentId: true, status: true, exposure: true, protection: true } } },
    });
    const carried = new Map((previous?.results ?? []).map((r) => [r.equipmentId, r]));
    const equipment = await tx.fpEquipment.findMany({ where: { building: { projectId } }, select: { id: true } });

    const v = await tx.fpVerification.create({
      data: {
        projectId,
        verificationDate: fromDateOnly(verificationDate),
        createdById: actorId,
        results: {
          create: equipment.map((e) => {
            const prior = carried.get(e.id);
            return {
              equipmentId: e.id,
              status: prior?.status ?? "service",
              exposure: prior?.exposure ?? null,
              protection: prior?.protection ?? null,
              updatedById: actorId,
            };
          }),
        },
      },
    });
    await writeAuditEvent(tx, {
      action: "fp.verification_created",
      actorEmployeeId: actorId,
      moduleKey,
      metadata: {
        projectId: rawProjectId,
        jobNumber: project.jobNumber,
        verificationId: v.id.toString(),
        verificationDate,
        units: equipment.length,
        carriedFrom: previous ? previous.id.toString() : null,
      },
    });
    return v.id;
  });
  return ok((await getVerification(id.toString()))!);
}

export async function updateVerification(
  actorId: string,
  rawId: string,
  input: UpdateVerificationInput,
): Promise<FpResult<FpVerification>> {
  const id = parseId(rawId);
  if (id === null) return fail("not_found", "Verification not found.");
  const before = await prisma.fpVerification.findUnique({ where: { id }, include: { project: { select: { jobNumber: true } } } });
  if (before === null) return fail("not_found", "Verification not found.");

  const data: Prisma.FpVerificationUpdateInput = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const note = (field: string, from: unknown, to: unknown) => {
    if (from !== to) changes[field] = { from, to };
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
  if (Object.keys(changes).length === 0) return ok((await getVerification(rawId))!);

  await prisma.$transaction(async (tx) => {
    await tx.fpVerification.update({ where: { id }, data });
    await writeAuditEvent(tx, {
      action: "fp.verification_updated",
      actorEmployeeId: actorId,
      moduleKey,
      metadata: { projectId: before.projectId.toString(), jobNumber: before.project.jobNumber, verificationId: rawId, changes },
    });
  });
  return ok((await getVerification(rawId))!);
}

export async function deleteVerification(actorId: string, rawId: string): Promise<FpResult<{ id: string }>> {
  const id = parseId(rawId);
  if (id === null) return fail("not_found", "Verification not found.");
  const v = await prisma.fpVerification.findUnique({
    where: { id },
    include: { project: { select: { jobNumber: true } }, _count: { select: { results: true } } },
  });
  if (v === null) return fail("not_found", "Verification not found.");

  await prisma.$transaction(async (tx) => {
    await tx.fpVerification.delete({ where: { id } });
    await writeAuditEvent(tx, {
      action: "fp.verification_deleted",
      actorEmployeeId: actorId,
      moduleKey,
      metadata: {
        projectId: v.projectId.toString(),
        jobNumber: v.project.jobNumber,
        verificationId: rawId,
        verificationDate: toDateOnly(v.verificationDate),
        units: v._count.results,
        wasReviewed: v.reviewedAt !== null,
      },
    });
  });
  return ok({ id: rawId });
}

/**
 * Step 7. The signer is always the signed-in employee.
 *
 * `completed` is the person who carried out the verification. `reviewed` is a
 * different engineer who did not perform steps 3 to 6: refused when the
 * reviewer completed the round, or is the last person to have changed any of
 * its results. (Only the last editor of each result is stored, so this catches
 * the common case, not every one; the audit log has the full history.)
 *
 * Removing the completion removes the review with it: a review of a
 * verification nobody has completed means nothing.
 */
export async function signVerification(
  actorId: string,
  rawId: string,
  role: "completed" | "reviewed",
  signed: boolean,
): Promise<FpResult<FpVerification>> {
  const id = parseId(rawId);
  if (id === null) return fail("not_found", "Verification not found.");
  const v = await prisma.fpVerification.findUnique({ where: { id }, include: { project: { select: { jobNumber: true } } } });
  if (v === null) return fail("not_found", "Verification not found.");

  let data: Prisma.FpVerificationUncheckedUpdateInput;
  if (role === "completed" && signed) {
    if (v.completedAt !== null) return fail("already_signed", "This verification is already marked completed. Remove that first.");
    data = { completedById: actorId, completedAt: new Date() };
  } else if (role === "completed") {
    data = { completedById: null, completedAt: null, reviewedById: null, reviewedAt: null };
  } else if (signed) {
    if (v.completedAt === null) return fail("not_completed", "Mark the verification completed before it is reviewed.");
    if (v.reviewedAt !== null) return fail("already_signed", "This verification is already reviewed. Remove that first.");
    if (v.completedById === actorId)
      return fail("self_review", "You completed this verification. A different engineer has to review it.");
    const edited = await prisma.fpResult.count({ where: { verificationId: id, updatedById: actorId } });
    if (edited > 0)
      return fail("self_review", "You recorded results in this verification. A different engineer has to review it.");
    data = { reviewedById: actorId, reviewedAt: new Date() };
  } else {
    data = { reviewedById: null, reviewedAt: null };
  }

  await prisma.$transaction(async (tx) => {
    await tx.fpVerification.update({ where: { id }, data });
    await writeAuditEvent(tx, {
      action: signed ? "fp.verification_signed" : "fp.verification_unsigned",
      actorEmployeeId: actorId,
      moduleKey,
      metadata: {
        projectId: v.projectId.toString(),
        jobNumber: v.project.jobNumber,
        verificationId: rawId,
        verificationDate: toDateOnly(v.verificationDate),
        role,
      },
    });
  });
  return ok((await getVerification(rawId))!);
}

// ---------------------------------------------------------------------------
// Result writes
// ---------------------------------------------------------------------------

const DATE_FIELDS = new Set(["testDate", "notifyDate", "deficiencyDue", "documentedDate"]);
const FREE_TEXT = new Set([
  "testedBy",
  "elements",
  "notifyWho",
  "notifyMethod",
  "notifyResponse",
  "deficiencyDescription",
  "deficiencyOwner",
  "documentedName",
  "documentedMethod",
  "notes",
]);

/**
 * One save from the step pane: any subset of a result's fields. The audit row
 * carries each changed field's before and after, plus the line's disposition
 * after the change, so the log reads as the procedure did.
 */
export async function updateResult(
  actorId: string,
  rawId: string,
  input: UpdateResultInput,
): Promise<FpResult<FpLine>> {
  const id = parseId(rawId);
  if (id === null) return fail("not_found", "Result not found.");
  const before = await prisma.fpResult.findUnique({
    where: { id },
    include: { ...LINE_INCLUDE, verification: { select: { projectId: true, project: { select: { jobNumber: true } } } } },
  });
  if (before === null) return fail("not_found", "Result not found.");

  const data: Record<string, unknown> = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [field, raw] of Object.entries(input)) {
    if (raw === undefined) continue;
    let value: unknown = raw;
    if (FREE_TEXT.has(field)) value = cleanText(raw as string | null);
    const stored = (before as unknown as Record<string, unknown>)[field];
    const from = DATE_FIELDS.has(field) ? toDateOnly(stored as Date | null) : stored;
    if (from === value) continue;
    data[field] = DATE_FIELDS.has(field) ? fromDateOnly(value as string | null) : value;
    changes[field] = { from, to: value };
  }
  if (Object.keys(changes).length === 0) return ok(toLine(before));

  const after = await prisma.$transaction(async (tx) => {
    const r = await tx.fpResult.update({
      where: { id },
      data: { ...(data as Prisma.FpResultUncheckedUpdateInput), updatedById: actorId },
      include: LINE_INCLUDE,
    });
    const line = toLine(r);
    await writeAuditEvent(tx, {
      action: "fp.result_updated",
      actorEmployeeId: actorId,
      moduleKey,
      metadata: {
        projectId: before.verification.projectId.toString(),
        jobNumber: before.verification.project.jobNumber,
        verificationId: before.verificationId.toString(),
        equipmentId: before.equipmentId.toString(),
        tag: before.equipment.tag,
        changes,
        disposition: disposition(line).code,
      },
    });
    return line;
  });
  return ok(after);
}
