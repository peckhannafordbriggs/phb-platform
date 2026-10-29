import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { KNOWLEDGE_BASE_MODULE_KEY } from "@/lib/modules/knowledge-base/constants";
import { localKbSource, type KbSource } from "@/lib/modules/knowledge-base/source";
import {
  KB_SYNC_ABANDONED_AFTER_MS,
  KbSyncInProgressError,
  syncKnowledgeBase,
} from "@/lib/modules/knowledge-base/sync";
import { readOnly, localStore } from "@/lib/sharepoint/folder-store";
import { createEmployee, disconnectDb, resetDb, testDb } from "./db";

/**
 * The sync against a synthetic library on disk. File NAMES follow the curated
 * 224070_UC_OLD_CHEM project; contents are placeholders, never PH+B documents.
 */

const T0 = new Date("2026-10-28T14:00:00.000Z");
const T1 = new Date("2026-10-29T14:00:00.000Z");
const OLD = new Date("2026-09-01T12:00:00.000Z");

const P = "224070_UC_OLD_CHEM";
const FILES: Record<string, string> = {
  "11 - SUBMITTALS/224070_SUB_Air_Valves_Approved_20241121.pdf": "a",
  "11 - SUBMITTALS/ARCHIVE_224070_SUB_Air_Valves_Approved_20240717.pdf": "b",
  "11 - SUBMITTALS/ARCHIVE_224070_SUB_Air_Valves_Rejected_20240119.pdf": "c",
  "11 - SUBMITTALS/ARCHIVE_224070_SUB_Exhaust_Attenuators_Approved_20240710.pdf": "d",
  "7 - SUBCONTRACTS/224070_SUBK_AMERAIR_Balancing_Executed_20240110.pdf": "e",
  "7 - SUBCONTRACTS/224070_SUBK_AMERAIR_Balancing_Unexecuted_20240110.pdf": "f",
  "10 - CHANGE ORDERS/+ATTENTION_CO_LOG_MISMATCH.txt": "g",
  "1 - DWGS AND SPECS/1A - MECHANICAL DRAWINGS/224070_DWGS_M_IFC_20231101.pdf": "h",
  "8 - FINANCIAL PERFORMANCE/8B - MARGIN OUTCOME SUMMARY/x.xlsx": "i",
  "12 - CORRESPONDENCE AND RFIS/224070_CORR_note.msg": "j",
  "224070_GAP_LOG.md": "k",
  "11 - SUBMITTALS/~$lock.docx": "litter",
};

let dir: string;
let source: KbSource;

