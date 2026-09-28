import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthCallbackError } from "@auth/core/errors";
import { createAssertionFetch } from "@/lib/auth/entra-assertion-fetch";
import {
  ENTRA_TOKEN_ERROR_EVENT,
  describeEntraTokenError,
  logEntraTokenError,
} from "@/lib/auth/entra-token-error";

/**
 * Entra's AADSTS code reaches the container log.
 *
 * On 2026-09-28 production sign-in failed four times as `invalid_client` with
 * the federated identity credential in place, and the log could not say
 * whether the assertion was rejected (AADSTS70021), absent (AADSTS7000218) or
 * something else. Auth.js had read Entra's body and discarded it - the first
 * test here pins that down, so nobody rebuilds a logger override that cannot
 * work. The container could not be probed either: `az containerapp exec`
 * answered 404 on the websocket handshake. The log has to carry it, and the
 * assertion fetch wrapper is the one place that still has the body.
 */

const TENANT = "48f37f84-1c36-4b3e-986c-b8b7196ad49d";
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;

/** Entra's token-endpoint error body, as documented and as observed live. */
const ENTRA_BODY = {
  error: "invalid_client",
  error_description:
    "AADSTS70021: No matching federated identity record found for presented assertion. " +
    "Assertion Issuer: 'https://login.microsoftonline.com/48f37f84-1c36-4b3e-986c-b8b7196ad49d/v2.0'. " +
    "Assertion Subject: '282bcb43-60e4-4d90-aa62-cea74fd719ae'. " +
    "Assertion Audience: 'api://AzureADTokenExchange'. " +
    "Trace ID: 5b1c6d7e-0000-0000-0000-000000000000 " +
    "Correlation ID: 9f8e7d6c-0000-0000-0000-000000000000 " +
    "Timestamp: 2026-09-28 14:49:46Z",
  error_codes: [70021],
  timestamp: "2026-09-28 14:49:46Z",
  trace_id: "5b1c6d7e-0000-0000-0000-000000000000",
  correlation_id: "9f8e7d6c-0000-0000-0000-000000000000",
  error_uri: "https://login.microsoftonline.com/error?code=70021",
};

