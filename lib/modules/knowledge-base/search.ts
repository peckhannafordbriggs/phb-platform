import { prisma } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";

/**
 * Keyword search over the indexed passages: the half of retrieval that does
 * not need embeddings, and the half that finds exact identifiers (AV-1,
 * RFI 446, 224070) which embeddings blur.
 *
 * PostgreSQL full-text search on kb_chunks.content_tsv, built with the
 * 'simple' dictionary: no stemming and no stop words, so identifiers survive
 * tokenising, and so the query side does the work a dictionary would:
 *
 *   - Each word of the question is a TERM. Stop words ("what", "is", "the")
 *     are dropped. A passage matches if it holds ANY term; it ranks by how
 *     MANY it holds (coverage), then by PostgreSQL's ts_rank_cd.
 *   - A term carries its variants: valve / valves, AV-1 / AV1, 1,200 / 1200.
 *   - "Quoted words" are one term that must appear as that phrase.
 *   - A six-digit number that is a project's job number scopes the search to
 *     that project instead of being searched for.
 *   - A term found in the file name or folder path counts too, so "air valves
 *     submittal" ranks the Air Valves submittal's passages above a passing
 *     mention elsewhere.
 *   - The current version of a document (is_latest) ranks above an older or
 *     ARCHIVE_ one; older versions are still returned, and say so.
 *
 * At most KB_SEARCH_PER_DOCUMENT passages come from one document, so one long
 * spec cannot fill the page.
 */

export const KB_SEARCH_LIMIT = 20;
export const KB_SEARCH_PER_DOCUMENT = 3;
export const KB_SEARCH_MAX_TERMS = 12;
/** Candidates fetched before the per-document cap is applied. */
const CANDIDATES = 200;

/** Words that carry no meaning in a question. Kept short: anything domain-ish stays. */
const STOP_WORDS = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have how i if in into is it its " +
    "me my of on or our so than that the their them then there these they this those to us was we were what " +
    "when where which who whom why will with would you your about any all also each just more most no not only " +
    "other same such too very was were show tell find give list get"
  ).split(" "),
);

export type KbSearchTerm = {
  /** As the person typed it, for "matched N of M words". */
  label: string;
  /** Each alternative goes to plainto_tsquery (or phraseto_tsquery for a phrase); any one matching counts. */
  variants: string[];
  phrase: boolean;
};

export type KbParsedQuery = { terms: KbSearchTerm[]; jobNumbers: string[] };

/**
 * The question as terms. Pure, so its rules are tested on their own; the
 * database decides what each variant tokenises to.
 */
export function parseQuery(query: string): KbParsedQuery {
  const terms: KbSearchTerm[] = [];
  const jobNumbers: string[] = [];
  const seen = new Set<string>();
  const add = (term: KbSearchTerm) => {
    const key = `${term.phrase ? "p" : "w"}:${term.label.toLowerCase()}`;
    if (seen.has(key) || terms.length >= KB_SEARCH_MAX_TERMS) return;
    seen.add(key);
    terms.push(term);
  };

  const phrases = [...query.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.trim()).filter((p) => p.length > 0);
  for (const phrase of phrases) add({ label: phrase, variants: [phrase], phrase: true });

  const rest = query.replace(/"[^"]*"/g, " ");
  for (const raw of rest.split(/\s+/)) {
    // Trim punctuation at the ends; keep what joins an identifier (AV-1, 23.05, 1/2).
    const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (word.length === 0) continue;
    const lower = word.toLowerCase();
    if (STOP_WORDS.has(lower)) continue;
    if (/^\d{6}$/.test(word)) jobNumbers.push(word);
    if (lower.length === 1 && !/\d/.test(lower)) continue;
    add({ label: word, variants: variantsOf(lower), phrase: false });
  }
  return { terms, jobNumbers };
}

