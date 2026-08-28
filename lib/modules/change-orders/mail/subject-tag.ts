/**
 * Splitting the bracketed project tag off the front of a subject, for display.
 *
 * The subjects in this mailbox are long, repetitive, and distinguished almost
 * entirely by a bracket at the front:
 *
 *   [CCHMC RFI 229] New CO logged (Bid Tracker) - Due 08/25/2026
 *   [CCHMC Bulletin 12] Change Order Request - Additional Information Needed
 *   RE: [CCHMC RFI 229] New CO logged (Bid Tracker) - Due 08/25/2026
 *
 * That bracket is the thing people actually scan for, and today it is buried at
 * the head of a sixty-character line among five others that begin the same way.
 * Pulling it out as its own element is the one change to the dense surface worth
 * making.
 *
 * DISPLAY ONLY, and that is a hard rule rather than a preference. docs/03 and
 * CLAUDE.md: preserve the subject exactly and let a human read it. Nothing here
 * rewrites, normalises or regenerates a subject - `tag` and `rest` are two views
 * of one string, and the original is always what gets sent, saved and searched.
 *
 * Not every message has one. The scope-request drafts start with a project name
 * and no brackets at all, so `tag` is null far more often than not and the row
 * has to look right either way.
 */

export interface SubjectParts {
  /** The tag without its brackets, or null when the subject has none. */
  tag: string | null;
  /**
   * Everything else, INCLUDING any `RE:` / `FW:` prefix.
   *
   * The prefix stays here rather than being dropped or promoted: it is part of
   * what the subject says, and a reply that stopped looking like a reply would
   * be a worse row than one with a slightly longer line.
   */
  rest: string;
}

/**
 * Exchange's own reply and forward prefixes.
 *
 * Matched only to find where the bracket starts. en-US only, matching the fence
 * in ./guards.ts - this mailbox is en-US and accepting every locale's prefix
 * would widen what counts as a tag for no gain.
 */
const REPLY_PREFIX = /^\s*((?:re|fw|fwd)\s*:\s*)/i;

/**
 * The longest a bracket can be and still be a project tag.
 *
 * A guard against treating a bracketed sentence as a label. The real tags are
 * short - `CCHMC RFI 229`, `CCHMC Bulletin 12`, `P&G Permit Pack 4, Bulletin 4`
 * - and something longer is prose that happens to be in brackets, which belongs
 * in the subject line where it was written.
 */
const MAX_TAG_LENGTH = 48;

export function splitSubjectTag(subject: string | null): SubjectParts {
  if (subject === null) return { tag: null, rest: "" };

  // Collect the reply prefixes so they can be put back in front of `rest`.
  let prefix = "";
  let remaining = subject;
  for (let i = 0; i < 10; i += 1) {
    const match = REPLY_PREFIX.exec(remaining);
    if (match === null) break;
    prefix += match[1];
    remaining = remaining.slice(match[0].length);
  }

  if (!remaining.startsWith("[")) {
    return { tag: null, rest: subject };
  }

  const close = remaining.indexOf("]");
  // An unclosed bracket is not a tag. Leave the subject alone.
  if (close === -1) return { tag: null, rest: subject };

  const tag = remaining.slice(1, close).trim();
  if (tag.length === 0 || tag.length > MAX_TAG_LENGTH) {
    return { tag: null, rest: subject };
  }

  /**
   * The leading space is stripped from the remainder before the prefix is put
   * back, not after. A captured prefix already ends in its own space, so a plain
   * concatenation produces `RE:  New CO logged` with two - which a later trim
   * cannot reach, because it is in the middle of the string.
   */
  const rest = (prefix + remaining.slice(close + 1).replace(/^\s+/, "")).trim();

  /**
   * A subject that is nothing but its tag keeps the whole subject as `rest`.
   *
   * Otherwise the row would render a chip and no text, which reads as a bug
   * rather than as a short subject.
   */
  if (rest.length === 0) return { tag: null, rest: subject };

  return { tag, rest };
}
