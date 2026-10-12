import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { COST_INTELLIGENCE_MODULE_KEY } from "./constants";

/**
 * Project sync: list the BID-DOC folder, then make `cip_projects` match it.
 *
 * Metadata only. Every direct subfolder of CIP_PROJECTS_DIR is a project; the
 * sync reads file names, sizes and dates, never contents (BID-DOC is ~24 GB).
 * Runs read the documents themselves. When SharePoint access lands, only
 * `readProjectsFolder` and `listProjectFiles` change.
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
  /** Defaults to CIP_PROJECTS_DIR. */
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
    const dir = options.dir ?? process.env.CIP_PROJECTS_DIR?.trim();
    if (!dir) return await fail("CIP_PROJECTS_DIR is not set. Point it at the BID-DOC folder in .env.local.");

    let read: { projects: FolderProject[]; errors: FolderError[] };
    try {
      read = await readProjectsFolder(dir);
    } catch (error) {
      return await fail(`Could not read the projects folder at ${dir}: ${errorText(error)}`);
    }

    const { projects, errors } = read;
    if (projects.length === 0) {
      return await fail(
        errors.length > 0
          ? `None of the ${errors.length} project folder(s) could be read. Nothing was changed.`
          : "The projects folder holds no project folders. Check CIP_PROJECTS_DIR. Nothing was changed.",
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

async function readProjectsFolder(dir: string): Promise<{ projects: FolderProject[]; errors: FolderError[] }> {
  const projects: FolderProject[] = [];
  const errors: FolderError[] = [];

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || IGNORED.test(entry.name)) continue;
    const locationPath = path.join(dir, entry.name);
    try {
      projects.push({ folderName: entry.name, locationPath, ...(await summarizeProject(locationPath)) });
    } catch (error) {
      errors.push({ folderName: entry.name, reason: errorText(error) });
    }
  }

  projects.sort((a, b) => a.folderName.localeCompare(b.folderName));
  return { projects, errors };
}

/**
 * Counts for one project. Categories are its top-level folders, plus
 * "General" when files sit directly in it. Archive folders are counted like
 * any other: the numbers say what is really there.
 */
async function summarizeProject(root: string): Promise<Omit<FolderProject, "folderName" | "locationPath">> {
  const categories: string[] = [];
  let fileCount = 0;
  let totalBytes = 0n;
  let newest = 0;
  let aiFileCount: number | null = null;
  let looseFiles = false;

  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (IGNORED.test(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const sub = await walk(full);
      categories.push(entry.name);
      fileCount += sub.files;
      totalBytes += sub.bytes;
      newest = Math.max(newest, sub.newest);
      if (AI_FILES.test(entry.name)) aiFileCount = (aiFileCount ?? 0) + sub.files;
    } else if (entry.isFile()) {
      const info = await stat(full);
      looseFiles = true;
      fileCount += 1;
      totalBytes += BigInt(info.size);
      newest = Math.max(newest, info.mtimeMs);
    }
  }

  categories.sort((a, b) => a.localeCompare(b));
  if (looseFiles) categories.push(GENERAL_CATEGORY);
  return { categories, fileCount, totalBytes, lastModified: newest > 0 ? new Date(newest) : null, aiFileCount };
}

/** Files, bytes and newest modified time under a folder. Iterative, so deep trees can't overflow the stack. */
async function walk(dir: string): Promise<{ files: number; bytes: bigint; newest: number }> {
  let files = 0;
  let bytes = 0n;
  let newest = 0;
  const pending = [dir];

  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = (await readdir(current, { withFileTypes: true })).filter((e) => !IGNORED.test(e.name));
    for (const entry of entries) if (entry.isDirectory()) pending.push(path.join(current, entry.name));
    const infos = await Promise.all(
      entries.filter((e) => e.isFile()).map((e) => stat(path.join(current, e.name))),
    );
    for (const info of infos) {
      files += 1;
      bytes += BigInt(info.size);
      newest = Math.max(newest, info.mtimeMs);
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
 * The project's files, read from disk when the page opens, so it is never
 * stale. Folders first, then files, each by name. Stops after FILE_TREE_LIMIT
 * entries; `truncated` says it did.
 */
export async function listProjectFiles(
  locationPath: string,
): Promise<{ tree: ProjectFileNode[]; truncated: boolean }> {
  let seen = 0;
  let truncated = false;

  async function read(dir: string, rel: string): Promise<ProjectFileNode[]> {
    const entries = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => !IGNORED.test(e.name) && (e.isDirectory() || e.isFile()))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

    const nodes: ProjectFileNode[] = [];
    for (const entry of entries) {
      if (seen >= FILE_TREE_LIMIT) {
        truncated = true;
        break;
      }
      seen += 1;
      const full = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        nodes.push({ name: entry.name, path: relPath, type: "dir", children: await read(full, relPath) });
      } else {
        const info = await stat(full);
        nodes.push({ name: entry.name, path: relPath, type: "file", size: info.size, modified: info.mtime.toISOString() });
      }
    }
    return nodes;
  }

  return { tree: await read(locationPath, ""), truncated };
}

/** The file tree, or a plain reason it could not be read (on a server without the folder, for one). */
export async function readProjectFiles(
  locationPath: string,
): Promise<{ tree: ProjectFileNode[]; truncated: boolean } | { error: string }> {
  try {
    return await listProjectFiles(locationPath);
  } catch (error) {
    return { error: `The folder could not be read from here: ${errorText(error)}` };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
