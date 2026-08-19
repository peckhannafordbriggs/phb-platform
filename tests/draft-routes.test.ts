import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { GET as draftRoute, PATCH as patchRoute } from "@/app/api/modules/change-orders/drafts/[messageId]/route";
import { POST as sendRoute } from "@/app/api/modules/change-orders/drafts/[messageId]/send/route";
import {
  createEmployee,
  disconnectDb,
  grantModule,
  resetDb,
  seedChangeOrdersModule,
} from "./db";

/**
 * The write routes, at the authorization boundary.
 *
 * No Graph credential is configured in the suite, so a granted caller stops at
 * "not configured" - which is the contract. What these prove is that the
 * boundary itself is identical to every other module route, and that the
 * dangerous one carries nothing a caller could turn into a different message.
 */

const authMock = vi.mocked(auth);

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

const params = { params: Promise.resolve({ messageId: "AAMkDraft" }) };

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/modules/change-orders/drafts/AAMkDraft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ROUTES: Array<{ name: string; call: () => Promise<Response> }> = [
  { name: "open draft", call: () => draftRoute(jsonRequest({}), { ...params }) },
  {
    name: "save draft",
    call: () => patchRoute(jsonRequest({ subject: "ZZTEST x" }), { ...params }),
  },
  {
    name: "send draft",
    call: () => sendRoute(jsonRequest({ expectedChangeKey: null }), { ...params }),
  },
];

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await resetDb();
  await seedChangeOrdersModule();
  process.env.PHB_ALLOW_SEND = "false";
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.PHB_ALLOW_SEND = "false";
});

afterAll(async () => {
  await disconnectDb();
});

describe("every draft route is behind the module grant", () => {
  for (const route of ROUTES) {
    it(`${route.name}: 401 when unauthenticated`, async () => {
      authMock.mockResolvedValue(null as never);
      expect((await route.call()).status).toBe(401);
    });

    it(`${route.name}: 404 - not 403 - without the grant`, async () => {
      await createEmployee({ entraOid: `oid-nogrant-${route.name}` });
      signedInAs(`oid-nogrant-${route.name}`);

      expect((await route.call()).status).toBe(404);
    });

    it(`${route.name}: 403 when the profile is incomplete`, async () => {
      const employee = await createEmployee({
        entraOid: `oid-incomplete-${route.name}`,
        profileCompleted: false,
      });
      await grantModule(employee.id);
      signedInAs(`oid-incomplete-${route.name}`);

      expect((await route.call()).status).toBe(403);
    });

    it(`${route.name}: writes nothing when the caller has no grant`, async () => {
      await createEmployee({ entraOid: `oid-nowrite-${route.name}` });
      signedInAs(`oid-nowrite-${route.name}`);

      await route.call();

      // No lock taken, no audit row - the guard runs before anything else.
      expect(await import("./db").then((m) => m.testDb.draftLock.count())).toBe(0);
      expect(await import("./db").then((m) => m.testDb.auditEvent.count())).toBe(0);
    });
  }
});

describe("the send route accepts nothing that could change the message", () => {
  beforeEach(async () => {
    const employee = await createEmployee({ entraOid: "oid-sender" });
    await grantModule(employee.id);
    signedInAs("oid-sender");
  });

  it("rejects a body carrying recipients", async () => {
    // The schema is strict, so a caller cannot smuggle a recipient list into a
    // send. This is what keeps the route structurally incapable of becoming
    // sendMail with a copied body.
    const response = await sendRoute(
      jsonRequest({
        expectedChangeKey: null,
        to: [{ name: null, address: "vendor@example.invalid" }],
      }),
      { ...params },
    );

    expect(response.status).toBe(422);
  });

  it("rejects a body carrying a subject or content", async () => {
    for (const extra of [{ subject: "anything" }, { body: { content: "x", format: "text" } }]) {
      const response = await sendRoute(
        jsonRequest({ expectedChangeKey: null, ...extra }),
        { ...params },
      );
      expect(response.status).toBe(422);
    }
  });

  it("requires the version the sender reviewed", async () => {
    const response = await sendRoute(jsonRequest({}), { ...params });

    expect(response.status).toBe(422);
  });

  it("writes no audit row when the send never happens", async () => {
    const { testDb } = await import("./db");

    await sendRoute(jsonRequest({ expectedChangeKey: null }), { ...params });

    // The credential is unconfigured, so nothing was sent. An audit row here
    // would be a false record of a message going out.
    expect(await testDb.auditEvent.count({ where: { action: "mail.sent" } })).toBe(0);
  });
});

describe("the save route", () => {
  beforeEach(async () => {
    const employee = await createEmployee({ entraOid: "oid-editor" });
    await grantModule(employee.id);
    signedInAs("oid-editor");
  });

  it("rejects an unknown field rather than ignoring it", async () => {
    const response = await patchRoute(
      jsonRequest({ subject: "ZZTEST x", isDraft: false }),
      { ...params },
    );

    expect(response.status).toBe(422);
  });

  it("rejects an attempt to attach something", async () => {
    const response = await patchRoute(
      jsonRequest({ attachments: [{ name: "payload.exe" }] }),
      { ...params },
    );

    expect(response.status).toBe(422);
  });

  it("rejects an empty change set", async () => {
    const response = await patchRoute(jsonRequest({}), { ...params });

    expect(response.status).toBe(422);
  });

  it("rejects an address that is not one", async () => {
    const response = await patchRoute(
      jsonRequest({ to: [{ name: null, address: "not-an-address" }] }),
      { ...params },
    );

    expect(response.status).toBe(422);
  });
});
