import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Only the session is mocked. The guard and the syncs are real.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { POST } from "@/app/api/modules/cost-intelligence/sync/[target]/route";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { createEmployee, disconnectDb, grantModule, grantModuleAdmin, resetDb, testDb } from "./db";

const authMock = vi.mocked(auth);
const saved = { skills: process.env.CIP_SKILLS_DIR, projects: process.env.CIP_PROJECTS_DIR };
let skillsDir: string;
let projectsDir: string;

const sync = (target: string) =>
  POST(new Request(`http://localhost/api/modules/cost-intelligence/sync/${target}`, { method: "POST" }), {
    params: Promise.resolve({ target }),
  });

async function signIn({ grant, admin }: { grant: boolean; admin: boolean }) {
  const employee = await createEmployee();
  if (grant) await grantModule(employee.id, COST_INTELLIGENCE_MODULE_KEY);
  if (admin) await grantModuleAdmin(employee.id, COST_INTELLIGENCE_MODULE_KEY);
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
    data: { key: COST_INTELLIGENCE_MODULE_KEY, displayName: "Cost Intelligence", sortOrder: 300 },
  });

  skillsDir = await mkdtemp(path.join(tmpdir(), "cip-route-skills-"));
  await mkdir(path.join(skillsDir, "phb-a"));
  await writeFile(path.join(skillsDir, "phb-a", "SKILL.md"), "---\nname: phb-a\ndescription: Does a.\n---\n");
  process.env.CIP_SKILLS_DIR = skillsDir;

  projectsDir = await mkdtemp(path.join(tmpdir(), "cip-route-projects-"));
  await mkdir(path.join(projectsDir, "Job", "ESTIMATE"), { recursive: true });
  await writeFile(path.join(projectsDir, "Job", "ESTIMATE", "est.xlsx"), "x");
  process.env.CIP_PROJECTS_DIR = projectsDir;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(skillsDir, { recursive: true, force: true });
  await rm(projectsDir, { recursive: true, force: true });
});

afterAll(async () => {
  for (const [key, value] of [
    ["CIP_SKILLS_DIR", saved.skills],
    ["CIP_PROJECTS_DIR", saved.projects],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await disconnectDb();
});

describe("POST /api/modules/cost-intelligence/sync/[target]", () => {
  it("401 with no session", async () => {
    authMock.mockResolvedValue(null as never);
    expect((await sync("skills")).status).toBe(401);
  });

  it("404 without the module grant, or with it but not module admin", async () => {
    await signIn({ grant: false, admin: false });
    expect((await sync("skills")).status).toBe(404);
    await signIn({ grant: true, admin: false });
    expect((await sync("projects")).status).toBe(404);
    expect(await testDb.cipSkillSync.count()).toBe(0);
    expect(await testDb.cipProjectSync.count()).toBe(0);
  });

  it("404 for an unknown target, even for a module admin", async () => {
    await signIn({ grant: true, admin: true });
    expect((await sync("runs")).status).toBe(404);
  });

  it("syncs skills for a module admin, saved as theirs", async () => {
    const me = await signIn({ grant: true, admin: true });

    const response = await sync("skills");

    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ status: "ok", skillsAdded: 1, message: null });
    expect(await testDb.cipSkill.count()).toBe(1);
    expect(await testDb.cipSkillSync.findFirstOrThrow()).toMatchObject({ triggeredById: me.id });
  });

  it("syncs projects for a module admin, saved as theirs", async () => {
    const me = await signIn({ grant: true, admin: true });

    const response = await sync("projects");

    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ status: "ok", projectsAdded: 1, message: null });
    expect(await testDb.cipProject.findFirstOrThrow()).toMatchObject({ folderName: "Job", categories: ["ESTIMATE"] });
    expect(await testDb.cipProjectSync.findFirstOrThrow()).toMatchObject({ triggeredById: me.id });
  });

  it("200 with status failed and a message when the folder is wrong", async () => {
    await signIn({ grant: true, admin: true });
    process.env.CIP_SKILLS_DIR = path.join(skillsDir, "missing");

    const response = await sync("skills");

    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.status).toBe("failed");
    expect(data.message).toMatch(/Could not read the skills folder/);
  });

  it("409 while another sync of the same kind is running", async () => {
    await signIn({ grant: true, admin: true });
    await testDb.cipSkillSync.create({ data: { trigger: "manual", status: "running" } });
    await testDb.cipProjectSync.create({ data: { trigger: "manual", status: "running" } });

    for (const target of ["skills", "projects"]) {
      const response = await sync(target);
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("sync_in_progress");
    }
  });
});
