import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Only the session is mocked. The guard and the search are real.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { GET } from "@/app/api/modules/knowledge-base/search/route";
import { KNOWLEDGE_BASE_MODULE_KEY } from "@/lib/modules/knowledge-base/constants";
import { createEmployee, disconnectDb, grantModule, resetDb, testDb } from "./db";

const authMock = vi.mocked(auth);
const get = (query: string) => GET(new Request(`http://localhost/api/modules/knowledge-base/search?${query}`));

async function signIn(grant: boolean) {
  const employee = await createEmployee();
  if (grant) await grantModule(employee.id, KNOWLEDGE_BASE_MODULE_KEY);
  authMock.mockResolvedValue({
    entraOid: employee.entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  await resetDb();
  await testDb.module.create({ data: { key: KNOWLEDGE_BASE_MODULE_KEY, displayName: "Knowledge Base", sortOrder: 400 } });
  const p = await testDb.kbProject.create({
    data: { sourceKind: "local", sourceId: "p", folderName: "224070_UC_OLD_CHEM", projectNumber: "224070", name: "UC", isLegacy: true },
  });
  const d = await testDb.kbDocument.create({
    data: {
      projectId: p.id, sourceKind: "local", sourceId: "d", path: "11 - SUBMITTALS/a.pdf", fileName: "a.pdf",
      fileType: "pdf", familyKey: "a", status: "indexed", chunkCount: 1,
    },
  });
  await testDb.$executeRawUnsafe(
    `INSERT INTO kb_chunks (id, document_id, ordinal, content) VALUES (gen_random_uuid(), $1::uuid, 0, 'AV-1 1200 CFM')`,
    d.id,
  );
});

afterAll(disconnectDb);

describe("GET /api/modules/knowledge-base/search", () => {
  it("401 with no session, 404 without the grant", async () => {
    authMock.mockResolvedValue(null as never);
    expect((await get("q=AV-1")).status).toBe(401);
    await signIn(false);
    expect((await get("q=AV-1")).status).toBe(404);
  });

  it("searches for anyone with the grant; module admin is not needed", async () => {
    await signIn(true);
    const response = await get("q=AV-1%20CFM");
    expect(response.status).toBe(200);
    expect((await response.json()).data.hits).toHaveLength(1);
  });

  it("422 for an empty, over-long or badly scoped query", async () => {
    await signIn(true);
    expect((await get("q=%20%20")).status).toBe(422);
    expect((await get(`q=${"x".repeat(301)}`)).status).toBe(422);
    expect((await get("q=AV-1&project=not-a-uuid")).status).toBe(422);
  });
});
