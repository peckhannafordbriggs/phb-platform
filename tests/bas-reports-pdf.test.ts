import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { renderReportHtml } from "@/lib/modules/bas/reports/engine/html";
import { createFixedNarrator } from "@/lib/modules/bas/reports/engine/narrative";
import { enqueueRun, executeReportRun } from "@/lib/modules/bas/reports/engine/run";
import { claimNextPdfJob, drainPdfQueue, renderClaimedPdf } from "@/lib/modules/bas/reports/pdf/jobs";
import {
  PDF_NOT_AVAILABLE_TOOLTIP,
  RENDER_IN_PROGRESS_PREFIX,
  contentDisposition,
  describePdfState,
  isRenderInProgress,
  pdfFileName,
  pdfStateKind,
  pdfTooltip,
  periodLabel,
  renderFailedSentence,
  type PdfState,
} from "@/lib/modules/bas/reports/pdf/naming";
import {
  PDF_FORMAT,
  createChromiumRenderer,
  fontFaceCss,
  looksLikePdf,
  type PdfBytes,
  type PdfInput,
  type PdfRenderer,
} from "@/lib/modules/bas/reports/pdf/render";
import { getRun, listRuns } from "@/lib/modules/bas/reports/runs-service";
import { changeReportState, createReport, requestRun } from "@/lib/modules/bas/reports/service";
import { drainQueue } from "@/lib/modules/bas/reports/worker";
import { seedBasReportLibrary } from "@/prisma/bas-report-library";
import { GET as pdfRoute } from "@/app/api/modules/bas/reports/runs/[runId]/pdf/route";
import { POST as retryRoute } from "@/app/api/modules/bas/reports/runs/[runId]/pdf/retry/route";
import { reportDocument } from "./fixtures/bas-report-document";
import {
  createEmployee,
  disconnectDb,
  grantModule,
  grantModuleAdmin,
  resetDb,
  seedBasModule,
  seedChangeOrdersModule,
  testDb,
} from "./db";

/**
 * Reports, Phase 4, the PDF half (2026-11-13).
 *
 * Three parts. The RENDERER, with the real Chromium Playwright installs
 * (locally `npx playwright install chromium`; in CI the step before the
 * tests; in the job image, Dockerfile.bas-reports): the sample report
 * document prints to a Letter PDF of a known page count, with the report
 * name and period in the header and page numbers in the footer, read back
 * with pdfjs. The QUEUE, against the real test database: the engine queues
 * a render as it stores a page, a worker claims it by writing the
 * in-progress failure first, the result lands on the run's PDF columns and
 * nowhere else, the download route serves it to the owner and a module
 * admin and tells anyone else nothing exists, a failed render leaves the
 * run untouched and offers Retry PDF, and the CHECKs hold the five columns
 * to the status. And the WEB APP's import graph, which must never reach the
 * module that launches a browser: the browser lives in the job image only.
 */

const authMock = vi.mocked(auth);
const NY = "America/New_York";
const ROOT = path.resolve(process.cwd());

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

const viewerOf = (e: Awaited<ReturnType<typeof createEmployee>>) => ({ ...e, profileCompleted: true });
const run = (runId: string) => ({ params: Promise.resolve({ runId }) });
const bare = (method = "GET") => new Request("http://localhost/api/modules/bas/reports/runs", { method });
/** The body is readable once: both halves come from one read. */
async function errorBody(response: Response): Promise<{ code?: string; message?: string }> {
  return ((await response.json()) as { error?: { code?: string; message?: string } }).error ?? {};
}
const errorMessage = async (response: Response) => (await errorBody(response)).message;

// ---------------------------------------------------------------------------
// Fakes, and pdfjs for reading a real PDF back
// ---------------------------------------------------------------------------

const FAKE_PDF: PdfBytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");

function fakeRenderer(): PdfRenderer & { inputs: PdfInput[]; closed: number } {
  const r = {
    inputs: [] as PdfInput[],
    closed: 0,
    async render(input: PdfInput) {
      r.inputs.push(input);
      return FAKE_PDF;
    },
    async close() {
      r.closed += 1;
    },
  };
  return r;
}

function failingRenderer(message: string): PdfRenderer {
  return {
    async render() {
      throw new Error(message);
    },
    async close() {},
  };
}

async function readPdf(bytes: Uint8Array): Promise<{ pages: number; text: string[] }> {
  const g = globalThis as { pdfjsWorker?: unknown };
  if (!g.pdfjsWorker) g.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, disableFontFace: true, useSystemFonts: false });
  const doc = await task.promise;
  try {
    const text: string[] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      text.push(content.items.map((i) => ("str" in i ? i.str : "")).join(" "));
      page.cleanup();
    }
    return { pages: doc.numPages, text };
  } finally {
    await task.destroy();
  }
}

