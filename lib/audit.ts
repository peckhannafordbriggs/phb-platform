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
  /**
   * Module-admin rights on an existing grant (B7.2) - for `bas`, the Settings
   * tab. Distinct from `employee.admin_granted`, which is the platform-wide
   * flag: conflating them in the log would make "who can add a building" and
   * "who can disable an employee" the same question, and they are not.
   *
   * `moduleKey` carries which module. Revoking the grant itself writes
   * `grant.removed` and takes these rights with it, so a `grant.admin_added`
   * with no later `grant.admin_removed` does not mean the person still has it.
   */
  | "grant.admin_added"
  | "grant.admin_removed"
  /**
   * BAS settings (B7.3). Projects and buildings, created and edited in the
   * Settings tab rather than by hand in psql.
   *
   * No `targetEmployeeId` - the subject is a building, not a person, and the
   * column means "which employee this was done TO". The ids and names live in
   * `metadata`, which is also where `previousName` and `previousTimezone` go:
   * an update overwrites the row it describes, so the log is the only place the
   * old value survives.
   *
   * `previousTimezone` in particular. Every reading is stored in UTC and the
   * building's zone is what renders it locally, so moving it silently re-reads
   * years of history by a whole number of hours. Nothing else would ever say
   * when that happened.
   */
  | "bas.project_created"
  | "bas.project_updated"
  | "bas.project_deleted"
  | "bas.building_created"
  | "bas.building_updated"
  | "bas.building_deleted"
  /**
   * Stations and their Niagara logins (B7.4).
   *
   * `bas.credential_set` carries the station, the USERNAME and the key version.
   * Never the password.
   *
   * The username was left out at first, on the grounds that audit_events is
   * append-only so anything written here can never be redacted. That reasoning
   * was backwards. Append-only is the reason TO record it: changing a station's
   * login from `bas_collector` to `admin` is a privilege escalation on a
   * building controller, and a log saying only "the credential changed" cannot
   * show that. A username is not a secret. The password is, and it is not here.
   */
  | "bas.station_created"
  | "bas.station_updated"
  | "bas.station_deleted"
  | "bas.credential_set"
  | "bas.credential_cleared"
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
