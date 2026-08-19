import { Parser } from "htmlparser2";

/**
 * Text-only editing of a message body, without re-emitting its markup.
 *
 * The problem this solves, measured against the real mailbox: a "New CO logged"
 * draft is ~1.3-4KB of Outlook HTML carrying one table, 12-28 style attributes
 * and a <style> block. Sanitizing it - which is what makes it safe to RENDER -
 * discards 59-83% of those bytes, including the grey header row and Calibri 11pt
 * on every cell. Editing the sanitized copy and saving it back would send the
 * vendor a visibly degraded message.
 *
 * So nothing here re-serializes anything. The parser reports the exact source
 * range of every text node; edits are spliced into the ORIGINAL string at those
 * ranges. Every byte outside an edited range is preserved by construction rather
 * than by careful round-tripping - the table's style attributes, the <style>
 * block, dir="ltr", Outlook's wrapper, the CRLFs, all of it.
 *
 * The cost is that this edits text, not structure. No new rows, no formatting
 * changes. That matches the actual job - read a draft, fix a date or a sentence,
 * send - and the source escape hatch covers the rest.
 */

/** Text inside these is markup or metadata, never message content. */
const NON_CONTENT_ELEMENTS = new Set([
  "script",
  "style",
  "title",
  "head",
  "noscript",
  "template",
]);

/**
 * How a field is labelled, most useful first.
 *
 * Order, not nesting depth. Outlook writes a table cell as
 * `<td><p>value</p></td>`, so taking the innermost label called every cell of
 * an automation table a "paragraph" - true, and useless for reviewing which
 * value you are changing. A cell is a cell however it is wrapped.
 *
 * A link beats a cell because editing link text changes what is displayed and
 * not where it points, which is worth knowing before typing.
 */
const CONTEXT_PRIORITY: { tag: string; label: string }[] = [
  { tag: "a", label: "link text" },
  { tag: "th", label: "table heading" },
  { tag: "td", label: "table cell" },
  { tag: "li", label: "list item" },
  { tag: "h1", label: "heading" },
  { tag: "h2", label: "heading" },
  { tag: "h3", label: "heading" },
  { tag: "h4", label: "heading" },
  { tag: "blockquote", label: "quote" },
  { tag: "p", label: "paragraph" },
];

export interface BodySegment {
  /** Stable for a given input string. Not meaningful across different bodies. */
  id: string;
  /** Inclusive source range. `raw.slice(start, end + 1)` is the exact original. */
  start: number;
  end: number;
  /** Entity-decoded, for display and editing. */
  text: string;
  /** e.g. "table cell". For labelling the field. */
  context: string;
}

interface TextRun {
  start: number;
  end: number;
  text: string;
  context: string;
}

/**
 * Every run of editable text in the body, in document order.
 *
 * htmlparser2 emits a separate text event per entity - "Tom ", "&", " Jerry " -
 * each with its own source range, so contiguous events are merged back into one
 * logical run. Merging only happens when the ranges actually touch, so a comment
 * or element between two texts keeps them separate.
 */
export function extractBodySegments(rawHtml: string): BodySegment[] {
  const runs: TextRun[] = [];
  const stack: string[] = [];
  let suppressDepth = 0;

  const parser: Parser = new Parser(
    {
      onopentagname(name) {
        stack.push(name);
        if (NON_CONTENT_ELEMENTS.has(name)) suppressDepth += 1;
      },
      onclosetag(name) {
        if (NON_CONTENT_ELEMENTS.has(name) && suppressDepth > 0) suppressDepth -= 1;
        const at = stack.lastIndexOf(name);
        if (at !== -1) stack.length = at;
      },
      ontext(text) {
        if (suppressDepth > 0) return;

        const start = parser.startIndex;
        const end = parser.endIndex;
        if (start < 0 || end < start) return;

        const previous = runs[runs.length - 1];
        if (previous !== undefined && previous.end + 1 === start) {
          previous.end = end;
          previous.text += text;
          return;
        }

        runs.push({ start, end, text, context: contextFor(stack) });
      },
    },
    // decodeEntities gives the editor readable text; the original bytes are
    // recovered from the source range, never re-encoded. The Parser tracks
    // startIndex/endIndex unconditionally - the withStartIndices/withEndIndices
    // options belong to DomHandler, which is not used here.
    { decodeEntities: true },
  );

  parser.write(rawHtml);
  parser.end();

  return runs
    // Whitespace between tags is layout, not content. Never offered for editing,
    // and therefore never rewritten.
    .filter((run) => run.text.trim().length > 0)
    .map((run, index) => ({
      id: `s${index}`,
      start: run.start,
      end: run.end,
      text: run.text,
      context: run.context,
    }));
}

function contextFor(stack: string[]): string {
  for (const { tag, label } of CONTEXT_PRIORITY) {
    if (stack.includes(tag)) return label;
  }
  return "text";
}

/**
 * Encodes text a person typed so it cannot become markup.
 *
 * &, < and > because they are markup. Quotes are left alone - they cannot
 * terminate anything in text content.
 *
 * A non-breaking space becomes `&nbsp;` rather than being written as a literal
 * U+00A0, for two reasons found by writing to the real mailbox. Exchange stores
 * a literal U+00A0 as `&nbsp;` anyway, so emitting the character meant what we
 * intended and what was stored differed by five bytes on every edit touching
 * one. And a literal non-breaking space is invisible in a diff and in an editor
 * field, where it reads as an ordinary space it is not.
 *
 * Other non-ASCII characters are left as UTF-8: the body declares that charset
 * and Exchange round-trips them unchanged.
 */
function encodeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\u00a0/g, "&nbsp;");
}

export interface BodyEdit {
  id: string;
  text: string;
}

/**
 * Splices edited text back into the original string.
 *
 * Applied from the end so earlier offsets stay valid. A segment whose text is
 * unchanged is written back as its ORIGINAL bytes rather than re-encoded, so
 * entity spellings the editor never touched - `&nbsp;` versus a literal space,
 * `&#39;` versus `&apos;` - survive exactly. Only genuinely edited text is
 * re-encoded, and only within its own range.
 */
export function applyBodyEdits(
  rawHtml: string,
  segments: BodySegment[],
  edits: BodyEdit[],
): string {
  if (edits.length === 0) return rawHtml;

  const byId = new Map(segments.map((segment) => [segment.id, segment]));

  const applicable = edits
    .map((edit) => ({ edit, segment: byId.get(edit.id) }))
    .filter(
      (pair): pair is { edit: BodyEdit; segment: BodySegment } =>
        pair.segment !== undefined,
    )
    .sort((a, b) => b.segment.start - a.segment.start);

  let result = rawHtml;
  for (const { edit, segment } of applicable) {
    const original = rawHtml.slice(segment.start, segment.end + 1);
    const replacement =
      edit.text === segment.text ? original : encodeText(edit.text);

    result =
      result.slice(0, segment.start) + replacement + result.slice(segment.end + 1);
  }

  return result;
}

/**
 * Appends a paragraph immediately before </body>, for the note someone wants to
 * add without touching the automation's structure.
 *
 * Everything already in the body is untouched: this is an insertion at one
 * offset, not a rewrite.
 */
export function appendParagraph(rawHtml: string, text: string): string {
  const paragraph = `<p>${encodeText(text)}</p>`;
  const closing = rawHtml.toLowerCase().lastIndexOf("</body>");

  if (closing === -1) return rawHtml + paragraph;
  return rawHtml.slice(0, closing) + paragraph + rawHtml.slice(closing);
}
