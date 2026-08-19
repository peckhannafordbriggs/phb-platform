import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMailService } from "@/lib/modules/change-orders/mail/service";
import { createGraphStub, graphErrorResponse, jsonResponse } from "./graph-stub";

/**
 * The write path.
 *
 * This is the phase that can send email to people outside the company, so these
 * tests are about what the service REFUSES. The negative cases are the point:
 * docs/07 - "the test that matters is that an ungranted request is rejected".
 *
 * NODE_ENV is "test" throughout, so the non-production ZZTEST fence is active
 * unless a case stubs otherwise.
 */

const ZZTEST_DRAFT = {
  id: "AAMkDraft",
  subject: "ZZTEST [CCHMC RFI 229] Change Order Request",
  toRecipients: [{ emailAddress: { name: "Me", address: "me@phb1899.com" } }],
  ccRecipients: [],
  bccRecipients: [],
  body: { contentType: "html", content: "<p>original</p>" },
  isDraft: true,
  hasAttachments: true,
  changeKey: "CHANGEKEY-1",
  lastModifiedDateTime: "2026-08-19T12:00:00Z",
};

const REAL_DRAFT = { ...ZZTEST_DRAFT, subject: "[CCHMC RFI 229] Change Order Request" };
const SENT_MESSAGE = { ...ZZTEST_DRAFT, isDraft: false };

