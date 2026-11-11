import { prisma } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { logger, logUnexpected } from "@/lib/logger";
import { QuestionRateLimiter } from "@/lib/modules/bas/analyze/rate-limit";
import {
  KB_ANSWER_MAX_PASSAGES,
  KB_ANSWER_PRIOR_TURNS,
  KB_ANSWER_UNSORTED_PASSAGES,
  KB_NO_EVIDENCE_TEXT,
  defaultAnswerer,
  finishAnswer,
  type KbAnswerer,
  type KbConflict,
  type KbPriorTurn,
} from "./answer";
import { KNOWLEDGE_BASE_MODULE_KEY } from "./constants";
import { defaultCondenser, joinWithLast, type KbCondenser } from "./followup";
import { locationLabel, versionText } from "./location";
import { reportedByViewer } from "./reports";
import type { KbReranker } from "./rerank";
import {
  parseQuery,
  passageTexts,
  searchPassages,
  type KbQueryEmbedder,
  type KbSearchHit,
  type KbSearchResult,
} from "./search";
import type { KbAnswerKind, KbScopeHow } from "./types";

/**
 * One question, start to finish, and its place in the shared history:
 *
 *   1. A follow-up is rewritten to stand alone for the search (followup.ts)
 *      and keeps the earlier question's projects unless it names its own.
 *   2. Search: words and meaning, copies collapsed, Haiku re-sorts (search.ts).
 *   3. The passages Haiku kept (at most KB_ANSWER_MAX_PASSAGES) go to Sonnet,
 *      which answers citing them (answer.ts). None kept: "no evidence", and
 *      Sonnet is not called - nothing is spent on a question the documents
 *      do not answer.
 *   4. The answer is checked (finishAnswer) and saved with a snapshot of every
 *      cited source, so the history reads the same after the index is rebuilt.
 *
 * Only final answers are history (types.ts): a question whose answer failed
 * is logged and not saved. History is shared - everyone with the module sees
 * every conversation - but only the person who started a conversation adds to
 * it; anyone else asks afresh.
 */

export type KbAnswerSource = {
  /** The citation number as shown. */
  n: number;
  chunkId: string;
  documentId: string;
  fileName: string;
  projectFolder: string;
  path: string;
  webUrl: string | null;
  versionLabel: string | null;
  isLatest: boolean;
  isArchived: boolean;
  pageStart: number | null;
  pageEnd: number | null;
  section: string | null;
  sheet: string | null;
  cellRange: string | null;
  /** The start of the passage, so the citation can be read without opening the file. */
  excerpt: string;
};

/** Stored in kb_questions.answer: everything the screen shows, as it was shown. */
export type KbAnswerSnapshot = {
  version: 1;
  kind: KbAnswerKind;
  text: string;
  missing: string | null;
  conflicts: KbConflict[];
  sources: KbAnswerSource[];
  /** What was searched: the question, or a follow-up rewritten to stand alone. */
  searchedFor: string;
  /** Passages the answer read. */
  considered: number;
  /** Anything the search had to say (words only, not re-sorted). */
  notices: string[];
};

export type KbAskedQuestion = {
  id: string;
  conversationId: string;
  ordinal: number;
  question: string;
  askedBy: { id: string; name: string } | null;
  createdAt: string;
  scope: { how: KbScopeHow; projectIds: string[] };
  answer: KbAnswerSnapshot;
  model: string | null;
  durationMs: number | null;
  /** Whether the person looking has an open report on this answer. */
  reportedByMe: boolean;
};

export type KbAskResult = { asked: KbAskedQuestion; search: KbSearchResult };

export type KbAskErrorCode =
  | "not_configured"
  | "conversation_not_found"
  | "not_your_conversation"
  | "rate_limited"
  | "answer_failed";

export class KbAskError extends Error {
  constructor(
    readonly code: KbAskErrorCode,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "KbAskError";
  }
}

/** Questions per person per minute: each one is up to three model calls. */
export const KB_QUESTIONS_PER_MINUTE = 10;
const limiter = new QuestionRateLimiter({ limit: KB_QUESTIONS_PER_MINUTE, windowMs: 60_000 });
const EXCERPT_CHARS = 700;

