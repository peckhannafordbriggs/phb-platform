import type { MessageMatchCandidate } from "../mail/types";

/**
 * Tying a note to the email it is about, in the mailbox.
 *
 * A note carries a subject and a received date; its filename carries the
 * automation's timestamp to the second and, in square brackets, the first
 * eight characters of the email's Internet Message-ID. It carries no Graph
 * message id and no conversation id - the backlog notes have no item folder
 * to read one from - so the link is made from what it has, and verified
 * against the live mailbox on 2026-10-21 across all fourteen notes:
 *
 *   1. Exact subject, received within the note's day (the candidates come
 *      from the mail service's mailbox-wide lookup).
 *   2. The bracket, when a candidate's Message-ID starts with it. It names
 *      the sender's mailbox server, so it tells senders apart and not two
 *      messages from one sender.
 *   3. The automation's stamp is ALWAYS after the message - Power Automate
 *      drops the item after Exchange has it, 45 to 70 seconds later on every
 *      note checked. So the match is the LATEST candidate received at or
 *      before the stamp, never the nearest: two replies a minute apart put
 *      the nearest on the wrong side (`tests/co-review-match.test.ts` holds
 *      the pair that proved it).
 *
 * It is a match, not an identity, and the screen says so: how it was matched
 * is returned, and the message's own sender and time are shown beside the
 * note's, so a wrong pairing is visible rather than silent.
 */

/** Twelve hours either side of the calendar day, so a UTC/local skew cannot miss it. */
const WINDOW_SLACK_MS = 12 * 60 * 60 * 1000;

/** The received-time window to search for a note dated `day` (YYYY-MM-DD). */
export function searchWindow(day: string): { from: Date; to: Date } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;

  const start = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(start)) return null;

  return {
    from: new Date(start - WINDOW_SLACK_MS),
    to: new Date(start + 24 * 60 * 60 * 1000 + WINDOW_SLACK_MS),
  };
}

export type MatchedBy = "message_id_and_time" | "subject_and_time";

export interface MatchChoice {
  message: MessageMatchCandidate;
  matchedBy: MatchedBy;
}

/**
 * The candidate the note is about, or null when there are none.
 *
 * `hint` is the bracket from the note's filename; `time` is the stamp, or
 * null when the filename carried none (then the newest candidate wins).
 */
export function chooseMatch(
  candidates: readonly MessageMatchCandidate[],
  day: string,
  time: string | null,
  hint: string | null,
): MatchChoice | null {
  if (candidates.length === 0) return null;

  const byId =
    hint === null ? [] : candidates.filter((c) => messageIdStartsWith(c.internetMessageId, hint));
  const pool = byId.length > 0 ? byId : candidates;
  const matchedBy: MatchedBy = byId.length > 0 ? "message_id_and_time" : "subject_and_time";

  const stamp = time === null ? Number.NaN : Date.parse(`${day}T${time}Z`);

  if (Number.isNaN(stamp)) {
    return { message: newest(pool), matchedBy };
  }

  // Latest at or before the stamp; failing that - a clock ahead of Exchange -
  // the earliest after it, which is the nearest on the only side left.
  const before = pool.filter((c) => receivedMs(c) <= stamp && receivedMs(c) !== Number.NEGATIVE_INFINITY);
  if (before.length > 0) return { message: newest(before), matchedBy };

  const after = pool.filter((c) => receivedMs(c) > stamp);
  if (after.length > 0) {
    return {
      message: [...after].sort((a, b) => receivedMs(a) - receivedMs(b))[0]!,
      matchedBy,
    };
  }

  return { message: newest(pool), matchedBy };
}

function messageIdStartsWith(internetMessageId: string | null, hint: string): boolean {
  if (internetMessageId === null || hint.length === 0) return false;
  return internetMessageId.replace(/^</, "").startsWith(hint);
}

function newest(pool: readonly MessageMatchCandidate[]): MessageMatchCandidate {
  return [...pool].sort((a, b) => receivedMs(b) - receivedMs(a))[0]!;
}

function receivedMs(message: MessageMatchCandidate): number {
  const ms =
    message.receivedDateTime === null ? Number.NaN : Date.parse(message.receivedDateTime);
  // An unparseable time sorts as oldest and never wins.
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}
