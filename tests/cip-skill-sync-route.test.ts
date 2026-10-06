import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Only the session is mocked. The guard and the sync are real.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { POST } from "@/app/api/modules/cost-intelligence/skills/sync/route";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { createEmployee, disconnectDb, grantModule, grantModuleAdmin, resetDb, testDb } from "./db";

const authMock = vi.mocked(auth);
const savedDir = process.env.CIP_SKILLS_DIR;
let dir: string;

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

async function signIn({ grant, admin }: { grant: boolean; admin: boolean }) {
  const employee = await createEmployee();
  if (grant) await grantModule(employee.id, COST_INTELLIGENCE_MODULE_KEY);
  if (admin) await grantModuleAdmin(employee.id, COST_INTELLIGENCE_MODULE_KEY);
  signedInAs(employee.entraOid!);
  return employee;
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await resetDb();
  await testDb.module.create({
    data: { key: COST_INTELLIGENCE_MODULE_KEY, displayName: "Cost Intelligence", sortOrder: 300 },
  });
  dir = await mkdtemp(path.join(tmpdir(), "cip-route-"));
  await mkdir(path.join(dir, "phb-a"));
  await writeFile(path.join(dir, "phb-a", "SKILL.md"), "---\nname: phb-a\ndescription: Does a.\n---\n");
  process.env.CIP_SKILLS_DIR = dir;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

afterAll(async () => {
  if (savedDir === undefined) delete process.env.CIP_SKILLS_DIR;
  else process.env.CIP_SKILLS_DIR = savedDir;
  await disconnectDb();
});

describe("POST /api/modules/cost-intelligence/skills/sync", () => {
  it("401 with no session", async () => {
    authMock.mockResolvedValue(null as never);
    expect((await POST()).status).toBe(401);
  });

  it("404 without the module grant", async () => {
    await signIn({ grant: false, admin: false });
    expect((await POST()).status).toBe(404);
    expect(await testDb.cipSkillSync.count()).toBe(0);
  });

  it("404 with the grant but not module admin", async () => {
    await signIn({ grant: true, admin: false });
    expect((await POST()).status).toBe(404);
    expect(await testDb.cipSkillSync.count()).toBe(0);
  });

  it("200 for a module admin, and the skills are saved as theirs", async () => {
    const me = await signIn({ grant: true, admin: true });

    const response = await POST();

    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ status: "ok", skillsAdded: 1, message: null });
    expect(await testDb.cipSkill.count()).toBe(1);
    expect(await testDb.cipSkillSync.findFirstOrThrow()).toMatchObject({ triggeredById: me.id });
  });

  it("200 with status failed and a message when the folder is wrong", async () => {
    await signIn({ grant: true, admin: true });
    process.env.CIP_SKILLS_DIR = path.join(dir, "missing");

    const response = await POST();

    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.status).toBe("failed");
    expect(data.message).toMatch(/Could not read the skills folder/);
  });

  it("409 while another sync is running", async () => {
    await signIn({ grant: true, admin: true });
    await testDb.cipSkillSync.create({ data: { trigger: "manual", status: "running" } });

    const response = await POST();

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("sync_in_progress");
  });
});
