import { prisma } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { logUnexpected } from "@/lib/logger";
import { KNOWLEDGE_BASE_MODULE_KEY } from "./constants";
import { isSamePassage, passageShingles } from "./duplicates";
import { azureEmbedder } from "./embed";
import { readKbEmbeddingEnv } from "./env";
import { toVectorLiteral } from "./vector";

/**
 * Search over the indexed passages: two searches, fused by rank.
 *
 * MEANING: the question is embedded (text-embedding-3-small, the model that
 * embedded the passages) and the nearest passages by cosine distance are
 * taken from the HNSW index. This is what finds "air handling units" in a
 * file that only says "AHU". When it cannot run - not configured, or Azure
 * does not answer - the search says so and uses words alone; it never fails
 * because of it.
 *
 * WORDS: the half that finds exact identifiers (AV-1, RFI 446, 224070) which
 * embeddings blur. As follows.
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
 * FUSION: reciprocal rank fusion (KB_RRF_K), so a passage both searches rank
 * well beats one only a single search found. Then, walking down that order:
 * a passage that is the same text as one already chosen (duplicates.ts: a
 * spec section copied into a submittal, a page carried into the next version)
 * is listed under it as `alsoIn` instead of taking a place of its own; and at
 * most KB_SEARCH_PER_DOCUMENT passages from one document, so one long spec
 * cannot fill the page.
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
  /** Found by its words, by its meaning, or by both searches. */
  matchedBy: "words" | "meaning" | "both";
  /** Cosine similarity to the question, when the meaning search found it. */
  similarity: number | null;
  score: number;
  /** The same text found in other places, lower in the results; best ranked first. */
  alsoIn: KbSearchCopy[];
};

/** Where else a hit's text was found: enough to name and open it. */
export type KbSearchCopy = Pick<
  KbSearchHit,
  | "chunkId"
  | "documentId"
  | "projectFolder"
  | "fileName"
  | "path"
  | "webUrl"
  | "versionLabel"
  | "isLatest"
  | "isArchived"
  | "pageStart"
  | "pageEnd"
  | "section"
  | "sheet"
  | "cellRange"
>;

/** Copies listed under one hit, at most. */
export const KB_SEARCH_MAX_COPIES = 10;
/** Passages whose text is read per step while choosing. */
const CONTENT_BATCH = 60;

export const KB_MARK_START = "\u0002";
export const KB_MARK_END = "\u0003";

export type KbSearchMode = "hybrid" | "keyword";

export type KbSearchResult = {
  query: string;
  terms: string[];
  /** Projects the search was limited to, and how they were chosen. */
  scope: { how: "all" | "chosen" | "from_question"; projectIds: string[] };
  /** What actually ran: "keyword" when asked for, or when the meaning search could not. */
  mode: KbSearchMode;
  /** Why the meaning search did not run, in plain words; null when it did or was not asked for. */
  notice: string | null;
  hits: KbSearchHit[];
  /** Passages either search found, before the per-document cap and the limit. */
  candidates: number;
};

/** Turns the question into a vector. Null: the meaning search is not available here. */
export type KbQueryEmbedder = (text: string) => Promise<number[]>;

/**
 * Reciprocal rank fusion: a passage scores 1/(K + rank) in each list it is
 * in, summed. Ranks, not raw scores, because a keyword score and a cosine
 * similarity are on different scales; 60 is the constant from the original
 * paper and the common default, and it lets a passage near the top of BOTH
 * lists beat one at the very top of one.
 */
export const KB_RRF_K = 60;

/** Nearest passages taken from the vector index before fusion. */
export const KB_VECTOR_CANDIDATES = 100;

/**
 * Below this cosine similarity a nearest neighbour is not evidence, only the
 * least unrelated passage there is. text-embedding-3-small puts related
 * construction text at roughly 0.4-0.8 and unrelated at 0.1-0.3. A starting
 * value; `npm run kb:eval` is how to move it.
 */
export const KB_MIN_SIMILARITY = 0.3;

/**
 * A small nudge, not a rule: among passages that rank alike, the current
 * version of a document goes first and an archived one last. Smaller than
 * the gap between neighbouring ranks near the top, so it reorders ties and
 * near-ties only.
 */
const VERSION_NUDGE = 0.0005;

type Candidate = { id: string; documentId: string; isLatest: boolean; isArchived: boolean };
type Ranked = Candidate & { keywordRank: number | null; vectorRank: number | null; similarity: number | null; score: number };

type HitRow = {
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
  matched: boolean[] | null;
};

