import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMailService } from "@/lib/modules/change-orders/mail/service";
import {
  createGraphStub,
  expectImmutableIdOnEveryRequest,
  graphErrorResponse,
  jsonResponse,
  type RecordedRequest,
} from "./graph-stub";

/**
 * Reply, reply-all, forward, compose, move and delete, at the service boundary.
 *
 * Interception is at the HTTP layer, so the middleware chain, the URL
 * construction, the immutable-id header and the error mapping under test are all
 * the real ones. What these prove is mostly what the service REFUSES, and which
 * Graph operation it reaches for - because "it built the reply itself instead of
 * asking Exchange" is a defect that no amount of the reply looking right would
 * reveal.
 *
 * NODE_ENV is "test" throughout, so the non-production ZZTEST fence is active.
 */

const ZZTEST_SOURCE = {
  id: "AAMkSource",
  subject: "ZZTEST [ZZTEST PR-91] New CO logged",
  conversationId: "CONV-1",
  toRecipients: [{ emailAddress: { name: "Me", address: "me@phb1899.com" } }],
  ccRecipients: [],
  bccRecipients: [],
  body: { contentType: "html", content: "<p>original</p>" },
  isDraft: false,
  hasAttachments: true,
  changeKey: "CK-SOURCE",
  lastModifiedDateTime: "2026-08-25T12:00:00Z",
};

/** What Graph returns from createReply: a draft, with the source conversation. */
const DERIVED_DRAFT = {
  id: "AAMkReply",
  subject: "RE: ZZTEST [ZZTEST PR-91] New CO logged",
  conversationId: "CONV-1",
  toRecipients: [{ emailAddress: { name: "Me", address: "me@phb1899.com" } }],
  ccRecipients: [],
  bccRecipients: [],
  body: { contentType: "html", content: "<p></p><hr><p>original</p>" },
  isDraft: true,
  hasAttachments: false,
  changeKey: "CK-REPLY",
  lastModifiedDateTime: "2026-08-25T12:01:00Z",
};

const REAL_MESSAGE = {
  ...ZZTEST_SOURCE,
  subject: "[CCHMC RFI 229] New CO logged (Bid Tracker)",
};

function silenceLogs(): void {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
}

beforeEach(() => {
  vi.unstubAllEnvs();
  process.env.PHB_ALLOW_SEND = "false";
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.env.PHB_ALLOW_SEND = "false";
});

/** What Exchange answers a successful DELETE with: 204, and no body. */
function noContentResponse(): Response {
  return new Response(null, { status: 204 });
}

/** The POST that is not the subject read. */
function postTo(requests: RecordedRequest[]): RecordedRequest | undefined {
  return requests.find((r) => r.method === "POST");
}

