import { describe, expect, it } from "vitest";
import { appendParagraph, extractBodySegments } from "@/lib/modules/change-orders/mail/body-text";

/**
 * Appending a paragraph is not idempotent, and that is the whole point of this
 * file.
 *
 * The editor used to send `appendNote` from its debounced autosave and clear the
 * field afterwards. Measured against the live mailbox, one sentence typed with
 * two pauses arrived as THREE paragraphs:
 *
 *   "Hello Joel,"              -> <p>Hello Joel,</p>
 *   " thanks for the pricing"  -> <p>Hello Joel,</p><p>thanks for the pricing</p>
 *   " on RFI 229."             -> ...three <p> elements
 *
 * From the reviewer's side it looked like the text jumping into a different box
 * mid-sentence, because each committed chunk came back as its own editable
 * segment while the note field emptied itself.
 *
 * The fix is in the editor, not here: `appendNote` is now only sent when a
 * person clicks "Add this paragraph", or as part of the flush immediately before
 * a send. Both are single actions. These tests pin down the underlying operation
 * so the reason it must not be repeated stays visible.
 */

const EMPTY_HTML = "";

/** What Exchange stores after the first append into an empty draft. */
const NORMALISED =
  '<html><head>\n<meta http-equiv="Content-Type" content="text/html; charset=utf-8">' +
  "</head><body><p>Hello Joel,</p></body></html>";

describe("appending a paragraph", () => {
  it("appends once per call - repeating it fragments the sentence", () => {
    // The exact sequence the old autosave produced, verified live.
    let body: string = EMPTY_HTML;
    for (const chunk of ["Hello Joel,", " thanks for the pricing", " on RFI 229."]) {
      body = appendParagraph(body, chunk);
    }

    expect((body.match(/<p>/g) ?? []).length).toBe(3);

    // And the editor would then show three separate fields for what the person
    // typed as one sentence.
    expect(extractBodySegments(body)).toHaveLength(3);
  });

  it("produces one paragraph when called once, however long the text", () => {
    const sentence = "Hello Joel, thanks for the pricing on RFI 229.";
    const body = appendParagraph(EMPTY_HTML, sentence);

    expect((body.match(/<p>/g) ?? []).length).toBe(1);

    const segments = extractBodySegments(body);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe(sentence);
  });

  it("inserts before </body> once Exchange has normalised the document", () => {
    /**
     * The first append into a genuinely empty body has no `</body>` to insert
     * before, so it returns a bare fragment - and Exchange wraps it into a full
     * document on write. Verified live. Every append after that therefore takes
     * the insert-before-closing-tag path, and both are exercised here.
     */
    const body = appendParagraph(NORMALISED, "A second paragraph.");

    expect(body).toContain("<p>Hello Joel,</p><p>A second paragraph.</p>");
    expect(body.endsWith("</body></html>")).toBe(true);
    // Exactly one closing body tag: the insert must not duplicate the document.
    expect((body.match(/<\/body>/g) ?? []).length).toBe(1);
  });

  it("leaves everything already in the body untouched", () => {
    // The reason the append path exists at all rather than rewriting the body:
    // an automation draft's table and its style attributes have to survive.
    const automation =
      '<html><body><table style="border-collapse:collapse">' +
      '<tr><td style="font-family:Calibri">RFI 229</td></tr></table></body></html>';

    const body = appendParagraph(automation, "Please confirm.");

    expect(body).toContain('<table style="border-collapse:collapse">');
    expect(body).toContain('<td style="font-family:Calibri">RFI 229</td>');
    expect(body).toContain("<p>Please confirm.</p>");
  });

  it("encodes what a person typed so it cannot become markup", () => {
    const body = appendParagraph(EMPTY_HTML, '<script>alert(1)</script> & "quoted"');

    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
    expect(body).toContain("&amp;");
  });
});
