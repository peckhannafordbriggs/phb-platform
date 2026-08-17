import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMailService } from "@/lib/modules/change-orders/mail/service";
import { createGraphStub, jsonResponse } from "./graph-stub";
import { TEST_MAILBOX } from "./constants";

/**
 * The service boundary. What these tests care about is not that Graph works, but
 * that nothing about Graph escapes upward and nothing about the mailbox can be
 * influenced from above.
 */

const ENCODED_MAILBOX = encodeURIComponent(TEST_MAILBOX);

const INBOX = {
  id: "folder-inbox",
  displayName: "Inbox",
  wellKnownName: "inbox",
  totalItemCount: 40,
  unreadItemCount: 2,
  childFolderCount: 0,
  parentFolderId: "root",
};

const PROJECTS = {
  id: "folder-projects",
  displayName: "Projects",
  wellKnownName: null,
  totalItemCount: 0,
  unreadItemCount: 0,
  childFolderCount: 2,
  parentFolderId: "root",
};

describe("the mailbox cannot be supplied by a caller", () => {
  it("targets CO_MAILBOX on every request", async () => {
    const stub = createGraphStub(() => jsonResponse({ value: [INBOX] }));
    const service = createMailService(stub.transport);

    await service.listFolders();
    await service.getFolder("folder-inbox");
    await service.listMessages("folder-inbox");
    await service.getMessage("message-1");
    await service.listAttachments("message-1");

    expect(stub.requests.length).toBeGreaterThanOrEqual(5);
    for (const request of stub.requests) {
      expect(request.url).toContain(`/users/${ENCODED_MAILBOX}/`);
    }
  });

  it("cannot be redirected by feeding a mailbox address in as an id", async () => {
    // The live mailbox. A caller passing it where an id is expected must not
    // cause a single request to be aimed at it.
    const LIVE_MAILBOX = "changeorder@phb1899.com";

    const stub = createGraphStub(() => jsonResponse({ value: [], id: "x" }));
    const service = createMailService(stub.transport);

    await service.getFolder(LIVE_MAILBOX);
    await service.listMessages(LIVE_MAILBOX, { skipToken: LIVE_MAILBOX });
    await service.getMessage(LIVE_MAILBOX);
    await service.listAttachments(LIVE_MAILBOX);

    expect(stub.requests.length).toBeGreaterThanOrEqual(4);
    for (const request of stub.requests) {
      expect(request.url).toContain(`/users/${ENCODED_MAILBOX}/`);
      expect(request.url).not.toContain(`/users/${encodeURIComponent(LIVE_MAILBOX)}`);
      expect(request.url).not.toContain(`/users/${LIVE_MAILBOX}`);
    }
  });

  it("ignores an id that tries to escape the mailbox path", async () => {
    const stub = createGraphStub(() => jsonResponse(INBOX));
    const service = createMailService(stub.transport);

    await service.getFolder("../../other-mailbox@example.invalid/mailFolders/inbox");

    const url = stub.requests[0]?.url ?? "";
    expect(url).toContain(`/users/${ENCODED_MAILBOX}/mailFolders/`);
    // The traversal is encoded into a single path segment rather than acted on.
    expect(url).not.toContain("/../");
    expect(url).toContain("..%2F..%2F");
  });
});