function silenceLogs(): void {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
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

describe("the send gate", () => {
  it("refuses a send with PHB_ALLOW_SEND unset, before any Graph request", async () => {
    silenceLogs();
    vi.stubEnv("PHB_ALLOW_SEND", undefined);

    const stub = createGraphStub(() => jsonResponse(ZZTEST_DRAFT));

    await expect(
      createMailService(stub.transport).sendDraft("AAMkDraft"),
    ).rejects.toMatchObject({ kind: "send_not_allowed" });

    // The gate is checked before the network. A closed gate must not cause
    // Exchange to be asked about a message that was never going to be sent.
    expect(stub.requests).toHaveLength(0);
  });

  it("refuses on anything that is not exactly \"true\"", async () => {
    silenceLogs();
    const stub = createGraphStub(() => jsonResponse(ZZTEST_DRAFT));
    const service = createMailService(stub.transport);

    for (const value of ["false", "TRUE", "True", "1", "yes", "true ", ""]) {
      vi.stubEnv("PHB_ALLOW_SEND", value);
      await expect(
        service.sendDraft("AAMkDraft"),
        `PHB_ALLOW_SEND=${JSON.stringify(value)} must not open the gate`,
      ).rejects.toMatchObject({ kind: "send_not_allowed" });
    }

    expect(stub.requests).toHaveLength(0);
  });

  it("still applies the ZZTEST fence when the gate is open", async () => {
    silenceLogs();
    vi.stubEnv("PHB_ALLOW_SEND", "true");

    const stub = createGraphStub(() => jsonResponse(REAL_DRAFT));

    // An open gate outside production is not a licence to send a real
    // change-order draft to a vendor.
    await expect(
      createMailService(stub.transport).sendDraft("AAMkDraft"),
    ).rejects.toMatchObject({ kind: "write_not_allowed" });

    // It read the subject to decide, and then sent nothing.
    expect(stub.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("sends a ZZTEST draft when the gate is open", async () => {
    vi.stubEnv("PHB_ALLOW_SEND", "true");

    const stub = createGraphStub((request) =>
      request.method === "POST" ? jsonResponse({}, { status: 202 }) : jsonResponse(ZZTEST_DRAFT),
    );

    const result = await createMailService(stub.transport).sendDraft("AAMkDraft");

    expect(result.subject).toBe(ZZTEST_DRAFT.subject);
    expect(result.to.map((a) => a.address)).toEqual(["me@phb1899.com"]);

    const post = stub.requests.find((r) => r.method === "POST");
    expect(post?.url).toContain("/messages/AAMkDraft/send");
    // An empty body. Nothing about the message came from the caller.
    expect(post?.body).toBe("{}");
  });
});

describe("sendMail is never used", () => {
  it("posts to the draft's own send action, not to sendMail", async () => {
    vi.stubEnv("PHB_ALLOW_SEND", "true");

    const stub = createGraphStub((request) =>
      request.method === "POST" ? jsonResponse({}, { status: 202 }) : jsonResponse(ZZTEST_DRAFT),
    );

    await createMailService(stub.transport).sendDraft("AAMkDraft");

    for (const request of stub.requests) {
      // sendMail with a copied body would drop the attachments Power Automate
      // attached, the subject tag downstream filing depends on, and threading.
      expect(request.url.toLowerCase()).not.toContain("sendmail");
    }
  });
});

describe("the ZZTEST fence on edits", () => {
  it("refuses an edit to a draft that is not a ZZTEST", async () => {
    silenceLogs();
    const stub = createGraphStub(() => jsonResponse(REAL_DRAFT));

    await expect(
      createMailService(stub.transport).updateDraft("AAMkDraft", { subject: "new" }),
    ).rejects.toMatchObject({ kind: "write_not_allowed" });

    expect(stub.requests.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("reads the subject from Exchange, not from the caller", async () => {
    silenceLogs();
    const stub = createGraphStub(() => jsonResponse(REAL_DRAFT));

    // Renaming it to ZZTEST in the same request must not open the fence: the
    // decision is made on what is actually in the mailbox.
    await expect(
      createMailService(stub.transport).updateDraft("AAMkDraft", {
        subject: "ZZTEST now",
      }),
    ).rejects.toMatchObject({ kind: "write_not_allowed" });
  });

  it("permits an edit to a ZZTEST draft", async () => {
    const stub = createGraphStub((request) =>
      request.method === "PATCH" ? jsonResponse(ZZTEST_DRAFT) : jsonResponse(ZZTEST_DRAFT),
    );

    await createMailService(stub.transport).updateDraft("AAMkDraft", {
      subject: ZZTEST_DRAFT.subject,
    });

    expect(stub.requests.some((r) => r.method === "PATCH")).toBe(true);
  });

  it("does not apply outside... in production", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const stub = createGraphStub(() => jsonResponse(REAL_DRAFT));

    await createMailService(stub.transport).updateDraft("AAMkDraft", {
      subject: "a real subject",
    });

    expect(stub.requests.some((r) => r.method === "PATCH")).toBe(true);
  });
});

describe("only drafts can be written", () => {
  it("refuses to edit a message that has been sent", async () => {
    const stub = createGraphStub(() => jsonResponse(SENT_MESSAGE));

    await expect(
      createMailService(stub.transport).updateDraft("AAMkDraft", { subject: "x" }),
    ).rejects.toMatchObject({ kind: "not_draft" });

    expect(stub.requests.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("refuses to send a message that has been sent", async () => {
    vi.stubEnv("PHB_ALLOW_SEND", "true");
    const stub = createGraphStub(() => jsonResponse(SENT_MESSAGE));

    await expect(
      createMailService(stub.transport).sendDraft("AAMkDraft"),
    ).rejects.toMatchObject({ kind: "not_draft" });

    expect(stub.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("refuses to open a non-draft for editing", async () => {
    const stub = createGraphStub(() => jsonResponse(SENT_MESSAGE));

    await expect(
      createMailService(stub.transport).getDraftForEdit("AAMkDraft"),
    ).rejects.toMatchObject({ kind: "not_draft" });
  });
});

describe("what a PATCH actually contains", () => {
  async function patchBodyFor(changes: Parameters<
    ReturnType<typeof createMailService>["updateDraft"]
  >[1]): Promise<Record<string, unknown>> {
    const stub = createGraphStub(() => jsonResponse(ZZTEST_DRAFT));
    await createMailService(stub.transport).updateDraft("AAMkDraft", changes);

    const patch = stub.requests.find((r) => r.method === "PATCH");
    return JSON.parse(patch?.body ?? "{}") as Record<string, unknown>;
  }

  it("never mentions attachments, so Exchange leaves them alone", async () => {
    const body = await patchBodyFor({
      subject: ZZTEST_DRAFT.subject,
      body: { content: "<p>edited</p>", format: "html" },
    });

    expect(body).not.toHaveProperty("attachments");
    expect(body).not.toHaveProperty("hasAttachments");
  });

  it("writes the subject back byte for byte, tag and all", async () => {
    const tagged = "ZZTEST [CCHMC Bulletin 12] Change Order Request — Additional Information Needed";
    const body = await patchBodyFor({ subject: tagged });

    // Nothing parses, normalizes or regenerates the tag. Downstream filing
    // depends on the exact string.
    expect(body.subject).toBe(tagged);
  });

  it("sends only the fields that were supplied", async () => {
    const body = await patchBodyFor({ subject: ZZTEST_DRAFT.subject });

    expect(Object.keys(body)).toEqual(["subject"]);
    expect(body).not.toHaveProperty("toRecipients");
    expect(body).not.toHaveProperty("body");
  });

  it("does not write at all when there is nothing to change", async () => {
    const stub = createGraphStub(() => jsonResponse(ZZTEST_DRAFT));

    await createMailService(stub.transport).updateDraft("AAMkDraft", {});

    expect(stub.requests.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("maps recipients into the Graph shape", async () => {
    const body = await patchBodyFor({
      to: [{ name: "Someone", address: "someone@phb1899.com" }],
    });

    expect(body.toRecipients).toEqual([
      { emailAddress: { address: "someone@phb1899.com", name: "Someone" } },
    ]);
  });
});

describe("a draft that changed underneath the editor", () => {
  it("refuses a save against a stale version", async () => {
    const stub = createGraphStub(() =>
      jsonResponse({ ...ZZTEST_DRAFT, changeKey: "CHANGEKEY-2" }),
    );

    await expect(
      createMailService(stub.transport).updateDraft("AAMkDraft", {
        subject: ZZTEST_DRAFT.subject,
        expectedChangeKey: "CHANGEKEY-1",
      }),
    ).rejects.toMatchObject({ kind: "conflict" });

    // Nothing was overwritten.
    expect(stub.requests.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("refuses a send against a version the sender did not review", async () => {
    vi.stubEnv("PHB_ALLOW_SEND", "true");
    const stub = createGraphStub(() =>
      jsonResponse({ ...ZZTEST_DRAFT, changeKey: "CHANGEKEY-2" }),
    );

    await expect(
      createMailService(stub.transport).sendDraft("AAMkDraft", {
        expectedChangeKey: "CHANGEKEY-1",
      }),
    ).rejects.toMatchObject({ kind: "conflict" });

    // The whole point: content nobody read must not go out.
    expect(stub.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("saves when the version matches", async () => {
    const stub = createGraphStub(() => jsonResponse(ZZTEST_DRAFT));

    await createMailService(stub.transport).updateDraft("AAMkDraft", {
      subject: ZZTEST_DRAFT.subject,
      expectedChangeKey: "CHANGEKEY-1",
    });

    expect(stub.requests.some((r) => r.method === "PATCH")).toBe(true);
  });
});

describe("errors that will actually happen", () => {
  it("reports a draft deleted from Outlook as not_found", async () => {
    const stub = createGraphStub(() =>
      graphErrorResponse(404, "ErrorItemNotFound", "gone"),
    );

    await expect(
      createMailService(stub.transport).getDraftForEdit("AAMkDraft"),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("reports a stale immutable id as not_found, not as a fault", async () => {
    const stub = createGraphStub(() =>
      graphErrorResponse(400, "ErrorInvalidIdMalformed", "bad id"),
    );

    await expect(
      createMailService(stub.transport).getDraftForEdit("stale"),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("surfaces no Graph error string to the caller", async () => {
    const stub = createGraphStub(() =>
      graphErrorResponse(403, "ErrorAccessDenied", "ApplicationAccessPolicy blocked"),
    );

    const error = await createMailService(stub.transport)
      .getDraftForEdit("AAMkDraft")
      .then(() => null)
      .catch((e: unknown) => e as { userMessage: string });

    expect(error?.userMessage).not.toContain("ApplicationAccessPolicy");
    expect(error?.userMessage).not.toContain("403");
  });
});

describe("text-only body editing", () => {
  const HTML_DRAFT = {
    ...ZZTEST_DRAFT,
    body: {
      contentType: "html",
      content:
        '<html><head><style>p{margin:0}</style></head><body dir="ltr">' +
        '<table border="1" style="border-collapse:collapse">' +
        '<tr style="background-color:rgb(242,242,242)"><th><div style="font-size:11pt">Due Date</div></th></tr>' +
        '<tr><td><div style="font-size:11pt">07/30/2026</div></td></tr>' +
        "</table></body></html>",
    },
  };

  async function patchBodyFor(
    changes: Parameters<ReturnType<typeof createMailService>["updateDraft"]>[1],
  ): Promise<{ content: string } | undefined> {
    const stub = createGraphStub(() => jsonResponse(HTML_DRAFT));
    await createMailService(stub.transport).updateDraft("AAMkDraft", changes);

    const patch = stub.requests.find((r) => r.method === "PATCH");
    if (patch === undefined) return undefined;
    return (JSON.parse(patch.body ?? "{}") as { body?: { content: string } }).body;
  }

  it("offers the message text but not the markup", async () => {
    const stub = createGraphStub(() => jsonResponse(HTML_DRAFT));
    const draft = await createMailService(stub.transport).getDraftForEdit("AAMkDraft");

    expect(draft.segments.map((s) => s.text)).toEqual(["Due Date", "07/30/2026"]);
    // The <style> block's CSS must never be presented as message text.
    expect(draft.segments.map((s) => s.text).join(" ")).not.toContain("margin");
  });

  it("changes only the edited words, keeping every style attribute", async () => {
    const stub = createGraphStub(() => jsonResponse(HTML_DRAFT));
    const service = createMailService(stub.transport);
    const draft = await service.getDraftForEdit("AAMkDraft");
    const dueDate = draft.segments.find((s) => s.text === "07/30/2026")!;

    const written = await patchBodyFor({
      bodyEdits: [{ id: dueDate.id, text: "08/15/2026" }],
    });

    expect(written?.content).toContain("08/15/2026");
    expect(written?.content).not.toContain("07/30/2026");
    // Everything sanitizing would have destroyed is still here.
    expect(written?.content).toContain('style="background-color:rgb(242,242,242)"');
    expect(written?.content).toContain("border-collapse:collapse");
    expect(written?.content).toContain("<style>p{margin:0}</style>");
    expect(written?.content).toContain('dir="ltr"');
  });

  it("does not write when the edits change nothing", async () => {
    const stub = createGraphStub(() => jsonResponse(HTML_DRAFT));
    const service = createMailService(stub.transport);
    const draft = await service.getDraftForEdit("AAMkDraft");

    // Re-submitting the current text is not a change, and must not cost a write
    // to the live mailbox.
    await service.updateDraft("AAMkDraft", {
      bodyEdits: draft.segments.map((s) => ({ id: s.id, text: s.text })),
    });

    expect(stub.requests.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("appends a note without rewriting what is above it", async () => {
    const written = await patchBodyFor({ appendNote: "Please confirm by Friday." });

    expect(written?.content).toContain("<p>Please confirm by Friday.</p></body>");
    expect(written?.content).toContain("border-collapse:collapse");
    expect(written?.content).toContain("07/30/2026");
  });

  it("encodes typed text so it cannot become markup", async () => {
    const stub = createGraphStub(() => jsonResponse(HTML_DRAFT));
    const service = createMailService(stub.transport);
    const draft = await service.getDraftForEdit("AAMkDraft");

    const written = await patchBodyFor({
      bodyEdits: [{ id: draft.segments[0]!.id, text: "<script>alert(1)</script>" }],
    });

    expect(written?.content).not.toContain("<script>alert(1)</script>");
    expect(written?.content).toContain("&lt;script&gt;");
  });

  it("applies text edits to the body in Exchange, not one supplied by a caller", async () => {
    const stub = createGraphStub(() => jsonResponse(HTML_DRAFT));
    const service = createMailService(stub.transport);
    const draft = await service.getDraftForEdit("AAMkDraft");

    // A caller cannot smuggle a whole replacement body through the edit path:
    // the splice always starts from what Exchange currently holds.
    const written = await patchBodyFor({
      bodyEdits: [{ id: draft.segments[0]!.id, text: "Changed" }],
    });

    expect(written?.content).toContain("<style>p{margin:0}</style>");
    expect(written?.content).toContain("Changed");
  });

  it("a plain-text draft offers no segments and is edited whole", async () => {
    const stub = createGraphStub(() =>
      jsonResponse({
        ...ZZTEST_DRAFT,
        body: { contentType: "text", content: "plain body" },
      }),
    );

    const draft = await createMailService(stub.transport).getDraftForEdit("AAMkDraft");

    expect(draft.bodyFormat).toBe("text");
    expect(draft.segments).toEqual([]);
  });
});
