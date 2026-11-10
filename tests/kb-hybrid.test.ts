import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  KB_MIN_SIMILARITY,
  KB_SEARCH_PER_DOCUMENT,
  searchPassages,
  type KbQueryEmbedder,
} from "@/lib/modules/knowledge-base/search";
import { KB_EMBEDDING_DIMENSIONS, toVectorLiteral } from "@/lib/modules/knowledge-base/vector";
import { disconnectDb, resetDb, testDb } from "./db";

/**
 * Keyword and meaning search fused by rank, against passages with vectors
 * written straight into the index. Vectors are built by hand on a few axes so
 * every similarity is known exactly: a passage on the question's axis is a
 * perfect match, an orthogonal one is unrelated.
 */

afterAll(disconnectDb);
beforeEach(async () => {
  await resetDb();
});

/** A unit vector mostly along `axis`, with `weight` of it and the rest on axis 1000. */
function vec(axis: number, weight = 1): number[] {
  const v = new Array<number>(KB_EMBEDDING_DIMENSIONS).fill(0);
  v[axis] = weight;
  if (weight < 1) v[1000] = Math.sqrt(1 - weight * weight);
  return v;
}

/** An embedder that maps known questions to known vectors. */
const embedderFor =
  (table: Record<string, number[]>): KbQueryEmbedder =>
  async (text) => {
    const v = table[text];
    if (!v) throw new Error(`no vector for "${text}" in the test`);
    return v;
  };

let n = 0;
async function project(folderName = "224070_UC_OLD_CHEM") {
  n += 1;
  return testDb.kbProject.create({
    data: {
      sourceKind: "local",
      sourceId: `p-${n}`,
      folderName,
      projectNumber: /^(\d{6})_/.exec(folderName)?.[1] ?? null,
      name: folderName,
      isLegacy: true,
    },
  });
}

async function doc(
  projectId: string,
  fileName: string,
  passages: { content: string; vector: number[] | null }[],
  flags: { isLatest?: boolean; isArchived?: boolean } = {},
) {
  n += 1;
  const d = await testDb.kbDocument.create({
    data: {
      projectId,
      sourceKind: "local",
      sourceId: `d-${n}`,
      path: `11 - SUBMITTALS/${fileName}`,
      fileName,
      fileType: "pdf",
      familyKey: fileName,
      isLatest: flags.isLatest ?? true,
      isArchived: flags.isArchived ?? false,
      status: "indexed",
      chunkCount: passages.length,
    },
  });
  for (const [ordinal, p] of passages.entries()) {
    await testDb.$executeRawUnsafe(
      `INSERT INTO kb_chunks (id, document_id, ordinal, content, page_start, page_end, embedding, embedding_model)
       VALUES (gen_random_uuid(), $1::uuid, $2, $3, $2 + 1, $2 + 1, $4::vector, $5)`,
      d.id,
      ordinal,
      p.content,
      p.vector ? toVectorLiteral(p.vector) : null,
      p.vector ? "text-embedding-3-small" : null,
    );
  }
  return d;
}

