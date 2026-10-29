import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KB_CHUNK_MAX_CHARS,
  KB_CHUNK_TARGET_CHARS,
  chunkPages,
  chunkSections,
  chunkSheetRows,
  cleanText,
  columnLetter,
  splitText,
} from "@/lib/modules/knowledge-base/chunk";
import {
  KbUnsupportedTypeError,
  cellText,
  extractDocument,
  htmlSections,
  markdownSections,
} from "@/lib/modules/knowledge-base/extract";
import { writeDocx, writePdf, writeWorkbook } from "./kb-fixtures";

/**
 * Text extraction and passage splitting, on synthetic documents built at test
 * time (tests/kb-fixtures.ts). Wording is invented; layouts mimic the curated
 * project files: a submittal PDF, a spec section in Word, an estimate sheet.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "zztest-kb-extract-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const file = (name: string) => path.join(dir, name);

const sentence = (n: number) => `Sentence ${n} about the air handling unit and its supply fan arrangement.`;
const paragraph = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => sentence(from + i)).join(" ");

describe("cleanText", () => {
  it("removes NUL, which PostgreSQL text cannot hold, and tidies whitespace", () => {
    expect(cleanText("  AHU-1\u0000  12,000\tCFM \r\n\r\n\r\n\r\nNext  ")).toBe("AHU-1 12,000 CFM\n\nNext");
  });
});

describe("splitText", () => {
  it("keeps short text whole", () => {
    expect(splitText("One line.")).toEqual(["One line."]);
  });

  it("cuts at paragraphs first, never past the maximum", () => {
    const text = [paragraph(0, 20), paragraph(20, 20), paragraph(40, 20)].join("\n\n");
    const pieces = splitText(text);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(KB_CHUNK_MAX_CHARS);
    expect(pieces.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  });

  it("cuts an unbroken run anywhere, and loses nothing", () => {
    const text = "x".repeat(KB_CHUNK_MAX_CHARS * 2 + 5);
    const pieces = splitText(text);
    expect(pieces.map((p) => p.length)).toEqual([KB_CHUNK_MAX_CHARS, KB_CHUNK_MAX_CHARS, 5]);
  });
});

describe("chunkPages", () => {
  it("joins short pages into one passage and says which pages", () => {
    const chunks = chunkPages([
      { page: 1, text: "Cover sheet" },
      { page: 2, text: "Fan schedule" },
      { page: 3, text: "" },
    ]);
    expect(chunks).toEqual([
      expect.objectContaining({ content: "Cover sheet\n\nFan schedule", pageStart: 1, pageEnd: 2, section: null }),
    ]);
  });

  it("splits a long page, every passage citing that page", () => {
    const chunks = chunkPages([{ page: 7, text: [paragraph(0, 30), paragraph(30, 30)].join("\n\n") }]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c).toMatchObject({ pageStart: 7, pageEnd: 7 });
  });

  it("estimates tokens at four characters each", () => {
    expect(chunkPages([{ page: 1, text: "12345678" }])[0]?.tokenCount).toBe(2);
  });
});

describe("chunkSections", () => {
  it("never puts two sections in one passage", () => {
    const chunks = chunkSections([
      { section: "1.1 Scope", text: "Short." },
      { section: "1.2 Products", text: "Also short." },
    ]);
    expect(chunks.map((c) => [c.section, c.content])).toEqual([
      ["1.1 Scope", "Short."],
      ["1.2 Products", "Also short."],
    ]);
  });

  it("packs pieces of one section up to the target", () => {
    const chunks = chunkSections([{ section: "S", text: [paragraph(0, 8), paragraph(8, 8), paragraph(16, 8)].join("\n\n") }]);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(KB_CHUNK_TARGET_CHARS);
  });
});

describe("chunkSheetRows", () => {
  it("cites the cells a passage covers and keeps sheets apart", () => {
    const chunks = chunkSheetRows([
      { sheet: "Labor", row: 1, minCol: 1, maxCol: 3, text: "Item | Hours | Rate" },
      { sheet: "Labor", row: 2, minCol: 1, maxCol: 4, text: "Item: Duct | Hours: 40" },
      { sheet: "Summary", row: 5, minCol: 2, maxCol: 2, text: "Total: 1200" },
    ]);
    expect(chunks.map((c) => [c.sheet, c.cellRange])).toEqual([
      ["Labor", "A1:D2"],
      ["Summary", "B5:B5"],
    ]);
  });

  it("names columns past Z", () => {
    expect([1, 26, 27, 52, 703].map(columnLetter)).toEqual(["A", "Z", "AA", "AZ", "AAA"]);
  });
});

describe("markdownSections and htmlSections", () => {
  it("keeps the heading path, and ignores # inside a code fence", () => {
    const sections = markdownSections("Intro\n# Gap log\n## Folder 10\nCO 8 missing\n```\n# not a heading\n```\n");
    expect(sections).toEqual([
      { section: null, text: "Intro\n" },
      { section: "Gap log > Folder 10", text: "CO 8 missing\n```\n# not a heading\n```\n\n" },
    ]);
  });

  it("flattens tables to cells separated by bars, and decodes entities", () => {
    const sections = htmlSections("<h1>Part 2 &amp; 3</h1><table><tr><td><p>AHU-1</p></td><td><p>12,000</p><p>CFM</p></td></tr></table>");
    expect(sections).toHaveLength(1);
    expect(sections[0]?.section).toBe("Part 2 & 3");
    expect(cleanText(sections[0]?.text ?? "")).toBe("AHU-1 | 12,000 CFM");
  });
});

describe("cellText", () => {
  it("reads formulas by their saved result, rich text, dates and links", () => {
    expect(cellText({ formula: "SUM(A1:A3)", result: 42 })).toBe("42");
    expect(cellText({ richText: [{ text: "Air " }, { text: "Valves" }] })).toBe("Air Valves");
    expect(cellText(new Date("2024-11-21T00:00:00Z"))).toBe("2024-11-21");
    expect(cellText({ text: "Submittal log", hyperlink: "https://example.invalid" })).toBe("Submittal log");
    expect(cellText({ error: "#REF!" })).toBe("");
    expect(cellText({ formula: "A1" })).toBe("");
  });
});

describe("extractDocument", () => {
  it("reads a PDF page by page", async () => {
    await writePdf(file("sub.pdf"), [
      "224070 Air Valves submittal\nReviewed: Approved",
      "",
      "Valve schedule\nAV-1 supply 1200 CFM",
    ]);
    const result = await extractDocument(file("sub.pdf"), "pdf");
    expect(result.empty).toBe(false);
    const chunks = result.empty ? [] : result.chunks;
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ pageStart: 1, pageEnd: 3 });
    expect(chunks[0]?.content).toMatch(/Air Valves submittal/);
    expect(chunks[0]?.content).toMatch(/AV-1 supply 1200 CFM/);
  });

  it("treats a PDF with no text layer as empty, not failed", async () => {
    await writePdf(file("scan.pdf"), ["", ""]);
    expect(await extractDocument(file("scan.pdf"), "pdf")).toEqual({ empty: true });
  });

  it("refuses a file that is not a PDF with the parser's own error", async () => {
    await writeFile(file("bad.pdf"), "not a pdf at all");
    await expect(extractDocument(file("bad.pdf"), "pdf")).rejects.toThrow();
  });

  it("reads Word by heading, tables included", async () => {
    await writeDocx(file("spec.docx"), [
      { text: "Front matter that precedes every heading." },
      { heading: 1, text: "Part 2 - Products" },
      { heading: 2, text: "2.3 Fans" },
      { text: "Fans shall be direct drive with ECM motors." },
      { table: [["Tag", "CFM"], ["EF-1", "800"]] },
      { heading: 2, text: "2.4 Dampers" },
      { text: "Dampers shall be low leakage." },
    ]);
    const result = await extractDocument(file("spec.docx"), "docx");
    const chunks = result.empty ? [] : result.chunks;
    expect(chunks.map((c) => c.section)).toEqual([null, "Part 2 - Products > 2.3 Fans", "Part 2 - Products > 2.4 Dampers"]);
    expect(chunks[1]?.content).toMatch(/ECM motors/);
    expect(chunks[1]?.content).toMatch(/EF-1 \| 800/);
  });

  it("reads a workbook, names columns from the header row, and skips very hidden sheets", async () => {
    await writeWorkbook(file("est.xlsm"), [
      {
        name: "Labor",
        rows: [
          ["Item", "Hours", "Rate"],
          ["Ductwork", 40, 95],
          [null, null, null],
          ["Total", { formula: "B2*C2", result: 3800 }, null],
        ],
      },
      { name: "Macros", rows: [["secret plumbing", "x"]], state: "veryHidden" },
    ]);
    const result = await extractDocument(file("est.xlsm"), "xlsm");
    const chunks = result.empty ? [] : result.chunks;
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ sheet: "Labor", cellRange: "A1:C4" });
    expect(chunks[0]?.content).toBe("Item | Hours | Rate\n\nItem: Ductwork | Hours: 40 | Rate: 95\n\nItem: Total | Hours: 3800");
  });

  it("reads Markdown and plain text", async () => {
    await writeFile(file("gap.md"), "# 224070 gap log\nCO 008 has no backup in folder 10.\n");
    await writeFile(file("note.txt"), "+ATTENTION: the CO log numbers do not match the CO sheets.");
    const md = await extractDocument(file("gap.md"), "md");
    const txt = await extractDocument(file("note.txt"), "txt");
    expect(md.empty ? null : md.chunks[0]).toMatchObject({ section: "224070 gap log" });
    expect(txt.empty ? null : txt.chunks[0]).toMatchObject({ section: null, pageStart: null });
  });

  it("has no reader for a type scope.ts never lets through", async () => {
    await writeFile(file("a.msg"), "x");
    await expect(extractDocument(file("a.msg"), "msg")).rejects.toBeInstanceOf(KbUnsupportedTypeError);
  });
});
