import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Only the session is mocked. The guard, the queue, the worker and the sync are real.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { GET, POST } from "@/app/api/modules/knowledge-base/sync/route";
import { KNOWLEDGE_BASE_MODULE_KEY } from "@/lib/modules/knowledge-base/constants";
import {
  KB_SYNC_QUEUE_EXPIRES_MS,
  KbSyncInProgressError,
  claimQueuedKbSync,
  queueKbSync,
  syncKnowledgeBase,
} from "@/lib/modules/knowledge-base/sync";
import { createEmployee, disconnectDb, grantModule, grantModuleAdmin, resetDb, testDb } from "./db";
import { writePdf } from "./kb-fixtures";

/**
 * The Index button's path end to end: the route queues, the worker claims,
 * the claimed sync runs and indexes. Against a synthetic library on disk
 * (KB_LOCAL_SOURCE_DIR), the way a developer runs it before SharePoint.
 */

const authMock = vi.mocked(auth);
const SOURCE_VARS = ["KB_LOCAL_SOURCE_DIR", "KB_SHAREPOINT_LIBRARY_URL"] as const;
const saved = Object.fromEntries(SOURCE_VARS.map((v) => [v, process.env[v]]));
let dir: string;

async function signIn({ grant, admin }: { grant: boolean; admin: boolean }) {
  const employee = await createEmployee();
  if (grant) await grantModule(employee.id, KNOWLEDGE_BASE_MODULE_KEY);
  if (admin) await grantModuleAdmin(employee.id, KNOWLEDGE_BASE_MODULE_KEY);
  authMock.mockResolvedValue({
    entraOid: employee.entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
  return employee;
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await resetDb();
  await testDb.module.create({
    data: { key: KNOWLEDGE_BASE_MODULE_KEY, displayName: "Knowledge Base", sortOrder: 400 },
  });
  dir = await mkdtemp(path.join(tmpdir(), "zztest-kb-worker-"));
  const sub = path.join(dir, "224070_UC_OLD_CHEM", "11 - SUBMITTALS");
  await mkdir(sub, { recursive: true });
  await writePdf(path.join(sub, "224070_SUB_Air_Valves_Approved_20241121.pdf"), [
    "Air valves submittal\nAV-1 1200 CFM supply",
  ]);
  delete process.env.KB_SHAREPOINT_LIBRARY_URL;
  process.env.KB_LOCAL_SOURCE_DIR = dir;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

afterAll(async () => {
  for (const name of SOURCE_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  await disconnectDb();
});

describe("POST /api/modules/knowledge-base/sync (the Index button)", () => {
  it("401 with no session, 404 without the grant or without module admin", async () => {
    authMock.mockResolvedValue(null as never);
    expect((await POST()).status).toBe(401);
    await signIn({ grant: false, admin: false });
    expect((await POST()).status).toBe(404);
    await signIn({ grant: true, admin: false });
    expect((await POST()).status).toBe(404);
    expect((await GET()).status).toBe(404);
    expect(await testDb.kbSyncRun.count()).toBe(0);
  });

  it("queues a sync as the admin's and does no work itself", async () => {
    const me = await signIn({ grant: true, admin: true });

    const response = await POST();

    expect(response.status).toBe(202);
    expect(await testDb.kbSyncRun.findFirstOrThrow()).toMatchObject({
      status: "queued",
      trigger: "manual",
      sourceKind: "local",
      triggeredById: me.id,
      heartbeatAt: null,
    });
    expect(await testDb.kbDocument.count()).toBe(0);
  });

  it("409 while one is queued, so a second press is not a second sync", async () => {
    await signIn({ grant: true, admin: true });
    expect((await POST()).status).toBe(202);
    const second = await POST();
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe("sync_in_progress");
    expect(await testDb.kbSyncRun.count()).toBe(1);
  });

  it("503 with the reason when no library is configured, and queues nothing", async () => {
    await signIn({ grant: true, admin: true });
    delete process.env.KB_LOCAL_SOURCE_DIR;
    const response = await POST();
    expect(response.status).toBe(503);
    expect((await response.json()).error.message).toMatch(/KB_SHAREPOINT_LIBRARY_URL/);
    expect(await testDb.kbSyncRun.count()).toBe(0);
  });

  it("GET reports the queued sync and the document counts for the screen", async () => {
    await signIn({ grant: true, admin: true });
    await POST();
    const body = (await (await GET()).json()).data;
    expect(body.syncs[0]).toMatchObject({ status: "queued", triggeredBy: expect.any(String) });
    expect(body.documents).toEqual({ pending: 0, indexed: 0, skipped: 0, failed: 0 });
    expect(body.chunks).toEqual({ total: 0, embedded: 0 });
  });
});

describe("the worker", () => {
  it("claims the queued sync once, runs it, and indexes the library", async () => {
    const me = await createEmployee();
    const { syncId } = await queueKbSync({ trigger: "manual", triggeredById: me.id });

    const claimed = await claimQueuedKbSync(new Date());
    expect(claimed).toMatchObject({ id: syncId, trigger: "manual", triggeredById: me.id, sourceKind: "local" });
    expect(await claimQueuedKbSync(new Date())).toBeNull();
    expect(await testDb.kbSyncRun.findUniqueOrThrow({ where: { id: syncId } })).toMatchObject({ status: "running" });

    const outcome = await syncKnowledgeBase({
      trigger: claimed!.trigger,
      triggeredById: claimed!.triggeredById,
      claimedId: claimed!.id,
    });

    expect(outcome).toMatchObject({ syncId, status: "ok", filesIndexed: 1 });
    expect(await testDb.kbSyncRun.count()).toBe(1);
    expect(await testDb.kbSyncRun.findUniqueOrThrow({ where: { id: syncId } })).toMatchObject({
      status: "ok",
      filesIndexed: 1,
      triggeredById: me.id,
    });
    expect(await testDb.auditEvent.findFirstOrThrow({ where: { action: "kb.synced" } })).toMatchObject({
      actorEmployeeId: me.id,
    });
  });

  it("finds nothing to do when nothing is queued", async () => {
    expect(await claimQueuedKbSync(new Date())).toBeNull();
  });

  it("fails a claimed sync whose library has gone unconfigured, rather than leave it running", async () => {
    const { syncId } = await queueKbSync({ trigger: "manual", triggeredById: null });
    const claimed = await claimQueuedKbSync(new Date());
    delete process.env.KB_LOCAL_SOURCE_DIR;

    const outcome = await syncKnowledgeBase({ trigger: "manual", triggeredById: null, claimedId: claimed!.id });

    expect(outcome).toMatchObject({ syncId, status: "failed" });
    expect(await testDb.kbSyncRun.findUniqueOrThrow({ where: { id: syncId } })).toMatchObject({ status: "failed" });
  });

  it("blocks a command-line sync while one is queued", async () => {
    await queueKbSync({ trigger: "manual", triggeredById: null });
    await expect(syncKnowledgeBase({ trigger: "manual", triggeredById: null })).rejects.toBeInstanceOf(
      KbSyncInProgressError,
    );
  });

  it("closes a queued sync no worker took within the hour, so the button works again", async () => {
    const t0 = new Date("2026-10-30T12:00:00Z");
    const { syncId } = await queueKbSync({ trigger: "manual", triggeredById: null, now: () => t0 });

    await queueKbSync({
      trigger: "manual",
      triggeredById: null,
      now: () => new Date(t0.getTime() + KB_SYNC_QUEUE_EXPIRES_MS + 1),
    });

    expect(await testDb.kbSyncRun.findUniqueOrThrow({ where: { id: syncId } })).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/Never picked up/),
    });
    expect(await testDb.kbSyncRun.count({ where: { status: "queued" } })).toBe(1);
  });
});
