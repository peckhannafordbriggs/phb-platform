import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { logUnexpected } from "@/lib/logger";
import { GRAPH_PARALLEL, limiter, type FolderReader, type StoreEntry } from "@/lib/sharepoint/folder-store";
import { KNOWLEDGE_BASE_MODULE_KEY } from "./constants";
import { parseFileName, pickLatest, type KbParsedName } from "./naming";
import { classifyPath, type KbScopeDecision } from "./scope";
import { azureEmbedder, KB_EMBEDDING_MODEL, type KbEmbedder } from "./embed";
import { embedPending } from "./embedder";
import { readKbEmbeddingEnv } from "./env";
import { indexPending, type KbIndexCounts } from "./indexer";
import { kbSource, type KbSource } from "./source";
import type { KbSyncTrigger } from "./types";

/**
 * The Knowledge Base sync: list the library, then make kb_projects and
 * kb_documents match it. One pipeline, run by a person (the admin's button,
 * `npm run kb:sync`) and later on a schedule.
 *
 * Every direct subfolder of the library is a project, and every project is
 * legacy (docs/KB-P0-P1.md). Every file in a project gets a kb_documents row:
 * scope.ts decides indexed or skipped, naming.ts the version family, and the
 * newest non-archived member of each family is `is_latest`.
 *
 * A file that is new, changed (its content tag differs), failed last time, or
 * was skipped under an older rule becomes `pending` and loses its chunks.
 * The sync then runs the indexer (indexer.ts), which reads each `pending`
 * file into passages. An unchanged indexed file is left alone, so a sync with
 * nothing new costs one listing and no reads.
 *
 * Two ways in: `npm run kb:sync` runs one here and now; the admin's Index
 * button queues one (queueKbSync) for the worker job, which claims it
 * (claimQueuedKbSync) and runs it with `claimedId`.
 *
 * Safety, from Cost Intelligence's project sync:
 * - One sync at a time, queued or running (kb_sync_runs_one_active_key). A
 *   `running` row with no heartbeat for KB_SYNC_ABANDONED_AFTER_MS crashed,
 *   and is closed; so is a `queued` row nobody claimed within the hour.
 * - Zero projects found fails the sync and changes nothing: a wrong path or an
 *   unsynced OneDrive folder must not empty the index.
 * - A project that could not be read keeps its rows as they were (`partial`).
 * - Each project is saved in its own transaction, then removals in one, then
 *   each indexed document in its own; the run row and the audit row last.
 *
 * Removal deletes rows rather than marking them: the index is derived, and
 * question history keeps its snapshot (kb_question_sources goes NULL).
 */

/** A running sync stamps its heartbeat after every project and document. */
export const KB_SYNC_ABANDONED_AFTER_MS = 10 * 60 * 1000;

/** OS litter, Office and LibreOffice lock files. Never a row. */
const IGNORED = /^(?:~\$.*|\.~lock\..*#|\.DS_Store|Thumbs\.db|desktop\.ini)$/i;

const PROJECT_NUMBER = /^(\d{6})_(.*)$/;

type ListedFile = {
  /** Relative to the library root: `<project>/<folders>/<file>`. */
  rel: string;
  /** Relative to the project folder. Stored as kb_documents.path. */
  inProject: string;
  entry: StoreEntry;
};

type ListedProject = { entry: StoreEntry; files: ListedFile[] };

export type KbProjectError = { folderName: string; reason: string };

export type KbSyncOutcome = {
  /** Null when no sync could start (the source is not configured). */
  syncId: string | null;
  status: "ok" | "partial" | "failed";
  projectsSeen: number;
  projectsRemoved: number;
  filesSeen: number;
  /** New or changed, waiting for the indexer. */
  filesQueued: number;
  filesUnchanged: number;
  filesSkipped: number;
  filesRemoved: number;
  /** What the indexer did in this sync (all zero with `index: false`). */
  filesIndexed: number;
  filesFailed: number;
  /** Read cleanly with no text: also counted in filesSkipped. */
  filesEmpty: number;
  chunksWritten: number;
  /** Passages given a vector this sync, and the tokens Azure counted. */
  chunksEmbedded: number;
  embeddingTokens: number;
  /** Why embedding did not run or did not finish; null when it completed or was not asked for. */
  embedding: { state: "done" | "not_configured" | "stopped" | "skipped"; message: string | null };
  errors: KbProjectError[];
  /** Why a failed sync failed, in plain words. */
  message: string | null;
};

/** Another sync is running. A route answers 409. */
export class KbSyncInProgressError extends Error {
  constructor() {
    super("A Knowledge Base sync is already running. Try again when it finishes.");
    this.name = "KbSyncInProgressError";
  }
}

const EMPTY = {
  projectsSeen: 0,
  projectsRemoved: 0,
  filesSeen: 0,
  filesQueued: 0,
  filesUnchanged: 0,
  filesSkipped: 0,
  filesRemoved: 0,
  filesIndexed: 0,
  filesFailed: 0,
  filesEmpty: 0,
  chunksWritten: 0,
  chunksEmbedded: 0,
  embeddingTokens: 0,
};

/** A queued sync no worker has picked up in this long is closed, so it stops blocking. */
export const KB_SYNC_QUEUE_EXPIRES_MS = 60 * 60 * 1000;

/** The library is not configured; nothing can be queued or run. A route answers 503. */
export class KbSourceNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KbSourceNotConfiguredError";
  }
}

