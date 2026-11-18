import { FORM_MARKER_FIELD, FORM_MARKER_VALUE, FORM_PRINTED_MARK } from "./form";
import type { PdfItem, PdfPage } from "./types";

/**
 * What an uploaded PDF is, and what is in it, with pdfjs-dist (Apache-2.0).
 *
 * Two kinds of file come through the import:
 *
 * - **The verification form** (form.ts): recognised by its hidden `fp_form`
 *   field, checked first and before any page text is read, so a form never
 *   reaches the schedule split. Its field values come back as plain strings.
 * - **A drawing set** with equipment schedules: text and positions, for split.ts.
 *
 * Server side only. The worker module is imported here and handed to pdfjs as
 * `globalThis.pdfjsWorker`, so it runs in-process (no worker thread, no file
 * path to resolve at run time) and the standalone build's file tracer sees a
 * literal import it can follow. The page's /Rotate is applied through the
 * viewport, so every item comes back in reading order: x right, y down.
 *
 * Text only, never pixels: a scanned set with no text layer comes back with no
 * items, and the caller says so instead of guessing.
 */

export const MAX_PDF_BYTES = 40 * 1024 * 1024;
export const MAX_PAGES = 60;

export class PdfReadError extends Error {
  constructor(
    public readonly code: "unreadable" | "too_many_pages" | "no_text" | "form_flattened" | "form_version",
    message: string,
  ) {
    super(message);
  }
}

export type PdfContents = { kind: "form"; fields: Record<string, string> } | { kind: "drawing"; pages: PdfPage[] };

type PdfDoc = Awaited<ReturnType<typeof import("pdfjs-dist/legacy/build/pdf.mjs").getDocument>["promise"]>;
type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

async function loadPdfjs(): Promise<Pdfjs> {
  const g = globalThis as { pdfjsWorker?: unknown };
  if (!g.pdfjsWorker) g.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

export async function readPdf(bytes: Uint8Array): Promise<PdfContents> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: bytes,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  let doc: PdfDoc;
  try {
    doc = await task.promise;
  } catch {
    await task.destroy();
    throw new PdfReadError("unreadable", "That file could not be read as a PDF.");
  }

  try {
    const fields = await formFields(doc);
    const marker = fields[FORM_MARKER_FIELD];
    if (marker === FORM_MARKER_VALUE) return { kind: "form", fields };
    if (marker !== undefined && marker.startsWith("phb-fp-form/")) {
      throw new PdfReadError("form_version", "That form is from another version of the platform. Download the current form from Import and copy the answers across.");
    }

    if (doc.numPages > MAX_PAGES) {
      throw new PdfReadError("too_many_pages", `That PDF has ${doc.numPages} pages. Upload only the schedule sheets (${MAX_PAGES} at most).`);
    }
    const pages: PdfPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) pages.push(await readPage(pdfjs, doc, n));

    // The form's printed mark without its fields: printed to PDF, flattened or
    // scanned with OCR. Its answers are pictures now, so say so rather than
    // feeding a form to the schedule reader.
    if (pages.some((p) => p.items.some((i) => i.s.includes(FORM_PRINTED_MARK)))) {
      throw new PdfReadError(
        "form_flattened",
        "That is the freeze protection form, but its fields were flattened (printed to PDF or scanned), so the answers cannot be read. Upload the saved form itself.",
      );
    }
    if (pages.every((p) => p.items.length < 20)) {
      throw new PdfReadError("no_text", "That PDF has no text layer (it looks scanned). Export the schedules from the drawing set as a PDF with text, or add the equipment by hand.");
    }
    return { kind: "drawing", pages };
  } finally {
    await task.destroy();
  }
}

/** A drawing set's pages. Kept for callers that only ever take schedules. */
export async function extractPdfPages(bytes: Uint8Array): Promise<PdfPage[]> {
  const contents = await readPdf(bytes);
  if (contents.kind === "form") throw new PdfReadError("unreadable", "That is the freeze protection form, not a drawing set.");
  return contents.pages;
}

/**
 * AcroForm values by field name, as strings. pdfjs gives a Map (v6) of arrays
 * of widgets; a combo box's value is its export value, sometimes as a
 * one-element array. Empty when the file has no form.
 */
async function formFields(doc: PdfDoc): Promise<Record<string, string>> {
  const raw = (await doc.getFieldObjects()) as Map<string, object[]> | Record<string, object[]> | null;
  if (raw === null) return {};
  const entries = raw instanceof Map ? [...raw.entries()] : Object.entries(raw);
  const out: Record<string, string> = {};
  for (const [name, widgets] of entries) {
    const v = (widgets[0] as { value?: unknown } | undefined)?.value;
    const value = Array.isArray(v) ? v[0] : v;
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

async function readPage(pdfjs: Pdfjs, doc: PdfDoc, n: number): Promise<PdfPage> {
  const page = await doc.getPage(n);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items: PdfItem[] = [];
  for (const raw of content.items) {
    if (!("str" in raw) || raw.str.trim() === "") continue;
    const m = pdfjs.Util.transform(viewport.transform, raw.transform);
    // Text not running left to right after rotation (a vertical label) is
    // left out: schedules are read across, and a sideways word in a
    // header would land in the wrong row.
    if (Math.abs(m[1]) > Math.abs(m[0]) * 0.1) continue;
    items.push({
      x: m[4],
      y: m[5],
      w: raw.width * (viewport.scale ?? 1),
      h: Math.hypot(m[2], m[3]),
      s: raw.str.replace(/\s+/g, " ").trim(),
    });
  }
  page.cleanup();
  return { page: n, width: viewport.width, height: viewport.height, items };
}
