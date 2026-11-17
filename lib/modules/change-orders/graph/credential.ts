import type { TokenCredential } from "@azure/identity";
import { createManagedIdentityAssertionProvider } from "@/lib/azure/managed-identity-assertion";
import { isProduction, readGraphEnv, type GraphEnv } from "@/lib/env";
import {
  GRAPH_SCOPE,
  createAppCredential,
  createCachedTokenProvider as createSharedCachedTokenProvider,
  type AppCredentialConfig,
} from "@/lib/mail/credential";
import type { TokenProvider } from "@/lib/mail/graph-client";
import { MailError } from "../mail/errors";

/**
 * How the platform proves it is the platform - to the Graph app registration.
 *
 * CLAUDE.md prohibition 7: nothing that expires may exist in production. So the
 * two environments authenticate differently, and the difference is this one
 * environment check - `isProduction` - not a strategy interface, not a plugin.
 *
 * The mechanism - the managed identity's token presented as a client
 * assertion in production, a client secret on developer machines, a secret
 * in production refused - is lib/mail/credential.ts since 2026-11-17, shared
 * with the BAS report sender, whose worker job cannot import lib/env.ts. The
 * assertion is lib/azure/managed-identity-assertion.ts, shared with sign-in
 * since 2026-09-16. This file adds only what is the mail module's: the
 * environment check, the configuration it reads, and the words - every
 * failure here is a MailError, as its callers expect.
 */

export { GRAPH_SCOPE };
export type { TokenProvider };

export type GraphCredentialConfig = AppCredentialConfig;

export function graphCredentialConfig(values: GraphEnv): GraphCredentialConfig {
  return {
    clientId: values.GRAPH_CLIENT_ID,
    tenantId: values.GRAPH_TENANT_ID,
    clientSecret: values.GRAPH_CLIENT_SECRET ?? null,
    managedIdentityClientId: values.GRAPH_MANAGED_IDENTITY_CLIENT_ID ?? null,
  };
}

export function createGraphCredential(
  config: GraphCredentialConfig,
): TokenCredential {
  return createAppCredential(config, {
    production: isProduction,
    assertion: (managedIdentityClientId) =>
      createManagedIdentityAssertionProvider({ managedIdentityClientId }),
    vocabulary: {
      // A secret reaching production is a configuration failure serious
      // enough to refuse, not to work around.
      secretInProduction: () =>
        new MailError("not_configured", {
          detail:
            "GRAPH_CLIENT_SECRET is set in production. Production must authenticate " +
            "with a managed identity and a federated identity credential; remove the " +
            "secret from the deployment configuration.",
        }),
      secretMissing: () =>
        new MailError("not_configured", {
          detail: "GRAPH_CLIENT_SECRET is required outside production.",
        }),
      assertionFailed: (error) =>
        new MailError("auth_failed", { detail: error.message, cause: error }),
    },
  });
}

/**
 * Wraps a credential in an in-memory cache (lib/mail/credential.ts), with
 * every failure an `auth_failed` MailError.
 *
 * `now` is injectable so expiry behaviour can be tested without waiting an hour.
 */
export function createCachedTokenProvider(
  credential: TokenCredential,
  options: { scope?: string; now?: () => number } = {},
): TokenProvider {
  return createSharedCachedTokenProvider(credential, {
    ...options,
    tokenRefused: (detail, cause) =>
      new MailError("auth_failed", cause === undefined ? { detail } : { detail, cause }),
  });
}

let memoisedProvider: TokenProvider | null = null;

/**
 * The process-wide token provider. Memoised because the cache inside it is the
 * point - a new provider per request would cache nothing.
 */
export function graphTokenProvider(): TokenProvider {
  if (memoisedProvider !== null) return memoisedProvider;

  const graphEnv = readGraphEnv();
  if (!graphEnv.present) {
    throw new MailError("not_configured", {
      detail: `Missing Graph configuration: ${graphEnv.missing.join(", ")}`,
    });
  }

  const credential = createGraphCredential(graphCredentialConfig(graphEnv.values));
  memoisedProvider = createCachedTokenProvider(credential);
  return memoisedProvider;
}
