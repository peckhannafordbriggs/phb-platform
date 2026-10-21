import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMailService } from "@/lib/modules/change-orders/mail/service";
import {
  MAX_NOTE_BYTES,
  createReviewService,
  parseFolderSpec,
  reviewConnectionStatus,
  shareIdFor,
} from "@/lib/modules/change-orders/review/service";
import { ReviewError } from "@/lib/modules/change-orders/review/errors";
import {
  CO_REVIEW_APP_CLIENT_ID_VAR,
  CO_REVIEW_APP_TENANT_ID_VAR,
  CO_REVIEW_SHAREPOINT_FOLDER_VAR,
} from "@/lib/env";
import { createGraphStub, graphErrorResponse, jsonResponse } from "./graph-stub";
import type { RecordedRequest } from "./graph-stub";

/**
 * The review service against a mocked transport: the real Graph client, the
 * real middleware, the real URL construction, the real error mapping. What
 * these prove is what leaves the service - and, above all, what never leaves
 * the process: a request that is not a GET.
 */

const DRIVE = "b!zztest-drive";
const FOLDER = "01ZZTESTFOLDER";
const SPEC = `ids:${DRIVE}/${FOLDER}`;

function child(
  name: string,
  extra: { id?: string; folder?: boolean; size?: number } = {},
) {
  return {
    id: extra.id ?? `id-${name}`,
    name,
    size: extra.size ?? 1200,
    lastModifiedDateTime: "2026-10-21T15:34:37Z",
    webUrl: `https://example.invalid/${encodeURIComponent(name)}`,
    ...(extra.folder ? { folder: { childCount: 4 } } : { file: { mimeType: "text/plain" } }),
  };
}

const NOTE_A = "NEEDS REVIEW - 2026-10-05 110119 - RE ZZTEST RFI 999 - Site [AB1CD23E].txt";
const NOTE_B = "NEEDS REVIEW - 2026-10-06 112331 - RE ZZTEST Temp Lab - Site [AB1CD23E].txt";
const ITEM_B = "2026-10-06 112331 - RE ZZTEST Temp Lab - Site [AB1CD23E]";

/** The live folder's shape on 2026-10-21: notes, `.keep.txt`, one item folder. */
const LISTING = [
  child(".keep.txt", { size: 39 }),
  child(NOTE_A),
  child(NOTE_B),
  child(ITEM_B, { folder: true, id: "id-folder-b" }),
];

const NOTE_TEXT = (subject: string) =>
  `NEEDS REVIEW — unmatched Change Order reply
============================================
Received: 2026-10-05
From:     ZZ Tester <zztest@example.invalid>
Subject:  ${subject}

WHY THIS NEEDS A HUMAN
Because.

WHAT THEY WROTE
"Words."

SUGGESTED NEXT STEP
Close it.

Classification: other (high confidence)   ·   Item: x
`;

function textResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { "content-type": "text/plain" } });
}

/** Answers a listing, a note's metadata, or a note's content, by URL. */
function folderResponder(options: { listing?: unknown[]; pageTwo?: unknown[] } = {}) {
  const listing = options.listing ?? LISTING;
  return (request: RecordedRequest): Response => {
    const { url } = request;
    if (url.includes("/children") && !url.includes("skiptoken")) {
      return jsonResponse(
        options.pageTwo === undefined
          ? { value: listing }
          : {
              value: listing,
              "@odata.nextLink": `https://graph.microsoft.com/v1.0/drives/${DRIVE}/items/${FOLDER}/children?$skiptoken=page2`,
            },
      );
    }
    if (url.includes("skiptoken=page2")) return jsonResponse({ value: options.pageTwo });
    if (url.endsWith("/content")) {
      const id = /items\/([^/]+)\/content/.exec(url)?.[1] ?? "";
      return textResponse(NOTE_TEXT(id.includes(encodeURIComponent(NOTE_A)) ? "RE: ZZTEST RFI 999 - Site" : "RE: ZZTEST Temp Lab - Site"));
    }
    const id = decodeURIComponent(/items\/([^/?]+)/.exec(url)?.[1] ?? "");
    const item = listing.find((c) => (c as { id: string }).id === id);
    if (item === undefined) return graphErrorResponse(404, "itemNotFound");
    return jsonResponse({ ...(item as object), parentReference: { driveId: DRIVE, id: FOLDER } });
  };
}

