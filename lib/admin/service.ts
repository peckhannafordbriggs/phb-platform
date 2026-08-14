import { prisma } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import type { EmployeeListQuery, AuditQuery } from "@/lib/validation/admin";

/**
 * Admin operations.
 *
 * The guardrails below are enforced here, not in the UI. Disabling a button is
 * a convenience; this is the boundary. Every mutation writes its audit event
 * inside the same transaction as the change, so a change that succeeded without
 * an audit row is not a reachable state.
 */

export type AdminFailure =
  | "not_found"
  | "self_admin_demote"
  | "self_disable"
  | "last_active_admin"
  | "unknown_module";

export type AdminResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: AdminFailure; message: string };

function fail<T>(code: AdminFailure, message: string): AdminResult<T> {
  return { ok: false, code, message };
}

/**
 * Counts admins who could still administer the platform if the given employee
 * stopped being one. Used by both guardrails that protect against locking
 * everyone out.
 */
async function otherActiveAdminCount(excludingEmployeeId: string): Promise<number> {
  return prisma.employee.count({
    where: {
      isPlatformAdmin: true,
      status: "active",
      id: { not: excludingEmployeeId },
    },
  });
}

// ---------------------------------------------------------------- employees

export async function listEmployees(query: EmployeeListQuery) {
  const { q, moduleKey, status, departmentId, scope, page, pageSize } = query;

  const where = {
    ...(status !== undefined ? { status } : {}),
    ...(departmentId !== undefined ? { departmentId } : {}),
    ...(q !== undefined && q.length > 0
      ? {
          OR: [
            { firstName: { contains: q, mode: "insensitive" as const } },
            { lastName: { contains: q, mode: "insensitive" as const } },
            { email: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
    // A module filter is a stricter form of "has at least one grant".
    ...(moduleKey !== undefined && moduleKey.length > 0
      ? { grants: { some: { moduleKey } } }
      : scope === "granted"
        ? { grants: { some: {} } }
        : {}),
  };

  const [total, employees] = await Promise.all([
    prisma.employee.count({ where }),
    prisma.employee.findMany({
      where,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        positionOther: true,
        profileCompleted: true,
        status: true,
        isPlatformAdmin: true,
        lastLoginAt: true,
        position: { select: { id: true, name: true } },
        department: { select: { id: true, name: true } },
        grants: { select: { moduleKey: true } },
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return {
    employees: employees.map(({ grants, ...employee }) => ({
      ...employee,
      grantedModuleKeys: grants.map((g) => g.moduleKey),
    })),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function getEmployeeDetail(employeeId: string) {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      positionOther: true,
      profileCompleted: true,
      status: true,
      isPlatformAdmin: true,
      firstSeenAt: true,
      lastLoginAt: true,
      position: { select: { id: true, name: true, status: true } },
      department: { select: { id: true, name: true, status: true } },
      grants: { select: { moduleKey: true, grantedAt: true } },
    },
  });

  if (employee === null) return null;

  const auditHistory = await prisma.auditEvent.findMany({
    where: { targetEmployeeId: employeeId },
    select: {
      id: true,
      action: true,
      moduleKey: true,
      metadata: true,
      occurredAt: true,
      actor: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
    orderBy: { occurredAt: "desc" },
    take: 100,
  });

  return { ...employee, auditHistory };
}

// ------------------------------------------------------------------ grants

export async function addGrant(
  actorId: string,
  employeeId: string,
  moduleKey: string,
): Promise<AdminResult<{ granted: boolean }>> {
  const [employee, moduleRow] = await Promise.all([
    prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true } }),
    prisma.module.findUnique({ where: { key: moduleKey }, select: { key: true } }),
  ]);

  if (employee === null) return fail("not_found", "Employee not found.");
  if (moduleRow === null) return fail("unknown_module", "Module not found.");

  const existing = await prisma.moduleGrant.findUnique({
    where: { employeeId_moduleKey: { employeeId, moduleKey } },
    select: { id: true },
  });

  // Idempotent: re-granting is a no-op rather than an error, and does not write
  // a second audit event.
  if (existing !== null) return { ok: true, data: { granted: false } };

  await prisma.$transaction(async (tx) => {
    await tx.moduleGrant.create({
      data: { employeeId, moduleKey, grantedById: actorId },
    });
    await writeAuditEvent(tx, {
      action: "grant.added",
      actorEmployeeId: actorId,
      targetEmployeeId: employeeId,
      moduleKey,
    });
  });

  return { ok: true, data: { granted: true } };
}

export async function removeGrant(
  actorId: string,
  employeeId: string,
  moduleKey: string,
): Promise<AdminResult<{ revoked: boolean }>> {
  const existing = await prisma.moduleGrant.findUnique({
    where: { employeeId_moduleKey: { employeeId, moduleKey } },
    select: { id: true },
  });

  if (existing === null) return { ok: true, data: { revoked: false } };

  await prisma.$transaction(async (tx) => {
    await tx.moduleGrant.delete({ where: { id: existing.id } });
    await writeAuditEvent(tx, {
      action: "grant.removed",
      actorEmployeeId: actorId,
      targetEmployeeId: employeeId,
      moduleKey,
    });
  });

  return { ok: true, data: { revoked: true } };
}

export async function bulkGrants(
  actorId: string,
  employeeIds: string[],
  moduleKey: string,
  action: "grant" | "revoke",
): Promise<AdminResult<{ changed: number }>> {
  const moduleRow = await prisma.module.findUnique({
    where: { key: moduleKey },
    select: { key: true },
  });
  if (moduleRow === null) return fail("unknown_module", "Module not found.");

  let changed = 0;
  for (const employeeId of employeeIds) {
    const result =
      action === "grant"
        ? await addGrant(actorId, employeeId, moduleKey)
        : await removeGrant(actorId, employeeId, moduleKey);

    // A missing employee in a bulk selection is skipped rather than failing the
    // whole operation; the count reports what actually happened.
    if (result.ok && ("granted" in result.data ? result.data.granted : result.data.revoked)) {
      changed += 1;
    }
  }

  return { ok: true, data: { changed } };
}

// ------------------------------------------------------- status / admin flag

export async function setStatus(
  actorId: string,
  employeeId: string,
  status: "active" | "disabled",
): Promise<AdminResult<{ status: string }>> {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, status: true, isPlatformAdmin: true },
  });
  if (employee === null) return fail("not_found", "Employee not found.");

  if (status === "disabled") {
    // Guardrail: an admin cannot disable their own account.
    if (employeeId === actorId) {
      return fail("self_disable", "You cannot disable your own account.");
    }
    // Guardrail: never leave the platform with zero active admins.
    if (employee.isPlatformAdmin && (await otherActiveAdminCount(employeeId)) === 0) {
      return fail(
        "last_active_admin",
        "This is the last active administrator. Promote someone else first.",
      );
    }
  }

  if (employee.status === status) return { ok: true, data: { status } };

  await prisma.$transaction(async (tx) => {
    await tx.employee.update({
      where: { id: employeeId },
      data: {
        status,
        // Disabling bumps sessionsValidAfter so the person is rejected on their
        // very next request rather than at next sign-out.
        ...(status === "disabled" ? { sessionsValidAfter: new Date() } : {}),
      },
    });
    await writeAuditEvent(tx, {
      action: status === "disabled" ? "employee.disabled" : "employee.enabled",
      actorEmployeeId: actorId,
      targetEmployeeId: employeeId,
    });
  });

  return { ok: true, data: { status } };
}

export async function setAdminFlag(
  actorId: string,
  employeeId: string,
  isPlatformAdmin: boolean,
): Promise<AdminResult<{ isPlatformAdmin: boolean }>> {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, isPlatformAdmin: true, status: true },
  });
  if (employee === null) return fail("not_found", "Employee not found.");

  if (!isPlatformAdmin) {
    // Guardrail: an admin cannot remove their own admin flag. Without this, one
    // wrong click needs database access to undo.
    if (employeeId === actorId) {
      return fail(
        "self_admin_demote",
        "You cannot remove your own administrator access.",
      );
    }
    // Guardrail: never leave the platform with zero active admins.
    if (employee.isPlatformAdmin && (await otherActiveAdminCount(employeeId)) === 0) {
      return fail(
        "last_active_admin",
        "This is the last active administrator. Promote someone else first.",
      );
    }
  }

  if (employee.isPlatformAdmin === isPlatformAdmin) {
    return { ok: true, data: { isPlatformAdmin } };
  }

  await prisma.$transaction(async (tx) => {
    await tx.employee.update({
      where: { id: employeeId },
      data: { isPlatformAdmin },
    });
    await writeAuditEvent(tx, {
      action: isPlatformAdmin
        ? "employee.admin_granted"
        : "employee.admin_revoked",
      actorEmployeeId: actorId,
      targetEmployeeId: employeeId,
    });
  });

  return { ok: true, data: { isPlatformAdmin } };
}

