import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import {
  DELIVERY_BACKOFF_MS,
  DELIVERY_LEASE_MS,
  DELIVERY_UNCLAIMED_AFTER_MS,
  claimNextDelivery,
  deliveryAddresses,
  enqueueRunDeliveries,
} from "@/lib/modules/bas/reports/deliveries";
import {
  MAX_DELIVERY_ATTEMPTS,
  SEND_DISABLED_LABEL,
  SEND_DISABLED_MESSAGE,
  describeDelivery,
  type DeliverySummary,
} from "@/lib/modules/bas/reports/delivery-words";
import {
  EMAIL_ATTACHMENT_MAX_BYTES,
  REPORT_DELIVERY_HEADER,
  createReportMailer,
  type ReportMailer,
} from "@/lib/modules/bas/reports/email/mailer";
import { buildReportEmail, notMonitoredLine, reportEmailSubject, runLink } from "@/lib/modules/bas/reports/email/message";
import { drainDeliveries, type DeliveryOptions } from "@/lib/modules/bas/reports/email/send";
import { createFixedNarrator } from "@/lib/modules/bas/reports/engine/narrative";
import { executeReportRun } from "@/lib/modules/bas/reports/engine/run";
import {
  DEFAULT_BAS_MAILBOX,
  mailNotConfiguredReason,
  readWorkerMailEnv,
  type BasMailEnv,
} from "@/lib/modules/bas/reports/job-env";
import { drainPdfQueue } from "@/lib/modules/bas/reports/pdf/jobs";
import { pdfFileName, periodLabel } from "@/lib/modules/bas/reports/pdf/naming";
import type { PdfBytes, PdfRenderer } from "@/lib/modules/bas/reports/pdf/render";
import { failAbandonedWork } from "@/lib/modules/bas/reports/queue-guards";
import { getRun, listRuns, resendFailedDeliveries, sendRunToMe } from "@/lib/modules/bas/reports/runs-service";
import { addReportRecipient, changeReportState, createReport, removeReportRecipient, requestRun } from "@/lib/modules/bas/reports/service";
import { drainQueue } from "@/lib/modules/bas/reports/worker";
import { seedBasReportLibrary } from "@/prisma/bas-report-library";
import { POST as resendRoute } from "@/app/api/modules/bas/reports/runs/[runId]/deliveries/resend/route";
import { POST as sendToMeRoute } from "@/app/api/modules/bas/reports/runs/[runId]/deliveries/send-to-me/route";
import { reportDocument } from "./fixtures/bas-report-document";
import { createGraphStub, graphErrorResponse, type GraphStub, type RecordedRequest } from "./graph-stub";
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
 * Reports, Phase 4, the email half (2026-11-17).
 *
 * Graph is faked at the HTTP boundary - tests/graph-stub.ts's fetch - and
 * nothing above it: the shared middleware chain, the sendMail request the
 * mailer builds, the delivery queue's SQL, the worker's drain, the routes,
 * the audit rows and the test database are all the real ones. The one seam
 * besides the fetch is the token: these tests are not about Entra, so the
 * stub's token provider stands in for the federated credential, whose
 * refusals (not configured; a secret in production) are tested before any
 * network call is made.
 */

const authMock = vi.mocked(auth);
const NY = "America/New_York";
const ROOT = path.resolve(process.cwd());
const MAILBOX = DEFAULT_BAS_MAILBOX;

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

