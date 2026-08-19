import { describe, expect, it } from "vitest";
import {
  appendParagraph,
  applyBodyEdits,
  extractBodySegments,
} from "@/lib/modules/change-orders/mail/body-text";

/**
 * Text-only body editing.
 *
 * The fixtures below are SYNTHETIC, reproducing the shapes measured in the real
 * mailbox - Outlook's wrapper, a <style> block, a bordered table whose formatting
 * lives entirely in style attributes, entities, CRLFs. Real bodies are not
 * committed: CLAUDE.md forbids persisting message content anywhere, and a test
 * fixture is persistence.
 *
 * The same properties were run against nine real bodies as a one-off gate before
 * any of this shipped - six sent automation messages, the ZZTEST draft, and two
 * drafts in the bin. All byte-identical.
 */

/** The real automation table, structure and styling preserved, text replaced. */
const AUTOMATION_BODY =
  `<html><head>\r\n<meta http-equiv="Content-Type" content="text/html; charset=utf-8">` +
  `<style type="text/css" style="display:none">\r\n<!--\r\np\r\n\t{margin-top:0;\r\n\tmargin-bottom:0}\r\n-->\r\n</style>` +
  `</head><body dir="ltr"><div class="elementToProof">A change order was logged.</div>` +
  `<table cellspacing="0" cellpadding="6" border="1" class="elementToProof"` +
  ` style="border-collapse:collapse; border-spacing:0px; box-sizing:border-box"><tbody>` +
  `<tr style="background-color:rgb(242,242,242)">` +
  `<th><div style="font-family:Calibri,Arial,sans-serif; font-size:11pt">Estimate Name</div></th>` +
  `<th><div style="font-family:Calibri,Arial,sans-serif; font-size:11pt">Due Date</div></th></tr>` +
  `<tr><td><div style="font-family:Calibri,Arial,sans-serif; font-size:11pt">Example Project</div></td>` +
  `<td><div style="font-family:Calibri,Arial,sans-serif; font-size:11pt">07/30/2026</div></td></tr>` +
  `</tbody></table><p>Regards &amp; thanks,&nbsp;the team</p></body></html>`;

