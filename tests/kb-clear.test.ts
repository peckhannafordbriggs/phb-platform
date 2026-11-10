import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Only the session is mocked. The guard and the delete are real.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { POST } from "@/app/api/modules/knowledge-base/index/clear/route";
import { clearKbIndex } from "@/lib/modules/knowledge-base/clear";
import { KNOWLEDGE_BASE_MODULE_KEY } from "@/lib/modules/knowledge-base/constants";
import { KbSyncInProgressError } from "@/lib/modules/knowledge-base/sync";
import { createEmployee, disconnectDb, grantModule, grantModuleAdmin, resetDb, testDb } from "./db";

/**
 * Clearing the index removes everything derived and nothing that is the
 * platform's own record: the question history keeps its rows, with only its
 * links into the index gone NULL, and the sync history stays.
 */

const authMock = vi.mocked(auth);
afterAll(disconnectDb);

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

const clear = (body: unknown) =>
  POST(
    new Request("http://localhost/api/modules/knowledge-base/index/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

/** An index of one project, one file, two passages, and a question citing one of them. */
async function seed() {
  const asker = await createEmployee();
  const project = await testDb.kbProject.create({
    data: { sourceKind: "local", sourceId: "p", folderName: "224070_UC_OLD_CHEM", projectNumber: "224070", name: "UC", isLegacy: true },
  });
  const doc = await testDb.kbDocument.create({
    data: {
      projectId: project.id, sourceKind: "local", sourceId: "d", path: "11 - SUBMITTALS/a.pdf", fileName: "a.pdf",
      fileType: "pdf", familyKey: "a", status: "indexed", chunkCount: 2,
    },
  });
  await testDb.$executeRawUnsafe(
    `INSERT INTO kb_chunks (id, document_id, ordinal, content) VALUES (gen_random_uuid(), $1::uuid, 0, 'one'), (gen_random_uuid(), $1::uuid, 1, 'two')`,
    doc.id,
  );
  const chunk = await testDb.kbChunk.findFirstOrThrow({ where: { documentId: doc.id, ordinal: 0 } });
  const conversation = await testDb.kbConversation.create({ data: { employeeId: asker.id } });
  const question = await testDb.kbQuestion.create({
    data: {
      conversationId: conversation.id, ordinal: 0, question: "What is AV-1?", scopeProjectIds: [], scopeHow: "all",
      answerKind: "answered", answer: { text: "AV-1 is a supply valve [1]." },
    },
  });
  await testDb.kbQuestionSource.create({ data: { questionId: question.id, n: 1, documentId: doc.id, chunkId: chunk.id } });
  await testDb.kbSyncRun.create({ data: { sourceKind: "local", trigger: "manual", status: "ok", finishedAt: new Date() } });
  return { question };
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  await resetDb();
  await testDb.module.create({ data: { key: KNOWLEDGE_BASE_MODULE_KEY, displayName: "Knowledge Base", sortOrder: 400 } });
});

describe("clearKbIndex", () => {
  it("removes projects, files and passages, and keeps the history and the sync record", async () => {
    const { question } = await seed();

    expect(await clearKbIndex({ actorId: null })).toEqual({ projects: 1, documents: 1, chunks: 2 });

    expect(await testDb.kbProject.count()).toBe(0);
    expect(await testDb.kbDocument.count()).toBe(0);
    expect(await testDb.kbChunk.count()).toBe(0);
    expect(await testDb.kbQuestion.findUniqueOrThrow({ where: { id: question.id } })).toMatchObject({
      answer: { text: "AV-1 is a supply valve [1]." },
    });
    expect(await testDb.kbQuestionSource.findFirstOrThrow()).toMatchObject({ n: 1, documentId: null, chunkId: null });
    expect(await testDb.kbSyncRun.count()).toBe(1);
  });

  it("is refused while a sync is queued or running, and removes nothing", async () => {
    await seed();
    await testDb.kbSyncRun.create({ data: { sourceKind: "local", trigger: "manual", status: "queued" } });
    await expect(clearKbIndex({ actorId: null })).rejects.toBeInstanceOf(KbSyncInProgressError);
    expect(await testDb.kbChunk.count()).toBe(2);
  });
});

describe("POST /api/modules/knowledge-base/index/clear", () => {
  it("404 for someone with the module but not module admin", async () => {
    await seed();
    await signIn({ admin: false });
    expect((await clear({ confirm: "clear" })).status).toBe(404);
    expect(await testDb.kbChunk.count()).toBe(2);
  });

  it("422 without the confirmation word, and removes nothing", async () => {
    await seed();
    await signIn({ admin: true });
    for (const body of [{}, { confirm: "yes" }, { confirm: "clear", also: 1 }, null]) {
      expect((await clear(body)).status).toBe(422);
    }
    expect(await testDb.kbChunk.count()).toBe(2);
  });

  it("clears for a module admin and records who did it", async () => {
    await seed();
    const me = await signIn({ admin: true });
    const response = await clear({ confirm: "clear" });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ projects: 1, documents: 1, chunks: 2 });
    expect(await testDb.auditEvent.findFirstOrThrow({ where: { action: "kb.index_cleared" } })).toMatchObject({
      actorEmployeeId: me.id,
      moduleKey: KNOWLEDGE_BASE_MODULE_KEY,
      metadata: { projects: 1, documents: 1, chunks: 2 },
    });
  });

  it("409 while a sync is running", async () => {
    await seed();
    await signIn({ admin: true });
    await testDb.kbSyncRun.create({ data: { sourceKind: "local", trigger: "manual", status: "running" } });
    expect((await clear({ confirm: "clear" })).status).toBe(409);
  });
});
