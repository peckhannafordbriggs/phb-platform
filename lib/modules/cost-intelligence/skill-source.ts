import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseChangelog, parseFrontmatter } from "./skill-parse";

/** One skill as the source sees it. The fields match `cip_skills`, minus `lastSynced`. */
export type SourceSkill = {
  folderName: string;
  locationPath: string;
  name: string;
  description: string;
  version: number;
  lastModified: Date;
};

/** A folder that looked like a skill but could not be read. The sync carries on without it. */
export type SourceSkillError = { folderName: string; reason: string };

export type SkillSourceResult = {
  skills: SourceSkill[];
  errors: SourceSkillError[];
};

/**
 * Where skills are read from. Local folder today; a SharePoint reader
 * implements the same method once Sites.Selected is granted, and nothing
 * downstream changes.
 */
export interface SkillSource {
  readonly kind: "local" | "sharepoint";
  listSkills(): Promise<SkillSourceResult>;
}

export type SkillSourceErrorCode = "not_configured" | "unreachable";

/** The source as a whole could not be read. Distinct from one bad skill. */
export class SkillSourceError extends Error {
  constructor(
    readonly code: SkillSourceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SkillSourceError";
  }
}

/**
 * Read when a sync runs, not at boot: the platform must start without it, and
 * only the sync needs it. A blank value counts as unset.
 */
export function readCipSkillsDir(): string | null {
  const raw = process.env.CIP_SKILLS_DIR?.trim();
  return raw === undefined || raw.length === 0 ? null : raw;
}

/** The configured source, or a `not_configured` error naming the variable. */
export function skillSourceFromEnv(): SkillSource {
  const dir = readCipSkillsDir();
  if (dir === null) {
    throw new SkillSourceError(
      "not_configured",
      "CIP_SKILLS_DIR is not set. Point it at the skills folder in .env.local.",
    );
  }
  return new LocalFolderSkillSource(dir);
}

/** Never part of a skill's content: OS litter, Office lock files, Python caches. */
const IGNORED = /^(?:~\$.*|\.DS_Store|Thumbs\.db|desktop\.ini|__pycache__|\.git)$/i;

/**
 * Reads a folder of skill folders from disk: the OneDrive copy, synced by the
 * OneDrive client. A skill is any direct subfolder holding a SKILL.md.
 */
export class LocalFolderSkillSource implements SkillSource {
  readonly kind = "local" as const;

  constructor(private readonly root: string) {}

  async listSkills(): Promise<SkillSourceResult> {
    const folders = await this.skillFolders();
    const skills: SourceSkill[] = [];
    const errors: SourceSkillError[] = [];

    for (const folderName of folders) {
      try {
        const skill = await this.readSkill(folderName);
        if ("reason" in skill) errors.push(skill);
        else skills.push(skill);
      } catch (error) {
        errors.push({
          folderName,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { skills, errors };
  }

  private async skillFolders(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      throw new SkillSourceError(
        "unreachable",
        `Could not read the skills folder at ${this.root}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const folders: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED.test(entry.name)) continue;
      if (await isFile(path.join(this.root, entry.name, "SKILL.md"))) {
        folders.push(entry.name);
      }
    }
    return folders.sort((a, b) => a.localeCompare(b));
  }

  private async readSkill(folderName: string): Promise<SourceSkill | SourceSkillError> {
    const locationPath = path.join(this.root, folderName);

    const front = parseFrontmatter(await readFile(path.join(locationPath, "SKILL.md"), "utf8"));
    if (!front.ok) return { folderName, reason: front.reason };

    const changelog = await readOptional(path.join(locationPath, "CHANGELOG.md"));
    const summary = changelog === null ? null : parseChangelog(changelog);

    const version = summary === null || summary.entries === 0 ? 1 : summary.entries;
    const lastModified = summary?.newest ?? (await newestFileTime(locationPath));

    return {
      folderName,
      locationPath,
      name: front.value.name,
      description: front.value.description,
      version,
      lastModified,
    };
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The newest modification time of any file under `dir`, for skills with no dated CHANGELOG. */
async function newestFileTime(dir: string): Promise<Date> {
  let newest = 0;

  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (IGNORED.test(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) newest = Math.max(newest, (await stat(full)).mtimeMs);
    }
  }

  await walk(dir);
  return new Date(newest);
}
