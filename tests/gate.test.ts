import { describe, expect, it } from "vitest";
import { evaluateGate, type TokenClaims } from "@/lib/auth/gate";

/**
 * Checks 1-3 of the login gate, against synthetic claims. No tenant, no
 * network, no database - so these run before an app registration exists.
 */

const TENANT = "11111111-2222-3333-4444-555555555555";
const config = { tenantId: TENANT, allowedDomains: ["phb1899.com"] };

function claims(overrides: TokenClaims = {}): TokenClaims {
  return {
    tid: TENANT,
    oid: "oid-abc",
    email: "jane.doe@phb1899.com",
    preferred_username: "jane.doe@phb1899.com",
    given_name: "Jane",
    family_name: "Doe",
    ...overrides,
  };
}

describe("login gate", () => {
  it("accepts a company account in the configured tenant", () => {
    const result = evaluateGate(claims(), config);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity).toEqual({
      entraOid: "oid-abc",
      email: "jane.doe@phb1899.com",
      firstName: "Jane",
      lastName: "Doe",
    });
  });

  it("rejects a token from another tenant", () => {
    const result = evaluateGate(
      claims({ tid: "99999999-9999-9999-9999-999999999999" }),
      config,
    );

    expect(result).toMatchObject({ ok: false, reason: "tenant_mismatch" });
  });

  it("rejects a token with no tenant claim at all", () => {
    const result = evaluateGate(claims({ tid: undefined }), config);

    expect(result).toMatchObject({ ok: false, reason: "tenant_mismatch" });
  });

  it("rejects a domain outside the allow-list", () => {
    const result = evaluateGate(
      claims({
        email: "someone@contractor.com",
        preferred_username: "someone@contractor.com",
      }),
      config,
    );

    expect(result).toMatchObject({ ok: false, reason: "domain_not_allowed" });
  });

  it("rejects a B2B guest whose UPN contains #EXT#", () => {
    // A guest has a real account in the tenant: the tid check passes and the
    // mail domain can even look right. Only the UPN gives it away.
    const result = evaluateGate(
      claims({
        preferred_username: "vendor_outside.com#EXT#@phb1899.onmicrosoft.com",
        email: "vendor@phb1899.com",
      }),
      config,
    );

    expect(result).toMatchObject({ ok: false, reason: "guest_account" });
  });

  it("rejects a guest even when the marker is lowercase", () => {
    const result = evaluateGate(
      claims({ upn: "vendor_outside.com#ext#@phb1899.onmicrosoft.com" }),
      config,
    );

    expect(result).toMatchObject({ ok: false, reason: "guest_account" });
  });

  it("rejects a token with no object ID", () => {
    const result = evaluateGate(claims({ oid: undefined }), config);

    expect(result).toMatchObject({ ok: false, reason: "missing_claims" });
  });

  it("lowercases the email", () => {
    const result = evaluateGate(
      claims({ email: "Jane.DOE@PHB1899.com" }),
      config,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.email).toBe("jane.doe@phb1899.com");
  });

  it("honours multiple configured domains", () => {
    const result = evaluateGate(claims({ email: "ops@phb-service.com" }), {
      tenantId: TENANT,
      allowedDomains: ["phb1899.com", "phb-service.com"],
    });

    expect(result.ok).toBe(true);
  });

  it("falls back to preferred_username when email is absent", () => {
    const result = evaluateGate(
      claims({ email: undefined, preferred_username: "bob@phb1899.com" }),
      config,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.email).toBe("bob@phb1899.com");
  });

  it("derives names from the display name when the granular claims are absent", () => {
    const result = evaluateGate(
      claims({
        given_name: undefined,
        family_name: undefined,
        name: "Maria  Del Rosario",
      }),
      config,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.firstName).toBe("Maria");
    expect(result.identity.lastName).toBe("Del Rosario");
  });

  it("never returns an empty first name", () => {
    const result = evaluateGate(
      claims({ given_name: undefined, family_name: undefined, name: undefined }),
      config,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.firstName).toBe("jane.doe");
  });
});
