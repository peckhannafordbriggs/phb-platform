import {
  CLIENT_ASSERTION_TYPE,
  type AssertionProvider,
} from "@/lib/azure/managed-identity-assertion";
import { logEntraTokenError } from "./entra-token-error";

/**
 * The one request sign-in makes that has to prove who the platform is.
 *
 * Auth.js can authenticate to a token endpoint with a secret, with a JWT it
 * signs itself using a private key, or with nothing. What it cannot do is
 * present a JWT somebody ELSE issued - which is what a managed identity's
 * token is. So the provider is configured with `token_endpoint_auth_method:
 * "none"` and this wrapper is handed to Auth.js as its `customFetch`. Every
 * request the provider makes passes through here; exactly one kind is touched.
 *
 * WHAT IS TOUCHED: a POST to `/oauth2/v2.0/token` on login.microsoftonline.com.
 * Two fields are added to its form body - `client_assertion_type` and
 * `client_assertion` - and nothing else about the request changes.
 *
 * WHAT IS NOT: everything else. Discovery, the authorization redirect, userinfo,
 * a token request to any other host. Those are passed through with the very
 * same arguments. The host check is not tidiness: the assertion is a bearer
 * credential for the platform, and a fetch wrapper that added it to every POST
 * would hand it to whichever server the URL named.
 *
 * The exact shape oauth4webapi hands a custom fetch, read from its source
 * rather than assumed: a STRING url, and an init of `{ body: URLSearchParams,
 * headers: plain object, method: "POST", redirect: "manual", signal }`. A
 * string body is accepted too. Anything else on the token endpoint is refused
 * loudly, because a token request sent without its assertion fails as
 * `invalid_client` and looks nothing like "the wrapper could not read the
 * body".
 *
 * WHAT IS READ: a non-2xx answer from that endpoint is logged, with Entra's
 * AADSTS code, before it is handed back. Auth.js discards the body when it
 * builds its error (see entra-token-error.ts), so this is the only place the
 * code can reach the log. The Response itself goes back untouched: the logger
 * reads a clone.
 */

export const ENTRA_HOST = "login.microsoftonline.com";

export function isEntraTokenEndpoint(url: URL): boolean {
  return url.hostname === ENTRA_HOST && url.pathname.endsWith("/oauth2/v2.0/token");
}

export class AssertionFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionFetchError";
  }
}

function urlOf(input: RequestInfo | URL): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

function methodOf(input: RequestInfo | URL, init: RequestInit | undefined): string {
  if (init?.method !== undefined) return init.method.toUpperCase();
  if (typeof input !== "string" && !(input instanceof URL)) return input.method.toUpperCase();
  return "GET";
}

export function createAssertionFetch(
  getAssertion: AssertionProvider,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  return async function assertionFetch(input, init) {
    if (methodOf(input, init) !== "POST" || !isEntraTokenEndpoint(urlOf(input))) {
      // Untouched means untouched: the same two arguments, not a copy.
      return baseFetch(input, init);
    }

    const body = init?.body;
    let params: URLSearchParams;
    if (body instanceof URLSearchParams) {
      params = new URLSearchParams(body);
    } else if (typeof body === "string") {
      params = new URLSearchParams(body);
    } else {
      throw new AssertionFetchError(
        "Refusing to send a token request whose body cannot be read as a form. " +
          "Auth.js posts URLSearchParams; something between it and this wrapper " +
          "has changed the body type.",
      );
    }

    // Two credentials in one request is an Entra error, and a sign that the
    // provider was built with a secret AND handed this wrapper. Refuse rather
    // than let Entra explain it less clearly.
    if (params.has("client_secret") || params.has("client_assertion")) {
      throw new AssertionFetchError(
        "The token request already carries a client credential. The production " +
          "provider must use token_endpoint_auth_method \"none\" and no clientSecret.",
      );
    }

    params.set("client_assertion_type", CLIENT_ASSERTION_TYPE);
    params.set("client_assertion", await getAssertion());

    const response = await baseFetch(input, { ...init, body: params });
    if (!response.ok) await logEntraTokenError(response);
    return response;
  };
}
