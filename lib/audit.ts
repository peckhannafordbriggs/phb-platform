import type { Prisma, PrismaClient } from "@/lib/generated/prisma/client";

/**
 * Audit action strings. Deliberately a union of literals rather than a database
 * enum: later phases add mail and job actions without a migration.
 *
 * docs/05-database-and-sources.md fixes the Phase 1 set.
 */
export type AuditAction =
  | "login.denied"
  | "employee.provisioned"
  | "employee.profile_completed"
  | "employee.enabled"
  | "employee.disabled"
  | "employee.admin_granted"
  | "employee.admin_revoked"
  | "grant.added"
  | "grant.removed"
  | "position.created"
  | "position.updated"
  | "department.created"
  | "department.updated";

export interface AuditEventInput {
  action: AuditAction;
  /** Null means the platform acted, not a person. */
  actorEmployeeId?: string | null;
  /** Null for events with no employee subject - notably login.denied. */
  targetEmployeeId?: string | null;
  moduleKey?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Accepts either the base client or a transaction client, so a caller can write
 * the audit row in the same transaction as the change it describes. A mutation
 * that succeeds without its audit row should not be possible.
 */
type AuditWriter = Pick<PrismaClient, "auditEvent">;

export async function writeAuditEvent(
  db: AuditWriter,
  event: AuditEventInput,
): Promise<void> {
  await db.auditEvent.create({
    data: {
      action: event.action,
      actorEmployeeId: event.actorEmployeeId ?? null,
      targetEmployeeId: event.targetEmployeeId ?? null,
      moduleKey: event.moduleKey ?? null,
      metadata:
        event.metadata === undefined || event.metadata === null
          ? undefined
          : (event.metadata as Prisma.InputJsonValue),
    },
  });
}