/**
 * Closes syncs that will never finish: a running one silent for ten minutes
 * (its process died) and a queued one no worker picked up within the hour.
 * Called before anything takes the one active slot.
 */
export async function closeStaleKbSyncs(now: Date): Promise<number> {
  const silentSince = new Date(now.getTime() - KB_SYNC_ABANDONED_AFTER_MS);
  const running = await prisma.kbSyncRun.updateMany({
    where: {
      status: "running",
      OR: [{ heartbeatAt: { lt: silentSince } }, { heartbeatAt: null, startedAt: { lt: silentSince } }],
    },
    data: { status: "failed", finishedAt: now, error: "Abandoned: no sign of life for ten minutes." },
  });
  const queued = await prisma.kbSyncRun.updateMany({
    where: { status: "queued", startedAt: { lt: new Date(now.getTime() - KB_SYNC_QUEUE_EXPIRES_MS) } },
    data: {
      status: "failed",
      finishedAt: now,
      error: "Never picked up: no Knowledge Base worker took it within an hour.",
    },
  });
  return running.count + queued.count;
}

/**
 * Asks the worker for a sync: the admin's Index button. Writes one `queued`
 * kb_sync_runs row, which the worker job's scaler sees within seconds and
 * claims (claimQueuedKbSync). One active sync at a time - queued or running
 * (kb_sync_runs_one_active_key) - so a second press while one is waiting or
 * working is KbSyncInProgressError, not a second sync.
 */
export async function queueKbSync(options: {
  trigger: KbSyncTrigger;
  triggeredById: string | null;
  now?: () => Date;
}): Promise<{ syncId: string; queuedAt: Date }> {
  const now = options.now ?? (() => new Date());
  const choice = kbSource();
  if (!choice.ok) throw new KbSourceNotConfiguredError(choice.message);

  await closeStaleKbSyncs(now());
  try {
    const row = await prisma.kbSyncRun.create({
      data: {
        sourceKind: choice.source.kind,
        status: "queued",
        trigger: options.trigger,
        triggeredById: options.triggeredById,
        startedAt: now(),
      },
      select: { id: true, startedAt: true },
    });
    return { syncId: row.id, queuedAt: row.startedAt };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new KbSyncInProgressError();
    }
    throw error;
  }
}

export type KbClaimedSync = {
  id: string;
  trigger: KbSyncTrigger;
  triggeredById: string | null;
  sourceKind: "sharepoint" | "local";
};

/**
 * The worker's half: take the oldest queued sync and mark it running, in one
 * statement, skipping any row another worker has locked. Null when there is
 * nothing to do. `started_at` becomes the time work began.
 */
