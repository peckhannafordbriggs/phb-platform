import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NoteView } from "@/app/(modules)/change-orders/review-workspace";
import { parseNote, type ReviewNote } from "@/lib/modules/change-orders/review/notes";

/**
 * A note renders as text, never as markup (decided 2026-10-21).
 *
 * A note is model-written prose derived from a vendor's email: whatever the
 * vendor wrote can end up quoted in WHAT THEY WROTE, and a model can be
 * talked into writing almost anything. So the note view is held to the same
 * standard as the reading pane, by rendering a hostile note and reading the
 * HTML back: the markup must be escaped, present as text, and inert.
 *
 * The mailbox's HTML sanitizer is deliberately NOT applied to a note. It is
 * an allowlist for markup, and a note is not markup - run through it, the
 * sentence "a < b" loses its tail. Escaping is the whole of the treatment.
 */

const HOSTILE = `NEEDS REVIEW — unmatched Change Order reply
============================================
Received: 2026-10-05
From:     <img src=x onerror="alert(1)"> <zz@example.invalid>
Subject:  RE: <script>alert("subject")</script> ZZTEST

WHY THIS NEEDS A HUMAN
The vendor wrote a < b and also </article><script>alert("why")</script>.

WHAT THEY WROTE
"<iframe src="https://evil.invalid"></iframe> and a javascript:alert(1) link"

SUGGESTED NEXT STEP
Close it. <style>body{display:none}</style>

Classification: other (high confidence)   ·   Item: x
`;

function render(text: string, overrides: Partial<ReviewNote> = {}): string {
  const note: ReviewNote = {
    id: "id-1",
    fileName: "NEEDS REVIEW - 2026-10-05 110119 - RE ZZTEST [AB1CD23E].txt",
    itemId: "2026-10-05 110119 - RE ZZTEST [AB1CD23E]",
    fileDate: "2026-10-05",
    fileTime: "11:01:19",
    fileMessageIdHint: "AB1CD23E",
    sizeBytes: text.length,
    lastModified: null,
    webUrl: 'https://example.invalid/x"><script>alert(2)</script>',
    hasItemFolder: false,
    ...parseNote(text),
    ...overrides,
  };
  return renderToStaticMarkup(createElement(NoteView, { note }));
}

describe("a note is escaped text", () => {
  const html = render(HOSTILE);

  it("contains no element the note tried to inject", () => {
    for (const tag of ["<script", "<iframe", "<img", "<style"]) {
      expect(html).not.toContain(tag);
    }
    // No event-handler attribute inside any tag, and no javascript: href. The
    // strings themselves may appear - escaped, as the note's words.
    expect(html).not.toMatch(/<[^>]+\son\w+=/);
    expect(html).not.toMatch(/href="javascript:/);
    expect(html).toContain("onerror=&quot;alert(1)&quot;");
  });

  it("shows the note's words, including the brackets, as text", () => {
    expect(html).toContain("&lt;script&gt;alert(&quot;subject&quot;)&lt;/script&gt;");
    expect(html).toContain("a &lt; b");
    expect(html).toContain("&lt;iframe src=&quot;https://evil.invalid&quot;&gt;&lt;/iframe&gt;");
    expect(html).toContain("&lt;style&gt;body{display:none}&lt;/style&gt;");
  });

  it("does not let the note close the article and start its own markup", () => {
    // One opening and one closing <article>: the note's "</article>" is text.
    expect(html.match(/<article/g)).toHaveLength(1);
    expect(html.match(/<\/article>/g)).toHaveLength(1);
    expect(html).toContain("&lt;/article&gt;");
  });

  it("escapes the SharePoint link's URL rather than trusting it", () => {
    expect(html).not.toContain('"><script>');
    expect(html).toMatch(/href="https:\/\/example\.invalid\/x&quot;&gt;&lt;script&gt;/);
    expect(html).toMatch(/rel="noopener noreferrer"/);
  });

  it("renders the whole note verbatim, escaped, in the details block", () => {
    expect(html).toContain("<pre");
    expect(html).toContain("WHY THIS NEEDS A HUMAN");
    expect(html).not.toContain("<script>");
  });
});

describe("a note that did not parse", () => {
  it("is still shown whole, with a sentence saying its sections could not be picked out", () => {
    const html = render("nothing like the layout\n<b>bold</b>\n");
    expect(html).toContain("sections could not be picked out");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("Not stated in the note.");
  });
});

describe("what the note view says about its item folder", () => {
  it("names the folder beside the note when there is one, and the mailbox when there is not", () => {
    expect(render(HOSTILE, { hasItemFolder: true })).toContain("sits beside this note in SharePoint");
    expect(render(HOSTILE, { hasItemFolder: false })).toContain("the email is read from the mailbox below");
  });
});