// ---------------------------------------------------------------------------
// The renderer, with the real Chromium
// ---------------------------------------------------------------------------

describe("the renderer (real Chromium, the one the image and CI install)", () => {
  /** The sample document is four Letter pages at these margins (three before the question-first layout of 2026-11-13, five while the inventory carried a question table); a template change that moves the count is a change to notice. */
  const SAMPLE_PAGES = 4;

  it("prints the sample report to a Letter PDF of the expected page count, with the header and the page numbers", async () => {
    const renderer = createChromiumRenderer();
    try {
      const html = renderReportHtml(reportDocument());
      const bytes = await renderer.render({ html, title: "ZZTEST sample weekly", period: "2026-09-22 to 2026-09-29" });
      expect(looksLikePdf(bytes)).toBe(true);
      expect(bytes.length).toBeGreaterThan(10_000);
      const pdf = await readPdf(bytes);
      expect(pdf.pages).toBe(SAMPLE_PAGES);
      // The body is the stored page, unchanged.
      expect(pdf.text[0]).toContain("PHB Steel Place BAS Health Report");
      expect(pdf.text.join(" ")).toContain("VAV-2-14");
      expect(pdf.text.join(" ")).toContain("Open Items Carried Forward");
      // The header on every page, the footer counting to the last.
      for (const page of pdf.text) {
        expect(page).toContain("ZZTEST sample weekly");
        expect(page).toContain("2026-09-22 to 2026-09-29");
      }
      expect(pdf.text[0]).toContain(`Page 1 of ${SAMPLE_PAGES}`);
      expect(pdf.text[SAMPLE_PAGES - 1]).toContain(`Page ${SAMPLE_PAGES} of ${SAMPLE_PAGES}`);
      expect(PDF_FORMAT).toBe("Letter");
    } finally {
      await renderer.close();
      await renderer.close();
    }
  }, 120_000);

  it("embeds Figtree from app/fonts, and falls back to the browser's face when the file is not there", () => {
    const css = fontFaceCss();
    expect(css).toMatch(/^@font-face \{ font-family: Figtree; font-weight: 300 900;/);
    expect(css).toContain("data:font/woff2;base64,");
    expect(css.length).toBeGreaterThan(20_000);
    expect(fontFaceCss(path.join(ROOT, "no-such-directory"))).toBe("");
  });

  it("escapes the report's name in the header rather than rendering it", async () => {
    const renderer = createChromiumRenderer();
    try {
      const bytes = await renderer.render({
        html: renderReportHtml(reportDocument()),
        title: 'ZZTEST <b>bold</b> & "quoted"',
        period: "2026-09-22 to 2026-09-29",
      });
      const pdf = await readPdf(bytes);
      expect(pdf.text[0]).toContain('ZZTEST <b>bold</b> & "quoted"');
    } finally {
      await renderer.close();
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Naming and state, pure
// ---------------------------------------------------------------------------

describe("the PDF's name and state", () => {
  it("names the file after the report and the period's dates in the building's zone, cleaned for a file system", () => {
    // 03:30Z on the 12th is still the 11th in New York.
    expect(periodLabel("2026-11-05T03:30:00Z", "2026-11-12T03:30:00Z", NY)).toBe("2026-11-04 to 2026-11-11");
    expect(periodLabel("2026-11-05T03:30:00Z", "2026-11-12T03:30:00Z", "UTC")).toBe("2026-11-05 to 2026-11-12");
    expect(pdfFileName("Office weekly", "2026-11-05T11:00:00Z", "2026-11-12T11:00:00Z", NY)).toBe("Office weekly 2026-11-05 to 2026-11-12.pdf");
    expect(pdfFileName('A/B: "C"*?<>|\t D', "2026-11-05T11:00:00Z", "2026-11-12T11:00:00Z", NY)).toBe("A B C D 2026-11-05 to 2026-11-12.pdf");
    expect(pdfFileName("   ", "2026-11-05T11:00:00Z", "2026-11-12T11:00:00Z", NY)).toBe("BAS report 2026-11-05 to 2026-11-12.pdf");
    expect(pdfFileName("x".repeat(300), "2026-11-05T11:00:00Z", "2026-11-12T11:00:00Z", NY).length).toBeLessThan(140);
  });

  it("writes a Content-Disposition with an ASCII fallback and the exact name", () => {
    const header = contentDisposition("Café weekly 2026-11-05 to 2026-11-12.pdf");
    expect(header).toMatch(/^attachment; filename="Caf_ weekly 2026-11-05 to 2026-11-12\.pdf"; filename\*=UTF-8''Caf%C3%A9%20weekly/);
    expect(contentDisposition('a"b.pdf')).toContain('filename="a_b.pdf"');
  });

  it("reads a render in progress as rendering, and words every state for a button and a cell", () => {
    const state = (over: Partial<PdfState>): PdfState => ({ status: "none", error: null, bytes: null, queuedAt: null, renderedAt: null, ...over });
    expect(pdfStateKind(state({}))).toBe("none");
    expect(pdfStateKind(state({ status: "queued" }))).toBe("queued");
    expect(pdfStateKind(state({ status: "ready", bytes: 81_000 }))).toBe("ready");
    expect(pdfStateKind(state({ status: "failed", error: renderFailedSentence("boom") }))).toBe("failed");
    expect(pdfStateKind(state({ status: "failed", error: `${RENDER_IN_PROGRESS_PREFIX}2026-11-13T10:00:00.000Z and has not finished.` }))).toBe("rendering");
    expect(isRenderInProgress(null)).toBe(false);

    expect(pdfTooltip(state({}))).toBe(PDF_NOT_AVAILABLE_TOOLTIP);
    expect(pdfTooltip(state({ status: "ready" }))).toBeUndefined();
    expect(pdfTooltip(state({ status: "queued" }))).toMatch(/queued/);
    expect(pdfTooltip(state({ status: "failed", error: "The PDF could not be rendered: x." }))).toMatch(/Retry PDF.*could not be rendered: x/);

    expect(describePdfState(state({}))).toBe("Not available");
    expect(describePdfState(state({ status: "queued" }))).toBe("Queued for the worker");
    expect(describePdfState(state({ status: "ready", bytes: 81_892 }))).toBe("Ready · 80 KB");
    expect(describePdfState(state({ status: "ready", bytes: 3 * 1024 * 1024 }))).toBe("Ready · 3.0 MB");
    expect(describePdfState(state({ status: "failed", error: "x" }))).toBe("Failed");
    // A long renderer error is cut, and the sentence still says what to do.
    const long = renderFailedSentence("e".repeat(5000));
    expect(long.length).toBeLessThan(1800);
    expect(long).toMatch(/Retry PDF/);
  });
});

// ---------------------------------------------------------------------------
// The queue, against the database
// ---------------------------------------------------------------------------

let owner: Awaited<ReturnType<typeof createEmployee>>;
let other: Awaited<ReturnType<typeof createEmployee>>;
let admin: Awaited<ReturnType<typeof createEmployee>>;
let siteId: bigint;
let reportId: string;
const REPORT_NAME = "ZZTEST pdf weekly";

async function seedBuilding() {
  const org = await testDb.basOrg.create({ data: { name: "ZZTEST_PDF_ORG" } });
  const project = await testDb.basProject.create({ data: { orgId: org.orgId, name: "ZZTEST_PDF_PROJECT" } });
  const site = await testDb.basSite.create({ data: { orgId: org.orgId, projectId: project.projectId, name: "ZZTEST_PDF_SITE", timezone: NY } });
  await testDb.basStation.create({ data: { siteId: site.siteId, niagaraStationName: "ZZTestPdfStation", connectionMode: "direct", baseUrl: "https://198.51.100.32" } });
  siteId = site.siteId;
}

async function dropBuilding() {
  await testDb.basStation.deleteMany({ where: { niagaraStationName: "ZZTestPdfStation" } });
  await testDb.basSite.deleteMany({ where: { name: "ZZTEST_PDF_SITE" } });
  await testDb.basProject.deleteMany({ where: { name: "ZZTEST_PDF_PROJECT" } });
  await testDb.basOrg.deleteMany({ where: { name: "ZZTEST_PDF_ORG" } });
}

async function activeReport(): Promise<string> {
  const library = await testDb.basLibraryQuestion.findMany({ select: { libraryQuestionId: true }, orderBy: { position: "asc" } });
  const created = await createReport(viewerOf(owner), {
    name: REPORT_NAME,
    siteId: siteId.toString(),
    presetKey: "health_weekly",
    analysisWindow: "7d",
    schedule: { kind: "weekly", weekdays: [1] },
    timeOfDay: "06:00",
    questions: library.map((q) => ({ kind: "library" as const, libraryQuestionId: q.libraryQuestionId.toString() })),
  });
  await changeReportState(viewerOf(owner), created.reportId, "activate");
  return created.reportId;
}

/** A finished run with its page stored and its PDF queued, as the engine leaves it. */
async function finishedRun(periodEnd = new Date()) {
  const outcome = await executeReportRun(reportId, { periodEnd, trigger: "manual", startedById: owner.id, narrator: createFixedNarrator() });
  return BigInt(outcome.runId);
}

const row = (runId: bigint) => testDb.basReportRun.findUniqueOrThrow({ where: { runId } });
const bytesOf = async (runId: bigint) => (await testDb.basReportRun.findUniqueOrThrow({ where: { runId }, select: { pdf: true } })).pdf;

describe("the PDF queue, through the engine, the worker and the routes", () => {
  beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    resetBasAvailabilityCache();
    await resetDb();
    await dropBuilding();
    await seedChangeOrdersModule();
    await seedBasModule();
    await seedBasReportLibrary(testDb);
    owner = await createEmployee({ email: "zztest.pdf.owner@phb1899.com" });
    other = await createEmployee({ email: "zztest.pdf.other@phb1899.com" });
    admin = await createEmployee({ email: "zztest.pdf.admin@phb1899.com" });
    for (const e of [owner, other, admin]) await grantModule(e.id, BAS_MODULE_KEY);
    await grantModuleAdmin(admin.id, BAS_MODULE_KEY);
    await seedBuilding();
    reportId = await activeReport();
  });

  afterAll(async () => {
    await resetDb();
    await dropBuilding();
    await disconnectDb();
  });

  it("queues the render as the page is stored, renders it with the report's name and period, stores it, and serves it to the owner and an admin only", async () => {
    const runId = await finishedRun();
    const queued = await row(runId);
    expect(queued.pdfStatus).toBe("queued");
    expect(queued.pdfQueuedAt).not.toBeNull();
    expect(queued.reportHtml ?? "").toContain("<!doctype html>");

    // The list and the detail carry the state, never the bytes.
    const listed = await listRuns(viewerOf(owner), null);
    expect(listed.runs[0]!.pdf).toEqual({ status: "queued", error: null, bytes: null, queuedAt: queued.pdfQueuedAt!.toISOString(), renderedAt: null });
    expect(JSON.stringify(listed)).not.toContain('"type":"Buffer"');

    // Not ready: the route says so, to the owner.
    signedInAs(owner.entraOid!);
    const notYet = await pdfRoute(bare(), run(runId.toString()));
    expect(notYet.status).toBe(409);
    const notYetBody = await errorBody(notYet);
    expect(notYetBody.code).toBe("pdf_not_available");
    expect(notYetBody.message).toMatch(/queued/);

    // The worker's drain: one render, with the header's two lines from the run.
    const renderer = fakeRenderer();
    const outcomes = await drainPdfQueue(renderer);
    expect(outcomes).toEqual([{ runId, reportId: BigInt(reportId), name: REPORT_NAME, ok: true, bytes: FAKE_PDF.length, error: null }]);
    expect(renderer.inputs).toHaveLength(1);
    expect(renderer.inputs[0]).toMatchObject({ title: REPORT_NAME, period: periodLabel(queued.periodStart, queued.periodEnd, NY) });
    expect(renderer.inputs[0]!.html).toBe(queued.reportHtml);
    const ready = await row(runId);
    expect(ready).toMatchObject({ pdfStatus: "ready", pdfError: null, pdfBytes: FAKE_PDF.length, pdfQueuedAt: null });
    expect(ready.pdfRenderedAt).not.toBeNull();
    expect(Buffer.from((await bytesOf(runId))!)).toEqual(Buffer.from(FAKE_PDF));
    // A second drain finds nothing.
    expect(await drainPdfQueue(renderer)).toEqual([]);

    // The owner downloads it, with the file named after the report and the period.
    const ok = await pdfRoute(bare(), run(runId.toString()));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/pdf");
    expect(ok.headers.get("content-length")).toBe(String(FAKE_PDF.length));
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    const expectedName = pdfFileName(REPORT_NAME, queued.periodStart, queued.periodEnd, NY);
    expect(expectedName).toMatch(/^ZZTEST pdf weekly \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}\.pdf$/);
    expect(ok.headers.get("content-disposition")).toBe(contentDisposition(expectedName));
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(Buffer.from(FAKE_PDF));

    // A module admin too; a BAS user who is neither is told nothing exists.
    signedInAs(admin.entraOid!);
    expect((await pdfRoute(bare(), run(runId.toString()))).status).toBe(200);
    signedInAs(other.entraOid!);
    const refused = await pdfRoute(bare(), run(runId.toString()));
    expect(refused.status).toBe(404);
    expect(await refused.text()).not.toContain(REPORT_NAME);
    expect((await retryRoute(bare("POST"), run(runId.toString()))).status).toBe(404);
    // Signed out: 401, before anything is looked up.
    authMock.mockResolvedValue(null as never);
    expect((await pdfRoute(bare(), run(runId.toString()))).status).toBe(401);
    // A run that is not a run.
    signedInAs(owner.entraOid!);
    expect((await pdfRoute(bare(), run("not-a-run"))).status).toBe(404);
    expect((await pdfRoute(bare(), run("999999"))).status).toBe(404);

    // The detail says ready with the size.
    const detail = await getRun(viewerOf(owner), runId.toString());
    expect(detail.pdf).toMatchObject({ status: "ready", bytes: FAKE_PDF.length, error: null, queuedAt: null });
    expect(detail.pdf.renderedAt).toBe(ready.pdfRenderedAt!.toISOString());
  });

  it("records a failed render on the PDF columns and nowhere else, offers Retry PDF to the owner and an admin, and renders on the retry", async () => {
    const runId = await finishedRun();
    const before = await row(runId);
    const findingsBefore = await testDb.basReportFinding.count({ where: { runId } });

    const failed = await drainPdfQueue(failingRenderer("Chromium exited with code 137"));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ runId, ok: false, bytes: null });
    expect(failed[0]!.error).toBe(renderFailedSentence("Chromium exited with code 137"));
    expect(failed[0]!.error).toMatch(/Retry PDF/);

    const after = await row(runId);
    expect(after).toMatchObject({ pdfStatus: "failed", pdfError: failed[0]!.error, pdfBytes: null, pdfQueuedAt: null, pdfRenderedAt: null });
    expect(await bytesOf(runId)).toBeNull();
    // The run is what it was.
    expect(after.status).toBe(before.status);
    expect(after.error).toBeNull();
    expect(after.reportHtml).toBe(before.reportHtml);
    expect(after.finishedAt?.toISOString()).toBe(before.finishedAt?.toISOString());
    expect(await testDb.basReportFinding.count({ where: { runId } })).toBe(findingsBefore);
    expect(pdfStateKind({ status: "failed", error: after.pdfError })).toBe("failed");

    // Download says why.
    signedInAs(owner.entraOid!);
    const refused = await pdfRoute(bare(), run(runId.toString()));
    expect(refused.status).toBe(409);
    expect(await errorMessage(refused)).toContain("Chromium exited with code 137");

    // Retry: not for a stranger; the owner queues it, once, with an audit row.
    signedInAs(other.entraOid!);
    expect((await retryRoute(bare("POST"), run(runId.toString()))).status).toBe(404);
    signedInAs(owner.entraOid!);
    const accepted = await retryRoute(bare("POST"), run(runId.toString()));
    expect(accepted.status).toBe(202);
    const body = ((await accepted.json()) as { data: { runId: string; pdf: PdfState } }).data;
    expect(body.runId).toBe(runId.toString());
    expect(body.pdf).toMatchObject({ status: "queued", error: null, bytes: null, renderedAt: null });
    expect(await row(runId)).toMatchObject({ pdfStatus: "queued", pdfError: null });
    const audit = await testDb.auditEvent.findMany({ where: { action: "bas.report_pdf_retry_requested" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorEmployeeId: owner.id, metadata: { runId: runId.toString(), reportId, name: REPORT_NAME, previousError: failed[0]!.error } });

    // Already queued: a second retry is refused, by the owner and by an admin.
    const again = await retryRoute(bare("POST"), run(runId.toString()));
    expect(again.status).toBe(409);
    const againBody = await errorBody(again);
    expect(againBody.code).toBe("pdf_not_retryable");
    expect(againBody.message).toMatch(/already queued/);
    signedInAs(admin.entraOid!);
    expect((await retryRoute(bare("POST"), run(runId.toString()))).status).toBe(409);

    // The next worker renders it; ready is not retryable either.
    const renderer = fakeRenderer();
    expect(await drainPdfQueue(renderer)).toMatchObject([{ runId, ok: true }]);
    expect(await row(runId)).toMatchObject({ pdfStatus: "ready", pdfError: null, pdfBytes: FAKE_PDF.length });
    signedInAs(owner.entraOid!);
    const ready = await retryRoute(bare("POST"), run(runId.toString()));
    expect(ready.status).toBe(409);
    expect(await errorMessage(ready)).toMatch(/ready/);
    // An admin may retry a failed one too.
    await drainPdfQueue(fakeRenderer());
    await testDb.$executeRaw`UPDATE bas_report_runs SET pdf_status = 'failed', pdf_error = 'x', pdf = NULL, pdf_bytes = NULL, pdf_rendered_at = NULL WHERE run_id = ${runId}`;
    signedInAs(admin.entraOid!);
    expect((await retryRoute(bare("POST"), run(runId.toString()))).status).toBe(202);
  });

  it("a run from before PDFs has Download greyed with 'use Re-run' and no Retry", async () => {
    const runId = await finishedRun();
    await testDb.$executeRaw`UPDATE bas_report_runs SET pdf_status = 'none', pdf_queued_at = NULL WHERE run_id = ${runId}`;
    const summary = (await listRuns(viewerOf(owner), null)).runs[0]!;
    expect(summary.pdf.status).toBe("none");
    expect(pdfTooltip(summary.pdf)).toBe(PDF_NOT_AVAILABLE_TOOLTIP);
    signedInAs(owner.entraOid!);
    const download = await pdfRoute(bare(), run(runId.toString()));
    expect(download.status).toBe(409);
    expect(await errorMessage(download)).toMatch(/^PDF not available for this run/);
    const retry = await retryRoute(bare("POST"), run(runId.toString()));
    expect(retry.status).toBe(409);
    expect(await errorMessage(retry)).toMatch(/before PDFs were rendered/);
    // And nothing to claim.
    expect(await claimNextPdfJob()).toBeNull();
  });

  it("claims by writing the in-progress failure first, so a worker that dies mid-render leaves an honest row, and two claims never take the same render", async () => {
    const first = await finishedRun(new Date(Date.now() - 86_400_000));
    const second = await finishedRun();
    const [a, b] = await Promise.all([claimNextPdfJob(), claimNextPdfJob()]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect([a!.runId, b!.runId].sort()).toEqual([first, second].sort());
    expect(a!.html).toContain("<!doctype html>");
    expect(a!.title).toBe(REPORT_NAME);
    // Both read as a render in progress: failed, with the sentence, no queue time.
    for (const id of [first, second]) {
      const r = await row(id);
      expect(r.pdfStatus).toBe("failed");
      expect(r.pdfError).toMatch(new RegExp(`^${RENDER_IN_PROGRESS_PREFIX}\\d{4}-`));
      expect(r.pdfQueuedAt).toBeNull();
      expect(pdfStateKind({ status: "failed", error: r.pdfError })).toBe("rendering");
    }
    expect((await getRun(viewerOf(owner), first.toString())).pdf.status).toBe("failed");
    // Nothing is left to claim; a worker that stopped here leaves exactly this.
    expect(await claimNextPdfJob()).toBeNull();
    // The one that finishes overwrites its row with ready.
    const done = await renderClaimedPdf(a!, fakeRenderer());
    expect(done.ok).toBe(true);
    expect(await row(a!.runId)).toMatchObject({ pdfStatus: "ready", pdfError: null });
    expect(await row(b!.runId)).toMatchObject({ pdfStatus: "failed" });
    // Retry PDF is open on the one that was lost.
    signedInAs(owner.entraOid!);
    expect((await retryRoute(bare("POST"), run(b!.runId.toString()))).status).toBe(202);
  });

  it("the worker prints the run's PDF in the same execution, and one without Chromium leaves it queued", async () => {
    const { runId } = await requestRun(viewerOf(owner), reportId);
    const renderer = fakeRenderer();
    const drained = await drainQueue({ narrator: createFixedNarrator(), pdf: renderer });
    expect(drained.runs.map((c) => c.runId)).toEqual([BigInt(runId)]);
    expect(drained.pdfs).toMatchObject([{ runId: BigInt(runId), ok: true }]);
    expect(await row(BigInt(runId))).toMatchObject({ pdfStatus: "ready" });

    const bare2 = await requestRun(viewerOf(owner), reportId);
    const without = await drainQueue({ narrator: createFixedNarrator(), pdf: null });
    expect(without.runs.map((c) => c.runId)).toEqual([BigInt(bare2.runId)]);
    expect(without.pdfs).toEqual([]);
    expect(await row(BigInt(bare2.runId))).toMatchObject({ pdfStatus: "queued" });
    // A worker with Chromium that starts only for that queued render gets to it with no run of its own.
    const later = await drainQueue({ narrator: createFixedNarrator(), pdf: renderer });
    expect(later.runs).toEqual([]);
    expect(later.pdfs).toMatchObject([{ runId: BigInt(bare2.runId), ok: true }]);
  });

  it("the real Chromium prints a stored run's page: the bytes on the row open as a PDF naming the building", async () => {
    const runId = await finishedRun();
    const renderer = createChromiumRenderer();
    try {
      const outcomes = await drainPdfQueue(renderer);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]!.ok, outcomes[0]!.error ?? "").toBe(true);
      const stored = await bytesOf(runId);
      expect(stored).not.toBeNull();
      expect(looksLikePdf(stored!)).toBe(true);
      const pdf = await readPdf(stored!);
      expect(pdf.pages).toBeGreaterThanOrEqual(1);
      expect(pdf.text[0]).toContain("ZZTEST_PDF_SITE BAS Health Report");
      expect(pdf.text[0]).toContain(REPORT_NAME);
      expect(pdf.text[pdf.pages - 1]).toContain(`Page ${pdf.pages} of ${pdf.pages}`);
      expect((await row(runId)).pdfBytes).toBe(stored!.length);
    } finally {
      await renderer.close();
    }
  }, 120_000);

  it("holds the five columns to pdf_status with the CHECKs, by name", async () => {
    const runId = await finishedRun();
    const refuse = (sql: Promise<unknown>, constraint: string) => expect(sql).rejects.toThrow(new RegExp(constraint));
    await refuse(testDb.$executeRaw`UPDATE bas_report_runs SET pdf_status = 'bogus', pdf_queued_at = NULL WHERE run_id = ${runId}`, "bas_report_runs_pdf_status_known");
    await refuse(testDb.$executeRaw`UPDATE bas_report_runs SET pdf_queued_at = NULL WHERE run_id = ${runId}`, "bas_report_runs_pdf_queued_has_time");
    await refuse(testDb.$executeRaw`UPDATE bas_report_runs SET pdf_status = 'failed', pdf_queued_at = NULL WHERE run_id = ${runId}`, "bas_report_runs_pdf_failed_has_error");
    await refuse(testDb.$executeRaw`UPDATE bas_report_runs SET pdf_status = 'none', pdf_queued_at = NULL, pdf_error = 'left over' WHERE run_id = ${runId}`, "bas_report_runs_pdf_failed_has_error");
    await refuse(testDb.$executeRaw`UPDATE bas_report_runs SET pdf_status = 'ready', pdf_queued_at = NULL, pdf_bytes = 5, pdf_rendered_at = now() WHERE run_id = ${runId}`, "bas_report_runs_pdf_ready_has_bytes");
    await refuse(testDb.$executeRaw`UPDATE bas_report_runs SET pdf_status = 'ready', pdf_queued_at = NULL, pdf = '\\x255044462d'::bytea, pdf_rendered_at = now() WHERE run_id = ${runId}`, "bas_report_runs_pdf_ready_has_length");
    await refuse(testDb.$executeRaw`UPDATE bas_report_runs SET pdf_status = 'ready', pdf_queued_at = NULL, pdf = '\\x255044462d'::bytea, pdf_bytes = 5 WHERE run_id = ${runId}`, "bas_report_runs_pdf_ready_has_time");
    // A run with no page cannot have a PDF state at all.
    const queuedRun = await enqueueRun(testDb, { reportId: BigInt(reportId), trigger: "manual", periodEnd: new Date(), startedById: owner.id });
    await refuse(testDb.$executeRaw`UPDATE bas_report_runs SET pdf_status = 'queued', pdf_queued_at = now() WHERE run_id = ${queuedRun.runId}`, "bas_report_runs_pdf_needs_html");
    // The sound shapes go through.
    await testDb.$executeRaw`UPDATE bas_report_runs SET pdf_status = 'ready', pdf_queued_at = NULL, pdf = '\\x255044462d'::bytea, pdf_bytes = 5, pdf_rendered_at = now() WHERE run_id = ${runId}`;
    await testDb.$executeRaw`UPDATE bas_report_runs SET pdf_status = 'failed', pdf = NULL, pdf_bytes = NULL, pdf_rendered_at = NULL, pdf_error = 'x' WHERE run_id = ${runId}`;
    await testDb.$executeRaw`UPDATE bas_report_runs SET pdf_status = 'none', pdf_error = NULL WHERE run_id = ${runId}`;
  });
});

// ---------------------------------------------------------------------------
// The browser stays in the job image
// ---------------------------------------------------------------------------

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"\n]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function resolveImport(spec: string, from: string): string | null {
  if (spec.startsWith("node:")) return null;
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return path.normalize(candidate);
  }
  return null;
}

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

