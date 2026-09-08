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
  | "station_has_points";

export class BasError extends Error {
  constructor(
    readonly code: BasErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BasError";
  }
}
