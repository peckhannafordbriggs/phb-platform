import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMailService } from "@/lib/modules/change-orders/mail/service";
import { createGraphStub, graphErrorResponse, jsonResponse } from "./graph-stub";
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
  totalItemCount: 40,
  unreadItemCount: 2,
  childFolderCount: 0,
  parentFolderId: "root",
};

const PROJECTS = {
  id: "folder-projects",
  displayName: "Projects",
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

/**
 * Graph v1.0 does not expose wellKnownName on mailFolder - selecting it fails the
 * whole request with 400 - so the service resolves the well-known folders by
 * their aliases instead. These handlers answer the alias lookups the way Graph
 * does: `/mailFolders/inbox` returns that folder, and an alias the mailbox does
 * not have is a 404.
 */
const ALIAS_IDS: Record<string, string> = {
  inbox: "folder-inbox",
  drafts: "folder-drafts",
  sentitems: "folder-sent",
  deleteditems: "folder-deleted",
};

function aliasInUrl(url: string): string | null {
  const match = /\/mailFolders\/(inbox|drafts|sentitems|deleteditems)(?:\?|$)/.exec(url);
  return match?.[1] ?? null;
}

describe("listFolders", () => {
  it("returns well-known folders plus the children of folders that have them", async () => {
    const stub = createGraphStub((request) => {
      const alias = aliasInUrl(request.url);
      if (alias !== null) return jsonResponse({ id: ALIAS_IDS[alias] });

      return request.url.includes("/childFolders")
        ? jsonResponse({
            value: [
              {
                id: "folder-project-a",
                displayName: "Project A",
                totalItemCount: 5,
                unreadItemCount: 1,
                childFolderCount: 0,
                parentFolderId: "folder-projects",
              },
            ],
          })
        : jsonResponse({ value: [INBOX, PROJECTS] });
    });

    const folders = await createMailService(stub.transport).listFolders();

    expect(folders.map((f) => f.displayName)).toEqual([
      "Inbox",
      "Projects",
      "Project A",
    ]);
    // Resolved from the alias lookup, not from a selected property.
    expect(folders[0]?.wellKnownName).toBe("inbox");
    expect(folders[1]?.wellKnownName).toBeNull();
    expect(folders[2]?.parentFolderId).toBe("folder-projects");

    // One for the top level, one for the only folder with children - not one per
    // folder - plus one per well-known alias.
    const listings = stub.requests.filter((r) => aliasInUrl(r.url) === null);
    expect(listings).toHaveLength(2);
    expect(stub.requests).toHaveLength(2 + 4);
  });

  it("never asks v1.0 for wellKnownName, which would fail the whole request", async () => {
    const stub = createGraphStub((request) => {
      const alias = aliasInUrl(request.url);
      return alias !== null
        ? jsonResponse({ id: ALIAS_IDS[alias] })
        : jsonResponse({ value: [INBOX] });
    });

    await createMailService(stub.transport).listFolders();
    await createMailService(stub.transport).getFolder("folder-inbox");

    // Graph answers `400 BadRequest: Could not find a property named
    // 'wellKnownName' on type 'microsoft.graph.mailFolder'`. It is a beta-only
    // property, and asking for it breaks every folder read.
    for (const request of stub.requests) {
      expect(decodeURIComponent(request.url)).not.toContain("wellKnownName");
    }
  });

  it("still returns the tree when a well-known alias does not resolve", async () => {
    const stub = createGraphStub((request) => {
      const alias = aliasInUrl(request.url);
      if (alias === "deleteditems") {
        return graphErrorResponse(404, "ErrorItemNotFound", "no such folder");
      }
      if (alias !== null) return jsonResponse({ id: ALIAS_IDS[alias] });
      return jsonResponse({ value: [INBOX] });
    });

    const folders = await createMailService(stub.transport).listFolders();

    // A mailbox is not guaranteed to have every special folder, and a tree
    // without one label is still worth returning.
    expect(folders.map((f) => f.displayName)).toEqual(["Inbox"]);
    expect(folders[0]?.wellKnownName).toBe("inbox");
  });

  it("walks the tree deeper than one level", async () => {
    // The real mailbox is why this exists. `Projects` is a child of Inbox, so
    // the project folders the change-order process files into sit at depth two
    // and their contents at depth three. A one-level walk returned the Projects
    // folder and nothing under it, which looked like an empty tree rather than a
    // truncated one.
    const tree: Record<string, unknown[]> = {
      "folder-inbox": [
        {
          id: "folder-projects",
          displayName: "Projects",
          childFolderCount: 1,
          parentFolderId: "folder-inbox",
          totalItemCount: 0,
          unreadItemCount: 0,
        },
      ],
      "folder-projects": [
        {
          id: "folder-liberty",
          displayName: "CCHMC Liberty Expansion",
          childFolderCount: 1,
          parentFolderId: "folder-projects",
          totalItemCount: 0,
          unreadItemCount: 0,
        },
      ],
      "folder-liberty": [
        {
          id: "folder-bulletin",
          displayName: "CCHMC Bulletin 12",
          childFolderCount: 0,
          parentFolderId: "folder-liberty",
          totalItemCount: 13,
          unreadItemCount: 0,
        },
      ],
    };

    const stub = createGraphStub((request) => {
      const alias = aliasInUrl(request.url);
      if (alias !== null) return jsonResponse({ id: ALIAS_IDS[alias] });

      const child = /mailFolders\/([^/?]+)\/childFolders/.exec(request.url);
      if (child !== null) {
        return jsonResponse({ value: tree[decodeURIComponent(child[1] ?? "")] ?? [] });
      }

      return jsonResponse({ value: [{ ...INBOX, childFolderCount: 1 }] });
    });

    const folders = await createMailService(stub.transport).listFolders();

    expect(folders.map((f) => f.displayName)).toEqual([
      "Inbox",
      "Projects",
      "CCHMC Liberty Expansion",
      "CCHMC Bulletin 12",
    ]);
    // Depth three, reached by three rounds of child lookups.
    expect(folders[3]?.parentFolderId).toBe("folder-liberty");
    expect(folders[3]?.totalItemCount).toBe(13);
  });

  it("labels a folder fetched by its alias", async () => {
    const stub = createGraphStub(() =>
      jsonResponse({ id: "folder-drafts", displayName: "Drafts" }),
    );

    const folder = await createMailService(stub.transport).getFolder("drafts");

    expect(folder.wellKnownName).toBe("drafts");
    expect(stub.requests).toHaveLength(1);
  });

  it("follows pagination rather than truncating at one page", async () => {
    let listingCount = 0;
    const stub = createGraphStub((request) => {
      const alias = aliasInUrl(request.url);
      if (alias !== null) return jsonResponse({ id: ALIAS_IDS[alias] });

      listingCount += 1;
      return listingCount === 1
        ? jsonResponse({
            value: [INBOX],
            "@odata.nextLink":
              "https://graph.microsoft.com/v1.0/users/x/mailFolders?$skiptoken=PAGE2",
          })
        : jsonResponse({
            value: [{ ...INBOX, id: "folder-drafts", displayName: "Drafts" }],
          });
    });

    const folders = await createMailService(stub.transport).listFolders();

    expect(folders.map((f) => f.displayName)).toEqual(["Inbox", "Drafts"]);
    expect(stub.requests[1]?.url.toLowerCase()).toContain("skiptoken=page2");
    // The second page's folder is the drafts folder, labelled from the alias.
    expect(folders[1]?.wellKnownName).toBe("drafts");
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
