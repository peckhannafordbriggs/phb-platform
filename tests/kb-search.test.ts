import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  KB_MARK_END,
  KB_MARK_START,
  KB_SEARCH_PER_DOCUMENT,
  parseQuery,
  searchPassages,
} from "@/lib/modules/knowledge-base/search";
import { disconnectDb, resetDb, testDb } from "./db";

/**
 * Keyword search against passages written straight into the index. Wording
 * is invented; names follow the curated project template.
 */

afterAll(disconnectDb);
beforeEach(async () => {
  await resetDb();
});

let n = 0;

async function project(folderName: string) {
  n += 1;
  const number = /^(\d{6})_/.exec(folderName)?.[1] ?? null;
  return testDb.kbProject.create({
    data: { sourceKind: "local", sourceId: `p-${n}`, folderName, projectNumber: number, name: folderName, isLegacy: true },
  });
}

async function doc(
  projectId: string,
  path: string,
  passages: { content: string; pageStart?: number; sheet?: string; cellRange?: string }[],
  flags: { isLatest?: boolean; isArchived?: boolean; status?: "indexed" | "pending" } = {},
) {
  n += 1;
  const fileName = path.split("/").at(-1)!;
  const status = flags.status ?? "indexed";
  const d = await testDb.kbDocument.create({
    data: {
      projectId,
      sourceKind: "local",
      sourceId: `d-${n}`,
      path,
      fileName,
      fileType: fileName.split(".").at(-1)!,
      familyKey: fileName,
      isLatest: flags.isLatest ?? true,
      isArchived: flags.isArchived ?? false,
      status,
      chunkCount: status === "indexed" ? passages.length : 0,
    },
  });
  for (const [ordinal, p] of passages.entries()) {
    await testDb.$executeRawUnsafe(
      `INSERT INTO kb_chunks (id, document_id, ordinal, content, page_start, page_end, sheet, cell_range)
       VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4, $4, $5, $6)`,
      d.id,
      ordinal,
      p.content,
      p.pageStart ?? null,
      p.sheet ?? null,
      p.cellRange ?? null,
    );
  }
  return d;
}

describe("parseQuery", () => {
  it("drops stop words and keeps identifiers", () => {
    expect(parseQuery("What is the CFM of AV-1?").terms.map((t) => t.label)).toEqual(["CFM", "AV-1"]);
  });

  it("adds tag, number and plural variants", () => {
    const [av, num, valves, box] = parseQuery("AV1 1,200 valves box").terms;
    expect(av?.variants).toEqual(expect.arrayContaining(["av1", "av-1"]));
    expect(num?.variants).toEqual(expect.arrayContaining(["1,200", "1200"]));
    expect(valves?.variants).toEqual(expect.arrayContaining(["valves", "valve"]));
    expect(box?.variants).toEqual(["box"]);
  });

  it("keeps a quoted phrase whole and notes job numbers", () => {
    const parsed = parseQuery('"control valves" 224070 approved');
    expect(parsed.terms[0]).toMatchObject({ label: "control valves", phrase: true });
    expect(parsed.jobNumbers).toEqual(["224070"]);
  });

  it("returns nothing for a question made only of stop words", () => {
    expect(parseQuery("what is it?").terms).toEqual([]);
  });
});