export async function claimQueuedKbSync(now: Date): Promise<KbClaimedSync | null> {
  await closeStaleKbSyncs(now);
  const rows = await prisma.$queryRaw<
    Array<{ id: string; trigger: KbSyncTrigger; triggered_by_id: string | null; source_kind: "sharepoint" | "local" }>
  >`
    UPDATE kb_sync_runs
       SET status = 'running', started_at = ${now}, heartbeat_at = ${now}
     WHERE id = (
       SELECT id FROM kb_sync_runs
        WHERE status = 'queued'
        ORDER BY started_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id::text, trigger, triggered_by_id::text, source_kind::text`;
  const row = rows[0];
  return row
    ? { id: row.id, trigger: row.trigger, triggeredById: row.triggered_by_id, sourceKind: row.source_kind }
    : null;
}

export async function syncKnowledgeBase(options: {
  trigger: KbSyncTrigger;
  triggeredById: string | null;
  /** A source instead of the configured one (tests, one-off local runs). */
  source?: KbSource;
  /** Read new and changed files into passages. Default true; false lists only. */
  index?: boolean;
  /** Embed passages that have no vector. Default true; skipped when embeddings are not configured. */
  embed?: boolean;
  /** An embedder instead of Azure OpenAI from the environment (tests). */
  embedder?: KbEmbedder;
  /** A sync the worker already claimed (claimQueuedKbSync): run it rather than start a new one. */
  claimedId?: string;
  now?: () => Date;
}): Promise<KbSyncOutcome> {
  const now = options.now ?? (() => new Date());

  const choice = options.source ? { ok: true as const, source: options.source } : kbSource();
  if (!choice.ok) {
    if (options.claimedId) {
      await prisma.kbSyncRun.update({
        where: { id: options.claimedId },
        data: { status: "failed", finishedAt: now(), error: choice.message },
      });
    }
    await kbAudit("kb.sync_failed", options.triggeredById, {
      ...(options.claimedId ? { syncId: options.claimedId } : {}),
      trigger: options.trigger,
      error: choice.message,
    });
    return {
      syncId: options.claimedId ?? null,
      status: "failed",
      ...EMPTY,
      embedding: { state: "skipped", message: null },
      errors: [],
      message: choice.message,
    };
  }
  const { source } = choice;

  let syncId: string;
  if (options.claimedId) {
    syncId = options.claimedId;
  } else {
    await closeStaleKbSyncs(now());
    try {
      ({ id: syncId } = await prisma.kbSyncRun.create({
        data: {
          sourceKind: source.kind,
          trigger: options.trigger,
          triggeredById: options.triggeredById,
          startedAt: now(),
        },
        select: { id: true },
      }));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new KbSyncInProgressError();
      }
      throw error;
    }
  }

  const fail = async (message: string, errors: KbProjectError[] = []): Promise<KbSyncOutcome> => {
    await prisma.kbSyncRun.update({
      where: { id: syncId },
      data: { status: "failed", finishedAt: now(), projectsSeen: errors.length, error: message },
    });
    await kbAudit("kb.sync_failed", options.triggeredById, { syncId, trigger: options.trigger, error: message });
    return {
      syncId,
      status: "failed",
      ...EMPTY,
      projectsSeen: errors.length,
      embedding: { state: "skipped", message: null },
      errors,
      message,
    };
  };

  try {
    let listed: { projects: ListedProject[]; errors: (KbProjectError & { id: string })[] };
    try {
      listed = await listLibrary(source.store);
    } catch (error) {
      return await fail(`Could not read the library (${source.label}): ${errorText(error)}. Nothing was changed.`);
    }

    const errors = [...listed.errors];
    if (listed.projects.length === 0) {
      return await fail(
        errors.length > 0
          ? `None of the ${errors.length} project folder(s) could be read. Nothing was changed.`
          : `The library (${source.label}) holds no project folders. Check the configured folder. Nothing was changed.`,
        errors,
      );
    }

    const heartbeat = () => prisma.kbSyncRun.update({ where: { id: syncId }, data: { heartbeatAt: now() } });
    const totals = { ...EMPTY };
    const saved: string[] = [];
    for (const project of listed.projects) {
      try {
        const counts = await saveProject(source.kind, project, now());
        saved.push(project.entry.id);
        for (const key of Object.keys(counts) as (keyof typeof counts)[]) totals[key] += counts[key];
        await heartbeat();
      } catch (error) {
        // Rolled back: the project keeps its rows as they were.
        logUnexpected("kb.sync_project_failed", error, { moduleKey: KNOWLEDGE_BASE_MODULE_KEY });
        errors.push({ id: project.entry.id, folderName: project.entry.name, reason: errorText(error) });
      }
    }

    const status = errors.length > 0 ? "partial" : "ok";
    // Gone from the library. A project that only failed to read or save is not gone.
    const present = [...saved, ...errors.map((e) => e.id)];
    const gone = { sourceKind: source.kind, sourceId: { notIn: present } };
    const projectErrors = errors.map(({ folderName, reason }) => ({ folderName, reason }));

    await prisma.$transaction(async (tx) => {
      totals.filesRemoved += await tx.kbDocument.count({ where: { project: gone } });
      totals.projectsRemoved = (await tx.kbProject.deleteMany({ where: gone })).count;
    });
    totals.projectsSeen = listed.projects.length + listed.errors.length;

    if (options.index !== false) {
      const indexed: KbIndexCounts = await indexPending({
        source,
        now,
        onProgress: async () => {
          await heartbeat();
        },
      });
      Object.assign(totals, indexed);
      totals.filesSkipped += indexed.filesEmpty;
    }

    const embedding = await embedStep(options, heartbeat, totals);
    const finalStatus = status === "ok" && embedding.state === "stopped" ? "partial" : status;
    const problems = [
      ...(errors.length > 0 ? [describeErrors(projectErrors)] : []),
      ...(embedding.state === "stopped" && embedding.message ? [embedding.message] : []),
    ];

    await prisma.$transaction(async (tx) => {
      await tx.kbSyncRun.update({
        where: { id: syncId },
        data: {
          status: finalStatus,
          finishedAt: now(),
          projectsSeen: totals.projectsSeen,
          filesSeen: totals.filesSeen,
          filesUnchanged: totals.filesUnchanged,
          filesSkipped: totals.filesSkipped,
          filesRemoved: totals.filesRemoved,
          filesIndexed: totals.filesIndexed,
          filesFailed: totals.filesFailed,
          chunksWritten: totals.chunksWritten,
          chunksEmbedded: totals.chunksEmbedded,
          embeddingTokens: totals.embeddingTokens,
          embeddingModel: totals.chunksEmbedded > 0 ? KB_EMBEDDING_MODEL : null,
          error: problems.length > 0 ? problems.join(" ") : null,
        },
      });

      await writeAuditEvent(tx, {
        action: "kb.synced",
        actorEmployeeId: options.triggeredById,
        moduleKey: KNOWLEDGE_BASE_MODULE_KEY,
        metadata: {
          syncId,
          trigger: options.trigger,
          source: source.kind,
          status: finalStatus,
          ...totals,
          embedding: embedding.state,
          projectsFailed: errors.length,
        },
      });
    });

    return { syncId, status: finalStatus, ...totals, embedding, errors: projectErrors, message: null };
  } catch (error) {
    await fail(
      "The sync stopped unexpectedly. Projects and documents already saved keep their new state; running it again continues.",
    ).catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

/**
 * The sync's last step. Not configured is not a failure: the index works on
 * keyword search alone, and says so. A refusal from Azure (quota, key, role)
 * stops embedding, makes the sync `partial`, and leaves the rest for the next.
 */
async function embedStep(
  options: { embed?: boolean; embedder?: KbEmbedder },
  heartbeat: () => Promise<unknown>,
  totals: { chunksEmbedded: number; embeddingTokens: number },
): Promise<KbSyncOutcome["embedding"]> {
  if (options.embed === false) return { state: "skipped", message: null };
  try {
    let embedder = options.embedder;
    if (!embedder) {
      const env = readKbEmbeddingEnv();
      if (!env.present) {
        return { state: "not_configured", message: `Embedding is not configured (${env.missing.join(", ")}).` };
      }
      embedder = azureEmbedder(env.values);
    }
    const counts = await embedPending({
      embedder,
      onProgress: async (c) => {
        totals.chunksEmbedded = c.chunksEmbedded;
        totals.embeddingTokens = c.embeddingTokens;
        await heartbeat();
      },
    });
    totals.chunksEmbedded = counts.chunksEmbedded;
    totals.embeddingTokens = counts.embeddingTokens;
    return { state: "done", message: null };
  } catch (error) {
    logUnexpected("kb.embedding_stopped", error, { moduleKey: KNOWLEDGE_BASE_MODULE_KEY });
    return {
      state: "stopped",
      message: `Embedding stopped after ${totals.chunksEmbedded} passages: ${errorText(error)} The next sync continues.`,
    };
  }
}

// ---------------------------------------------------------------------------
// Saving one project
// ---------------------------------------------------------------------------

type Planned = { file: ListedFile; decision: KbScopeDecision; parsed: KbParsedName };

/** What a sync changes about a row's processing state. Empty: leave it. */
type DocState = {
  status?: "pending" | "skipped";
  skipReason?: string | null;
  error?: null;
  chunkCount?: number;
  indexedAt?: null;
  embeddingModel?: null;
};

/** No chunks, not indexed: what a new, changed or skipped file starts from. */
const RESET = { error: null, chunkCount: 0, indexedAt: null, embeddingModel: null } as const;

async function saveProject(kind: "sharepoint" | "local", project: ListedProject, now: Date) {
  const plan: Planned[] = project.files.map((file) => ({
    file,
    decision: classifyPath(file.rel, file.entry.size),
    parsed: parseFileName(file.entry.name),
  }));

  // The current version of each family, among the files that are indexed.
  const families = new Map<string, { path: string; parsed: KbParsedName }[]>();
  for (const p of plan) {
    if (!p.decision.include) continue;
    const members = families.get(p.parsed.familyKey) ?? [];
    members.push({ path: p.file.rel, parsed: p.parsed });
    families.set(p.parsed.familyKey, members);
  }
  const latest = new Set<string>();
  for (const members of families.values()) {
    const best = pickLatest(members);
    if (best) latest.add(best.path);
  }

  const counts = { filesSeen: plan.length, filesQueued: 0, filesUnchanged: 0, filesSkipped: 0, filesRemoved: 0 };
  const folderName = project.entry.name;
  const numbered = PROJECT_NUMBER.exec(folderName);
  const projectData = {
    folderName,
    projectNumber: numbered?.[1] ?? null,
    name: (numbered?.[2] ?? folderName).replace(/_/g, " ").trim() || folderName,
    webUrl: kind === "sharepoint" ? project.entry.location : null,
    isLegacy: true,
    lastSeenAt: now,
  };

  await prisma.$transaction(
    async (tx) => {
      const { id: projectId } = await tx.kbProject.upsert({
        where: { sourceKind_sourceId: { sourceKind: kind, sourceId: project.entry.id } },
        create: { sourceKind: kind, sourceId: project.entry.id, ...projectData },
        update: projectData,
        select: { id: true },
      });

      const ids = plan.map((p) => p.file.entry.id);
      const prior = new Map(
        (
          await tx.kbDocument.findMany({
            where: { sourceKind: kind, sourceId: { in: ids } },
            select: { id: true, sourceId: true, etag: true, status: true },
          })
        ).map((row) => [row.sourceId, row]),
      );

      const clearChunks: string[] = [];
      for (const { file, decision, parsed } of plan) {
        const before = prior.get(file.entry.id);
        const facts = {
          projectId,
          path: file.inProject,
          fileName: file.entry.name,
          fileType: decision.fileType,
          webUrl: kind === "sharepoint" ? file.entry.location : null,
          etag: file.entry.contentTag,
          sizeBytes: BigInt(file.entry.size),
          sourceModifiedAt: file.entry.modified,
          folderCode: decision.folderCode,
          familyKey: parsed.familyKey,
          versionLabel: parsed.versionLabel,
          isArchived: decision.archived,
          isLatest: latest.has(file.rel),
          lastSeenAt: now,
        };

        let state: DocState;
        if (!decision.include) {
          state = { status: "skipped", skipReason: decision.reason, ...RESET };
          counts.filesSkipped += 1;
          if (before && before.status !== "skipped") clearChunks.push(before.id);
        } else if (
          before === undefined ||
          before.etag !== facts.etag ||
          before.status === "skipped" ||
          before.status === "failed"
        ) {
          state = { status: "pending", skipReason: null, ...RESET };
          counts.filesQueued += 1;
          if (before) clearChunks.push(before.id);
        } else {
          // Unchanged: an indexed file stays indexed, a pending one keeps waiting.
          state = {};
          if (before.status === "pending") counts.filesQueued += 1;
          else counts.filesUnchanged += 1;
        }

        if (before === undefined) {
          await tx.kbDocument.create({
            data: { sourceKind: kind, sourceId: file.entry.id, ...facts, ...state },
          });
        } else {
          await tx.kbDocument.update({ where: { id: before.id }, data: { ...facts, ...state } });
        }
      }

      if (clearChunks.length > 0) {
        await tx.kbChunk.deleteMany({ where: { documentId: { in: clearChunks } } });
      }

      // Gone from this project folder.
      const removed = await tx.kbDocument.deleteMany({ where: { projectId, sourceId: { notIn: ids } } });
      counts.filesRemoved = removed.count;
    },
    // One write per file; a large project outlasts the 5 s default.
    { timeout: 120_000 },
  );

  return counts;
}

// ---------------------------------------------------------------------------
// Reading the library
// ---------------------------------------------------------------------------

async function listLibrary(store: FolderReader) {
  const projects: ListedProject[] = [];
  const errors: (KbProjectError & { id: string })[] = [];
  // Files directly at the library root belong to no project and are not listed.
  const folders = (await store.list("")).filter((e) => e.folder && !IGNORED.test(e.name));

  // Every project at once, with one limit on requests in flight across all of them.
  const limit = limiter(GRAPH_PARALLEL);
  await Promise.all(
    folders.map(async (entry) => {
      try {
        projects.push({ entry, files: await listFiles(store, entry.name, "", limit) });
      } catch (error) {
        errors.push({ id: entry.id, folderName: entry.name, reason: errorText(error) });
      }
    }),
  );

  projects.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
  errors.sort((a, b) => a.folderName.localeCompare(b.folderName));
  return { projects, errors };
}

async function listFiles(
  store: FolderReader,
  project: string,
  inProject: string,
  limit: ReturnType<typeof limiter>,
): Promise<ListedFile[]> {
  const dir = inProject ? `${project}/${inProject}` : project;
  const entries = (await limit(() => store.list(dir))).filter((e) => !IGNORED.test(e.name));
  const nested = await Promise.all(
    entries.map(async (entry): Promise<ListedFile[]> => {
      const childPath = inProject ? `${inProject}/${entry.name}` : entry.name;
      if (entry.folder) return listFiles(store, project, childPath, limit);
      return [{ rel: `${project}/${childPath}`, inProject: childPath, entry }];
    }),
  );
  return nested.flat();
}

// ---------------------------------------------------------------------------

/** The most recent sync, for the admin's "Last synced" line. */
export async function getLatestKbSync() {
  return prisma.kbSyncRun.findFirst({ orderBy: { startedAt: "desc" } });
}

type KbAction = "kb.synced" | "kb.sync_failed";

/** A sync outcome in audit_events. Never throws: losing the sync over its audit row would be worse. */
async function kbAudit(action: KbAction, actorEmployeeId: string | null, metadata: Record<string, unknown>) {
  try {
    await writeAuditEvent(prisma, { action, actorEmployeeId, moduleKey: KNOWLEDGE_BASE_MODULE_KEY, metadata });
  } catch (error) {
    logUnexpected("kb.audit_write_failed", error, { reason: action, moduleKey: KNOWLEDGE_BASE_MODULE_KEY });
  }
}

function describeErrors(errors: KbProjectError[]): string {
  const list = errors.map((e) => `${e.folderName} (${e.reason})`).join("; ");
  const text = `${errors.length} project folder(s) could not be read and kept their previous rows: ${list}`;
  return text.length > 2000 ? `${text.slice(0, 2000)}...` : text;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