function variantsOf(word: string): string[] {
  const out = new Set([word]);
  // AV-1 / AV1, EF-1A / EF1A
  const tag = /^([a-z]+)-?(\d+[a-z]?)$/.exec(word);
  if (tag) {
    out.add(`${tag[1]}-${tag[2]}`);
    out.add(`${tag[1]}${tag[2]}`);
  }
  // 1,200 / 1200
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(word)) out.add(word.replace(/,/g, ""));
  // Plurals, for plain words: valves / valve, boxes / box, assemblies / assembly
  if (/^[a-z]{4,}$/.test(word)) {
    if (word.endsWith("ies")) out.add(`${word.slice(0, -3)}y`);
    else if (/(ss|x|ch|sh)es$/.test(word)) out.add(word.slice(0, -2));
    else if (word.endsWith("s") && !word.endsWith("ss")) out.add(word.slice(0, -1));
    else if (word.endsWith("y") && !/[aeiou]y$/.test(word)) out.add(`${word.slice(0, -1)}ies`);
    else if (/(ss|x|ch|sh)$/.test(word)) out.add(`${word}es`);
    else out.add(`${word}s`);
  }
  return [...out];
}

export type KbSearchHit = {
  chunkId: string;
  documentId: string;
  projectId: string;
  projectFolder: string;
  projectNumber: string | null;
  fileName: string;
  /** Inside the project folder. */
  path: string;
  folderCode: string | null;
  webUrl: string | null;
  versionLabel: string | null;
  isLatest: boolean;
  isArchived: boolean;
  pageStart: number | null;
  pageEnd: number | null;
  section: string | null;
  sheet: string | null;
  cellRange: string | null;
  /** Matched words wrapped in KB_MARK_START / KB_MARK_END; plain text otherwise. */
  snippet: string;
  /** Which of the query's terms this passage (or its file name) holds. */
  matched: string[];
  score: number;
};

export const KB_MARK_START = "\u0002";
export const KB_MARK_END = "\u0003";

export type KbSearchResult = {
  query: string;
  terms: string[];
  /** Projects the search was limited to, and how they were chosen. */
  scope: { how: "all" | "chosen" | "from_question"; projectIds: string[] };
  hits: KbSearchHit[];
  /** Passages that matched at all, before the per-document cap and the limit. */
  candidates: number;
};

type Row = {
  chunk_id: string;
  document_id: string;
  project_id: string;
  folder_name: string;
  project_number: string | null;
  file_name: string;
  path: string;
  folder_code: string | null;
  web_url: string | null;
  version_label: string | null;
  is_latest: boolean;
  is_archived: boolean;
  page_start: number | null;
  page_end: number | null;
  section: string | null;
  sheet: string | null;
  cell_range: string | null;
  snippet: string;
  matched: boolean[];
  score: number;
};