const viewerOf = (e: Awaited<ReturnType<typeof createEmployee>>) => ({ ...e, profileCompleted: true });
const params = (runId: string | bigint) => ({ params: Promise.resolve({ runId: String(runId) }) });
const post = () => new Request("http://localhost/api/modules/bas/reports/runs/x/deliveries", { method: "POST" });
async function errorBody(response: Response): Promise<{ code?: string; message?: string }> {
  return ((await response.json()) as { error?: { code?: string; message?: string } }).error ?? {};
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const PDF_HEAD = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n";
const FAKE_PDF: PdfBytes = new TextEncoder().encode(`${PDF_HEAD}trailer\n<< /Root 1 0 R >>\n%%EOF\n`);

function renderer(bytes: PdfBytes = FAKE_PDF): PdfRenderer {
  return { render: async () => bytes, close: async () => {} };
}

/** One byte over the simple-upload line, and still a PDF to the renderer's own check. */
function oversizedPdf(): PdfBytes {
  const out = new Uint8Array(EMAIL_ATTACHMENT_MAX_BYTES + 1);
  out.set(new TextEncoder().encode(PDF_HEAD), 0);
  return out;
}

const accepted = (request: RecordedRequest, index: number) =>
  new Response(null, { status: 202, headers: { "request-id": `req-${index + 1}` } });

const mailEnv = (over: Partial<BasMailEnv> = {}): BasMailEnv => ({
  clientId: "11111111-2222-3333-4444-555555555555",
  tenantId: "66666666-7777-8888-9999-000000000000",
  mailbox: MAILBOX,
  clientSecret: null,
  managedIdentityClientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  allowSend: true,
  production: true,
  platformUrl: "https://platform.example.test",
  ...over,
});

function mailerFor(stub: GraphStub, over: Partial<BasMailEnv> = {}): ReportMailer {
  return createReportMailer(mailEnv(over), {
    fetchImpl: stub.transport.fetchImpl,
    sleep: stub.transport.sleep,
    tokenProvider: stub.transport.tokenProvider,
  });
}

function delivery(stub: GraphStub, over: Partial<BasMailEnv> = {}, now?: () => Date): DeliveryOptions {
  return { mailer: mailerFor(stub, over), platformUrl: "https://platform.example.test", ...(now ? { now } : {}) };
}

interface SentMail {
  url: string;
  to: string[];
  subject: string;
  html: string;
  header: string | null;
  attachments: Array<{ name: string; contentType: string; contentBytes: string }>;
  saveToSentItems: boolean;
}

function sent(request: RecordedRequest): SentMail {
  const body = JSON.parse(request.body ?? "{}") as {
    message: {
      subject: string;
      body: { content: string };
      toRecipients: Array<{ emailAddress: { address: string } }>;
      internetMessageHeaders?: Array<{ name: string; value: string }>;
      attachments?: Array<{ name: string; contentType: string; contentBytes: string }>;
    };
    saveToSentItems: boolean;
  };
  return {
    url: request.url,
    to: body.message.toRecipients.map((r) => r.emailAddress.address),
    subject: body.message.subject,
    html: body.message.body.content,
    header: body.message.internetMessageHeaders?.find((h) => h.name === REPORT_DELIVERY_HEADER)?.value ?? null,
    attachments: body.message.attachments ?? [],
    saveToSentItems: body.saveToSentItems,
  };
}

// ---------------------------------------------------------------------------
// The message, pure
// ---------------------------------------------------------------------------

describe("what a report email says", () => {
  const base = {
    runId: "42",
    reportName: "Weekly health",
    buildingName: "PHB Steel Place",
    periodStart: new Date("2026-09-22T13:00:00Z"),
    periodEnd: new Date("2026-09-29T13:00:00Z"),
    timezone: NY,
    runStatus: "succeeded" as const,
    partialReason: null,
    platformUrl: "https://platform.example.test",
    pdf: { kind: "attached" as const, fileName: "Weekly health 2026-09-22 to 2026-09-29.pdf", bytes: 81_892 },
  };

  it("subject is <Report name> — <building> — <period>", () => {
    expect(reportEmailSubject(base)).toBe("Weekly health — PHB Steel Place — 2026-09-22 to 2026-09-29");
    // A name typed with a line break cannot split the header.
    expect(reportEmailSubject({ ...base, reportName: "Weekly\r\nBcc: x@evil.test" })).toBe("Weekly Bcc: x@evil.test — PHB Steel Place — 2026-09-22 to 2026-09-29");
  });

  it("body: building status, the three top findings, New / Still open / Cleared, the Not monitored line, the PDF line and the link", () => {
    const doc = reportDocument();
    const { html } = buildReportEmail({ ...base, document: doc });
    expect(html).toContain("Building status: <strong>Action Needed</strong>");
    for (const f of doc.summary.topFindings.slice(0, 3)) expect(html).toContain(f.subjectName);
    expect(html).toContain("New: 2 &middot; Still open: 2 &middot; Cleared: 1");
    expect(html).toContain("Not monitored: Q6 - the building does not trend the points that question needs.");
    expect(html).toContain("The full report is attached as a PDF (0.1 MB).");
    expect(html).toContain('<a href="https://platform.example.test/bas/reports/generated/42">Open the report on the platform</a>');
    expect(runLink(null, "42")).toBeNull();
    expect(buildReportEmail({ ...base, document: doc, platformUrl: null }).html).toContain("Open it on the platform: BAS &rarr; Reports &rarr; Weekly health.");
  });

  it("lists three findings at most, says so when there are none, and says when every question was monitored", () => {
    const doc = reportDocument();
    const four = [...doc.summary.topFindings, { ...doc.summary.topFindings[0]!, subjectName: "ZZ fourth finding" }];
    const many = buildReportEmail({ ...base, document: { ...doc, summary: { ...doc.summary, topFindings: four } } }).html;
    expect(many).not.toContain("ZZ fourth finding");
    expect(many.match(/<li /g)).toHaveLength(3);
    const none = buildReportEmail({ ...base, document: { ...doc, summary: { ...doc.summary, topFindings: [] }, inventory: { ...doc.inventory, notMonitored: [] } } }).html;
    expect(none).toContain("Top findings: none this period.");
    expect(notMonitoredLine({ ...doc, inventory: { ...doc.inventory, notMonitored: [] } })).toBe("Not monitored: none.");
  });

  it("says a run finished partial, and why", () => {
    const { html } = buildReportEmail({ ...base, runStatus: "partial", partialReason: "The run reached the $10.00 spending cap.", document: reportDocument() });
    expect(html).toContain("This run finished partial: The run reached the $10.00 spending cap.");
  });

  it("a PDF over the simple-upload limit is not attached: the body says so and links to the run", () => {
    const { html } = buildReportEmail({ ...base, document: reportDocument(), pdf: { kind: "too_large", bytes: 4 * 1024 * 1024, limitBytes: EMAIL_ATTACHMENT_MAX_BYTES } });
    expect(html).toContain("The PDF is 4.0 MB, more than the 3.0 MB an email from the platform can carry, so it is not attached.");
    expect(html).toContain("/bas/reports/generated/42");
  });

  it("escapes every string the run supplies", () => {
    const doc = reportDocument();
    const evil = { ...doc.summary.topFindings[0]!, subjectName: '<img src=x onerror="alert(1)">' };
    const { html } = buildReportEmail({
      ...base,
      reportName: "<script>alert(1)</script>",
      buildingName: "A & B",
      document: { ...doc, summary: { ...doc.summary, topFindings: [evil] } },
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("A &amp; B");
  });
});

describe("the Delivery column's words", () => {
  const d = (over: Partial<DeliverySummary>): DeliverySummary => ({ total: 0, sent: 0, failed: 0, pending: 0, notSent: 0, emptyReason: null, ...over });
  it("reads 3 of 3 sent, 1 failed, Not sent — sending disabled, and the waiting states", () => {
    expect(describeDelivery(d({ total: 3, sent: 3 }))).toBe("3 of 3 sent");
    expect(describeDelivery(d({ total: 3, sent: 2, failed: 1 }))).toBe("1 failed");
    expect(describeDelivery(d({ total: 3, notSent: 3 }))).toBe("Not sent — sending disabled");
    expect(SEND_DISABLED_LABEL).toBe("Not sent — sending disabled");
    expect(describeDelivery(d({ total: 3, sent: 1, pending: 2 }))).toBe("1 of 3 sent · 2 waiting");
    expect(describeDelivery(d({ emptyReason: "waiting_for_pdf" }))).toBe("Waiting for the PDF");
    expect(describeDelivery(d({ emptyReason: "none" }))).toBe("Not emailed");
  });
});

describe("the worker's mail settings", () => {
  it("opens the gate for exactly \"true\", defaults the mailbox, and names what is missing without printing a value", () => {
    expect(readWorkerMailEnv({}).allowSend).toBe(false);
    for (const v of ["TRUE", "True", "1", "yes", " true", "false"]) expect(readWorkerMailEnv({ BAS_REPORTS_ALLOW_SEND: v }).allowSend, v).toBe(false);
    expect(readWorkerMailEnv({ BAS_REPORTS_ALLOW_SEND: "true" }).allowSend).toBe(true);
    expect(readWorkerMailEnv({}).mailbox).toBe("controlls@phb1899.com");
    expect(readWorkerMailEnv({ BAS_MAILBOX: "  " }).mailbox).toBe("controlls@phb1899.com");
    expect(readWorkerMailEnv({ PLATFORM_URL: "https://platform.example.test/" }).platformUrl).toBe("https://platform.example.test");
    expect(mailNotConfiguredReason(readWorkerMailEnv({ NODE_ENV: "production" }))).toBe(
      "BAS_MAIL_CLIENT_ID and BAS_MAIL_TENANT_ID are not set, so the report email cannot be sent.",
    );
    expect(mailNotConfiguredReason(readWorkerMailEnv({ BAS_MAIL_CLIENT_ID: "c", BAS_MAIL_TENANT_ID: "t" }))).toBe(
      "BAS_MAIL_CLIENT_SECRET is not set, so the report email cannot be sent.",
    );
    const secretInProd = mailNotConfiguredReason(readWorkerMailEnv({ NODE_ENV: "production", BAS_MAIL_CLIENT_ID: "c", BAS_MAIL_TENANT_ID: "t", BAS_MAIL_CLIENT_SECRET: "s3cret-value" }));
    expect(secretInProd).toMatch(/BAS_MAIL_CLIENT_SECRET is set in production/);
    expect(secretInProd).not.toContain("s3cret-value");
    expect(mailNotConfiguredReason(readWorkerMailEnv({ NODE_ENV: "production", BAS_MAIL_CLIENT_ID: "c", BAS_MAIL_TENANT_ID: "t" }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The queue, the worker and the routes, against the database
// ---------------------------------------------------------------------------

let owner: Awaited<ReturnType<typeof createEmployee>>;
let other: Awaited<ReturnType<typeof createEmployee>>;
let admin: Awaited<ReturnType<typeof createEmployee>>;
let siteId: bigint;
let reportId: string;
const REPORT_NAME = "ZZTEST email weekly";
const SITE = "ZZTEST_EMAIL_SITE";

async function seedBuilding() {
  const org = await testDb.basOrg.create({ data: { name: "ZZTEST_EMAIL_ORG" } });
  const project = await testDb.basProject.create({ data: { orgId: org.orgId, name: "ZZTEST_EMAIL_PROJECT" } });
  const site = await testDb.basSite.create({ data: { orgId: org.orgId, projectId: project.projectId, name: SITE, timezone: NY } });
  await testDb.basStation.create({ data: { siteId: site.siteId, niagaraStationName: "ZZTestEmailStation", connectionMode: "direct", baseUrl: "https://198.51.100.33" } });
  siteId = site.siteId;
}

async function dropBuilding() {
  await testDb.basStation.deleteMany({ where: { niagaraStationName: "ZZTestEmailStation" } });
  await testDb.basSite.deleteMany({ where: { name: SITE } });
  await testDb.basProject.deleteMany({ where: { name: "ZZTEST_EMAIL_PROJECT" } });
  await testDb.basOrg.deleteMany({ where: { name: "ZZTEST_EMAIL_ORG" } });
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

/** A run as the worker leaves it: finished, its PDF ready, its deliveries written. */
async function readyRun(pdf: PdfBytes = FAKE_PDF, periodEnd = new Date()): Promise<bigint> {
  const outcome = await executeReportRun(reportId, { periodEnd, trigger: "manual", startedById: owner.id, narrator: createFixedNarrator() });
  const rendered = await drainPdfQueue(renderer(pdf));
  expect(rendered.map((r) => r.ok)).toEqual([true]);
  return BigInt(outcome.runId);
}

const rows = (runId: bigint) =>
  testDb.basReportDelivery.findMany({ where: { runId }, orderBy: [{ position: "asc" }, { deliveryId: "asc" }] });

describe("report email, through the queue, the worker and the routes", () => {
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
    owner = await createEmployee({ email: "zztest.email.owner@phb1899.com" });
    other = await createEmployee({ email: "zztest.email.other@phb1899.com" });
    admin = await createEmployee({ email: "zztest.email.admin@phb1899.com" });
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

  it("the owner is always included - from the employee record, first - even with no recipient rows; one message per address, from the BAS mailbox, with the PDF", async () => {
    expect(await testDb.basReportRecipient.count()).toBe(0);
    const runId = await readyRun();
    const queued = await rows(runId);
    expect(queued.map((r) => [r.email, r.source, r.position, r.status])).toEqual([["zztest.email.owner@phb1899.com", "owner", 0, "pending"]]);

    const stub = createGraphStub(accepted);
    const outcomes = await drainDeliveries(delivery(stub));
    expect(outcomes.map((o) => o.status)).toEqual(["sent"]);
    expect(stub.requests).toHaveLength(1);
    const mail = sent(stub.requests[0]!);
    expect(mail.url).toBe(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/sendMail`);
    expect(stub.requests[0]!.method).toBe("POST");
    expect(mail.to).toEqual(["zztest.email.owner@phb1899.com"]);
    const run = await testDb.basReportRun.findUniqueOrThrow({ where: { runId }, select: { periodStart: true, periodEnd: true } });
    expect(mail.subject).toBe(`${REPORT_NAME} — ${SITE} — ${periodLabel(run.periodStart, run.periodEnd, NY)}`);
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments[0]!.name).toBe(pdfFileName(REPORT_NAME, run.periodStart, run.periodEnd, NY));
    expect(mail.attachments[0]!.contentType).toBe("application/pdf");
    expect(Buffer.from(mail.attachments[0]!.contentBytes, "base64")).toEqual(Buffer.from(FAKE_PDF));
    expect(mail.header).toBe(queued[0]!.deliveryId.toString());
    expect(mail.saveToSentItems).toBe(true);
    expect(mail.html).toContain(`/bas/reports/generated/${runId}`);

    const after = await rows(runId);
    expect(after[0]).toMatchObject({ status: "sent", attempts: 1, lastError: null, graphRequestId: "req-1" });
    expect(after[0]!.sentAt).not.toBeNull();
    expect((await listRuns(viewerOf(owner), null)).runs[0]!.delivery).toMatchObject({ total: 1, sent: 1 });
    expect(describeDelivery((await getRun(viewerOf(owner), runId.toString())).delivery)).toBe("1 of 1 sent");
  });

  it("with recipients, the owner goes first and the rows follow in the order they were added; the owner cannot be added or removed through the recipients API", async () => {
    await addReportRecipient(viewerOf(owner), reportId, { email: "Zztest.First@phb1899.com" });
    await addReportRecipient(viewerOf(owner), reportId, { email: "zztest.second@phb1899.com" });
    await expect(addReportRecipient(viewerOf(owner), reportId, { email: owner.email.toUpperCase() })).rejects.toMatchObject({ code: "owner_is_recipient" });
    await expect(removeReportRecipient(viewerOf(owner), reportId, owner.email)).rejects.toMatchObject({ code: "owner_is_recipient" });

    const runId = await readyRun();
    expect((await rows(runId)).map((r) => [r.email, r.source, r.position])).toEqual([
      ["zztest.email.owner@phb1899.com", "owner", 0],
      ["zztest.first@phb1899.com", "recipient", 1],
      ["zztest.second@phb1899.com", "recipient", 2],
    ]);
    const stub = createGraphStub(accepted);
    await drainDeliveries(delivery(stub));
    expect(stub.requests.map((r) => sent(r).to)).toEqual([["zztest.email.owner@phb1899.com"], ["zztest.first@phb1899.com"], ["zztest.second@phb1899.com"]]);
    expect(describeDelivery((await getRun(viewerOf(owner), runId.toString())).delivery)).toBe("3 of 3 sent");
    // The address list is pure too: the owner first, recipients deduplicated, the owner never twice.
    expect(deliveryAddresses("A@x.com", [{ email: "b@x.com" }, { email: "a@x.com" }, { email: "B@x.com" }])).toEqual([
      { email: "a@x.com", source: "owner", position: 0 },
      { email: "b@x.com", source: "recipient", position: 1 },
    ]);
  });

  it("gate off: nothing leaves - no token, no request - and every delivery says Not sent — sending disabled; Resend has nothing to resend", async () => {
    await addReportRecipient(viewerOf(owner), reportId, { email: "zztest.first@phb1899.com" });
    const runId = await readyRun();
    const stub = createGraphStub(accepted);
    const outcomes = await drainDeliveries(delivery(stub, { allowSend: false }));
    expect(outcomes.map((o) => o.status)).toEqual(["not_sent", "not_sent"]);
    expect(stub.requests).toHaveLength(0);
    expect(stub.tokenCalls()).toBe(0);
    for (const r of await rows(runId)) {
      expect(r).toMatchObject({ status: "not_sent", attempts: 0, lastError: SEND_DISABLED_MESSAGE, sentAt: null });
    }
    expect(describeDelivery((await getRun(viewerOf(owner), runId.toString())).delivery)).toBe("Not sent — sending disabled");
    // The mailer refuses on its own as well, before any request.
    await expect(mailerFor(stub, { allowSend: false }).send({ to: owner.email, subject: "s", html: "h", attachment: null, deliveryId: "1" })).rejects.toMatchObject({ kind: "send_disabled" });
    expect(stub.requests).toHaveLength(0);

    signedInAs(owner.entraOid!);
    const resend = await resendRoute(post(), params(runId));
    expect(resend.status).toBe(409);
    expect((await errorBody(resend)).code).toBe("nothing_to_resend");
  });

  it("a forced Graph failure is tried three times on the backoff, then shows Failed with Resend; Resend queues it again and it goes", async () => {
    const runId = await readyRun();
    const t0 = new Date(Date.now() + 1000);
    let clock = t0;
    const failing = createGraphStub(() => graphErrorResponse(500, "ErrorInternalServerError"));
    const opts = delivery(failing, {}, () => clock);

    expect((await drainDeliveries(opts)).map((o) => o.status)).toEqual(["pending"]);
    expect(await rows(runId)).toMatchObject([{ status: "pending", attempts: 1 }]);
    // Not due yet: the backoff holds it.
    expect(await drainDeliveries(opts)).toEqual([]);
    clock = new Date(t0.getTime() + DELIVERY_BACKOFF_MS[0] + 1000);
    expect((await drainDeliveries(opts)).map((o) => o.status)).toEqual(["pending"]);
    clock = new Date(clock.getTime() + DELIVERY_BACKOFF_MS[1] + 1000);
    expect((await drainDeliveries(opts)).map((o) => o.status)).toEqual(["failed"]);
    expect(failing.requests).toHaveLength(MAX_DELIVERY_ATTEMPTS);
    const [failed] = await rows(runId);
    expect(failed).toMatchObject({ status: "failed", attempts: 3 });
    expect(failed!.lastError).toMatch(/^3 attempts failed; the last: Graph refused the send: status=500 code=ErrorInternalServerError requestId=/);
    // Nothing more is attempted.
    clock = new Date(clock.getTime() + 24 * 3600_000);
    expect(await drainDeliveries(opts)).toEqual([]);

    const summary = (await listRuns(viewerOf(owner), null)).runs[0]!.delivery;
    expect(describeDelivery(summary)).toBe("1 failed");

    // Resend: the owner's route, 202, audited, the row pending with three fresh attempts.
    signedInAs(owner.entraOid!);
    const resend = await resendRoute(post(), params(runId));
    expect(resend.status).toBe(202);
    expect(((await resend.json()) as { data: { requeued: number } }).data.requeued).toBe(1);
    expect(await rows(runId)).toMatchObject([{ status: "pending", attempts: 0, lastError: null, requestedById: owner.id }]);
    const audit = await testDb.auditEvent.findMany({ where: { action: "bas.report_resend_requested" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorEmployeeId).toBe(owner.id);
    expect(audit[0]!.metadata).toMatchObject({ runId: runId.toString(), name: REPORT_NAME, emails: ["zztest.email.owner@phb1899.com"], count: 1 });

    const ok = createGraphStub(accepted);
    expect((await drainDeliveries(delivery(ok))).map((o) => o.status)).toEqual(["sent"]);
    expect(await rows(runId)).toMatchObject([{ status: "sent", attempts: 1 }]);
  });

  it("Resend touches only failed rows: sent and not-sent rows are left exactly as they were", async () => {
    await addReportRecipient(viewerOf(owner), reportId, { email: "zztest.first@phb1899.com" });
    await addReportRecipient(viewerOf(owner), reportId, { email: "zztest.bounce@phb1899.com" });
    await addReportRecipient(viewerOf(owner), reportId, { email: "zztest.later@phb1899.com" });
    const runId = await readyRun();
    // The fourth row is made a not-sent one before anything runs.
    await testDb.basReportDelivery.updateMany({ where: { runId, email: "zztest.later@phb1899.com" }, data: { status: "not_sent", lastError: SEND_DISABLED_MESSAGE } });

    let clock = new Date(Date.now() + 1000);
    const stub = createGraphStub((request, index) =>
      sent(request).to[0] === "zztest.bounce@phb1899.com" ? graphErrorResponse(403, "ErrorAccessDenied") : accepted(request, index),
    );
    const opts = delivery(stub, {}, () => clock);
    for (let i = 0; i < 3; i += 1) {
      await drainDeliveries(opts);
      clock = new Date(clock.getTime() + 10 * 60_000);
    }
    const before = await rows(runId);
    expect(before.map((r) => [r.email, r.status])).toEqual([
      ["zztest.email.owner@phb1899.com", "sent"],
      ["zztest.first@phb1899.com", "sent"],
      ["zztest.bounce@phb1899.com", "failed"],
      ["zztest.later@phb1899.com", "not_sent"],
    ]);
    expect(before[2]!.lastError).toMatch(/status=403 code=ErrorAccessDenied/);
    expect(before[2]!.lastError).toMatch(/ApplicationAccessPolicy/);

    // An admin may resend somebody else's run; a person with no right to the run is told it does not exist.
    await expect(resendFailedDeliveries(viewerOf(other), runId.toString())).rejects.toMatchObject({ code: "run_not_found" });
    expect(await resendFailedDeliveries(viewerOf(admin), runId.toString())).toEqual({ runId: runId.toString(), requeued: 1 });

    const after = await rows(runId);
    for (const i of [0, 1, 3]) {
      expect(after[i], before[i]!.email).toEqual(before[i]);
    }
    expect(after[2]).toMatchObject({ status: "pending", attempts: 0, lastError: null, requestedById: admin.id });
    expect(await testDb.auditEvent.count({ where: { action: "bas.report_resend_requested", actorEmployeeId: admin.id } })).toBe(1);
  });

  it("is idempotent on a worker retry: rows are written once per address, a sent row is never claimed again, and a worker that died mid-send is reclaimed after its lease", async () => {
    await addReportRecipient(viewerOf(owner), reportId, { email: "zztest.first@phb1899.com" });
    const runId = await readyRun();
    // Writing the rows again - a second render, a repeated worker - writes nothing.
    expect(await enqueueRunDeliveries(testDb, runId)).toBe(0);
    expect(await testDb.basReportDelivery.count({ where: { runId } })).toBe(2);

    // A worker takes the owner's row and dies before Graph answers.
    const now = new Date(Date.now() + 1000);
    const claim = await claimNextDelivery(now);
    expect(claim).toMatchObject({ email: "zztest.email.owner@phb1899.com", attempt: 1 });
    const leased = await testDb.basReportDelivery.findUniqueOrThrow({ where: { deliveryId: claim!.deliveryId } });
    expect(leased.lastError).toMatch(/^An attempt started at .* and has not finished\.$/);

    // The next worker, inside the lease: only the other address.
    const stub = createGraphStub(accepted);
    const first = await drainDeliveries(delivery(stub, {}, () => now));
    expect(first.map((o) => o.email)).toEqual(["zztest.first@phb1899.com"]);
    // And again: nothing - the sent row is not taken twice, the leased one is still held.
    expect(await drainDeliveries(delivery(stub, {}, () => now))).toEqual([]);
    expect(stub.requests).toHaveLength(1);

    // After the lease: the owner's row, its second attempt, one request.
    const later = new Date(now.getTime() + DELIVERY_LEASE_MS + 1000);
    const second = await drainDeliveries(delivery(stub, {}, () => later));
    expect(second.map((o) => [o.email, o.status])).toEqual([["zztest.email.owner@phb1899.com", "sent"]]);
    expect(stub.requests).toHaveLength(2);
    expect(await rows(runId)).toMatchObject([
      { email: "zztest.email.owner@phb1899.com", status: "sent", attempts: 2 },
      { email: "zztest.first@phb1899.com", status: "sent", attempts: 1 },
    ]);
    // Rendering the same run's PDF again (Retry PDF on a ready run is refused, but the queue does not rely on it).
    expect(await enqueueRunDeliveries(testDb, runId)).toBe(0);
  });

  it("an external address requires confirmation before it is a recipient; once confirmed it is sent to in production and refused outside it", async () => {
    await expect(addReportRecipient(viewerOf(owner), reportId, { email: "contractor@example.com" })).rejects.toMatchObject({ code: "external_unconfirmed" });
    expect(await testDb.basReportRecipient.count()).toBe(0);
    const added = await addReportRecipient(viewerOf(owner), reportId, { email: "contractor@example.com", confirmed: true });
    expect(added).toMatchObject({ email: "contractor@example.com", isExternal: true });

    const runId = await readyRun();
    const detail = await getRun(viewerOf(owner), runId.toString());
    expect(detail.deliveries.map((d) => [d.email, d.isExternal])).toEqual([
      ["zztest.email.owner@phb1899.com", false],
      ["contractor@example.com", true],
    ]);

    // Outside production: company addresses only. The external row fails without a request; the owner's goes.
    const dev = createGraphStub(accepted);
    const outcomes = await drainDeliveries(delivery(dev, { production: false }));
    expect(outcomes.map((o) => [o.email, o.status])).toEqual([
      ["zztest.email.owner@phb1899.com", "sent"],
      ["contractor@example.com", "failed"],
    ]);
    expect(dev.requests.map((r) => sent(r).to[0])).toEqual(["zztest.email.owner@phb1899.com"]);
    expect((await rows(runId))[1]!.lastError).toMatch(/outside production a report email goes only to @phb1899\.com addresses/);

    // In production the same row, resent, goes.
    await resendFailedDeliveries(viewerOf(owner), runId.toString());
    const prod = createGraphStub(accepted);
    await drainDeliveries(delivery(prod, { production: true }));
    expect(prod.requests.map((r) => sent(r).to[0])).toEqual(["contractor@example.com"]);
  });

  it("Send to me sends a copy to the person asking - their own address, from the session - and is audited; twice while waiting is refused", async () => {
    await addReportRecipient(viewerOf(owner), reportId, { email: "zztest.first@phb1899.com" });
    const runId = await readyRun();
    const stub = createGraphStub(accepted);
    await drainDeliveries(delivery(stub));
    expect(stub.requests).toHaveLength(2);

    // An admin, on nobody's list.
    signedInAs(admin.entraOid!);
    const response = await sendToMeRoute(post(), params(runId));
    expect(response.status).toBe(202);
    expect(((await response.json()) as { data: { email: string } }).data.email).toBe(admin.email);
    const again = await sendToMeRoute(post(), params(runId));
    expect(again.status).toBe(409);
    expect((await errorBody(again)).code).toBe("delivery_pending");

    const audit = await testDb.auditEvent.findMany({ where: { action: "bas.report_send_to_me_requested" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorEmployeeId).toBe(admin.id);
    expect(audit[0]!.metadata).toMatchObject({ runId: runId.toString(), name: REPORT_NAME, email: admin.email, previousStatus: null });

    await drainDeliveries(delivery(stub));
    expect(stub.requests.map((r) => sent(r).to[0])).toEqual(["zztest.email.owner@phb1899.com", "zztest.first@phb1899.com", admin.email]);
    expect((await rows(runId)).map((r) => [r.email, r.source, r.status])).toEqual([
      ["zztest.email.owner@phb1899.com", "owner", "sent"],
      ["zztest.first@phb1899.com", "recipient", "sent"],
      [admin.email, "requested", "sent"],
    ]);

    // The owner, whose own row was sent: a second copy, on the same row.
    expect(await sendRunToMe(viewerOf(owner), runId.toString())).toEqual({ runId: runId.toString(), email: owner.email });
    expect((await rows(runId))[0]).toMatchObject({ status: "pending", attempts: 0, sentAt: null, requestedById: owner.id });
    expect(await testDb.basReportDelivery.count({ where: { runId } })).toBe(3);
    const ownerAudit = await testDb.auditEvent.findFirstOrThrow({ where: { action: "bas.report_send_to_me_requested", actorEmployeeId: owner.id } });
    expect(ownerAudit.metadata).toMatchObject({ previousStatus: "sent" });

    // Somebody with no right to the run is told it does not exist.
    signedInAs(other.entraOid!);
    expect((await sendToMeRoute(post(), params(runId))).status).toBe(404);
  });

  it("Send to me is refused for a run with no finished report", async () => {
    const queued = await requestRun(viewerOf(owner), reportId);
    await expect(sendRunToMe(viewerOf(owner), queued.runId)).rejects.toMatchObject({ code: "run_not_sendable" });
    expect(await testDb.basReportDelivery.count()).toBe(0);
  });

  it("a PDF over Graph's simple-upload limit is not attached: the message carries the link and says why", async () => {
    const runId = await readyRun(oversizedPdf());
    const stub = createGraphStub(accepted);
    await drainDeliveries(delivery(stub));
    const mail = sent(stub.requests[0]!);
    expect(mail.attachments).toEqual([]);
    expect(mail.html).toContain("so it is not attached");
    expect(mail.html).toContain(`/bas/reports/generated/${runId}`);
  });

  it("not configured: the delivery fails at once naming the variable, with no request; a secret in production is refused the same way", async () => {
    const runId = await readyRun();
    const stub = createGraphStub(accepted);
    const unconfigured = createReportMailer(mailEnv({ clientId: null }), { fetchImpl: stub.transport.fetchImpl });
    await drainDeliveries({ mailer: unconfigured, platformUrl: null });
    expect(stub.requests).toHaveLength(0);
    expect(await rows(runId)).toMatchObject([{ status: "failed", attempts: 1, lastError: "BAS_MAIL_CLIENT_ID is not set, so the report email cannot be sent." }]);

    const withSecret = createReportMailer(mailEnv({ clientSecret: "s3cret-value" }), { fetchImpl: stub.transport.fetchImpl });
    await expect(withSecret.send({ to: owner.email, subject: "s", html: "h", attachment: null, deliveryId: "1" })).rejects.toMatchObject({
      kind: "not_configured",
      message: expect.stringMatching(/BAS_MAIL_CLIENT_SECRET is set in production/) as unknown as string,
    });
    expect(stub.requests).toHaveLength(0);
  });

  it("the worker: a queued run is worked, printed and emailed in one drain", async () => {
    await addReportRecipient(viewerOf(owner), reportId, { email: "zztest.first@phb1899.com" });
    const { runId } = await requestRun(viewerOf(owner), reportId);
    const stub = createGraphStub(accepted);
    const done = await drainQueue({ narrator: createFixedNarrator(), pdf: renderer(), email: delivery(stub) });
    expect(done.runs.map((r) => r.runId.toString())).toEqual([runId]);
    expect(done.pdfs.map((p) => p.ok)).toEqual([true]);
    expect(done.deliveries.map((d) => [d.email, d.status])).toEqual([
      ["zztest.email.owner@phb1899.com", "sent"],
      ["zztest.first@phb1899.com", "sent"],
    ]);
    // A worker with no email options leaves due deliveries for one that has them.
    const { runId: second } = await requestRun(viewerOf(owner), reportId);
    const noEmail = await drainQueue({ narrator: createFixedNarrator(), pdf: renderer() });
    expect(noEmail.deliveries).toEqual([]);
    expect(await testDb.basReportDelivery.count({ where: { runId: BigInt(second), status: "pending" } })).toBe(2);
  });

  it("a failed or unfinished run gets no delivery rows; a run is emailed only once its PDF is ready", async () => {
    const outcome = await executeReportRun(reportId, { periodEnd: new Date(), trigger: "manual", startedById: owner.id, narrator: createFixedNarrator() });
    const runId = BigInt(outcome.runId);
    // Finished, PDF queued: no rows yet, and the list says it is waiting for the PDF.
    expect(await testDb.basReportDelivery.count({ where: { runId } })).toBe(0);
    expect(describeDelivery((await getRun(viewerOf(owner), outcome.runId)).delivery)).toBe("Waiting for the PDF");
    // A failed render writes none.
    await drainPdfQueue({ render: async () => { throw new Error("boom"); }, close: async () => {} });
    expect(await testDb.basReportDelivery.count({ where: { runId } })).toBe(0);
    expect(describeDelivery((await getRun(viewerOf(owner), outcome.runId)).delivery)).toBe("Not sent: no PDF");
    // A run that is not succeeded or partial never gets rows.
    await testDb.basReportRun.update({ where: { runId }, data: { status: "failed", error: "x", partialReason: null } });
    expect(await enqueueRunDeliveries(testDb, runId)).toBe(0);
  });

  it("the scheduler's guard fails a delivery due for an hour and never taken, and the scaler's count returns to zero", async () => {
    const runId = await readyRun();
    expect(await scalerCount()).toBe(1);
    const now = new Date(Date.now() + DELIVERY_UNCLAIMED_AFTER_MS + 60_000);
    const report = await failAbandonedWork(now);
    expect(report.abandonedDeliveries.map((d) => d.email)).toEqual(["zztest.email.owner@phb1899.com"]);
    expect(report.abandonedDeliveries[0]!.error).toMatch(/never sent: the worker job is not starting executions/);
    expect(await rows(runId)).toMatchObject([{ status: "failed" }]);
    expect(await scalerCount()).toBe(0);
    // A delivery in its backoff is not counted, so the scaler does not start a worker for it early.
    await resendFailedDeliveries(viewerOf(owner), runId.toString());
    await testDb.basReportDelivery.updateMany({ where: { runId }, data: { nextAttemptAt: new Date(Date.now() + 60_000), attempts: 1 } });
    expect(await scalerCount()).toBe(0);
  });
});

/** The worker job's KEDA query, exactly as the template carries it (tests/bas-reports-queue-guards.test.ts reads it the same way). */
async function scalerCount(): Promise<number> {
  const bicep = readFileSync(path.join(ROOT, "infra/main.bicep"), "utf8");
  const start = bicep.indexOf("resource basReportsWorkerJob ");
  const block = bicep.slice(start, bicep.indexOf("\nresource ", start + 1));
  const m = /query: '((?:[^'\\]|\\.)*)'/.exec(block);
  expect(m).not.toBeNull();
  const query = m![1]!.replace(/\\'/g, "'");
  const result = await testDb.$queryRawUnsafe<Array<{ count: bigint }>>(query);
  return Number(result[0]!.count);
}

// ---------------------------------------------------------------------------
// The worker is the only sender
// ---------------------------------------------------------------------------

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(path.join(ROOT, d))) {
      const rel = `${d}/${name}`;
      const full = path.join(ROOT, rel);
      if (statSync(full).isDirectory()) {
        if (name === "node_modules" || name === "generated") continue;
        walk(rel);
      } else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
    }
  };
  if (existsSync(path.join(ROOT, dir))) walk(dir);
  return out;
}

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the worker is the only sender", () => {
  const all = [...sourceFiles("lib"), ...sourceFiles("app"), ...sourceFiles("scripts"), ...sourceFiles("components")];

  it("sendMail is called in exactly one file, the BAS report mailer", () => {
    const callers = all.filter((f) => /sendMail/.test(stripComments(readFileSync(path.join(ROOT, f), "utf8"))));
    expect(callers).toEqual(["lib/modules/bas/reports/email/mailer.ts"]);
  });

  it("nothing in the web app imports the mailer or the drain; only the worker does", () => {
    const importers = (target: RegExp) =>
      all.filter((f) => target.test(stripComments(readFileSync(path.join(ROOT, f), "utf8")))).sort();
    expect(importers(/from ["'](?:\.\/|[^"']*email\/)mailer["']/)).toEqual([
      "lib/modules/bas/reports/email/send.ts",
      "scripts/bas-reports-worker.ts",
    ]);
    expect(importers(/from ["'][^"']*email\/send["']/)).toEqual(["lib/modules/bas/reports/worker.ts"]);
    // The worker module is reached from the worker script, the dev run script's
    // neighbours and nothing under app/.
    expect(importers(/from ["'][^"']*reports\/worker["']/).filter((f) => f.startsWith("app/"))).toEqual([]);
    // Resend and Send to me write rows through the runs service, which never imports the sender.
    const service = stripComments(readFileSync(path.join(ROOT, "lib/modules/bas/reports/runs-service.ts"), "utf8"));
    expect(service).not.toMatch(/email\/(mailer|send)/);
    const deliveries = stripComments(readFileSync(path.join(ROOT, "lib/modules/bas/reports/deliveries.ts"), "utf8"));
    expect(deliveries).not.toMatch(/from ["'][^"']*(?:email\/|lib\/mail\/|microsoft-graph)/);
  });

  it("the mailer refuses before any request, in this order: the gate, then the address outside production, then the configuration", () => {
    const mailer = stripComments(readFileSync(path.join(ROOT, "lib/modules/bas/reports/email/mailer.ts"), "utf8"));
    const send = mailer.slice(mailer.indexOf("async send("));
    const gate = send.indexOf("if (!mail.allowSend)");
    const fence = send.indexOf("if (!mail.production && isExternalAddress");
    const call = send.indexOf(".api(");
    expect(gate).toBeGreaterThan(-1);
    expect(fence).toBeGreaterThan(gate);
    expect(call).toBeGreaterThan(fence);
  });
});
