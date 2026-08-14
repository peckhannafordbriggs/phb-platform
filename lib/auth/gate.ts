/**
 * The login gate - checks 1 through 3 of the four required by
 * docs/04-auth-and-permissions.md.
 *
 * This module is deliberately pure: no database, no network, no environment
 * reads. Everything it needs is passed in, so the whole gate is unit-testable
 * against synthetic token claims without a tenant or a database.
 *
 * Check 4 (employee row is not disabled) needs the database and lives in
 * lib/auth/signin.ts.
 */

export type GateDenialReason =
  | "tenant_mismatch"
  | "domain_not_allowed"
  | "guest_account"
  | "missing_claims";

export interface TokenClaims {
  tid?: unknown;
  oid?: unknown;
  email?: unknown;
  preferred_username?: unknown;
  upn?: unknown;
  given_name?: unknown;
  family_name?: unknown;
  name?: unknown;
}

/** What the platform keeps from a token once the gate has passed. */
export interface GatedIdentity {
  entraOid: string;
  email: string;
  firstName: string;
  lastName: string;
}

export type GateResult =
  | { ok: true; identity: GatedIdentity }
  | { ok: false; reason: GateDenialReason; email: string | null };

export interface GateConfig {
  tenantId: string;
  /** Lowercased, no leading '@'. */
  allowedDomains: readonly string[];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

/**
 * B2B guests have real accounts in the tenant, so single-tenant configuration
 * does not exclude them. Their UPN is mangled to contain '#EXT#'.
 */
function looksLikeGuest(values: readonly (string | null)[]): boolean {
  return values.some((v) => v !== null && v.toUpperCase().includes("#EXT#"));
}

function splitDisplayName(name: string | null): [string, string] {
  if (name === null) return ["", ""];
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return ["", ""];
  if (parts.length === 1) return [parts[0] ?? "", ""];
  return [parts[0] ?? "", parts.slice(1).join(" ")];
}

export function evaluateGate(
  claims: TokenClaims,
  config: GateConfig,
): GateResult {
  const upn = asString(claims.upn);
  const preferredUsername = asString(claims.preferred_username);
  const emailClaim = asString(claims.email);

  // The address the platform will key on. Entra does not always populate
  // `email`; `preferred_username` carries the UPN in that case.
  const rawEmail = emailClaim ?? preferredUsername ?? upn;
  const email = rawEmail === null ? null : rawEmail.toLowerCase();

  // Check 1 - tenant. The single-tenant app setting is not sufficient
  // verification on its own; the token must actually say so.
  const tid = asString(claims.tid);
  if (tid === null || tid !== config.tenantId) {
    return { ok: false, reason: "tenant_mismatch", email };
  }

  // Check 3 - guests. Evaluated before the domain check so a guest is reported
  // as a guest rather than as a domain failure.
  if (looksLikeGuest([upn, preferredUsername, emailClaim])) {
    return { ok: false, reason: "guest_account", email };
  }

  const oid = asString(claims.oid);
  if (oid === null || email === null) {
    return { ok: false, reason: "missing_claims", email };
  }

  // Check 2 - domain. The tenant has more than one verified domain, so this is
  // configured rather than hardcoded.
  const domain = domainOf(email);
  if (domain === null || !config.allowedDomains.includes(domain)) {
    return { ok: false, reason: "domain_not_allowed", email };
  }

  const [fallbackFirst, fallbackLast] = splitDisplayName(asString(claims.name));
  const localPart = email.slice(0, email.lastIndexOf("@"));

  // ?? is not enough here: splitDisplayName returns "" rather than null when
  // there is no display name, and "" is not nullish. firstName is NOT NULL in
  // the schema and an empty one would leave an unidentifiable row in the admin
  // list, so fall back to the address local part.
  const firstName =
    asString(claims.given_name) ??
    (fallbackFirst.length > 0 ? fallbackFirst : localPart);

  return {
    ok: true,
    identity: {
      entraOid: oid,
      email,
      // Directory display names are often badly formatted; onboarding lets the
      // employee correct these. They only need to be non-empty here.
      firstName,
      lastName: asString(claims.family_name) ?? fallbackLast,
    },
  };
}
