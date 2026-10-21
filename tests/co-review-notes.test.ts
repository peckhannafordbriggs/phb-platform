import { describe, expect, it } from "vitest";
import {
  NOTE_FILE_PATTERN,
  fileNameHint,
  groupNotes,
  isNoteFileName,
  messageIdHintOf,
  parseNote,
  parseNoteAddress,
  parseNoteFileName,
  subjectGroupKey,
  summarise,
  type ReviewNote,
} from "@/lib/modules/change-orders/review/notes";

/**
 * The pure half of Needs Review: which files are notes, what a filename
 * says, how the four sections are found, and how notes become threads.
 *
 * The fixtures follow the classifier spec's layout (§4.2) with invented,
 * ZZTEST-flavoured content. No real note is committed: a note is model-written
 * text derived from a vendor's email, and CLAUDE.md prohibition 8 forbids a
 * real message as a fixture.
 */

const NOTE = `NEEDS REVIEW — unmatched Change Order reply
============================================
Received: 2026-10-05
From:     ZZ Tester <zztest@example.invalid>
Subject:  RE: ZZTEST RFI 999 - Example Site

WHY THIS NEEDS A HUMAN
The email is about ZZTEST RFI 999, but there is no row for it in the Bid
Tracker and the thread's conversation ID matches no tracked CO.

WHAT THEY WROTE
"Do we only put flex connections in where noted? There are many other ducts
crossing the line."

SUGGESTED NEXT STEP
Confirm whether RFI 999 has gone through intake. If it has a CO row, re-stage
with co_key ZZTEST|RFI 999; otherwise close.

Classification: question (high confidence)   ·   Item: 2026-10-05 110119 - RE ZZTEST RFI 999 - Example Site [AB1CD23E]
Source: Change Order Step 2/_to_classify/2026-10-05 110119 - RE ZZTEST RFI 999 - Example Site [AB1CD23E]/
`;

describe("which files are notes", () => {
  it("matches the automation's filename and nothing else in the folder", () => {
    expect(isNoteFileName("NEEDS REVIEW - 2026-10-05 110119 - RE RFI 254 - CCHMC Liberty [MN2PR19M].txt")).toBe(true);
    // The placeholder SharePoint keeps in an otherwise-empty folder.
    expect(isNoteFileName(".keep.txt")).toBe(false);
    // An item folder is named like the note without the prefix.
    expect(isNoteFileName("2026-10-05 110119 - RE RFI 254 - CCHMC Liberty [MN2PR19M]")).toBe(false);
    expect(isNoteFileName("NEEDS REVIEW - something.pdf")).toBe(false);
    expect(isNoteFileName("notes.txt")).toBe(false);
  });

  it("is anchored at both ends", () => {
    expect(NOTE_FILE_PATTERN.source.startsWith("^")).toBe(true);
    expect(NOTE_FILE_PATTERN.source.endsWith("$")).toBe(true);
    expect(isNoteFileName("x NEEDS REVIEW - a.txt")).toBe(false);
    expect(isNoteFileName("NEEDS REVIEW - a.txt.exe")).toBe(false);
  });

  it("reads the item id, date and time out of the filename", () => {
    const parsed = parseNoteFileName(
      "NEEDS REVIEW - 2026-10-05 110119 - RE RFI 254 - CCHMC Liberty [MN2PR19M].txt",
    );
    expect(parsed).toEqual({
      itemId: "2026-10-05 110119 - RE RFI 254 - CCHMC Liberty [MN2PR19M]",
      receivedDate: "2026-10-05",
      receivedTime: "11:01:19",
      // The first eight characters of the email's Internet Message-ID,
      // verified against the mailbox for every live note on 2026-10-21.
      messageIdHint: "MN2PR19M",
    });
    expect(messageIdHintOf("2026-10-12 121046 - Re Reminder - pricing due 10-09-2026  [CAMzoE+o]")).toBe("CAMzoE+o");
    expect(messageIdHintOf("2026-07-16 - TEST Fix2 drain verify A [ZZ FIX2 DT-01] 125455")).toBeNull();
    expect(messageIdHintOf("no bracket at all")).toBeNull();
  });

  it("keeps a note whose name carries no stamp, with nulls rather than a guess", () => {
    expect(parseNoteFileName("NEEDS REVIEW - hand-written.txt")).toEqual({
      itemId: "hand-written",
      receivedDate: null,
      receivedTime: null,
      messageIdHint: null,
    });
    expect(parseNoteFileName("NEEDS REVIEW - 2026-07-15 - Re something.txt")).toMatchObject({
      receivedDate: "2026-07-15",
      receivedTime: null,
    });
  });

  it("turns an item id into a subject hint", () => {
    expect(fileNameHint("2026-10-05 110119 - RE RFI 254 - CCHMC Liberty [MN2PR19M]")).toBe(
      "RE RFI 254 - CCHMC Liberty",
    );
    expect(fileNameHint("2026-07-15 - Re [ZZ E2E PT-01] Change Order Request [MW4PR19M]")).toBe(
      "Re [ZZ E2E PT-01] Change Order Request",
    );
  });
});