/** Every repository module reachable from `entry`, with how each was reached. */
function walk(entry: string): Map<string, string | null> {
  const start = path.join(ROOT, entry);
  const parent = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift()!;
    const code = stripComments(readFileSync(file, "utf8"));
    for (const m of code.matchAll(IMPORT_RE)) {
      const target = resolveImport(m[1]!, file);
      if (target !== null && !parent.has(target)) {
        parent.set(target, file);
        queue.push(target);
      }
    }
  }
  return parent;
}

function chainTo(parent: Map<string, string | null>, target: string): string[] {
  const full = path.join(ROOT, target);
  if (!parent.has(full)) return [];
  const chain: string[] = [];
  for (let cur: string | null | undefined = full; cur; cur = parent.get(cur)) chain.unshift(rel(cur));
  return chain;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated" || entry.name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name)) out.push(full.split(path.sep).join("/"));
  }
  return out;
}

describe("Chromium lives in the job image and nowhere the web app serves", () => {
  const RENDER = "lib/modules/bas/reports/pdf/render.ts";
  const JOBS = "lib/modules/bas/reports/pdf/jobs.ts";

  it("no module the web app serves reaches the renderer or the queue that uses it", () => {
    const entries = [
      "app/api/modules/bas/reports/runs/[runId]/pdf/route.ts",
      "app/api/modules/bas/reports/runs/[runId]/pdf/retry/route.ts",
      "app/api/modules/bas/reports/runs/[runId]/route.ts",
      "app/api/modules/bas/reports/runs/route.ts",
      "app/(modules)/bas/reports/generated/[runId]/page.tsx",
      "app/(modules)/bas/reports/page.tsx",
      "app/(modules)/bas/reports-generated.tsx",
      "app/(modules)/bas/reports-run-actions.tsx",
      "lib/modules/bas/reports/runs-service.ts",
      "lib/modules/bas/reports/service.ts",
    ];
    for (const entry of entries) {
      const graph = walk(entry);
      expect(graph.size, entry).toBeGreaterThan(3);
      for (const forbidden of [RENDER, JOBS]) {
        const chain = chainTo(graph, forbidden);
        expect(chain, `${entry} reaches ${forbidden}: ${chain.join(" -> ")}`).toEqual([]);
      }
    }
    // The pure half is what the web app is allowed, and the screens and the
    // runs service do use it.
    for (const entry of [
      "app/api/modules/bas/reports/runs/[runId]/pdf/route.ts",
      "app/(modules)/bas/reports/generated/[runId]/page.tsx",
      "app/(modules)/bas/reports-generated.tsx",
      "lib/modules/bas/reports/runs-service.ts",
    ]) {
      expect(chainTo(walk(entry), "lib/modules/bas/reports/pdf/naming.ts").length, `${entry} should reach naming.ts`).toBeGreaterThan(0);
    }
    // The worker does reach it, which is the point.
    expect(chainTo(walk("scripts/bas-reports-worker.ts"), RENDER).length).toBeGreaterThan(0);
    expect(chainTo(walk("scripts/bas-reports-scheduler.ts"), RENDER)).toEqual([]);
  });

  it("only the renderer imports playwright, and the web image never installs a browser", () => {
    const importers = [...sourceFiles("lib"), ...sourceFiles("app"), ...sourceFiles("scripts"), ...sourceFiles("components")].filter((f) =>
      /from ["']playwright["']/.test(stripComments(readFileSync(path.join(ROOT, f), "utf8"))),
    );
    expect(importers).toEqual([RENDER]);
    const web = readFileSync(path.join(ROOT, "Dockerfile"), "utf8")
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    expect(web).not.toMatch(/playwright|chromium/i);
    const jobs = readFileSync(path.join(ROOT, "Dockerfile.bas-reports"), "utf8")
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    expect(jobs).toMatch(/npx playwright install --with-deps chromium/);
  });

  it("every read of a run in lib/ and app/ selects its columns by name, and only loadRunPdf selects the bytes", () => {
    const reads: Array<{ file: string; call: string }> = [];
    for (const file of [...sourceFiles("lib"), ...sourceFiles("app")]) {
      const code = stripComments(readFileSync(path.join(ROOT, file), "utf8"));
      const re = /basReportRun\.(find(?:Many|First|Unique|FirstOrThrow|UniqueOrThrow))\s*\(/g;
      for (const m of code.matchAll(re)) {
        // The call's argument, by balancing parentheses from the opening one.
        let depth = 0;
        let end = m.index! + m[0].length - 1;
        for (let i = end; i < code.length; i += 1) {
          if (code[i] === "(") depth += 1;
          else if (code[i] === ")") {
            depth -= 1;
            if (depth === 0) {
              end = i;
              break;
            }
          }
        }
        reads.push({ file, call: code.slice(m.index!, end + 1) });
      }
    }
    expect(reads.length).toBeGreaterThan(5);
    for (const r of reads) {
      expect(r.call, `${r.file}: ${r.call.slice(0, 80)}`).toMatch(/select:/);
      expect(r.call, `${r.file}: ${r.call.slice(0, 80)}`).not.toMatch(/include:/);
    }
    const selectingBytes = reads.filter((r) => /\bpdf:\s*true/.test(r.call));
    expect(selectingBytes.map((r) => r.file)).toEqual(["lib/modules/bas/reports/runs-service.ts"]);
    expect(selectingBytes).toHaveLength(1);
    // RUN_SELECT, the list's and the detail's columns, leaves the bytes out.
    const service = readFileSync(path.join(ROOT, "lib/modules/bas/reports/runs-service.ts"), "utf8");
    const select = /const RUN_SELECT = \{([\s\S]*?)\} as const;/.exec(service)?.[1] ?? "";
    expect(select).toMatch(/pdfStatus: true/);
    expect(select).not.toMatch(/\n\s*pdf: true/);
  });
});
