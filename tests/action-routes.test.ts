import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { POST as respondRoute } from "@/app/api/modules/change-orders/messages/[messageId]/respond/route";
import { POST as moveRoute } from "@/app/api/modules/change-orders/messages/[messageId]/move/route";
import { DELETE as deleteRoute } from "@/app/api/modules/change-orders/messages/[messageId]/route";
import { GET as downloadRoute } from "@/app/api/modules/change-orders/messages/[messageId]/attachments/[attachmentId]/route";
import { POST as composeRoute } from "@/app/api/modules/change-orders/drafts/route";
import { POST as addAttachmentRoute } from "@/app/api/modules/change-orders/drafts/[messageId]/attachments/route";
import { DELETE as removeAttachmentRoute } from "@/app/api/modules/change-orders/drafts/[messageId]/attachments/[attachmentId]/route";
import {
  createEmployee,
  disconnectDb,
  grantModule,
  resetDb,
  seedChangeOrdersModule,
  testDb,
} from "./db";

/**
 * Every Phase 8 route, at the authorization boundary.
 *
 * No Graph credential is configured in the suite, so a granted caller stops at
 * "not configured". That is the contract and it is what makes these tests
 * useful: they prove the boundary and the input validation without a live
 * mailbox, and they prove that a caller who should not be here writes nothing at
 * all - no lock, no audit row - before the mailbox is ever reached.
 *
 * docs/07: "the test that matters is that an ungranted request is rejected".
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

const messageParams = { params: Promise.resolve({ messageId: "AAMkSource" }) };
const attachmentParams = {
  params: Promise.resolve({ messageId: "AAMkSource", attachmentId: "att-1" }),
};

function jsonRequest(body: unknown, method = "POST"): Request {
  return new Request("http://localhost/api/modules/change-orders/x", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** GET and DELETE take no body - the runtime refuses to construct one that has. */
function bodylessRequest(method: string): Request {
  return new Request("http://localhost/api/modules/change-orders/x", { method });
}

function uploadRequest(
  name = "notes.pdf",
  type = "application/pdf",
  bytes = new Uint8Array([1, 2, 3]),
): Request {
  const form = new FormData();
  form.set("file", new File([bytes], name, { type }));
  return new Request("http://localhost/api/modules/change-orders/x", {
    method: "POST",
    body: form,
  });
}

/** Every route Phase 8 added, so each assertion below runs against all of them. */
const ROUTES: Array<{ name: string; call: () => Promise<Response> }> = [
  {
    name: "reply",
    call: () => respondRoute(jsonRequest({ mode: "reply" }), { ...messageParams }),
  },
  {
    name: "reply-all",
    call: () => respondRoute(jsonRequest({ mode: "replyAll" }), { ...messageParams }),
  },
  {
    name: "forward",
    call: () => respondRoute(jsonRequest({ mode: "forward" }), { ...messageParams }),
  },
  {
    name: "compose",
    call: () => composeRoute(jsonRequest({ subject: "ZZTEST x" })),
  },
  {
    name: "move",
    call: () =>
      moveRoute(jsonRequest({ destinationFolderId: "rfi229" }), { ...messageParams }),
  },
  {
    name: "delete",
    call: () => deleteRoute(bodylessRequest("DELETE"), { ...messageParams }),
  },
  {
    name: "download attachment",
    call: () => downloadRoute(bodylessRequest("GET"), { ...attachmentParams }),
  },
  {
    name: "add attachment",
    call: () => addAttachmentRoute(uploadRequest(), { ...messageParams }),
  },
  {
    name: "remove attachment",
    call: () =>
      removeAttachmentRoute(bodylessRequest("DELETE"), { ...attachmentParams }),
  },
];

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
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

