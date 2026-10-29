import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
  chunkPages,
  chunkSections,
  chunkSheetRows,
  cleanText,
  visibleLength,
  type KbChunkDraft,
  type KbPage,
  type KbSection,
  type KbSheetRow,
} from "./chunk";

/**
 * Reads a document on disk into passages with locations. One reader per file
 * type, chosen by kb_documents.file_type (scope.ts decides which types reach
 * here):
 *
 *   pdf        per page, with pdfjs (no native dependency, runs the same on
 *              Windows and in the container)
 *   docx       per heading, with mammoth (Word's own Heading styles)
 *   md, txt    per Markdown heading; a .txt file is one section
 *   xlsx, xlsm per sheet and row, with exceljs, citing cell ranges
 *
 * `empty: true` means the file read cleanly and held no text worth indexing,
 * e.g. a scanned PDF with no text layer. The indexer records it as skipped
 * `empty_text`; it is not an error.
 */

export type KbExtraction = { empty: true } | { empty: false; chunks: KbChunkDraft[] };

/** Below this many non-space characters a document is treated as empty. */
export const KB_MIN_VISIBLE_CHARS = 20;

export class KbUnsupportedTypeError extends Error {
  constructor(readonly fileType: string) {
    super(`No reader for .${fileType} files.`);
    this.name = "KbUnsupportedTypeError";
  }
}

export async function extractDocument(filePath: string, fileType: string): Promise<KbExtraction> {
  switch (fileType) {
    case "pdf":
      return finish(chunkPages(await readPdfPages(filePath)));
    case "docx":
      return finish(chunkSections(await readDocxSections(filePath)));
    case "md":
      return finish(chunkSections(markdownSections(await readFile(filePath, "utf8"))));
    case "txt":
      return finish(chunkSections([{ section: null, text: await readFile(filePath, "utf8") }]));
    case "xlsx":
    case "xlsm":
      return finish(chunkSheetRows(await readWorkbookRows(filePath)));
    default:
      throw new KbUnsupportedTypeError(fileType);
  }
}

function finish(chunks: KbChunkDraft[]): KbExtraction {
  const visible = chunks.reduce((n, c) => n + visibleLength(c.content), 0);
  return visible < KB_MIN_VISIBLE_CHARS ? { empty: true } : { empty: false, chunks };
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

type TextItem = { str: string; hasEOL?: boolean };

/**
 * pdfjs's metrics for the 14 standard PDF fonts, for files that use one
 * without embedding it. Resolved from the installed package, not a URL.
 */
function standardFontDataUrl(): string {
  const require = createRequire(path.join(process.cwd(), "package.json"));
  return path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + path.sep;
}

export async function readPdfPages(filePath: string): Promise<KbPage[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await readFile(filePath));
  const task = pdfjs.getDocument({
    data,
    // Text only: never evaluate PDF-supplied code, never load fonts or images.
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: standardFontDataUrl(),
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    const pages: KbPage[] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items as TextItem[]) {
        if (typeof item.str !== "string") continue;
        text += item.str;
        text += item.hasEOL ? "\n" : item.str.length > 0 && !item.str.endsWith(" ") ? " " : "";
      }
      page.cleanup();
      pages.push({ page: n, text: cleanText(text) });
    }
    return dropRunningHeaders(pages);
  } finally {
    await doc.destroy();
  }
}

/**
 * Lines repeated on most pages (a spec's project block, a vendor's letterhead)
 * match every question about the project and answer none. A line of at least
 * 12 characters found on 60% or more of the pages of a document of 5 pages or
 * more is kept on the first page it appears on and dropped from the rest.
 */
export function dropRunningHeaders(pages: KbPage[]): KbPage[] {
  if (pages.length < 5) return pages;
  const seen = new Map<string, number>();
  for (const p of pages) {
    for (const line of new Set(p.text.split("\n"))) {
      if (line.length >= 12) seen.set(line, (seen.get(line) ?? 0) + 1);
    }
  }
  const repeated = new Set([...seen].filter(([, n]) => n >= pages.length * 0.6).map(([line]) => line));
  if (repeated.size === 0) return pages;
  const kept = new Set<string>();
  return pages.map((p) => ({
    page: p.page,
    text: p.text
      .split("\n")
      .filter((line) => {
        if (!repeated.has(line)) return true;
        if (kept.has(line)) return false;
        kept.add(line);
        return true;
      })
      .join("\n"),
  }));
}

// ---------------------------------------------------------------------------
// Word
// ---------------------------------------------------------------------------

/** Heading path kept on a passage, e.g. "Part 2 - Products > 2.3 Fans". */
const SECTION_MAX = 300;

export async function readDocxSections(filePath: string): Promise<KbSection[]> {
  const mammoth = await import("mammoth");
  const { value: html } = await mammoth.convertToHtml({ path: filePath });
  return htmlSections(html);
}

/**
 * mammoth's HTML is simple and well formed: headings, paragraphs, lists and
 * tables. Split on headings, keep the heading path, flatten the rest to text
 * with table cells separated by " | ".
 */
