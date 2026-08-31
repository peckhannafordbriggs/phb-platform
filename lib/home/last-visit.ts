/**
 * What Home may honestly say about the reader's previous visit.
 *
 * A plain module with no imports, for the same reason
 * app/(modules)/bas/health-client.ts is one: this rule has to be *proved*, and
 * lib/home/service.ts reaches Prisma and next-auth, which a node test
 * environment cannot load. Logic that needs a test lives where a test can
 * import it.
 */

/**
 * THREE states, not two, and collapsing them is the bug this type exists to
 * prevent.
 *
 * `previousLoginAt` being null does not mean "first visit". It also means "this
 * row predates the column" - which was true of every employee the day the
 * column shipped, including people who had used the platform for weeks. Telling
 * one of them "this is your first time here" is a false claim about their own
 * history, and it is exactly the kind of confident-looking wrong answer the
 * rest of this module refuses to produce.
 */
export type LastVisit =
  /** We know when. The only state that can date a "since you last signed in". */
  | { state: "known"; at: Date }
  /** Genuinely their first sign-in. There is no previous visit. */
  | { state: "first" }
  /** They have been here before and we do not know when. Claim neither. */
  | { state: "unknown" };

/**
 * `firstSeenAt` separates "first visit" from "we lost the record" exactly,
 * rather than by heuristic: sign-in writes both columns at the same instant the
 * first time and moves only `lastLoginAt` after that. So `lastLoginAt` strictly
 * after `firstSeenAt` proves a second visit happened, whether or not anything
 * recorded when it was.
 */
export function classifyLastVisit(employee: {
  previousLoginAt: Date | null;
  lastLoginAt: Date | null;
  firstSeenAt: Date;
}): LastVisit {
  if (employee.previousLoginAt !== null) {
    return { state: "known", at: employee.previousLoginAt };
  }

  /**
   * No `lastLoginAt` at all is a row seeded ahead of its owner. It cannot be
   * the one rendering this page, but "has never signed in" is nearer to first
   * than to a visit we failed to record.
   */
  if (employee.lastLoginAt === null) return { state: "first" };

  // Strictly greater: equal is the first sign-in, which wrote both at once.
  return employee.lastLoginAt.getTime() > employee.firstSeenAt.getTime()
    ? { state: "unknown" }
    : { state: "first" };
}
