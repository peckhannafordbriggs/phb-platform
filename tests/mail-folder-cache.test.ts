import { describe, expect, it, vi } from "vitest";
import { createMailService } from "@/lib/modules/change-orders/mail/service";
import { createGraphStub, graphErrorResponse, jsonResponse } from "./graph-stub";

/**
 * The folder tree is cached for thirty seconds, in memory, per process.
 *
 * Why it exists: measured against the real mailbox, `listFolders()` costs **11
 * Graph requests and ~1.3 seconds**. The walk is sequential by necessity - a
 * level's paths are not known until the level above returns - and it ran on
 * every mount of the Change Orders screen, which made it the single largest
 * thing between opening the tab and seeing anything.
 *
 * docs/03 permits exactly this much and no more: "Short-lived in-memory cache
 * only (seconds), for list views." These tests pin down the boundaries, because
 * the dangerous version of this change is the one that starts caching messages.
 */

/** Inbox has one child, so a walk is two requests plus four alias lookups. */
function folderStub() {
  return createGraphStub((request) => {
    if (request.url.includes("/childFolders")) {
      return jsonResponse({
        value: [
          {
            id: "projects",
            displayName: "Projects",
            parentFolderId: "inbox",
            childFolderCount: 0,
            totalItemCount: 4,
            unreadItemCount: 0,
          },
        ],
      });
    }

    // A well-known alias lookup: /mailFolders/inbox and friends.
    if (/\/mailFolders\/[a-z]+(\?|$)/.test(request.url)) {
      return jsonResponse({ id: "inbox" });
    }

    return jsonResponse({
      value: [
        {
          id: "inbox",
          displayName: "Inbox",
          parentFolderId: "root",
          childFolderCount: 1,
          totalItemCount: 10,
          unreadItemCount: 0,
        },
      ],
    });
  });
}

describe("the folder tree is read once and reused", () => {
  it("makes no Graph request at all on the second read", async () => {
    const stub = folderStub();
    const service = createMailService(stub.transport);

    const first = await service.listFolders();
    const afterFirst = stub.requests.length;
    expect(afterFirst).toBeGreaterThan(1);

    const second = await service.listFolders();

    // The whole point: 11 round trips against the real mailbox become none.
    expect(stub.requests).toHaveLength(afterFirst);
    expect(second).toEqual(first);
  });

  it("shares one walk between callers that ask at the same time", async () => {
    const stub = folderStub();
    const service = createMailService(stub.transport);

    /**
     * The screen mounts the folder pane and the message list together, so two
     * callers can ask within milliseconds. The cache holds the in-flight promise
     * rather than only the settled result, so the second waits for the first
     * instead of starting a second walk of eleven requests.
     */
    const [a, b, c] = await Promise.all([
      service.listFolders(),
      service.listFolders(),
      service.listFolders(),
    ]);

    expect(a).toEqual(b);
    expect(b).toEqual(c);

    // One walk, not three.
    const walks = stub.requests.filter((r) => r.url.endsWith("/mailFolders?$select=id,displayName,parentFolderId,childFolderCount,unreadItemCount,totalItemCount&$top=100"));
    expect(walks.length).toBeLessThanOrEqual(1);
  });

  it("re-reads once the window has passed", async () => {
    vi.useFakeTimers();
    try {
      const stub = folderStub();
      const service = createMailService(stub.transport);

      await service.listFolders();
      const afterFirst = stub.requests.length;

      vi.setSystemTime(Date.now() + 31_000);
      await service.listFolders();

      // Thirty seconds of staleness is the deal; thirty-one is not.
      expect(stub.requests.length).toBeGreaterThan(afterFirst);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cache a failed walk", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    let throttled = 0;
    const stub = createGraphStub((request) => {
      const isTopLevelWalk =
        request.url.includes("/mailFolders?") && !request.url.includes("/childFolders");

      /**
       * Twice, not once: the client retries a throttled request one time by
       * design, so a single 429 would succeed on the retry and prove nothing.
       * Failing both attempts is what surfaces `throttled` to the caller.
       */
      if (isTopLevelWalk && throttled < 2) {
        throttled += 1;
        return graphErrorResponse(429, "TooManyRequests", "slow down");
      }
      if (request.url.includes("/childFolders")) return jsonResponse({ value: [] });
      if (/\/mailFolders\/[a-z]+(\?|$)/.test(request.url)) {
        return jsonResponse({ id: "inbox" });
      }
      return jsonResponse({
        value: [
          {
            id: "inbox",
            displayName: "Inbox",
            parentFolderId: "root",
            childFolderCount: 0,
            totalItemCount: 10,
            unreadItemCount: 0,
          },
        ],
      });
    });

    const service = createMailService(stub.transport);

    await expect(service.listFolders()).rejects.toMatchObject({ kind: "throttled" });

    /**
     * The retry has to actually reach Graph. Caching the rejection would leave
     * the folder pane broken for thirty seconds after one throttled read, and
     * the pane's "Try again" button would do nothing - which is the shape of bug
     * that gets reported as "the app is stuck".
     */
    const folders = await service.listFolders();
    expect(folders.length).toBeGreaterThan(0);

    vi.restoreAllMocks();
  });

  it("caches nothing about messages", async () => {
    const stub = createGraphStub(() =>
      jsonResponse({
        value: [
          {
            id: "m1",
            subject: "ZZTEST",
            isDraft: false,
            isRead: true,
            hasAttachments: false,
          },
        ],
      }),
    );
    const service = createMailService(stub.transport);

    await service.listMessages("inbox", { top: 25 });
    await service.listMessages("inbox", { top: 25 });
    await service.getMessage("m1");
    await service.getMessage("m1");

    /**
     * Four reads, four requests. A stale folder list is cosmetic; a stale
     * message list during a review is a correctness problem - somebody could act
     * on a draft that has already been sent. docs/03: reads go live to Graph.
     */
    expect(stub.requests).toHaveLength(4);
  });

  it("does not share a cache between service instances", async () => {
    const stubA = folderStub();
    const stubB = folderStub();

    await createMailService(stubA.transport).listFolders();
    await createMailService(stubB.transport).listFolders();

    // Per instance, so a test - or a differently configured service - never sees
    // another one's tree.
    expect(stubB.requests.length).toBeGreaterThan(1);
  });
});
