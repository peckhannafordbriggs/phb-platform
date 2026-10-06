import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { COST_INTELLIGENCE_MODULE_KEY } from "./constants";

/**
 * Skill catalog sync: read the skills folder, then make `cip_skills` match it.
 *
 * The folder is CIP_SKILLS_DIR (the OneDrive copy for now). A skill is any
 * direct subfolder holding a SKILL.md. When SharePoint access lands, only
 * `readSkillsFolder` changes.
 */

type FolderSkill = {
  folderName: string;
  locationPath: string;
  name: string;
  description: string;
  version: number;
  lastModified: Date;
};

type FolderError = { folderName: string; reason: string };

export type SkillSyncOutcome = {
  syncId: string;
  status: "ok" | "partial" | "failed";
  skillsSeen: number;
  skillsAdded: number;
  skillsUpdated: number;
  skillsDeleted: number;
  errors: FolderError[];
  /** Why a failed sync failed, in plain words. */
  message: string | null;
};

/** Another sync is running. The route answers 409. */
export class SkillSyncInProgressError extends Error {
  constructor() {
    super("A skill sync is already running. Try again in a minute.");
    this.name = "SkillSyncInProgressError";
  }
}

/** A `running` row older than this is a sync that crashed; it is closed so the next one can start. */
export const ABANDONED_AFTER_MS = 10 * 60 * 1000;

/**
 * Every call leaves one `cip_skill_syncs` row: ok, partial or failed.
 *
 * - Zero skills found fails the sync and changes nothing. A wrong path or an
 *   unsynced OneDrive folder must not wipe the catalog.
 * - A folder that could not be read keeps its row; the sync is `partial`.
 * - Skill changes, the sync row and the audit row are one transaction.
 */
export async function syncSkills(options: {
  trigger: "manual" | "scheduled";
  triggeredById: string | null;
  /** Defaults to CIP_SKILLS_DIR. */
  dir?: string;
  now?: () => Date;
}): Promise<SkillSyncOutcome> {
  const now = options.now ?? (() => new Date());

  await prisma.cipSkillSync.updateMany({
    where: { status: "running", startedAt: { lt: new Date(now().getTime() - ABANDONED_AFTER_MS) } },
    data: { status: "failed", finishedAt: now(), errors: [{ reason: "Abandoned: never finished." }] },
  });

  let syncId: bigint;
  try {
    ({ id: syncId } = await prisma.cipSkillSync.create({
      data: { trigger: options.trigger, triggeredById: options.triggeredById, startedAt: now() },
      select: { id: true },
    }));
  } catch (error) {
    // cip_skill_syncs_one_running_key allows one `running` row.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new SkillSyncInProgressError();
    }
    throw error;
  }

  const fail = async (message: string, errors: FolderError[] = []): Promise<SkillSyncOutcome> => {
    await prisma.cipSkillSync.update({
      where: { id: syncId },
      data: { status: "failed", finishedAt: now(), skillsSeen: errors.length, errors: [{ reason: message }, ...errors] },
    });
    return {
      syncId: syncId.toString(),
      status: "failed",
      skillsSeen: errors.length,
      skillsAdded: 0,
      skillsUpdated: 0,
      skillsDeleted: 0,
      errors,
      message,
    };
  };

  try {
    const dir = options.dir ?? process.env.CIP_SKILLS_DIR?.trim();
    if (!dir) return await fail("CIP_SKILLS_DIR is not set. Point it at the skills folder in .env.local.");

    let read: { skills: FolderSkill[]; errors: FolderError[] };
    try {
      read = await readSkillsFolder(dir);
    } catch (error) {
      return await fail(`Could not read the skills folder at ${dir}: ${errorText(error)}`);
    }

    const { skills, errors } = read;
    if (skills.length === 0) {
      return await fail(
        errors.length > 0
          ? `None of the ${errors.length} skill folder(s) could be read. Nothing was changed.`
          : "The skills folder holds no skills. Check CIP_SKILLS_DIR. Nothing was changed.",
        errors,
      );
    }

    return await saveSkills(syncId, options, skills, errors, now());
  } catch (error) {
    await fail("The sync stopped unexpectedly. Nothing was changed.").catch(() => undefined);
    throw error;
  }
}

