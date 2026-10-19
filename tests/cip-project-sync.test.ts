import { localStore } from "@/lib/modules/cost-intelligence/folder-store";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import {
  ABANDONED_AFTER_MS,
  ProjectSyncInProgressError,
  listProjectFiles,
  listProjects,
  syncProjects,
} from "@/lib/modules/cost-intelligence/project-sync";
import { createEmployee, disconnectDb, resetDb, testDb } from "./db";

const T0 = new Date("2026-10-12T14:00:00.000Z");
const OLD = new Date("2026-09-01T12:00:00.000Z");
const NEW = new Date("2026-10-01T12:00:00.000Z");

let dir: string;

beforeEach(async () => {
  await resetDb();
  dir = await mkdtemp(path.join(tmpdir(), "cip-projects-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterAll(disconnectDb);

/** Writes files under BID-DOC/<project>/ with the given modified time. */
async function writeProject(project: string, files: Record<string, string>, mtime = OLD): Promise<string> {
  const root = path.join(dir, project);
  await mkdir(root, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
    await utimes(file, mtime, mtime);
  }
  return root;
}

const run = (triggeredById: string | null = null, now = T0) =>
  syncProjects({ trigger: "manual", triggeredById, dir, now: () => now });

const row = (folderName: string) => testDb.cipProject.findUniqueOrThrow({ where: { folderName } });

describe("syncProjects", () => {
  it("records categories, counts, size, newest date and AI FILES, and who ran it", async () => {
    const me = await createEmployee();
    const root = await writeProject("Mercy Rookwood AHU", {
      "PH+B_Bid_Intake_Form.xlsx": "12345",
      "ESTIMATE/est.xlsm": "1234567890",
      "ESTIMATE/Piping/notes.docx": "123",
      "AI FILES/brief.pdf": "12",
      "~$lock.xlsx": "ignored",
    });
    await utimes(path.join(root, "ESTIMATE/Piping/notes.docx"), NEW, NEW);
    await writeProject("Mercy Anderson AHU 6 JES", { "VENDOR QUOTES/q.pdf": "1" });
    await writeFile(path.join(dir, "loose file at BID-DOC root.txt"), "not a project");

    const outcome = await run(me.id);

    expect(outcome).toMatchObject({ status: "ok", projectsSeen: 2, projectsAdded: 2, projectsRemoved: 0 });
    expect(await row("Mercy Rookwood AHU")).toMatchObject({
      locationPath: root,
      categories: ["AI FILES", "ESTIMATE", "General"],
      fileCount: 4,
      totalBytes: 20n,
      lastModified: NEW,
      aiFileCount: 1,
      lastSynced: T0,
      removedAt: null,
    });
    expect(await row("Mercy Anderson AHU 6 JES")).toMatchObject({ categories: ["VENDOR QUOTES"], aiFileCount: null });
    expect(await testDb.cipProjectSync.findFirstOrThrow()).toMatchObject({ status: "ok", triggeredById: me.id });
    expect(await testDb.auditEvent.findFirstOrThrow({ where: { action: "cip.projects_synced" } })).toMatchObject({
      actorEmployeeId: me.id,
      moduleKey: COST_INTELLIGENCE_MODULE_KEY,
    });
  });

  it("an empty AI FILES folder counts 0, not missing", async () => {
    await writeProject("Job", { "ESTIMATE/a.xlsx": "1" });
    await mkdir(path.join(dir, "Job", "AI FILES"));
    await run();
    expect(await row("Job")).toMatchObject({ aiFileCount: 0, lastModified: OLD });
  });

  it("updates changed projects and only stamps lastSynced on unchanged ones", async () => {
    await writeProject("A", { "ESTIMATE/a.xlsx": "1" });
    await writeProject("B", { "ESTIMATE/b.xlsx": "1" });
    await run();

    await writeProject("A", { "AI FILES/out_rev0.docx": "12" }, NEW);
    const later = new Date(T0.getTime() + 60_000);
    const outcome = await run(null, later);

    expect(outcome).toMatchObject({ projectsAdded: 0, projectsUpdated: 1, projectsRemoved: 0 });
    expect(await row("A")).toMatchObject({ fileCount: 2, aiFileCount: 1, lastModified: NEW, lastSynced: later });
    expect(await row("B")).toMatchObject({ fileCount: 1, lastSynced: later });
  });

  it("marks a vanished folder removed, hides it, and restores it when it comes back", async () => {
    await writeProject("A", { "x.pdf": "1" });
    await writeProject("Gone", { "x.pdf": "1" });
    await run();
    const goneId = (await row("Gone")).id;

    await rm(path.join(dir, "Gone"), { recursive: true });
    expect(await run()).toMatchObject({ projectsRemoved: 1 });
    expect((await row("Gone")).removedAt).toEqual(T0);
    expect((await listProjects()).map((p) => p.folderName)).toEqual(["A"]);

    await writeProject("Gone", { "x.pdf": "1" });
    expect(await run()).toMatchObject({ projectsAdded: 1, projectsRemoved: 0 });
    expect(await row("Gone")).toMatchObject({ id: goneId, removedAt: null });
  });

  it("fails and changes nothing when the folder is empty or missing", async () => {
    await writeProject("A", { "x.pdf": "1" });
    await run();
    await rm(path.join(dir, "A"), { recursive: true });

    const empty = await run();
    expect(empty).toMatchObject({ status: "failed", projectsRemoved: 0 });
    expect(empty.message).toMatch(/no project folders/);
    expect((await row("A")).removedAt).toBeNull();

    const missing = await syncProjects({ trigger: "manual", triggeredById: null, dir: path.join(dir, "nope") });
    expect(missing).toMatchObject({ status: "failed" });
    expect(missing.message).toMatch(/Could not read the projects folder/);
  });

  it("allows one sync at a time, and clears a sync that crashed", async () => {
    await writeProject("A", { "x.pdf": "1" });
    const running = await testDb.cipProjectSync.create({ data: { trigger: "manual", startedAt: T0 } });

    await expect(run()).rejects.toBeInstanceOf(ProjectSyncInProgressError);

    const outcome = await run(null, new Date(T0.getTime() + ABANDONED_AFTER_MS + 1));
    expect(outcome.status).toBe("ok");
    expect(await testDb.cipProjectSync.findUniqueOrThrow({ where: { id: running.id } })).toMatchObject({
      status: "failed",
    });
  });
});

describe("listProjects", () => {
  it("orders by newest change first", async () => {
    await writeProject("Older", { "x.pdf": "1" }, OLD);
    await writeProject("Newer", { "x.pdf": "1" }, NEW);
    await run();
    expect((await listProjects()).map((p) => p.folderName)).toEqual(["Newer", "Older"]);
  });
});

describe("listProjectFiles", () => {
  it("lists folders before files, by name, with sizes, and skips Office lock files", async () => {
    const root = await writeProject("Job", {
      "b.pdf": "12",
      "ESTIMATE/z.xlsx": "1",
      "AI FILES/a.docx": "123",
      "~$b.pdf": "x",
    });

    const { tree, truncated } = await listProjectFiles(localStore(path.dirname(root)), path.basename(root));

    expect(truncated).toBe(false);
    expect(tree.map((n) => [n.name, n.type])).toEqual([
      ["AI FILES", "dir"],
      ["ESTIMATE", "dir"],
      ["b.pdf", "file"],
    ]);
    expect(tree[0]?.children).toEqual([
      { name: "a.docx", path: "AI FILES/a.docx", type: "file", size: 3, modified: OLD.toISOString() },
    ]);
  });
});
