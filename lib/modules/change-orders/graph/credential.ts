import { ClientAssertionCredential, ClientSecretCredential } from "@azure/identity";
import type { TokenCredential } from "@azure/identity";
import {
  ManagedIdentityAssertionError,
  createManagedIdentityAssertionProvider,
} from "@/lib/azure/managed-identity-assertion";
import { isProduction, readGraphEnv, type GraphEnv } from "@/lib/env";
import { MailError } from "../mail/errors";

/**
 * How the platform proves it is the platform - to the Graph app registration.
 *
 * CLAUDE.md prohibition 7: nothing that expires may exist in production. So the
 * two environments authenticate differently, and the difference is this one
 * environment check - not a strategy interface, not a plugin.
 *
 * The production half - the managed identity's token presented as a client
 * assertion - is lib/azure/managed-identity-assertion.ts, shared with sign-in
 * since 2026-09-16. This file adds only what is Graph's: the error type its
 * callers expect, and the secret path for developer machines.
 */

export const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

/** Refresh this far before expiry so a request never carries a dying token. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface GraphCredentialConfig {
  clientId: string;
  tenantId: string;
  clientSecret: string | null;
  managedIdentityClientId: string | null;
}

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
  if (isProduction) {
    // A secret reaching production is a configuration failure serious enough to
    // refuse, not to work around. Failing here means the module is unavailable;
    // proceeding would mean production depends on something that expires.
    if (config.clientSecret !== null) {
      throw new MailError("not_configured", {
        detail:
          "GRAPH_CLIENT_SECRET is set in production. Production must authenticate " +
          "with a managed identity and a federated identity credential; remove the " +
          "secret from the deployment configuration.",
      });
    }

    // The managed identity does not itself hold Mail.ReadWrite. It proves
    // identity to Entra, which then issues a token for the Graph app
    // registration that does - the federated identity credential ties them
    // together. Nothing in this path expires.
    const getAssertion = createManagedIdentityAssertionProvider({
      managedIdentityClientId: config.managedIdentityClientId,
    });

    return new ClientAssertionCredential(
      config.tenantId,
      config.clientId,
      async () => {
        try {
          return await getAssertion();
        } catch (error) {
          if (error instanceof ManagedIdentityAssertionError) {
            throw new MailError("auth_failed", { detail: error.message, cause: error });
          }
          throw error;
        }
      },
    );
  }

  if (config.clientSecret === null) {
    throw new MailError("not_configured", {
      detail: "GRAPH_CLIENT_SECRET is required outside production.",
    });
  }

  return new ClientSecretCredential(
    config.tenantId,
    config.clientId,
    config.clientSecret,
  );
}

/** Returns a bearer token. The only thing the Graph client needs to know. */
export type TokenProvider = () => Promise<string>;

/**
 * Wraps a credential in an in-memory cache.
 *
 * Graph tokens last about an hour. Fetching one per request is wasteful and, at
 * enough traffic, gets the app throttled at the token endpoint rather than at
 * Graph - a failure that looks nothing like the cause. Concurrent callers share
 * one in-flight fetch for the same reason.
 *
 * `now` is injectable so expiry behaviour can be tested without waiting an hour.
 */
export function createCachedTokenProvider(
  credential: TokenCredential,
  options: { scope?: string; now?: () => number } = {},
): TokenProvider {
  const scope = options.scope ?? GRAPH_SCOPE;
  const now = options.now ?? (() => Date.now());

  let cached: { token: string; expiresAt: number } | null = null;
  let inFlight: Promise<string> | null = null;

  async function fetchToken(): Promise<string> {
    let result;
    try {
      result = await credential.getToken(scope);
    } catch (error) {
      throw new MailError("auth_failed", {
        detail: `Entra refused a token for the Graph app registration: ${
          error instanceof Error ? error.name : typeof error
        }`,
        cause: error,
      });
    }

    if (result === null) {
      throw new MailError("auth_failed", {
        detail: "The credential returned no token and no error.",
      });
    }

    cached = { token: result.token, expiresAt: result.expiresOnTimestamp };
    return result.token;
  }

  return async function getToken(): Promise<string> {
    if (cached !== null && cached.expiresAt - REFRESH_MARGIN_MS > now()) {
      return cached.token;
    }

    if (inFlight !== null) return inFlight;

    inFlight = fetchToken().finally(() => {
      inFlight = null;
    });

    return inFlight;
  };
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
