/**
 * What a review note is, as pure functions.
 *
 * The change-order classifier writes one plain-text note per item it declines
 * to decide, and Power Automate drops it in `_needs_review` under a fixed name
 * (docs/13-needs-review.md §3-4; the layout is fixed by the classifier spec
 * §4.2). Everything here is a decision about that text: which files count,
 * what a filename says, how the four sections are found, and which notes
 * belong to one thread. None of it touches Graph, so all of it is testable
 * without a credential.
 *
 * Tolerance is the rule. The layout is a convention a model follows, not a
 * schema a parser enforces: a note that does not parse is still a note, is
 * still counted, and is shown whole. A parser that dropped a malformed note
 * would hide exactly the item somebody most needs to look at.
 */

/**
 * The files that are review notes. Everything else in the folder - the
 * `.keep.txt` placeholder, the item folders, anything a person drops there -
 * is not one and is not counted.
 *
 * Anchored and case-insensitive: SharePoint preserves case but a filename
 * typed by hand might not, and a note is a note either way.
 */
export const NOTE_FILE_PATTERN = /^NEEDS REVIEW - (.+)\.txt$/i;

export function isNoteFileName(name: string): boolean {
  return NOTE_FILE_PATTERN.test(name);
}

/** What the filename alone says, before the note is read. */
export interface NoteFileName {
  /**
   * The automation's item id: `2026-10-05 110119 - RE RFI 254 - CCHMC Liberty
   * [MN2PR19M]`. The same string names the item folder beside the note, when
   * there is one, and appears on the note's own trailer line.
   */
  itemId: string;
  /** `YYYY-MM-DD` from the item id, or null when it does not start with one. */
  receivedDate: string | null;
  /** `HH:MM:SS` from the item id's second token, or null. UTC, by observation. */
  receivedTime: string | null;
  /**
   * The bracket at the end of the item id - `[MN2PR19M]` - which is the first
   * eight characters of the email's Internet Message-ID, verified against the
   * mailbox for every live note on 2026-10-21. Null when there is none.
   */
  messageIdHint: string | null;
}

export function parseNoteFileName(name: string): NoteFileName | null {
  const match = NOTE_FILE_PATTERN.exec(name);
  if (match === null) return null;

  const itemId = match[1]!.trim();
  const head = /^(\d{4}-\d{2}-\d{2})(?: (\d{2})(\d{2})(\d{2}))?/.exec(itemId);

  return {
    itemId,
    receivedDate: head?.[1] ?? null,
    receivedTime:
      head?.[2] !== undefined ? `${head[2]}:${head[3]}:${head[4]}` : null,
    messageIdHint: messageIdHintOf(itemId),
  };
}

/** The bracketed Message-ID fragment at the end of an item id, or null. */
export function messageIdHintOf(itemId: string): string | null {
  const match = /\[([^\[\]\s]+)\]\s*$/.exec(itemId);
  return match?.[1] ?? null;
}

export interface NoteAddress {
  name: string | null;
  address: string | null;
}

/** The note, parsed. `text` is always the whole note verbatim. */
export interface ParsedNote {
  /** The first line, e.g. `NEEDS REVIEW — unmatched Change Order reply`. */
  title: string | null;
  /** The part of the title after the dash: why this kind of note exists. */
  reason: string | null;
  receivedDate: string | null;
  from: NoteAddress | null;
  subject: string | null;
  why: string | null;
  wrote: string | null;
  nextStep: string | null;
  /** `question`, `answer`, `other`, … from the trailer line. */
  classification: string | null;
  /** `high`, `medium`, `low` from the trailer line. */
  confidence: string | null;
  text: string;
}

const SECTION_HEADINGS = {
  why: "WHY THIS NEEDS A HUMAN",
  wrote: "WHAT THEY WROTE",
  nextStep: "SUGGESTED NEXT STEP",
} as const;

type SectionKey = keyof typeof SECTION_HEADINGS;

function headingOf(line: string): SectionKey | null {
  const trimmed = line.trim();
  for (const key of Object.keys(SECTION_HEADINGS) as SectionKey[]) {
    if (trimmed === SECTION_HEADINGS[key]) return key;
  }
  return null;
}

/** A trailer line ends the sections: `Classification: …`, `Source: …`. */
function isTrailer(line: string): boolean {
  return /^(Classification|Source|Item):\s/.test(line.trim());
}