describe("the count and the listing", () => {
  it("counts only files named like a note: not .keep.txt, not the item folders", async () => {
    const stub = createGraphStub(folderResponder());
    const service = createReviewService(stub.transport, { folder: SPEC });

    const summary = await service.summary();

    expect(summary).toEqual({ count: 2, oldestDate: "2026-10-05", newestDate: "2026-10-06" });
    // One request: the folder listing. No note was read for a count.
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]!.url).toContain(`/drives/${encodeURIComponent(DRIVE)}/items/${FOLDER}/children`);
  });

  it("follows the listing's pages before counting", async () => {
    const stub = createGraphStub(folderResponder({ pageTwo: [child("NEEDS REVIEW - 2026-08-18 130331 - RE Old [X].txt")] }));
    const service = createReviewService(stub.transport, { folder: SPEC });

    expect((await service.summary()).count).toBe(3);
    expect((await service.summary()).oldestDate).toBe("2026-08-18");
    expect(stub.requests.filter((r) => r.url.includes("/children"))).toHaveLength(4);
  });

  it("reads every note, parses it, groups by subject and says which notes have an item folder beside them", async () => {
    const stub = createGraphStub(folderResponder());
    const service = createReviewService(stub.transport, { folder: SPEC });

    const { summary, groups } = await service.listNotes();

    expect(summary.count).toBe(2);
    expect(groups.map((g) => g.subject)).toEqual(["RE: ZZTEST Temp Lab - Site", "RE: ZZTEST RFI 999 - Site"]);
    const [tempLab, rfi] = groups;
    expect(tempLab!.notes[0]).toMatchObject({
      fileName: NOTE_B,
      itemId: ITEM_B,
      fileMessageIdHint: "AB1CD23E",
      hasItemFolder: true,
      why: "Because.",
      wrote: '"Words."',
      nextStep: "Close it.",
      classification: "other",
      confidence: "high",
    });
    expect(rfi!.notes[0]!.hasItemFolder).toBe(false);
    // The listing, then one content read per note.
    expect(stub.requests.filter((r) => r.url.endsWith("/content"))).toHaveLength(2);
  });
});