// ------------------------------------------------- positions / departments

export async function listPositions(includeHidden: boolean) {
  return prisma.position.findMany({
    where: includeHidden ? {} : { status: "active" },
    select: { id: true, name: true, status: true },
    orderBy: { name: "asc" },
  });
}

export async function listDepartments(includeHidden: boolean) {
  return prisma.department.findMany({
    where: includeHidden ? {} : { status: "active" },
    select: { id: true, name: true, status: true },
    orderBy: { name: "asc" },
  });
}

export async function createPosition(actorId: string, name: string) {
  const position = await prisma.position.create({ data: { name } });
  await writeAuditEvent(prisma, {
    action: "position.created",
    actorEmployeeId: actorId,
    metadata: { positionId: position.id, name },
  });
  return position;
}

export async function createDepartment(actorId: string, name: string) {
  const department = await prisma.department.create({ data: { name } });
  await writeAuditEvent(prisma, {
    action: "department.created",
    actorEmployeeId: actorId,
    metadata: { departmentId: department.id, name },
  });
  return department;
}

/**
 * Renaming and hiding only. There is no delete: hiding must not break employees
 * already assigned to the value, and the foreign key is ON DELETE RESTRICT so a
 * delete would fail anyway.
 */
export async function updatePosition(
  actorId: string,
  id: string,
  changes: { name?: string; status?: "active" | "hidden" },
): Promise<AdminResult<{ id: string }>> {
  const existing = await prisma.position.findUnique({ where: { id }, select: { id: true } });
  if (existing === null) return fail("not_found", "Position not found.");

  await prisma.position.update({ where: { id }, data: changes });
  await writeAuditEvent(prisma, {
    action: "position.updated",
    actorEmployeeId: actorId,
    metadata: { positionId: id, ...changes },
  });
  return { ok: true, data: { id } };
}

