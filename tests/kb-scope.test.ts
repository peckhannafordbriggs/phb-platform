import { describe, expect, it } from "vitest";
import {
  KB_MAX_FILE_BYTES,
  classifyPath,
} from "@/lib/modules/knowledge-base/scope";
import {
  KB_EMBEDDING_DIMENSIONS,
  toVectorLiteral,
} from "@/lib/modules/knowledge-base/vector";
import {
  readKbEmbeddingEnv,
  readKbSourceEnv,
} from "@/lib/modules/knowledge-base/env";

/**
 * Paths are real ones from the 221457_MAGNODE template folder, so a change
 * to the rules is tested against what the library actually holds.
 */
const ROOT = "221457_MAGNODE";

describe("classifyPath", () => {
  it("indexes an approved submittal and reads the job and folder", () => {
    expect(
      classifyPath(`${ROOT}/11 - SUBMITTALS/221457_SUB_Fans_Approved_20220120.pdf`, 4_792_112),
    ).toEqual({ include: true, projectNumber: "221457", folderCode: "11" });
  });

  it("takes the deepest folder code", () => {
    const decision = classifyPath(
      `${ROOT}/2 - ESTIMATE/2B - VENDOR AND SUB QUOTES/221457_QUOTE_FERENTE_PIPE_20210719.pdf`,
    );
    expect(decision).toMatchObject({ include: true, folderCode: "2B" });
  });

  it.each([
    [`${ROOT}/11 - SUBMITTALS/ARCHIVE_221457_SUB_Vents_Rejected_20220124.pdf`, "archive_prefix"],
    [`${ROOT}/12 - CORRESPONDENCE AND RFIS/DRAFT_221457_CORR_note.pdf`, "draft_prefix"],
    [`${ROOT}/11 - SUBMITTALS/README.txt`, "folder_readme"],
    [`${ROOT}/1 - DWGS AND SPECS/1A - MECHANICAL DRAWINGS/221457_DWGS_MECHANICAL_IFC_20220121.pdf`, "drawings_folder"],
    [`${ROOT}/1 - DWGS AND SPECS/1D - REVIT EXPORTS/model.pdf`, "drawings_folder"],
    [`${ROOT}/2 - ESTIMATE/2B - VENDOR AND SUB QUOTES/221457_QUOTE_BLACGLU_PUMPS_20210716.doc`, "unsupported_type"],
    [`${ROOT}/2 - ESTIMATE/2A - ESTIMATE FILE/221457_EST_Master_v01.xlsx`, "restricted_folder"],
    [`${ROOT}/5 - PROJECT METRICS AND BENCHMARKS/5A - PHB COST SUMMARY/x.xlsx`, "restricted_folder"],
    [`${ROOT}/8 - FINANCIAL PERFORMANCE/8B - MARGIN OUTCOME SUMMARY/x.pdf`, "restricted_folder"],
  ])("skips %s as %s", (filePath, reason) => {
    expect(classifyPath(filePath)).toMatchObject({ include: false, reason });
  });

  it("keeps the specifications and the datasheet, which are not restricted", () => {
    expect(classifyPath(`${ROOT}/1 - DWGS AND SPECS/1C - SPECIFICATIONS/221457_SPEC_Div23_20210602.pdf`).include).toBe(true);
    expect(classifyPath(`${ROOT}/5 - PROJECT METRICS AND BENCHMARKS/5C - PROJECT DATASHEET/221457_DATASHEET_v01_TEMPLATE.xlsx`).include).toBe(true);
  });

  it("reports restricted ahead of every other reason", () => {
    expect(classifyPath(`${ROOT}/8 - FINANCIAL PERFORMANCE/README.txt`)).toMatchObject({
      reason: "restricted_folder",
    });
    expect(classifyPath(`${ROOT}/2 - ESTIMATE/2A - ESTIMATE FILE/ARCHIVE_old.xlsx`)).toMatchObject({
      reason: "restricted_folder",
    });
  });

  it("does not mistake 8 for a prefix of 8 in another code", () => {
    // 11 and 12 contain no restricted code; only an exact match counts.
    expect(classifyPath(`${ROOT}/12 - CORRESPONDENCE AND RFIS/x.pdf`).include).toBe(true);
  });

  it("indexes the curator's notes beside the files", () => {
    expect(
      classifyPath(`${ROOT}/10 - CHANGE ORDERS/+THIS_FOLDER_IS_MESSED_UP.txt`),
    ).toMatchObject({ include: true, folderCode: "10" });
  });

  it("skips a file over the size cap", () => {
    expect(classifyPath(`${ROOT}/11 - SUBMITTALS/big.pdf`, KB_MAX_FILE_BYTES + 1)).toMatchObject({
      reason: "too_large",
    });
  });

  it("accepts Windows separators and an unrecognised top folder", () => {
    expect(classifyPath("Misc\\11 - SUBMITTALS\\a.pdf")).toEqual({
      include: true,
      projectNumber: null,
      folderCode: "11",
    });
  });
});