describe("extracting editable text", () => {
  it("finds the message text and nothing else", () => {
    const segments = extractBodySegments(AUTOMATION_BODY);
    const texts = segments.map((s) => s.text);

    expect(texts).toContain("A change order was logged.");
    expect(texts).toContain("Estimate Name");
    expect(texts).toContain("07/30/2026");

    // The <style> block's CSS is markup, not content, and must never be offered
    // for editing - or a reviewer could break the message's formatting while
    // "fixing a sentence".
    expect(texts.join(" ")).not.toContain("margin-top");
    expect(texts.join(" ")).not.toContain("text/css");
  });

  it("labels a field with where it lives, so it can be reviewed in context", () => {
    const segments = extractBodySegments(AUTOMATION_BODY);

    expect(segments.find((s) => s.text === "Due Date")?.context).toBe("table heading");
    expect(segments.find((s) => s.text === "07/30/2026")?.context).toBe("table cell");
  });

  it("calls a table cell a table cell even when Outlook wraps it in a <p>", () => {
    // Found against the real draft. Outlook writes a pasted table cell as
    // `<td><p>value</p></td>`, so taking the innermost label called all eight
    // cells of the automation table "paragraph" - true, and useless when the
    // point of the labels is knowing which value you are about to change.
    const body =
      '<table><tr><td><p>CCHMC Liberty Expansion</p></td>' +
      '<td><p><a href="https://example.invalid">the link</a></p></td></tr></table>';

    const segments = extractBodySegments(body);

    expect(segments.find((x) => x.text === "CCHMC Liberty Expansion")?.context).toBe(
      "table cell",
    );
    // A link inside a cell is labelled as a link: editing it changes the text
    // shown, not where it points.
    expect(segments.find((x) => x.text === "the link")?.context).toBe("link text");
  });

  it("labels a heading cell as a heading", () => {
    const segments = extractBodySegments("<table><tr><th><p>Due Date</p></th></tr></table>");

    expect(segments[0]?.context).toBe("table heading");
  });
  it("merges entities back into one readable run", () => {
    const segments = extractBodySegments(AUTOMATION_BODY);
    const closing = segments.find((s) => s.text.startsWith("Regards"));

    // The parser reports "Regards ", "&", " thanks,", " ", "the team" as
    // separate events. A person should see one field.
    expect(closing?.text).toBe("Regards & thanks, the team");
  });

  it("skips whitespace between tags", () => {
    const segments = extractBodySegments("<p>real</p>\r\n  \t<p>also real</p>");

    expect(segments.map((s) => s.text)).toEqual(["real", "also real"]);
  });

  it("records a source range that is exactly the original bytes", () => {
    for (const segment of extractBodySegments(AUTOMATION_BODY)) {
      const slice = AUTOMATION_BODY.slice(segment.start, segment.end + 1);
      expect(slice.length).toBeGreaterThan(0);
      // The slice is the encoded source; decoding it yields the segment text.
      expect(slice.replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")).toBe(segment.text);
    }
  });
});

describe("the byte-identical guarantee", () => {
  const BODIES = [
    AUTOMATION_BODY,
    "<html><body><p>plain</p></body></html>",
    "<p>entities &amp; &nbsp; &lt;kept&gt;</p>",
    '<body dir="ltr">\r\n<div>CRLF\r\nacross lines</div>\r\n</body>',
    '<table border="1"><tr><td>only a table</td></tr></table>',
    "",
  ];

  it("no edits changes nothing", () => {
    for (const body of BODIES) {
      expect(applyBodyEdits(body, extractBodySegments(body), [])).toBe(body);
    }
  });

  it("rewriting every segment with its own text changes nothing", () => {
    // The real proof: it exercises the splice on every range at once.
    for (const body of BODIES) {
      const segments = extractBodySegments(body);
      const selfEdits = segments.map((s) => ({ id: s.id, text: s.text }));

      expect(applyBodyEdits(body, segments, selfEdits)).toBe(body);
    }
  });

  it("an untouched entity keeps its exact spelling", () => {
    const body = "<p>a &nbsp; b &#39;c&#39; &amp; d</p>";
    const segments = extractBodySegments(body);
    const selfEdits = segments.map((s) => ({ id: s.id, text: s.text }));

    // Re-encoding would turn &nbsp; into a literal space and &#39; into a bare
    // quote. Unchanged segments are written back as their original bytes, so the
    // spelling survives.
    expect(applyBodyEdits(body, segments, selfEdits)).toBe(body);
  });

  it("editing one segment leaves every other byte alone", () => {
    const segments = extractBodySegments(AUTOMATION_BODY);
    const dueDate = segments.find((s) => s.text === "07/30/2026");
    expect(dueDate).toBeDefined();

    const edited = applyBodyEdits(AUTOMATION_BODY, segments, [
      { id: dueDate!.id, text: "08/15/2026" },
    ]);

    expect(edited).toContain("08/15/2026");
    expect(edited).not.toContain("07/30/2026");
    expect(edited.slice(0, dueDate!.start)).toBe(AUTOMATION_BODY.slice(0, dueDate!.start));
    expect(edited.slice(dueDate!.start + "08/15/2026".length)).toBe(
      AUTOMATION_BODY.slice(dueDate!.end + 1),
    );
  });

  it("keeps everything sanitizing would have destroyed", () => {
    const segments = extractBodySegments(AUTOMATION_BODY);
    const edited = applyBodyEdits(AUTOMATION_BODY, segments, [
      { id: segments[0]!.id, text: "Edited." },
    ]);

    // Measured against the real mailbox: sanitizing keeps 0 of 12-28 style
    // attributes and 0 of 6 <style> blocks. This is what that would cost a
    // vendor - the grey header row and Calibri 11pt in every cell.
    expect(edited).toContain('style="background-color:rgb(242,242,242)"');
    expect(edited).toContain("font-family:Calibri,Arial,sans-serif");
    expect(edited).toContain("border-collapse:collapse");
    expect(edited).toContain('<style type="text/css"');
    expect(edited).toContain('dir="ltr"');
    expect(edited).toContain('class="elementToProof"');
    // And the table is still a table.
    expect((edited.match(/<td/g) ?? []).length).toBe(2);
  });

  it("applies several edits without disturbing each other's offsets", () => {
    const segments = extractBodySegments(AUTOMATION_BODY);
    const heading = segments.find((s) => s.text === "Estimate Name")!;
    const dueDate = segments.find((s) => s.text === "07/30/2026")!;

    const edited = applyBodyEdits(AUTOMATION_BODY, segments, [
      { id: heading.id, text: "Project" },
      { id: dueDate.id, text: "A much longer replacement value" },
    ]);

    expect(edited).toContain(">Project</div>");
    expect(edited).toContain("A much longer replacement value");
    expect(edited).toContain("border-collapse:collapse");
    expect((edited.match(/<td/g) ?? []).length).toBe(2);
  });

  it("encodes text a person types, so it cannot become markup", () => {
    const body = "<p>safe</p>";
    const segments = extractBodySegments(body);

    const edited = applyBodyEdits(body, segments, [
      { id: segments[0]!.id, text: "<script>alert(1)</script> & <b>bold</b>" },
    ]);

    expect(edited).not.toContain("<script>");
    expect(edited).toContain("&lt;script&gt;");
    expect(edited).toContain("&amp;");
  });

  it("re-encodes a non-breaking space, because Exchange does", () => {
    // Found by writing to the real mailbox. A literal U+00A0 is stored by
    // Exchange as `&nbsp;`, so emitting the character meant what we intended and
    // what was stored differed by five bytes on every edit touching one. It is
    // also invisible in an editor field, where it reads as a space it is not.
    const body = "<p>before</p>";
    const segments = extractBodySegments(body);

    const edited = applyBodyEdits(body, segments, [
      { id: segments[0]!.id, text: "a b" },
    ]);

    expect(edited).toBe("<p>a&nbsp;b</p>");
    expect(edited).not.toContain(" ");
  });

  it("leaves other non-ASCII alone, which Exchange round-trips as UTF-8", () => {
    const body = "<p>before</p>";
    const segments = extractBodySegments(body);

    const edited = applyBodyEdits(body, segments, [
      { id: segments[0]!.id, text: "Due — café" },
    ]);

    expect(edited).toBe("<p>Due — café</p>");
  });
  it("ignores an edit naming a segment that does not exist", () => {
    const segments = extractBodySegments(AUTOMATION_BODY);

    expect(applyBodyEdits(AUTOMATION_BODY, segments, [{ id: "s999", text: "x" }])).toBe(
      AUTOMATION_BODY,
    );
  });
});

describe("appending a note", () => {
  it("inserts before the closing body tag and touches nothing else", () => {
    const appended = appendParagraph(AUTOMATION_BODY, "Please confirm by Friday.");

    expect(appended).toContain("<p>Please confirm by Friday.</p></body>");
    expect(appended.slice(0, appended.indexOf("<p>Please confirm"))).toBe(
      AUTOMATION_BODY.slice(0, AUTOMATION_BODY.lastIndexOf("</body>")),
    );
  });

  it("encodes the note", () => {
    const appended = appendParagraph("<body>x</body>", "<img src=x onerror=alert(1)>");

    expect(appended).not.toContain("<img");
    expect(appended).toContain("&lt;img");
  });

  it("still appends when there is no body tag", () => {
    expect(appendParagraph("<p>fragment</p>", "note")).toBe("<p>fragment</p><p>note</p>");
  });
});
