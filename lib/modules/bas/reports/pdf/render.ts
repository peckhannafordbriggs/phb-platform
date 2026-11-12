import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";

/**
 * The report as a PDF (Reports, Phase 4, the PDF half - 2026-11-13): the
 * run's stored `report_html` - the SAME page the Generated view shows and
 * the standalone HTML holds - printed by headless Chromium.
 *
 * ONE RENDERING. The plan's decision (docs/bas-reports-tab-plan.md, "PDF
 * method"): Chromium prints the HTML the platform already renders, so the
 * screen and the PDF cannot disagree, at the cost of a browser in the JOB
 * image - and never in the web image. This module is imported by the worker
 * (through pdf/jobs.ts) and by nothing the web app serves;
 * tests/bas-reports-pdf.test.ts holds that.
 *
 * What is added at print time, and never stored: the page setup (Letter,
 * backgrounds on, margins), the report name and period in the header, page
 * numbers in the footer, a few break rules so a table row or a finding box
 * is not cut across pages, and Figtree - the platform's reading face,
 * embedded from app/fonts so the PDF reads like the screen rather than in
 * whatever sans-serif the container has. The stored HTML is untouched.
 *
 * Chromium runs without its sandbox (Playwright's default), as the image's
 * unprivileged `node` user, with every network request refused: the page is
 * self-contained and a report must not reach out. One browser per renderer,
 * launched on the first render and closed by the worker when its execution
 * ends; one context per render, so nothing carries over between reports.
 */

export interface PdfInput {
  html: string;
  /** The report's name, in the header. */
  title: string;
  /** The period as two dates, in the header (pdf/naming.ts, periodLabel). */
  period: string;
}

/** Bytes over their own buffer, which is what Prisma's Bytes column takes. */
export type PdfBytes = Uint8Array<ArrayBuffer>;

export interface PdfRenderer {
  /** The PDF's bytes. Throws when the page cannot be printed; the caller records why. */
  render(input: PdfInput): Promise<PdfBytes>;
  /** Close the browser if one was launched. Safe to call more than once. */
  close(): Promise<void>;
}

export const PDF_FORMAT = "Letter";
/** Room for the header and the footer, and the margins a printed report has. */
export const PDF_MARGIN = { top: "0.95in", right: "0.6in", bottom: "0.85in", left: "0.6in" } as const;
/** The most one render may take, launch included. A report that prints slower than this is a report that is broken. */
export const RENDER_TIMEOUT_MS = 60_000;

/** The platform's reading face, beside the code; the web app loads the same file through next/font (app/layout.tsx). */
export const FONT_FILE = path.join("app", "fonts", "figtree-latin-wght.woff2");

/** Added to the page before printing. Never stored, never shown on screen. */
export const PRINT_CSS = `
@page { size: Letter; }
html, body { margin: 0; padding: 0; background: #fff; }
.bas-report { max-width: none; }
.bas-report h1, .bas-report h2 { break-after: avoid; }
.bas-report tr, .bas-report .incident, .bas-report .partial { break-inside: avoid; }
.bas-report thead { display: table-header-group; }
.bas-report table { break-inside: auto; }
`;

/**
 * Figtree embedded as a data URL, so the print has the screen's face; an
 * empty string, and the browser's sans-serif, when the file is not beside
 * the code (a checkout without app/fonts, or a working directory that is
 * not the repository root).
 */
export function fontFaceCss(root: string = process.cwd()): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path.join(root, FONT_FILE));
  } catch {
    return "";
  }
  return `@font-face { font-family: Figtree; font-weight: 300 900; font-display: block; src: url(data:font/woff2;base64,${bytes.toString("base64")}) format("woff2"); }`;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Chromium's header and footer templates are documents of their own: they
 * see none of the page's styles and need their own font size, and their
 * box spans the page with no margin, so the padding here is the page's
 * horizontal margin. `pageNumber` and `totalPages` are the two class names
 * Chromium fills in.
 */
const HEADER_FOOTER_STYLE = "font-size:9px;font-family:Figtree,system-ui,sans-serif;color:#5c5873;width:100%;padding:0 0.6in;box-sizing:border-box;";

export function headerTemplate(title: string, period: string): string {
  return `<div style="${HEADER_FOOTER_STYLE}display:flex;justify-content:space-between;gap:1em;"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(title)}</span><span style="white-space:nowrap;">${escapeHtml(period)}</span></div>`;
}

export function footerTemplate(): string {
  return `<div style="${HEADER_FOOTER_STYLE}text-align:right;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

export function looksLikePdf(bytes: Uint8Array): boolean {
  return bytes.length > PDF_MAGIC.length && PDF_MAGIC.every((b, i) => bytes[i] === b);
}

export function createChromiumRenderer(options: { timeoutMs?: number; fontRoot?: string } = {}): PdfRenderer {
  const timeout = options.timeoutMs ?? RENDER_TIMEOUT_MS;
  const fonts = fontFaceCss(options.fontRoot);
  let browser: Browser | null = null;

  async function launched(): Promise<Browser> {
    if (browser === null || !browser.isConnected()) browser = await chromium.launch({ timeout });
    return browser;
  }

  return {
    async render(input) {
      const b = await launched();
      const context = await b.newContext();
      try {
        // Self-contained, by force: a report reaches nothing outside its own bytes.
        await context.route("**/*", (route) => route.abort());
        const page = await context.newPage();
        page.setDefaultTimeout(timeout);
        await page.setContent(input.html, { waitUntil: "load" });
        await page.addStyleTag({ content: `${fonts}\n${PRINT_CSS}` });
        // The embedded face has to be ready before the page is laid out for print.
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        const bytes: PdfBytes = new Uint8Array(
          await page.pdf({
            format: PDF_FORMAT,
            printBackground: true,
            margin: PDF_MARGIN,
            displayHeaderFooter: true,
            headerTemplate: headerTemplate(input.title, input.period),
            footerTemplate: footerTemplate(),
          }),
        );
        if (!looksLikePdf(bytes)) throw new Error(`Chromium returned ${bytes.length} bytes that are not a PDF`);
        return bytes;
      } finally {
        await context.close().catch(() => undefined);
      }
    },
    async close() {
      const b = browser;
      browser = null;
      if (b !== null) await b.close().catch(() => undefined);
    },
  };
}
