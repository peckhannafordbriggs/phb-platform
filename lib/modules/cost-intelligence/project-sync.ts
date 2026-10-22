import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { auditError, cipAudit } from "./audit";
import { COST_INTELLIGENCE_MODULE_KEY } from "./constants";
import { GRAPH_PARALLEL, limiter, localStore, projectsStore, type FolderStore } from "./folder-store";

/**
 * Project sync: list the BID-DOC folder, then make `cip_projects` match it.
 *
 * Metadata only. Every direct subfolder of BID-DOC is a project: the SharePoint
 * folder (CIP_SHAREPOINT_PROJECTS_FOLDER), or CIP_PROJECTS_DIR locally. The
 * sync reads file names, sizes and dates, never contents (BID-DOC is ~24 GB),
 * and keeps each project's file tree so the Projects page never has to walk the
 * folder again. Runs read the documents themselves.
 */

/** The category for files that sit directly in the project folder. */
export const GENERAL_CATEGORY = "General";

const AI_FILES = /^ai files$/i;

type FolderProject = {
  folderName: string;
  locationPath: string;
  categories: string[];
  fileCount: number;
  totalBytes: bigint;
  lastModified: Date | null;
  aiFileCount: number | null;
  fileTree: ProjectFiles;
};

type FolderError = { folderName: string; reason: string };

export type ProjectSyncOutcome = {
  syncId: string;
  status: "ok" | "partial" | "failed";
  projectsSeen: number;
  projectsAdded: number;
  projectsUpdated: number;
  projectsRemoved: number;
  errors: FolderError[];
  /** Why a failed sync failed, in plain words. */
  message: string | null;
};

/** Another sync is running. The route answers 409. */
export class ProjectSyncInProgressError extends Error {
  constructor() {
    super("A project sync is already running. Try again in a minute.");
    this.name = "ProjectSyncInProgressError";
  }
}

/** A `running` row older than this is a sync that crashed; it is closed so the next one can start. */
export const ABANDONED_AFTER_MS = 10 * 60 * 1000;

/**
 * Every call leaves one `cip_project_syncs` row: ok, partial or failed.
 *
 * - Zero projects found fails the sync and changes nothing. A wrong path or an
 *   unsynced OneDrive folder must not mark every project removed.
 * - A project that could not be read keeps its row as it was; the sync is `partial`.
 * - A folder that is gone is marked removed (`removed_at`), never deleted:
 *   runs point at projects. A removed folder that comes back is restored.
 * - Project changes, the sync row and the audit row are one transaction.
 */
export async function syncProjects(options: {
  trigger: "manual" | "scheduled";
  triggeredById: string | null;
  /** A local folder instead of the configured one (tests). */
  dir?: string;
  now?: () => Date;
}): Promise<ProjectSyncOutcome> {
  const now = options.now ?? (() => new Date());

  await prisma.cipProjectSync.updateMany({
    where: { status: "running", startedAt: { lt: new Date(now().getTime() - ABANDONED_AFTER_MS) } },
    data: { status: "failed", finishedAt: now(), errors: [{ reason: "Abandoned: never finished." }] },
  });

  let syncId: bigint;
  try {
    ({ id: syncId } = await prisma.cipProjectSync.create({
      data: { trigger: options.trigger, triggeredById: options.triggeredById, startedAt: now() },
      select: { id: true },
    }));
  } catch (error) {
    // cip_project_syncs_one_running_key allows one `running` row.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ProjectSyncInProgressError();
    }
    throw error;
  }

  const fail = async (message: string, errors: FolderError[] = []): Promise<ProjectSyncOutcome> => {
    await cipAudit("cip.projects_sync_failed", options.triggeredById, {
      syncId: syncId.toString(),
      trigger: options.trigger,
      error: auditError(message),
    });
    await prisma.cipProjectSync.update({
      where: { id: syncId },
      data: { status: "failed", finishedAt: now(), projectsSeen: errors.length, errors: [{ reason: message }, ...errors] },
    });
    return {
      syncId: syncId.toString(),
      status: "failed",
      projectsSeen: errors.length,
      projectsAdded: 0,
      projectsUpdated: 0,
      projectsRemoved: 0,
      errors,
      message,
    };
  };

  try {
    const choice = options.dir ? { ok: true as const, store: localStore(options.dir), source: options.dir } : projectsStore();
    if (!choice.ok) return await fail(choice.message);

    let read: { projects: FolderProject[]; errors: FolderError[] };
    try {
      read = await readProjectsFolder(choice.store);
    } catch (error) {
      return await fail(`Could not read the projects folder (${choice.source}): ${errorText(error)}`);
    }

    const { projects, errors } = read;
    if (projects.length === 0) {
      return await fail(
        errors.length > 0
          ? `None of the ${errors.length} project folder(s) could be read. Nothing was changed.`
          : "The projects folder holds no project folders. Check the configured folder. Nothing was changed.",
        errors,
      );
    }

    return await saveProjects(syncId, options, projects, errors, now());
  } catch (error) {
    await fail("The sync stopped unexpectedly. Nothing was changed.").catch(() => undefined);
    throw error;
  }
}