/** What oauth4webapi hands a custom fetch for the token request. */
function tokenInit(): RequestInit {
  return {
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: "https://phb.example/api/auth/callback/microsoft-entra-id",
      client_id: "220921c1-f23e-4d01-b354-736884ba3d00",
    }),
    headers: { accept: "application/json" },
    method: "POST",
    redirect: "manual",
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Every JSON line written to stderr during the test, parsed. */
function stderrLines(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return spy.mock.calls.map((call) => JSON.parse(call[0] as string) as Record<string, unknown>);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("why Auth.js cannot log it", () => {
  it("OAuthCallbackError discards the response body Auth.js hands it", () => {
    // callback.js:144 - `new OAuthCallbackError(message, { providerId, ...body })`.
    // The body is passed as ErrorOptions; Error keeps only `options.cause`.
    const error = new OAuthCallbackError("OAuth Provider returned an error: invalid_client", {
      providerId: "microsoft-entra-id",
      ...ENTRA_BODY,
    } as ErrorOptions);
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("AADSTS");
  });
});

describe("describeEntraTokenError", () => {
  it("reads the AADSTS code, the description and the support ids", () => {
    const fields = describeEntraTokenError(401, ENTRA_BODY);

    expect(fields.status).toBe(401);
    expect(fields.entraError).toBe("invalid_client");
    expect(fields.entraErrorCode).toBe("AADSTS70021");
    expect(fields.entraErrorDescription).toBe(ENTRA_BODY.error_description);
    expect(fields.entraTraceId).toBe(ENTRA_BODY.trace_id);
    expect(fields.entraCorrelationId).toBe(ENTRA_BODY.correlation_id);
    expect(fields.entraTimestamp).toBe(ENTRA_BODY.timestamp);
  });

  it("falls back to error_codes when Entra sends no description", () => {
    const fields = describeEntraTokenError(401, { error: "invalid_client", error_codes: [7000218] });
    expect(fields.entraErrorCode).toBe("AADSTS7000218");
    expect(fields.entraErrorDescription).toBeUndefined();
  });

  it("copies nothing that is not on the whitelist", () => {
    const fields = describeEntraTokenError(401, {
      ...ENTRA_BODY,
      access_token: "eyJ.access.token",
      id_token: "eyJ.id.token",
      refresh_token: "eyJ.refresh.token",
      client_assertion: "eyJ.assertion",
      client_secret: "a-secret",
      code: "an-authorization-code",
    });

    const written = JSON.stringify(fields);
    for (const forbidden of [
      "eyJ.access.token",
      "eyJ.id.token",
      "eyJ.refresh.token",
      "eyJ.assertion",
      "a-secret",
      "an-authorization-code",
      "error_uri",
    ]) {
      expect(written).not.toContain(forbidden);
    }
    expect(Object.keys(fields).sort()).toEqual(
      [
        "entraCorrelationId",
        "entraError",
        "entraErrorCode",
        "entraErrorDescription",
        "entraTimestamp",
        "entraTraceId",
        "status",
      ].sort(),
    );
  });

  it("logs the status alone for a body that is not an object", () => {
    expect(describeEntraTokenError(502, null)).toEqual({ status: 502 });
    expect(describeEntraTokenError(502, "<html>Bad Gateway</html>")).toEqual({ status: 502 });
  });
});

describe("logEntraTokenError", () => {
  it("writes one JSON line and leaves the response readable", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = jsonResponse(401, ENTRA_BODY);

    await logEntraTokenError(response);

    const lines = stderrLines(stderr);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "error",
      event: ENTRA_TOKEN_ERROR_EVENT,
      status: 401,
      entraErrorCode: "AADSTS70021",
      entraErrorDescription: ENTRA_BODY.error_description,
    });
    // The caller - Auth.js - still gets the body.
    expect(response.bodyUsed).toBe(false);
    await expect(response.json()).resolves.toEqual(ENTRA_BODY);
  });

  it("does not throw on a body that is not JSON", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = new Response("<html>Bad Gateway</html>", { status: 502 });

    await expect(logEntraTokenError(response)).resolves.toBeUndefined();

    expect(stderrLines(stderr)[0]).toMatchObject({ event: ENTRA_TOKEN_ERROR_EVENT, status: 502 });
  });
});

describe("createAssertionFetch", () => {
  const getAssertion = async () => "eyJ.managed-identity.token";

  it("logs a refused token exchange with its AADSTS code and returns the response", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const baseFetch = vi.fn(async () => jsonResponse(401, ENTRA_BODY));
    const wrapped = createAssertionFetch(getAssertion, baseFetch as unknown as typeof fetch);

    const response = await wrapped(TOKEN_URL, tokenInit());

    const lines = stderrLines(stderr);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: ENTRA_TOKEN_ERROR_EVENT,
      status: 401,
      entraError: "invalid_client",
      entraErrorCode: "AADSTS70021",
    });
    // Never the assertion, which the wrapper has in hand at this point.
    expect(JSON.stringify(lines[0])).not.toContain("eyJ.managed-identity.token");
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual(ENTRA_BODY);
  });

  it("logs nothing for a successful exchange", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const baseFetch = vi.fn(async () =>
      jsonResponse(200, { token_type: "Bearer", id_token: "eyJ.id", access_token: "eyJ.at" }),
    );
    const wrapped = createAssertionFetch(getAssertion, baseFetch as unknown as typeof fetch);

    const response = await wrapped(TOKEN_URL, tokenInit());

    expect(stderr).not.toHaveBeenCalled();
    expect(response.bodyUsed).toBe(false);
  });

  it("logs nothing for a failure on a request it does not touch", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const baseFetch = vi.fn(async () => jsonResponse(500, { error: "server_error" }));
    const wrapped = createAssertionFetch(getAssertion, baseFetch as unknown as typeof fetch);

    // Discovery: a GET, and not the token endpoint. Passed through untouched,
    // and that includes its failure - the AADSTS logging is for the exchange.
    await wrapped(`https://login.microsoftonline.com/${TENANT}/v2.0/.well-known/openid-configuration`);

    expect(stderr).not.toHaveBeenCalled();
  });
});
