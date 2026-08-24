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
  "site_not_found";

export class BasError extends Error {
  constructor(
    readonly code: BasErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BasError";
  }
}
