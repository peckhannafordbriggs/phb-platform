import type { AuditAction } from "@/lib/audit";

/**
 * Turning an audit row into a sentence a person can read.
 *
 * This is the point of Phase 10. The table has been written correctly since
 * Phase 3 and read with difficulty ever since: `grant.added` beside two UUIDs is
 * a record, not an answer. Under app-only Graph auth Exchange records the
 * *application* as the sender rather than the person, so for anything touching
 * mail this table is the only record of who did it — which makes "unreadable"
 * closer to "unavailable" than it sounds.
 *
 * Pure, and deliberately separate from the service: it takes a row and a lookup
 * of module display names, and returns a description. No database, no React, so
 * the wording is testable on its own and the same function renders the audit
 * page and the inline history on an employee's detail page. Two renderers would
 * eventually disagree about what an action means.
 */

export interface AuditParty {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
}

/** The shape the service selects. Narrower than the Prisma row on purpose. */
export interface DescribableAuditEvent {
  action: string;
  moduleKey: string | null;
  metadata: unknown;
  actor: AuditParty | null;
  target: AuditParty | null;
}

export interface AuditDescription {
  /** The whole event as one sentence, without the timestamp. */
  sentence: string;
  /** Who acted. "The platform" when the actor is null. */
  actorLabel: string;
  /** Who it was done to, or null for events with no employee subject. */
  targetLabel: string | null;
  /**
   * The target changed their own record rather than an admin changing it.
   *
   * PHASE-10 asks for this specifically. It is recorded two ways and both are
   * honoured: `metadata.self`, written by the position path since Phase 3, and
   * actor id equal to target id, which covers every other action without
   * needing the metadata to have been written.
   */
  self: boolean;
  /**
   * False when the action is not one this file knows.
   *
   * Later phases add actions — mail, jobs — and an audit viewer that invented
   * plausible prose for an action it did not recognise would be worse than one
   * that admitted it. An unknown action renders its raw name.
   */
  known: boolean;
}

/** Display name, falling back to the email, then to something honest. */
function nameOf(party: AuditParty | null): string {
  if (party === null) return "The platform";

  const full = [party.firstName, party.lastName]
    .filter((part): part is string => part !== null && part.trim().length > 0)
    .join(" ")
    .trim();

  return full.length > 0 ? full : party.email;
}

