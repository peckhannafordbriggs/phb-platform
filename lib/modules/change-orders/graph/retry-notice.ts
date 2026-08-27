import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Carrying "that request was throttled and retried" out to the browser.
 *
 * The problem this solves is narrow. A throttled request is retried once inside
 * the Graph middleware chain, after honouring `Retry-After` - which means the
 * whole thing happens inside ONE HTTP request from the browser's point of view,
 * and the pane simply sits there for up to thirty extra seconds looking frozen.
 * PHASE-9 asks for that to be visible rather than mysterious.
 *
 * It cannot be streamed - the retry finishes before the response begins - so
 * what is honest is to say it afterwards: the request comes back carrying a note
 * that it was retried and how long it waited, and the UI says so. The browser
 * separately shows a "still working" hint while a request is simply slow, which
 * covers the during-the-wait half.
 *
 * ## Why AsyncLocalStorage
 *
 * The Graph client is memoised process-wide, so its middleware instances are
 * shared by every concurrent request. A module-level counter would attribute one
 * request's throttle to whichever other request happened to read it next, which
 * is worse than not reporting at all: a pane would claim the mailbox was busy
 * when its own request sailed through. AsyncLocalStorage scopes the record to
 * the async context that opened it, which is exactly one route invocation.
 *
 * Outside a scope - a script, a background call, a test that did not open one -
 * noteThrottleRetry is a no-op rather than an error. Nothing here is load
 * bearing; it is a message.
 */

export interface RetryNotice {
  /** Throttled Graph requests retried during this route invocation. */
  count: number;
  /** Total seconds spent waiting on `Retry-After` before retrying. */
  waitedSeconds: number;
}

const storage = new AsyncLocalStorage<RetryNotice>();

/**
 * Records one throttle retry against the current scope.
 *
 * Called by ThrottleRetryMiddleware, which is the only place that knows a retry
 * happened at all.
 */
export function noteThrottleRetry(waitSeconds: number): void {
  const record = storage.getStore();
  if (record === undefined) return;

  record.count += 1;
  record.waitedSeconds += waitSeconds;
}

/**
 * Runs `fn` in a fresh scope and reports what was retried inside it.
 *
 * `notice` is null when nothing was throttled, so the caller sets no header in
 * the ordinary case rather than an "everything is fine" one.
 */
export async function captureThrottleRetries<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; notice: RetryNotice | null }> {
  const record: RetryNotice = { count: 0, waitedSeconds: 0 };

  const value = await storage.run(record, fn);

  return { value, notice: record.count > 0 ? { ...record } : null };
}

/**
 * The header names the browser reads.
 *
 * A header rather than a field in the `{ data }` body because every mail route
 * would otherwise have to thread it through its own payload, and a route that
 * forgot would silently lose the notice. The wrapper sets it once for all of
 * them - the same reason withMailbox owns the authorization check.
 */
export const RETRY_COUNT_HEADER = "x-phb-mail-retried";
export const RETRY_WAIT_HEADER = "x-phb-mail-retry-wait";