describe("parsing a note", () => {
  it("finds the header, the three sections and the trailer", () => {
    const note = parseNote(NOTE);

    expect(note.title).toBe("NEEDS REVIEW — unmatched Change Order reply");
    expect(note.reason).toBe("unmatched Change Order reply");
    expect(note.receivedDate).toBe("2026-10-05");
    expect(note.from).toEqual({ name: "ZZ Tester", address: "zztest@example.invalid" });
    expect(note.subject).toBe("RE: ZZTEST RFI 999 - Example Site");
    expect(note.why).toMatch(/^The email is about ZZTEST RFI 999/);
    expect(note.why).toMatch(/matches no tracked CO\.$/);
    expect(note.wrote).toMatch(/^"Do we only put flex connections/);
    expect(note.nextStep).toMatch(/otherwise close\.$/);
    expect(note.classification).toBe("question");
    expect(note.confidence).toBe("high");
    // The whole note is always carried, verbatim.
    expect(note.text).toBe(NOTE);
  });

  it("does not let the trailer bleed into the last section", () => {
    const note = parseNote(NOTE);
    expect(note.nextStep).not.toContain("Classification:");
    expect(note.nextStep).not.toContain("Source:");
  });

  it("reads the other title the classifier writes, and a plain dash", () => {
    expect(parseNote("NEEDS REVIEW — not a Change Order response (no action expected)\n").reason).toBe(
      "not a Change Order response (no action expected)",
    );
    expect(parseNote("NEEDS REVIEW - something else\n").reason).toBe("something else");
  });

  it("strips a byte-order mark and accepts CRLF", () => {
    const note = parseNote("﻿" + NOTE.replace(/\n/g, "\r\n"));
    expect(note.title).toBe("NEEDS REVIEW — unmatched Change Order reply");
    expect(note.subject).toBe("RE: ZZTEST RFI 999 - Example Site");
    expect(note.wrote).toMatch(/^"Do we only/);
    expect(note.text.startsWith("﻿")).toBe(false);
  });

  /**
   * THE ONE THAT MATTERS for the count: a note that does not parse is still
   * a note. Its sections are null, its text is whole, and nothing throws.
   */
  it("keeps a note that follows no layout at all", () => {
    const note = parseNote("just some words somebody typed\nwith <b>markup</b> in them\n");
    expect(note.title).toBe("just some words somebody typed");
    expect(note.reason).toBeNull();
    expect(note.why).toBeNull();
    expect(note.wrote).toBeNull();
    expect(note.nextStep).toBeNull();
    expect(note.subject).toBeNull();
    expect(note.text).toContain("<b>markup</b>");
  });

  it("handles an empty note", () => {
    const note = parseNote("");
    expect(note.title).toBeNull();
    expect(note.text).toBe("");
  });

  it("reads the three shapes of a From line", () => {
    expect(parseNoteAddress("Mark Example <mark@example.invalid>")).toEqual({
      name: "Mark Example",
      address: "mark@example.invalid",
    });
    expect(parseNoteAddress("<mark@example.invalid>")).toEqual({ name: null, address: "mark@example.invalid" });
    expect(parseNoteAddress("mark@example.invalid")).toEqual({ name: null, address: "mark@example.invalid" });
    expect(parseNoteAddress("Mark Example")).toEqual({ name: "Mark Example", address: null });
    expect(parseNoteAddress("   ")).toBeNull();
  });
});

function note(overrides: Partial<ReviewNote> & { id: string }): ReviewNote {
  return {
    fileName: `NEEDS REVIEW - ${overrides.id}.txt`,
    itemId: overrides.id,
    fileDate: null,
    fileTime: null,
    fileMessageIdHint: null,
    sizeBytes: 100,
    lastModified: null,
    webUrl: null,
    hasItemFolder: false,
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
    text: "",
    ...overrides,
  };
}

describe("grouping by subject", () => {
  it("skips Exchange's reply and forward prefixes, repeatedly, and ignores case and spacing", () => {
    expect(subjectGroupKey("RE: Temp Lab - Site")).toBe("temp lab - site");
    expect(subjectGroupKey("FW: RE: Temp Lab - Site")).toBe("temp lab - site");
    expect(subjectGroupKey("Fwd: temp  lab -  site")).toBe("temp lab - site");
    expect(subjectGroupKey("Temp Lab - Site")).toBe("temp lab - site");
    expect(subjectGroupKey(null)).toBe("");
  });

  it("does not merge subjects that merely share a prefix", () => {
    expect(subjectGroupKey("RE: RFI 254 - Site")).not.toBe(subjectGroupKey("RE: RFI 255 - Site"));
  });

  it("survives a subject that is thousands of RE: prefixes", () => {
    const hostile = "RE: ".repeat(5000) + "x";
    expect(subjectGroupKey(hostile)).toBe("x");
  });

  it("groups the backlog's shape: three replies on one thread, two on another, one on its own", () => {
    const groups = groupNotes([
      note({ id: "a", subject: "RE: RFI 254 - Site", fileDate: "2026-10-05", fileTime: "11:01:19" }),
      note({ id: "b", subject: "RE: RFI 254 - Site", fileDate: "2026-10-05", fileTime: "12:51:21" }),
      note({ id: "c", subject: "RE: RFI 254 - Site", fileDate: "2026-10-05", fileTime: "11:36:46" }),
      note({ id: "d", subject: "RE: Temp Lab - Site", fileDate: "2026-10-05", fileTime: "20:20:30" }),
      note({ id: "e", subject: "RE: Temp Lab - Site", fileDate: "2026-10-06", fileTime: "11:23:31" }),
      note({ id: "f", subject: "Re: 2 of your flow(s) have failed", fileDate: "2026-08-18", fileTime: "19:27:02" }),
    ]);

    expect(groups.map((g) => [g.subject, g.notes.map((n) => n.id)])).toEqual([
      // Newest thread first; within a thread, newest note first.
      ["RE: Temp Lab - Site", ["e", "d"]],
      ["RE: RFI 254 - Site", ["b", "c", "a"]],
      ["Re: 2 of your flow(s) have failed", ["f"]],
    ]);
    expect(groups[0]).toMatchObject({ newestDate: "2026-10-06 11:23:31", oldestDate: "2026-10-05 20:20:30" });
  });

  it("falls back to the filename's hint for a note whose header did not parse", () => {
    const groups = groupNotes([
      note({ id: "2026-10-05 110119 - RE RFI 254 - Site [AB1CD23E]", subject: null, fileDate: "2026-10-05" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.subject).toBe("RE RFI 254 - Site");
  });

  it("lists an undated note last rather than dropping it", () => {
    const groups = groupNotes([
      note({ id: "undated", subject: "A" }),
      note({ id: "dated", subject: "B", fileDate: "2026-10-01" }),
    ]);
    expect(groups.map((g) => g.subject)).toEqual(["B", "A"]);
    expect(groups[1]!.newestDate).toBeNull();
  });
});

describe("the count", () => {
  it("is the number of notes, with the oldest and newest dates from their filenames", () => {
    expect(
      summarise([
        { fileDate: "2026-10-05", fileTime: "11:01:19" },
        { fileDate: "2026-08-18", fileTime: null },
        { fileDate: null, fileTime: null },
      ]),
    ).toEqual({ count: 3, oldestDate: "2026-08-18", newestDate: "2026-10-05" });
  });

  it("is zero with no dates for an empty folder", () => {
    expect(summarise([])).toEqual({ count: 0, oldestDate: null, newestDate: null });
  });
});
