/**
 * Splits extracted text into passages: the unit that is embedded, searched
 * and cited. A passage never crosses a section or a sheet, and carries the
 * exact location it came from - a page range, a section heading, or a sheet
 * and cell range - so a citation can say where to look.
 *
 * Sizes are in characters, about four to a token. A passage aims at
 * KB_CHUNK_TARGET_CHARS and never exceeds KB_CHUNK_MAX_CHARS: small enough
 * that a citation points somewhere specific, large enough to hold a whole
 * spec paragraph or a submittal's line items.
 */

export const KB_CHUNK_TARGET_CHARS = 1800;
export const KB_CHUNK_MAX_CHARS = 2400;

/** A document that would produce more passages than this keeps the first ones only. */
export const KB_MAX_CHUNKS_PER_DOCUMENT = 4000;

export type KbChunkLocation = {
  pageStart: number | null;
  pageEnd: number | null;
  section: string | null;
  sheet: string | null;
  cellRange: string | null;
};

export type KbChunkDraft = KbChunkLocation & { content: string; tokenCount: number };

/** One PDF page, 1-based. */
export type KbPage = { page: number; text: string };

/** A stretch of text under one heading path (`null`: before any heading). */
export type KbSection = { section: string | null; text: string };

/** One spreadsheet row as text, with the columns it used (1-based). */
export type KbSheetRow = { sheet: string; row: number; minCol: number; maxCol: number; text: string };

/**
 * Text as stored: no NUL (PostgreSQL text cannot hold one), no carriage
 * returns, runs of spaces collapsed, at most one blank line in a row.
 */
export function cleanText(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Characters that are not whitespace: how "empty" is judged. */
export function visibleLength(text: string): number {
  return text.replace(/\s+/g, "").length;
}

/**
 * Pieces of at most `max` characters, cut at the largest boundary that works:
 * paragraph, then line, then sentence, then word, then anywhere.
 */
export function splitText(text: string, max = KB_CHUNK_MAX_CHARS): string[] {
  const clean = cleanText(text);
  if (clean.length === 0) return [];
  if (clean.length <= max) return [clean];
  const separators = [/\n\n/, /\n/, /(?<=[.!?;:])\s+/, /\s+/];
  return cut(clean, max, separators);
}

function cut(text: string, max: number, separators: RegExp[]): string[] {
  if (text.length <= max) return text.length > 0 ? [text] : [];
  const [separator, ...rest] = separators;
  if (separator === undefined) {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
    return out;
  }
  const parts = text.split(separator).map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length <= 1) return cut(text, max, rest);
  const joiner = separator.source === "\\n\\n" ? "\n\n" : separator.source === "\\n" ? "\n" : " ";
  const out: string[] = [];
  let current = "";
  for (const part of parts.flatMap((p) => cut(p, max, rest))) {
    const next = current ? `${current}${joiner}${part}` : part;
    if (next.length <= max) current = next;
    else {
      if (current) out.push(current);
      current = part;
    }
  }
  if (current) out.push(current);
  return out;
}

type Piece<L> = { text: string; loc: L };

/**
 * Packs pieces into passages up to the target size. `merge` widens a
 * passage's location to take the next piece, or returns null when the two
 * cannot share a passage (a different section or sheet).
 */
function pack<L>(pieces: Piece<L>[], merge: (a: L, b: L) => L | null): Piece<L>[] {
  const out: Piece<L>[] = [];
  let current: Piece<L> | null = null;
  for (const piece of pieces) {
    if (current !== null) {
      const loc = merge(current.loc, piece.loc);
      const text: string = `${current.text}\n\n${piece.text}`;
      if (loc !== null && text.length <= KB_CHUNK_TARGET_CHARS) {
        current = { text, loc };
        continue;
      }
      out.push(current);
    }
    current = piece;
  }
  if (current !== null) out.push(current);
  return out;
}

const NO_LOCATION: KbChunkLocation = { pageStart: null, pageEnd: null, section: null, sheet: null, cellRange: null };

function draft(content: string, loc: Partial<KbChunkLocation>): KbChunkDraft {
  return { ...NO_LOCATION, ...loc, content, tokenCount: Math.ceil(content.length / 4) };
}

/** PDF: passages may run across pages, and say which. */
export function chunkPages(pages: KbPage[]): KbChunkDraft[] {
  const pieces = pages.flatMap((p) =>
    splitText(p.text).map((text) => ({ text, loc: { start: p.page, end: p.page } })),
  );
  return cap(
    pack(pieces, (a, b) => ({ start: a.start, end: b.end })).map((p) =>
      draft(p.text, { pageStart: p.loc.start, pageEnd: p.loc.end }),
    ),
  );
}

/** Word, Markdown, text: passages stay inside one section. */
export function chunkSections(sections: KbSection[]): KbChunkDraft[] {
  const pieces = sections.flatMap((s) => splitText(s.text).map((text) => ({ text, loc: s.section })));
  return cap(
    pack(pieces, (a, b) => (a === b ? a : null)).map((p) => draft(p.text, { section: p.loc })),
  );
}

/** Excel: passages stay inside one sheet and name the cells they cover. */
export function chunkSheetRows(rows: KbSheetRow[]): KbChunkDraft[] {
  type Loc = { sheet: string; firstRow: number; lastRow: number; minCol: number; maxCol: number };
  const pieces: Piece<Loc>[] = rows.flatMap((r) =>
    splitText(r.text).map((text) => ({
      text,
      loc: { sheet: r.sheet, firstRow: r.row, lastRow: r.row, minCol: r.minCol, maxCol: r.maxCol },
    })),
  );
  const packed = pack(pieces, (a, b) =>
    a.sheet !== b.sheet
      ? null
      : {
          sheet: a.sheet,
          firstRow: Math.min(a.firstRow, b.firstRow),
          lastRow: Math.max(a.lastRow, b.lastRow),
          minCol: Math.min(a.minCol, b.minCol),
          maxCol: Math.max(a.maxCol, b.maxCol),
        },
  );
  return cap(
    packed.map((p) =>
      draft(p.text, {
        sheet: p.loc.sheet,
        cellRange: `${columnLetter(p.loc.minCol)}${p.loc.firstRow}:${columnLetter(p.loc.maxCol)}${p.loc.lastRow}`,
      }),
    ),
  );
}

/** 1 -> A, 27 -> AA. */
export function columnLetter(column: number): string {
  let n = column;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function cap(drafts: KbChunkDraft[]): KbChunkDraft[] {
  return drafts.length > KB_MAX_CHUNKS_PER_DOCUMENT ? drafts.slice(0, KB_MAX_CHUNKS_PER_DOCUMENT) : drafts;
}