async function saveProjects(
  syncId: bigint,
  options: { trigger: "manual" | "scheduled"; triggeredById: string | null },
  projects: FolderProject[],
  errors: FolderError[],
  now: Date,
): Promise<ProjectSyncOutcome> {
  const status = errors.length > 0 ? "partial" : "ok";
  const projectsSeen = projects.length + errors.length;

  const counts = await prisma.$transaction(
    async (tx) => {
      const existing = new Map((await tx.cipProject.findMany()).map((row) => [row.folderName, row]));
      let projectsAdded = 0;
      let projectsUpdated = 0;
      const unchanged: string[] = [];

      for (const project of projects) {
        const row = existing.get(project.folderName);
        const data = { ...project, fileTree: project.fileTree as unknown as Prisma.InputJsonValue, lastSynced: now, removedAt: null };
        if (row === undefined || row.removedAt !== null) {
          // New, or a removed folder that came back.
          await tx.cipProject.upsert({ where: { folderName: project.folderName }, create: data, update: data });
          projectsAdded += 1;
        } else if (
          row.locationPath !== project.locationPath ||
          row.fileCount !== project.fileCount ||
          row.totalBytes !== project.totalBytes ||
          row.aiFileCount !== project.aiFileCount ||
          row.lastModified?.getTime() !== project.lastModified?.getTime() ||
          row.categories.join("\n") !== project.categories.join("\n") ||
          sameJson(row.fileTree, project.fileTree) === false
        ) {
          await tx.cipProject.update({ where: { id: row.id }, data });
          projectsUpdated += 1;
        } else {
          unchanged.push(project.folderName);
        }
      }

      if (unchanged.length > 0) {
        await tx.cipProject.updateMany({ where: { folderName: { in: unchanged } }, data: { lastSynced: now } });
      }

      // Gone from the folder. A folder that only failed to read is not gone.
      const present = new Set([...projects, ...errors].map((p) => p.folderName));
      const { count: projectsRemoved } = await tx.cipProject.updateMany({
        where: { removedAt: null, folderName: { notIn: [...present] } },
        data: { removedAt: now },
      });

      await tx.cipProjectSync.update({
        where: { id: syncId },
        data: { status, finishedAt: now, projectsSeen, projectsAdded, projectsUpdated, projectsRemoved, errors },
      });

      await writeAuditEvent(tx, {
        action: "cip.projects_synced",
        actorEmployeeId: options.triggeredById,
        moduleKey: COST_INTELLIGENCE_MODULE_KEY,
        metadata: {
          syncId: syncId.toString(),
          trigger: options.trigger,
          status,
          projectsSeen,
          projectsAdded,
          projectsUpdated,
          projectsRemoved,
          projectsSkipped: errors.length,
        },
      });

      return { projectsAdded, projectsUpdated, projectsRemoved };
    },
    // One write per changed project; hundreds of projects outlast the 5 s default.
    { timeout: 60_000 },
  );

  return { syncId: syncId.toString(), status, projectsSeen, ...counts, errors, message: null };
}

/** The most recent sync, for the "Last synced" line. */
export async function getLatestProjectSync() {
  return prisma.cipProjectSync.findFirst({ orderBy: { startedAt: "desc" } });
}

/** Every project still in the folder, most recently changed first. Without the file trees, which can be large. */
export async function listProjects() {
  return prisma.cipProject.findMany({
    where: { removedAt: null },
    orderBy: [{ lastModified: { sort: "desc", nulls: "last" } }, { folderName: "asc" }],
    omit: { fileTree: true },
  });
}

export type ProjectListItem = Awaited<ReturnType<typeof listProjects>>[number];

// ---------------------------------------------------------------------------
// Reading the folder
// ---------------------------------------------------------------------------

/** OS litter, Office lock files and caches. Never counted. */
const IGNORED = /^(?:~\$.*|\.DS_Store|Thumbs\.db|desktop\.ini|__pycache__|\.git)$/i;

