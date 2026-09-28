import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { customFetch } from "@auth/core";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
// Auth.js's real provider normalisation, imported by path because the
// package does not export it. It is the one place the trap below shows.
import parseProviders from "../node_modules/@auth/core/lib/utils/providers.js";
import {
  AssertionFetchError,
  createAssertionFetch,
  isEntraTokenEndpoint,
} from "@/lib/auth/entra-assertion-fetch";
import {
  SsoConfigurationError,
  buildEntraProvider,
  secretOrNull,
} from "@/lib/auth/entra-provider";
import {
  CLIENT_ASSERTION_TYPE,
  ManagedIdentityAssertionError,
  TOKEN_EXCHANGE_SCOPE,
  createManagedIdentityAssertionProvider,
} from "@/lib/azure/managed-identity-assertion";

/**
 * Production sign-in authenticates with the managed identity, not a secret.
 *
 * The first production sign-in (2026-09-16) reached the token exchange and Entra
 * answered `invalid_client`: the app is a confidential client and the request
 * carried neither client_secret nor client_assertion, because production
 * deploys no secret (CLAUDE.md prohibition 7). The fix presents the managed
 * identity's token as the assertion, through the one seam Auth.js offers - a
 * provider-level customFetch - and this file is the proof that the seam does
 * exactly one thing.
 *
 * What cannot be proved here: that Entra accepts the assertion. That needs the
 * federated identity credential on the SSO app registration, which only Vitis
 * can create, and a real authorization code. runbook.md -> Request 3.
 */