describe("listFolders", () => {
  it("returns well-known folders plus the children of folders that have them", async () => {
    const stub = createGraphStub((request) =>
      request.url.includes("/childFolders")
        ? jsonResponse({
            value: [
              {
                id: "folder-project-a",
                displayName: "Project A",
                wellKnownName: null,
                totalItemCount: 5,
                unreadItemCount: 1,
                childFolderCount: 0,
                parentFolderId: "folder-projects",
              },
            ],
          })
        : jsonResponse({ value: [INBOX, PROJECTS] }),
    );

    const folders = await createMailService(stub.transport).listFolders();

    expect(folders.map((f) => f.displayName)).toEqual([
      "Inbox",
      "Projects",
      "Project A",
    ]);
    expect(folders[0]?.wellKnownName).toBe("inbox");
    expect(folders[2]?.parentFolderId).toBe("folder-projects");

    // One request for the top level, one for the only folder with children -
    // not one per folder.
    expect(stub.requests).toHaveLength(2);
  });

  it("follows pagination rather than truncating at one page", async () => {
    const stub = createGraphStub((request, index) =>
      index === 0
        ? jsonResponse({
            value: [INBOX],
            "@odata.nextLink":
              "https://graph.microsoft.com/v1.0/users/x/mailFolders?$skiptoken=PAGE2",
          })
        : jsonResponse({
            value: [{ ...INBOX, id: "folder-drafts", displayName: "Drafts" }],
          }),
    );

    const folders = await createMailService(stub.transport).listFolders();

    expect(folders.map((f) => f.displayName)).toEqual(["Inbox", "Drafts"]);
    expect(stub.requests[1]?.url.toLowerCase()).toContain("skiptoken=page2");
  });
});

describe("listMessages", () => {
  const MESSAGE = {
    id: "AAMkAGImmutable",
    conversationId: "conv-1",
    subject: "[CO: Owner|Bulletin] CO 1234 pricing",
    from: { emailAddress: { name: "Vendor Co", address: "sales@vendor.invalid" } },
    toRecipients: [
      { emailAddress: { name: "Change Orders", address: TEST_MAILBOX } },
    ],
    receivedDateTime: "2026-08-17T12:00:00Z",
    isDraft: false,
    isRead: true,
    hasAttachments: true,
  };

  it("returns metadata only, and never requests a body", async () => {
    const stub = createGraphStub(() => jsonResponse({ value: [MESSAGE] }));

    const page = await createMailService(stub.transport).listMessages("folder-inbox");

    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toEqual({
      id: "AAMkAGImmutable",
      conversationId: "conv-1",
      subject: "[CO: Owner|Bulletin] CO 1234 pricing",
      from: { name: "Vendor Co", address: "sales@vendor.invalid" },
      to: [{ name: "Change Orders", address: TEST_MAILBOX }],
      receivedDateTime: "2026-08-17T12:00:00Z",
      isDraft: false,
      isRead: true,
      hasAttachments: true,
    });

    const url = decodeURIComponent(stub.requests[0]?.url ?? "");
    expect(url).toContain("$select=");
    expect(url).not.toContain("body");
  });

  it("hands back a skip token, not a Graph URL", async () => {
    const stub = createGraphStub(() =>
      jsonResponse({
        value: [MESSAGE],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/users/x/messages?%24skiptoken=NEXTPAGE",
      }),
    );

    const page = await createMailService(stub.transport).listMessages("folder-inbox");

    expect(page.nextSkipToken).toBe("NEXTPAGE");
    expect(page.nextSkipToken).not.toContain("http");
  });

  it("clamps an unbounded page size", async () => {
    const stub = createGraphStub(() => jsonResponse({ value: [] }));

    await createMailService(stub.transport).listMessages("folder-inbox", {
      top: 5000,
    });

    expect(decodeURIComponent(stub.requests[0]?.url ?? "")).toContain("$top=100");
  });

  it("orders newest first on the first page only", async () => {
    const stub = createGraphStub(() => jsonResponse({ value: [] }));
    const service = createMailService(stub.transport);

    await service.listMessages("folder-inbox");
    await service.listMessages("folder-inbox", { skipToken: "PAGE2" });

    expect(decodeURIComponent(stub.requests[0]?.url ?? "")).toContain(
      "$orderby=receivedDateTime desc",
    );
    // The token already encodes the order; Graph rejects the combination.
    expect(decodeURIComponent(stub.requests[1]?.url ?? "")).not.toContain("$orderby");
  });
});

