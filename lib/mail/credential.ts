import { ClientAssertionCredential, ClientSecretCredential } from "@azure/identity";
import type { TokenCredential } from "@azure/identity";
import {
  ManagedIdentityAssertionError,
  type AssertionProvider,
} from "@/lib/azure/managed-identity-assertion";
import type { TokenProvider } from "./graph-client";

/**
 * How the platform proves it is the platform to an app registration that
 * holds a Graph application permission - shared since 2026-11-17 by the
 * Change Orders mail app (and the Needs Review app, through the Change
 * Orders factory) and the BAS report sender app.
 *
 * CLAUDE.md prohibition 7: nothing that expires may exist in production. So
 * the two environments authenticate differently, and the difference is one
 * boolean the CALLER passes - never read from the environment here, because
 * the Reports worker's import graph must not reach lib/env.ts:
 *
 *   production   the managed identity's token presented as a client
 *                assertion, matched by a federated identity credential on
 *                the app registration. A client secret present is REFUSED,
 *                not ignored: production must not depend on something that
 *                expires.
 *   elsewhere    a client secret from .env.local; absent is refused rather
 *                than silently using none.
 *
 * The assertion itself is lib/azure/managed-identity-assertion.ts, the one
 * implementation of that step; the caller hands in the factory, so a test can
 * hand in a fake one and the audience string lives in one place.
 *
 * What differs between callers is only the words: each module reports these
 * failures in its own error type, through `vocabulary`.
 */

export const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

/** Refresh this far before expiry so a request never carries a dying token. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface AppCredentialConfig {
  clientId: string;
  tenantId: string;
  clientSecret: string | null;
  managedIdentityClientId: string | null;
}

export interface CredentialVocabulary {
  /** A client secret reached production. */
  secretInProduction(): Error;
  /** Outside production, there is no secret to use. */
  secretMissing(): Error;
  /** The managed identity could not produce an assertion. */
  assertionFailed(error: ManagedIdentityAssertionError): Error;
}

export interface AppCredentialOptions {
  production: boolean;
  /** Called once, in production only, with the identity's client id. */
  assertion: (managedIdentityClientId: string | null) => AssertionProvider;
  vocabulary: CredentialVocabulary;
}

export function createAppCredential(
  config: AppCredentialConfig,
  options: AppCredentialOptions,
): TokenCredential {
  if (options.production) {
    // A secret reaching production is a configuration failure serious enough to
    // refuse, not to work around. Failing here means the module is unavailable;
    // proceeding would mean production depends on something that expires.
    if (config.clientSecret !== null) throw options.vocabulary.secretInProduction();

    // The managed identity does not itself hold the Graph permission. It
    // proves identity to Entra, which then issues a token for the app
    // registration that does - the federated identity credential ties them
    // together. Nothing in this path expires.
    const getAssertion = options.assertion(config.managedIdentityClientId);

    return new ClientAssertionCredential(config.tenantId, config.clientId, async () => {
      try {
        return await getAssertion();
      } catch (error) {
        if (error instanceof ManagedIdentityAssertionError) {
          throw options.vocabulary.assertionFailed(error);
        }
        throw error;
      }
    });
  }

  if (config.clientSecret === null) throw options.vocabulary.secretMissing();

  return new ClientSecretCredential(config.tenantId, config.clientId, config.clientSecret);
}

export interface CachedTokenOptions {
  scope?: string;
  now?: () => number;
  /** Entra refused a token, or the credential returned none. */
  tokenRefused: (detail: string, cause?: unknown) => Error;
}

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
  options: CachedTokenOptions,
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
      throw options.tokenRefused(
        `Entra refused a token for the Graph app registration: ${
          error instanceof Error ? error.name : typeof error
        }`,
        error,
      );
    }

    if (result === null) {
      throw options.tokenRefused("The credential returned no token and no error.");
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
