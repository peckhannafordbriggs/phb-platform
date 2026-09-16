// From @auth/core directly, not from next-auth's index: that index imports
// next/server, which a plain Node test process cannot resolve, and this module
// has to be unit-testable. next-auth re-exports this very symbol, so the two
// are one object and Auth.js finds it on the provider either way.
import { customFetch } from "@auth/core";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import {
  createManagedIdentityAssertionProvider,
  type AssertionProvider,
} from "@/lib/azure/managed-identity-assertion";
import { createAssertionFetch } from "./entra-assertion-fetch";

/**
 * The Entra provider, built for the environment it runs in.
 *
 * CLAUDE.md prohibition 7: nothing that expires may exist in production. So
 * the two environments authenticate the token exchange differently, and the
 * difference is this one environment check - the same shape as
 * createGraphCredential, for the same reason.
 *
 *   local       client_secret from .env.local. It expires in 2028 and can only
 *               ever affect a developer machine.
 *   production  NO secret. `token_endpoint_auth_method: "none"` so Auth.js
 *               sends none, and a customFetch that adds the managed identity's
 *               token as a `client_assertion` to the one request that needs
 *               it. Entra matches it against a federated identity credential on
 *               the SSO app registration - the same credential shape the Graph
 *               app registration already carries.
 *
 * Production REFUSES to boot with AUTH_MICROSOFT_ENTRA_ID_SECRET set. Not a
 * warning: a secret reaching production is the failure prohibition 7 exists to
 * prevent, and quietly preferring the assertion would leave the secret in
 * place to be noticed the day it expires.
 *
 * This lives outside auth.config.ts on purpose. middleware.ts imports that file
 * on the edge runtime, where @azure/identity cannot load; the middleware only
 * checks for a session and never exchanges a code, so it keeps the plain
 * provider and this one is composed in auth.ts, on Node.
 */

export class SsoConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsoConfigurationError";
  }
}

export interface EntraProviderConfig {
  clientId: string;
  tenantId: string;
  /** `null` when unset or blank. */
  clientSecret: string | null;
  production: boolean;
  /** The platform's user-assigned managed identity, or null. Production only. */
  managedIdentityClientId: string | null;
  /** Test seams. Production leaves both undefined. */
  assertionProvider?: AssertionProvider;
  fetchImpl?: typeof fetch;
}

export function buildEntraProvider(config: EntraProviderConfig) {
  const issuer = `https://login.microsoftonline.com/${config.tenantId}/v2.0`;

  if (config.production) {
    if (config.clientSecret !== null) {
      throw new SsoConfigurationError(
        "AUTH_MICROSOFT_ENTRA_ID_SECRET is set in production. Production sign-in " +
          "authenticates with the managed identity and a federated identity " +
          "credential on the SSO app registration; remove the secret from the " +
          "deployment configuration. (CLAUDE.md prohibition 7.)",
      );
    }

    const getAssertion =
      config.assertionProvider ??
      createManagedIdentityAssertionProvider({
        managedIdentityClientId: config.managedIdentityClientId,
      });

    return MicrosoftEntraID({
      clientId: config.clientId,
      issuer,
      // Auth.js sends no client credential of its own...
      client: { token_endpoint_auth_method: "none" },
      // ...and this adds the assertion to the token request, and only to it.
      [customFetch]: createAssertionFetch(getAssertion, config.fetchImpl),
    });
  }

  // Outside production the secret is used when present and, when absent,
  // sign-in fails at the token exchange exactly as it always has. Not refused
  // here: the test environment builds this provider without ever signing in.
  return MicrosoftEntraID({
    clientId: config.clientId,
    clientSecret: config.clientSecret ?? undefined,
    issuer,
  });
}

/** Blank in the environment means absent. An Azure app setting left empty arrives as "". */
export function secretOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}