async function saveSkills(
  syncId: bigint,
  options: { trigger: "manual" | "scheduled"; triggeredById: string | null },
  skills: FolderSkill[],
  errors: FolderError[],
  now: Date,
): Promise<SkillSyncOutcome> {
  const status = errors.length > 0 ? "partial" : "ok";
  const skillsSeen = skills.length + errors.length;

  const counts = await prisma.$transaction(async (tx) => {
    const existing = new Map((await tx.cipSkill.findMany()).map((row) => [row.folderName, row]));
    let skillsAdded = 0;
    let skillsUpdated = 0;
    const unchanged: string[] = [];

    for (const skill of skills) {
      const row = existing.get(skill.folderName);
      const data = { ...skill, lastSynced: now };
      if (row === undefined) {
        await tx.cipSkill.create({ data });
        skillsAdded += 1;
      } else if (
        row.name !== skill.name ||
        row.description !== skill.description ||
        row.version !== skill.version ||
        row.locationPath !== skill.locationPath ||
        row.lastModified.getTime() !== skill.lastModified.getTime()
      ) {
        await tx.cipSkill.update({ where: { id: row.id }, data });
        skillsUpdated += 1;
      } else {
        unchanged.push(skill.folderName);
      }
    }

    if (unchanged.length > 0) {
      await tx.cipSkill.updateMany({ where: { folderName: { in: unchanged } }, data: { lastSynced: now } });
    }

    // Gone from the folder. A folder that only failed to read is not gone.
    const present = new Set([...skills, ...errors].map((s) => s.folderName));
    const { count: skillsDeleted } = await tx.cipSkill.deleteMany({
      where: { folderName: { notIn: [...present] } },
    });

    await tx.cipSkillSync.update({
      where: { id: syncId },
      data: { status, finishedAt: now, skillsSeen, skillsAdded, skillsUpdated, skillsDeleted, errors },
    });

    await writeAuditEvent(tx, {
      action: "cip.skills_synced",
      actorEmployeeId: options.triggeredById,
      moduleKey: COST_INTELLIGENCE_MODULE_KEY,
      metadata: {
        syncId: syncId.toString(),
        trigger: options.trigger,
        status,
        skillsSeen,
        skillsAdded,
        skillsUpdated,
        skillsDeleted,
        skillsSkipped: errors.length,
      },
    });

    return { skillsAdded, skillsUpdated, skillsDeleted };
  });

  return { syncId: syncId.toString(), status, skillsSeen, ...counts, errors, message: null };
}

/** The most recent sync, for the "Last synced" line. */
export async function getLatestSkillSync() {
  return prisma.cipSkillSync.findFirst({ orderBy: { startedAt: "desc" } });
}

// ---------------------------------------------------------------------------
// Reading the folder
// ---------------------------------------------------------------------------

/** OS litter, Office lock files and caches. Never part of a skill. */
const IGNORED = /^(?:~\$.*|\.DS_Store|Thumbs\.db|desktop\.ini|__pycache__|\.git)$/i;

async function readSkillsFolder(dir: string): Promise<{ skills: FolderSkill[]; errors: FolderError[] }> {
  const skills: FolderSkill[] = [];
  const errors: FolderError[] = [];

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || IGNORED.test(entry.name)) continue;
    const folderName = entry.name;
    const locationPath = path.join(dir, folderName);

    const skillMd = await readOptional(path.join(locationPath, "SKILL.md"));
    if (skillMd === null) continue;

    try {
      const front = parseFrontmatter(skillMd);
      if ("reason" in front) {
        errors.push({ folderName, reason: front.reason });
        continue;
      }
      const changelog = await readOptional(path.join(locationPath, "CHANGELOG.md"));
      const { entries, newest } = parseChangelog(changelog ?? "");
      skills.push({
        folderName,
        locationPath,
        name: front.name,
        description: front.description,
        version: Math.max(entries, 1),
        lastModified: newest ?? (await newestFileTime(locationPath)),
      });
    } catch (error) {
      errors.push({ folderName, reason: errorText(error) });
    }
  }

  skills.sort((a, b) => a.folderName.localeCompare(b.folderName));
  return { skills, errors };
}

