import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Only the session is mocked in the route tests. Search, history and the database are real.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { POST as askRoute } from "@/app/api/modules/knowledge-base/ask/route";
import { GET as historyRoute } from "@/app/api/modules/knowledge-base/history/route";
import { GET as conversationRoute } from "@/app/api/modules/knowledge-base/history/[id]/route";
import { QuestionRateLimiter } from "@/lib/modules/bas/analyze/rate-limit";
import type { KbAnswerer, KbAnswerPassage, KbPriorTurn } from "@/lib/modules/knowledge-base/answer";
import {
  KbAskError,
  askQuestion,
  getConversation,
  listConversations,
} from "@/lib/modules/knowledge-base/ask";
import { KNOWLEDGE_BASE_MODULE_KEY } from "@/lib/modules/knowledge-base/constants";
import type { KbReranker } from "@/lib/modules/knowledge-base/rerank";
import { createEmployee, disconnectDb, grantModule, resetDb, testDb } from "./db";

/**
 * A question start to finish against real passages: search, re-sort (a fake
 * Haiku), answer (a fake Sonnet), the checks on the answer, and the shared
 * history it is saved to. No model is reached.
 */

const authMock = vi.mocked(auth);
afterAll(disconnectDb);

let n = 0;
async function seed() {
  n += 1;
  const project = await testDb.kbProject.create({
    data: { sourceKind: "local", sourceId: `p-${n}`, folderName: "221457_MAGNODE", projectNumber: "221457", name: "Magnode", isLegacy: true },
  });
  const other = await testDb.kbProject.create({
    data: { sourceKind: "local", sourceId: `q-${n}`, folderName: "224070_UC_OLD_CHEM", projectNumber: "224070", name: "UC", isLegacy: true },
  });
  const files: [string, string, string][] = [
    [project.id, "221457_SUB_Packaged_RTUs_Approved.pdf", "RTU-3 rooftop unit. Approx. weight 375 LBS. Dimensions 172.5 x 48.4 in."],
    [project.id, "221457_SPEC_Div23.pdf", "Shop drawings shall indicate rooftop unit dimensions and weight loading."],
    [other.id, "224070_SUB_Custom_AHUs.pdf", "AHU-C1 unit shipping weight 6,200 lbs, dimensions 240 x 96 in."],
  ];
  for (const [projectId, fileName, content] of files) {
    n += 1;
    const d = await testDb.kbDocument.create({
      data: {
        projectId, sourceKind: "local", sourceId: `d-${n}`, path: `11 - SUBMITTALS/${fileName}`, fileName,
        fileType: "pdf", familyKey: fileName, status: "indexed", chunkCount: 1,
      },
    });
    await testDb.$executeRawUnsafe(
      `INSERT INTO kb_chunks (id, document_id, ordinal, content, page_start, page_end) VALUES (gen_random_uuid(), $1::uuid, 0, $2, 4, 4)`,
      d.id,
      content,
    );
  }
  return { project, other };
}

/** Haiku that keeps the RTU passages, best first. */
const rerankRtu: KbReranker = async (_q, passages) =>
  passages
    .filter((p) => p.fileName.includes("RTU") || p.fileName.includes("SPEC"))
    .sort((a, b) => (a.fileName.includes("RTU") ? -1 : 1) - (b.fileName.includes("RTU") ? -1 : 1))
    .map((p) => p.n);

function recordingAnswerer(answer: string, extra: Partial<{ kind: "answered" | "no_evidence"; missing: string | null }> = {}) {
  const calls: { question: string; passages: KbAnswerPassage[]; priorTurns: KbPriorTurn[] }[] = [];
  const answerer: KbAnswerer = async (input) => {
    calls.push(input);
    return {
      draft: { kind: extra.kind ?? "answered", answer, missing: extra.missing ?? null, conflicts: [] },
      model: "claude-sonnet-5-5",
    };
  };
  return { calls, answerer };
}

const freshLimiter = () => new QuestionRateLimiter({ limit: 100, windowMs: 60_000 });

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await resetDb();
  await testDb.module.create({ data: { key: KNOWLEDGE_BASE_MODULE_KEY, displayName: "Knowledge Base", sortOrder: 400 } });
});