async function readProjectsFolder(store: FolderStore): Promise<{ projects: FolderProject[]; errors: FolderError[] }> {
  const projects: FolderProject[] = [];
  const errors: FolderError[] = [];
  const folders = (await store.list("")).filter((e) => e.folder && !IGNORED.test(e.name));

  // Every project at once, with one limit on requests in flight across all of them.
  const limit = limiter(GRAPH_PARALLEL);
  await Promise.all(
    folders.map(async (entry) => {
      try {
        projects.push({ folderName: entry.name, locationPath: entry.location, ...(await summarizeProject(store, entry.name, limit)) });
      } catch (error) {
        errors.push({ folderName: entry.name, reason: errorText(error) });
      }
    }),
  );

  projects.sort((a, b) => a.folderName.localeCompare(b.folderName));
  errors.sort((a, b) => a.folderName.localeCompare(b.folderName));
  return { projects, errors };
}

type Limit = ReturnType<typeof limiter>;

/**
 * Counts and the file tree for one project, from one walk. Categories are its
 * top-level folders, plus "General" when files sit directly in it. Archive
 * folders are counted like any other: the numbers say what is really there.
 */
async function summarizeProject(
  store: FolderStore,
  root: string,
  limit: Limit,
): Promise<Omit<FolderProject, "folderName" | "locationPath">> {
  const tree = await readTree(store, root, "", limit);

  let fileCount = 0;
  let totalBytes = 0n;
  let newest = 0;
  let aiFileCount: number | null = null;
  const pending = [...tree];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.type === "dir") pending.push(...(node.children ?? []));
    else {
      fileCount += 1;
      totalBytes += BigInt(node.size ?? 0);
      newest = Math.max(newest, node.modified ? Date.parse(node.modified) : 0);
    }
  }
  for (const node of tree) {
    if (node.type === "dir" && AI_FILES.test(node.name)) aiFileCount = (aiFileCount ?? 0) + countTreeFiles(node.children ?? []);
  }

  const categories = tree.filter((n) => n.type === "dir").map((n) => n.name);
  if (tree.some((n) => n.type === "file")) categories.push(GENERAL_CATEGORY);

  return {
    categories,
    fileCount,
    totalBytes,
    lastModified: newest > 0 ? new Date(newest) : null,
    aiFileCount,
    fileTree: capTree(tree),
  };
}

/** One folder's tree. Subfolders are read in parallel; `limit` caps the requests in flight. */
async function readTree(store: FolderStore, dir: string, rel: string, limit: Limit): Promise<ProjectFileNode[]> {
  const entries = (await limit(() => store.list(dir)))
    .filter((e) => !IGNORED.test(e.name))
    .sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name));

  return Promise.all(
    entries.map(async (entry): Promise<ProjectFileNode> => {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (!entry.folder) {
        return { name: entry.name, path: relPath, type: "file", size: entry.size, modified: entry.modified.toISOString() };
      }
      return { name: entry.name, path: relPath, type: "dir", children: await readTree(store, `${dir}/${entry.name}`, relPath, limit) };
    }),
  );
}

function countTreeFiles(nodes: ProjectFileNode[]): number {
  return nodes.reduce((n, node) => n + (node.type === "file" ? 1 : countTreeFiles(node.children ?? [])), 0);
}

// ---------------------------------------------------------------------------
// The file tree on the Projects page
// ---------------------------------------------------------------------------

export type ProjectFileNode = {
  name: string;
  /** Relative to the project folder, with forward slashes. */
  path: string;
  type: "dir" | "file";
  size?: number;
  modified?: string;
  children?: ProjectFileNode[];
};

export type ProjectFiles = { tree: ProjectFileNode[]; truncated: boolean };

/** A big project still renders; the rest is cut and the page says so. */
export const FILE_TREE_LIMIT = 5000;

/** The first FILE_TREE_LIMIT entries in display order (folders first, then files, by name). */
function capTree(tree: ProjectFileNode[]): ProjectFiles {
  let seen = 0;
  let truncated = false;
  function cut(nodes: ProjectFileNode[]): ProjectFileNode[] {
    const out: ProjectFileNode[] = [];
    for (const node of nodes) {
      if (seen >= FILE_TREE_LIMIT) {
        truncated = true;
        break;
      }
      seen += 1;
      out.push(node.type === "dir" ? { ...node, children: cut(node.children ?? []) } : node);
    }
    return out;
  }
  return { tree: cut(tree), truncated };
}

/** The project's file tree as of the last sync, or a plain reason there is none. */
export async function readProjectFiles(projectId: bigint): Promise<ProjectFiles | { error: string }> {
  const row = await prisma.cipProject.findUnique({ where: { id: projectId }, select: { fileTree: true } });
  const files = row?.fileTree as ProjectFiles | null | undefined;
  if (!files || !Array.isArray(files.tree)) return { error: "No file list yet. Press Sync to read this project's files." };
  return files;
}

/** Equal as data. Postgres jsonb reorders object keys, so plain JSON.stringify would not do. */
function sameJson(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
        : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