export async function updateDepartment(
  actorId: string,
  id: string,
  changes: { name?: string; status?: "active" | "hidden" },
): Promise<AdminResult<{ id: string }>> {
  const existing = await prisma.department.findUnique({ where: { id }, select: { id: true } });
  if (existing === null) return fail("not_found", "Department not found.");

  await prisma.department.update({ where: { id }, data: changes });
  await writeAuditEvent(prisma, {
    action: "department.updated",
    actorEmployeeId: actorId,
    metadata: { departmentId: id, ...changes },
  });
  return { ok: true, data: { id } };
}

// ------------------------------------------------------------------- audit

export async function listAuditEvents(query: AuditQuery) {
  const { targetEmployeeId, actorEmployeeId, action, page, pageSize } = query;

  const where = {
    ...(targetEmployeeId !== undefined ? { targetEmployeeId } : {}),
    ...(actorEmployeeId !== undefined ? { actorEmployeeId } : {}),
    ...(action !== undefined && action.length > 0 ? { action } : {}),
  };

  const [total, events] = await Promise.all([
    prisma.auditEvent.count({ where }),
    prisma.auditEvent.findMany({
      where,
      select: {
        id: true,
        action: true,
        moduleKey: true,
        metadata: true,
        occurredAt: true,
        actor: { select: { id: true, email: true } },
        target: { select: { id: true, email: true } },
      },
      orderBy: { occurredAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return {
    events,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
