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

  /**
   * This person's own history, inline.
   *
   * PHASE-10: "the common question is 'why does this person have access' and it
   * should be answerable without leaving the page."
   *
   * Rows where they are the TARGET, plus rows where they were the ACTOR on
   * themselves - which is the same set, since an actor-on-self row also carries
   * them as the target. Selected through AUDIT_SELECT so the same describe()
   * renders it as the audit page; a second, narrower select is how the two
   * views would drift.
   */
  const auditHistory = await prisma.auditEvent.findMany({
    where: { targetEmployeeId: employeeId },
    select: AUDIT_SELECT,
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
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

/**
 * The fields every audit reader needs.
 *
 * Names as well as emails, because the whole point of Phase 10 is that
 * `grant.added` beside two UUIDs is not an answer - see
 * ./audit-describe.ts, which turns one of these into a sentence.
 */
const AUDIT_SELECT = {
  id: true,
  action: true,
  moduleKey: true,
  metadata: true,
  occurredAt: true,
  actor: { select: { id: true, firstName: true, lastName: true, email: true } },
  target: { select: { id: true, firstName: true, lastName: true, email: true } },
} as const;

/**
 * Turns the `to` bound into an exclusive upper limit.
 *
 * A bare date from a filter means "up to the end of that day", so `to=2026-09-12`
 * has to include everything on the 12th. Adding a day and comparing with `lt` is
 * exact where `lte` on midnight would silently exclude all but the first instant
 * of it - a filter that drops a day of history is the kind of quiet wrongness
 * this whole phase exists to remove.
 *
 * A `to` that carries a time is used as given.
 */
function exclusiveUpperBound(to: Date): Date {
  const midnightUtc =
    to.getUTCHours() === 0 &&
    to.getUTCMinutes() === 0 &&
    to.getUTCSeconds() === 0 &&
    to.getUTCMilliseconds() === 0;

  if (!midnightUtc) return to;

  const next = new Date(to);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

export async function listAuditEvents(query: AuditQuery) {
  const { targetEmployeeId, actorEmployeeId, action, from, to, page, pageSize } =
    query;

  const occurredAt =
    from === undefined && to === undefined
      ? {}
      : {
          occurredAt: {
            ...(from !== undefined ? { gte: from } : {}),
            ...(to !== undefined ? { lt: exclusiveUpperBound(to) } : {}),
          },
        };

  const where = {
    ...(targetEmployeeId !== undefined ? { targetEmployeeId } : {}),
    ...(actorEmployeeId !== undefined ? { actorEmployeeId } : {}),
    ...(action !== undefined && action.length > 0 ? { action } : {}),
    ...occurredAt,
  };

  const [total, events] = await Promise.all([
    prisma.auditEvent.count({ where }),
    prisma.auditEvent.findMany({
      where,
      select: AUDIT_SELECT,
      // Newest first, with id as the tiebreak. Two events written inside one
      // transaction can share a timestamp, and a list that reorders itself
      // between two identical requests is not a log.
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
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

/**
 * The people who appear in the audit log, for the filter dropdowns.
 *
 * Distinct actors and targets rather than every employee. Two reasons, and the
 * second is the one that matters: the list is far shorter - actors are
 * essentially the admins - and every option in it returns at least one row, so
 * the filter cannot offer a choice that produces an empty page. A dropdown of
 * 130 names where 120 of them yield nothing is worse than no dropdown.
 */
export async function auditFilterOptions() {
  const [actorIds, targetIds] = await Promise.all([
    prisma.auditEvent.findMany({
      where: { actorEmployeeId: { not: null } },
      select: { actorEmployeeId: true },
      distinct: ["actorEmployeeId"],
    }),
    prisma.auditEvent.findMany({
      where: { targetEmployeeId: { not: null } },
      select: { targetEmployeeId: true },
      distinct: ["targetEmployeeId"],
    }),
  ]);

  const ids = new Set<string>();
  for (const row of actorIds) if (row.actorEmployeeId !== null) ids.add(row.actorEmployeeId);
  for (const row of targetIds) if (row.targetEmployeeId !== null) ids.add(row.targetEmployeeId);

  const people = await prisma.employee.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, firstName: true, lastName: true, email: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  const byId = new Map(people.map((p) => [p.id, p]));
  const pick = (rows: { id: string | null }[]) =>
    rows
      .map((r) => (r.id === null ? undefined : byId.get(r.id)))
      .filter((p): p is (typeof people)[number] => p !== undefined);

  return {
    actors: pick(actorIds.map((r) => ({ id: r.actorEmployeeId }))),
    targets: pick(targetIds.map((r) => ({ id: r.targetEmployeeId }))),
  };
}

/**
 * Module display names, for rendering audit rows and the grant matrix.
 *
 * Includes inactive modules deliberately: an audit row naming a module that has
 * since been deactivated still has to render, and falling back to the raw key
 * there would make old history read worse than new history for no reason.
 */
export async function moduleDisplayNames(): Promise<Map<string, string>> {
  const modules = await prisma.module.findMany({
    select: { key: true, displayName: true },
  });
  return new Map(modules.map((m) => [m.key, m.displayName]));
}
