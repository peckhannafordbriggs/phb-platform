import type { PdfItem, PdfPage } from "./types";

/**
 * Text and positions out of a PDF drawing set, with pdfjs-dist (Apache-2.0).
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
    public readonly code: "unreadable" | "too_many_pages" | "no_text",
    message: string,
  ) {
    super(message);
  }
}

export async function extractPdfPages(bytes: Uint8Array): Promise<PdfPage[]> {
  const g = globalThis as { pdfjsWorker?: unknown };
  if (!g.pdfjsWorker) g.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const task = pdfjs.getDocument({
    data: bytes,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch {
    await task.destroy();
    throw new PdfReadError("unreadable", "That file could not be read as a PDF.");
  }

  try {
    if (doc.numPages > MAX_PAGES) {
      throw new PdfReadError("too_many_pages", `That PDF has ${doc.numPages} pages. Upload only the schedule sheets (${MAX_PAGES} at most).`);
    }
    const pages: PdfPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
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
      pages.push({ page: n, width: viewport.width, height: viewport.height, items });
      page.cleanup();
    }
    if (pages.every((p) => p.items.length < 20)) {
      throw new PdfReadError("no_text", "That PDF has no text layer (it looks scanned). Export the schedules from the drawing set as a PDF with text, or add the equipment by hand.");
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