export async function askQuestion(input: {
  employeeId: string;
  question: string;
  conversationId?: string | null;
  /** Chosen projects. Absent: a follow-up keeps the earlier ones; otherwise a job number in the question, else all. */
  projectIds?: string[];
  /** Tests inject these; production reads the environment. */
  deps?: {
    answerer?: KbAnswerer | null;
    condenser?: KbCondenser | null;
    reranker?: KbReranker | null;
    queryEmbedder?: KbQueryEmbedder | null;
    limiter?: QuestionRateLimiter;
  };
}): Promise<KbAskResult> {
  const started = Date.now();
  const deps = input.deps ?? {};
  const question = input.question.trim();

  const answerer = deps.answerer === undefined ? defaultAnswerer() : deps.answerer;
  if (answerer === null) {
    throw new KbAskError("not_configured", "Answers are not configured here: the Knowledge Base has no Claude key.");
  }

  // The earlier turns, when this is a follow-up.
  let prior: { scopeProjectIds: string[]; turns: KbPriorTurn[] } | null = null;
  if (input.conversationId) {
    const conversation = await prisma.kbConversation.findUnique({
      where: { id: input.conversationId },
      select: {
        employeeId: true,
        questions: {
          orderBy: { ordinal: "desc" },
          take: KB_ANSWER_PRIOR_TURNS,
          select: { question: true, answer: true, scopeProjectIds: true },
        },
      },
    });
    if (!conversation) throw new KbAskError("conversation_not_found", "That conversation no longer exists.");
    if (conversation.employeeId !== input.employeeId) {
      throw new KbAskError(
        "not_your_conversation",
        "Only the person who started this conversation can add to it. Ask it as a new question.",
      );
    }
    const turns = [...conversation.questions].reverse();
    prior = {
      scopeProjectIds: turns.at(-1)?.scopeProjectIds ?? [],
      turns: turns.map((t) => ({ question: t.question, answer: (t.answer as KbAnswerSnapshot).text })),
    };
  }

  const verdict = (deps.limiter ?? limiter).check(input.employeeId);
  if (!verdict.allowed) {
    throw new KbAskError(
      "rate_limited",
      `That is ${KB_QUESTIONS_PER_MINUTE} questions in a minute. Try again in ${Math.ceil(verdict.retryAfterMs / 1000)} seconds.`,
      verdict.retryAfterMs,
    );
  }

  // What to search for, and where.
  let searchedFor = question;
  if (prior && prior.turns.length > 0) {
    const condenser = deps.condenser === undefined ? defaultCondenser() : deps.condenser;
    try {
      searchedFor = condenser ? await condenser(prior.turns, question) : joinWithLast(prior.turns, question);
    } catch (error) {
      searchedFor = joinWithLast(prior.turns, question);
      logUnexpected("kb.followup_condense_failed", error, { moduleKey: KNOWLEDGE_BASE_MODULE_KEY });
    }
  }
  const chosen = input.projectIds && input.projectIds.length > 0 ? input.projectIds : null;
  const inherit =
    !chosen && prior !== null && prior.scopeProjectIds.length > 0 && parseQuery(question).jobNumbers.length === 0;
  const search = await searchPassages({
    query: searchedFor,
    projectIds: chosen ?? (inherit ? prior!.scopeProjectIds : undefined),
    ...(deps.reranker !== undefined ? { reranker: deps.reranker } : {}),
    ...(deps.queryEmbedder !== undefined ? { queryEmbedder: deps.queryEmbedder } : {}),
  });
  const scopeHow: KbScopeHow = chosen ? "chosen" : inherit ? "follow_up" : search.scope.how;

  // The evidence: what the re-sort kept, or the top of the list without one.
  const evidence = search.reranked
    ? search.hits.filter((h) => h.relevant).slice(0, KB_ANSWER_MAX_PASSAGES)
    : search.hits.slice(0, KB_ANSWER_UNSORTED_PASSAGES);
  const texts = evidence.length > 0 ? await passageTexts(evidence.map((h) => h.chunkId)) : new Map<string, string>();

  let model: string | null = null;
  let finished: ReturnType<typeof finishAnswer>;
  if (evidence.length === 0) {
    finished = {
      kind: "no_evidence",
      text: search.hits.length === 0 ? "Nothing in the indexed documents matches this." : KB_NO_EVIDENCE_TEXT,
      missing: null,
      conflicts: [],
      cited: [],
    };
  } else {
    try {
      const result = await answerer({
        question,
        priorTurns: prior?.turns ?? [],
        passages: evidence.map((h, i) => ({
          n: i + 1,
          fileName: h.fileName,
          projectFolder: h.projectFolder,
          where: locationLabel(h),
          version: versionText(h),
          content: texts.get(h.chunkId) ?? h.snippet,
        })),
      });
      model = result.model;
      finished = finishAnswer(result.draft, evidence.length);
    } catch (error) {
      logUnexpected("kb.answer_failed", error, { moduleKey: KNOWLEDGE_BASE_MODULE_KEY, employeeId: input.employeeId });
      throw new KbAskError("answer_failed", "Claude did not answer this time. The search results are below; try again.");
    }
  }

  const sources = finished.cited.map((sent, i) => sourceOf(evidence[sent - 1]!, i + 1, texts));
  const snapshot: KbAnswerSnapshot = {
    version: 1,
    kind: finished.kind,
    text: finished.text,
    missing: finished.missing,
    conflicts: finished.conflicts,
    sources,
    searchedFor,
    considered: evidence.length,
    notices: [search.notice, search.rerankNotice].filter((n): n is string => n !== null),
  };
  const durationMs = Date.now() - started;

  const saved = await save({
    employeeId: input.employeeId,
    conversationId: input.conversationId ?? null,
    question,
    scopeHow,
    scopeProjectIds: search.scope.projectIds,
    snapshot,
    model,
    durationMs,
  });

  logger.info("kb.question_answered", {
    outcome: snapshot.kind,
    employeeId: input.employeeId,
    moduleKey: KNOWLEDGE_BASE_MODULE_KEY,
    count: sources.length,
    durationMs,
  });
  return { asked: saved, search };
}

