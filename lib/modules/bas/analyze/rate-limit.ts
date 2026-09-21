/**
 * Per-employee rate limit on questions.
 *
 * docs/BAS-B5.md: "One person cannot spend the organization's tokens by
 * holding down Enter." Each question is two model calls and a database query,
 * so the limit is on questions, per employee, in a sliding window.
 *
 * In-memory and process-local, on purpose. The platform is one container with
 * one to three users; a shared store for this would be the Redis CLAUDE.md
 * rules out. A new revision starts with an empty window, which is the harmless
 * direction. The limit is enforced in the service, not the route, so a second
 * caller of the service cannot forget it.
 */

export interface RateLimitOptions {
  /** Questions allowed per window. */
  limit: number;
  windowMs: number;
  /** Injected so a test can move time without sleeping. */
  now?: () => number;
}

export type RateLimitVerdict =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterMs: number };

export class QuestionRateLimiter {
  private readonly stamps = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: RateLimitOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.now = options.now ?? (() => Date.now());
  }

  /** Records the attempt when allowed. A refused attempt is not counted. */
  check(employeeId: string): RateLimitVerdict {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const recent = (this.stamps.get(employeeId) ?? []).filter((t) => t > cutoff);

    if (recent.length >= this.limit) {
      const oldest = recent[0]!;
      this.stamps.set(employeeId, recent);
      return { allowed: false, retryAfterMs: oldest + this.windowMs - now };
    }

    recent.push(now);
    this.stamps.set(employeeId, recent);
    return { allowed: true, remaining: this.limit - recent.length };
  }

  /** Test-only. */
  reset(): void {
    this.stamps.clear();
  }
}

/** Six a minute: a person reading answers cannot ask faster than that. */
export const QUESTIONS_PER_MINUTE = 6;

export const questionRateLimiter = new QuestionRateLimiter({
  limit: QUESTIONS_PER_MINUTE,
  windowMs: 60_000,
});