const TENANT = "48f37f84-1c36-4b3e-986c-b8b7196ad49d";
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const AUTHORIZE_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`;
const ASSERTION = "eyJ.managed-identity.token";

/** What oauth4webapi actually hands a custom fetch, read from its source. */
function tokenRequest(body: BodyInit = new URLSearchParams({
  grant_type: "authorization_code",
  code: "the-code",
  redirect_uri: "https://phb.example/api/auth/callback/microsoft-entra-id",
  client_id: "220921c1-f23e-4d01-b354-736884ba3d00",
})): [string, RequestInit] {
  return [
    TOKEN_URL,
    {
      body,
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      method: "POST",
      redirect: "manual",
    },
  ];
}

function recorder() {
  const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
  const baseFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([input, init]);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, baseFetch };
}

function bodyOf(init: RequestInit | undefined): URLSearchParams {
  const body = init?.body;
  if (!(body instanceof URLSearchParams)) throw new Error(`body is ${typeof body}`);
  return body;
}

describe("the assertion fetch touches exactly one kind of request", () => {
  it("adds client_assertion_type and client_assertion to a token-endpoint POST, and nothing else", async () => {
    const { calls, baseFetch } = recorder();
    const getAssertion = vi.fn(async () => ASSERTION);
    const wrapped = createAssertionFetch(getAssertion, baseFetch);
    const [url, init] = tokenRequest();
    const originalKeys = [...bodyOf(init).keys()];

    await wrapped(url, init);

    expect(calls).toHaveLength(1);
    const [sentUrl, sentInit] = calls[0]!;
    const sent = bodyOf(sentInit);

    expect(sentUrl).toBe(url);
    expect(sent.get("client_assertion_type")).toBe(CLIENT_ASSERTION_TYPE);
    expect(sent.get("client_assertion")).toBe(ASSERTION);
    // Exactly two fields added; every original one preserved with its value.
    expect([...sent.keys()].sort()).toEqual(
      [...originalKeys, "client_assertion_type", "client_assertion"].sort(),
    );
    for (const key of originalKeys) {
      expect(sent.get(key)).toBe(bodyOf(init).get(key));
    }
    // The rest of the init is the same request.
    expect(sentInit?.method).toBe("POST");
    expect(sentInit?.redirect).toBe("manual");
    expect(sentInit?.headers).toEqual(init.headers);
    // And the caller's body object was not mutated behind its back.
    expect(bodyOf(init).has("client_assertion")).toBe(false);
  });

  it("accepts a string form body the same way", async () => {
    const { calls, baseFetch } = recorder();
    const wrapped = createAssertionFetch(async () => ASSERTION, baseFetch);
    const [url, init] = tokenRequest("grant_type=authorization_code&code=abc");

    await wrapped(url, init);

    const sent = bodyOf(calls[0]![1]);
    expect(sent.get("code")).toBe("abc");
    expect(sent.get("client_assertion")).toBe(ASSERTION);
  });

  it("fetches the assertion lazily - once per token request, never otherwise", async () => {
    const { baseFetch } = recorder();
    const getAssertion = vi.fn(async () => ASSERTION);
    const wrapped = createAssertionFetch(getAssertion, baseFetch);

    await wrapped(AUTHORIZE_URL, { method: "GET" });
    await wrapped("https://graph.microsoft.com/oidc/userinfo", { method: "POST" });
    expect(getAssertion).not.toHaveBeenCalled();

    await wrapped(...tokenRequest());
    expect(getAssertion).toHaveBeenCalledTimes(1);
  });

  it("passes every other request through with the very same arguments", async () => {
    const { calls, baseFetch } = recorder();
    const wrapped = createAssertionFetch(async () => ASSERTION, baseFetch);

    const others: Array<[RequestInfo | URL, RequestInit | undefined]> = [
      // a GET to the token endpoint is not a token request
      [TOKEN_URL, { method: "GET" }],
      // the authorization redirect and discovery
      [AUTHORIZE_URL, { method: "POST", body: new URLSearchParams({ a: "1" }) }],
      [`https://login.microsoftonline.com/${TENANT}/v2.0/.well-known/openid-configuration`, undefined],
      // userinfo
      ["https://graph.microsoft.com/oidc/userinfo", { method: "POST", body: new URLSearchParams() }],
      // a URL object, and a Request object, both elsewhere
      [new URL("https://graph.microsoft.com/v1.0/me"), { method: "POST" }],
      [new Request("https://example.com/oauth2/v2.0/token", { method: "POST" }), undefined],
    ];

    for (const [input, init] of others) {
      await wrapped(input, init);
    }

    expect(calls).toHaveLength(others.length);
    calls.forEach(([input, init], i) => {
      // Identity, not equality: the wrapper did not rebuild the request.
      expect(input).toBe(others[i]![0]);
      expect(init).toBe(others[i]![1]);
    });
  });

  it("never sends the assertion to a token endpoint on another host", async () => {
    // The assertion is a bearer credential for the platform. A wrapper that
    // keyed on the path alone would hand it to whatever server the URL named.
    const { calls, baseFetch } = recorder();
    const getAssertion = vi.fn(async () => ASSERTION);
    const wrapped = createAssertionFetch(getAssertion, baseFetch);
    const [, init] = tokenRequest();

    await wrapped(`https://evil.example/${TENANT}/oauth2/v2.0/token`, init);

    expect(getAssertion).not.toHaveBeenCalled();
    expect(bodyOf(calls[0]![1]).has("client_assertion")).toBe(false);
    expect(calls[0]![1]).toBe(init);
  });

  it("recognises a token request made with a Request object", async () => {
    const { calls, baseFetch } = recorder();
    const wrapped = createAssertionFetch(async () => ASSERTION, baseFetch);
    const request = new Request(TOKEN_URL, { method: "POST" });

    await wrapped(request, { body: new URLSearchParams({ code: "x" }) });

    expect(bodyOf(calls[0]![1]).get("client_assertion")).toBe(ASSERTION);
  });

  it("refuses a token request whose body it cannot read, rather than sending it bare", async () => {
    const { calls, baseFetch } = recorder();
    const wrapped = createAssertionFetch(async () => ASSERTION, baseFetch);
    const [url, init] = tokenRequest(new FormData());

    await expect(wrapped(url, init)).rejects.toBeInstanceOf(AssertionFetchError);
    expect(calls).toHaveLength(0);
  });

  it("refuses a token request that already carries a client credential", async () => {
    const { calls, baseFetch } = recorder();
    const wrapped = createAssertionFetch(async () => ASSERTION, baseFetch);
    const [url, init] = tokenRequest(
      new URLSearchParams({ grant_type: "authorization_code", client_secret: "oops" }),
    );

    await expect(wrapped(url, init)).rejects.toBeInstanceOf(AssertionFetchError);
    expect(calls).toHaveLength(0);
  });

  it("names the token endpoint precisely", () => {
    expect(isEntraTokenEndpoint(new URL(TOKEN_URL))).toBe(true);
    expect(isEntraTokenEndpoint(new URL(AUTHORIZE_URL))).toBe(false);
    expect(isEntraTokenEndpoint(new URL(`https://login.microsoftonline.com/${TENANT}/oauth2/token`))).toBe(false);
    expect(isEntraTokenEndpoint(new URL("https://example.com/oauth2/v2.0/token"))).toBe(false);
  });
});