describe("every Phase 8 route is behind the module grant", () => {
  for (const route of ROUTES) {
    it(`${route.name}: 401 when unauthenticated`, async () => {
      authMock.mockResolvedValue(null as never);
      expect((await route.call()).status).toBe(401);
    });

    it(`${route.name}: 404 - not 403 - without the grant`, async () => {
      // 404, so an ungranted caller learns nothing about what exists.
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

    it(`${route.name}: writes nothing without the grant`, async () => {
      await createEmployee({ entraOid: `oid-nowrite-${route.name}` });
      signedInAs(`oid-nowrite-${route.name}`);

      await route.call();

      // No lock, no audit row. The guard runs before anything else, so a caller
      // who should not be here leaves no trace in the platform either.
      expect(await testDb.draftLock.count()).toBe(0);
      expect(await testDb.auditEvent.count()).toBe(0);
    });
  }
});

describe("the respond route accepts nothing that could put content in a message", () => {
  beforeEach(async () => {
    const employee = await createEmployee({ entraOid: "oid-responder" });
    await grantModule(employee.id);
    signedInAs("oid-responder");
  });

  it("rejects an unknown mode", async () => {
    const response = await respondRoute(
      jsonRequest({ mode: "sendToEveryone" }),
      { ...messageParams },
    );

    expect(response.status).toBe(422);
  });

  it("rejects a comment, a body or recipients alongside the mode", async () => {
    /**
     * The reason this matters: `createReply` accepts a `comment`, and Graph would
     * put it in the draft. Accepting one here would be a second way to get
     * content into an outbound message, and the safety model rests on there
     * being exactly one - the editor, which a human is looking at.
     */
    for (const body of [
      { mode: "reply", comment: "please pay this" },
      { mode: "reply", body: { content: "<p>x</p>", format: "html" } },
      { mode: "reply", to: [{ name: null, address: "vendor@example.com" }] },
      { mode: "forward", toRecipients: [] },
      { mode: "reply", subject: "ZZTEST x" },
    ]) {
      const response = await respondRoute(jsonRequest(body), { ...messageParams });
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
  });

  it("rejects a missing body entirely", async () => {
    const bare = new Request("http://localhost/x", { method: "POST" });
    expect((await respondRoute(bare, { ...messageParams })).status).toBe(422);
  });

  it("has no way to ask it for more than one message", async () => {
    for (const body of [
      { mode: ["reply", "forward"] },
      { messageIds: ["a", "b"], mode: "reply" },
      { mode: "reply", count: 2 },
    ]) {
      const response = await respondRoute(jsonRequest(body), { ...messageParams });
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
  });
});

describe("the compose route creates a draft and nothing else", () => {
  beforeEach(async () => {
    const employee = await createEmployee({ entraOid: "oid-composer" });
    await grantModule(employee.id);
    signedInAs("oid-composer");
  });

  it("accepts an absent body as an empty draft", async () => {
    const bare = new Request("http://localhost/x", { method: "POST" });

    // Not a validation failure: "create me an empty draft" is a legitimate ask.
    // It stops at "not configured" because the suite has no Graph credential.
    const response = await composeRoute(bare);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: "mail_not_configured" },
    });
  });

  it("rejects anything that looks like sending", async () => {
    for (const body of [
      { subject: "ZZTEST x", send: true },
      { subject: "ZZTEST x", sendAt: "2026-09-01T00:00:00Z" },
      { subject: "ZZTEST x", saveToSentItems: false },
    ]) {
      expect((await composeRoute(jsonRequest(body))).status).toBe(422);
    }
  });

  it("rejects a recipient that is not an email address", async () => {
    const response = await composeRoute(
      jsonRequest({ subject: "ZZTEST x", to: [{ name: null, address: "not-an-address" }] }),
    );

    expect(response.status).toBe(422);
  });
});

describe("the move route takes one folder id and nothing else", () => {
  beforeEach(async () => {
    const employee = await createEmployee({ entraOid: "oid-mover" });
    await grantModule(employee.id);
    signedInAs("oid-mover");
  });

  it("rejects a missing or empty destination", async () => {
    for (const body of [{}, { destinationFolderId: "" }, { destinationFolderId: "   " }]) {
      expect(
        (await moveRoute(jsonRequest(body), { ...messageParams })).status,
        JSON.stringify(body),
      ).toBe(422);
    }
  });

  it("rejects a list of destinations", async () => {
    const response = await moveRoute(
      jsonRequest({ destinationFolderId: ["a", "b"] }),
      { ...messageParams },
    );

    expect(response.status).toBe(422);
  });

  it("rejects an unknown field", async () => {
    const response = await moveRoute(
      jsonRequest({ destinationFolderId: "rfi229", andDelete: true }),
      { ...messageParams },
    );

    expect(response.status).toBe(422);
  });
});

describe("the attachment upload route", () => {
  beforeEach(async () => {
    const employee = await createEmployee({ entraOid: "oid-uploader" });
    await grantModule(employee.id);
    signedInAs("oid-uploader");
  });

  it("rejects a request with no file", async () => {
    const form = new FormData();
    form.set("notafile", "hello");

    const response = await addAttachmentRoute(
      new Request("http://localhost/x", { method: "POST", body: form }),
      { ...messageParams },
    );

    expect(response.status).toBe(422);
  });

  it("rejects a JSON body rather than crashing on it", async () => {
    const response = await addAttachmentRoute(
      jsonRequest({ contentBytes: "AAAA" }),
      { ...messageParams },
    );

    // A parse failure must be the platform's 422, not an HTML 500 from the
    // framework - which is what would happen if the parse ran outside the
    // route wrapper's error boundary.
    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("rejects a file over the limit before reaching the mailbox", async () => {
    const { MAX_ATTACHMENT_BYTES } = await import(
      "@/lib/modules/change-orders/mail/attachments"
    );

    const response = await addAttachmentRoute(
      uploadRequest(
        "huge.pdf",
        "application/pdf",
        new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
      ),
      { ...messageParams },
    );

    expect(response.status).toBe(422);
    // Nothing was written, and nothing was asked of Graph.
    expect(await testDb.auditEvent.count()).toBe(0);
  });

  it("gets as far as the mailbox with an acceptable file", async () => {
    // Proof the refusals above are about the file rather than about the route
    // being broken: a legitimate upload reaches the "not configured" answer.
    const response = await addAttachmentRoute(uploadRequest(), { ...messageParams });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: "mail_not_configured" },
    });
  });
});

describe("no Phase 8 route exposes a permanent delete", () => {
  beforeEach(async () => {
    const employee = await createEmployee({ entraOid: "oid-deleter" });
    await grantModule(employee.id);
    signedInAs("oid-deleter");
  });

  it("has no route file that mentions it", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const path = await import("node:path");

    const root = path.resolve(
      process.cwd(),
      "app/api/modules/change-orders",
    );
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => path.join(entry.parentPath ?? root, entry.name));

    expect(files.length).toBeGreaterThan(5);

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const code = source
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join("\n");

      expect(code, `${file}`).not.toContain("permanentDelete");
      expect(code, `${file}`).not.toContain("sendMail");
    }
  });
});