describe("reading one note", () => {
  it("checks the item is a note in the review folder before asking for its content", async () => {
    const stub = createGraphStub(folderResponder());
    const service = createReviewService(stub.transport, { folder: SPEC });

    const note = await service.readNote(`id-${NOTE_A}`);

    expect(note.subject).toBe("RE: ZZTEST RFI 999 - Site");
    expect(stub.requests.map((r) => r.url.endsWith("/content"))).toEqual([false, true]);
  });

  it("refuses an id that is a child of some other folder", async () => {
    const stub = createGraphStub((request) =>
      request.url.endsWith("/content")
        ? textResponse("should never be read")
        : jsonResponse({ ...child(NOTE_A), parentReference: { driveId: DRIVE, id: "01SOMEWHERE-ELSE" } }),
    );
    const service = createReviewService(stub.transport, { folder: SPEC });

    await expect(service.readNote(`id-${NOTE_A}`)).rejects.toMatchObject({ kind: "not_a_note" });
    expect(stub.requests.some((r) => r.url.endsWith("/content"))).toBe(false);
  });

  it("refuses an item folder, and a file that is not named like a note", async () => {
    const stub = createGraphStub(folderResponder());
    const service = createReviewService(stub.transport, { folder: SPEC });

    await expect(service.readNote("id-folder-b")).rejects.toMatchObject({ kind: "not_a_note" });
    await expect(service.readNote("id-.keep.txt")).rejects.toMatchObject({ kind: "not_a_note" });
    expect(stub.requests.some((r) => r.url.endsWith("/content"))).toBe(false);
  });

  it("refuses to read something note-shaped but far too large", async () => {
    const stub = createGraphStub(
      folderResponder({ listing: [child(NOTE_A, { size: MAX_NOTE_BYTES + 1 })] }),
    );
    const service = createReviewService(stub.transport, { folder: SPEC });

    await expect(service.readNote(`id-${NOTE_A}`)).rejects.toMatchObject({ kind: "not_a_note" });
    expect(stub.requests.some((r) => r.url.endsWith("/content"))).toBe(false);
  });

  it("reports a note that has left the folder as not_found", async () => {
    const stub = createGraphStub(() => graphErrorResponse(404, "itemNotFound"));
    const service = createReviewService(stub.transport, { folder: SPEC });

    await expect(service.readNote("id-gone")).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("what leaves the service", () => {
  /**
   * THE ONE THAT MATTERS. Every request the service ever makes is a GET.
   * tests/co-review-read-only.test.ts holds the source text to the same
   * claim; this holds the wire.
   */
  it("sends GET and only GET, across every operation", async () => {
    const stub = createGraphStub(folderResponder());
    const service = createReviewService(stub.transport, { folder: SPEC });

    await service.summary();
    await service.listNotes();
    await service.readNote(`id-${NOTE_A}`);

    expect(stub.requests.length).toBeGreaterThanOrEqual(6);
    for (const request of stub.requests) {
      expect(request.method, request.url).toBe("GET");
      expect(request.body, request.url).toBeNull();
    }
  });

  it("maps a 403 to folder_forbidden with a message that blames the grant, not the employee", async () => {
    const stub = createGraphStub(() => graphErrorResponse(403, "accessDenied"));
    const service = createReviewService(stub.transport, { folder: SPEC });

    const error = await service.summary().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReviewError);
    expect((error as ReviewError).kind).toBe("folder_forbidden");
    expect((error as ReviewError).userMessage).toMatch(/not permitted to read the review folder/);
    expect((error as ReviewError).userMessage).not.toMatch(/you/i);
  });

  it("retries a throttled listing once, like the mailbox", async () => {
    const stub = createGraphStub([
      () => graphErrorResponse(429, "TooManyRequests", "slow down", { "retry-after": "2" }),
      () => jsonResponse({ value: LISTING }),
    ]);
    const service = createReviewService(stub.transport, { folder: SPEC });

    expect((await service.summary()).count).toBe(2);
    expect(stub.sleeps).toEqual([2000]);
  });

  it("never leaks a GraphError: anything unexpected is a ReviewError too", async () => {
    const stub = createGraphStub(() => graphErrorResponse(500, "generalException"));
    const service = createReviewService(stub.transport, { folder: SPEC });

    const error = await service.summary().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReviewError);
    expect((error as ReviewError).kind).toBe("unexpected");
  });
});

describe("where the folder comes from", () => {
  it("accepts ids:<driveId>/<itemId>, and refuses the forms that are not a folder address", () => {
    expect(parseFolderSpec(SPEC)).toEqual({ kind: "ids", driveId: DRIVE, itemId: FOLDER });
    expect(parseFolderSpec("https://example.invalid/sites/x/Shared%20Documents/a/_needs_review")).toEqual({
      kind: "url",
      url: "https://example.invalid/sites/x/Shared%20Documents/a/_needs_review",
    });
    for (const bad of ["ids:onlyone", "ids:a/b/c", "https://example.invalid/Forms/AllItems.aspx?id=x", "C:\\folder", ""]) {
      expect(() => parseFolderSpec(bad), bad).toThrow(ReviewError);
    }
  });

  it("resolves a URL through /shares once, then addresses the drive directly", async () => {
    const url = "https://example.invalid/sites/x/Shared%20Documents/a/_needs_review";
    const stub = createGraphStub((request) =>
      request.url.includes("/shares/")
        ? jsonResponse({ id: FOLDER, parentReference: { driveId: DRIVE }, folder: {} })
        : folderResponder()(request),
    );
    const service = createReviewService(stub.transport, { folder: url });

    await service.summary();
    await service.summary();

    const shares = stub.requests.filter((r) => r.url.includes("/shares/"));
    expect(shares).toHaveLength(1);
    expect(shares[0]!.url).toContain(`/shares/${shareIdFor(url)}/driveItem`);
    expect(shareIdFor(url).startsWith("u!")).toBe(true);
    expect(stub.requests.filter((r) => r.url.includes(`/drives/${encodeURIComponent(DRIVE)}/items/${FOLDER}/children`))).toHaveLength(2);
  });

  it("refuses a URL that resolves to a file rather than a folder", async () => {
    const stub = createGraphStub(() => jsonResponse({ id: "f", parentReference: { driveId: DRIVE }, file: {} }));
    const service = createReviewService(stub.transport, { folder: "https://example.invalid/a/note.txt" });

    await expect(service.summary()).rejects.toMatchObject({ kind: "not_configured" });
  });
});

describe("configuration", () => {
  const VARS = [CO_REVIEW_APP_CLIENT_ID_VAR, CO_REVIEW_APP_TENANT_ID_VAR, CO_REVIEW_SHAREPOINT_FOLDER_VAR];
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of VARS) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of VARS) {
      const value = saved.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("reports not configured, naming the variables, when nothing is set", () => {
    const status = reviewConnectionStatus();
    expect(status.configured).toBe(false);
    if (!status.configured) expect(status.missing).toEqual([...VARS].sort());
  });

  it("treats a blank value as absent, which is how .env.example and a blank Azure setting arrive", () => {
    process.env[CO_REVIEW_APP_CLIENT_ID_VAR] = "   ";
    process.env[CO_REVIEW_APP_TENANT_ID_VAR] = "";
    process.env[CO_REVIEW_SHAREPOINT_FOLDER_VAR] = "";
    expect(reviewConnectionStatus().configured).toBe(false);
  });

  it("refuses a client id that is not a GUID", () => {
    process.env[CO_REVIEW_APP_CLIENT_ID_VAR] = "not-a-guid";
    process.env[CO_REVIEW_APP_TENANT_ID_VAR] = "99999999-8888-4777-9666-555555555555";
    process.env[CO_REVIEW_SHAREPOINT_FOLDER_VAR] = SPEC;
    const status = reviewConnectionStatus();
    expect(status.configured).toBe(false);
    if (!status.configured) expect(status.missing).toEqual([CO_REVIEW_APP_CLIENT_ID_VAR]);
  });

  it("is configured with the three identifiers and no secret", () => {
    process.env[CO_REVIEW_APP_CLIENT_ID_VAR] = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    process.env[CO_REVIEW_APP_TENANT_ID_VAR] = "99999999-8888-4777-9666-555555555555";
    process.env[CO_REVIEW_SHAREPOINT_FOLDER_VAR] = SPEC;
    expect(reviewConnectionStatus()).toEqual({ configured: true });
  });

  it("createReviewService without a folder throws not_configured rather than reaching Graph", () => {
    const stub = createGraphStub(() => jsonResponse({ value: [] }));
    expect(() => createReviewService(stub.transport)).toThrow(ReviewError);
    expect(stub.requests).toHaveLength(0);
  });
});

/**
 * The one method the mail service gained for Needs Review. Held here beside
 * the review tests because its purpose is the review tab's, and because the
 * claim about it - mailbox-wide, exact subject, no ordering on the wire - is
 * the kind that is only visible in the URL.
 */
describe("finding a note's message in the mailbox", () => {
  afterEach(() => vi.restoreAllMocks());

  it("filters the whole mailbox by exact subject and a received window, with no $orderby, and sorts the page itself", async () => {
    const stub = createGraphStub(() =>
      jsonResponse({
        value: [
          { id: "older", subject: "RE: ZZTEST", receivedDateTime: "2026-10-05T11:00:09Z", internetMessageId: "<AB1CD23E0001@example.invalid>" },
          { id: "newer", subject: "RE: ZZTEST", receivedDateTime: "2026-10-05T12:50:26Z" },
        ],
      }),
    );
    const service = createMailService(stub.transport);

    const found = await service.findMessagesReceivedBetween(
      "RE: P&G Reese's ZZTEST",
      new Date("2026-10-04T12:00:00Z"),
      new Date("2026-10-06T12:00:00Z"),
    );

    expect(found.map((m) => m.id)).toEqual(["newer", "older"]);
    // The Message-ID rides along, null when Exchange gave none.
    expect(found.map((m) => m.internetMessageId)).toEqual([null, "<AB1CD23E0001@example.invalid>"]);
    expect(stub.requests).toHaveLength(1);
    const url = decodeURIComponent(stub.requests[0]!.url);
    expect(stub.requests[0]!.method).toBe("GET");
    // Mailbox-wide: /messages directly under the user, not under a folder.
    expect(url).toMatch(/\/users\/[^/]+\/messages\?/);
    expect(url).not.toContain("/mailFolders/");
    expect(url).toContain("receivedDateTime ge 2026-10-04T12:00:00.000Z");
    expect(url).toContain("receivedDateTime lt 2026-10-06T12:00:00.000Z");
    // The apostrophe is doubled - OData's own escape - so the subject with
    // one in it does not end the expression early.
    expect(url).toContain("subject eq 'RE: P&G Reese''s ZZTEST'");
    expect(url).not.toContain("$orderby");
    // Metadata only; a lookup must not pull bodies - but the Message-ID, yes.
    expect(url).not.toMatch(/\$select=[^&]*body/);
    expect(url).toMatch(/\$select=[^&]*internetMessageId/);
  });

  /**
   * The SDK does not percent-encode `$filter`, so an ampersand in a subject
   * split the query string and Graph answered 400 - found live on
   * 2026-10-21 with `P&G`, a real project. The expression now travels
   * encoded, and this reads the RAW url rather than the decoded one.
   */
  it("percent-encodes the filter, so a subject with an ampersand is one parameter and not two", async () => {
    const stub = createGraphStub(() => jsonResponse({ value: [] }));
    const service = createMailService(stub.transport);

    await service.findMessagesReceivedBetween("RE: P&G #1", new Date("2026-10-04T12:00:00Z"), new Date("2026-10-06T12:00:00Z"));
    await service.searchMessages("folder-1", "P&G #1");

    for (const request of stub.requests) {
      const query = request.url.slice(request.url.indexOf("?") + 1);
      const filter = query.split("&").find((part) => part.startsWith("$filter="));
      expect(filter, request.url).toBeDefined();
      expect(filter, request.url).toContain("P%26G%20%231");
      expect(query.split("&").some((part) => part.startsWith("G")), request.url).toBe(false);
      expect(decodeURIComponent(filter!), request.url).toContain("P&G #1");
    }
  });
});