describe("askQuestion", () => {
  it("answers from the passages Haiku kept, renumbers the citations, and saves it with its sources", async () => {
    await seed();
    const me = await createEmployee({ firstName: "Karthik", lastName: "R" });
    const { calls, answerer } = recordingAnswerer("RTU-3 weighs about 375 LBS [1]. The spec asks for the weight on shop drawings [2].");

    const { asked, search } = await askQuestion({
      employeeId: me.id,
      question: "rooftop unit weight",
      deps: { answerer, reranker: rerankRtu, queryEmbedder: null, limiter: freshLimiter() },
    });

    // Sonnet read only what Haiku kept, in Haiku's order.
    expect(calls[0]?.passages.map((p) => [p.n, p.fileName])).toEqual([
      [1, "221457_SUB_Packaged_RTUs_Approved.pdf"],
      [2, "221457_SPEC_Div23.pdf"],
    ]);
    expect(calls[0]?.passages[0]).toMatchObject({ where: "Page 4", version: "Current version", content: expect.stringContaining("375 LBS") });
    expect(search.reranked).toBe(true);

    expect(asked).toMatchObject({
      ordinal: 0,
      question: "rooftop unit weight",
      askedBy: { id: me.id, name: "Karthik R" },
      model: "claude-sonnet-5-5",
      scope: { how: "all", projectIds: [] },
      answer: {
        version: 1,
        kind: "answered",
        text: "RTU-3 weighs about 375 LBS [1]. The spec asks for the weight on shop drawings [2].",
        considered: 2,
        searchedFor: "rooftop unit weight",
      },
    });
    expect(asked.answer.sources.map((s) => [s.n, s.fileName, s.pageStart])).toEqual([
      [1, "221457_SUB_Packaged_RTUs_Approved.pdf", 4],
      [2, "221457_SPEC_Div23.pdf", 4],
    ]);
    expect(asked.answer.sources[0]?.excerpt).toContain("375 LBS");

    const rows = await testDb.kbQuestionSource.findMany({ orderBy: { n: "asc" } });
    expect(rows.map((r) => r.n)).toEqual([1, 2]);
    expect(rows.every((r) => r.chunkId !== null && r.documentId !== null)).toBe(true);
  });

  it("says no evidence without calling Sonnet when Haiku keeps nothing", async () => {
    await seed();
    const me = await createEmployee();
    const { calls, answerer } = recordingAnswerer("never");
    const { asked } = await askQuestion({
      employeeId: me.id,
      question: "rooftop unit weight",
      deps: { answerer, reranker: async () => [], queryEmbedder: null, limiter: freshLimiter() },
    });
    expect(calls).toHaveLength(0);
    expect(asked).toMatchObject({ model: null, answer: { kind: "no_evidence", sources: [], considered: 0 } });
    expect(await testDb.kbQuestion.count()).toBe(1);
  });

  it("refuses without a key and saves nothing", async () => {
    await seed();
    const me = await createEmployee();
    await expect(
      askQuestion({ employeeId: me.id, question: "weight", deps: { answerer: null, limiter: freshLimiter() } }),
    ).rejects.toMatchObject({ code: "not_configured" });
    expect(await testDb.kbConversation.count()).toBe(0);
  });

  it("saves nothing when the answer fails", async () => {
    await seed();
    const me = await createEmployee();
    await expect(
      askQuestion({
        employeeId: me.id,
        question: "rooftop unit weight",
        deps: {
          answerer: async () => {
            throw new Error("529 overloaded");
          },
          reranker: rerankRtu,
          queryEmbedder: null,
          limiter: freshLimiter(),
        },
      }),
    ).rejects.toMatchObject({ code: "answer_failed" });
    expect(await testDb.kbQuestion.count()).toBe(0);
  });

  it("answers a follow-up in the same conversation: rewritten for the search, earlier projects kept", async () => {
    const { project } = await seed();
    const me = await createEmployee();
    const limiter = freshLimiter();
    const first = await askQuestion({
      employeeId: me.id,
      question: "rooftop unit weight 221457",
      deps: { ...recordingAnswerer("375 LBS [1].") , reranker: rerankRtu, queryEmbedder: null, limiter },
    });
    expect(first.asked.scope).toEqual({ how: "from_question", projectIds: [project.id] });

    const seenByCondenser: KbPriorTurn[][] = [];
    const { calls, answerer } = recordingAnswerer("172.5 x 48.4 in [1].");
    const second = await askQuestion({
      employeeId: me.id,
      conversationId: first.asked.conversationId,
      question: "and its dimensions?",
      deps: {
        answerer,
        condenser: async (turns) => {
          seenByCondenser.push(turns);
          return "rooftop unit dimensions";
        },
        reranker: rerankRtu,
        queryEmbedder: null,
        limiter,
      },
    });

    expect(seenByCondenser[0]).toEqual([{ question: "rooftop unit weight 221457", answer: "375 LBS [1]." }]);
    expect(calls[0]?.priorTurns).toEqual([{ question: "rooftop unit weight 221457", answer: "375 LBS [1]." }]);
    expect(calls[0]?.question).toBe("and its dimensions?");
    expect(second.asked).toMatchObject({
      ordinal: 1,
      conversationId: first.asked.conversationId,
      scope: { how: "follow_up", projectIds: [project.id] },
      answer: { searchedFor: "rooftop unit dimensions" },
    });
    // The other project's AHU never reached the answer.
    expect(calls[0]?.passages.every((p) => p.projectFolder === "221457_MAGNODE")).toBe(true);
  });

  it("falls back to the last question plus the follow-up when the rewrite fails", async () => {
    await seed();
    const me = await createEmployee();
    const limiter = freshLimiter();
    const first = await askQuestion({
      employeeId: me.id,
      question: "rooftop unit weight",
      deps: { ...recordingAnswerer("375 LBS [1]."), reranker: rerankRtu, queryEmbedder: null, limiter },
    });
    const second = await askQuestion({
      employeeId: me.id,
      conversationId: first.asked.conversationId,
      question: "dimensions?",
      deps: {
        ...recordingAnswerer("172.5 in [1]."),
        condenser: async () => {
          throw new Error("timeout");
        },
        reranker: rerankRtu,
        queryEmbedder: null,
        limiter,
      },
    });
    expect(second.asked.answer.searchedFor).toBe("rooftop unit weight dimensions?");
  });

  it("lets only the starter add to a conversation", async () => {
    await seed();
    const me = await createEmployee();
    const someoneElse = await createEmployee();
    const first = await askQuestion({
      employeeId: me.id,
      question: "rooftop unit weight",
      deps: { ...recordingAnswerer("375 LBS [1]."), reranker: rerankRtu, queryEmbedder: null, limiter: freshLimiter() },
    });
    await expect(
      askQuestion({
        employeeId: someoneElse.id,
        conversationId: first.asked.conversationId,
        question: "and RTU-2?",
        deps: { ...recordingAnswerer("x [1]."), reranker: rerankRtu, queryEmbedder: null, limiter: freshLimiter() },
      }),
    ).rejects.toMatchObject({ code: "not_your_conversation" });
  });

  it("limits questions per person per minute", async () => {
    await seed();
    const me = await createEmployee();
    const limiter = new QuestionRateLimiter({ limit: 1, windowMs: 60_000 });
    const deps = { ...recordingAnswerer("375 LBS [1]."), reranker: rerankRtu, queryEmbedder: null, limiter };
    await askQuestion({ employeeId: me.id, question: "rooftop unit weight", deps });
    const refused = await askQuestion({ employeeId: me.id, question: "rooftop unit weight", deps }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(KbAskError);
    expect(refused).toMatchObject({ code: "rate_limited" });
  });
});

describe("the shared history", () => {
  it("shows everyone's conversations, newest first, pages without repeats, and says whose each is", async () => {
    await seed();
    const a = await createEmployee({ firstName: "Ann", lastName: "A" });
    const b = await createEmployee({ firstName: "Bob", lastName: "B" });
    const limiter = freshLimiter();
    const ask = (employeeId: string, question: string) =>
      askQuestion({ employeeId, question, deps: { ...recordingAnswerer("375 LBS [1]."), reranker: rerankRtu, queryEmbedder: null, limiter } });
    await ask(a.id, "rooftop unit weight one");
    await ask(b.id, "rooftop unit weight two");
    const third = await ask(a.id, "rooftop unit weight three");

    const all = await listConversations({});
    expect(all.map((c) => [c.firstQuestion, c.startedBy?.name])).toEqual([
      ["rooftop unit weight three", "Ann A"],
      ["rooftop unit weight two", "Bob B"],
      ["rooftop unit weight one", "Ann A"],
    ]);
    const page1 = await listConversations({ limit: 2 });
    const last = page1.at(-1)!;
    const page2 = await listConversations({ limit: 2, before: { updatedAt: new Date(last.updatedAt), id: last.id } });
    expect([...page1, ...page2].map((c) => c.firstQuestion)).toEqual(all.map((c) => c.firstQuestion));
    expect((await listConversations({ employeeId: b.id })).map((c) => c.firstQuestion)).toEqual(["rooftop unit weight two"]);

    const mine = await getConversation(third.asked.conversationId, a.id);
    const theirs = await getConversation(third.asked.conversationId, b.id);
    expect(mine).toMatchObject({ mine: true, startedBy: { name: "Ann A" } });
    expect(theirs?.mine).toBe(false);
    expect(theirs?.questions.map((q) => q.answer.text)).toEqual(["375 LBS [1]."]);
  });
});

describe("the routes", () => {
  async function signIn() {
    const employee = await createEmployee();
    await grantModule(employee.id, KNOWLEDGE_BASE_MODULE_KEY);
    authMock.mockResolvedValue({
      entraOid: employee.entraOid,
      issuedAt: Math.floor(Date.now() / 1000),
      user: {},
      expires: new Date(Date.now() + 3_600_000).toISOString(),
    } as unknown as Session as never);
    return employee;
  }
  const post = (body: unknown) =>
    askRoute(
      new Request("http://localhost/api/modules/knowledge-base/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  it("ask: 422 for a bad body, 503 without a key (tests never reach Anthropic)", async () => {
    await signIn();
    for (const body of [{}, { question: "" }, { question: "x".repeat(501) }, { question: "ok", extra: 1 }, { question: "ok", conversationId: "nope" }]) {
      expect((await post(body)).status).toBe(422);
    }
    const response = await post({ question: "rooftop unit weight" });
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("not_configured");
  });

  it("history: lists everyone's, opens one, 404 for an unknown id, 404 without the grant", async () => {
    await seed();
    const asker = await createEmployee();
    const { asked } = await askQuestion({
      employeeId: asker.id,
      question: "rooftop unit weight",
      deps: { ...recordingAnswerer("375 LBS [1]."), reranker: rerankRtu, queryEmbedder: null, limiter: freshLimiter() },
    });
    await signIn();
    const list = await historyRoute(new Request("http://localhost/api/modules/knowledge-base/history"));
    expect((await list.json()).data.map((c: { id: string }) => c.id)).toEqual([asked.conversationId]);
    const one = await conversationRoute(new Request("http://localhost/x"), { params: Promise.resolve({ id: asked.conversationId }) });
    expect((await one.json()).data).toMatchObject({ mine: false, questions: [{ question: "rooftop unit weight" }] });
    const missing = await conversationRoute(new Request("http://localhost/x"), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000000" }),
    });
    expect(missing.status).toBe(404);
    expect((await historyRoute(new Request("http://localhost/api/modules/knowledge-base/history?before=2026-01-01T00:00:00Z"))).status).toBe(422);

    const outsider = await createEmployee();
    authMock.mockResolvedValue({
      entraOid: outsider.entraOid,
      issuedAt: Math.floor(Date.now() / 1000),
      user: {},
      expires: new Date(Date.now() + 3_600_000).toISOString(),
    } as unknown as Session as never);
    expect((await historyRoute(new Request("http://localhost/api/modules/knowledge-base/history"))).status).toBe(404);
  });
});
