import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KB_EMBEDDING_MODEL,
  KbEmbeddingError,
  azureEmbedder,
  embeddingInput,
  embeddingsUrl,
  type EmbeddingFetch,
  type KbEmbedder,
} from "@/lib/modules/knowledge-base/embed";
import { KB_EMBED_BATCH, embedPending } from "@/lib/modules/knowledge-base/embedder";
import { localKbSource } from "@/lib/modules/knowledge-base/source";
import { syncKnowledgeBase } from "@/lib/modules/knowledge-base/sync";
import { KB_EMBEDDING_DIMENSIONS } from "@/lib/modules/knowledge-base/vector";
import { disconnectDb, resetDb, testDb } from "./db";
import { writePdf } from "./kb-fixtures";

/**
 * The embedding client against a fake of Azure's endpoint, and the backlog
 * embedder and sync step against the test database with a fake embedder. No
 * test reaches Azure: tests/setup.ts clears the KB_EMBEDDING_* variables.
 */

const ENV = { endpoint: "https://phb-kb.cognitiveservices.azure.com", deployment: "text-embedding-3-small", apiKey: "k" };

/** A deterministic unit vector per text, so similar inputs are not assumed. */
function vectorFor(text: string): number[] {
  const v = new Array<number>(KB_EMBEDDING_DIMENSIONS).fill(0);
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % KB_EMBEDDING_DIMENSIONS;
  v[h] = 1;
  return v;
}

function fakeAzure(responses: Array<(body: { input: string[]; model: string }) => Response>) {
  const calls: { url: string; headers: Record<string, string>; body: { input: string[]; model: string } }[] = [];
  const fetchImpl: EmbeddingFetch = async (url, init) => {
    const body = JSON.parse(String(init.body)) as { input: string[]; model: string };
    calls.push({ url, headers: init.headers as Record<string, string>, body });
    const next = responses.length > 1 ? responses.shift()! : responses[0]!;
    return next(body);
  };
  return { fetchImpl, calls };
}

const okResponse = (body: { input: string[] }) =>
  Response.json({
    data: body.input.map((t, index) => ({ index, embedding: vectorFor(t) })).reverse(),
    usage: { prompt_tokens: body.input.length * 10, total_tokens: body.input.length * 10 },
  });

describe("embeddingsUrl", () => {
  it("uses only the host, so a base URL and a Foundry Target URI both work", () => {
    expect(embeddingsUrl("https://phb-kb.cognitiveservices.azure.com/")).toBe(
      "https://phb-kb.cognitiveservices.azure.com/openai/v1/embeddings",
    );
    expect(
      embeddingsUrl(
        "https://phb-kb.openai.azure.com/openai/deployments/text-embedding-3-small/embeddings?api-version=2023-05-15",
      ),
    ).toBe("https://phb-kb.openai.azure.com/openai/v1/embeddings");
  });
});

