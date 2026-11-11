import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { POST as reportRoute } from "@/app/api/modules/knowledge-base/questions/[id]/report/route";
import { GET as listRoute } from "@/app/api/modules/knowledge-base/reports/route";
import { POST as closeRoute } from "@/app/api/modules/knowledge-base/reports/[id]/route";
import { getConversation } from "@/lib/modules/knowledge-base/ask";
import { KNOWLEDGE_BASE_MODULE_KEY } from "@/lib/modules/knowledge-base/constants";
import { closeReport, countOpenReports, listReports, reportAnswer } from "@/lib/modules/knowledge-base/reports";
import { createEmployee, disconnectDb, grantModule, grantModuleAdmin, resetDb, testDb } from "./db";

/**
 * Report a wrong answer, and the module admins' queue. One open report per
 * person per answer; closing needs a note; both are audited.
 */

const authMock = vi.mocked(auth);
afterAll(disconnectDb);

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  await resetDb();
  await testDb.module.create({ data: { key: KNOWLEDGE_BASE_MODULE_KEY, displayName: "Knowledge Base", sortOrder: 400 } });
});

/** A saved answer with two sources, as ask.ts saves it. */
async function answered() {
  const asker = await createEmployee({ firstName: "Ann", lastName: "A" });
  const conversation = await testDb.kbConversation.create({ data: { employeeId: asker.id } });
  const source = (n: number) => ({
    n, chunkId: `c${n}`, documentId: `d${n}`, fileName: `file${n}.pdf`, projectFolder: "221457_MAGNODE", path: "x", webUrl: null,
    versionLabel: null, isLatest: true, isArchived: false, pageStart: n, pageEnd: n, section: null, sheet: null, cellRange: null, excerpt: "x",
  });
  const question = await testDb.kbQuestion.create({
    data: {
      conversationId: conversation.id, ordinal: 0, question: "What does RTU-3 weigh?", scopeProjectIds: [], scopeHow: "all",
      answerKind: "answered",
      answer: { version: 1, kind: "answered", text: "375 lbs [1].", missing: null, conflicts: [], sources: [source(1), source(2)], searchedFor: "q", considered: 2, notices: [] },
    },
  });
  return { asker, conversation, question };
}