describe("the provider is built for its environment", () => {
  const base = {
    clientId: "220921c1-f23e-4d01-b354-736884ba3d00",
    tenantId: TENANT,
    managedIdentityClientId: "d6ed7dd3-a599-444b-b043-90f1e7282bea",
  };

  it("REFUSES to boot in production with the SSO secret set (prohibition 7)", () => {
    expect(() =>
      buildEntraProvider({ ...base, production: true, clientSecret: "a-secret" }),
    ).toThrowError(SsoConfigurationError);
    expect(() =>
      buildEntraProvider({ ...base, production: true, clientSecret: "a-secret" }),
    ).toThrowError(/AUTH_MICROSOFT_ENTRA_ID_SECRET/);
  });

  it("in production sends no client credential and carries the assertion fetch", async () => {
    const { calls, baseFetch } = recorder();
    const provider = buildEntraProvider({
      ...base,
      production: true,
      clientSecret: null,
      assertionProvider: async () => ASSERTION,
      fetchImpl: baseFetch,
    });
    const options = provider.options as Record<PropertyKey, unknown>;

    expect(options.clientSecret).toBeUndefined();
    expect((options.client as { token_endpoint_auth_method: string }).token_endpoint_auth_method).toBe("none");
    expect(options.issuer).toBe(`https://login.microsoftonline.com/${TENANT}/v2.0`);

    // And the fetch Auth.js will use is the wrapper, end to end. On the
    // provider OBJECT - an option is discarded, see the describe below.
    expect(options[customFetch]).toBeUndefined();
    const wrapped = provider[customFetch] as typeof fetch;
    expect(typeof wrapped).toBe("function");
    await wrapped(...tokenRequest());
    expect(bodyOf(calls[0]![1]).get("client_assertion")).toBe(ASSERTION);
    expect(bodyOf(calls[0]![1]).get("client_assertion_type")).toBe(CLIENT_ASSERTION_TYPE);
  });

  it("outside production uses the secret and no assertion", () => {
    const provider = buildEntraProvider({
      ...base,
      production: false,
      clientSecret: "local-dev-secret",
    });
    const options = provider.options as Record<PropertyKey, unknown>;

    expect(options.clientSecret).toBe("local-dev-secret");
    expect(options.client).toBeUndefined();
    expect(options[customFetch]).toBeUndefined();
    // Auth.js's own fetch for this provider, untouched.
    expect(typeof provider[customFetch]).toBe("function");
    expect(provider[customFetch]).not.toBe(
      buildEntraProvider({ ...base, production: true, clientSecret: null })[customFetch],
    );
  });

  it("treats a blank secret as absent - an Azure app setting left empty arrives as an empty string", () => {
    expect(secretOrNull("")).toBeNull();
    expect(secretOrNull("   ")).toBeNull();
    expect(secretOrNull(undefined)).toBeNull();
    expect(secretOrNull(" s ")).toBe("s");
  });
});

describe("the managed identity assertion provider", () => {
  it("asks the identity for the token-exchange audience and returns its token", async () => {
    const getToken = vi.fn(async () => ({ token: ASSERTION }));
    const getAssertion = createManagedIdentityAssertionProvider({
      managedIdentityClientId: "d6ed7dd3-a599-444b-b043-90f1e7282bea",
      source: { getToken },
    });

    await expect(getAssertion()).resolves.toBe(ASSERTION);
    expect(getToken).toHaveBeenCalledWith(TOKEN_EXCHANGE_SCOPE);
    expect(TOKEN_EXCHANGE_SCOPE).toBe("api://AzureADTokenExchange/.default");
  });

  it("fails loudly when the identity returns nothing", async () => {
    const getAssertion = createManagedIdentityAssertionProvider({
      managedIdentityClientId: null,
      source: { getToken: async () => null },
    });

    await expect(getAssertion()).rejects.toBeInstanceOf(ManagedIdentityAssertionError);
    await expect(getAssertion()).rejects.toThrowError(/managed identity is assigned/);
  });

  it("is the ONLY place a managed identity token is turned into an assertion", async () => {
    // Two copies of a credential path are two places for the audience string
    // to drift. The Graph credential used to carry its own; it must not again.
    const graph = await readFile(
      path.join(process.cwd(), "lib/modules/change-orders/graph/credential.ts"),
      "utf8",
    );
    expect(graph).not.toContain("new ManagedIdentityCredential(");
    expect(graph).not.toContain("api://AzureADTokenExchange");
    expect(graph).toContain("createManagedIdentityAssertionProvider");
  });
});