beforeEach(async () => {
  await resetDb();
  dir = await mkdtemp(path.join(tmpdir(), "zztest-kb-"));
  source = localKbSource(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterAll(disconnectDb);

async function write(project: string, files: Record<string, string>, mtime = OLD): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(dir, project, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
    await utimes(file, mtime, mtime);
  }
}

const sync = (now = T0, triggeredById: string | null = null, src: KbSource = source) =>
  syncKnowledgeBase({ trigger: "manual", triggeredById, source: src, now: () => now });

const doc = (fileName: string) => testDb.kbDocument.findFirstOrThrow({ where: { fileName } });

async function addChunk(documentId: string) {
  await testDb.$executeRawUnsafe(
    `INSERT INTO kb_chunks (id, document_id, ordinal, content) VALUES (gen_random_uuid(), $1::uuid, 0, 'x')`,
    documentId,
  );
}

/** Marks a document indexed with one chunk, as the indexer will. */
async function markIndexed(fileName: string) {
  const row = await doc(fileName);
  await testDb.kbDocument.update({ where: { id: row.id }, data: { status: "indexed", chunkCount: 1, indexedAt: T0 } });
  await addChunk(row.id);
  return row.id;
}

describe("syncKnowledgeBase", () => {
  it("records the project, every file with its decision, and who ran it", async () => {
    const me = await createEmployee();
    await write(P, FILES);
    await writeFile(path.join(dir, "loose.txt"), "not a project");

    const outcome = await sync(T0, me.id);

    expect(outcome).toMatchObject({
      status: "ok",
      projectsSeen: 1,
      filesSeen: 11,
      filesQueued: 7,
      filesSkipped: 4,
      filesUnchanged: 0,
      filesRemoved: 0,
    });
    expect(await testDb.kbProject.findFirstOrThrow()).toMatchObject({
      folderName: P,
      projectNumber: "224070",
      name: "UC OLD CHEM",
      isLegacy: true,
      sourceKind: "local",
      lastSeenAt: T0,
    });
    expect(await testDb.kbDocument.count({ where: { fileName: { startsWith: "~$" } } })).toBe(0);

    expect(await doc("224070_SUB_Air_Valves_Approved_20241121.pdf")).toMatchObject({
      status: "pending",
      path: "11 - SUBMITTALS/224070_SUB_Air_Valves_Approved_20241121.pdf",
      folderCode: "11",
      fileType: "pdf",
      familyKey: "224070_SUB_Air_Valves",
      versionLabel: "20241121",
      isLatest: true,
      isArchived: false,
      sizeBytes: 1n,
      sourceModifiedAt: OLD,
    });
    expect(await doc("ARCHIVE_224070_SUB_Air_Valves_Rejected_20240119.pdf")).toMatchObject({
      status: "pending",
      isArchived: true,
      isLatest: false,
    });
    // A family with only archived members has no latest.
    expect(await doc("ARCHIVE_224070_SUB_Exhaust_Attenuators_Approved_20240710.pdf")).toMatchObject({ isLatest: false });
    expect(await doc("224070_SUBK_AMERAIR_Balancing_Executed_20240110.pdf")).toMatchObject({ isLatest: true });
    expect(await doc("224070_SUBK_AMERAIR_Balancing_Unexecuted_20240110.pdf")).toMatchObject({ isLatest: false });

    for (const [fileName, reason] of [
      ["224070_DWGS_M_IFC_20231101.pdf", "drawings"],
      ["x.xlsx", "restricted_folder"],
      ["224070_CORR_note.msg", "unsupported_type"],
      ["224070_GAP_LOG.md", "project_root_file"],
    ]) {
      expect(await doc(fileName!)).toMatchObject({ status: "skipped", skipReason: reason, isLatest: false });
    }

    expect(await testDb.kbSyncRun.findFirstOrThrow()).toMatchObject({
      status: "ok",
      trigger: "manual",
      sourceKind: "local",
      triggeredById: me.id,
      projectsSeen: 1,
      filesSeen: 11,
      filesSkipped: 4,
      finishedAt: T0,
      error: null,
    });
    expect(await testDb.auditEvent.findFirstOrThrow({ where: { action: "kb.synced" } })).toMatchObject({
      actorEmployeeId: me.id,
      moduleKey: KNOWLEDGE_BASE_MODULE_KEY,
    });
  });

  it("leaves an unchanged indexed file and its chunks alone", async () => {
    await write(P, FILES);
    await sync();
    const id = await markIndexed("224070_SUB_Air_Valves_Approved_20241121.pdf");

    const outcome = await sync(T1);

    expect(outcome).toMatchObject({ status: "ok", filesUnchanged: 1, filesQueued: 6 });
    expect(await testDb.kbDocument.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: "indexed",
      chunkCount: 1,
      lastSeenAt: T1,
    });
    expect(await testDb.kbChunk.count({ where: { documentId: id } })).toBe(1);
  });

  it("queues a changed file again and drops its old chunks", async () => {
    await write(P, FILES);
    await sync();
    const id = await markIndexed("224070_SUB_Air_Valves_Approved_20241121.pdf");
    await write(P, { "11 - SUBMITTALS/224070_SUB_Air_Valves_Approved_20241121.pdf": "longer now" });

    await sync(T1);

    expect(await testDb.kbDocument.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: "pending",
      chunkCount: 0,
      indexedAt: null,
      sizeBytes: 10n,
    });
    expect(await testDb.kbChunk.count({ where: { documentId: id } })).toBe(0);
  });

  it("retries a failed file", async () => {
    await write(P, FILES);
    await sync();
    const row = await doc("224070_SUB_Air_Valves_Approved_20241121.pdf");
    await testDb.kbDocument.update({ where: { id: row.id }, data: { status: "failed", error: "boom" } });

    await sync(T1);

    expect(await doc("224070_SUB_Air_Valves_Approved_20241121.pdf")).toMatchObject({ status: "pending", error: null });
  });

  it("moves latest to a new version and removes a deleted file", async () => {
    await write(P, FILES);
    await sync();
    await write(P, { "11 - SUBMITTALS/224070_SUB_Air_Valves_Approved_20250301.pdf": "z" });
    await rm(path.join(dir, P, "10 - CHANGE ORDERS", "+ATTENTION_CO_LOG_MISMATCH.txt"));

    const outcome = await sync(T1);

    expect(outcome).toMatchObject({ filesRemoved: 1 });
    expect(await doc("224070_SUB_Air_Valves_Approved_20250301.pdf")).toMatchObject({ isLatest: true });
    expect(await doc("224070_SUB_Air_Valves_Approved_20241121.pdf")).toMatchObject({ isLatest: false });
    expect(await testDb.kbDocument.count({ where: { fileName: "+ATTENTION_CO_LOG_MISMATCH.txt" } })).toBe(0);
  });

  it("removes a project folder that is gone, with its documents and chunks", async () => {
    await write(P, FILES);
    await write("221457_MAGNODE", { "11 - SUBMITTALS/221457_SUB_Fans_Approved_20220120.pdf": "m" });
    await sync();
    const id = await markIndexed("221457_SUB_Fans_Approved_20220120.pdf");
    await rm(path.join(dir, "221457_MAGNODE"), { recursive: true });

    const outcome = await sync(T1);

    expect(outcome).toMatchObject({ status: "ok", projectsRemoved: 1, filesRemoved: 1 });
    expect(await testDb.kbProject.count()).toBe(1);
    expect(await testDb.kbChunk.count({ where: { documentId: id } })).toBe(0);
  });

  it("changes nothing when the library holds no projects", async () => {
    await write(P, FILES);
    await sync();
    const before = await testDb.kbDocument.count();
    const empty = await mkdtemp(path.join(tmpdir(), "zztest-kb-empty-"));
    try {
      const outcome = await sync(T1, null, localKbSource(empty));
      expect(outcome).toMatchObject({ status: "failed", message: expect.stringMatching(/no project folders/) });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
    expect(await testDb.kbDocument.count()).toBe(before);
    expect(await testDb.kbSyncRun.findFirstOrThrow({ where: { status: "failed" } })).toMatchObject({
      error: expect.stringMatching(/Nothing was changed/),
    });
    expect(await testDb.auditEvent.count({ where: { action: "kb.sync_failed" } })).toBe(1);
  });

  it("keeps an unreadable project's rows and reports the sync partial", async () => {
    await write(P, FILES);
    await write("221457_MAGNODE", { "11 - SUBMITTALS/221457_SUB_Fans_Approved_20220120.pdf": "m" });
    await sync();
    const store = readOnly(localStore(dir));
    const flaky: KbSource = {
      kind: "local",
      label: dir,
      store: {
        ...store,
        list: async (rel) => {
          if (rel.startsWith("221457_MAGNODE")) throw new Error("EACCES");
          return store.list(rel);
        },
      },
    };

    const outcome = await sync(T1, null, flaky);

    expect(outcome).toMatchObject({
      status: "partial",
      projectsSeen: 2,
      projectsRemoved: 0,
      errors: [{ folderName: "221457_MAGNODE", reason: "EACCES" }],
    });
    expect(await doc("221457_SUB_Fans_Approved_20220120.pdf")).toMatchObject({ lastSeenAt: T0 });
    expect((await testDb.kbSyncRun.findFirstOrThrow({ where: { status: "partial" } })).error).toMatch(/221457_MAGNODE/);
  });

  it("refuses a second sync while one is running, and closes an abandoned one", async () => {
    await write(P, FILES);
    await testDb.kbSyncRun.create({ data: { sourceKind: "local", trigger: "manual", startedAt: T0 } });
    await expect(sync(new Date(T0.getTime() + 60_000))).rejects.toBeInstanceOf(KbSyncInProgressError);

    const outcome = await sync(new Date(T0.getTime() + KB_SYNC_ABANDONED_AFTER_MS + 1));
    expect(outcome.status).toBe("ok");
    expect(await testDb.kbSyncRun.findFirstOrThrow({ where: { startedAt: T0 } })).toMatchObject({
      status: "failed",
      error: "Abandoned: never finished.",
    });
  });

  it("re-queues a file whose rule changed from skipped to indexed", async () => {
    await write(P, FILES);
    await sync();
    const row = await doc("224070_SUB_Air_Valves_Approved_20241121.pdf");
    await testDb.kbDocument.update({
      where: { id: row.id },
      data: { status: "skipped", skipReason: "too_large" },
    });

    await sync(T1);

    expect(await doc("224070_SUB_Air_Valves_Approved_20241121.pdf")).toMatchObject({ status: "pending", skipReason: null });
  });
});