const HEADLINE = `StartSel=${KB_MARK_START}, StopSel=${KB_MARK_END}, MaxWords=45, MinWords=20, ShortWord=1, MaxFragments=2, FragmentDelimiter=" … "`;

export async function searchPassages(options: {
  query: string;
  /** Limit to these projects. Empty or absent: a job number in the question, else all. */
  projectIds?: string[];
  limit?: number;
  /** Default "hybrid": keyword and meaning together, falling back to keyword alone. */
  mode?: KbSearchMode;
  /** Instead of Azure OpenAI from the environment (tests). Null: no meaning search. */
  queryEmbedder?: KbQueryEmbedder | null;
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

  const projectFilter =
    scope.projectIds.length > 0
      ? Prisma.sql`AND d.project_id IN (${Prisma.join(scope.projectIds.map((id) => Prisma.sql`${id}::uuid`))})`
      : Prisma.empty;
  const termSql = terms.map((t) =>
    Prisma.join(
      t.variants.map((v) =>
        t.phrase ? Prisma.sql`phraseto_tsquery('simple', ${v})` : Prisma.sql`plainto_tsquery('simple', ${v})`,
      ),
      " || ",
    ),
  );

  // The meaning search, unless asked not to or not available.
  let mode: KbSearchMode = options.mode ?? "hybrid";
  let notice: string | null = null;
  let vector: (Candidate & { similarity: number })[] = [];
  if (mode === "hybrid") {
    const embedder = options.queryEmbedder === undefined ? defaultQueryEmbedder() : options.queryEmbedder;
    if (embedder === null) {
      mode = "keyword";
      notice = "Searched by words only: meaning-based search is not configured here.";
    } else {
      try {
        vector = await vectorCandidates(await embedder(options.query), projectFilter, scope.projectIds.length > 0);
      } catch (error) {
        mode = "keyword";
        notice = "Searched by words only: meaning-based search did not answer this time.";
        logUnexpected("kb.query_embedding_failed", error, { moduleKey: KNOWLEDGE_BASE_MODULE_KEY });
      }
    }
  }

  const keyword = termSql.length > 0 ? await keywordCandidates(termSql, projectFilter) : [];

  // Fuse by rank.
  const byId = new Map<string, Ranked>();
  const entry = (c: Candidate) => {
    const existing = byId.get(c.id);
    if (existing) return existing;
    const created: Ranked = { ...c, keywordRank: null, vectorRank: null, similarity: null, score: 0 };
    byId.set(c.id, created);
    return created;
  };
  keyword.forEach((c, i) => {
    const r = entry(c);
    r.keywordRank = i + 1;
    r.score += 1 / (KB_RRF_K + i + 1);
  });
  vector.forEach((c, i) => {
    const r = entry(c);
    r.vectorRank = i + 1;
    r.similarity = c.similarity;
    r.score += 1 / (KB_RRF_K + i + 1);
  });
  for (const r of byId.values()) {
    if (r.isLatest) r.score += VERSION_NUDGE;
    if (r.isArchived) r.score -= VERSION_NUDGE;
  }
  const ranked = [...byId.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  // Walk down the fused order: a copy of a chosen passage goes under it, then
  // the per-document cap. Text is read a batch at a time, only as far as needed.
  const perDocument = new Map<string, number>();
  const chosen: { ranked: Ranked; shingles: Set<string> | null; copies: Ranked[] }[] = [];
  choosing: for (let at = 0; at < ranked.length && chosen.length < limit; at += CONTENT_BATCH) {
    const batch = ranked.slice(at, at + CONTENT_BATCH);
    const contents = await passageContents(batch.map((r) => r.id));
    for (const r of batch) {
      const shingles = passageShingles(contents.get(r.id) ?? "");
      const original = chosen.find((c) => isSamePassage(c.shingles, shingles));
      if (original) {
        if (original.copies.length < KB_SEARCH_MAX_COPIES) original.copies.push(r);
        continue;
      }
      const n = perDocument.get(r.documentId) ?? 0;
      if (n >= KB_SEARCH_PER_DOCUMENT) continue;
      perDocument.set(r.documentId, n + 1);
      chosen.push({ ranked: r, shingles, copies: [] });
      if (chosen.length >= limit) break choosing;
    }
  }

  const ids = chosen.flatMap((c) => [c.ranked.id, ...c.copies.map((copy) => copy.id)]);
  const rows = ids.length > 0 ? await hydrate(ids, termSql) : new Map<string, HitRow>();
  const hits: KbSearchHit[] = [];
  for (const { ranked: c, copies } of chosen) {
    const r = rows.get(c.id);
    if (!r) continue; // re-indexed between the two queries
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
      matched: terms.filter((_, i) => r.matched?.[i]).map((t) => t.label),
      matchedBy: c.keywordRank !== null && c.vectorRank !== null ? "both" : c.vectorRank !== null ? "meaning" : "words",
      similarity: c.similarity,
      score: c.score,
      alsoIn: copies.flatMap((copy) => {
        const row = rows.get(copy.id);
        return row ? [copyOf(row)] : [];
      }),
    });
  }

  return {
    query: options.query,
    terms: terms.map((t) => t.label),
    scope,
    mode,
    notice,
    hits,
    candidates: byId.size,
  };
}