/**
 * `name` and `description` from the block between the first two `---` lines.
 * Handles plain, "double quoted", 'single quoted' and folded (`>`, `>-`, `|`)
 * values, collapsed to one line.
 */
export function parseFrontmatter(
  source: string,
): { name: string; description: string } | { reason: string } {
  const lines = source.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { reason: "SKILL.md does not start with a --- block" };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end === -1) return { reason: "SKILL.md has no closing --- line" };

  const block = lines.slice(1, end);
  const name = readKey(block, "name");
  const description = readKey(block, "description");
  if (!name) return { reason: "SKILL.md has no name" };
  if (!description) return { reason: "SKILL.md has no description" };
  return { name, description };
}

function readKey(block: string[], key: string): string | null {
  const start = block.findIndex((line) => line.startsWith(`${key}:`));
  if (start === -1) return null;
  let value = block[start]!.slice(key.length + 1).trim();

  if (/^[>|][+-]?$/.test(value)) {
    const body: string[] = [];
    for (const line of block.slice(start + 1)) {
      if (line.length > 0 && !/^\s/.test(line)) break;
      body.push(line);
    }
    value = body.join(" ");
  } else if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0]!;
    // A quoted value may continue onto following lines until its closing quote.
    let text = value.slice(1);
    for (let i = start + 1; closingQuote(text, quote) === -1 && i < block.length; i += 1) {
      text += ` ${block[i]!.trim()}`;
    }
    const close = closingQuote(text, quote);
    text = close === -1 ? text : text.slice(0, close);
    value =
      quote === '"'
        ? text.replace(/\\(["\\/nt])/g, (_, ch: string) => (ch === "n" || ch === "t" ? " " : ch))
        : text.replace(/''/g, "'");
  }
  return value.replace(/\s+/g, " ").trim();
}

function closingQuote(text: string, quote: string): number {
  for (let i = 0; i < text.length; i += 1) {
    if (quote === '"' && text[i] === "\\") i += 1;
    else if (quote === "'" && text[i] === "'" && text[i + 1] === "'") i += 1;
    else if (text[i] === quote) return i;
  }
  return -1;
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * Version = number of `## ` entries (dated or not). Last modified = the newest
 * date in those headings, as midnight UTC. Dates come as `2026-09-22`,
 * `2026-06` (read as the 1st) or `June 30, 2026`.
 */
export function parseChangelog(source: string): { entries: number; newest: Date | null } {
  let entries = 0;
  let newest: Date | null = null;

  for (const line of source.split(/\r?\n/)) {
    if (!/^## (?!#)/.test(line)) continue;
    entries += 1;

    const dates: Date[] = [];
    for (const m of line.matchAll(/\b(\d{4})-(\d{2})(?:-(\d{2}))?\b/g)) {
      dates.push(utcDate(Number(m[1]), Number(m[2]), Number(m[3] ?? 1)));
    }
    for (const m of line.matchAll(/\b([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\b/g)) {
      const month = MONTHS.indexOf(m[1]!.toLowerCase());
      if (month !== -1) dates.push(utcDate(Number(m[3]), month + 1, Number(m[2])));
    }
    for (const date of dates) {
      if (!Number.isNaN(date.getTime()) && (newest === null || date > newest)) newest = date;
    }
  }
  return { entries, newest };
}

/** Invalid Date for an impossible date like 2026-02-31, which Date.UTC would roll over. */
function utcDate(year: number, month: number, day: number): Date {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : new Date(NaN);
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Newest file time in a folder, for a skill with no dated CHANGELOG. */
async function newestFileTime(dir: string): Promise<Date> {
  let newest = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (IGNORED.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, (await newestFileTime(full)).getTime());
    else if (entry.isFile()) newest = Math.max(newest, (await stat(full)).mtimeMs);
  }
  return new Date(newest);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
