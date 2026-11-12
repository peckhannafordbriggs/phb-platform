import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChangeOrderMailService,
  createMailService,
  inlineImageSigningKey,
} from "@/lib/modules/change-orders/mail/service";
import { createGraphClient } from "@/lib/modules/change-orders/graph/client";
import {
  MESSAGE_ROUTES_PATH,
  verifyInlineImageLink,
} from "@/lib/modules/change-orders/mail/inline-images";
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
    await service.listMessages(LIVE_MAILBOX, { cursor: LIVE_MAILBOX });
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
    /**
     * That SOME request carried the token, not that the second one did.
     *
     * The alias lookups now start alongside the folder walk rather than after
     * it - they have no data dependency on it, and awaiting them afterwards was
     * adding their whole latency to every cold mount. That makes the request
     * ORDER a race between two independent groups, so asserting a position here
     * would be asserting the serialisation that change removed.
     */
    expect(
      stub.requests.some((r) => r.url.toLowerCase().includes("skiptoken=page2")),
    ).toBe(true);
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

  /**
   * The nextLink below is the real one, copied from the live mailbox: a
   * 13-message folder requested with $top=5. Mail collections continue with
   * `$skip`, NOT `$skiptoken`.
   *
   * The previous fixture invented a `$skiptoken` link, so the tests agreed with
   * a service that could only ever return one page. That is the whole reason
   * PHASE-5 says to verify paging against the live mailbox.
   */
  const REAL_NEXT_LINK =
    "https://graph.microsoft.com/v1.0/users/changeorder@example.invalid/mailFolders('AAMkAD%3D%3D')/messages" +
    "?%24select=id%2csubject&%24orderby=receivedDateTime+desc&%24top=5&%24skip=5";

  it("reads Graph's $skip continuation, which is how mail actually pages", async () => {
    const stub = createGraphStub(() =>
      jsonResponse({ value: [MESSAGE], "@odata.nextLink": REAL_NEXT_LINK }),
    );

    const page = await createMailService(stub.transport).listMessages("folder-inbox");

    expect(page.nextCursor).toBe("s:5");
    expect(page.nextCursor).not.toContain("http");
  });

  it("still reads a $skiptoken continuation, for collections that use one", async () => {
    const stub = createGraphStub(() =>
      jsonResponse({
        value: [MESSAGE],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/users/x/messages?%24skiptoken=NEXTPAGE",
      }),
    );

    const page = await createMailService(stub.transport).listMessages("folder-inbox");

    expect(page.nextCursor).toBe("t:NEXTPAGE");
  });

  it("carries an offset cursor back as $skip", async () => {
    const stub = createGraphStub(() => jsonResponse({ value: [] }));

    await createMailService(stub.transport).listMessages("folder-inbox", {
      cursor: "s:5",
    });

    expect(decodeURIComponent(stub.requests[0]?.url ?? "")).toContain("$skip=5");
  });

  it("ignores a cursor a caller made up, rather than trusting it", async () => {
    const stub = createGraphStub(() => jsonResponse({ value: [] }));
    const service = createMailService(stub.transport);

    // The cursor arrives from a URL query parameter, so it is input.
    for (const bad of ["s:-1", "s:abc", "nonsense", "s:", "t:"]) {
      await service.listMessages("folder-inbox", { cursor: bad });
    }

    for (const request of stub.requests) {
      const url = decodeURIComponent(request.url);
      expect(url).not.toContain("$skip=-1");
      expect(url).not.toContain("$skip=abc");
      expect(url).not.toContain("$skiptoken=");
    }
  });

  it("clamps an unbounded page size", async () => {
    const stub = createGraphStub(() => jsonResponse({ value: [] }));

    await createMailService(stub.transport).listMessages("folder-inbox", {
      top: 5000,
    });

    expect(decodeURIComponent(stub.requests[0]?.url ?? "")).toContain("$top=100");
  });

  it("repeats $orderby on an offset page, or the offset addresses the wrong rows", async () => {
    const stub = createGraphStub(() => jsonResponse({ value: [] }));
    const service = createMailService(stub.transport);

    await service.listMessages("folder-inbox");
    await service.listMessages("folder-inbox", { cursor: "s:5" });

    // Graph's own nextLink repeats it. $skip=5 into an unordered result set is
    // a different five messages than $skip=5 into a sorted one, so page two
    // would overlap page one and silently drop messages.
    for (const request of stub.requests) {
      expect(decodeURIComponent(request.url)).toContain(
        "$orderby=receivedDateTime desc",
      );
    }
  });

  it("drops $orderby only for a $skiptoken cursor, which Graph rejects it with", async () => {
    const stub = createGraphStub(() => jsonResponse({ value: [] }));

    await createMailService(stub.transport).listMessages("folder-inbox", {
      cursor: "t:OPAQUE",
    });

    const url = decodeURIComponent(stub.requests[0]?.url ?? "");
    expect(url).not.toContain("$orderby");
    // The SDK spells it $skipToken; Graph accepts either casing.
    expect(url.toLowerCase()).toContain("$skiptoken=opaque");
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
      // Plain text cannot carry an image at all.
      inlineImages: 0,
      inlineImagesUnresolved: 0,
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

/**
 * Inline images. The pictures in a message body are attachments on the message
 * referenced by Content-ID, and the body is rendered with the platform's own
 * signed link in place of each `cid:` - see mail/inline-images.ts for why a
 * link rather than a cookie-gated route.
 *
 * The fixtures are the shapes the live mailbox returned on 2026-11-12: the
 * mail filter's two banner icons on a message Exchange reports as having NO
 * attachments, and a PDF that carries a Content-ID of its own.
 */
describe("getMessage: inline images", () => {
  const BANNER_ICON = {
    "@odata.type": "#microsoft.graph.fileAttachment",
    id: "att-icon",
    name: "inky-injection-inliner-03755809cc10337ec572b1f12a6beedf.png",
    contentType: "image/png",
    size: 1_699,
    isInline: true,
    contentId: "inky-injection-inliner-03755809cc10337ec572b1f12a6beedf",
  };

  const PDF_WITH_CONTENT_ID = {
    "@odata.type": "#microsoft.graph.fileAttachment",
    id: "att-pdf",
    name: "Bulletin 15.pdf",
    contentType: "application/pdf",
    size: 479_319,
    isInline: false,
    contentId: "68847E4DA04DA7459E27023E5665F74A@namprd19.prod.outlook.com",
  };

  function messageWith(body: string, extra: Record<string, unknown> = {}) {
    return {
      id: "message-1",
      subject: "1 of your flow(s) have failed",
      hasAttachments: false,
      body: { contentType: "html", content: body },
      ...extra,
    };
  }

  function linkParts(src: string) {
    const url = new URL(src, "http://localhost");
    const [, messageId, attachmentId] =
      /\/messages\/([^/]+)\/inline-images\/([^/?]+)/.exec(url.pathname) ?? [];
    return {
      messageId: decodeURIComponent(messageId ?? ""),
      attachmentId: decodeURIComponent(attachmentId ?? ""),
      exp: url.searchParams.get("exp"),
      sig: url.searchParams.get("sig"),
    };
  }

  function srcOf(html: string): string {
    const src = /<img[^>]*\ssrc="([^"]*)"/.exec(html)?.[1] ?? "";
    return src.replace(/&amp;/g, "&");
  }

  it("reads the attachments even though Exchange says there are none, and links each image", async () => {
    const stub = createGraphStub((request) =>
      request.url.includes("/attachments")
        ? jsonResponse({ value: [BANNER_ICON] })
        : jsonResponse(
            messageWith(
              '<p>Flow failed</p><img src="cid:inky-injection-inliner-03755809cc10337ec572b1f12a6beedf" width="24" height="24">',
            ),
          ),
    );

    const message = await createMailService(stub.transport).getMessage("message-1");

    // Two reads: the message, then its attachments - despite hasAttachments
    // being false, which is what Exchange reports for inline-only messages.
    expect(stub.requests.map((r) => /\/messages\/message-1(\/attachments)?/.exec(r.url)?.[1] ?? "")).toEqual(["", "/attachments"]);

    expect(message.body?.inlineImages).toBe(1);
    expect(message.body?.inlineImagesUnresolved).toBe(0);
    expect(message.body?.content).not.toContain("cid:");
    expect(message.body?.content).not.toContain("data-inline-image");

    const src = srcOf(message.body?.content ?? "");
    expect(src.startsWith(`${MESSAGE_ROUTES_PATH}/message-1/inline-images/att-icon?`)).toBe(true);
    // Relative, so it resolves against whichever hostname the platform is used at.
    expect(src.startsWith("/")).toBe(true);

    // And it is a link the image route will accept: signed for this message
    // and this attachment, under the process's own key.
    const parts = linkParts(src);
    expect(parts).toMatchObject({ messageId: "message-1", attachmentId: "att-icon" });
    expect(verifyInlineImageLink(inlineImageSigningKey(), parts)).toBe("valid");
    expect(
      verifyInlineImageLink(inlineImageSigningKey(), { ...parts, attachmentId: "att-pdf" }),
    ).toBe("invalid");

    // The attachments come back with the message: one read serves both.
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]?.contentId).toBe(BANNER_ICON.contentId);
  });

  it("reads no attachments for a body that references none", async () => {
    const stub = createGraphStub(() =>
      jsonResponse(messageWith("<p>Thanks, will do.</p>")),
    );

    const message = await createMailService(stub.transport).getMessage("message-1");

    expect(stub.requests).toHaveLength(1);
    expect(message.attachments).toEqual([]);
    expect(message.body?.inlineImages).toBe(0);
  });

  it("still reads the attachments when Exchange says there are some", async () => {
    const stub = createGraphStub((request) =>
      request.url.includes("/attachments")
        ? jsonResponse({ value: [PDF_WITH_CONTENT_ID] })
        : jsonResponse(messageWith("<p>Quote attached</p>", { hasAttachments: true })),
    );

    const message = await createMailService(stub.transport).getMessage("message-1");

    expect(stub.requests).toHaveLength(2);
    expect(message.attachments.map((a) => a.id)).toEqual(["att-pdf"]);
  });

  it("leaves a cid: no attachment carries as a placeholder, and says so", async () => {
    const stub = createGraphStub((request) =>
      request.url.includes("/attachments")
        ? jsonResponse({ value: [BANNER_ICON] })
        : jsonResponse(messageWith('<img src="cid:image001.png@01DC" alt="screenshot">')),
    );

    const message = await createMailService(stub.transport).getMessage("message-1");

    expect(message.body?.inlineImages).toBe(1);
    expect(message.body?.inlineImagesUnresolved).toBe(1);
    expect(message.body?.content).toContain('data-inline-image="true"');
    expect(message.body?.content).not.toContain("inline-images/");
  });

  it("never links a cid: to an attachment that is not an image", async () => {
    // Exchange gives ordinary attachments a Content-ID too. A body naming the
    // PDF's gets a placeholder, not a link the image route would then refuse.
    const stub = createGraphStub((request) =>
      request.url.includes("/attachments")
        ? jsonResponse({ value: [PDF_WITH_CONTENT_ID] })
        : jsonResponse(messageWith(`<img src="cid:${PDF_WITH_CONTENT_ID.contentId}">`)),
    );

    const message = await createMailService(stub.transport).getMessage("message-1");

    expect(message.body?.inlineImagesUnresolved).toBe(1);
    expect(message.body?.content).not.toContain("inline-images/");
  });

  it("matches a Content-ID case-insensitively when nothing matches exactly", async () => {
    const stub = createGraphStub((request) =>
      request.url.includes("/attachments")
        ? jsonResponse({ value: [BANNER_ICON] })
        : jsonResponse(messageWith(`<img src="cid:${BANNER_ICON.contentId.toUpperCase()}">`)),
    );

    const message = await createMailService(stub.transport).getMessage("message-1");

    expect(message.body?.inlineImagesUnresolved).toBe(0);
    expect(srcOf(message.body?.content ?? "")).toContain("/inline-images/att-icon?");
  });

  it("resolves the pictures in a draft's preview the same way", async () => {
    const stub = createGraphStub((request) =>
      request.url.includes("/attachments")
        ? jsonResponse({ value: [BANNER_ICON] })
        : jsonResponse(
            messageWith(`<p>Re:</p><img src="cid:${BANNER_ICON.contentId}">`, {
              id: "draft-1",
              subject: "ZZTEST RE: flow",
              isDraft: true,
            }),
          ),
    );

    const draft = await createMailService(stub.transport).getDraftForEdit("draft-1");

    expect(draft.preview?.inlineImagesUnresolved).toBe(0);
    expect(srcOf(draft.preview?.content ?? "")).toContain(
      `${MESSAGE_ROUTES_PATH}/draft-1/inline-images/att-icon?`,
    );
    // The RAW body the editor writes back is untouched: the link never reaches
    // Exchange.
    expect(draft.body).toContain(`cid:${BANNER_ICON.contentId}`);
    expect(draft.body).not.toContain("inline-images/");
  });

  it("links nothing without a signing key, and still says what is missing", async () => {
    const stub = createGraphStub((request) =>
      request.url.includes("/attachments")
        ? jsonResponse({ value: [BANNER_ICON] })
        : jsonResponse(messageWith(`<img src="cid:${BANNER_ICON.contentId}">`)),
    );
    const service = new ChangeOrderMailService({
      client: createGraphClient(stub.transport),
      mailbox: TEST_MAILBOX,
    });

    const message = await service.getMessage("message-1");

    expect(message.body?.inlineImagesUnresolved).toBe(1);
    expect(message.body?.content).not.toContain("inline-images/");
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
        contentId: null,
        isItemAttachment: false,
      },
      {
        id: "attachment-2",
        name: "Forwarded RFQ",
        contentType: null,
        sizeBytes: 12_000,
        isInline: false,
        contentId: null,
        isItemAttachment: true,
      },
    ]);

    // GET /attachments returns contentBytes by default. The $select is what
    // stops that, so assert it is actually narrow.
    const select = decodeURIComponent(stub.requests[0]?.url ?? "");
    expect(select).toContain("$select=id,name,contentType,size,isInline");
    expect(select).not.toContain("contentBytes");
    // `contentId` is on the fileAttachment subtype. Asked for bare, Graph
    // refuses the whole request (verified live 2026-11-12); this is the form
    // it answers.
    expect(select).toContain(",microsoft.graph.fileAttachment/contentId");
    expect(select).not.toMatch(/[,=]contentId/);
  });

  it("carries a Content-ID as Exchange stores it, without brackets", async () => {
    const stub = createGraphStub(() =>
      jsonResponse({
        value: [
          {
            "@odata.type": "#microsoft.graph.fileAttachment",
            id: "attachment-1",
            name: "image001.png",
            contentType: "image/png",
            size: 1_699,
            isInline: true,
            contentId: "<image001.png@01DC4E0C.3A5B2A10>",
          },
        ],
      }),
    );

    const [attachment] = await createMailService(stub.transport).listAttachments(
      "message-1",
    );

    expect(attachment?.contentId).toBe("image001.png@01DC4E0C.3A5B2A10");
    expect(attachment?.isInline).toBe(true);
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