describe("toVectorLiteral", () => {
  it("serialises a full-width vector", () => {
    const literal = toVectorLiteral(new Array<number>(KB_EMBEDDING_DIMENSIONS).fill(0.5));
    expect(literal.startsWith("[0.5,0.5")).toBe(true);
    expect(literal.split(",")).toHaveLength(KB_EMBEDDING_DIMENSIONS);
  });

  it("refuses the wrong width", () => {
    expect(() => toVectorLiteral([1, 2, 3])).toThrow(/3 dimensions/);
  });

  it("refuses NaN and Infinity", () => {
    const v = new Array<number>(KB_EMBEDDING_DIMENSIONS).fill(0);
    v[7] = Number.NaN;
    expect(() => toVectorLiteral(v)).toThrow(/value 7/);
  });
});

describe("readKbEmbeddingEnv", () => {
  const complete = {
    KB_EMBEDDING_ENDPOINT: "https://phb-openai.openai.azure.com/",
    KB_EMBEDDING_DEPLOYMENT: "text-embedding-3-small",
  };

  it("reads a complete configuration and trims the trailing slash", () => {
    expect(readKbEmbeddingEnv(complete)).toEqual({
      present: true,
      values: {
        endpoint: "https://phb-openai.openai.azure.com",
        deployment: "text-embedding-3-small",
        apiKey: null,
      },
    });
  });

  it("names what is missing, treating blank as absent", () => {
    expect(readKbEmbeddingEnv({ KB_EMBEDDING_ENDPOINT: "", KB_EMBEDDING_DEPLOYMENT: "" })).toEqual({
      present: false,
      missing: ["KB_EMBEDDING_DEPLOYMENT", "KB_EMBEDDING_ENDPOINT"],
    });
  });

  it("refuses an API key in production", () => {
    expect(() =>
      readKbEmbeddingEnv({ ...complete, KB_EMBEDDING_API_KEY: "k", NODE_ENV: "production" }),
    ).toThrow(/managed identity/);
  });
});

describe("readKbSourceEnv", () => {
  it("uses a local folder outside production", () => {
    expect(readKbSourceEnv({ KB_LOCAL_SOURCE_DIR: "C:\\KB" })).toEqual({
      present: true,
      values: { kind: "local", directory: "C:\\KB" },
    });
  });

  it("never uses a local folder in production", () => {
    const result = readKbSourceEnv({ KB_LOCAL_SOURCE_DIR: "/kb", NODE_ENV: "production" });
    expect(result.present).toBe(false);
  });

  it("prefers SharePoint when it is configured", () => {
    const result = readKbSourceEnv({
      KB_LOCAL_SOURCE_DIR: "/kb",
      KB_GRAPH_TENANT_ID: "00000000-0000-0000-0000-000000000001",
      KB_GRAPH_CLIENT_ID: "00000000-0000-0000-0000-000000000002",
      KB_SHAREPOINT_SITE_ID: "phb1899.sharepoint.com,a,b",
      KB_SHAREPOINT_DRIVE_ID: "b!abc",
    });
    expect(result.present && result.values.kind).toBe("sharepoint");
  });
});