describe("azureEmbedder", () => {
  it("sends the deployment as the model with the api key, and returns vectors in input order", async () => {
    const { fetchImpl, calls } = fakeAzure([okResponse]);
    const result = await azureEmbedder(ENV, { fetchImpl })(["first", "second"]);

    expect(calls[0]).toMatchObject({
      url: "https://phb-kb.cognitiveservices.azure.com/openai/v1/embeddings",
      headers: { "api-key": "k" },
      body: { model: "text-embedding-3-small", input: ["first", "second"] },
    });
    expect(result.vectors).toEqual([vectorFor("first"), vectorFor("second")]);
    expect(result.tokens).toBe(20);
  });

  it("uses a bearer token, not a key, when there is no key", async () => {
    const { fetchImpl, calls } = fakeAzure([okResponse]);
    await azureEmbedder({ ...ENV, apiKey: null }, { fetchImpl, getToken: async () => "tok" })(["x"]);
    expect(calls[0]?.headers).toMatchObject({ Authorization: "Bearer tok" });
    expect(calls[0]?.headers).not.toHaveProperty("api-key");
  });

  it("outside production, with no key, says to set one instead of asking a managed identity that is not there", () => {
    expect(() => azureEmbedder({ ...ENV, apiKey: null })).toThrow(/KB_EMBEDDING_API_KEY/);
  });

  it("waits out a 429 for as long as Azure says, then carries on", async () => {
    const sleep = vi.fn(async () => {});
    const { fetchImpl, calls } = fakeAzure([
      () => new Response("{}", { status: 429, headers: { "retry-after": "7" } }),
      okResponse,
    ]);
    const result = await azureEmbedder(ENV, { fetchImpl, sleep })(["x"]);
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(7000);
    expect(result.vectors).toHaveLength(1);
  });

  it("refuses with Azure's reason and a hint on 401, without retrying", async () => {
    const { fetchImpl, calls } = fakeAzure([
      () => Response.json({ error: { code: "401", message: "Access denied due to invalid subscription key" } }, { status: 401 }),
    ]);
    await expect(azureEmbedder(ENV, { fetchImpl })(["x"])).rejects.toThrow(/invalid subscription key.*KB_EMBEDDING_API_KEY/);
    expect(calls).toHaveLength(1);
  });

  it("names the network reason behind fetch failed, and does not retry a certificate refusal", async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const fetchImpl: EmbeddingFetch = async () => {
      calls += 1;
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("unable to get local issuer certificate"), { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" }),
      });
    };
    await expect(azureEmbedder(ENV, { fetchImpl, sleep })(["x"])).rejects.toThrow(
      /unable to get local issuer certificate.*--use-system-ca/,
    );
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a connection reset, then gives up with the code", async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl: EmbeddingFetch = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
    };
    await expect(azureEmbedder(ENV, { fetchImpl, sleep })(["x"])).rejects.toThrow(/socket hang up \(ECONNRESET\)/);
    expect(sleep).toHaveBeenCalledTimes(5);
  });

  it("refuses vectors of the wrong width, naming the deployment", async () => {
    const { fetchImpl } = fakeAzure([() => Response.json({ data: [{ index: 0, embedding: [1, 2, 3] }] })]);
    await expect(azureEmbedder(ENV, { fetchImpl })(["x"])).rejects.toThrow(/3-dimension vectors.*text-embedding-3-small/);
  });

  it("refuses a reply that is missing embeddings", async () => {
    const { fetchImpl } = fakeAzure([() => Response.json({ data: [] })]);
    await expect(azureEmbedder(ENV, { fetchImpl })(["x", "y"])).rejects.toBeInstanceOf(KbEmbeddingError);
  });
});

describe("embeddingInput", () => {
  it("leads with the file and where in it, so a question about the submittal finds the page", () => {
    expect(
      embeddingInput({
        content: "AV-1 1,200 CFM",
        fileName: "224070_SUB_Air_Valves_Approved_20241121.pdf",
        projectFolder: "224070_UC_OLD_CHEM",
        pageStart: 14,
        pageEnd: 14,
        section: null,
        sheet: null,
        cellRange: null,
      }),
    ).toBe("224070 SUB Air Valves Approved 20241121 (224070_UC_OLD_CHEM, page 14)\nAV-1 1,200 CFM");
  });
});

// ---------------------------------------------------------------------------
// Against the database
// ---------------------------------------------------------------------------

afterAll(disconnectDb);

let n = 0;
async function indexedDocument(passages: number, isLatest = true) {
  n += 1;
  const project = await testDb.kbProject.upsert({
    where: { sourceKind_sourceId: { sourceKind: "local", sourceId: "p" } },
    create: { sourceKind: "local", sourceId: "p", folderName: "224070_UC_OLD_CHEM", projectNumber: "224070", name: "UC", isLegacy: true },
    update: {},
  });
  const doc = await testDb.kbDocument.create({
    data: {
      projectId: project.id,
      sourceKind: "local",
      sourceId: `d-${n}`,
      path: `11 - SUBMITTALS/doc-${n}.pdf`,
      fileName: `doc-${n}.pdf`,
      fileType: "pdf",
      familyKey: `doc-${n}`,
      isLatest,
      status: "indexed",
      chunkCount: passages,
    },
  });
  for (let i = 0; i < passages; i += 1) {
    await testDb.$executeRawUnsafe(
      `INSERT INTO kb_chunks (id, document_id, ordinal, content, page_start, page_end) VALUES (gen_random_uuid(), $1::uuid, $2, $3, $2 + 1, $2 + 1)`,
      doc.id,
      i,
      `Passage ${i} of document ${n}`,
    );
  }
  return doc;
}

const fakeEmbedder = (): { embedder: KbEmbedder; batches: string[][] } => {
  const batches: string[][] = [];
  return {
    batches,
    embedder: async (texts) => {
      batches.push(texts);
      return { vectors: texts.map(vectorFor), tokens: texts.length * 10 };
    },
  };
};

