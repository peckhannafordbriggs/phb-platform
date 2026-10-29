import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { logUnexpected } from "@/lib/logger";
import { GRAPH_PARALLEL, limiter, type FolderReader, type StoreEntry } from "@/lib/sharepoint/folder-store";
import { KNOWLEDGE_BASE_MODULE_KEY } from "./constants";
import { parseFileName, pickLatest, type KbParsedName } from "./naming";
import { classifyPath, type KbScopeDecision } from "./scope";
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
 * Safety, from Cost Intelligence's project sync:
 * - One sync at a time (kb_sync_runs_one_running_key). A `running` row with
 *   no heartbeat for KB_SYNC_ABANDONED_AFTER_MS crashed, and is closed.
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
};

export async function syncKnowledgeBase(options: {
  trigger: KbSyncTrigger;
  triggeredById: string | null;
  /** A source instead of the configured one (tests, one-off local runs). */
  source?: KbSource;
  /** Read new and changed files into passages. Default true; false lists only. */
  index?: boolean;
  now?: () => Date;
}): Promise<KbSyncOutcome> {
  const now = options.now ?? (() => new Date());

  const choice = options.source ? { ok: true as const, source: options.source } : kbSource();
  if (!choice.ok) {
    await kbAudit("kb.sync_failed", options.triggeredById, { trigger: options.trigger, error: choice.message });
    return { syncId: null, status: "failed", ...EMPTY, errors: [], message: choice.message };
  }
  const { source } = choice;

  const silentSince = new Date(now().getTime() - KB_SYNC_ABANDONED_AFTER_MS);
  await prisma.kbSyncRun.updateMany({
    where: {
      status: "running",
      OR: [{ heartbeatAt: { lt: silentSince } }, { heartbeatAt: null, startedAt: { lt: silentSince } }],
    },
    data: { status: "failed", finishedAt: now(), error: "Abandoned: no sign of life for ten minutes." },
  });

  let syncId: string;
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

  const fail = async (message: string, errors: KbProjectError[] = []): Promise<KbSyncOutcome> => {
    await prisma.kbSyncRun.update({
      where: { id: syncId },
      data: { status: "failed", finishedAt: now(), projectsSeen: errors.length, error: message },
    });
    await kbAudit("kb.sync_failed", options.triggeredById, { syncId, trigger: options.trigger, error: message });
    return { syncId, status: "failed", ...EMPTY, projectsSeen: errors.length, errors, message };
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

    await prisma.$transaction(async (tx) => {
      await tx.kbSyncRun.update({
        where: { id: syncId },
        data: {
          status,
          finishedAt: now(),
          projectsSeen: totals.projectsSeen,
          filesSeen: totals.filesSeen,
          filesUnchanged: totals.filesUnchanged,
          filesSkipped: totals.filesSkipped,
          filesRemoved: totals.filesRemoved,
          filesIndexed: totals.filesIndexed,
          filesFailed: totals.filesFailed,
          chunksWritten: totals.chunksWritten,
          error: errors.length > 0 ? describeErrors(projectErrors) : null,
        },
      });

      await writeAuditEvent(tx, {
        action: "kb.synced",
        actorEmployeeId: options.triggeredById,
        moduleKey: KNOWLEDGE_BASE_MODULE_KEY,
        metadata: { syncId, trigger: options.trigger, source: source.kind, status, ...totals, projectsFailed: errors.length },
      });
    });

    return { syncId, status, ...totals, errors: projectErrors, message: null };
  } catch (error) {
    await fail(
      "The sync stopped unexpectedly. Projects and documents already saved keep their new state; running it again continues.",
    ).catch(() => undefined);
    throw error;
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