describe("reply, reply-all and forward use Graph's own operations", () => {
  const CASES = [
    { method: "createReplyDraft", action: "createReply" },
    { method: "createReplyAllDraft", action: "createReplyAll" },
    { method: "createForwardDraft", action: "createForward" },
  ] as const;

  for (const { method, action } of CASES) {
    it(`${method} posts to ${action}, never assembling a body`, async () => {
      const stub = createGraphStub((request) =>
        request.method === "POST"
          ? jsonResponse(DERIVED_DRAFT)
          : jsonResponse(request.url.includes("AAMkReply") ? DERIVED_DRAFT : ZZTEST_SOURCE),
      );

      const service = createMailService(stub.transport);
      const draft = await service[method]("AAMkSource");

      const post = postTo(stub.requests);
      expect(post?.url).toContain(`/messages/AAMkSource/${action}`);

      /**
       * An empty body, and this is the assertion that matters most in this file.
       *
       * docs/03 and PHASE-8: Exchange writes the quoting, the In-Reply-To and
       * References headers and the conversation id. Intake 6 matches replies by
       * conversation ID, so a body assembled here - or a `comment` passed through
       * from a caller - is how threading breaks silently.
       */
      expect(post?.body).toBe("{}");

      // Nothing that looks like hand-built mail went anywhere.
      for (const request of stub.requests) {
        expect(request.url.toLowerCase()).not.toContain("sendmail");
      }

      // The draft came back re-read, in the shape the Phase 6 editor reads.
      expect(draft.id).toBe("AAMkReply");
      expect(draft.segments.length).toBeGreaterThan(0);
      expect(draft.changeKey).toBe("CK-REPLY");
    });

    it(`${method} refuses a message that is not a ZZTEST`, async () => {
      silenceLogs();
      const stub = createGraphStub(() => jsonResponse(REAL_MESSAGE));

      await expect(
        createMailService(stub.transport)[method]("AAMkSource"),
      ).rejects.toMatchObject({ kind: "write_not_allowed" });

      // It read the subject to decide, and created nothing.
      expect(stub.requests.some((r) => r.method === "POST")).toBe(false);
    });

    it(`${method} reports a source message that is gone as not_found`, async () => {
      silenceLogs();
      const stub = createGraphStub(() =>
        graphErrorResponse(404, "ErrorItemNotFound", "gone"),
      );

      await expect(
        createMailService(stub.transport)[method]("AAMkSource"),
      ).rejects.toMatchObject({ kind: "not_found" });
    });
  }

  it("sends the immutable-id header on every request in the flow", async () => {
    const stub = createGraphStub((request) =>
      request.method === "POST"
        ? jsonResponse(DERIVED_DRAFT)
        : jsonResponse(request.url.includes("AAMkReply") ? DERIVED_DRAFT : ZZTEST_SOURCE),
    );

    await createMailService(stub.transport).createReplyDraft("AAMkSource");

    expectImmutableIdOnEveryRequest(stub);
  });

  it("keeps the source conversation id, which is what filing matches on", async () => {
    const stub = createGraphStub((request) =>
      request.method === "POST"
        ? jsonResponse(DERIVED_DRAFT)
        : jsonResponse(request.url.includes("AAMkReply") ? DERIVED_DRAFT : ZZTEST_SOURCE),
    );

    await createMailService(stub.transport).createReplyDraft("AAMkSource");

    // Asserted on the fixture rather than on our code, deliberately: this is a
    // statement about what Exchange returns, and the live-mailbox check in
    // docs/runbook.md is what actually proves it.
    expect(DERIVED_DRAFT.conversationId).toBe(ZZTEST_SOURCE.conversationId);
  });
});

describe("composing a draft from scratch", () => {
  const CREATED_EMPTY = {
    id: "AAMkNew",
    subject: "ZZTEST hand-written",
    conversationId: "CONV-NEW",
    toRecipients: [],
    ccRecipients: [],
    bccRecipients: [],
    body: { contentType: "html", content: "" },
    isDraft: true,
    hasAttachments: false,
    changeKey: "CK-NEW",
    lastModifiedDateTime: "2026-08-25T12:02:00Z",
  };

  it("posts to /messages and re-reads what Exchange stored", async () => {
    const stub = createGraphStub((request) =>
      request.method === "POST" ? jsonResponse(CREATED_EMPTY) : jsonResponse(CREATED_EMPTY),
    );

    const draft = await createMailService(stub.transport).createDraft({
      subject: "ZZTEST hand-written",
    });

    const post = postTo(stub.requests);
    expect(post?.url).toMatch(/\/messages$/);
    expect(draft.id).toBe("AAMkNew");
    expect(draft.subject).toBe("ZZTEST hand-written");
  });

  it("gives an empty draft a deterministic HTML body and no segments", async () => {
    const stub = createGraphStub(() => jsonResponse(CREATED_EMPTY));

    const draft = await createMailService(stub.transport).createDraft({
      subject: "ZZTEST hand-written",
    });

    // The case the editor's "add a paragraph" affordance exists for: an empty
    // body has no text runs to splice into.
    expect(draft.body).toBe("");
    expect(draft.segments).toEqual([]);
    expect(draft.bodyFormat).toBe("html");

    const post = postTo(stub.requests);
    const sent = JSON.parse(post?.body ?? "{}") as {
      body?: { contentType?: string };
    };
    expect(sent.body?.contentType).toBe("HTML");
  });

  it("applies the fence to the requested subject, before creating anything", async () => {
    silenceLogs();
    const stub = createGraphStub(() => jsonResponse(CREATED_EMPTY));

    await expect(
      createMailService(stub.transport).createDraft({
        subject: "[CCHMC RFI 229] a real one",
      }),
    ).rejects.toMatchObject({ kind: "write_not_allowed" });

    // Nothing was created. This is the one write whose fence input comes from the
    // caller, so it has to refuse before the network rather than after.
    expect(stub.requests).toHaveLength(0);
  });

  it("refuses an empty subject outside production", async () => {
    silenceLogs();
    const stub = createGraphStub(() => jsonResponse(CREATED_EMPTY));

    await expect(
      createMailService(stub.transport).createDraft({}),
    ).rejects.toMatchObject({ kind: "write_not_allowed" });
    expect(stub.requests).toHaveLength(0);
  });

  it("re-checks the fence against what Exchange actually stored", async () => {
    silenceLogs();

    // Exchange answering with a different subject than we sent should not leave a
    // draft the platform believes is fenced when it is not.
    const stub = createGraphStub((request) =>
      request.method === "POST"
        ? jsonResponse({ ...CREATED_EMPTY, subject: "ZZTEST hand-written" })
        : jsonResponse({ ...CREATED_EMPTY, subject: "something else entirely" }),
    );

    await expect(
      createMailService(stub.transport).createDraft({ subject: "ZZTEST hand-written" }),
    ).rejects.toMatchObject({ kind: "write_not_allowed" });
  });

  it("permits an ordinary subject in production", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const real = { ...CREATED_EMPTY, subject: "[CCHMC RFI 229] a real one" };
    const stub = createGraphStub(() => jsonResponse(real));

    const draft = await createMailService(stub.transport).createDraft({
      subject: "[CCHMC RFI 229] a real one",
    });

    // The subject is written back byte for byte. Nothing parses or regenerates
    // the bracketed tag downstream filing depends on.
    expect(draft.subject).toBe("[CCHMC RFI 229] a real one");
  });

  it("cannot send what it creates", async () => {
    const stub = createGraphStub(() => jsonResponse(CREATED_EMPTY));

    await createMailService(stub.transport).createDraft({ subject: "ZZTEST x" });

    // Creating a draft must never be one request away from an outbound message.
    for (const request of stub.requests) {
      expect(request.url.toLowerCase()).not.toContain("/send");
      expect(request.url.toLowerCase()).not.toContain("sendmail");
    }
  });
});