describe("Auth.js keeps a provider's own custom fetch - so ours must be on the provider object", () => {
  /**
   * What production did from 2026-09-17 to 2026-09-28. The wrapper was passed
   * as an option, `MicrosoftEntraID({ ..., [customFetch]: wrapper })`. The
   * Entra provider ships a customFetch of its own (it rewrites `{tenantid}` in
   * the discovery issuer), Auth.js's parseProviders copies that onto the
   * provider first and applies the option only where nothing is set, and the
   * wrapper never ran. Every token request went out with no assertion; Entra
   * answered `invalid_client`; the federated identity credential was never
   * exercised. Nothing in a unit test of the wrapper could see it - only
   * Auth.js's real normalisation can, so that is what runs here.
   */
  const base = {
    clientId: "220921c1-f23e-4d01-b354-736884ba3d00",
    tenantId: TENANT,
    managedIdentityClientId: "d6ed7dd3-a599-444b-b043-90f1e7282bea",
  };
  const DISCOVERY_URL = `https://login.microsoftonline.com/${TENANT}/v2.0/.well-known/openid-configuration`;

  function resolve(provider: ReturnType<typeof buildEntraProvider>) {
    const { provider: resolved } = parseProviders({
      url: new URL("https://phb.example/api/auth"),
      providerId: "microsoft-entra-id",
      config: { providers: [provider] } as never,
    });
    return (resolved as Record<PropertyKey, unknown>)[customFetch] as typeof fetch;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("DISCARDS a customFetch passed as a provider option (the 2026-09-17 to 09-28 failure)", async () => {
    const ours = vi.fn(async () => new Response("{}"));
    const provider = MicrosoftEntraID({
      clientId: base.clientId,
      issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
      client: { token_endpoint_auth_method: "none" },
      [customFetch]: ours as unknown as typeof fetch,
    });
    const { calls, baseFetch } = recorder();
    vi.stubGlobal("fetch", baseFetch);

    const resolved = resolve(provider as ReturnType<typeof buildEntraProvider>);
    await resolved(...tokenRequest());

    expect(ours).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0]![1]).has("client_assertion")).toBe(false);
  });

  it("the production provider, resolved by Auth.js, sends the assertion", async () => {
    const provider = buildEntraProvider({
      ...base,
      production: true,
      clientSecret: null,
      assertionProvider: async () => ASSERTION,
    });
    const { calls, baseFetch } = recorder();
    vi.stubGlobal("fetch", baseFetch);

    const resolved = resolve(provider);
    await resolved(...tokenRequest());

    expect(calls).toHaveLength(1);
    expect(String(calls[0]![0])).toBe(TOKEN_URL);
    expect(bodyOf(calls[0]![1]).get("client_assertion")).toBe(ASSERTION);
    expect(bodyOf(calls[0]![1]).get("client_assertion_type")).toBe(CLIENT_ASSERTION_TYPE);
  });

  it("keeps Auth.js's own discovery-issuer rewrite underneath the wrapper", async () => {
    const provider = buildEntraProvider({
      ...base,
      production: true,
      clientSecret: null,
      assertionProvider: async () => ASSERTION,
    });
    const seen: string[] = [];
    let issuer = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        seen.push(String(input));
        return Response.json({ issuer });
      }),
    );
    const resolved = resolve(provider);

    // Auth.js's fetch exists to replace a literal `{tenantid}`, which is what
    // the `common` discovery document carries. Its regex takes `\w+` as the
    // tenant, which a GUID is not, so for this issuer it substitutes "common"
    // - Auth.js's behaviour, recorded rather than corrected. The point here is
    // only that the rewrite HAPPENED, which proves Auth.js's fetch ran under
    // ours: a wrapper that replaced it would return the placeholder verbatim.
    issuer = "https://login.microsoftonline.com/{tenantid}/v2.0";
    const placeholder = (await (await resolved(DISCOVERY_URL)).json()) as { issuer: string };
    expect(placeholder.issuer).not.toContain("{tenantid}");
    expect(placeholder.issuer).toBe("https://login.microsoftonline.com/common/v2.0");

    // What the tenant-specific endpoint really returns (read live 2026-09-28):
    // the GUID, no placeholder. Passed through untouched, so oauth4webapi's
    // issuer comparison against the configured issuer holds in production.
    issuer = `https://login.microsoftonline.com/${TENANT}/v2.0`;
    const real = (await (await resolved(DISCOVERY_URL)).json()) as { issuer: string };
    expect(real.issuer).toBe(`https://login.microsoftonline.com/${TENANT}/v2.0`);

    expect(seen).toEqual([DISCOVERY_URL, DISCOVERY_URL]);
  });
});