export async function searchPassages(options: {
  query: string;
  /** Limit to these projects. Empty or absent: a job number in the question, else all. */
  projectIds?: string[];
  limit?: number;
}): Promise<KbSearchResult> {
  const limit = Math.min(options.limit ?? KB_SEARCH_LIMIT, 50);
  const parsed = parseQuery(options.query);

  let scope: KbSearchResult["scope"] = { how: "all", projectIds: [] };
  let terms = parsed.terms;
  if (options.projectIds && options.projectIds.length > 0) {
    scope = { how: "chosen", projectIds: options.projectIds };
  } else if (parsed.jobNumbers.length > 0) {
    const projects = await prisma.kbProject.findMany({
      where: { projectNumber: { in: parsed.jobNumbers }, isLegacy: true },
      select: { id: true, projectNumber: true },
    });
    if (projects.length > 0) {
      scope = { how: "from_question", projectIds: projects.map((p) => p.id) };
      const used = new Set(projects.map((p) => p.projectNumber));
      terms = terms.filter((t) => t.phrase || !used.has(t.label));
    }
  }

  const empty: KbSearchResult = { query: options.query, terms: terms.map((t) => t.label), scope, hits: [], candidates: 0 };
  if (terms.length === 0) return empty;

  // One tsquery per term (its variants ORed), and their OR for the GIN probe.
  const termSql = terms.map((t) =>
    Prisma.join(
      t.variants.map((v) =>
        t.phrase ? Prisma.sql`phraseto_tsquery('simple', ${v})` : Prisma.sql`plainto_tsquery('simple', ${v})`,
      ),
      " || ",
    ),
  );
  const anyTerm = Prisma.join(termSql.map((q) => Prisma.sql`(${q})`), " || ");
  const inContent = termSql.map((q) => Prisma.sql`(c.content_tsv @@ (${q}))`);
  const inName = termSql.map((q) => Prisma.sql`(n.name_tsv @@ (${q}))`);
  const matchedArray = Prisma.sql`ARRAY[${Prisma.join(
    terms.map((_, i) => Prisma.sql`(${inContent[i]!} OR ${inName[i]!})`),
  )}]`;
  const count = (parts: Prisma.Sql[]) => Prisma.join(parts.map((p) => Prisma.sql`(${p})::int`), " + ");
  const projectFilter =
    scope.projectIds.length > 0 ? Prisma.sql`AND d.project_id IN (${Prisma.join(scope.projectIds.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.empty;

  const rows = await prisma.$queryRaw<Row[]>`
    WITH q AS (SELECT (${anyTerm}) AS any_term),
    hits AS (
      SELECT c.id, c.document_id
        FROM kb_chunks c, q
       WHERE c.content_tsv @@ q.any_term
    )
    SELECT c.id::text AS chunk_id, d.id::text AS document_id, p.id::text AS project_id,
           p.folder_name, p.project_number, d.file_name, d.path, d.folder_code, d.web_url,
           d.version_label, d.is_latest, d.is_archived,
           c.page_start, c.page_end, c.section, c.sheet, c.cell_range,
           ts_headline('simple', c.content, q.any_term,
             ${`StartSel=${KB_MARK_START}, StopSel=${KB_MARK_END}, MaxWords=45, MinWords=20, ShortWord=1, MaxFragments=2, FragmentDelimiter=" … "`}) AS snippet,
           ${matchedArray} AS matched,
           ( (${count(terms.map((_, i) => Prisma.sql`${inContent[i]!} OR ${inName[i]!}`))}) * 10.0
           + (${count(inName)}) * 2.0
           + ts_rank_cd(c.content_tsv, q.any_term, 32) * 5.0
           + CASE WHEN d.is_latest THEN 3.0 ELSE 0.0 END
           - CASE WHEN d.is_archived THEN 3.0 ELSE 0.0 END )::float8 AS score
      FROM hits h
      JOIN kb_chunks c ON c.id = h.id
      JOIN kb_documents d ON d.id = c.document_id
      JOIN kb_projects p ON p.id = d.project_id
      CROSS JOIN q
      CROSS JOIN LATERAL (
        -- Underscores, dots and slashes to spaces first: the parser reads
        -- "224070_SUB_Fans_Approved_20240130.pdf" as ONE file-name token.
        SELECT to_tsvector('simple', regexp_replace(concat_ws(' ', d.file_name, d.path), '[_./]+', ' ', 'g')) AS name_tsv
      ) n
     WHERE d.status = 'indexed' AND p.is_legacy ${projectFilter}
     ORDER BY score DESC, d.path, c.ordinal
     LIMIT ${CANDIDATES}`;

  const perDocument = new Map<string, number>();
  const hits: KbSearchHit[] = [];
  for (const r of rows) {
    const n = perDocument.get(r.document_id) ?? 0;
    if (n >= KB_SEARCH_PER_DOCUMENT) continue;
    perDocument.set(r.document_id, n + 1);
    hits.push({
      chunkId: r.chunk_id,
      documentId: r.document_id,
      projectId: r.project_id,
      projectFolder: r.folder_name,
      projectNumber: r.project_number,
      fileName: r.file_name,
      path: r.path,
      folderCode: r.folder_code,
      webUrl: r.web_url,
      versionLabel: r.version_label,
      isLatest: r.is_latest,
      isArchived: r.is_archived,
      pageStart: r.page_start,
      pageEnd: r.page_end,
      section: r.section,
      sheet: r.sheet,
      cellRange: r.cell_range,
      snippet: r.snippet,
      matched: terms.filter((_, i) => r.matched[i]).map((t) => t.label),
      score: r.score,
    });
    if (hits.length >= limit) break;
  }

  return { ...empty, hits, candidates: rows.length };
}

/** The projects a person can search, for the scope picker. */
export async function listSearchableProjects() {
  return prisma.kbProject.findMany({
    where: { isLegacy: true },
    orderBy: { folderName: "asc" },
    select: { id: true, folderName: true, projectNumber: true, name: true },
  });
}