/**
 * `Mark Shad <mshad@phb1899.com>`, `<mshad@phb1899.com>`, or a bare address.
 * A name with no address is kept as a name; the match is on the brackets, not
 * on what an address looks like, because the value is shown and never used.
 */
export function parseNoteAddress(value: string): NoteAddress | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const bracketed = /^(.*?)\s*<([^<>]+)>\s*$/.exec(trimmed);
  if (bracketed !== null) {
    const name = bracketed[1]!.trim();
    return { name: name.length > 0 ? name : null, address: bracketed[2]!.trim() };
  }

  return trimmed.includes("@")
    ? { name: null, address: trimmed }
    : { name: trimmed, address: null };
}

function trimSection(lines: string[]): string | null {
  const text = lines.join("\n").trim();
  return text.length > 0 ? text : null;
}

export function parseNote(raw: string): ParsedNote {
  // A BOM is how Power Automate sometimes starts a text file; it is not text.
  const text = raw.replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);

  const note: ParsedNote = {
    title: null,
    reason: null,
    receivedDate: null,
    from: null,
    subject: null,
    why: null,
    wrote: null,
    nextStep: null,
    classification: null,
    confidence: null,
    text,
  };

  const firstLine = lines.find((line) => line.trim().length > 0) ?? null;
  if (firstLine !== null) {
    note.title = firstLine.trim();
    // Either dash. The spec writes an em dash; a hand-typed note might not.
    const dash = /^NEEDS REVIEW\s*[—–-]\s*(.+)$/i.exec(note.title);
    note.reason = dash?.[1]?.trim() ?? null;
  }

  const sections: Record<SectionKey, string[]> = { why: [], wrote: [], nextStep: [] };
  let current: SectionKey | null = null;

  for (const line of lines) {
    const heading = headingOf(line);
    if (heading !== null) {
      current = heading;
      continue;
    }

    if (isTrailer(line)) {
      current = null;
      const classification = /^Classification:\s*([^(·]+?)\s*(?:\(\s*([a-z]+)\s+confidence\s*\))?\s*(?:·|$)/i.exec(
        line.trim(),
      );
      if (classification !== null) {
        note.classification = classification[1]!.trim().toLowerCase();
        note.confidence = classification[2]?.toLowerCase() ?? null;
      }
      continue;
    }

    if (current !== null) {
      sections[current].push(line);
      continue;
    }

    // Header lines, anywhere before the first section.
    const header = /^(Received|From|Subject):\s*(.*)$/.exec(line);
    if (header !== null) {
      const value = header[2]!.trim();
      if (header[1] === "Received") note.receivedDate = value.length > 0 ? value : null;
      else if (header[1] === "From") note.from = parseNoteAddress(value);
      else note.subject = value.length > 0 ? value : null;
    }
  }

  note.why = trimSection(sections.why);
  note.wrote = trimSection(sections.wrote);
  note.nextStep = trimSection(sections.nextStep);

  return note;
}

/**
 * Exchange's own reply and forward prefixes, skipped repeatedly, so `RE: FW:
 * Temp Lab` and `Temp Lab` are one thread. Deliberately the same two prefixes
 * the ZZTEST fence skips (mail/guards.ts) and no others: this mailbox is
 * en-US, and matching every locale's prefix would merge subjects that are
 * genuinely different.
 *
 * A loop rather than a regex with `+`, for the same reason guards.ts gives:
 * a subject of thousands of "RE:" must not become something the regex engine
 * walks forever.
 */
export function subjectGroupKey(subject: string | null): string {
  let rest = (subject ?? "").trim();

  for (;;) {
    const stripped = rest.replace(/^(?:RE|FW|FWD)\s*:\s*/i, "");
    if (stripped === rest) break;
    rest = stripped;
  }

  return rest.replace(/\s+/g, " ").toLowerCase();
}