describe("hybrid search", () => {
  it("finds a passage by meaning when it shares no word with the question", async () => {
    const p = await project();
    await doc(p.id, "224070_SUB_Custom_AHUs_Approved_20231222.pdf", [{ content: "AHU-1 casing and coil schedule.", vector: vec(1) }]);
    await doc(p.id, "224070_SUB_Louvers_Approved_20240410.pdf", [{ content: "Louver blade depth.", vector: vec(2) }]);

    const result = await searchPassages({
      query: "air handling unit specifications",
      queryEmbedder: embedderFor({ "air handling unit specifications": vec(1, 0.9) }),
    });

    expect(result.mode).toBe("hybrid");
    expect(result.notice).toBeNull();
    expect(result.hits.map((h) => h.fileName)).toEqual(["224070_SUB_Custom_AHUs_Approved_20231222.pdf"]);
    expect(result.hits[0]).toMatchObject({ matchedBy: "meaning", matched: [], pageStart: 1 });
    expect(result.hits[0]?.similarity).toBeCloseTo(0.9, 5);
    // Nothing to mark: the snippet is the passage's opening.
    expect(result.hits[0]?.snippet).toBe("AHU-1 casing and coil schedule.");
  });

  it("puts a passage both searches found above one only a single search found", async () => {
    const p = await project();
    await doc(p.id, "words-only.pdf", [{ content: "AV-1 noted on the cover sheet.", vector: vec(3) }]);
    await doc(p.id, "meaning-only.pdf", [{ content: "Supply valve table.", vector: vec(4, 0.95) }]);
    await doc(p.id, "both.pdf", [{ content: "AV-1 supply valve, 1,200 CFM.", vector: vec(4, 0.9) }]);

    const hits = (await searchPassages({ query: "AV-1 capacity", queryEmbedder: embedderFor({ "AV-1 capacity": vec(4) }) })).hits;

    expect(hits[0]).toMatchObject({ fileName: "both.pdf", matchedBy: "both" });
    expect(hits.map((h) => h.matchedBy).sort()).toEqual(["both", "meaning", "words"]);
  });

  it("ignores nearest neighbours that are not similar enough to be evidence", async () => {
    const p = await project();
    await doc(p.id, "unrelated.pdf", [{ content: "Sound attenuator lengths.", vector: vec(5) }]);
    await doc(p.id, "weak.pdf", [{ content: "Hangers and supports.", vector: vec(6, KB_MIN_SIMILARITY - 0.05) }]);

    const result = await searchPassages({ query: "glycol makeup", queryEmbedder: embedderFor({ "glycol makeup": vec(6) }) });

    expect(result.hits).toEqual([]);
  });

  it("searches by meaning alone when every word is a stop word", async () => {
    const p = await project();
    await doc(p.id, "a.pdf", [{ content: "Scope of the mechanical work.", vector: vec(7) }]);
    const result = await searchPassages({ query: "what is it about", queryEmbedder: embedderFor({ "what is it about": vec(7) }) });
    expect(result.terms).toEqual([]);
    expect(result.hits.map((h) => h.matchedBy)).toEqual(["meaning"]);
  });

  it("falls back to words, and says so, when the question cannot be embedded", async () => {
    const p = await project();
    await doc(p.id, "a.pdf", [{ content: "AV-1 supply valve.", vector: vec(8) }]);

    const failing = await searchPassages({
      query: "AV-1",
      queryEmbedder: async () => {
        throw new Error("Azure OpenAI answered 429 (quota).");
      },
    });
    expect(failing).toMatchObject({ mode: "keyword", notice: expect.stringMatching(/did not answer/) });
    expect(failing.hits.map((h) => h.matchedBy)).toEqual(["words"]);

    const unconfigured = await searchPassages({ query: "AV-1", queryEmbedder: null });
    expect(unconfigured).toMatchObject({ mode: "keyword", notice: expect.stringMatching(/not configured/) });
    expect(unconfigured.hits).toHaveLength(1);
  });

  it("asks for nothing from Azure in keyword mode", async () => {
    const p = await project();
    await doc(p.id, "a.pdf", [{ content: "AV-1 supply valve.", vector: vec(8) }]);
    const result = await searchPassages({
      query: "AV-1",
      mode: "keyword",
      queryEmbedder: async () => {
        throw new Error("must not be called");
      },
    });
    expect(result).toMatchObject({ mode: "keyword", notice: null });
    expect(result.hits).toHaveLength(1);
  });

  it("still finds by words a passage that has no vector yet", async () => {
    const p = await project();
    await doc(p.id, "fresh.pdf", [{ content: "AV-1 supply valve.", vector: null }]);
    const result = await searchPassages({ query: "AV-1", queryEmbedder: embedderFor({ "AV-1": vec(9) }) });
    expect(result.hits.map((h) => [h.fileName, h.matchedBy])).toEqual([["fresh.pdf", "words"]]);
  });

  it("keeps a meaning search inside the chosen project", async () => {
    const a = await project("224070_UC_OLD_CHEM");
    const b = await project("221457_MAGNODE");
    await doc(a.id, "a.pdf", [{ content: "Fan curve.", vector: vec(10) }]);
    await doc(b.id, "b.pdf", [{ content: "Fan curve.", vector: vec(10) }]);

    const result = await searchPassages({
      query: "fan performance 221457",
      queryEmbedder: embedderFor({ "fan performance 221457": vec(10) }),
    });

    expect(result.scope.how).toBe("from_question");
    expect(result.hits.map((h) => h.projectFolder)).toEqual(["221457_MAGNODE"]);
  });

  it("puts the current version above an archived one that matches as well", async () => {
    const p = await project();
    await doc(p.id, "ARCHIVE_valves.pdf", [{ content: "Valve schedule.", vector: vec(11) }], { isLatest: false, isArchived: true });
    await doc(p.id, "valves.pdf", [{ content: "Valve schedule.", vector: vec(11) }]);

    const hits = (await searchPassages({ query: "valve schedule", queryEmbedder: embedderFor({ "valve schedule": vec(11) }) })).hits;

    expect(hits.map((h) => h.fileName)).toEqual(["valves.pdf", "ARCHIVE_valves.pdf"]);
  });

  it("still takes at most a few passages from one document", async () => {
    const p = await project();
    await doc(
      p.id,
      "spec.pdf",
      Array.from({ length: 6 }, (_, i) => ({ content: `Duct sealing, part ${i}.`, vector: vec(12) })),
    );
    const hits = (await searchPassages({ query: "duct sealing", queryEmbedder: embedderFor({ "duct sealing": vec(12) }) })).hits;
    expect(hits).toHaveLength(KB_SEARCH_PER_DOCUMENT);
  });
});

