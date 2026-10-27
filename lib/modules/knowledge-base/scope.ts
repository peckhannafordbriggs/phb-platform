/**
 * What the Knowledge Base indexes, and what it deliberately leaves out.
 *
 * Every file in the library gets a row in kb_documents. A file left out gets
 * status 'skipped' and one of KB_SKIP_REASONS, so "why can't search find X"
 * is answered by a query rather than a guess. The CHECK on
 * kb_documents.skip_reason is generated from the same list, and
 * tests/kb-schema.test.ts proves the two match. Add a reason here and in a
 * migration together, never one without the other.
 *
 * The decisions behind each rule are in docs/KB-P0-P1.md.
 */

export const KB_SKIP_REASONS = [
  /** `ARCHIVE_` prefix: rejected submittals, superseded versions. Template rule. */
  "archive_prefix",
  /** `DRAFT_` prefix: unreviewed work in progress. Template rule. */
  "draft_prefix",
  /** A folder whose contents not every KB grantee may read. See below. */
  "restricted_folder",
  /** Drawings and Revit exports: text extraction on them is mostly noise. */
  "drawings_folder",
  /** The template's own README.txt files: filing guidance, not project knowledge. */
  "folder_readme",
  /** An extension the pipeline has no reader for. */
  "unsupported_type",
  /** Larger than KB_MAX_FILE_BYTES. */
  "too_large",
  /** Read successfully and held no text, e.g. a scanned PDF with no OCR layer. */
  "empty_text",
] as const;

export type KbSkipReason = (typeof KB_SKIP_REASONS)[number];

/**
 * Folder codes whose contents are excluded because the knowledge base has ONE
 * flat grant: anyone who can open the module can retrieve any indexed chunk.
 * These are the folders the template assigns to Joel alone - the estimate
 * file, the PH+B cost summary and all of Financial Performance - and indexing
 * them would let every grantee ask about margins and job cost.
 *
 * Lifting this needs a per-folder permission inside the module first, not a
 * change to this list. `8` covers 8A-8E because they sit beneath it.
 */
export const RESTRICTED_FOLDER_CODES: ReadonlySet<string> = new Set([
  "2A",
  "5A",
  "8",
]);

/**
 * Folder codes excluded for quality rather than access: mechanical drawing
 * sets and Revit exports. A drawing PDF extracts as scattered labels and
 * dimension strings, which match nearly any equipment question and answer
 * none of them. Revisit with title-block-only extraction once search is
 * measured (P3).
 */
export const DRAWINGS_FOLDER_CODES: ReadonlySet<string> = new Set(["1A", "1D"]);

/** Lower-case, without the dot. */
export const KB_SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([
  "pdf",
  "docx",
  "xlsx",
  "md",
  "txt",
]);

/** The largest sample file is 19 MB (a rejected controls submittal). */
export const KB_MAX_FILE_BYTES = 50 * 1024 * 1024;

export interface KbPathFacts {
  /** The six-digit job number from a `[JOB]_[NAME]` top folder, else null. */
  projectNumber: string | null;
  /** The deepest template folder code on the path (`11`, `2B`, `5C`), else null. */
  folderCode: string | null;
}

export type KbScopeDecision =
  | ({ include: true } & KbPathFacts)
  | ({ include: false; reason: KbSkipReason } & KbPathFacts);

const PROJECT_FOLDER = /^(\d{6})_/;
const TEMPLATE_FOLDER = /^(\d{1,2}[A-Z]?) - /;

/**
 * Decides whether a file is indexed, from its path relative to the library
 * root and its size. Pure: no I/O, so the same rules apply to a SharePoint
 * listing and to a local synced copy.
 *
 * `empty_text` is never returned here. Only reading the file can tell.
 */
export function classifyPath(
  relativePath: string,
  sizeBytes: number | null = null,
): KbScopeDecision {
  const segments = relativePath
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s.length > 0);
  const fileName = segments.at(-1) ?? "";
  const folders = segments.slice(0, -1);

  const projectNumber = PROJECT_FOLDER.exec(folders[0] ?? "")?.[1] ?? null;
  const codes = folders
    .map((folder) => TEMPLATE_FOLDER.exec(folder)?.[1])
    .filter((code): code is string => code !== undefined);
  const facts: KbPathFacts = { projectNumber, folderCode: codes.at(-1) ?? null };

  const skip = (reason: KbSkipReason): KbScopeDecision => ({
    include: false,
    reason,
    ...facts,
  });

  // Access before everything else: a restricted file is reported as
  // restricted even when it is also a draft or an unsupported type.
  if (codes.some((code) => RESTRICTED_FOLDER_CODES.has(code))) {
    return skip("restricted_folder");
  }

  const upper = fileName.toUpperCase();
  if (upper.startsWith("ARCHIVE_")) return skip("archive_prefix");
  if (upper.startsWith("DRAFT_")) return skip("draft_prefix");
  if (upper === "README.TXT") return skip("folder_readme");

  if (codes.some((code) => DRAWINGS_FOLDER_CODES.has(code))) {
    return skip("drawings_folder");
  }

  const dot = fileName.lastIndexOf(".");
  const extension = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  if (!KB_SUPPORTED_EXTENSIONS.has(extension)) return skip("unsupported_type");

  if (sizeBytes !== null && sizeBytes > KB_MAX_FILE_BYTES) {
    return skip("too_large");
  }

  return { include: true, ...facts };
}
