import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ABANDONED_AFTER_MS,
  SkillSyncInProgressError,
  parseChangelog,
  parseFrontmatter,
  syncSkills,
} from "@/lib/modules/cost-intelligence/skill-sync";
import { createEmployee, disconnectDb, resetDb, testDb } from "./db";

const T0 = new Date("2026-10-06T14:00:00.000Z");
const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

let dir: string;

beforeEach(async () => {
  await resetDb();
  dir = await mkdtemp(path.join(tmpdir(), "cip-skills-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));
afterAll(disconnectDb);

async function writeSkill(folder: string, files: Record<string, string> = {}): Promise<string> {
  const skillDir = path.join(dir, folder);
  const all = { "SKILL.md": `---\nname: ${folder}\ndescription: Does ${folder}.\n---\n`, ...files };
  for (const [name, body] of Object.entries(all)) {
    await mkdir(path.dirname(path.join(skillDir, name)), { recursive: true });
    await writeFile(path.join(skillDir, name), body);
  }
  return skillDir;
}

const run = (triggeredById: string | null = null, now = T0) =>
  syncSkills({ trigger: "manual", triggeredById, dir, now: () => now });

const folders = async () =>
  (await testDb.cipSkill.findMany({ orderBy: { folderName: "asc" } })).map((s) => s.folderName);

describe("parseFrontmatter", () => {
  const front = (body: string) => parseFrontmatter(`---\n${body}\n---\n`);

  it("reads plain, double-quoted, single-quoted and folded values", () => {
    expect(front("name: a\ndescription: Plain.")).toEqual({ name: "a", description: "Plain." });
    expect(front('name: "a"\ndescription: "The \\"Eval\\" tab."')).toEqual({
      name: "a",
      description: 'The "Eval" tab.',
    });
    expect(front("name: a\ndescription: 'A project''s rates.'")).toEqual({
      name: "a",
      description: "A project's rates.",
    });
    expect(front("name: a\ndescription: >-\n  Folded\n  lines.\nlicense: x")).toEqual({
      name: "a",
      description: "Folded lines.",
    });
  });

  it("handles Windows line endings", () => {
    expect(parseFrontmatter("---\r\nname: a\r\ndescription: b\r\n---\r\n")).toEqual({
      name: "a",
      description: "b",
    });
  });

  it("refuses a missing block, name or description", () => {
    expect(parseFrontmatter("# heading")).toHaveProperty("reason");
    expect(front("description: x")).toHaveProperty("reason");
    expect(front("name: x")).toHaveProperty("reason");
  });
});

describe("parseChangelog", () => {
  it("counts ## entries, not ### notes, and finds the newest date", () => {
    expect(parseChangelog("## 2026-09-23 — b\n## v0.1 — 2026-09-22\n### note\n")).toEqual({
      entries: 2,
      newest: utc("2026-09-23"),
    });
  });

  it("reads ranges, month names, month-only dates, undated entries and out-of-order entries", () => {
    expect(parseChangelog("## 2026-09-17 → 2026-09-22").newest).toEqual(utc("2026-09-22"));
    expect(parseChangelog("## v1.2 — June 30, 2026").newest).toEqual(utc("2026-06-30"));
    expect(parseChangelog("## v2 — 2026-06\n## v1\n")).toEqual({ entries: 2, newest: utc("2026-06-01") });
    expect(parseChangelog("## 2026-07-07\n## 2026-07-28\n## 2026-07-27\n").newest).toEqual(utc("2026-07-28"));
  });

  it("ignores impossible dates", () => {
    expect(parseChangelog("## 2026-02-31 — typo").newest).toBeNull();
  });
});

describe("syncSkills", () => {
  it("adds every skill folder, skips folders without SKILL.md, and records who ran it", async () => {
    const me = await createEmployee();
    const skillDir = await writeSkill("phb-a", { "CHANGELOG.md": "## 2026-09-23\n## 2026-09-22\n" });
    await writeSkill("phb-b");
    await mkdir(path.join(dir, "_shared"));
    await writeFile(path.join(dir, "README.md"), "x");

    const outcome = await run(me.id);

    expect(outcome).toMatchObject({ status: "ok", skillsSeen: 2, skillsAdded: 2, errors: [] });
    expect(await testDb.cipSkill.findUniqueOrThrow({ where: { folderName: "phb-a" } })).toMatchObject({
      name: "phb-a",
      description: "Does phb-a.",
      version: 2,
      lastModified: utc("2026-09-23"),
      locationPath: skillDir,
      lastSynced: T0,
    });
    expect(await testDb.cipSkillSync.findFirstOrThrow()).toMatchObject({ status: "ok", triggeredById: me.id });
    expect(
      await testDb.auditEvent.findFirstOrThrow({ where: { action: "cip.skills_synced" } }),
    ).toMatchObject({ actorEmployeeId: me.id, moduleKey: "cost-intelligence" });
  });

  it("uses version 1 and the newest file time when there is no CHANGELOG", async () => {
    const skillDir = await writeSkill("phb-a", { "ref/notes.md": "x", "~$lock.xlsx": "x" });
    const older = new Date("2026-01-01T00:00:00Z");
    const newer = new Date("2026-03-15T12:00:00Z");
    await utimes(path.join(skillDir, "SKILL.md"), older, older);
    await utimes(path.join(skillDir, "ref/notes.md"), newer, newer);
    await utimes(path.join(skillDir, "~$lock.xlsx"), T0, T0);

    await run();

    expect(await testDb.cipSkill.findFirstOrThrow()).toMatchObject({ version: 1, lastModified: newer });
  });

  it("updates changed skills, deletes missing ones, and stamps lastSynced on the rest", async () => {
    await writeSkill("phb-a");
    await writeSkill("phb-b");
    await writeSkill("phb-c");
    await run();

    await writeFile(path.join(dir, "phb-a", "CHANGELOG.md"), "## 2026-10-01\n## 2026-09-01\n");
    await rm(path.join(dir, "phb-c"), { recursive: true });
    const later = new Date(T0.getTime() + 60_000);

    const outcome = await run(null, later);

    expect(outcome).toMatchObject({ status: "ok", skillsAdded: 0, skillsUpdated: 1, skillsDeleted: 1 });
    const rows = await testDb.cipSkill.findMany({ orderBy: { folderName: "asc" } });
    expect(rows.map((r) => [r.folderName, r.version, r.lastSynced])).toEqual([
      ["phb-a", 2, later],
      ["phb-b", 1, later],
    ]);
  });

  it("keeps a skill that could not be read, and marks the sync partial", async () => {
    await writeSkill("phb-a");
    await writeSkill("phb-b");
    await run();
    await writeFile(path.join(dir, "phb-b", "SKILL.md"), "no front block");

    const outcome = await run();

    expect(outcome).toMatchObject({ status: "partial", skillsSeen: 2, skillsDeleted: 0 });
    expect(outcome.errors).toEqual([{ folderName: "phb-b", reason: "SKILL.md does not start with a --- block" }]);
    expect(await folders()).toEqual(["phb-a", "phb-b"]);
  });

  it("fails and changes nothing when the folder holds no skills", async () => {
    await writeSkill("phb-a");
    await run();
    await rm(path.join(dir, "phb-a"), { recursive: true });

    const outcome = await run();

    expect(outcome.status).toBe("failed");
    expect(outcome.message).toMatch(/no skills/);
    expect(await folders()).toEqual(["phb-a"]);
    expect(await testDb.auditEvent.count({ where: { action: "cip.skills_synced" } })).toBe(1);
  });

  it("fails and changes nothing when every skill is unreadable", async () => {
    await writeSkill("phb-a");
    await run();
    await writeFile(path.join(dir, "phb-a", "SKILL.md"), "broken");

    expect((await run()).status).toBe("failed");
    expect(await folders()).toEqual(["phb-a"]);
  });

  it("records a failed sync for a folder that does not exist", async () => {
    const outcome = await syncSkills({
      trigger: "manual",
      triggeredById: null,
      dir: path.join(dir, "nope"),
      now: () => T0,
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.message).toMatch(/Could not read the skills folder/);
    expect(await testDb.cipSkillSync.findFirstOrThrow()).toMatchObject({ status: "failed", finishedAt: T0 });
  });

  it("fails with a message naming CIP_SKILLS_DIR when it is not set", async () => {
    const saved = process.env.CIP_SKILLS_DIR;
    delete process.env.CIP_SKILLS_DIR;
    try {
      const outcome = await syncSkills({ trigger: "manual", triggeredById: null, now: () => T0 });
      expect(outcome.message).toMatch(/CIP_SKILLS_DIR/);
    } finally {
      if (saved !== undefined) process.env.CIP_SKILLS_DIR = saved;
    }
  });

  it("refuses a second sync while one is running", async () => {
    await writeSkill("phb-a");
    await testDb.cipSkillSync.create({ data: { trigger: "manual", status: "running", startedAt: T0 } });

    await expect(run()).rejects.toBeInstanceOf(SkillSyncInProgressError);
    expect(await folders()).toEqual([]);
  });

  it("clears a sync abandoned past the limit, then runs", async () => {
    await writeSkill("phb-a");
    const stale = new Date(T0.getTime() - ABANDONED_AFTER_MS - 1000);
    await testDb.cipSkillSync.create({ data: { trigger: "manual", status: "running", startedAt: stale } });

    expect((await run()).status).toBe("ok");
    expect((await testDb.cipSkillSync.findFirstOrThrow({ orderBy: { id: "asc" } })).status).toBe("failed");
  });
});
