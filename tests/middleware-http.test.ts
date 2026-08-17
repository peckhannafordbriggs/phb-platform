import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Real HTTP, through the real middleware.
 *
 * Every other test in this suite calls a route handler as a function, which
 * skips the middleware entirely. That gap hid a live bug: the handlers returned
 * 401 correctly while an actual unauthenticated request to the same URL got a
 * 302 to /signin, because the edge middleware ran first and redirected. A
 * fetch() would have followed that redirect and been handed a sign-in HTML page
 * with a 200 on it.
 *
 * So this file boots Next in-process and makes genuine requests over a socket.
 * Nothing is mocked - no session mock, no fetch stub. An unauthenticated request
 * is unauthenticated because it carries no cookie.
 */

let server: Server;
let origin: string;
let closeApp: (() => Promise<void>) | undefined;

beforeAll(async () => {
  // Next is noisy on first compile and the telemetry notice adds nothing here.
  process.env.NEXT_TELEMETRY_DISABLED = "1";

  const { default: next } = await import("next");

  const app = next({ dev: true, dir: process.cwd() });
  await app.prepare();

  const handler = app.getRequestHandler();
  closeApp = () => app.close();

  server = createServer((req, res) => {
    void handler(req, res);
  });

  await new Promise<void>((resolve) => {
    // Port 0 - the OS picks a free one, so the suite cannot collide with a dev
    // server the developer already has running.
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected the test server to report a numeric port");
  }
  origin = `http://127.0.0.1:${address.port}`;

  // Middleware compiles on first request; do it here so the compile time is not
  // charged to whichever test happens to run first.
  await fetch(`${origin}/api/me`, { redirect: "manual" });
  // Compiling the middleware is the slow part of this file.
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeApp?.();
}, 30_000);

/** `redirect: "manual"` so a 302 is observed rather than silently followed. */
function request(path: string): Promise<Response> {
  return fetch(`${origin}${path}`, { redirect: "manual" });
}

describe("an unauthenticated request to an API route", () => {
  const apiPaths = [
    "/api/modules/change-orders/mailbox/health",
    "/api/modules/change-orders/ping",
    "/api/me",
    "/api/admin/employees",
    "/api/onboarding",
  ];

  for (const path of apiPaths) {
    it(`${path} returns 401, not a 302`, async () => {
      const response = await request(path);

      expect(response.status).toBe(401);
      // The regression this file exists for.
      expect(response.status).not.toBe(302);
      expect(response.headers.get("location")).toBeNull();
    });
  }

  it("returns the standard error shape, not an HTML sign-in page", async () => {
    const response = await request("/api/modules/change-orders/mailbox/health");

    expect(response.headers.get("content-type")).toContain("application/json");

    const body = (await response.json()) as {
      error: { code: string; message: string };
    };

    // docs/07-conventions.md: { error: { code, message } }
    expect(body).toEqual({
      error: { code: "unauthenticated", message: "Sign in to continue." },
    });
  });

  it("is not followed into a 200 by a default fetch", async () => {
    // What a browser client actually does. Before the fix this resolved to a
    // 200 carrying the sign-in page, and a caller had to parse HTML to discover
    // it was not signed in.
    const response = await fetch(
      `${origin}/api/modules/change-orders/mailbox/health`,
    );

    expect(response.status).toBe(401);
    expect(response.redirected).toBe(false);
  });
});

describe("page routes still redirect", () => {
  const pagePaths = ["/", "/admin", "/change-orders", "/onboarding"];

  for (const path of pagePaths) {
    it(`${path} redirects to /signin`, async () => {
      const response = await request(path);

      // 302, the default from Response.redirect - unchanged by this fix.
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("/signin");
    });
  }
});

describe("the auth routes stay reachable", () => {
  it("does not intercept /api/auth/*, or sign-in could never start", async () => {
    const response = await request("/api/auth/providers");

    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(302);
  });
});
