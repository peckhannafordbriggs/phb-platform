import { describe, expect, it } from "vitest";
import {
  conversationIdOf,
  conversationRows,
  isSingleMessage,
  truncationNotice,
} from "@/app/(modules)/change-orders/mailbox-client";
import { groupConversations } from "@/lib/modules/change-orders/mail/conversations";
import type { MessageSummary } from "@/lib/modules/change-orders/mail/types";

/**
 * What the grouped message pane actually renders.
 *
 * One rule here is not cosmetic and is the reason this logic is a function
 * rather than JSX: a collapsed group still emits its drafts. An unsent draft
 * reply shares its conversation with the message it answers, so grouping would
 * otherwise fold the single most important message in this mailbox behind a
 * chevron - and reviewing drafts is the job the platform exists to do.
 */

function message(
  id: string,
  conversationId: string,
  receivedDateTime: string,
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

/** A real shape: a vendor thread with the unsent reply the operator must send. */
const THREAD = groupConversations([
  message("m1", "conv-a", "2026-08-19T09:00:00Z"),
  message("m2", "conv-a", "2026-08-21T09:00:00Z"),
  message("m3", "conv-a", "2026-08-25T09:00:00Z"),
  message("d1", "conv-a", "2026-08-25T15:00:00Z", { isDraft: true }),
  message("lone", "conv-b", "2026-08-24T09:00:00Z"),
]);

describe("rows for a grouped folder", () => {
  it("renders a single-message conversation as an ordinary row, not a group of one", () => {
    const rows = conversationRows(THREAD, new Set());
    const lone = rows.find((r) => r.kind === "message" && r.message.id === "lone");

    expect(lone).toBeDefined();
    expect(rows.some((r) => r.kind === "group" && r.group.id === "c:conv-b")).toBe(
      false,
    );
    // And it is not indented, because it is not inside anything.
    expect(lone?.kind === "message" && lone.indented).toBe(false);

    const convB = THREAD.find((g) => g.id === "c:conv-b");
    expect(convB !== undefined && isSingleMessage(convB)).toBe(true);
  });

  it("collapses a multi-message thread to one header row", () => {
    const rows = conversationRows(THREAD, new Set());
    const header = rows.find((r) => r.kind === "group");

    expect(header?.kind === "group" && header.group.messageCount).toBe(4);
    expect(header?.kind === "group" && header.expanded).toBe(false);
  });

  /**
   * The rule this file exists for.
   *
   * PHASE-9: "A draft inside a collapsed group must stay visible, since
   * reviewing it is the job."
   */
  it("keeps an unsent draft visible inside a COLLAPSED group", () => {
    const rows = conversationRows(THREAD, new Set());

    const visible = rows
      .filter((r) => r.kind === "message")
      .map((r) => (r.kind === "message" ? r.message.id : ""));

    expect(visible).toContain("d1");
    // ...and only the draft. The three read messages stay folded away.
    expect(visible).not.toContain("m1");
    expect(visible).not.toContain("m2");
    expect(visible).not.toContain("m3");
  });

  it("states how many messages a collapsed group is holding back", () => {
    const rows = conversationRows(THREAD, new Set());
    const header = rows.find((r) => r.kind === "group");

    // Four messages, one of them a draft that is being shown: three hidden. A
    // row that showed the draft and said nothing would imply the draft was the
    // whole thread.
    expect(header?.kind === "group" && header.hiddenCount).toBe(3);
  });

  it("hides nothing once expanded, and orders the thread newest last", () => {
    const rows = conversationRows(THREAD, new Set(["c:conv-a"]));
    const header = rows.find((r) => r.kind === "group");

    expect(header?.kind === "group" && header.hiddenCount).toBe(0);

    const inThread = rows
      .filter((r) => r.kind === "message" && r.indented)
      .map((r) => (r.kind === "message" ? r.message.id : ""));

    expect(inThread).toEqual(["m1", "m2", "m3", "d1"]);
  });

  it("puts the newest conversation first, so grouping does not disturb the ordering", () => {
    const rows = conversationRows(THREAD, new Set());

    // conv-a's newest is 08-25 15:00, conv-b's is 08-24.
    expect(rows[0]?.kind).toBe("group");
    expect(rows[0]?.kind === "group" && rows[0].group.id).toBe("c:conv-a");
    expect(rows[rows.length - 1]?.kind === "message").toBe(true);
  });

  it("emits every message exactly once when everything is expanded", () => {
    const rows = conversationRows(THREAD, new Set(["c:conv-a", "c:conv-b"]));
    const ids = rows
      .filter((r) => r.kind === "message")
      .map((r) => (r.kind === "message" ? r.message.id : ""));

    expect([...ids].sort()).toEqual(["d1", "lone", "m1", "m2", "m3"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("finds the conversation a message belongs to, so opening one can reveal it", () => {
    expect(conversationIdOf(THREAD, "m2")).toBe("c:conv-a");
    expect(conversationIdOf(THREAD, "lone")).toBe("c:conv-b");
    expect(conversationIdOf(THREAD, "nonexistent")).toBeNull();
  });

  it("renders nothing for an empty folder", () => {
    expect(conversationRows([], new Set())).toEqual([]);
  });
});

describe("what a truncated grouped list is allowed to claim", () => {
  it("says nothing at all when nothing was dropped", () => {
    // No "showing everything" banner: a line on every screen is a line nobody
    // reads on the one screen where it matters.
    expect(truncationNotice(null, 13)).toBeNull();
  });

  /**
   * The two wordings must stay different. A folder read is ordered newest-first
   * by Exchange, so what it dropped is the oldest and a thread's newest message
   * is guaranteed present. A search is unordered - Exchange refuses to order a
   * filtered collection - so no such promise is available and none is made.
   */
  it("promises the newest messages survived a folder cap", () => {
    const notice = truncationNotice("folder_cap", 500);

    expect(notice).toContain("500");
    expect(notice).toContain("oldest");
    expect(notice).toContain("never its newest");
    // And it names the way out, which is the flat, paged listing.
    expect(notice).toContain("grouping");
  });

  it("makes no such promise about a search cap", () => {
    const notice = truncationNotice("search_cap", 500);

    expect(notice).not.toContain("never its newest");
    expect(notice).toContain("not just the oldest");
  });

  it("does not use the same sentence for both", () => {
    expect(truncationNotice("folder_cap", 500)).not.toBe(
      truncationNotice("search_cap", 500),
    );
  });
});