/** Passages holding any term, best first: coverage, file-name matches, then ts_rank_cd. */
async function keywordCandidates(termSql: Prisma.Sql[], projectFilter: Prisma.Sql): Promise<Candidate[]> {
  const anyTerm = Prisma.join(termSql.map((q) => Prisma.sql`(${q})`), " || ");
  const inContent = termSql.map((q) => Prisma.sql`(c.content_tsv @@ (${q}))`);
  const inName = termSql.map((q) => Prisma.sql`(n.name_tsv @@ (${q}))`);
  const count = (parts: Prisma.Sql[]) => Prisma.join(parts.map((p) => Prisma.sql`(${p})::int`), " + ");

  const rows = await prisma.$queryRaw<Array<{ id: string; document_id: string; is_latest: boolean; is_archived: boolean }>>`
    WITH q AS (SELECT (${anyTerm}) AS any_term)
    SELECT c.id::text AS id, d.id::text AS document_id, d.is_latest, d.is_archived
      FROM kb_chunks c
      JOIN kb_documents d ON d.id = c.document_id
      JOIN kb_projects p ON p.id = d.project_id
      CROSS JOIN q
      CROSS JOIN LATERAL (
        -- Underscores, dots and slashes to spaces first: the parser reads
        -- "224070_SUB_Fans_Approved_20240130.pdf" as ONE file-name token.
        SELECT to_tsvector('simple', regexp_replace(concat_ws(' ', d.file_name, d.path), '[_./]+', ' ', 'g')) AS name_tsv
      ) n
     WHERE c.content_tsv @@ q.any_term
       AND d.status = 'indexed' AND p.is_legacy ${projectFilter}
     ORDER BY ( (${count(termSql.map((_, i) => Prisma.sql`${inContent[i]!} OR ${inName[i]!}`))}) * 10.0
              + (${count(inName)}) * 2.0
              + ts_rank_cd(c.content_tsv, q.any_term, 32) * 5.0
              + CASE WHEN d.is_latest THEN 3.0 ELSE 0.0 END
              - CASE WHEN d.is_archived THEN 3.0 ELSE 0.0 END ) DESC, d.path, c.ordinal
     LIMIT ${CANDIDATES}`;
  return rows.map((r) => ({ id: r.id, documentId: r.document_id, isLatest: r.is_latest, isArchived: r.is_archived }));
}

/**
 * The passages nearest the question by cosine distance, above
 * KB_MIN_SIMILARITY. Across the whole library the HNSW index answers (with a
 * wider search than its default, ef_search 200, so filtering leaves enough).
 * Within chosen projects the distance is computed exactly over just their
 * passages instead: an approximate index filtered down to one project can
 * return too few.
 */
async function vectorCandidates(
  question: number[],
  projectFilter: Prisma.Sql,
  scoped: boolean,
): Promise<(Candidate & { similarity: number })[]> {
  const q = toVectorLiteral(question);
  const order = scoped ? Prisma.sql`(c.embedding <=> ${q}::vector) + 0` : Prisma.sql`c.embedding <=> ${q}::vector`;
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('hnsw.ef_search', '200', true)`;
    return tx.$queryRaw<Array<{ id: string; document_id: string; is_latest: boolean; is_archived: boolean; similarity: number }>>`
      SELECT c.id::text AS id, d.id::text AS document_id, d.is_latest, d.is_archived,
             (1 - (c.embedding <=> ${q}::vector))::float8 AS similarity
        FROM kb_chunks c
        JOIN kb_documents d ON d.id = c.document_id
        JOIN kb_projects p ON p.id = d.project_id
       WHERE c.embedding IS NOT NULL
         AND d.status = 'indexed' AND p.is_legacy ${projectFilter}
       ORDER BY ${order}
       LIMIT ${KB_VECTOR_CANDIDATES}`;
  });
  return rows
    .filter((r) => r.similarity >= KB_MIN_SIMILARITY)
    .map((r) => ({ id: r.id, documentId: r.document_id, isLatest: r.is_latest, isArchived: r.is_archived, similarity: r.similarity }));
}

async function passageContents(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Array<{ id: string; content: string }>>`
    SELECT id::text AS id, content FROM kb_chunks WHERE id = ANY(${ids}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r.content]));
}

