import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseChangelog, parseFrontmatter } from "@/lib/modules/cost-intelligence/skill-parse";
import { CipError } from "@/lib/modules/cost-intelligence/errors";
import {
  LocalFolderSkillSource,
  readCipSkillsDir,
  skillSourceFromEnv,
} from "@/lib/modules/cost-intelligence/skill-source";

const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe("parseFrontmatter", () => {
  const front = (body: string) => parseFrontmatter(`---\n${body}\n---\n\n# Title\n`);

  it("reads plain values", () => {
    expect(front("name: phb-bid-kickoff\ndescription: Kicks off a bid.")).toEqual({
      ok: true,
      value: { name: "phb-bid-kickoff", description: "Kicks off a bid." },
    });
  });

  it("reads double-quoted values, including escaped quotes", () => {
    const result = front('name: "phb-equipment-rfp"\ndescription: "Levels the \\"Vendor Equip Eval\\" tab."');
    expect(result).toEqual({
      ok: true,
      value: { name: "phb-equipment-rfp", description: 'Levels the "Vendor Equip Eval" tab.' },
    });
  });

  it("reads single-quoted values, where '' is one quote", () => {
    const result = front("name: phb-rate-intake\ndescription: 'Intakes a project''s rates.'");
    expect(result.ok && result.value.description).toBe("Intakes a project's rates.");
  });

  it("joins folded blocks into one line and stops at the next key", () => {
    const result = front(
      "name: bid-tracking-agent\ndescription: >\n  Processes a bid job\n  into the tracker.\nlicense: internal",
    );
    expect(result.ok && result.value.description).toBe("Processes a bid job into the tracker.");
  });

  it("reads >- blocks the same way", () => {
    const result = front("name: stratus-vdc-to-excel\ndescription: >-\n  Converts a Stratus\n  export.");
    expect(result.ok && result.value.description).toBe("Converts a Stratus export.");
  });

  it("handles Windows line endings", () => {
    const result = parseFrontmatter("---\r\nname: a\r\ndescription: b\r\n---\r\n");
    expect(result).toEqual({ ok: true, value: { name: "a", description: "b" } });
  });

  it("refuses a file with no front block, no name, or no description", () => {
    expect(parseFrontmatter("# Just a heading").ok).toBe(false);
    expect(front("description: x").ok).toBe(false);
    expect(front("name: x").ok).toBe(false);
  });
});

describe("parseChangelog", () => {
  it("counts every ## entry and ignores ### notes", () => {
    const summary = parseChangelog(
      "# skill — changelog\n\n## 2026-09-23 — shortened\n\n## v0.1 — 2026-09-22 — first build\n\n### Where it came from\n",
    );
    expect(summary).toEqual({ entries: 2, newest: utc("2026-09-23") });
  });

  it("takes the later date of a range", () => {
    expect(parseChangelog("## 2026-09-17 → 2026-09-22 — v1.0").newest).toEqual(utc("2026-09-22"));
  });

  it("finds the newest date when entries are out of order", () => {
    const summary = parseChangelog("## 2026-07-28 — a\n## 2026-07-07 — b\n## 2026-07-27 — c\n");
    expect(summary.newest).toEqual(utc("2026-07-28"));
  });

  it("reads 'June 30, 2026' and month-only '2026-06'", () => {
    expect(parseChangelog("## v1.2 — June 30, 2026 — pass").newest).toEqual(utc("2026-06-30"));
    expect(parseChangelog("## v2 — 2026-06 (review)").newest).toEqual(utc("2026-06-01"));
  });

  it("counts an undated entry as a version", () => {
    expect(parseChangelog("## v3 — 2026-09-08\n## v2 — 2026-06\n## v1\n")).toEqual({
      entries: 3,
      newest: utc("2026-09-08"),
    });
  });

  it("rejects impossible dates", () => {
    expect(parseChangelog("## 2026-02-31 — typo").newest).toBeNull();
  });

  it("returns zero entries for a file with none", () => {
    expect(parseChangelog("# CHANGELOG\n\nNothing yet.")).toEqual({ entries: 0, newest: null });
  });
});

