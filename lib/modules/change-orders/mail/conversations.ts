import type {
  ConversationGroup,
  ConversationTruncation,
  MailAddress,
  MessageSummary,
} from "./types";

/**
 * Grouping a folder's messages into conversations.
 *
 * Pure, and deliberately separate from the service: everything here is
 * arithmetic over `MessageSummary`, so it is testable without a Graph transport
 * and reusable for a search result, which the service has already collected and
 * sorted by the time it gets here.
 *
 * Grouping is a DISPLAY concern and nothing more. Nothing in this file produces
 * an id that an action can be aimed at, and `ConversationGroup` carries its
 * messages individually rather than any kind of aggregate handle - see
 * CLAUDE.md on why acting on more than one message at a time is not a thing
 * this platform will ever have.
 */

/**
 * The key a message groups under.
 *
 * A message with no `conversationId` gets a key derived from its own id rather
 * than sharing one null bucket with every other such message. Exchange does
 * populate `conversationId` on everything in this mailbox, but "the field was
 * missing so we merged nine unrelated messages into one thread" is precisely
 * the silent-hiding failure PHASE-9 names, and a defensive key costs nothing.
 *
 * The prefixes keep the two spaces disjoint: a real conversation id can never
 * collide with a synthesised one.
 */
export function conversationKeyOf(message: MessageSummary): string {
  const id = message.conversationId;
  return id !== null && id.length > 0 ? `c:${id}` : `m:${message.id}`;
}

/** Epoch millis, or null when Exchange gave us nothing to order by. */
function timeOf(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Oldest first, which is the order a thread is read in.
 *
 * PHASE-9: "Expand to the individual messages, newest last." A message with no
 * date sorts to the top - it is the least useful row, and burying it under the
 * newest reply would hide it.
 */
function byOldestFirst(a: MessageSummary, b: MessageSummary): number {
  const left = timeOf(a.receivedDateTime);
  const right = timeOf(b.receivedDateTime);

  if (left === null && right === null) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  if (left !== right) return left - right;

  // Ties broken on id so the order is stable across polls. Two messages in one
  // thread sharing a timestamp to the second is ordinary; a list that reshuffles
  // under the reader every 60 seconds is not.
  return a.id.localeCompare(b.id);
}

/** Newest group first, matching the flat list's ordering. */
function byNewestGroupFirst(a: ConversationGroup, b: ConversationGroup): number {
  const left = timeOf(a.newestDateTime);
  const right = timeOf(b.newestDateTime);

  if (left === null && right === null) return a.id.localeCompare(b.id);
  if (left === null) return 1;
  if (right === null) return -1;
  if (left !== right) return right - left;

  return a.id.localeCompare(b.id);
}

/**
 * Who took part, in the order they first appear in the thread.
 *
 * Senders, because that is who a person is looking for when they scan a thread
 * row. A conversation whose messages have no sender at all - a folder of
 * unsent drafts, where Exchange has not stamped `from` yet - falls back to the
 * recipients, so the row says "to Joel Prater" instead of saying nothing.
 *
 * Deduplicated on the address, case-insensitively, keeping the first display
 * name seen. Exchange varies the casing of the same address between messages.
 */
function participantsOf(ordered: MessageSummary[]): MailAddress[] {
  const seen = new Map<string, MailAddress>();

  for (const message of ordered) {
    const from = message.from;
    if (from === null) continue;
    const key = from.address.toLowerCase();
    if (!seen.has(key)) seen.set(key, from);
  }

  if (seen.size > 0) return [...seen.values()];

  for (const message of ordered) {
    for (const to of message.to) {
      const key = to.address.toLowerCase();
      if (!seen.has(key)) seen.set(key, to);
    }
  }

  return [...seen.values()];
}

/**
 * Groups messages into conversations, newest conversation first.
 *
 * The input is expected to be the COMPLETE set being displayed - see
 * ChangeOrderMailService.listConversations, which collects a folder to a cap
 * rather than grouping one page. Grouping a page produces a header that makes a
 * false factual claim ("4 messages") about a thread that has nine, and a wrong
 * count is worse than an absent one.
 *
 * Input order is not relied on: the group order and the within-group order are
 * both established here.
 */
export function groupConversations(
  messages: MessageSummary[],
): ConversationGroup[] {
  const buckets = new Map<string, MessageSummary[]>();

  for (const message of messages) {
    const key = conversationKeyOf(message);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [message]);
    else bucket.push(message);
  }

  const groups: ConversationGroup[] = [];

  for (const [id, bucket] of buckets) {
    const ordered = [...bucket].sort(byOldestFirst);

    /**
     * The newest message's subject, not the oldest.
     *
     * Exchange keeps `conversationId` stable across a reply, and the reply's
     * subject is what carries `RE:` and any retagging - so the newest subject is
     * the one that matches what the person saw arrive. Nothing here parses or
     * strips the `[CCHMC RFI 229]` tag: docs/03, preserve the subject exactly.
     */
    const newest = ordered[ordered.length - 1];

    groups.push({
      id,
      subject: newest?.subject ?? null,
      participants: participantsOf(ordered),
      messageCount: ordered.length,
      unreadCount: ordered.filter((m) => !m.isRead && !m.isDraft).length,
      draftCount: ordered.filter((m) => m.isDraft).length,
      hasAttachments: ordered.some((m) => m.hasAttachments),
      newestDateTime: newest?.receivedDateTime ?? null,
      messages: ordered,
    });
  }

  return groups.sort(byNewestGroupFirst);
}

/**
 * What a truncated grouped list can honestly claim, per cap.
 *
 * The two caps are NOT equivalent and must not share a sentence:
 *
 *   folder_cap - the collection is `$orderby=receivedDateTime desc` with no
 *     `$filter`, so the messages that did not fit are the OLDEST in the folder.
 *     A conversation can be missing early replies; it can never be missing the
 *     newest one.
 *
 *   search_cap - a search is `$filter=contains(subject,…)` and Exchange refuses
 *     `$filter` with `$orderby` (400 InefficientFilter), so the result set comes
 *     back in no order at all. What did not fit is an ARBITRARY subset, and a
 *     group can be missing messages from anywhere including its newest.
 *
 * Returned as a discriminator rather than a prose string so the wording lives in
 * the UI and the decision lives here.
 */
export function truncationOf(
  truncated: boolean,
  cap: ConversationTruncation,
): ConversationTruncation | null {
  return truncated ? cap : null;
}