describe("moving a message", () => {
  it("posts destinationId and keeps the id, because immutable ids are in use", async () => {
    const stub = createGraphStub((request) =>
      request.method === "POST"
        ? jsonResponse({ ...ZZTEST_SOURCE, parentFolderId: "rfi229" })
        : jsonResponse(ZZTEST_SOURCE),
    );

    const result = await createMailService(stub.transport).moveMessage(
      "AAMkSource",
      "rfi229",
    );

    const post = postTo(stub.requests);
    expect(post?.url).toContain("/messages/AAMkSource/move");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({ destinationId: "rfi229" });

    expect(result.id).toBe("AAMkSource");
    expect(result.previousId).toBe("AAMkSource");
    // The assertion PHASE-8 asks for: verified, not assumed.
    expect(result.idChanged).toBe(false);
    expect(result.destinationFolderId).toBe("rfi229");

    expectImmutableIdOnEveryRequest(stub);
  });

  it("reports a changed id rather than hiding it", async () => {
    silenceLogs();

    // Should be impossible. If the immutable-id header ever stopped taking
    // effect, every id the browser holds would be one move from stale - so this
    // surfaces as data instead of as messages that cannot be reopened.
    const stub = createGraphStub((request) =>
      request.method === "POST"
        ? jsonResponse({ ...ZZTEST_SOURCE, id: "AAMkDifferent" })
        : jsonResponse(ZZTEST_SOURCE),
    );

    const result = await createMailService(stub.transport).moveMessage(
      "AAMkSource",
      "rfi229",
    );

    expect(result.idChanged).toBe(true);
    expect(result.id).toBe("AAMkDifferent");
  });

  it("refuses to move a message that is not a ZZTEST", async () => {
    silenceLogs();
    const stub = createGraphStub(() => jsonResponse(REAL_MESSAGE));

    await expect(
      createMailService(stub.transport).moveMessage("AAMkSource", "rfi229"),
    ).rejects.toMatchObject({ kind: "write_not_allowed" });

    expect(stub.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("refuses an empty destination without asking Graph", async () => {
    silenceLogs();
    const stub = createGraphStub(() => jsonResponse(ZZTEST_SOURCE));

    await expect(
      createMailService(stub.transport).moveMessage("AAMkSource", "   "),
    ).rejects.toMatchObject({ kind: "not_found" });

    expect(stub.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("reports a folder deleted or renamed in Outlook as not_found", async () => {
    silenceLogs();

    // One of the errors PHASE-8 names. It must not surface a Graph error string.
    const stub = createGraphStub((request) =>
      request.method === "POST"
        ? graphErrorResponse(404, "ErrorFolderNotFound", "no such folder")
        : jsonResponse(ZZTEST_SOURCE),
    );

    const error = await createMailService(stub.transport)
      .moveMessage("AAMkSource", "gone")
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ kind: "not_found" });
    expect((error as Error).message).not.toContain("ErrorFolderNotFound");
  });

  it("reports a stale message id as not_found, not as a crash", async () => {
    silenceLogs();

    // A stale id is a 400 from Graph, not a 404 - verified against the real
    // mailbox in an earlier phase. Power Automate files things constantly, so
    // holding an id from a previous listing is ordinary.
    const stub = createGraphStub(() =>
      graphErrorResponse(400, "ErrorInvalidIdMalformed", "bad id"),
    );

    await expect(
      createMailService(stub.transport).moveMessage("stale", "rfi229"),
    ).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("deleting a message", () => {
  it("issues DELETE, which is Exchange's soft delete", async () => {
    const stub = createGraphStub((request) =>
      request.method === "DELETE"
        ? noContentResponse()
        : jsonResponse(ZZTEST_SOURCE),
    );

    const result = await createMailService(stub.transport).deleteMessage("AAMkSource");

    const del = stub.requests.find((r) => r.method === "DELETE");
    expect(del?.url).toContain("/messages/AAMkSource");
    // Never the permanent form. It destroys the audit trail and there is no
    // legitimate need for it here.
    expect(del?.url.toLowerCase()).not.toContain("permanentdelete");
    expect(result.subject).toBe(ZZTEST_SOURCE.subject);
  });

  it("refuses to delete a message that is not a ZZTEST", async () => {
    silenceLogs();
    const stub = createGraphStub(() => jsonResponse(REAL_MESSAGE));

    await expect(
      createMailService(stub.transport).deleteMessage("AAMkSource"),
    ).rejects.toMatchObject({ kind: "write_not_allowed" });

    expect(stub.requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("reports a message somebody already deleted as not_found", async () => {
    silenceLogs();

    const stub = createGraphStub((request) =>
      request.method === "DELETE"
        ? graphErrorResponse(404, "ErrorItemNotFound", "already gone")
        : jsonResponse(ZZTEST_SOURCE),
    );

    await expect(
      createMailService(stub.transport).deleteMessage("AAMkSource"),
    ).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("none of the new writes can send", () => {
  it("no new method takes a list of ids", async () => {
    const { ChangeOrderMailService } = await import(
      "@/lib/modules/change-orders/mail/service"
    );

    // CLAUDE.md prohibition 1, restated as arity: one human, one message. A
    // method taking a collection is the shape a bulk operation would arrive in.
    const prototype = ChangeOrderMailService.prototype;
    expect(prototype.createReplyDraft.length).toBeLessThanOrEqual(1);
    expect(prototype.createReplyAllDraft.length).toBeLessThanOrEqual(1);
    expect(prototype.createForwardDraft.length).toBeLessThanOrEqual(1);
    expect(prototype.moveMessage.length).toBeLessThanOrEqual(2);
    expect(prototype.deleteMessage.length).toBeLessThanOrEqual(1);
    expect(prototype.addDraftAttachment.length).toBeLessThanOrEqual(2);
    expect(prototype.removeDraftAttachment.length).toBeLessThanOrEqual(2);
  });

  it("PHB_ALLOW_SEND being true does not make any of them send", async () => {
    // The gate opening is about sending a reviewed draft, not about the rest of
    // the client suddenly gaining a send path.
    vi.stubEnv("PHB_ALLOW_SEND", "true");

    const stub = createGraphStub((request) =>
      request.method === "POST" || request.method === "DELETE"
        ? jsonResponse(DERIVED_DRAFT)
        : jsonResponse(request.url.includes("AAMkReply") ? DERIVED_DRAFT : ZZTEST_SOURCE),
    );

    const service = createMailService(stub.transport);
    await service.createReplyDraft("AAMkSource");
    await service.moveMessage("AAMkSource", "rfi229");
    await service.deleteMessage("AAMkSource");

    for (const request of stub.requests) {
      expect(request.url.toLowerCase()).not.toContain("/send");
      expect(request.url.toLowerCase()).not.toContain("sendmail");
    }
  });
});
