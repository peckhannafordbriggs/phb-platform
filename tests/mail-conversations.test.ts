import { describe, expect, it } from "vitest";
import {
  conversationKeyOf,
  groupConversations,
  truncationOf,
} from "@/lib/modules/change-orders/mail/conversations";
import { createMailService } from "@/lib/modules/change-orders/mail/service";
import type { MessageSummary } from "@/lib/modules/change-orders/mail/types";
import { createGraphStub, jsonResponse } from "./graph-stub";

/**
 * Conversation grouping.
 *
 * The design decision this phase turns on is that a grouped listing COLLECTS the
 * folder rather than grouping a page. A group assembled from one page renders a
 * factual claim - "4 messages, newest 08-25" - that is false when the rest of
 * the thread is on page two, and Graph gives no per-message conversation size to
 * notice it with. So the service collects to a cap, groups the complete set, and
 * returns no cursor.
 *
 * Two halves: the arithmetic (pure, no transport) and the collection (through
 * the real middleware chain onto a stubbed HTTP layer).
 */

function message(
  id: string,
  conversationId: string | null,
  receivedDateTime: string | null,
  extra: Partial<MessageSummary> = {},
): MessageSummary {
  return {
    id,
    conversationId,
    subject: "[CCHMC RFI 229] Change Order Request",
    from: { name: "Joel Prater", address: "joel@vendor.example" },
    to: [{ name: null, address: "changeorder@phb1899.com" }],
    receivedDateTime,
    isDraft: false,
    isRead: true,
    hasAttachments: false,
    ...extra,
  };
}

