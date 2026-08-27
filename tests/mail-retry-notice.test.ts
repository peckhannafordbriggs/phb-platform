import { describe, expect, it } from "vitest";
import {
  captureThrottleRetries,
  noteThrottleRetry,
} from "@/lib/modules/change-orders/graph/retry-notice";
import { createMailService } from "@/lib/modules/change-orders/mail/service";
import {
  createGraphStub,
  graphErrorResponse,
  jsonResponse,
} from "./graph-stub";

/**
 * Telling the browser that a request was throttled and retried.
 *
 * PHASE-9: "make the UI show that a request is being retried rather than
 * appearing frozen". The retry happens inside the Graph middleware chain, after
 * honouring Retry-After, which means it happens inside ONE HTTP request from the
 * browser's point of view - so the pane sits there for up to thirty extra
 * seconds with nothing to show and no way to know why.
 *
 * It cannot be streamed, so what is honest is to say it afterwards. These pin
 * down that the notice is captured at all, and - more importantly - that it is
 * attributed to the request that was actually throttled.
 */

const FOLDER = {
  id: "folder-inbox",
  displayName: "Inbox",
  parentFolderId: "root",
  totalItemCount: 7,
  unreadItemCount: 0,
  childFolderCount: 2,
};

describe("capturing a throttle retry", () => {
  it("reports nothing when nothing was throttled", async () => {
    const stub = createGraphStub(() => jsonResponse(FOLDER));

    const { notice } = await captureThrottleRetries(() =>
      createMailService(stub.transport).getFolder("folder-inbox"),
    );

    // Absent rather than zero: presence is the signal, so an ordinary response
    // carries no header at all.
    expect(notice).toBeNull();
  });

  it("records the retry and the seconds waited, from the real middleware", async () => {
    const stub = createGraphStub([
      () =>
        graphErrorResponse(429, "TooManyRequests", "slow down", {
          "retry-after": "7",
        }),
      () => jsonResponse(FOLDER),
    ]);

    const { value, notice } = await captureThrottleRetries(() =>
      createMailService(stub.transport).getFolder("folder-inbox"),
    );

    // The request succeeded on the retry, so the caller got its answer...
    expect(value.displayName).toBe("Inbox");
    // ...and the wait it sat through has a stated reason.
    expect(notice).toEqual({ count: 1, waitedSeconds: 7 });
    expect(stub.sleeps).toEqual([7000]);
  });

  it("still reports the wait when the retry fails too", async () => {
    const stub = createGraphStub([
      () =>
        graphErrorResponse(429, "TooManyRequests", "slow", { "retry-after": "3" }),
      () =>
        graphErrorResponse(429, "TooManyRequests", "slow", { "retry-after": "5" }),
    ]);

    const { notice } = await captureThrottleRetries(async () => {
      await expect(
        createMailService(stub.transport).getFolder("folder-inbox"),
      ).rejects.toMatchObject({ kind: "throttled" });
    });

    // The route answers with an error AND with the reason it took so long to
    // produce it - a throttled failure is a different story from a slow one.
    expect(notice).toEqual({ count: 1, waitedSeconds: 3 });
  });

  it("adds up several throttled requests inside one route invocation", async () => {
    let n = 0;
    const stub = createGraphStub(() => {
      n += 1;
      // Every other request throttles once.
      if (n % 2 === 1) {
        return graphErrorResponse(429, "TooManyRequests", "slow", {
          "retry-after": "2",
        });
      }
      return jsonResponse(FOLDER);
    });

    const { notice } = await captureThrottleRetries(async () => {
      const service = createMailService(stub.transport);
      await service.getFolder("folder-inbox");
      await service.getFolder("folder-inbox");
    });

    expect(notice).toEqual({ count: 2, waitedSeconds: 4 });
  });

  /**
   * The reason this is AsyncLocalStorage rather than a module counter.
   *
   * The Graph client is memoised process-wide, so its middleware instances are
   * shared by every concurrent request. A shared counter would attribute one
   * request's throttle to whichever other request read it next - a pane claiming
   * the mailbox was busy when its own request sailed through, which is worse
   * than saying nothing.
   */
  it("does not attribute one request's throttle to a concurrent one", async () => {
    const slowStub = createGraphStub([
      () =>
        graphErrorResponse(429, "TooManyRequests", "slow", { "retry-after": "4" }),
      () => jsonResponse(FOLDER),
    ]);
    const fastStub = createGraphStub(() => jsonResponse(FOLDER));

    const [slow, fast] = await Promise.all([
      captureThrottleRetries(() =>
        createMailService(slowStub.transport).getFolder("folder-inbox"),
      ),
      captureThrottleRetries(() =>
        createMailService(fastStub.transport).getFolder("folder-inbox"),
      ),
    ]);

    expect(slow.notice).toEqual({ count: 1, waitedSeconds: 4 });
    expect(fast.notice).toBeNull();
  });

  it("is a no-op outside a scope, so a script or a job cannot fail on it", () => {
    // Nothing is listening. This must not throw - the notice is a message, not
    // a load-bearing mechanism.
    expect(() => noteThrottleRetry(5)).not.toThrow();
  });
});