describe("LocalFolderSkillSource", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "cip-skills-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function skill(folder: string, files: Record<string, string>): Promise<string> {
    const dir = path.join(root, folder);
    await mkdir(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), body);
    }
    return dir;
  }

  const skillMd = (name: string) => `---\nname: ${name}\ndescription: Does ${name}.\n---\n`;

  it("lists only folders holding a SKILL.md, sorted", async () => {
    await skill("phb-b", { "SKILL.md": skillMd("phb-b") });
    await skill("phb-a", { "SKILL.md": skillMd("phb-a") });
    await skill("_shared", { "glossary.md": "x" });
    await writeFile(path.join(root, "README.md"), "x");

    const { skills, errors } = await new LocalFolderSkillSource(root).listSkills();

    expect(skills.map((s) => s.folderName)).toEqual(["phb-a", "phb-b"]);
    expect(errors).toEqual([]);
  });

  it("takes version and date from the CHANGELOG", async () => {
    const dir = await skill("phb-a", {
      "SKILL.md": skillMd("phb-a"),
      "CHANGELOG.md": "## 2026-09-23 — b\n## v0.1 — 2026-09-22 — a\n",
    });

    const [only] = (await new LocalFolderSkillSource(root).listSkills()).skills;

    expect(only).toEqual({
      folderName: "phb-a",
      locationPath: dir,
      name: "phb-a",
      description: "Does phb-a.",
      version: 2,
      lastModified: utc("2026-09-23"),
    });
  });

  it("falls back to version 1 and the newest file time with no CHANGELOG", async () => {
    const dir = await skill("phb-a", { "SKILL.md": skillMd("phb-a"), "ref/notes.md": "x" });
    const older = new Date("2026-01-01T00:00:00Z");
    const newer = new Date("2026-03-15T12:00:00Z");
    await utimes(path.join(dir, "SKILL.md"), older, older);
    await utimes(path.join(dir, "ref/notes.md"), newer, newer);

    const [only] = (await new LocalFolderSkillSource(root).listSkills()).skills;

    expect(only?.version).toBe(1);
    expect(only?.lastModified).toEqual(newer);
  });

  it("ignores Office lock files when finding the newest file", async () => {
    const dir = await skill("phb-a", { "SKILL.md": skillMd("phb-a"), "~$book.xlsx": "lock" });
    const older = new Date("2026-01-01T00:00:00Z");
    const newer = new Date("2026-06-01T00:00:00Z");
    await utimes(path.join(dir, "SKILL.md"), older, older);
    await utimes(path.join(dir, "~$book.xlsx"), newer, newer);

    const [only] = (await new LocalFolderSkillSource(root).listSkills()).skills;

    expect(only?.lastModified).toEqual(older);
  });

  it("reports a bad skill and still returns the good ones", async () => {
    await skill("phb-good", { "SKILL.md": skillMd("phb-good") });
    await skill("phb-bad", { "SKILL.md": "no front block here" });

    const { skills, errors } = await new LocalFolderSkillSource(root).listSkills();

    expect(skills.map((s) => s.folderName)).toEqual(["phb-good"]);
    expect(errors).toEqual([
      { folderName: "phb-bad", reason: "SKILL.md does not start with a --- block" },
    ]);
  });

  it("returns an empty list for an empty folder, without throwing", async () => {
    expect(await new LocalFolderSkillSource(root).listSkills()).toEqual({ skills: [], errors: [] });
  });

  it("throws unreachable for a folder that does not exist", async () => {
    const missing = new LocalFolderSkillSource(path.join(root, "nope"));
    await expect(missing.listSkills()).rejects.toMatchObject({ code: "unreachable" });
  });
});

describe("CIP_SKILLS_DIR", () => {
  const saved = process.env.CIP_SKILLS_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.CIP_SKILLS_DIR;
    else process.env.CIP_SKILLS_DIR = saved;
  });

  it("treats unset and blank the same", () => {
    delete process.env.CIP_SKILLS_DIR;
    expect(readCipSkillsDir()).toBeNull();
    process.env.CIP_SKILLS_DIR = "   ";
    expect(readCipSkillsDir()).toBeNull();
  });

  it("names the variable when it is missing", () => {
    delete process.env.CIP_SKILLS_DIR;
    expect(() => skillSourceFromEnv()).toThrow(CipError);
    expect(() => skillSourceFromEnv()).toThrow(/CIP_SKILLS_DIR/);
  });
});