export function htmlSections(html: string): KbSection[] {
  const sections: KbSection[] = [];
  const path: string[] = [];
  let current: KbSection = { section: null, text: "" };
  const parts = html.split(/(<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>)/i);
  for (const part of parts) {
    const heading = /^<h([1-6])[^>]*>([\s\S]*?)<\/h[1-6]>$/i.exec(part);
    if (heading) {
      if (cleanText(current.text)) sections.push(current);
      const level = Number(heading[1]);
      path.length = level - 1;
      path[level - 1] = htmlToText(heading[2] ?? "");
      const name = path.filter(Boolean).join(" > ");
      current = { section: name.slice(0, SECTION_MAX) || null, text: "" };
    } else {
      current.text += htmlToText(part);
    }
  }
  if (cleanText(current.text)) sections.push(current);
  return sections;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function htmlToText(html: string): string {
  return html
    // A cell's own paragraphs are one value: joined with spaces, ended by a bar.
    .replace(/<t([dh])\b[^>]*>([\s\S]*?)<\/t\1>/gi, (_m, _t, inner: string) =>
      `${inner.replace(/<\/p>\s*<p\b[^>]*>/gi, " ").replace(/<\/?p\b[^>]*>/gi, "")} | `,
    )
    .replace(/<\/(p|li|tr|table|h[1-6])>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
      if (code.startsWith("#")) {
        const point = /^#x/i.test(code) ? parseInt(code.slice(2), 16) : Number(code.slice(1));
        return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : " ";
      }
      return ENTITIES[code.toLowerCase()] ?? whole;
    })
    .replace(/ \| \n/g, "\n");
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

export function markdownSections(text: string): KbSection[] {
  const sections: KbSection[] = [];
  const path: string[] = [];
  let current: KbSection = { section: null, text: "" };
  let fenced = false;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      if (cleanText(current.text)) sections.push(current);
      const level = heading[1]!.length;
      path.length = level - 1;
      path[level - 1] = heading[2] ?? "";
      current = { section: path.filter(Boolean).join(" > ").slice(0, SECTION_MAX) || null, text: "" };
    } else {
      current.text += `${line}\n`;
    }
  }
  if (cleanText(current.text)) sections.push(current);
  return sections;
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

/**
 * Every row with a value, as text. A header row (the first row of at least
 * three text cells, none of them a "Label:" of a form) names the columns
 * below it, so a row reads "Equipment: AHU-1 | CFM: 12000" rather than
 * "AHU-1 | 12000".
 * Formulas give their last calculated value, as Excel saved it. Hidden
 * sheets are read; "very hidden" ones (macro plumbing) are not.
 *
 * Estimate templates carry thousands of pre-formulated rows that compute to
 * zero. A formula whose saved result is zero or blank says nothing and is
 * left out, and so is a row of numbers with at most one that is not zero
 * (a line number beside empty totals). A merged range is read once.
 */
export async function readWorkbookRows(filePath: string): Promise<KbSheetRow[]> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  const bytes = await withoutVmlDrawings(await readFile(filePath));
  // exceljs types `Buffer` against an older @types/node; the bytes are the same.
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  const rows: KbSheetRow[] = [];
  for (const sheet of workbook.worksheets) {
    if (sheet.state === "veryHidden") continue;
    let headers: Map<number, string> | null = null;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells: { col: number; text: string; isText: boolean }[] = [];
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        if (cell.isMerged && cell.master.address !== cell.address) return;
        if (isEmptyFormula(cell.value)) return;
        const text = cellText(cell.value);
        if (text !== "") cells.push({ col, text, isText: isTextValue(cell.value) });
      });
      if (cells.length === 0) return;
      const numeric = (c: { text: string; isText: boolean }) => !c.isText || NUMBER.test(c.text);
      if (cells.every(numeric) && cells.filter((c) => Number(c.text) !== 0).length <= 1) return;

      if (
        headers === null &&
        cells.length >= 3 &&
        cells.every((c) => c.isText && !numeric(c) && !c.text.endsWith(":"))
      ) {
        headers = new Map(cells.map((c) => [c.col, c.text]));
        rows.push(rowOf(sheet.name, rowNumber, cells, cells.map((c) => c.text).join(" | ")));
        return;
      }
      const named = headers;
      const text = cells
        .map((c) => {
          const name = named?.get(c.col);
          return name ? `${name}: ${c.text}` : c.text;
        })
        .join(" | ");
      rows.push(rowOf(sheet.name, rowNumber, cells, text));
    });
  }
  return rows;
}

function rowOf(sheet: string, row: number, cells: { col: number }[], text: string): KbSheetRow {
  const cols = cells.map((c) => c.col);
  return { sheet, row, minCol: Math.min(...cols), maxCol: Math.max(...cols), text };
}

/**
 * Legacy VML drawings (cell comments, form-control buttons on macro
 * workbooks) are HTML-flavoured and not always well-formed XML; Excel
 * tolerates them and exceljs does not ("unexpected close tag"). They hold no
 * cell values, so they are removed before the workbook is parsed.
 */
async function withoutVmlDrawings(bytes: Buffer): Promise<Buffer> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  const vml = Object.keys(zip.files).filter((name) => /\.vml$/i.test(name));
  if (vml.length === 0) return bytes;
  for (const name of vml) zip.remove(name);
  return zip.generateAsync({ type: "nodebuffer" });
}

const NUMBER = /^-?[\d,]*\.?\d+$/;

function isEmptyFormula(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (!("formula" in v) && !("sharedFormula" in v)) return false;
  return v.result === undefined || v.result === null || v.result === 0 || v.result === "";
}

function isTextValue(value: unknown): boolean {
  if (typeof value === "string") return true;
  if (value !== null && typeof value === "object" && "richText" in value) return true;
  return false;
}

/** A cell's value as a person would read it, or "" for nothing worth indexing. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return cleanText(value).replace(/\n+/g, " ");
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.richText)) {
      return cellText((v.richText as { text?: string }[]).map((r) => r.text ?? "").join(""));
    }
    if ("result" in v) return cellText(v.result); // formula: the saved result
    if ("error" in v) return ""; // #REF!, #DIV/0!
    if (typeof v.text === "string") return cellText(v.text); // hyperlink
  }
  return "";
}
