import { ManagedIdentityCredential } from "@azure/identity";

/**
 * How the platform proves it is the platform, in production - to Entra, for
 * ANY app registration that has been told to trust its managed identity.
 *
 * Two things need that proof: the Graph module, which acquires app-only tokens
 * for the mail app registration, and sign-in, which exchanges a user's
 * authorization code at the SSO app registration. Both are "a confidential
 * client authenticating to Entra", and CLAUDE.md prohibition 7 says neither may
 * do it with something that expires. So both do it the same way: the managed
 * identity gets a token for the token-exchange audience, and that token is
 * presented as a `client_assertion`. Entra matches its issuer and subject
 * against a federated identity credential on the target app registration and,
 * if they match, treats the request as authenticated by that app.
 *
 * This is the ONE implementation of that step. It used to live inside the Graph
 * credential; sign-in needed the same thing, and two copies of a credential
 * path are two places for the audience string to drift apart.
 *
 * Nothing here expires. The managed identity has no secret; the token it
 * returns lasts about an hour and is fetched fresh when needed.
 */

/**
 * The audience Entra requires when a managed identity federates to an app.
 * Global cloud value; US Government and China clouds use different ones, and
 * this platform is in neither.
 */
export const TOKEN_EXCHANGE_SCOPE = "api://AzureADTokenExchange/.default";

/** RFC 7523 - the assertion is a JWT issued by a party the app trusts. */
export const CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/** Returns a fresh assertion. Never cached here: the caller decides. */
export type AssertionProvider = () => Promise<string>;

/**
 * The part of a TokenCredential this needs. Structural, so a test can hand in
 * a stub and prove the scope requested without reaching for Azure.
 */
export interface AssertionSource {
  getToken(scope: string): Promise<{ token: string } | null>;
}

export class ManagedIdentityAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedIdentityAssertionError";
  }
}

export interface ManagedIdentityAssertionOptions {
  /**
   * The USER-ASSIGNED identity's client id. The container app carries it as
   * GRAPH_MANAGED_IDENTITY_CLIENT_ID - named for the module that first needed
   * it, but it is the platform's one identity and sign-in uses the same one.
   * `null` lets @azure/identity pick the system-assigned identity, which this
   * deployment does not have; it is accepted so a future deployment could.
   */
  managedIdentityClientId: string | null;
  /** Test seam. Production leaves it undefined and gets the real identity. */
  source?: AssertionSource;
}

export function createManagedIdentityAssertionProvider(
  options: ManagedIdentityAssertionOptions,
): AssertionProvider {
  const source: AssertionSource =
    options.source ??
    new ManagedIdentityCredential(
      options.managedIdentityClientId !== null
        ? { clientId: options.managedIdentityClientId }
        : {},
    );

  return async function getAssertion(): Promise<string> {
    const result = await source.getToken(TOKEN_EXCHANGE_SCOPE);
    if (result === null) {
      throw new ManagedIdentityAssertionError(
        "The managed identity returned no token for the Entra token-exchange " +
          "audience. Check that a managed identity is assigned to the container app.",
      );
    }
    return result.token;
  };
}
