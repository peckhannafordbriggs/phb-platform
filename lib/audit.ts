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
  | "department.updated"
  /**
   * Profile field changes. `employee.position_changed` is written by both the
   * self-service route and the admin route - `actorEmployeeId` is what tells them
   * apart. `employee.department_changed` is admin-only, and is also written by
   * the 20260817000000_replace_departments migration with a null actor, which is
   * the honest record for the platform acting rather than a person.
   */
  | "employee.position_changed"
  | "employee.department_changed"
  /** Written only by that migration. No application path deletes a department. */
  | "department.deleted"
  /**
   * Mail. `mail.sent` is the important one and is not logging: under app-only
   * auth Exchange records the application as the sender, not the person, so this
   * row is the ONLY record of who sent a message to a vendor. Its metadata
   * carries the recipients and subject deliberately - docs/07 forbids recipient
   * lists in application *logs*, which is a different thing from an audit trail
   * whose purpose is attribution.
   */
  | "mail.draft_edited"
  | "mail.sent"
  /**
   * Phase 8. `mail.moved` and `mail.deleted` are the two the phase requires,
   * and for the same reason as `mail.sent`: under app-only auth Exchange records
   * the application as having done it, so this row is the only record of which
   * person did.
   *
   * A delete is recoverable - it goes to Deleted Items - so this row is what
   * tells an operator where a message went, not a record of destruction.
   */
  | "mail.moved"
  | "mail.deleted"
  /**
   * A draft the platform created: composed from scratch, or derived from a
   * message by reply, reply-all or forward. The metadata says which, and what it
   * came from, because a reply draft nobody remembers making is otherwise
   * indistinguishable from one the automation produced.
   */
  | "mail.draft_created"
  /** Attachment metadata only - the name and size, never the content. */
  | "mail.attachment_added"
  | "mail.attachment_removed";

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
