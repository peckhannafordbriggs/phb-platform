import { logger } from "@/lib/logger";
import { MailError } from "./errors";

/**
 * The development guards, as pure predicates.
 *
 * They are called from inside the mail service, never from a route handler. A
 * route-layer check protects the routes that remember to do it; a service-layer
 * check protects every call site that will ever exist. See CLAUDE.md and
 * docs/03-exchange-and-graph.md - development runs against the live
 * changeorder@phb1899.com mailbox and there is no test mailbox.
 */

/**
 * Read live from process.env rather than from the boot-time env object.
 *
 * Two reasons, both about failing closed. A value captured at import time is
 * frozen by whatever module happened to load first, which makes the effective
 * setting depend on import order. And reading it at the moment of the send means
 * the answer is the answer *now*, not at boot.
 */
function sendAllowed(): boolean {
  return process.env.PHB_ALLOW_SEND === "true";
}

function inProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export const ZZTEST_PREFIX = "ZZTEST";

/**
 * The reply and forward prefixes Exchange writes for us.
 *
 * Not cosmetic. `createReply` and `createForward` name the draft they produce
 * "RE: <original>" / "FW: <original>", so a reply to a ZZTEST message is called
 * "RE: ZZTEST ..." - which does not begin with ZZTEST, and would put every
 * derived draft outside the fence the moment Phase 8 could create one. That
 * would mean a reply could be created and then neither edited nor sent, which
 * makes the whole path unverifiable outside production.
 *
 * Stripped rather than matched loosely: the prefix has to be at the front, and
 * what follows it still has to be a ZZTEST subject. `RE: [CCHMC RFI 229] ...`
 * is still refused, which is the case that matters.
 *
 * en-US only, deliberately. The mailbox is en-US, and accepting every locale's
 * prefix - AW:, WG:, RE :, Re[2]: - would widen the fence for a mailbox that
 * will never produce them.
 */
const REPLY_PREFIX = /^\s*(?:re|fw|fwd)\s*:\s*/i;

/**
 * Whether a subject is inside the non-production write fence.
 *
 * Exchange's own reply and forward prefixes are skipped, repeatedly, because a
 * forwarded reply is "FW: RE: ZZTEST ...". Everything else about the subject is
 * taken literally - nothing here normalizes, parses or rewrites the
 * `[CCHMC RFI 229]` tag that downstream filing depends on.
 */
export function isZzTestSubject(subject: string | null): boolean {
  if (subject === null) return false;

  let remaining = subject;
  // Bounded rather than a greedy repeated group: a pathological subject of
  // thousands of "RE:" runs must not become a regex the parser walks forever.
  for (let i = 0; i < 10; i += 1) {
    const stripped = remaining.replace(REPLY_PREFIX, "");
    if (stripped === remaining) break;
    remaining = stripped;
  }

  return remaining.trimStart().startsWith(ZZTEST_PREFIX);
}

/**
 * Write operations - draft create and update, move, delete - outside production.
 *
 * Everything a write can do is recoverable: a delete goes to Deleted Items, a
 * move reverses, a bad draft can be deleted. The guard exists anyway, because
 * "recoverable" still means an operator finds a change they did not make in a
 * mailbox a daily process depends on.
 */
export function assertWriteAllowed(
  subject: string | null,
  operation: string,
): void {
  if (inProduction()) return;

  if (!isZzTestSubject(subject)) {
    logger.warn("mail.write_blocked", {
      outcome: "blocked",
      reason: `non-production write to a non-${ZZTEST_PREFIX} message`,
      route: operation,
    });
    throw new MailError("write_not_allowed", {
      detail:
        `Refused ${operation}: outside production, write operations are permitted ` +
        `only on messages whose subject begins with ${ZZTEST_PREFIX}.`,
    });
  }
}

/**
 * The send gate.
 *
 * Stricter and separate from the write guard on purpose: every other operation
 * is reversible and a send is not. CLAUDE.md prohibition 1 - no auto-send,
 * bulk-send, send-all or scheduled send is ever added to this system, and the
 * only thing this function permits is a human-initiated send of an existing
 * draft.
 */
export function assertSendAllowed(subject: string | null, operation: string): void {
  assertSendGateOpen(operation);

  // A send is also a write, so the ZZTEST fence applies outside production.
  assertWriteAllowed(subject, operation);
}

/**
 * The environment half of the send gate, on its own.
 *
 * Separate so a send can be refused before a single Graph request is made. The
 * ZZTEST half needs the subject, and reading the subject means a network call -
 * so checking them together would mean a closed gate still talked to Exchange
 * about a message it was never going to send.
 */
export function assertSendGateOpen(operation: string): void {
  if (sendAllowed()) return;

  logger.warn("mail.send_blocked", {
    outcome: "blocked",
    reason: "PHB_ALLOW_SEND is not true",
    route: operation,
  });
  throw new MailError("send_not_allowed", {
    detail: `Refused ${operation}: PHB_ALLOW_SEND is not "true".`,
  });
}
