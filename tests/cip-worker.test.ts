import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { answerCheckpoint, cancelRun, createRun, getRun } from "@/lib/modules/cost-intelligence/runs";
import {
  STALE_AFTER_MS,
  failStaleRuns,
  freeName,
  runSessionStore,
  workOnce,
  type RunAgent,
  type WorkerConfig,
} from "@/lib/modules/cost-intelligence/worker";
import { localStore } from "@/lib/modules/cost-intelligence/folder-store";
import { createEmployee, disconnectDb, resetDb, testDb } from "./db";

let root: string;
let config: WorkerConfig;
let actor: string;
let projectDir: string;
let skillsDir: string;

/** What one fake agent turn does, given the workspace it was started in. */
type Script = (cwd: string, options: Options) => Promise<void>;

/**
 * A stand-in for the Agent SDK's query(): runs `script` against the workspace,
 * then yields the messages a real session would, ending in a result.
 */
function fakeAgent(scripts: Script[], cost = 0.25): RunAgent & { prompts: string[] } {
  const prompts: string[] = [];
  const agent = ((args: { prompt: string; options: Options }) => {
    prompts.push(args.prompt);
    const script = scripts.shift() ?? (async () => {});
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-1" } as unknown as SDKMessage;
      yield {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "Reading the bid documents." }, { type: "tool_use", name: "Read", input: { file_path: `${args.options.cwd}/project/Specs/spec.pdf` } }] },
      } as unknown as SDKMessage;
      await script(args.options.cwd!, args.options);
      yield {
        type: "result",
        subtype: "success",
        total_cost_usd: cost,
        modelUsage: { m: { inputTokens: 1000, cacheReadInputTokens: 500, cacheCreationInputTokens: 0, outputTokens: 200 } },
      } as unknown as SDKMessage;
    })();
  }) as unknown as RunAgent & { prompts: string[] };
  agent.prompts = prompts;
  return agent;
}

/** Calls the ask_user tool the way the model would. */
async function askUser(options: Options, question: string, choices?: string[]) {
  const server = options.mcpServers!.cip as unknown as {
    instance: { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }> };
  };
  await server.instance._registeredTools.ask_user!.handler({ question, options: choices }, {});
}

const write = (cwd: string, rel: string, body: string) =>
  mkdir(path.dirname(path.join(cwd, "out", rel)), { recursive: true }).then(() => writeFile(path.join(cwd, "out", rel), body));

async function start(steps = ["phb-a"]): Promise<string> {
  for (const folderName of steps) {
    await testDb.cipSkill.upsert({
      where: { folderName },
      create: { name: `Skill ${folderName}`, description: "", version: 1, locationPath: "x", folderName, lastModified: new Date(), lastSynced: new Date() },
      update: {},
    });
  }
  const workflow = await testDb.cipWorkflow.create({
    data: { name: `Flow ${steps.join("+")}`, status: "active", steps: { create: steps.map((s, i) => ({ position: i + 1, skillFolderName: s })) } },
  });
  const project = await testDb.cipProject.create({
    data: { folderName: "Job", locationPath: projectDir, fileCount: 1, totalBytes: 1n, lastSynced: new Date() },
  });
  const result = await createRun(actor, { workflowId: workflow.id.toString(), projectId: project.id.toString() });
  if (!result.ok) throw new Error(result.message);
  return result.data.id;
}

beforeEach(async () => {
  await resetDb();
  actor = (await createEmployee()).id;
  root = await mkdtemp(path.join(tmpdir(), "cip-worker-"));
  const bidDoc = path.join(root, "bid-doc");
  skillsDir = path.join(root, "skills");
  config = { projects: localStore(bidDoc), skills: localStore(skillsDir), outputsDir: bidDoc, workspaceDir: path.join(root, "ws") };
  projectDir = path.join(bidDoc, "Job");
  await mkdir(path.join(projectDir, "Specs"), { recursive: true });
  await writeFile(path.join(projectDir, "Specs", "spec.pdf"), "original");
  await mkdir(path.join(projectDir, "ESTIMATE", "Archive"), { recursive: true });
  await writeFile(path.join(projectDir, "ESTIMATE", "Archive", "old.xlsx"), "old");
  for (const skill of ["phb-a", "phb-b", "_shared"]) {
    await mkdir(path.join(skillsDir, skill), { recursive: true });
    await writeFile(path.join(skillsDir, skill, skill === "_shared" ? "glossary.md" : "SKILL.md"), `# ${skill}`);
  }
});
afterEach(() => rm(root, { recursive: true, force: true }));
afterAll(disconnectDb);

