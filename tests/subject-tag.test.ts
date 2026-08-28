import { describe, expect, it } from "vitest";
import { splitSubjectTag } from "@/lib/modules/change-orders/mail/subject-tag";

/**
 * The project tag, pulled out of the subject for display.
 *
 * Every subject below is real, taken from changeorder@phb1899.com. The rule this
 * file exists to enforce is that the split is a VIEW and never an edit: docs/03
 * and CLAUDE.md both say the subject is preserved exactly, because downstream
 * filing depends on it and nothing may parse or regenerate it.
 */

describe("subjects that carry a tag", () => {
  it("splits the tag from a logged-CO subject", () => {
    const parts = splitSubjectTag(
      "[CCHMC RFI 229] New CO logged (Bid Tracker) — Due 08/25/2026",
    );

    expect(parts.tag).toBe("CCHMC RFI 229");
    expect(parts.rest).toBe("New CO logged (Bid Tracker) — Due 08/25/2026");
  });

  it("splits a bulletin subject", () => {
    const parts = splitSubjectTag(
      "[CCHMC Bulletin 12] Change Order Request — Additional Information Needed — CCHMC Liberty Expansion 226111",
    );

    expect(parts.tag).toBe("CCHMC Bulletin 12");
    expect(parts.rest).toContain("Change Order Request");
  });

  it("handles a tag with a comma and an ampersand in it", () => {
    // `P&G Permit Pack 4, Bulletin 4` is a real folder and a real tag.
    const parts = splitSubjectTag(
      "[P&G Permit Pack 4, Bulletin 4] New CO logged (Bid Tracker) — Due 07/10/2026",
    );

    expect(parts.tag).toBe("P&G Permit Pack 4, Bulletin 4");
  });

  it("keeps a reply prefix with the text rather than losing it", () => {
    const parts = splitSubjectTag(
      "RE: [CCHMC RFI 229] New CO logged (Bid Tracker) — Due 08/25/2026",
    );

    expect(parts.tag).toBe("CCHMC RFI 229");
    // A reply that stopped looking like a reply would be a worse row.
    expect(parts.rest).toBe("RE: New CO logged (Bid Tracker) — Due 08/25/2026");
  });

  it("handles a forwarded reply, which stacks two prefixes", () => {
    const parts = splitSubjectTag("FW: RE: [CCHMC Bulletin 13] Bulletin 13 - Liberty");

    expect(parts.tag).toBe("CCHMC Bulletin 13");
    expect(parts.rest).toBe("FW: RE: Bulletin 13 - Liberty");
  });

  it("finds a ZZTEST tag, since the fixtures use the same shape", () => {
    const parts = splitSubjectTag("[ZZTEST PR-91] New CO logged (Bid Tracker) — Due 08/14/2026");

    expect(parts.tag).toBe("ZZTEST PR-91");
  });
});

describe("subjects that carry no tag", () => {
  /**
   * Most of them. docs/03 is explicit that not every automation message has a
   * tag - the scope-request drafts start with a project name and no brackets -
   * so the untagged row is the common case, not the edge case.
   */
  it("leaves a scope-request subject whole", () => {
    const subject = "CCHMC Liberty Expansion — Change Order Scope Request — Due 08-11-2026";
    const parts = splitSubjectTag(subject);

    expect(parts.tag).toBeNull();
    expect(parts.rest).toBe(subject);
  });

  it("leaves a reply to an untagged subject whole", () => {
    const subject = "RE: CCHMC Liberty Expansion — Change Order Scope Request — Due 08-11-2026";
    const parts = splitSubjectTag(subject);

    expect(parts.tag).toBeNull();
    expect(parts.rest).toBe(subject);
  });

  it("leaves a bracket that is not at the front alone", () => {
    const subject = "Reminder — Change Order pricing due 08/25/2026 [CCHMC RFI 229]";
    const parts = splitSubjectTag(subject);

    expect(parts.tag).toBeNull();
    expect(parts.rest).toBe(subject);
  });

  it("handles a null subject", () => {
    expect(splitSubjectTag(null)).toEqual({ tag: null, rest: "" });
  });

  it("handles an empty subject", () => {
    expect(splitSubjectTag("")).toEqual({ tag: null, rest: "" });
  });
});

describe("things that look like a tag and are not", () => {
  it("refuses an unclosed bracket", () => {
    const subject = "[CCHMC RFI 229 New CO logged";
    expect(splitSubjectTag(subject)).toEqual({ tag: null, rest: subject });
  });

  it("refuses an empty bracket", () => {
    const subject = "[] New CO logged";
    expect(splitSubjectTag(subject)).toEqual({ tag: null, rest: subject });
  });

  it("refuses a bracketed sentence, which is prose rather than a label", () => {
    const subject =
      "[This is a very long parenthetical that somebody typed into the subject line] Pricing";
    expect(splitSubjectTag(subject).tag).toBeNull();
  });

  it("refuses a subject that is nothing but a tag", () => {
    // A chip with no text beside it reads as a bug rather than a short subject.
    const subject = "[CCHMC RFI 229]";
    expect(splitSubjectTag(subject)).toEqual({ tag: null, rest: subject });
  });
});

describe("the split never edits the subject", () => {
  /**
   * The property that matters most. `tag` and `rest` are two views of one
   * string; the original is what gets sent, saved and searched.
   */
  const SUBJECTS = [
    "[CCHMC RFI 229] New CO logged (Bid Tracker) — Due 08/25/2026",
    "RE: [CCHMC Bulletin 12] Change Order Request — Additional Information Needed",
    "CCHMC Liberty Expansion — Change Order Scope Request — Due 08-11-2026",
    "FW: RE: [CCHMC Bulletin 13] Bulletin 13 - Liberty",
    "[P&G Permit Pack 4, Bulletin 4] New CO logged (Bid Tracker) — Due 07/10/2026",
    "Reminder — Change Order pricing due 08/25/2026 — CCHMC RFI 229",
  ];

  it("loses no character other than the brackets and the space after them", () => {
    for (const subject of SUBJECTS) {
      const { tag, rest } = splitSubjectTag(subject);

      /**
       * Compared as a sorted multiset rather than by concatenation, because the
       * split legitimately REORDERS: a tag behind a `RE:` comes out in front of
       * it. Order is a display decision; losing or inventing a character is not,
       * and that is what this is checking.
       */
      const chars = (s: string) => s.replace(/[[\]\s]/g, "").split("").sort().join("");

      expect(chars((tag ?? "") + rest), subject).toBe(chars(subject));
    }
  });

  it("never invents a tag that is not in the subject", () => {
    for (const subject of SUBJECTS) {
      const { tag } = splitSubjectTag(subject);
      if (tag !== null) expect(subject).toContain(tag);
    }
  });

  it("is idempotent on its own output", () => {
    for (const subject of SUBJECTS) {
      const once = splitSubjectTag(subject);
      const twice = splitSubjectTag(once.rest);

      // `rest` has had its tag removed, so a second pass finds nothing more.
      expect(twice.tag).toBeNull();
    }
  });
});