describe("getMessage", () => {
  it("sanitizes an HTML body before it leaves the service", async () => {
    const hostile =
      '<p>Quote attached</p><script>fetch("https://evil.invalid")</script>' +
      '<img src="https://tracker.invalid/px.gif">';

    const stub = createGraphStub(() =>
      jsonResponse({
        id: "message-1",
        subject: "Pricing",
        body: { contentType: "html", content: hostile },
      }),
    );

    const message = await createMailService(stub.transport).getMessage("message-1");

    expect(message.body?.format).toBe("html");
    expect(message.body?.content).toContain("Quote attached");
    expect(message.body?.content).not.toContain("script");
    expect(message.body?.content).not.toContain("evil.invalid");
    expect(message.body?.remoteImagesBlocked).toBe(1);
  });

  it("passes a plain-text body through untouched", async () => {
    const stub = createGraphStub(() =>
      jsonResponse({
        id: "message-1",
        body: { contentType: "text", content: "Price is 4,200.00 <not html>" },
      }),
    );

    const message = await createMailService(stub.transport).getMessage("message-1");

    expect(message.body).toEqual({
      content: "Price is 4,200.00 <not html>",
      format: "text",
      remoteImagesBlocked: 0,
    });
  });

  it("tolerates a message with no body at all", async () => {
    const stub = createGraphStub(() => jsonResponse({ id: "message-1" }));

    const message = await createMailService(stub.transport).getMessage("message-1");

    expect(message.body).toBeNull();
    expect(message.subject).toBeNull();
    expect(message.to).toEqual([]);
  });
});

describe("listAttachments", () => {
  it("returns metadata and never asks Graph for content", async () => {
    const stub = createGraphStub(() =>
      jsonResponse({
        value: [
          {
            "@odata.type": "#microsoft.graph.fileAttachment",
            id: "attachment-1",
            name: "quote.pdf",
            contentType: "application/pdf",
            size: 84_512,
            isInline: false,
          },
          {
            "@odata.type": "#microsoft.graph.itemAttachment",
            id: "attachment-2",
            name: "Forwarded RFQ",
            contentType: null,
            size: 12_000,
            isInline: false,
          },
        ],
      }),
    );

    const attachments = await createMailService(stub.transport).listAttachments(
      "message-1",
    );

    expect(attachments).toEqual([
      {
        id: "attachment-1",
        name: "quote.pdf",
        contentType: "application/pdf",
        sizeBytes: 84_512,
        isInline: false,
        isItemAttachment: false,
      },
      {
        id: "attachment-2",
        name: "Forwarded RFQ",
        contentType: null,
        sizeBytes: 12_000,
        isInline: false,
        isItemAttachment: true,
      },
    ]);

    // GET /attachments returns contentBytes by default. The $select is what
    // stops that, so assert it is actually narrow.
    const select = decodeURIComponent(stub.requests[0]?.url ?? "");
    expect(select).toContain("$select=id,name,contentType,size,isInline");
    expect(select).not.toContain("contentBytes");
  });
});

describe("logging", () => {
  let logLines: string[];

  beforeEach(() => {
    logLines = [];
    const capture = (...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    };
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never writes a message body, a subject or a recipient list", async () => {
    const bodyMarker = "CONFIDENTIAL-BODY-CONTENT-MARKER";
    const subjectMarker = "CONFIDENTIAL-SUBJECT-MARKER";

    const stub = createGraphStub(() =>
      jsonResponse({
        id: "message-1",
        subject: subjectMarker,
        body: { contentType: "text", content: bodyMarker },
        toRecipients: [
          { emailAddress: { address: "someone-private@vendor.invalid" } },
        ],
      }),
    );

    await createMailService(stub.transport).getMessage("message-1");

    const combined = logLines.join("\n");
    expect(combined).not.toContain(bodyMarker);
    expect(combined).not.toContain(subjectMarker);
    expect(combined).not.toContain("someone-private@vendor.invalid");
  });
});