function copyOf(r: HitRow): KbSearchCopy {
  return {
    chunkId: r.chunk_id,
    documentId: r.document_id,
    projectFolder: r.folder_name,
    fileName: r.file_name,
    path: r.path,
    webUrl: r.web_url,
    versionLabel: r.version_label,
    isLatest: r.is_latest,
    isArchived: r.is_archived,
    pageStart: r.page_start,
    pageEnd: r.page_end,
    section: r.section,
    sheet: r.sheet,
    cellRange: r.cell_range,
  };
}

/** What the screen shows for each chosen passage, with its snippet and the words it holds. */
async function hydrate(ids: string[], termSql: Prisma.Sql[]): Promise<Map<string, HitRow>> {
  const hasTerms = termSql.length > 0;
  const anyTerm = hasTerms ? Prisma.join(termSql.map((q) => Prisma.sql`(${q})`), " || ") : Prisma.sql`NULL::tsquery`;
  const matched = hasTerms
    ? Prisma.sql`ARRAY[${Prisma.join(
        termSql.map((q) => Prisma.sql`((c.content_tsv @@ (${q})) OR (n.name_tsv @@ (${q})))`),
      )}]`
    : Prisma.sql`NULL::boolean[]`;
  // With no words to mark, the snippet is the passage's opening.
  const snippet = hasTerms
    ? Prisma.sql`ts_headline('simple', c.content, q.any_term, ${HEADLINE})`
    : Prisma.sql`left(c.content, 320)`;

  const rows = await prisma.$queryRaw<HitRow[]>`
    WITH q AS (SELECT (${anyTerm}) AS any_term)
    SELECT c.id::text AS chunk_id, d.id::text AS document_id, p.id::text AS project_id,
           p.folder_name, p.project_number, d.file_name, d.path, d.folder_code, d.web_url,
           d.version_label, d.is_latest, d.is_archived,
           c.page_start, c.page_end, c.section, c.sheet, c.cell_range,
           ${snippet} AS snippet,
           ${matched} AS matched
      FROM kb_chunks c
      JOIN kb_documents d ON d.id = c.document_id
      JOIN kb_projects p ON p.id = d.project_id
      CROSS JOIN q
      CROSS JOIN LATERAL (
        SELECT to_tsvector('simple', regexp_replace(concat_ws(' ', d.file_name, d.path), '[_./]+', ' ', 'g')) AS name_tsv
      ) n
     WHERE c.id = ANY(${ids}::uuid[])`;
  return new Map(rows.map((r) => [r.chunk_id, r]));
}

// ---------------------------------------------------------------------------
// The question's vector
// ---------------------------------------------------------------------------

const QUERY_CACHE_SIZE = 500;
const queryCache = new Map<string, number[]>();
let configuredEmbedder: { key: string; embed: KbQueryEmbedder | null } | null = null;

/**
 * Azure OpenAI from the environment, or null when it is not configured. A
 * person is waiting, so one retry and a five-second limit, unlike the sync,
 * which waits out quota. Repeated questions are answered from a small
 * in-process cache: the same text always gets the same vector.
 */
function defaultQueryEmbedder(): KbQueryEmbedder | null {
  let env;
  try {
    env = readKbEmbeddingEnv();
  } catch {
    return null; // a key in production: refused there, so not available
  }
  if (!env.present) return null;
  const key = `${env.values.endpoint}|${env.values.deployment}|${env.values.apiKey ?? ""}`;
  if (configuredEmbedder?.key !== key) {
    let embed: KbQueryEmbedder | null;
    try {
      const batch = azureEmbedder(env.values, { maxAttempts: 2, timeoutMs: 5_000 });
      embed = async (text) => {
        const cached = queryCache.get(text);
        if (cached) return cached;
        const { vectors } = await batch([text]);
        const vector = vectors[0]!;
        if (queryCache.size >= QUERY_CACHE_SIZE) queryCache.delete(queryCache.keys().next().value!);
        queryCache.set(text, vector);
        return vector;
      };
    } catch {
      embed = null; // e.g. no key outside production
    }
    configuredEmbedder = { key, embed };
  }
  return configuredEmbedder.embed;
}

/** The projects a person can search, for the scope picker. */
export async function listSearchableProjects() {
  return prisma.kbProject.findMany({
    where: { isLegacy: true },
    orderBy: { folderName: "asc" },
    select: { id: true, folderName: true, projectNumber: true, name: true },
  });
}