function metadataOf(event: DescribableAuditEvent): Record<string, unknown> {
  const raw = event.metadata;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

function stringField(meta: Record<string, unknown>, key: string): string | null {
  const value = meta[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A module's display name, or its key when the module is not in the lookup.
 *
 * The key is the fallback rather than a guess, because a module can be
 * deactivated or renamed and its old audit rows still have to render. Nothing
 * here knows any particular module — CLAUDE.md and PHASE-10 both forbid
 * hardcoding a module key, and a lookup keyed on the stable `key` is how this
 * file stays ignorant of which modules exist.
 */
function moduleLabel(
  moduleKey: string | null,
  moduleNames: ReadonlyMap<string, string>,
): string {
  if (moduleKey === null || moduleKey.length === 0) return "a module";
  return moduleNames.get(moduleKey) ?? moduleKey;
}

/**
 * The known actions, as sentence builders.
 *
 * Keyed by the same literals as `AuditAction` so adding a member there without
 * adding a case here is visible: `KNOWN_ACTIONS` is typed as a total record, so
 * this file stops compiling.
 */
type SentenceBuilder = (context: {
  actor: string;
  target: string | null;
  module: string;
  meta: Record<string, unknown>;
  self: boolean;
}) => string;

const KNOWN_ACTIONS: Record<AuditAction, SentenceBuilder> = {
  "login.denied": ({ meta }) => {
    const reason = stringField(meta, "reason");
    const email = stringField(meta, "email");
    const who = email ?? "Someone";
    return reason === null
      ? `${who} was denied sign-in`
      : `${who} was denied sign-in — ${reason}`;
  },

  "employee.provisioned": ({ target }) =>
    `${target ?? "An employee"} signed in for the first time and was added with no access`,

  "employee.profile_completed": ({ target }) =>
    `${target ?? "An employee"} completed their profile`,

  "employee.enabled": ({ actor, target }) =>
    `${actor} re-enabled ${target ?? "an employee"}`,

  "employee.disabled": ({ actor, target }) =>
    `${actor} disabled ${target ?? "an employee"}`,

  "employee.admin_granted": ({ actor, target }) =>
    `${actor} made ${target ?? "an employee"} a platform administrator`,

  "employee.admin_revoked": ({ actor, target }) =>
    `${actor} removed platform administrator access from ${target ?? "an employee"}`,

  "grant.added": ({ actor, target, module }) =>
    `${actor} granted ${module} to ${target ?? "an employee"}`,

  "grant.removed": ({ actor, target, module }) =>
    `${actor} revoked ${module} from ${target ?? "an employee"}`,

  // "administrator for", not "administrator" - the sentence has to survive
  // being read next to employee.admin_granted without the two looking alike.
  "grant.admin_added": ({ actor, target, module }) =>
    `${actor} made ${target ?? "an employee"} an administrator for ${module}`,

  // Named subjects, because "created a project" with two UUIDs beside it is the
  // exact unreadability audit-describe exists to fix. The name comes from
  // metadata rather than a join: the row it describes may since have been
  // renamed or deleted, and the log should say what happened at the time.
  "bas.project_created": ({ actor, meta }) =>
    `${actor} created the project ${stringField(meta, "name") ?? "(unnamed)"}`,

  "bas.project_updated": ({ actor, meta }) => {
    const name = stringField(meta, "name") ?? "a project";
    const previous = stringField(meta, "previousName");
    return previous !== null && previous !== name
      ? `${actor} renamed the project ${previous} to ${name}`
      : `${actor} updated the project ${name}`;
  },

  "bas.project_deleted": ({ actor, meta }) =>
    `${actor} deleted the project ${stringField(meta, "name") ?? "(unnamed)"}`,

  "bas.building_created": ({ actor, meta }) =>
    `${actor} added the building ${stringField(meta, "name") ?? "(unnamed)"}` +
    `${stringField(meta, "timezone") !== null ? ` (${stringField(meta, "timezone")})` : ""}`,

  "bas.building_updated": ({ actor, meta }) => {
    const name = stringField(meta, "name") ?? "a building";
    const previousName = stringField(meta, "previousName");
    const zone = stringField(meta, "timezone");
    const previousZone = stringField(meta, "previousTimezone");

    // The timezone is called out ahead of a rename. A rename is cosmetic; a
    // zone change silently re-reads every stored reading in that building.
    if (zone !== null && previousZone !== null && zone !== previousZone) {
      return `${actor} changed ${name}'s timezone from ${previousZone} to ${zone}`;
    }
    return previousName !== null && previousName !== name
      ? `${actor} renamed the building ${previousName} to ${name}`
      : `${actor} updated the building ${name}`;
  },

  "bas.building_deleted": ({ actor, meta }) =>
    `${actor} deleted the building ${stringField(meta, "name") ?? "(unnamed)"}`,

  "bas.station_created": ({ actor, meta }) =>
    `${actor} registered the station ${stringField(meta, "niagaraStationName") ?? "(unnamed)"}`,

  "bas.station_updated": ({ actor, meta }) => {
    const name = stringField(meta, "niagaraStationName") ?? "a station";
    const previous = stringField(meta, "previousNiagaraStationName");
    const mode = stringField(meta, "connectionMode");
    const previousMode = stringField(meta, "previousConnectionMode");

    // A renamed Niagara station is not cosmetic - that string is in every oBIX
    // URL - so it is called out ahead of a mode change.
    if (previous !== null && previous !== name) {
      return `${actor} renamed the station ${previous} to ${name}`;
    }
    if (mode !== null && previousMode !== null && mode !== previousMode) {
      return `${actor} changed how ${name} is reached, from ${previousMode} to ${mode}`;
    }
    return `${actor} updated the station ${name}`;
  },

  "bas.station_deleted": ({ actor, meta }) =>
    `${actor} deleted the station ${stringField(meta, "niagaraStationName") ?? "(unnamed)"}`,

  // Names the account. "The login changed" cannot show an escalation from
  // bas_collector to admin; "changed it to admin" can. The password is not here
  // and never will be - see the note on the action in lib/audit.ts.
  "bas.credential_set": ({ actor, meta }) => {
    const username = stringField(meta, "username");
    const station = stringField(meta, "stationId") ?? "(unknown)";
    return username === null
      ? `${actor} set the Niagara login for station ${station}`
      : `${actor} set the Niagara login for station ${station} to ${username}`;
  },

  "bas.credential_cleared": ({ actor, meta }) =>
    `${actor} removed the stored Niagara login for station ${stringField(meta, "stationId") ?? "(unknown)"}`,

  "grant.admin_removed": ({ actor, target, module }) =>
    `${actor} removed ${target ?? "an employee"}'s administrator access for ${module}`,

  "position.created": ({ actor, meta }) => {
    const name = stringField(meta, "name");
    return `${actor} added the position ${name ?? "(unnamed)"}`;
  },

  "position.updated": ({ actor, meta }) => {
    const name = stringField(meta, "name");
    const status = stringField(meta, "status");
    if (status === "hidden") {
      return `${actor} hid the position ${name ?? "(unnamed)"} from the list`;
    }
    if (status === "active") {
      return `${actor} restored the position ${name ?? "(unnamed)"} to the list`;
    }
    return `${actor} renamed a position to ${name ?? "(unnamed)"}`;
  },

  "department.created": ({ actor, meta }) => {
    const name = stringField(meta, "name");
    return `${actor} added the department ${name ?? "(unnamed)"}`;
  },

  "department.updated": ({ actor, meta }) => {
    const name = stringField(meta, "name");
    const status = stringField(meta, "status");
    if (status === "hidden") {
      return `${actor} hid the department ${name ?? "(unnamed)"} from the list`;
    }
    if (status === "active") {
      return `${actor} restored the department ${name ?? "(unnamed)"} to the list`;
    }
    return `${actor} renamed a department to ${name ?? "(unnamed)"}`;
  },

  "department.deleted": ({ actor, meta }) => {
    const name = stringField(meta, "name");
    return `${actor} removed the department ${name ?? "(unnamed)"}`;
  },

  /**
   * The one PHASE-10 calls out by name.
   *
   * An employee setting their own position and an admin setting it for them are
   * the same write through the same service, and the difference is exactly what
   * an admin looking at the log wants to see.
   */
  "employee.position_changed": ({ actor, target, meta, self }) => {
    const from = stringField(meta, "from");
    const wasFreeText = meta.usedFreeTextPosition === true;
    const suffix = from === null ? "" : ` (previously ${from})`;
    const flag = wasFreeText ? ", entered as free text" : "";

    return self
      ? `${target ?? actor} changed their own position${suffix}${flag}`
      : `${actor} changed the position of ${target ?? "an employee"}${suffix}${flag}`;
  },

  "employee.department_changed": ({ actor, target, meta, self }) => {
    const from = stringField(meta, "from");
    const suffix = from === null ? "" : ` (previously ${from})`;

    return self
      ? `${target ?? actor} changed their own department${suffix}`
      : `${actor} changed the department of ${target ?? "an employee"}${suffix}`;
  },

  "mail.draft_edited": ({ actor, meta }) => {
    const subject = stringField(meta, "subject");
    return `${actor} edited a draft${subject === null ? "" : `: ${subject}`}`;
  },

  /**
   * The most important row in the table.
   *
   * Under app-only auth Exchange records the application as the sender, so this
   * is the only record anywhere of which person sent a message to a vendor.
   */
  "mail.sent": ({ actor, meta }) => {
    const subject = stringField(meta, "subject");
    const recipients = Array.isArray(meta.recipients)
      ? meta.recipients.filter((r): r is string => typeof r === "string")
      : [];

    const to =
      recipients.length === 0
        ? ""
        : ` to ${recipients.slice(0, 3).join(", ")}${
            recipients.length > 3 ? ` +${recipients.length - 3} more` : ""
          }`;

    return `${actor} sent${subject === null ? " a message" : ` "${subject}"`}${to}`;
  },

  "mail.moved": ({ actor, meta }) => {
    const subject = stringField(meta, "subject");
    const destination = stringField(meta, "destinationFolderId");
    return `${actor} moved${subject === null ? " a message" : ` "${subject}"`}${
      destination === null ? "" : " to another folder"
    }`;
  },

  "mail.deleted": ({ actor, meta }) => {
    const subject = stringField(meta, "subject");
    // Deliberately "to Deleted Items": the platform's delete is a move, and a
    // log line reading "deleted" alone would overstate what happened.
    return `${actor} moved${
      subject === null ? " a message" : ` "${subject}"`
    } to Deleted Items`;
  },

  "mail.draft_created": ({ actor, meta }) => {
    const mode = stringField(meta, "mode");
    const subject = stringField(meta, "subject");
    const kind =
      mode === "reply"
        ? "a reply"
        : mode === "replyAll"
          ? "a reply-all"
          : mode === "forward"
            ? "a forward"
            : "a draft";
    return `${actor} created ${kind}${subject === null ? "" : `: ${subject}`}`;
  },

  "mail.attachment_added": ({ actor, meta }) => {
    const name = stringField(meta, "name");
    return `${actor} attached ${name ?? "a file"} to a draft`;
  },

  "mail.attachment_removed": ({ actor, meta }) => {
    const name = stringField(meta, "name");
    return `${actor} removed ${name ?? "a file"} from a draft`;
  },
};

/**
 * Describes one audit row.
 *
 * `moduleNames` maps a module key to its display name. Pass an empty map and
 * every module renders as its key, which is degraded but never wrong.
 */
export function describeAuditEvent(
  event: DescribableAuditEvent,
  moduleNames: ReadonlyMap<string, string> = new Map(),
): AuditDescription {
  const meta = metadataOf(event);
  const actorLabel = nameOf(event.actor);
  const targetLabel = event.target === null ? null : nameOf(event.target);

  const self =
    meta.self === true ||
    (event.actor !== null &&
      event.target !== null &&
      event.actor.id === event.target.id);

  const builder = KNOWN_ACTIONS[event.action as AuditAction] as
    | SentenceBuilder
    | undefined;

  if (builder === undefined) {
    /**
     * An action this file has never heard of. Say so rather than guess.
     *
     * This is the path a later phase's new action takes before anyone writes a
     * case for it, and it has to stay legible: the raw action name plus whoever
     * was involved is a worse sentence than the others and an honest one.
     */
    return {
      sentence:
        targetLabel === null
          ? `${actorLabel} — ${event.action}`
          : `${actorLabel} — ${event.action} — ${targetLabel}`,
      actorLabel,
      targetLabel,
      self,
      known: false,
    };
  }

  return {
    sentence: builder({
      actor: actorLabel,
      target: targetLabel,
      module: moduleLabel(event.moduleKey, moduleNames),
      meta,
      self,
    }),
    actorLabel,
    targetLabel,
    self,
    known: true,
  };
}

/**
 * Short labels for the action filter.
 *
 * A separate record from the sentence builders because a dropdown option and a
 * sentence are different registers - "Granted a module" reads correctly in a
 * list of choices where "Jim Schwarz granted Change Orders to Sarah Martin"
 * does not. Typed as a total record over AuditAction for the same reason
 * KNOWN_ACTIONS is: adding an action without labelling it stops the build.
 */
const ACTION_LABELS: Record<AuditAction, string> = {
  "login.denied": "Sign-in denied",
  "employee.provisioned": "First sign-in",
  "employee.profile_completed": "Profile completed",
  "employee.enabled": "Employee enabled",
  "employee.disabled": "Employee disabled",
  "employee.admin_granted": "Made an administrator",
  "employee.admin_revoked": "Administrator access removed",
  "grant.added": "Module granted",
  "grant.removed": "Module revoked",
  "grant.admin_added": "Made a module administrator",
  "grant.admin_removed": "Module administrator access removed",
  "bas.project_created": "BAS project created",
  "bas.project_updated": "BAS project updated",
  "bas.project_deleted": "BAS project deleted",
  "bas.building_created": "BAS building added",
  "bas.building_updated": "BAS building updated",
  "bas.building_deleted": "BAS building deleted",
  "bas.station_created": "BAS station registered",
  "bas.station_updated": "BAS station updated",
  "bas.station_deleted": "BAS station deleted",
  "bas.credential_set": "BAS station login set",
  "bas.credential_cleared": "BAS station login removed",
  "position.created": "Position added",
  "position.updated": "Position renamed or hidden",
  "department.created": "Department added",
  "department.updated": "Department renamed or hidden",
  "department.deleted": "Department removed",
  "employee.position_changed": "Position changed",
  "employee.department_changed": "Department changed",
  "mail.draft_edited": "Draft edited",
  "mail.sent": "Message sent",
  "mail.moved": "Message moved",
  "mail.deleted": "Message deleted",
  "mail.draft_created": "Draft created",
  "mail.attachment_added": "Attachment added",
  "mail.attachment_removed": "Attachment removed",
};

/** The label for one action, or the raw name when it is not a known action. */
export function auditActionLabel(action: string): string {
  return ACTION_LABELS[action as AuditAction] ?? action;
}

/**
 * The actions offered in the audit filter, ordered for a dropdown.
 *
 * Derived from the same record the renderer uses, so the filter cannot offer an
 * action nothing knows how to describe, and cannot omit one it does. Sorted by
 * label rather than by key, because the key's dotted prefix groups by
 * implementation detail and the label groups by what somebody is looking for.
 */
export function knownAuditActions(): { action: AuditAction; label: string }[] {
  return (Object.keys(KNOWN_ACTIONS) as AuditAction[])
    .map((action) => ({ action, label: ACTION_LABELS[action] }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