const BOILERPLATE =
  "SECTION 237388.11 PACKAGED ROOFTOP AIR CONDITIONERS. PART 1 GENERAL. 1.1 SECTION INCLUDES: packaged rooftop " +
  "air conditioners tagged on drawing MH-650 and 651. 1.2 REFERENCES: AFBMA 9 load ratings and fatigue life for " +
  "ball bearings; SMACNA HVAC duct construction standards; UL 900 test performance of air filter units. 1.3 " +
  "SUBMITTALS: shop drawings indicate assembly, unit dimensions, weight loading, required clearances, construction " +
  "details, field connection details, electrical characteristics and connection requirements.";

describe("the same text in more than one file", () => {
  it("is listed once, under the best-ranked copy, with where else it is", async () => {
    const p = await project("221457_MAGNODE");
    await doc(p.id, "221457_SPEC_Div23_20210602.pdf", [{ content: BOILERPLATE, vector: vec(13) }]);
    await doc(p.id, "221457_SUB_Packaged_RTU_9_Approved_20220203.pdf", [
      { content: `Project Silver, New Manufacturing Facility, Trenton OH. ${BOILERPLATE}`, vector: vec(13, 0.99) },
    ]);
    await doc(
      p.id,
      "ARCHIVE_221457_SUB_Packaged_RTUs_1_and_2_Rejected_20220107.pdf",
      [{ content: `Project Silver, New Manufacturing Facility. ${BOILERPLATE} Page 2`, vector: vec(13, 0.98) }],
      { isLatest: false, isArchived: true },
    );
    await doc(p.id, "221457_SUB_Packaged_RTUs_1_and_2_Approved_20220125.pdf", [
      { content: "UNIT TAG: RTU-3. Dimensions in inches 172.5 by 48.4. Approx. weight 375 LBS.", vector: vec(13, 0.9) },
    ]);

    const hits = (
      await searchPassages({ query: "unit dimensions weight", queryEmbedder: embedderFor({ "unit dimensions weight": vec(13) }) })
    ).hits;

    expect(hits.map((h) => h.fileName)).toEqual([
      "221457_SPEC_Div23_20210602.pdf",
      "221457_SUB_Packaged_RTUs_1_and_2_Approved_20220125.pdf",
    ]);
    expect(hits[0]?.alsoIn.map((c) => [c.fileName, c.isArchived, c.pageStart])).toEqual([
      ["221457_SUB_Packaged_RTU_9_Approved_20220203.pdf", false, 1],
      ["ARCHIVE_221457_SUB_Packaged_RTUs_1_and_2_Rejected_20220107.pdf", true, 1],
    ]);
    expect(hits[1]?.alsoIn).toEqual([]);
  });

  it("keeps a page that holds the boilerplate and a good deal of its own", async () => {
    const p = await project("221457_MAGNODE");
    await doc(p.id, "spec.pdf", [{ content: BOILERPLATE, vector: vec(14) }]);
    const own =
      "ROOFTOP UNITS SCHEDULE: RTU-1 supply fan 12,000 CFM, gas heat 400 MBH, operating weight 4,200 LBS, " +
      "dimensions 180 by 88 by 64 inches; RTU-2 supply fan 9,500 CFM, gas heat 300 MBH, operating weight 3,650 LBS, " +
      "dimensions 160 by 88 by 60 inches; RTU-3 supply fan 6,000 CFM, operating weight 2,100 LBS.";
    await doc(p.id, "submittal.pdf", [{ content: `${BOILERPLATE} ${own}`, vector: vec(14, 0.95) }]);

    const hits = (
      await searchPassages({ query: "unit dimensions weight", queryEmbedder: embedderFor({ "unit dimensions weight": vec(14) }) })
    ).hits;

    expect(hits.map((h) => h.fileName).sort()).toEqual(["spec.pdf", "submittal.pdf"]);
    expect(hits.every((h) => h.alsoIn.length === 0)).toBe(true);
  });

  it("does not let copies use up a document's places", async () => {
    const p = await project("221457_MAGNODE");
    await doc(p.id, "original.pdf", [{ content: BOILERPLATE, vector: vec(15) }]);
    // One file holding the boilerplate on four pages: one hit, three copies, no cap reached.
    await doc(
      p.id,
      "copies.pdf",
      Array.from({ length: 4 }, (_, i) => ({ content: `Page ${i + 10}. ${BOILERPLATE}`, vector: vec(15, 0.97) })),
    );
    const hits = (await searchPassages({ query: "rooftop", queryEmbedder: embedderFor({ rooftop: vec(15) }) })).hits;
    expect(hits).toHaveLength(1);
    expect(hits[0]?.alsoIn).toHaveLength(4);
  });
});
