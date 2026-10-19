import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { COST_INTELLIGENCE_MODULE_KEY } from "./constants";
import { localStore, projectsStore, type FolderStore } from "./folder-store";

/**
 * Project sync: list the BID-DOC folder, then make `cip_projects` match it.
 *
 * Metadata only. Every direct subfolder of BID-DOC is a project: the SharePoint
 * folder (CIP_SHAREPOINT_PROJECTS_FOLDER), or CIP_PROJECTS_DIR locally. The
 * sync reads file names, sizes and dates, never contents (BID-DOC is ~24 GB).
 * Runs read the documents themselves.
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
        const data = { ...project, lastSynced: now, removedAt: null };
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
          row.categories.join("\n") !== project.categories.join("\n")
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

/** Every project still in the folder, most recently changed first. */
export async function listProjects() {
  return prisma.cipProject.findMany({
    where: { removedAt: null },
    orderBy: [{ lastModified: { sort: "desc", nulls: "last" } }, { folderName: "asc" }],
  });
}

// ---------------------------------------------------------------------------
// Reading the folder
// ---------------------------------------------------------------------------

/** OS litter, Office lock files and caches. Never counted. */
const IGNORED = /^(?:~\$.*|\.DS_Store|Thumbs\.db|desktop\.ini|__pycache__|\.git)$/i;

async function readProjectsFolder(store: FolderStore): Promise<{ projects: FolderProject[]; errors: FolderError[] }> {
  const projects: FolderProject[] = [];
  const errors: FolderError[] = [];
  const folders = (await store.list("")).filter((e) => e.folder && !IGNORED.test(e.name));

  // A few projects at a time: SharePoint answers one folder per request.
  for (let i = 0; i < folders.length; i += PROJECTS_AT_ONCE) {
    await Promise.all(
      folders.slice(i, i + PROJECTS_AT_ONCE).map(async (entry) => {
        try {
          projects.push({ folderName: entry.name, locationPath: entry.location, ...(await summarizeProject(store, entry.name)) });
        } catch (error) {
          errors.push({ folderName: entry.name, reason: errorText(error) });
        }
      }),
    );
  }

  projects.sort((a, b) => a.folderName.localeCompare(b.folderName));
  errors.sort((a, b) => a.folderName.localeCompare(b.folderName));
  return { projects, errors };
}

const PROJECTS_AT_ONCE = 4;

/**
 * Counts for one project. Categories are its top-level folders, plus
 * "General" when files sit directly in it. Archive folders are counted like
 * any other: the numbers say what is really there.
 */
async function summarizeProject(store: FolderStore, root: string): Promise<Omit<FolderProject, "folderName" | "locationPath">> {
  const categories: string[] = [];
  let fileCount = 0;
  let totalBytes = 0n;
  let newest = 0;
  let aiFileCount: number | null = null;
  let looseFiles = false;

  for (const entry of await store.list(root)) {
    if (IGNORED.test(entry.name)) continue;
    if (entry.folder) {
      const sub = await walk(store, `${root}/${entry.name}`);
      categories.push(entry.name);
      fileCount += sub.files;
      totalBytes += sub.bytes;
      newest = Math.max(newest, sub.newest);
      if (AI_FILES.test(entry.name)) aiFileCount = (aiFileCount ?? 0) + sub.files;
    } else {
      looseFiles = true;
      fileCount += 1;
      totalBytes += BigInt(entry.size);
      newest = Math.max(newest, entry.modified.getTime());
    }
  }

  categories.sort((a, b) => a.localeCompare(b));
  if (looseFiles) categories.push(GENERAL_CATEGORY);
  return { categories, fileCount, totalBytes, lastModified: newest > 0 ? new Date(newest) : null, aiFileCount };
}

/** Files, bytes and newest modified time under a folder. Iterative, so deep trees can't overflow the stack. */
async function walk(store: FolderStore, dir: string): Promise<{ files: number; bytes: bigint; newest: number }> {
  let files = 0;
  let bytes = 0n;
  let newest = 0;
  const pending = [dir];

  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await store.list(current)) {
      if (IGNORED.test(entry.name)) continue;
      if (entry.folder) pending.push(`${current}/${entry.name}`);
      else {
        files += 1;
        bytes += BigInt(entry.size);
        newest = Math.max(newest, entry.modified.getTime());
      }
    }
  }
  return { files, bytes, newest };
}

// ---------------------------------------------------------------------------
// The live file tree on the Projects page
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

/** A big project still renders; the rest is cut and the page says so. */
export const FILE_TREE_LIMIT = 5000;

/**
 * The project's files, read from the folder when the page opens, so it is never
 * stale. Folders first, then files, each by name. Stops after FILE_TREE_LIMIT
 * entries; `truncated` says it did.
 */
export async function listProjectFiles(
  store: FolderStore,
  folderName: string,
): Promise<{ tree: ProjectFileNode[]; truncated: boolean }> {
  let seen = 0;
  let truncated = false;

  async function read(dir: string, rel: string): Promise<ProjectFileNode[]> {
    const entries = (await store.list(dir))
      .filter((e) => !IGNORED.test(e.name))
      .sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name));

    const nodes: ProjectFileNode[] = [];
    for (const entry of entries) {
      if (seen >= FILE_TREE_LIMIT) {
        truncated = true;
        break;
      }
      seen += 1;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.folder) {
        nodes.push({ name: entry.name, path: relPath, type: "dir", children: await read(`${dir}/${entry.name}`, relPath) });
      } else {
        nodes.push({ name: entry.name, path: relPath, type: "file", size: entry.size, modified: entry.modified.toISOString() });
      }
    }
    return nodes;
  }

  return { tree: await read(folderName, ""), truncated };
}

/** The file tree, or a plain reason it could not be read. */
export async function readProjectFiles(
  folderName: string,
): Promise<{ tree: ProjectFileNode[]; truncated: boolean } | { error: string }> {
  const choice = projectsStore();
  if (!choice.ok) return { error: choice.message };
  try {
    return await listProjectFiles(choice.store, folderName);
  } catch (error) {
    return { error: `The folder could not be read: ${errorText(error)}` };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