function sourceOf(hit: KbSearchHit, n: number, texts: Map<string, string>): KbAnswerSource {
  return {
    n,
    chunkId: hit.chunkId,
    documentId: hit.documentId,
    fileName: hit.fileName,
    projectFolder: hit.projectFolder,
    path: hit.path,
    webUrl: hit.webUrl,
    versionLabel: hit.versionLabel,
    isLatest: hit.isLatest,
    isArchived: hit.isArchived,
    pageStart: hit.pageStart,
    pageEnd: hit.pageEnd,
    section: hit.section,
    sheet: hit.sheet,
    cellRange: hit.cellRange,
    excerpt: (texts.get(hit.chunkId) ?? hit.snippet).slice(0, EXCERPT_CHARS),
  };
}

async function save(row: {
  employeeId: string;
  conversationId: string | null;
  question: string;
  scopeHow: KbScopeHow;
  scopeProjectIds: string[];
  snapshot: KbAnswerSnapshot;
  model: string | null;
  durationMs: number;
}): Promise<KbAskedQuestion> {
  // Two follow-ups sent at once race for the next ordinal; the unique index
  // refuses the second, which simply takes the one after.
  for (let attempt = 1; ; attempt += 1) {
    try {
      const id = await prisma.$transaction(async (tx) => {
        const conversationId =
          row.conversationId ?? (await tx.kbConversation.create({ data: { employeeId: row.employeeId } })).id;
        const ordinal = await tx.kbQuestion.count({ where: { conversationId } });
        const created = await tx.kbQuestion.create({
          data: {
            conversationId,
            ordinal,
            question: row.question,
            scopeHow: row.scopeHow,
            scopeProjectIds: row.scopeProjectIds,
            answerKind: row.snapshot.kind,
            answer: row.snapshot as unknown as Prisma.InputJsonValue,
            model: row.model,
            durationMs: row.durationMs,
          },
        });
        if (row.snapshot.sources.length > 0) {
          await tx.kbQuestionSource.createMany({
            data: row.snapshot.sources.map((s) => ({
              questionId: created.id,
              n: s.n,
              documentId: s.documentId,
              chunkId: s.chunkId,
            })),
          });
        }
        await tx.kbConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
        return created.id;
      });
      const [asked] = await questionsWhere({ id }, row.employeeId);
      return asked!;
    } catch (error) {
      const raced = error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
      if (!raced || attempt >= 3) throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// The shared history
// ---------------------------------------------------------------------------

export type KbConversationSummary = {
  id: string;
  startedBy: { id: string; name: string } | null;
  firstQuestion: string;
  questionCount: number;
  lastAnswerKind: KbAnswerKind | null;
  updatedAt: string;
};

export const KB_HISTORY_PAGE = 30;

const nameOf = (e: { id: string; firstName: string; lastName: string } | null) =>
  e ? { id: e.id, name: `${e.firstName} ${e.lastName}`.trim() } : null;

/**
 * Everyone's conversations, newest activity first (`mine` narrows to one
 * person's). Paged by `before`: the updatedAt and id of the last row shown,
 * so a conversation updated while someone pages is neither repeated nor lost.
 */
export async function listConversations(options: {
  employeeId?: string;
  before?: { updatedAt: Date; id: string };
  limit?: number;
}): Promise<KbConversationSummary[]> {
  const limit = Math.min(options.limit ?? KB_HISTORY_PAGE, 100);
  const rows = await prisma.kbConversation.findMany({
    where: {
      ...(options.employeeId ? { employeeId: options.employeeId } : {}),
      ...(options.before
        ? {
            OR: [
              { updatedAt: { lt: options.before.updatedAt } },
              { updatedAt: options.before.updatedAt, id: { lt: options.before.id } },
            ],
          }
        : {}),
      questions: { some: {} },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: limit,
    select: {
      id: true,
      updatedAt: true,
      employee: { select: { id: true, firstName: true, lastName: true } },
      _count: { select: { questions: true } },
      questions: { orderBy: { ordinal: "asc" }, select: { question: true, answerKind: true, ordinal: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    startedBy: nameOf(r.employee),
    firstQuestion: r.questions[0]?.question ?? "",
    questionCount: r._count.questions,
    lastAnswerKind: (r.questions.at(-1)?.answerKind as KbAnswerKind | undefined) ?? null,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** One conversation, every question in order. Null when it does not exist. */
export async function getConversation(
  id: string,
  viewerId: string,
): Promise<{ id: string; startedBy: { id: string; name: string } | null; mine: boolean; questions: KbAskedQuestion[] } | null> {
  const conversation = await prisma.kbConversation.findUnique({
    where: { id },
    select: { id: true, employeeId: true, employee: { select: { id: true, firstName: true, lastName: true } } },
  });
  if (!conversation) return null;
  return {
    id: conversation.id,
    startedBy: nameOf(conversation.employee),
    mine: conversation.employeeId === viewerId,
    questions: await questionsWhere({ conversationId: id }, viewerId),
  };
}

async function questionsWhere(
  where: { id: string } | { conversationId: string },
  viewerId: string,
): Promise<KbAskedQuestion[]> {
  const rows = await prisma.kbQuestion.findMany({
    where,
    orderBy: { ordinal: "asc" },
    include: { conversation: { select: { employee: { select: { id: true, firstName: true, lastName: true } } } } },
  });
  const reported = await reportedByViewer(rows.map((q) => q.id), viewerId);
  return rows.map((q) => ({
    id: q.id,
    conversationId: q.conversationId,
    ordinal: q.ordinal,
    question: q.question,
    askedBy: nameOf(q.conversation.employee),
    createdAt: q.createdAt.toISOString(),
    scope: { how: q.scopeHow as KbScopeHow, projectIds: q.scopeProjectIds },
    answer: q.answer as unknown as KbAnswerSnapshot,
    model: q.model,
    durationMs: q.durationMs,
    reportedByMe: reported.has(q.id),
  }));
}