describe("searchPassages", () => {
  it("ranks by how many words a passage holds, and cites its page", async () => {
    const p = await project("224070_UC_OLD_CHEM");
    await doc(p.id, "11 - SUBMITTALS/224070_SUB_Air_Valves_Approved_20241121.pdf", [
      { content: "Valve schedule. AV-1 supply air valve 1,200 CFM. AV-2 exhaust 900 CFM.", pageStart: 14 },
    ]);
    await doc(p.id, "12 - CORRESPONDENCE AND RFIS/224070_CORR_note.pdf", [
      { content: "General note about CFM measurement at the hoods.", pageStart: 2 },
    ]);

    const result = await searchPassages({ query: "What CFM is AV-1?" });

    expect(result.terms).toEqual(["CFM", "AV-1"]);
    expect(result.hits.map((h) => h.fileName)).toEqual([
      "224070_SUB_Air_Valves_Approved_20241121.pdf",
      "224070_CORR_note.pdf",
    ]);
    expect(result.hits[0]).toMatchObject({ pageStart: 14, matched: ["CFM", "AV-1"], projectNumber: "224070" });
    expect(result.hits[0]?.snippet).toContain(`${KB_MARK_START}AV${KB_MARK_END}`);
  });

  it("finds a singular question in plural text, and AV1 written as AV-1", async () => {
    const p = await project("224070_UC_OLD_CHEM");
    await doc(p.id, "11 - SUBMITTALS/a.pdf", [{ content: "Control valves: AV-1 and AV-2." }]);
    expect((await searchPassages({ query: "control valve" })).hits).toHaveLength(1);
    expect((await searchPassages({ query: "AV1" })).hits).toHaveLength(1);
  });

  it("counts a word found in the file name", async () => {
    const p = await project("224070_UC_OLD_CHEM");
    await doc(p.id, "11 - SUBMITTALS/224070_SUB_Fans_Approved_20240130.pdf", [{ content: "Model EF-3 direct drive." }]);
    await doc(p.id, "12 - CORRESPONDENCE AND RFIS/224070_CORR_misc.pdf", [{ content: "Model EF-3 noted in passing." }]);

    const result = await searchPassages({ query: "EF-3 fans submittal" });

    expect(result.hits[0]?.fileName).toBe("224070_SUB_Fans_Approved_20240130.pdf");
    expect(result.hits[0]?.matched).toEqual(["EF-3", "fans", "submittal"]);
  });

  it("puts the current version first and still returns the archived one, labelled", async () => {
    const p = await project("224070_UC_OLD_CHEM");
    await doc(p.id, "11 - SUBMITTALS/ARCHIVE_224070_SUB_Louvers_Rejected_20240328.pdf", [{ content: "Louver L-1 blade depth 4 inch." }], {
      isLatest: false,
      isArchived: true,
    });
    await doc(p.id, "11 - SUBMITTALS/224070_SUB_Louvers_Approved_20240410.pdf", [{ content: "Louver L-1 blade depth 6 inch." }]);

    const hits = (await searchPassages({ query: "louver L-1 blade depth" })).hits;

    expect(hits.map((h) => [h.isLatest, h.isArchived])).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  it("scopes to the project whose job number is in the question, and does not search for the number", async () => {
    const a = await project("224070_UC_OLD_CHEM");
    const b = await project("221457_MAGNODE");
    await doc(a.id, "11 - SUBMITTALS/a.pdf", [{ content: "Insulation thickness 1 inch." }]);
    await doc(b.id, "11 - SUBMITTALS/b.pdf", [{ content: "Insulation thickness 2 inch." }]);

    const result = await searchPassages({ query: "insulation thickness 221457" });

    expect(result.scope).toEqual({ how: "from_question", projectIds: [b.id] });
    expect(result.terms).toEqual(["insulation", "thickness"]);
    expect(result.hits.map((h) => h.projectFolder)).toEqual(["221457_MAGNODE"]);
  });

  it("honours a chosen scope", async () => {
    const a = await project("224070_UC_OLD_CHEM");
    const b = await project("221457_MAGNODE");
    await doc(a.id, "x/a.pdf", [{ content: "Duct pressure test passed." }]);
    await doc(b.id, "x/b.pdf", [{ content: "Duct pressure test failed." }]);
    const result = await searchPassages({ query: "duct pressure", projectIds: [a.id] });
    expect(result.scope.how).toBe("chosen");
    expect(result.hits.map((h) => h.projectId)).toEqual([a.id]);
  });

  it("cites a spreadsheet by sheet and cells", async () => {
    const p = await project("224070_UC_OLD_CHEM");
    await doc(p.id, "10 - CHANGE ORDERS/224070_COR_Log_20260625.xlsx", [
      { content: "Subcontractor Change Request#: 022 | Description: RFI #446", sheet: "Log", cellRange: "A30:R34" },
    ]);
    const [hit] = (await searchPassages({ query: "RFI 446" })).hits;
    expect(hit).toMatchObject({ sheet: "Log", cellRange: "A30:R34", pageStart: null });
  });

  it("takes at most a few passages from one document", async () => {
    const p = await project("224070_UC_OLD_CHEM");
    await doc(
      p.id,
      "1 - DWGS AND SPECS/1C - SPECIFICATIONS/spec.pdf",
      Array.from({ length: 8 }, (_, i) => ({ content: `Ductwork sealing class A, page ${i + 1}.`, pageStart: i + 1 })),
    );
    await doc(p.id, "11 - SUBMITTALS/duct.pdf", [{ content: "Ductwork submittal." }]);

    const hits = (await searchPassages({ query: "ductwork" })).hits;

    expect(hits.filter((h) => h.fileName === "spec.pdf")).toHaveLength(KB_SEARCH_PER_DOCUMENT);
    expect(hits.some((h) => h.fileName === "duct.pdf")).toBe(true);
  });

  it("never returns a document that is not indexed", async () => {
    const p = await project("224070_UC_OLD_CHEM");
    await doc(p.id, "x/pending.pdf", [{ content: "Chiller CH-1." }], { status: "pending" });
    expect((await searchPassages({ query: "chiller" })).hits).toEqual([]);
  });

  it("returns nothing, without querying, for stop words only", async () => {
    expect(await searchPassages({ query: "what is the" })).toMatchObject({ hits: [], terms: [], candidates: 0 });
  });
});