/** A note as the listing carries it: what the folder said, plus the parse. */
export interface ReviewNote extends ParsedNote {
  /** The drive item id. Opaque; passed back to read the note, never parsed. */
  id: string;
  fileName: string;
  itemId: string;
  /**
   * From the filename, so it exists even for a note whose text did not parse,
   * and in a form that sorts. `receivedDate` on the parse is the header's.
   */
  fileDate: string | null;
  fileTime: string | null;
  /** The Message-ID fragment from the filename's bracket. See NoteFileName. */
  fileMessageIdHint: string | null;
  sizeBytes: number;
  lastModified: string | null;
  /** Where the note lives, for a person who wants the folder. */
  webUrl: string | null;
  /**
   * Whether an item folder of the same name sits beside the note. Absent for
   * every note written before the 2026-10-21 flow fix, and shown as a fact
   * rather than treated as an error - the email itself is read from Exchange.
   */
  hasItemFolder: boolean;
}

export interface ReviewGroup {
  key: string;
  /** The newest note's subject, verbatim; the filename's hint when none parsed. */
  subject: string;
  notes: ReviewNote[];
  newestDate: string | null;
  oldestDate: string | null;
}

/**
 * `YYYY-MM-DD HH:MM:SS` or `YYYY-MM-DD`, for ordering. Nulls sort last so a
 * note with an unreadable filename is still listed rather than lost.
 */
export function noteSortKey(note: Pick<ReviewNote, "fileDate" | "fileTime">): string | null {
  if (note.fileDate === null) return null;
  return note.fileTime === null ? note.fileDate : `${note.fileDate} ${note.fileTime}`;
}

function byNewestFirst(a: ReviewNote, b: ReviewNote): number {
  const ak = noteSortKey(a);
  const bk = noteSortKey(b);
  if (ak === bk) return a.fileName.localeCompare(b.fileName);
  if (ak === null) return 1;
  if (bk === null) return -1;
  return bk.localeCompare(ak);
}

/**
 * Groups by subject, as decided (2026-10-21). Not by conversation id: the
 * note carries none, and the backlog notes have no item folder to read one
 * from. The subject is the note header's; a note whose header did not parse
 * groups on the filename's hint, which SharePoint has already stripped of
 * punctuation, so such a note may sit in a group of its own. That is the
 * honest outcome for a note the parser could not read.
 */
export function groupNotes(notes: readonly ReviewNote[]): ReviewGroup[] {
  const groups = new Map<string, ReviewNote[]>();

  for (const note of notes) {
    const key = subjectGroupKey(note.subject ?? fileNameHint(note.itemId));
    const members = groups.get(key) ?? [];
    members.push(note);
    groups.set(key, members);
  }

  const result: ReviewGroup[] = [];
  for (const [key, members] of groups) {
    members.sort(byNewestFirst);
    const dated = members.map(noteSortKey).filter((k): k is string => k !== null);
    const newest = members[0]!;
    result.push({
      key,
      subject: newest.subject ?? fileNameHint(newest.itemId),
      notes: members,
      newestDate: dated[0] ?? null,
      oldestDate: dated[dated.length - 1] ?? null,
    });
  }

  result.sort((a, b) => {
    if (a.newestDate === b.newestDate) return a.key.localeCompare(b.key);
    if (a.newestDate === null) return 1;
    if (b.newestDate === null) return -1;
    return b.newestDate.localeCompare(a.newestDate);
  });

  return result;
}

/**
 * The subject-shaped part of an item id, after the date and time: `RE RFI 254
 * - CCHMC Liberty [MN2PR19M]` becomes `RE RFI 254 - CCHMC Liberty`. A hint,
 * not the subject: the automation strips punctuation when it names the folder.
 */
export function fileNameHint(itemId: string): string {
  return itemId
    .replace(/^\d{4}-\d{2}-\d{2}(?: \d{6})?\s*-\s*/, "")
    .replace(/\s*\[[^\]]*\]\s*$/, "")
    .trim();
}

/** The count the tab shows, and the date beside it. From filenames alone. */
export interface ReviewSummary {
  count: number;
  /** `YYYY-MM-DD` of the oldest note, by its filename. Null when none dates. */
  oldestDate: string | null;
  newestDate: string | null;
}

export function summarise(
  notes: readonly Pick<ReviewNote, "fileDate" | "fileTime">[],
): ReviewSummary {
  const dates = notes
    .map((note) => note.fileDate)
    .filter((d): d is string => d !== null)
    .sort();

  return {
    count: notes.length,
    oldestDate: dates[0] ?? null,
    newestDate: dates[dates.length - 1] ?? null,
  };
}
