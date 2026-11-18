/**
 * Who counts as external (Reports, Phase 1).
 *
 * The plan (§A, Recipients): any address is allowed, and an address outside
 * the company gets a warn-and-confirm step and an audit entry that says so.
 * "Outside the company" is decided here, once, by the domain: anything that
 * is not @phb1899.com. The decision is recorded on the row (`is_external`)
 * and on the audit row when it is made, so a later change to this rule does
 * not rewrite history.
 *
 * Not ALLOWED_EMAIL_DOMAINS from lib/env.ts: that list is who may SIGN IN,
 * and a domain allowed to sign in is not the same question as a domain whose
 * inboxes a building's health report may go to. One company domain, named.
 */
export const COMPANY_EMAIL_DOMAIN = "phb1899.com";

/** Lower-cased and trimmed - the one spelling a recipient row stores. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isExternalAddress(email: string): boolean {
  const at = normaliseEmail(email).lastIndexOf("@");
  if (at < 0) return true;
  return normaliseEmail(email).slice(at + 1) !== COMPANY_EMAIL_DOMAIN;
}

/** The same shape the database CHECK enforces, so a 422 here and a refusal there agree. */
export const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
