/**
 * What the Knowledge Base indexes, and what it deliberately leaves out.
 *
 * Every file in a project folder gets a row in kb_documents. A file left out
 * gets status 'skipped' and one of KB_SKIP_REASONS, so "why can't search find
 * X" is answered by a query rather than a guess. The CHECK on
 * kb_documents.skip_reason lists the same values, and tests/kb-schema.test.ts
 * proves the two match. Change both together, in a migration.
 *
 * `ARCHIVE_` files are NOT skipped: they are superseded or rejected versions,
 * indexed with `archived` set so answers never lead with them but can use one
 * to explain a change (the specification's rule for versions).
 *
 * Decisions: docs/KB-P0-P1.md -> *Decisions taken*.
 */

export const KB_SKIP_REASONS = [
  /** `DRAFT_` prefix: unreviewed work in progress. Template rule. */
  "draft_prefix",
  /** A folder whose contents not every KB grantee may read. See below. */
  "restricted_folder",
  /** Drawing sets: folders 1A and 1D, and `_Drawings_` files elsewhere in folder 1 (1E). */
  "drawings",
  /** The template's own README.txt files: filing guidance, not project knowledge. */
  "folder_readme",
  /**
   * A file directly in the project folder, outside the 13 template folders:
   * curation artefacts such as `224070_GAP_LOG.md`, not project documents.
   */
  "project_root_file",
  /** An extension the pipeline has no reader for (e.g. `.msg`, legacy `.doc`). */
  "unsupported_type",
  /** Larger than KB_MAX_FILE_BYTES. */
  "too_large",
  /** Read successfully and held no text, e.g. a scanned PDF with no OCR layer. */
  "empty_text",
] as const;

export type KbSkipReason = (typeof KB_SKIP_REASONS)[number];

/**
 * Folder codes excluded because the knowledge base has ONE flat grant: anyone
 * who can open the module can retrieve any indexed passage. These are the
 * folders the template assigns to the PE alone - the estimate file, the PH+B
 * cost summary and all of Financial Performance. `8` covers 8A-8E.
 */
export const RESTRICTED_FOLDER_CODES: ReadonlySet<string> = new Set(["2A", "5A", "8"]);

/** Drawing folders: mechanical sets and Revit exports. */
export const DRAWINGS_FOLDER_CODES: ReadonlySet<string> = new Set(["1A", "1D"]);

/** Lower-case, without the dot. Excel includes macro workbooks. */
export const KB_SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([
  "pdf",
  "docx",
  "xlsx",
  "xlsm",
  "md",
  "txt",
]);

/**
 * The largest curated file seen is 82 MB (a custom AHU submittal); specs and
 * contracts run past 1,000 pages. Extraction streams from disk, so this guards
 * against something unexpected rather than limiting normal documents.
 */
export const KB_MAX_FILE_BYTES = 250 * 1024 * 1024;

export interface KbPathFacts {
  /** The six-digit job number from a `[JOB]_[NAME]` top folder, else null. */
  projectNumber: string | null;
  /** The deepest template folder code on the path (`11`, `2B`, `5C`), else null. */
  folderCode: string | null;
  /** Lower-case extension without the dot; "" when there is none. */
  fileType: string;
  /** An `ARCHIVE_` file: a superseded or rejected version. */
  archived: boolean;
}

export type KbScopeDecision =
  | ({ include: true } & KbPathFacts)
  | ({ include: false; reason: KbSkipReason } & KbPathFacts);

const PROJECT_FOLDER = /^(\d{6})_/;
const TEMPLATE_FOLDER = /^(\d{1,2}[A-Z]?) - /;
/**
 * `_Drawings_` as a whole token: the bulletin and addenda drawing sets in 1E.
 * Applied only under folder 1 (DWGS AND SPECS). Elsewhere the word names
 * documents worth reading: RFIs in 12 (`_RFI_446_Drawings_Process_CHW_`) and
 * coordination or shop drawing submittals in 11, whose cover pages and
 * reviewer comments are text.
 */
const DRAWINGS_FILE = /(^|_)Drawings(_|\.|$)/i;

/**
 * Decides whether a file is indexed, from its path relative to the library
 * root (`<project>/<folders>/<file>`) and its size. Pure: the same rules apply
 * to a SharePoint listing and to a local synced copy.
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
    .slice(1)
    .map((folder) => TEMPLATE_FOLDER.exec(folder)?.[1])
    .filter((code): code is string => code !== undefined);
  const dot = fileName.lastIndexOf(".");
  const fileType = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  const archived = fileName.toUpperCase().startsWith("ARCHIVE_");
  const facts: KbPathFacts = {
    projectNumber,
    folderCode: codes.at(-1) ?? null,
    fileType,
    archived,
  };

  const skip = (reason: KbSkipReason): KbScopeDecision => ({ include: false, reason, ...facts });

  // Access before everything else: a restricted file is reported as
  // restricted even when it is also a draft or an unsupported type.
  if (codes.some((code) => RESTRICTED_FOLDER_CODES.has(code))) return skip("restricted_folder");

  if (folders.length <= 1) return skip("project_root_file");

  if (fileName.toUpperCase().startsWith("DRAFT_")) return skip("draft_prefix");
  if (fileName.toUpperCase() === "README.TXT") return skip("folder_readme");

  const inDrawingsAndSpecs = codes[0] === "1";
  if (
    codes.some((code) => DRAWINGS_FOLDER_CODES.has(code)) ||
    (inDrawingsAndSpecs && DRAWINGS_FILE.test(fileName))
  ) {
    return skip("drawings");
  }

  if (!KB_SUPPORTED_EXTENSIONS.has(fileType)) return skip("unsupported_type");
  if (sizeBytes !== null && sizeBytes > KB_MAX_FILE_BYTES) return skip("too_large");

  return { include: true, ...facts };
}