describe("workOnce", () => {
  it("returns null when nothing is queued", async () => {
    expect(await workOnce(config, fakeAgent([]))).toBeNull();
  });

  it("runs a step in a copied workspace, publishes ./out to AI FILES, and records cost", async () => {
    const id = await start();
    let seen: { project: string[]; skill: string; shared: string; archive: string[] } | undefined;
    const agent = fakeAgent([
      async (cwd) => {
        seen = {
          project: await readdir(path.join(cwd, "project")),
          skill: await readFile(path.join(cwd, ".claude/skills/phb-a/SKILL.md"), "utf8"),
          shared: await readFile(path.join(cwd, "skills-repo/_shared/glossary.md"), "utf8"),
          archive: await readdir(path.join(cwd, "project/ESTIMATE")),
        };
        await writeFile(path.join(cwd, "project", "Specs", "spec.pdf"), "agent scribbled on the copy");
        await write(cwd, "Job_Brief_rev0.docx", "brief");
      },
    ]);

    expect((await workOnce(config, agent))?.toString()).toBe(id);

    expect(seen).toEqual({ project: ["ESTIMATE", "Specs"], skill: "# phb-a", shared: "# _shared", archive: [] });
    expect(agent.prompts[0]).toMatch(/^\/phb-a /);
    expect(await readFile(path.join(projectDir, "Specs", "spec.pdf"), "utf8")).toBe("original");
    expect(await readFile(path.join(projectDir, "AI FILES", "Job_Brief_rev0.docx"), "utf8")).toBe("brief");

    const run = await getRun(id);
    expect(run).toMatchObject({ status: "succeeded", costUsd: 0.25, tokens: 1700, outputs: [{ path: "AI FILES/Job_Brief_rev0.docx" }] });
    expect(run?.events.map((e) => e.type)).toEqual([
      "queued", "started", "step_started", "message", "tool", "output", "step_finished", "succeeded",
    ]);
    expect(run?.events.find((e) => e.type === "tool")?.message).toBe("Read Specs/spec.pdf");
    expect(await readdir(config.workspaceDir)).toEqual([]);
  });

  it("never overwrites: a taken name gets the next _revN", async () => {
    await mkdir(path.join(projectDir, "AI FILES"), { recursive: true });
    await writeFile(path.join(projectDir, "AI FILES", "Brief_rev0.docx"), "first");
    await writeFile(path.join(projectDir, "AI FILES", "Brief_rev1.docx"), "second");
    const id = await start();

    await workOnce(config, fakeAgent([(cwd) => write(cwd, "Brief_rev0.docx", "third")]));

    expect(await readFile(path.join(projectDir, "AI FILES", "Brief_rev0.docx"), "utf8")).toBe("first");
    expect(await readFile(path.join(projectDir, "AI FILES", "Brief_rev2.docx"), "utf8")).toBe("third");
    expect((await getRun(id))?.outputs.map((o) => o.path)).toEqual(["AI FILES/Brief_rev2.docx"]);
  });

  it("runs steps in order and adds their costs", async () => {
    const id = await start(["phb-a", "phb-b"]);
    const agent = fakeAgent([async () => {}, async () => {}], 0.5);

    await workOnce(config, agent);

    expect(agent.prompts.map((p) => p.split(" ")[0])).toEqual(["/phb-a", "/phb-b"]);
    expect(await getRun(id)).toMatchObject({ status: "succeeded", costUsd: 1, tokens: 3400 });
    expect((await getRun(id))?.steps.map((s) => s.state)).toEqual(["done", "done"]);
  });

  it("pauses on ask_user, publishes what was written, and resumes the same session with the answer", async () => {
    const id = await start(["phb-a", "phb-b"]);
    const agent = fakeAgent([
      async (cwd, options) => {
        await write(cwd, "Draft_rev0.md", "draft");
        await askUser(options, "Hard bid or CM?", ["Hard bid", "CM"]);
      },
      async (_cwd, options) => {
        expect(options.resume).toBe("sess-1");
      },
      async () => {},
    ]);

    await workOnce(config, agent);
    let run = await getRun(id);
    expect(run).toMatchObject({ status: "waiting", checkpoint: { question: "Hard bid or CM?", options: ["Hard bid", "CM"] } });
    expect(run?.outputs.map((o) => o.path)).toEqual(["AI FILES/Draft_rev0.md"]);
    expect((await testDb.cipRun.findUniqueOrThrow({ where: { id: BigInt(id) } })).sessionId).toBe("sess-1");

    expect(await workOnce(config, agent)).toBeNull(); // waiting runs are not picked up

    await answerCheckpoint(actor, id, "CM");
    await workOnce(config, agent);

    run = await getRun(id);
    expect(agent.prompts[1]).toContain('answered your question "Hard bid or CM?"');
    expect(agent.prompts[1]).toContain("CM");
    expect(run).toMatchObject({ status: "succeeded" });
    expect(run?.steps.map((s) => s.state)).toEqual(["done", "done"]);
    // The resumed session reports its running total; it replaces step 1's figure rather than adding to it.
    expect(run?.costUsd).toBe(0.5);
  });

  it("stops at the cost cap with a plain reason", async () => {
    const id = await start();
    const agent = ((() =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "s" } as unknown as SDKMessage;
        yield { type: "result", subtype: "error_max_budget_usd", total_cost_usd: 5.01, modelUsage: {} } as unknown as SDKMessage;
      })()) as unknown) as RunAgent;

    await workOnce(config, agent);

    expect(await getRun(id)).toMatchObject({ status: "failed", error: "Stopped at the $5.00 cost cap.", costUsd: 5.01 });
  });

  it("keeps the step's cost when a resumed session ends in an error that reports less", async () => {
    const id = await start();
    await workOnce(config, fakeAgent([async (_cwd, options) => askUser(options, "Go on?")], 1.2));
    await answerCheckpoint(actor, id, "Stop here");
    const broke = ((() =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-1" } as unknown as SDKMessage;
        yield { type: "result", subtype: "error_during_execution", total_cost_usd: 0, modelUsage: {} } as unknown as SDKMessage;
      })()) as unknown) as RunAgent;

    await workOnce(config, broke);

    expect(await getRun(id)).toMatchObject({ status: "failed", costUsd: 1.2, tokens: 1700 });
  });

  it("gives the agent a scratch folder inside the workspace", async () => {
    await start();
    let seen: Options | undefined;
    await workOnce(config, fakeAgent([async (cwd, options) => {
      seen = options;
      expect((await readdir(cwd)).sort()).toContain("tmp");
    }]));
    const env = seen!.env!;
    expect(env.TEMP).toBe(path.join(seen!.cwd!, "tmp"));
    expect(env.TMP).toBe(env.TEMP);
    expect(env.TMPDIR).toBe(env.TEMP);
  });

  it("stops when the run is cancelled mid-step, and leaves it cancelled", async () => {
    const id = await start();
    const agent = ((({ options }: { options: Options }) =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "s" } as unknown as SDKMessage;
        await cancelRun(actor, id);
        await new Promise<void>((resolve, reject) => {
          options.abortController!.signal.addEventListener("abort", () => reject(new Error("aborted")));
          setTimeout(resolve, 8000);
        });
      })()) as unknown) as RunAgent;

    await workOnce(config, agent);

    expect(await getRun(id)).toMatchObject({ status: "cancelled" });
  }, 15_000);

  it("fails a run whose worker stopped sending heartbeats", async () => {
    const id = await start();
    await testDb.cipRun.update({
      where: { id: BigInt(id) },
      data: { status: "running", heartbeatAt: new Date(Date.now() - STALE_AFTER_MS - 1000) },
    });
    expect(await failStaleRuns()).toBe(1);
    expect(await getRun(id)).toMatchObject({ status: "failed" });
  });
});