async function signIn({ admin }: { admin: boolean }) {
  const employee = await createEmployee();
  await grantModule(employee.id, KNOWLEDGE_BASE_MODULE_KEY);
  if (admin) await grantModuleAdmin(employee.id, KNOWLEDGE_BASE_MODULE_KEY);
  authMock.mockResolvedValue({
    entraOid: employee.entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
  return employee;
}

const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("reporting an answer", () => {
  it("files a report anyone with the module can make, and a second one updates it rather than adding", async () => {
    const { question, conversation } = await answered();
    const me = await createEmployee();
    const first = await reportAnswer({ questionId: question.id, reporterId: me.id, reason: "wrong_fact", comment: " It is 410 lbs. " });
    const again = await reportAnswer({ questionId: question.id, reporterId: me.id, reason: "wrong_source", citationN: 2 });
    expect(again.id).toBe(first.id);
    expect(await testDb.kbAnswerReport.findMany()).toMatchObject([{ reason: "wrong_source", citationN: 2, comment: null, status: "open" }]);
    expect(await testDb.auditEvent.count({ where: { action: "kb.answer_reported" } })).toBe(2);

    // The person who reported sees it; the asker does not.
    expect((await getConversation(conversation.id, me.id))?.questions[0]?.reportedByMe).toBe(true);
    expect((await getConversation(conversation.id, question.id))?.questions[0]?.reportedByMe).toBe(false);
  });

  it("refuses a source the answer does not have", async () => {
    const { question } = await answered();
    const me = await createEmployee();
    await expect(reportAnswer({ questionId: question.id, reporterId: me.id, reason: "wrong_source", citationN: 3 })).rejects.toMatchObject({
      code: "citation_not_found",
    });
  });
});

describe("the admin queue", () => {
  it("lists open reports with the answer as shown, closes one with a note, and refuses a second close", async () => {
    const { question } = await answered();
    const reporter = await createEmployee({ firstName: "Bob", lastName: "B" });
    const admin = await createEmployee({ firstName: "Cat", lastName: "C" });
    const filed = await reportAnswer({ questionId: question.id, reporterId: reporter.id, reason: "outdated", comment: "Rev 2 changed it." });

    const open = await listReports("open");
    expect(open).toMatchObject([
      {
        id: filed.id,
        reason: "outdated",
        comment: "Rev 2 changed it.",
        reportedBy: "Bob B",
        question: { text: "What does RTU-3 weigh?", askedBy: "Ann A", answer: { text: "375 lbs [1]." } },
        resolution: null,
      },
    ]);
    expect(await countOpenReports()).toBe(1);

    await closeReport({ reportId: filed.id, adminId: admin.id, status: "resolved", note: " Re-indexed rev 2. " });
    expect(await listReports("open")).toEqual([]);
    expect(await listReports("closed")).toMatchObject([{ status: "resolved", resolution: { by: "Cat C", note: "Re-indexed rev 2." } }]);
    await expect(closeReport({ reportId: filed.id, adminId: admin.id, status: "dismissed", note: "x" })).rejects.toMatchObject({
      code: "already_closed",
    });
    expect(await testDb.auditEvent.findFirstOrThrow({ where: { action: "kb.answer_report_closed" } })).toMatchObject({
      actorEmployeeId: admin.id,
      metadata: { status: "resolved", note: "Re-indexed rev 2." },
    });

    // Closed, the reporter may report the same answer again.
    const later = await reportAnswer({ questionId: question.id, reporterId: reporter.id, reason: "wrong_fact" });
    expect(later.id).not.toBe(filed.id);
  });
});

describe("the routes", () => {
  it("report: 200 for anyone with the module, 422 for a bad body, 404 for an unknown answer", async () => {
    const { question } = await answered();
    await signIn({ admin: false });
    const url = `http://localhost/api/modules/knowledge-base/questions/${question.id}/report`;
    for (const body of [{}, { reason: "nope" }, { reason: "other", extra: 1 }, { reason: "other", comment: "x".repeat(2001) }]) {
      expect((await reportRoute(new Request(url, json(body)), params(question.id))).status).toBe(422);
    }
    expect((await reportRoute(new Request(url, json({ reason: "other", citationN: 9 })), params(question.id))).status).toBe(422);
    expect((await reportRoute(new Request(url, json({ reason: "other" })), params(question.id))).status).toBe(200);
    expect((await reportRoute(new Request(url, json({ reason: "other" })), params("00000000-0000-4000-8000-000000000000"))).status).toBe(404);
  });

  it("queue: 404 for someone without module admin, and closing needs a note", async () => {
    const { question } = await answered();
    const reporter = await createEmployee();
    const filed = await reportAnswer({ questionId: question.id, reporterId: reporter.id, reason: "other" });

    await signIn({ admin: false });
    expect((await listRoute(new Request("http://localhost/api/modules/knowledge-base/reports"))).status).toBe(404);
    const closeUrl = `http://localhost/api/modules/knowledge-base/reports/${filed.id}`;
    expect((await closeRoute(new Request(closeUrl, json({ status: "resolved", note: "ok" })), params(filed.id))).status).toBe(404);

    await signIn({ admin: true });
    expect((await (await listRoute(new Request("http://localhost/api/modules/knowledge-base/reports"))).json()).data).toHaveLength(1);
    expect((await closeRoute(new Request(closeUrl, json({ status: "resolved", note: "  " })), params(filed.id))).status).toBe(422);
    expect((await closeRoute(new Request(closeUrl, json({ status: "dismissed", note: "Answer is right." })), params(filed.id))).status).toBe(200);
    expect((await closeRoute(new Request(closeUrl, json({ status: "resolved", note: "again" })), params(filed.id))).status).toBe(409);
  });
});