const unembedded = async () =>
  (await testDb.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM kb_chunks WHERE embedding IS NULL`))[0]!.n;

describe("embedPending", () => {
  beforeEach(resetDb);

  it("embeds every passage without a vector, in batches, current versions first, and marks the documents", async () => {
    const old = await indexedDocument(3, false);
    const current = await indexedDocument(KB_EMBED_BATCH + 2);
    const { embedder, batches } = fakeEmbedder();

    const counts = await embedPending({ embedder });

    expect(counts).toEqual({ chunksEmbedded: KB_EMBED_BATCH + 5, embeddingTokens: (KB_EMBED_BATCH + 5) * 10 });
    expect(batches.map((b) => b.length)).toEqual([KB_EMBED_BATCH, 5]);
    expect(batches[0]?.[0]).toMatch(new RegExp(`^${current.fileName.replace(".pdf", "")}`));
    expect(await unembedded()).toBe(0);
    const models = await testDb.kbDocument.findMany({ select: { id: true, embeddingModel: true } });
    expect(models.every((m) => m.embeddingModel === KB_EMBEDDING_MODEL)).toBe(true);
    const [row] = await testDb.$queryRawUnsafe<{ embedding_model: string }[]>(
      `SELECT embedding_model FROM kb_chunks WHERE document_id = $1::uuid LIMIT 1`,
      old.id,
    );
    expect(row?.embedding_model).toBe(KB_EMBEDDING_MODEL);
  });

  it("does nothing, and asks nothing of Azure, when every passage has a vector", async () => {
    await indexedDocument(2);
    await embedPending({ embedder: fakeEmbedder().embedder });
    const { embedder, batches } = fakeEmbedder();
    expect(await embedPending({ embedder })).toEqual({ chunksEmbedded: 0, embeddingTokens: 0 });
    expect(batches).toEqual([]);
  });

  it("never embeds a passage of a document that is not indexed", async () => {
    const doc = await indexedDocument(2);
    await testDb.kbDocument.update({ where: { id: doc.id }, data: { status: "pending", chunkCount: 0 } });
    const { embedder, batches } = fakeEmbedder();
    await embedPending({ embedder });
    expect(batches).toEqual([]);
  });

  it("keeps what it wrote when Azure refuses part way, and the next run continues", async () => {
    await indexedDocument(KB_EMBED_BATCH + 10);
    let call = 0;
    const flaky: KbEmbedder = async (texts) => {
      call += 1;
      if (call === 2) throw new KbEmbeddingError("Azure OpenAI answered 429 (quota).", 429);
      return { vectors: texts.map(vectorFor), tokens: 1 };
    };
    await expect(embedPending({ embedder: flaky })).rejects.toThrow(/quota/);
    expect(await unembedded()).toBe(10);

    const counts = await embedPending({ embedder: fakeEmbedder().embedder });
    expect(counts.chunksEmbedded).toBe(10);
    expect(await unembedded()).toBe(0);
  });
});

describe("syncKnowledgeBase embeds as its last step", () => {
  let dir: string;
  beforeEach(async () => {
    await resetDb();
    dir = await mkdtemp(path.join(tmpdir(), "zztest-kb-embed-"));
    await mkdir(path.join(dir, "224070_UC_OLD_CHEM", "11 - SUBMITTALS"), { recursive: true });
    await writePdf(path.join(dir, "224070_UC_OLD_CHEM", "11 - SUBMITTALS", "224070_SUB_Air_Valves_Approved_20241121.pdf"), [
      "Air valves submittal\nAV-1 1200 CFM supply",
    ]);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const sync = (embedder?: KbEmbedder) =>
    syncKnowledgeBase({ trigger: "manual", triggeredById: null, source: localKbSource(dir), ...(embedder ? { embedder } : {}) });

  it("embeds what it indexed and records it on the run", async () => {
    const outcome = await sync(fakeEmbedder().embedder);
    expect(outcome).toMatchObject({ status: "ok", filesIndexed: 1, chunksEmbedded: 1, embedding: { state: "done" } });
    expect(await testDb.kbSyncRun.findFirstOrThrow()).toMatchObject({
      chunksEmbedded: 1,
      embeddingTokens: 10,
      embeddingModel: KB_EMBEDDING_MODEL,
    });
    expect(await unembedded()).toBe(0);
  });

  it("says embedding is not configured, and is still ok, when the variables are absent", async () => {
    const outcome = await sync();
    expect(outcome).toMatchObject({ status: "ok", chunksEmbedded: 0, embedding: { state: "not_configured" } });
    expect(await unembedded()).toBe(1);
  });

  it("is partial with the reason when Azure refuses, and keeps the index", async () => {
    const outcome = await sync(async () => {
      throw new KbEmbeddingError("Azure OpenAI answered 403 (no role).", 403);
    });
    expect(outcome).toMatchObject({ status: "partial", filesIndexed: 1, embedding: { state: "stopped" } });
    expect((await testDb.kbSyncRun.findFirstOrThrow()).error).toMatch(/Embedding stopped after 0 passages: .*403/);
    expect(await testDb.kbDocument.findFirstOrThrow()).toMatchObject({ status: "indexed", embeddingModel: null });
  });
});