describe("runSessionStore", () => {
  it("stores entries once by uuid and loads them back in order, per session and subpath", async () => {
    const id = BigInt(await start());
    const store = runSessionStore(id);
    const key = { projectKey: "p", sessionId: "s1" };

    await store.append(key, [{ type: "user", uuid: "a", n: 1 }, { type: "title" }]);
    await store.append(key, [{ type: "user", uuid: "a", n: 1 }, { type: "assistant", uuid: "b" }]);
    await store.append({ ...key, subpath: "subagents/agent-1" }, [{ type: "user", uuid: "c" }]);

    expect(await store.load(key)).toEqual([{ type: "user", uuid: "a", n: 1 }, { type: "title" }, { type: "assistant", uuid: "b" }]);
    expect(await store.load({ ...key, sessionId: "nope" })).toBeNull();
    expect(await store.listSubkeys!(key)).toEqual(["subagents/agent-1"]);
  });
});

describe("freeName", () => {
  it("keeps a free name, else bumps or adds _revN", async () => {
    const dir = path.join(root, "names");
    await mkdir(dir);
    await writeFile(path.join(dir, "a.docx"), "");
    await writeFile(path.join(dir, "b_rev3.xlsx"), "");
    expect(path.basename(await freeName(path.join(dir, "new.pdf")))).toBe("new.pdf");
    expect(path.basename(await freeName(path.join(dir, "a.docx")))).toBe("a_rev1.docx");
    expect(path.basename(await freeName(path.join(dir, "b_rev3.xlsx")))).toBe("b_rev4.xlsx");
  });
});
