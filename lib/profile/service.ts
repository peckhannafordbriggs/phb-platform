import { prisma } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import type { PositionInput } from "@/lib/validation/profile";

/**
 * Profile field changes, for both the employee editing their own position and an
 * admin editing someone's.
 *
 * There is one implementation of each change. The two routes differ only in
 * authorization - who may act, and on whom - which is decided before anything
 * here is called. `actorId` is always the session's employee and is never taken
 * from a request body, so the audit trail records who really did it even when
 * actor and target are the same person.
 *
 * Every change writes its audit event in the same transaction as the update, so
 * a change that succeeded without an audit row is not a reachable state.
 */

export type ProfileFailure =
  | "not_found"
  | "invalid_position"
  | "invalid_department";

export type ProfileResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ProfileFailure; message: string };

function fail<T>(code: ProfileFailure, message: string): ProfileResult<T> {
  return { ok: false, code, message };
}

/** Normalises the "Other" pair into the two columns. Exactly one is set. */
function resolvePosition(input: PositionInput): {
  positionId: string | null;
  positionOther: string | null;
} {
  const id =
    input.positionId != null && input.positionId.length > 0
      ? input.positionId
      : null;
  const other =
    input.positionOther != null && input.positionOther.length > 0
      ? input.positionOther
      : null;

  // The schema guarantees exactly one; a chosen row wins if that ever changes.
  return id !== null
    ? { positionId: id, positionOther: null }
    : { positionId: null, positionOther: other };
}

export interface PositionChanged {
  positionId: string | null;
  positionOther: string | null;
}

export async function setPosition(
  actorId: string,
  employeeId: string,
  input: PositionInput,
): Promise<ProfileResult<PositionChanged>> {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      id: true,
      positionId: true,
      positionOther: true,
      position: { select: { name: true } },
    },
  });
  if (employee === null) return fail("not_found", "Employee not found.");

  const next = resolvePosition(input);

  // A hidden position cannot be chosen, even by a caller bypassing the form -
  // the same check onboarding makes. Hiding a list value has to stop new
  // assignments, or hiding it achieves nothing.
  if (next.positionId !== null) {
    const position = await prisma.position.findFirst({
      where: { id: next.positionId, status: "active" },
      select: { id: true },
    });
    if (position === null) {
      return fail("invalid_position", "Select a position from the list.");
    }
  }

  const unchanged =
    employee.positionId === next.positionId &&
    employee.positionOther === next.positionOther;

  // No-op rather than an error, and no second audit row - the same shape the
  // grant and status operations use.
  if (unchanged) return { ok: true, data: next };

  const previous = employee.position?.name ?? employee.positionOther ?? null;

  await prisma.$transaction(async (tx) => {
    await tx.employee.update({
      where: { id: employeeId },
      // Only these two columns. Nothing about email, name, department, status or
      // the admin flag is reachable from here.
      data: { positionId: next.positionId, positionOther: next.positionOther },
    });

    await writeAuditEvent(tx, {
      action: "employee.position_changed",
      actorEmployeeId: actorId,
      targetEmployeeId: employeeId,
      metadata: {
        from: previous,
        usedFreeTextPosition: next.positionOther !== null,
        // Distinguishes "I changed mine" from "an admin changed mine" at a
        // glance, without comparing two ids in the audit list.
        self: actorId === employeeId,
      },
    });
  });

  return { ok: true, data: next };
}

export interface DepartmentChanged {
  departmentId: string;
  name: string;
}

/**
 * Admin-only. Department is not self-reported: it drives the admin employee
 * filter, and an employee changing their own would make that filter a record of
 * what people call themselves rather than of how the company is organised.
 *
 * The route is what enforces admin. This function does not check, for the same
 * reason setStatus does not: authorization belongs at the boundary, once, where
 * it can be seen.
 */
export async function setDepartment(
  actorId: string,
  employeeId: string,
  departmentId: string,
): Promise<ProfileResult<DepartmentChanged>> {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      id: true,
      departmentId: true,
      department: { select: { name: true } },
    },
  });
  if (employee === null) return fail("not_found", "Employee not found.");

  const department = await prisma.department.findFirst({
    where: { id: departmentId, status: "active" },
    select: { id: true, name: true },
  });
  if (department === null) {
    return fail("invalid_department", "Select a department from the list.");
  }

  if (employee.departmentId === departmentId) {
    return { ok: true, data: { departmentId, name: department.name } };
  }

  const previous = employee.department?.name ?? null;

  await prisma.$transaction(async (tx) => {
    await tx.employee.update({
      where: { id: employeeId },
      data: { departmentId },
    });

    await writeAuditEvent(tx, {
      action: "employee.department_changed",
      actorEmployeeId: actorId,
      targetEmployeeId: employeeId,
      // The same action string and the same from/to shape the
      // 20260817000000_replace_departments migration writes, so the audit list
      // reads consistently whether the platform or a person made the change.
      metadata: { from: previous, to: department.name },
    });
  });

  return { ok: true, data: { departmentId, name: department.name } };
}
