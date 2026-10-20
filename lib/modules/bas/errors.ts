/**
 * Typed failures from the BAS service, modelled on
 * lib/modules/change-orders/mail/errors.ts.
 *
 * The service raises a `code`; only the route layer turns one into an HTTP
 * status. A component branches on the code, never on a status and never on a
 * database message.
 */
export type BasErrorCode =
  /**
   * A site was asked for that this employee cannot see - because it does not
   * exist, or because it exists and they have no grant for it.
   *
   * Deliberately one code for both. Answering "that building exists but is not
   * yours" differently from "there is no such building" is the same disclosure
   * the module guard already refuses to make when it returns 404 rather than 403
   * for a missing grant. Today every employee holding the module sees every
   * site, so only the first case is reachable; the second becomes reachable the
   * day `bas_site_grant` exists, and it must not need a second look then.
   */
  | "site_not_found"
  /**
   * A point was asked for that is not in the picker's list for this employee and
   * this building filter - it does not exist, is inactive, or belongs to a site
   * they cannot see.
   *
   * Refused rather than quietly replaced with the first available point. A
   * silent swap would render one point's readings under another point's name in
   * the URL, which is worse than an error: it is wrong and it looks fine.
   */
  | "point_not_found"
  /**
   * A custom date range the trend cannot be measured over: the end before the
   * start, an end in the future (in the building's zone), or a date that is
   * not a date. The message names which, and the route answers 422 - the
   * request was understood and is wrong, which is not the same as not found.
   */
  | "invalid_range"
  // --- Settings (B7.3). Everything below is a write refusing to happen. ---
  /** No such project, or none this employee may see. Same conflation as above. */
  | "project_not_found"
  /** No such building. `site_not_found` is the read-side equivalent. */
  | "building_not_found"
  /** No such organisation to hang a project on. */
  | "org_not_found"
  /**
   * A project name already used in that org, or a building name already used in
   * that PROJECT - not in that org. Two projects may each hold a "North
   * Building"; that is why the unique key moved in B7.1.
   */
  | "name_taken"
  /**
   * A project still has buildings, or a building still has stations.
   *
   * The foreign keys are RESTRICT, so the database would refuse this anyway.
   * Checking first is not redundant: it turns a Prisma foreign-key error naming
   * a constraint into a sentence naming what is in the way, and the person
   * reading it has no access to psql - which is the entire point of B7.
   */
  | "project_has_buildings"
  | "building_has_stations"
  /**
   * A timezone PostgreSQL does not recognise. Checked against
   * pg_timezone_names, because a plausible-looking wrong zone silently shifts
   * every local timestamp in the module by a whole number of hours.
   */
  | "invalid_timezone"
  // --- Stations (B7.4) ---
  /** No such station, or no such parent station. */
  | "station_not_found"
  /**
   * A parent that would make the chain loop, including a station parented to
   * itself. The self-referencing foreign key is RESTRICT, which stops a parent
   * that does not exist and says nothing at all about A -> B -> A.
   */
  | "station_cycle"
  /**
   * A station still has points, child stations, or recorded collector runs.
   *
   * Its readings exist nowhere else: the station overwrote them roughly 42
   * hours after recording them. Deletion is refused rather than cascaded, and
   * the message offers "mark it inactive" instead.
   */
  | "station_has_points"
  // --- Roles and equipment (B8.5) ---
  /**
   * A role that is not in bas_point_roles. 422, like `invalid_timezone`: the
   * request was understood and names a value that does not exist. The
   * vocabulary is not editable from here, so there is nothing to create.
   */
  | "role_not_found"
  /** An equipment type that is not in bas_equipment_types. Same class as above. */
  | "equipment_type_not_found"
  /**
   * No such equipment, or none this employee may see. Same conflation as every
   * other not-found in this module.
   */
  | "equipment_not_found"
  /**
   * Equipment on a different building from a point it was to be assigned to.
   * Equipment belongs to a building (bas_equipment.site_id) and the pairing
   * views join through it, so a point on building A attached to an RTU on
   * building B would pair with B's setpoints. 409: well-formed, refused by the
   * world. Said plainly rather than conflated with not-found, because the
   * viewer can already see both buildings.
   */
  | "equipment_other_building"
  /**
   * A parent that would make the equipment chain loop, including a parent of
   * itself. The FK is RESTRICT and says nothing about A -> B -> A.
   */
  | "equipment_cycle"
  /** Equipment that still has points attached or equipment under it. Refused, never cascaded. */
  | "equipment_in_use"
  /**
   * A point whose station is attached to no building cannot be given
   * equipment: there is no building to look the equipment up on. Attach the
   * station first. 409.
   */
  | "station_unassigned";

export class BasError extends Error {
  constructor(
    readonly code: BasErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BasError";
  }
}