describe("grouping messages into conversations", () => {
  it("puts messages sharing a conversationId in one group, oldest first", () => {
    const groups = groupConversations([
      message("m3", "conv-a", "2026-08-25T14:00:00Z"),
      message("m1", "conv-a", "2026-08-19T09:00:00Z"),
      message("m2", "conv-a", "2026-08-21T11:00:00Z"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.messageCount).toBe(3);
    // PHASE-9: "Expand to the individual messages, newest last."
    expect(groups[0]?.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("orders the groups newest-first, like the flat list", () => {
    const groups = groupConversations([
      message("old", "conv-old", "2026-08-06T09:00:00Z"),
      message("new", "conv-new", "2026-08-25T09:00:00Z"),
      message("mid", "conv-mid", "2026-08-19T09:00:00Z"),
    ]);

    expect(groups.map((g) => g.id)).toEqual([
      "c:conv-new",
      "c:conv-mid",
      "c:conv-old",
    ]);
  });

  it("dates and titles a group from its NEWEST message", () => {
    const groups = groupConversations([
      message("m1", "conv-a", "2026-08-19T09:00:00Z", {
        subject: "CCHMC Liberty Expansion - Change Order Scope Request",
      }),
      message("m2", "conv-a", "2026-08-25T14:00:00Z", {
        subject: "RE: CCHMC Liberty Expansion - Change Order Scope Request",
      }),
    ]);

    // The newest subject is the one that matches what the person saw arrive, and
    // it is preserved byte for byte - nothing here strips a prefix or the tag.
    expect(groups[0]?.subject).toBe(
      "RE: CCHMC Liberty Expansion - Change Order Scope Request",
    );
    expect(groups[0]?.newestDateTime).toBe("2026-08-25T14:00:00Z");
  });

  it("keeps a single-message conversation as a group of one, for the UI to flatten", () => {
    const groups = groupConversations([
      message("m1", "conv-a", "2026-08-19T09:00:00Z"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.messageCount).toBe(1);
  });

  /**
   * The defensive case. Exchange populates conversationId on everything in this
   * mailbox, but merging unrelated messages into one thread because a field was
   * missing is exactly the silent-hiding failure this phase is about.
   */
  it("never merges messages that have no conversationId", () => {
    const groups = groupConversations([
      message("m1", null, "2026-08-19T09:00:00Z"),
      message("m2", null, "2026-08-20T09:00:00Z"),
      message("m3", "", "2026-08-21T09:00:00Z"),
    ]);

    expect(groups).toHaveLength(3);
    expect(groups.every((g) => g.messageCount === 1)).toBe(true);
    expect(conversationKeyOf(message("m9", null, null))).toBe("m:m9");
  });

  it("counts drafts and unread separately, and never counts a draft as unread", () => {
    const groups = groupConversations([
      message("m1", "conv-a", "2026-08-19T09:00:00Z", { isRead: false }),
      message("m2", "conv-a", "2026-08-20T09:00:00Z", { isRead: true }),
      message("d1", "conv-a", "2026-08-21T09:00:00Z", {
        isDraft: true,
        isRead: false,
      }),
    ]);

    expect(groups[0]?.unreadCount).toBe(1);
    expect(groups[0]?.draftCount).toBe(1);
  });

  it("lists participants once each, in the order they first spoke", () => {
    const groups = groupConversations([
      message("m1", "conv-a", "2026-08-19T09:00:00Z", {
        from: { name: "Joel Prater", address: "joel@vendor.example" },
      }),
      message("m2", "conv-a", "2026-08-20T09:00:00Z", {
        from: { name: "Dana Reeves", address: "dana@phb1899.com" },
      }),
      // Same person, different casing - Exchange varies it between messages.
      message("m3", "conv-a", "2026-08-21T09:00:00Z", {
        from: { name: "Joel Prater", address: "JOEL@vendor.example" },
      }),
    ]);

    expect(groups[0]?.participants.map((p) => p.address)).toEqual([
      "joel@vendor.example",
      "dana@phb1899.com",
    ]);
  });

  it("falls back to recipients for a thread of unsent drafts", () => {
    const groups = groupConversations([
      message("d1", "conv-a", "2026-08-19T09:00:00Z", {
        isDraft: true,
        from: null,
        to: [{ name: "Joel Prater", address: "joel@vendor.example" }],
      }),
      message("d2", "conv-a", "2026-08-20T09:00:00Z", {
        isDraft: true,
        from: null,
        to: [{ name: "Joel Prater", address: "joel@vendor.example" }],
      }),
    ]);

    expect(groups[0]?.participants).toEqual([
      { name: "Joel Prater", address: "joel@vendor.example" },
    ]);
  });

  it("does not lose a message that has no date", () => {
    const groups = groupConversations([
      message("m1", "conv-a", null),
      message("m2", "conv-a", "2026-08-20T09:00:00Z"),
    ]);

    expect(groups[0]?.messageCount).toBe(2);
    // Undated sorts to the top rather than being buried under the newest reply.
    expect(groups[0]?.messages[0]?.id).toBe("m1");
  });

  it("is stable across two identical calls, so a poll does not reshuffle rows", () => {
    const input = [
      message("m2", "conv-a", "2026-08-20T09:00:00Z"),
      message("m1", "conv-a", "2026-08-20T09:00:00Z"),
      message("m3", "conv-b", "2026-08-20T09:00:00Z"),
    ];

    const first = groupConversations(input);
    const second = groupConversations([...input].reverse());

    expect(second.map((g) => g.id)).toEqual(first.map((g) => g.id));
    expect(second[0]?.messages.map((m) => m.id)).toEqual(
      first[0]?.messages.map((m) => m.id),
    );
  });
});

describe("labelling truncation", () => {
  it("says nothing when nothing was dropped", () => {
    expect(truncationOf(false, "folder_cap")).toBeNull();
  });

  /**
   * The two caps are different promises and must stay distinguishable all the
   * way to the banner. A folder read is ordered by Exchange, so what it dropped
   * is the oldest; a search is unordered, because a filter combined with an
   * orderby is refused, so what it dropped could be anything.
   */
  it("distinguishes a folder cap from a search cap", () => {
    expect(truncationOf(true, "folder_cap")).toBe("folder_cap");
    expect(truncationOf(true, "search_cap")).toBe("search_cap");
  });
});

// ------------------------------------------------------------------- service

function graphMessage(id: string, conversationId: string, received: string) {
  return {
    id,
    conversationId,
    subject: "[CCHMC Bulletin 12] Change Order Request",
    receivedDateTime: received,
    isDraft: false,
    isRead: true,
    hasAttachments: false,
    from: {
      emailAddress: { name: "Joel Prater", address: "joel@vendor.example" },
    },
    toRecipients: [{ emailAddress: { address: "changeorder@phb1899.com" } }],
  };
}

const NEXT_LINK =
  "https://graph.microsoft.com/v1.0/users/x/mailFolders/bulletin12/messages" +
  "?$orderby=receivedDateTime%20desc&$top=100&$skip=100";

describe("listConversations collects the folder", () => {
  it("orders by receivedDateTime desc, which is what makes the cap honest", async () => {
    const stub = createGraphStub(() =>
      jsonResponse({
        value: [graphMessage("m1", "conv-a", "2026-08-25T09:00:00Z")],
      }),
    );

    await createMailService(stub.transport).listConversations("bulletin12");

    const url = decodeURIComponent(stub.requests[0]?.url ?? "");
    expect(url).toContain("mailFolders/bulletin12/messages");
    // Without this the collection is unordered and the cap would drop an
    // arbitrary subset rather than the oldest - which is the one property the
    // truncation banner relies on to stay truthful.
    expect(url).toContain("$orderby=receivedDateTime desc");
    // And no filter, or Exchange answers 400 InefficientFilter to the pair.
    expect(url).not.toContain("$filter");
  });

  it("returns no cursor - a grouped read has nothing left to page", async () => {
    const stub = createGraphStub(() =>
      jsonResponse({
        value: [graphMessage("m1", "conv-a", "2026-08-25T09:00:00Z")],
      }),
    );

    const page =
      await createMailService(stub.transport).listConversations("bulletin12");

    expect(page.truncated).toBe(false);
    expect(page.truncation).toBeNull();
    expect(page.messageCount).toBe(1);
  });

  it("follows nextLink across pages and groups the whole folder", async () => {
    let call = 0;
    const stub = createGraphStub(() => {
      call += 1;
      if (call === 1) {
        return jsonResponse({
          value: [
            graphMessage("m3", "conv-a", "2026-08-25T09:00:00Z"),
            graphMessage("m2", "conv-b", "2026-08-24T09:00:00Z"),
          ],
          "@odata.nextLink": NEXT_LINK,
        });
      }
      return jsonResponse({
        value: [graphMessage("m1", "conv-a", "2026-08-19T09:00:00Z")],
      });
    });

    const page =
      await createMailService(stub.transport).listConversations("bulletin12");

    expect(stub.requests).toHaveLength(2);
    expect(decodeURIComponent(stub.requests[1]?.url ?? "")).toContain("$skip=100");
    expect(page.messageCount).toBe(3);

    // m1 arrived on the SECOND page and belongs to the conversation that started
    // on the first. Grouping a page alone would have claimed "conv-a: 1 message".
    const convA = page.conversations.find((c) => c.id === "c:conv-a");
    expect(convA?.messageCount).toBe(2);
    expect(convA?.messages.map((m) => m.id)).toEqual(["m1", "m3"]);
  });

  /**
   * Offset paging walks into a collection that arriving mail shifts underneath
   * the walk, so the same row can come back on two pages. A duplicate inside a
   * thread would inflate the count on the row header - the exact kind of false
   * claim this design exists to avoid.
   */
  it("de-duplicates a row returned on two pages", async () => {
    let call = 0;
    const stub = createGraphStub(() => {
      call += 1;
      if (call === 1) {
        return jsonResponse({
          value: [graphMessage("m1", "conv-a", "2026-08-25T09:00:00Z")],
          "@odata.nextLink": NEXT_LINK,
        });
      }
      return jsonResponse({
        value: [graphMessage("m1", "conv-a", "2026-08-25T09:00:00Z")],
      });
    });

    const page =
      await createMailService(stub.transport).listConversations("bulletin12");

    expect(page.messageCount).toBe(1);
    expect(page.conversations[0]?.messageCount).toBe(1);
  });

  it("stops at the page cap and SAYS it truncated, naming the folder cap", async () => {
    let n = 0;
    // Always another page: an unbounded walk would never return.
    const stub = createGraphStub(() => {
      n += 1;
      return jsonResponse({
        value: [graphMessage("m" + n, "conv-a", "2026-08-25T09:00:00Z")],
        "@odata.nextLink": NEXT_LINK,
      });
    });

    const page =
      await createMailService(stub.transport).listConversations("bulletin12");

    // MAX_CONVERSATION_PAGES
    expect(stub.requests).toHaveLength(5);
    expect(page.truncated).toBe(true);
    // Named, so the banner can promise the newest message of each thread is
    // present - which is only true because the collection was ordered.
    expect(page.truncation).toBe("folder_cap");
  });

  it("does not call a complete folder truncated", async () => {
    const stub = createGraphStub(() =>
      jsonResponse({
        value: [graphMessage("m1", "conv-a", "2026-08-25T09:00:00Z")],
      }),
    );

    const page =
      await createMailService(stub.transport).listConversations("bulletin12");

    expect(stub.requests).toHaveLength(1);
    expect(page.truncated).toBe(false);
  });
});
