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
  /**
   * An admin asked the employee to complete their profile again
   * (lib/admin/service.ts, resetProfile). The only correction the platform
   * offers for a profile holding words nobody chose: the name comes from
   * Microsoft and the rest is the employee's own, so an admin edits neither.
   * `metadata.wasCompleted` records whether the profile had been completed.
   */
  | "employee.profile_reset"
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
  /**
   * A point shown or hidden on the browsing screens (B8.3). Carries `visible`
   * and `collected` - the latter so the row can never be read as "stopped
   * collecting it". Hiding costs nothing; deactivating loses data. The two are
   * different columns and this action only ever touches the first.
   */
  | "bas.point_visibility_changed"
  /**
   * A point's label set, changed or cleared (B8.4). Carries `previousLabel`
   * and `label` (NULL for "cleared - back to the Niagara name"), plus the oBIX
   * key and Niagara's own name so the row identifies the point even after a
   * later rename. Only `bas_points.label` moves; the key is never editable.
   */
  | "bas.point_label_changed"
  /**
   * A point's role or equipment set, changed or cleared (B8.5). Each carries
   * the previous and new value, the oBIX key, Niagara's name and the label,
   * so the row identifies the point after any rename. `viaBulk` and
   * `selectionSize` say whether it was one of a bulk assignment; a bulk
   * change is one row PER POINT, never one row for the selection, so the
   * history of any single point is complete on its own.
   *
   * A role is not cosmetic: the pairing views and the unclassified count
   * read it, so a wrong role changes what a point is judged against. The
   * previous value is here so a judgment that went wrong can be traced to
   * the change that caused it.
   */
  | "bas.point_role_changed"
  | "bas.point_equipment_changed"
  /**
   * Equipment created, edited or deleted (B8.5). The update row carries the
   * previous and new value of every field that moved, including the parent,
   * because reparenting a VAV under a different RTU changes which setpoints
   * it pairs with.
   */
  | "bas.equipment_created"
  | "bas.equipment_updated"
  | "bas.equipment_deleted"
  /**
   * A question typed into the Analyze tab (B5). One row per question,
   * whatever the outcome, carrying the question, the SQL that ran (or was
   * tried), the row count, the duration and the outcome kind.
   *
   * An audit row rather than only a log line because docs/BAS-B5.md says the
   * record of questions is "the only way to audit a wrong answer after the
   * fact", and container logs age out where audit_events does not. No
   * `targetEmployeeId`: the subject is a question, not a person. Nothing in
   * the metadata is a secret - the SQL runs on a role that can read nothing
   * secret, and the question is the person's own words.
   */
  | "bas.question_asked"
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
