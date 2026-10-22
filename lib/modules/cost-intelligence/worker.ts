import { cp, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createSdkMcpServer,
  query,
  tool,
  type SDKMessage,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { auditError, cipAudit } from "./audit";
import { AI_FILES, FileExistsError, isNotFound, projectsStore, skillsStore, type FolderStore } from "./folder-store";
import type { RunStepSnapshot } from "./runs";

/**
 * The run worker. `npm run cip:worker` (scripts/cip-worker.ts) calls
 * `workOnce` in a loop; in Azure a Container Apps Job runs it per queued run.
 *
 * For each step of a run it:
 *   1. builds a workspace: a COPY of the project (`project/`), the skills repo
 *      (`skills-repo/`), the step's skill in `.claude/skills/`, and an empty `out/`
 *   2. runs the Agent SDK with that skill. The agent may read anything in the
 *      workspace and run scripts on the copy; the real project is never touched
 *   3. publishes what the agent wrote to `out/` into the project's `AI FILES\`,
 *      as `_revN` when a name is taken, so nothing is ever overwritten
 *
 * A checkpoint is the `ask_user` tool: it records the question, the agent ends
 * its turn, the run goes to `waiting` and the worker moves on. The transcript
 * is mirrored to cip_run_transcripts (the SDK's SessionStore), so answering
 * re-queues the run and any worker can resume it.
 */

export type WorkerConfig = {
  /** BID-DOC: one folder per project. Read, and written only in `<project>/AI FILES`. */
  projects: FolderStore;
  /** PHB-CIS-skills, read-only: one folder per skill. */
  skills: FolderStore;
  /** Where run workspaces are built. Deleted when a run finishes. */
  workspaceDir: string;
  /** Where projects and skills come from, for the startup log. */
  sources?: { projects: string; skills: string };
  /** How often the heartbeat is written while a run is held. Tests shorten it. */
  heartbeatMs?: number;
};

export function workerConfigFromEnv(): WorkerConfig {
  const projects = projectsStore();
  const skills = skillsStore();
  if (!projects.ok) throw new Error(projects.message);
  if (!skills.ok) throw new Error(skills.message);
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error("Set ANTHROPIC_API_KEY for the worker (see .env.example).");
  }
  return {
    projects: projects.store,
    skills: skills.store,
    workspaceDir: process.env.CIP_WORKSPACE_DIR?.trim() || path.join(os.tmpdir(), "cip-runs"),
    sources: { projects: projects.source, skills: skills.source },
  };
}

/** A `running` run with no heartbeat for this long is a worker that died. */
export const STALE_AFTER_MS = 10 * 60 * 1000;
const HEARTBEAT_EVERY_MS = 15_000;
/** Also how quickly a worker notices its run was cancelled or failed by someone else. */
const CANCEL_CHECK_EVERY_MS = 5_000;
/** One ledger line stays readable; the full text is in the transcript. */
const LEDGER_TEXT_MAX = 1500;

/** OS litter, Office lock files, caches and archives. Never copied into a run. */
const SKIP = /^(?:~\$.*|\.DS_Store|Thumbs\.db|desktop\.ini|__pycache__|\.git|(?:\+\+ ?)?archive|_ARCHIVE-DO-NOT-READ)$/i;

/** What the agent is told on every step, on top of Claude Code's own system prompt. */
export const PLATFORM_INSTRUCTIONS = `You are running inside PH+B's Cost Intelligence platform, not in Cowork. These rules override anything a skill says about folders or tools:

- The project is in ./project. It is a read-only copy: read anything, but never edit it.
- The full skills repository (shared files, templates, helper scripts) is in ./skills-repo.
- Write every file you produce into ./out, using the file names the skill asks for (keep the _revN convention). Everything in ./out is published to the project's AI FILES folder when this step ends. Files written anywhere else are thrown away.
- There is no device_bash and no connected folder: use the Bash, Read, Write and Edit tools on this workspace.
- Stay inside this workspace. Do not read or write anything outside it. Put scratch files in ./tmp, not /tmp.
- When the skill tells you to check with the user, ask a question, or wait for a decision, call the ask_user tool with the question and, when there are clear choices, the options. Then stop working and end your turn. The answer arrives as the next message.
- Never ask the user anything in plain text; they only see questions sent through ask_user.
- If an answer tells you to stop, do no more work: reply in one line and end.
- Finish with a short plain summary of what you did and which files you wrote.`;

// ---------------------------------------------------------------------------
// Claiming and recovery
// ---------------------------------------------------------------------------

/** Take the oldest queued run, or null. SKIP LOCKED: two workers never get the same run. */
export async function claimNextRun(): Promise<bigint | null> {
  const rows = await prisma.$queryRaw<{ id: bigint; session_id: string | null }[]>`
    UPDATE cip_runs
       SET status = 'running', started_at = COALESCE(started_at, now()), heartbeat_at = now()
     WHERE id = (
       SELECT id FROM cip_runs WHERE status = 'queued'
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
    RETURNING id, session_id`;
  const row = rows[0];
  if (row === undefined) return null;
  await event(row.id, null, row.session_id ? "resumed" : "started", row.session_id ? "Resumed" : "Started");
  return row.id;
}

/** Fail runs whose worker stopped sending heartbeats. The person can start a new run. */
export async function failStaleRuns(now = new Date()): Promise<number> {
  const stale = await prisma.cipRun.findMany({
    where: { status: "running", heartbeatAt: { lt: new Date(now.getTime() - STALE_AFTER_MS) } },
    select: { id: true },
  });
  for (const { id } of stale) {
    await finish(id, "failed", "The worker stopped while running this. Start the run again.");
  }
  return stale.length;
}

// ---------------------------------------------------------------------------
// The SDK's transcript, kept in Postgres
// ---------------------------------------------------------------------------

/** SessionStore over cip_run_transcripts, scoped to one run. Entries with a uuid are stored once. */
export function runSessionStore(runId: bigint): SessionStore {
  return {
    async append(key, entries) {
      if (entries.length === 0) return;
      await prisma.cipRunTranscript.createMany({
        data: entries.map((entry) => ({
          runId,
          sessionId: key.sessionId,
          subpath: key.subpath ?? "",
          entryUuid: typeof entry.uuid === "string" ? entry.uuid : null,
          entry: entry as Prisma.InputJsonValue,
        })),
        skipDuplicates: true,
      });
    },
    async load(key) {
      const rows = await prisma.cipRunTranscript.findMany({
        where: { runId, sessionId: key.sessionId, subpath: key.subpath ?? "" },
        orderBy: { id: "asc" },
        select: { entry: true },
      });
      return rows.length === 0 ? null : rows.map((r) => r.entry as SessionStoreEntry);
    },
    async listSubkeys(key) {
      const rows = await prisma.cipRunTranscript.findMany({
        where: { runId, sessionId: key.sessionId, NOT: { subpath: "" } },
        distinct: ["subpath"],
        select: { subpath: true },
      });
      return rows.map((r) => r.subpath);
    },
  };
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

/** How the agent is started. Tests pass a fake. */
export type RunAgent = typeof query;

type StepOutcome =
  | { kind: "done" }
  | { kind: "asked" }
  /** The run left `running` under us: cancelled, or failed by another worker. */
  | { kind: "stopped" }
  /** `progressed`: the model produced output, as opposed to the session failing to start. */
  | { kind: "failed"; message: string; progressed: boolean };

/**
 * Claim one queued run and work on it until it finishes, waits on a question,
 * or is cancelled. Returns the run id, or null when nothing was queued.
 */
export async function workOnce(config: WorkerConfig, runAgent: RunAgent = query): Promise<bigint | null> {
  await failStaleRuns();
  const runId = await claimNextRun();
  if (runId === null) return null;

  // The heartbeat runs on a timer for as long as this worker holds the run, not
  // per agent message: rebuilding the workspace (a full SharePoint download on
  // resume) and long silent tool calls send no messages, and a run with no
  // heartbeat for STALE_AFTER_MS is failed by the next worker. Only a `running`
  // run is touched, so a run that went waiting, cancelled or failed stays so.
  const heartbeat = setInterval(() => {
    void prisma.cipRun
      .updateMany({ where: { id: runId, status: "running" }, data: { heartbeatAt: new Date() } })
      .catch(() => undefined);
  }, config.heartbeatMs ?? HEARTBEAT_EVERY_MS);

  try {
    await processRun(runId, config, runAgent);
  } catch (error) {
    await finish(runId, "failed", `The worker hit an error: ${errorText(error)}`).catch(() => undefined);
  } finally {
    clearInterval(heartbeat);
  }
  return runId;
}

async function processRun(runId: bigint, config: WorkerConfig, runAgent: RunAgent): Promise<void> {
  const run = await prisma.cipRun.findUniqueOrThrow({ where: { id: runId }, include: { project: true } });
  const steps = run.steps as RunStepSnapshot[];
  // The long path: on Windows TEMP can be an 8.3 short name (KRACHA~1), which
  // Claude Code does not match against its working directory.
  await mkdir(config.workspaceDir, { recursive: true });
  const workspace = path.join(await realpath(config.workspaceDir), `run-${runId}`);

  let current = run.currentStep;
  let sessionId = run.sessionId;
  // Set by Continue: resume the session that died mid-step with this, once.
  let continuePrompt = run.resumePrompt;
  if (continuePrompt !== null) await prisma.cipRun.update({ where: { id: runId }, data: { resumePrompt: null } });

  while (current < steps.length) {
    const step = steps[current]!;
    const continuing = sessionId !== null && continuePrompt !== null;
    const resumeWith = continuing ? continuePrompt : sessionId ? await answerFor(runId, current) : null;
    continuePrompt = null;
    if (sessionId && resumeWith === null) {
      // A session with no answered question to resume from: start the step over.
      sessionId = null;
    }
    if (!resumeWith) await event(runId, current, "step_started", `Step ${current + 1} of ${steps.length}: ${step.name}`);

    const building = Date.now();
    await buildWorkspace(workspace, config, run.project.folderName, step.folderName);
    await event(runId, current, "workspace", `Workspace ready (${Math.round((Date.now() - building) / 1000)} s)`);

    const outcome = await runStep({ runId, step, current, workspace, sessionId, resumeWith, model: run.model, runAgent });
    if (outcome.kind === "stopped") break;
    if (outcome.kind === "failed" && continuing && !outcome.progressed) {
      // The session could not be picked back up (it may have died mid tool call): redo the step instead.
      await event(runId, current, "resume_failed", `Could not pick the session back up, so step ${current + 1} starts over`);
      sessionId = null;
      continue;
    }
    if (outcome.kind === "failed") {
      await finish(runId, "failed", outcome.message);
      break;
    }

    // Published at a question too: the workspace is rebuilt on resume, maybe in
    // another container, and the published files come back in ./project/AI FILES.
    const published = await publishOutputs(path.join(workspace, "out"), config.projects, run.project.folderName);
    for (const file of published) await event(runId, current, "output", `${AI_FILES}/${file}`);
    if (published.length > 0) {
      await cipAudit("cip.outputs_published", null, { runId: runId.toString(), step: current + 1, files: published });
    }
    if (outcome.kind === "asked") {
      await rm(workspace, { recursive: true, force: true });
      return;
    }

    current += 1;
    sessionId = null;
    await prisma.cipRun.update({ where: { id: runId }, data: { currentStep: current, sessionId: null } });
    await event(runId, current - 1, "step_finished", `Finished ${step.name}`);

    if (current === steps.length) await finish(runId, "succeeded", null);
  }

  await rm(workspace, { recursive: true, force: true });
}

/** The answer to the step's latest question, worded for the agent, or null. */
async function answerFor(runId: bigint, step: number): Promise<string | null> {
  const checkpoint = await prisma.cipRunCheckpoint.findFirst({
    where: { runId, step, answeredAt: { not: null } },
    orderBy: { id: "desc" },
  });
  return checkpoint?.answer
    ? `The user answered your question "${checkpoint.question}":\n\n${checkpoint.answer}\n\n` +
        `Continue the skill. Files you wrote before the question were published and are now in ./project/${AI_FILES}; ` +
        "to change one, write the new version into ./out."
    : null;
}

async function runStep(args: {
  runId: bigint;
  step: RunStepSnapshot;
  current: number;
  workspace: string;
  sessionId: string | null;
  resumeWith: string | null;
  model: string;
  runAgent: RunAgent;
}): Promise<StepOutcome> {
  const { runId, step, current, workspace } = args;
  const before = await spentBeforeStep(runId, current);
  const run = await prisma.cipRun.findUniqueOrThrow({ where: { id: runId }, select: { budgetUsd: true } });
  const remaining = Math.max(Number(run.budgetUsd) - before.cost, 0.01);

  let asked = false;
  const askUser = tool(
    "ask_user",
    "Ask the person running this workflow a question and wait for their answer. Use it whenever the skill says to check with the user. After calling it, end your turn.",
    {
      question: z.string().min(1).describe("The question, with enough context to answer it without opening any files"),
      options: z.array(z.string().min(1)).max(8).optional().describe("Clear choices, when there are some"),
    },
    async ({ question, options }) => {
      asked = true;
      await prisma.cipRunCheckpoint.create({ data: { runId, step: current, question, options: options ?? [] } });
      await event(runId, current, "checkpoint", question);
      await cipAudit("cip.question_asked", null, { runId: runId.toString(), step: current + 1, question });
      return { content: [{ type: "text", text: "Question sent. Stop now and end your turn; the answer will be the next message." }] };
    },
  );

  const abort = new AbortController();
  // Stop the agent once the run is no longer ours to work on: cancelled by a
  // person, or failed by another worker that took it for dead. Carrying on
  // would spend money on a run that already shows as finished.
  let stopped = false;
  const watcher = setInterval(() => {
    void prisma.cipRun
      .findUnique({ where: { id: runId }, select: { status: true } })
      .then((r) => {
        if (r?.status !== "running") {
          stopped = true;
          abort.abort();
        }
      })
      .catch(() => undefined);
  }, CANCEL_CHECK_EVERY_MS);

  let sessionSeen: string | null = null;
  let progressed = false;
  let failure: string | null = null;
  let succeeded = false;

  try {
    const messages = args.runAgent({
      prompt:
        args.resumeWith ??
        `/${step.folderName} Run this skill on the project in ./project. Write your outputs into ./out.`,
      options: {
        cwd: workspace,
        model: args.model,
        resume: args.sessionId ?? undefined,
        sessionStore: runSessionStore(runId),
        settingSources: ["project"],
        skills: [step.folderName],
        systemPrompt: { type: "preset", preset: "claude_code", append: PLATFORM_INSTRUCTIONS },
        // Only these tools exist, and nothing else loads: no web, no MCP servers or
        // settings from the machine, no inherited environment. Within that, no
        // per-call permission checks: there is nobody to ask, and "dontAsk" refused
        // Write and Bash after a resume on Windows (runbook: "Write and Bash are
        // denied"). The boundary is the tool list plus the workspace being a copy.
        // Claude Code refuses this mode as root; the worker never runs as root.
        tools: AGENT_TOOLS,
        allowedTools: [...AGENT_TOOLS, "mcp__cip__ask_user"],
        disallowedTools: ["WebFetch", "WebSearch"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        mcpServers: { cip: createSdkMcpServer({ name: "cip", tools: [askUser] }) },
        strictMcpConfig: true,
        env: agentEnv(workspace),
        maxBudgetUsd: remaining,
        abortController: abort,
      },
    });

    for await (const message of messages) {
      // Model output only: a session that cannot be resumed still sends its
      // init, an error result, and sometimes a synthetic assistant error.
      if (message.type === "assistant" && !message.error) progressed = true;
      await record(runId, current, message);
      // Every message carries the session id; keep it so an answered question can resume this session.
      const session = "session_id" in message && typeof message.session_id === "string" ? message.session_id : null;
      if (session && session !== sessionSeen) {
        sessionSeen = session;
        await prisma.cipRun.update({ where: { id: runId }, data: { sessionId: session } });
      }
      if (message.type === "result") {
        await saveCost(runId, before, message);
        if (message.subtype === "success") succeeded = true;
        else failure = resultFailure(message.subtype, Number(run.budgetUsd));
      }
    }
  } catch (error) {
    if (!stopped) failure = `The agent stopped: ${errorText(error)}`;
  } finally {
    clearInterval(watcher);
  }

  if (stopped) return { kind: "stopped" };
  if (asked) {
    await prisma.cipRun.update({ where: { id: runId }, data: { status: "waiting", heartbeatAt: null } });
    return { kind: "asked" };
  }
  if (failure) return { kind: "failed", message: failure, progressed };
  if (!succeeded) return { kind: "failed", message: "The agent ended without finishing.", progressed };
  return { kind: "done" };
}

const AGENT_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Skill", "TodoWrite"];

/** Variables the agent process may see. Everything else on the worker (database URL included) stays out. */
const PASS_THROUGH = [
  "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "ComSpec", "PATHEXT",
  "LANG", "LC_ALL", "ANTHROPIC_API_KEY",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS",
];

export function agentEnv(workspace: string): Record<string, string> {
  const env: Record<string, string> = {
    // The agent's own config and session files live in the workspace, not the worker's home.
    CLAUDE_CONFIG_DIR: path.join(workspace, ".claude-home"),
    CLAUDE_AGENT_SDK_CLIENT_APP: "phb-cip-worker",
  };
  for (const key of PASS_THROUGH) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Scratch files (Git Bash maps /tmp to TEMP) stay in the workspace and go with it.
  const scratch = path.join(workspace, "tmp");
  env.TEMP = env.TMP = env.TMPDIR = scratch;
  return env;
}

function resultFailure(subtype: string, budget: number): string {
  if (subtype === "error_max_budget_usd") return `Stopped at the $${budget.toFixed(2)} cost cap.`;
  if (subtype === "error_max_turns") return "Stopped: the agent took too many turns.";
  return "The agent hit an error and stopped.";
}

/** Cost and tokens of the steps already finished; a step's session totals are added on top. */
async function spentBeforeStep(runId: bigint, step: number): Promise<{ cost: number; input: number; output: number }> {
  const finished = await prisma.cipRunEvent.findMany({
    where: { runId, type: "step_cost", step: { lt: step } },
    select: { data: true },
  });
  return finished.reduce(
    (sum, e) => {
      const d = e.data as { cost?: number; input?: number; output?: number };
      return { cost: sum.cost + (d.cost ?? 0), input: sum.input + (d.input ?? 0), output: sum.output + (d.output ?? 0) };
    },
    { cost: 0, input: 0, output: 0 },
  );
}

/** A result's totals are cumulative for the session (a resumed one included), so they replace, never add, and never go down. */
async function saveCost(
  runId: bigint,
  before: { cost: number; input: number; output: number },
  result: Extract<SDKMessage, { type: "result" }>,
): Promise<void> {
  let input = 0;
  let output = 0;
  for (const usage of Object.values(result.modelUsage ?? {})) {
    input += usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
    output += usage.outputTokens;
  }
  const step = await prisma.cipRun.findUniqueOrThrow({ where: { id: runId }, select: { currentStep: true } });
  // Never lower what a step already recorded: an error result (no credit, API
  // down) after a resume can report less than the session really spent.
  const prior = await prisma.cipRunEvent.findFirst({ where: { runId, type: "step_cost", step: step.currentStep } });
  const was = (prior?.data ?? {}) as { cost?: number; input?: number; output?: number };
  const cost = Math.max(result.total_cost_usd, was.cost ?? 0);
  input = Math.max(input, was.input ?? 0);
  output = Math.max(output, was.output ?? 0);
  await prisma.$transaction([
    prisma.cipRunEvent.deleteMany({ where: { runId, type: "step_cost", step: step.currentStep } }),
    prisma.cipRunEvent.create({
      data: {
        runId,
        step: step.currentStep,
        type: "step_cost",
        message: `$${cost.toFixed(4)}`,
        data: { cost, input, output },
      },
    }),
    prisma.cipRun.update({
      where: { id: runId },
      data: {
        costUsd: before.cost + cost,
        inputTokens: BigInt(before.input + input),
        outputTokens: BigInt(before.output + output),
      },
    }),
  ]);
}

/** What goes in the ledger: what the agent says, and the tools it uses. */
async function record(runId: bigint, step: number, message: SDKMessage): Promise<void> {
  if (message.type !== "assistant" || message.parent_tool_use_id !== null) return;
  for (const block of message.message.content) {
    if (block.type === "text" && block.text.trim()) {
      await event(runId, step, "message", clip(block.text.trim()));
    } else if (block.type === "tool_use" && block.name !== "mcp__cip__ask_user") {
      await event(runId, step, "tool", describeTool(block.name, block.input));
    }
  }
}

function describeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const pick = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  switch (name) {
    case "Read":
      return `Read ${pick("file_path").replace(/^.*?\/project\//, "")}`;
    case "Write":
    case "Edit":
      return `${name === "Write" ? "Wrote" : "Edited"} ${pick("file_path").replace(/^.*?\/out\//, "")}`;
    case "Bash":
      return `Ran: ${clip(pick("description") || pick("command"), 200)}`;
    case "Glob":
    case "Grep":
      return `Searched for ${clip(pick("pattern"), 200)}`;
    case "Skill":
      return `Opened skill ${pick("skill") || pick("command")}`;
    default:
      return `Used ${name}`;
  }
}

async function event(runId: bigint, step: number | null, type: string, message: string): Promise<void> {
  await prisma.cipRunEvent.create({ data: { runId, step, type, message } });
}

/** Set a final status unless the run was cancelled meanwhile. */
async function finish(runId: bigint, status: "succeeded" | "failed", error: string | null): Promise<void> {
  const { count } = await prisma.cipRun.updateMany({
    where: { id: runId, status: { in: ["queued", "running", "waiting"] } },
    data: { status, error, finishedAt: new Date(), heartbeatAt: null },
  });
  if (count === 0) return;
  await event(runId, null, status, status === "succeeded" ? "Run completed" : (error ?? "Run failed"));
  const run = await prisma.cipRun.findUnique({
    where: { id: runId },
    select: { workflowName: true, currentStep: true, costUsd: true, project: { select: { folderName: true } } },
  });
  await cipAudit(status === "succeeded" ? "cip.run_succeeded" : "cip.run_failed", null, {
    runId: runId.toString(),
    workflowName: run?.workflowName ?? null,
    projectName: run?.project.folderName ?? null,
    costUsd: Number(run?.costUsd ?? 0),
    ...(status === "failed" ? { step: (run?.currentStep ?? 0) + 1, error: error === null ? null : auditError(error) } : {}),
  });
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** project/ (a copy), skills-repo/, .claude/skills/<skill>/ and an empty out/. */
export async function buildWorkspace(workspace: string, config: WorkerConfig, project: string, skill: string) {
  await rm(workspace, { recursive: true, force: true });
  const filter = (source: string) => !SKIP.test(path.basename(source));
  const projectCopy = path.join(workspace, "project");
  // Includes AI FILES, so outputs published earlier (a previous step, or before a question) come back.
  await config.projects.download(project, projectCopy, SKIP);
  await config.skills.download("", path.join(workspace, "skills-repo"), SKIP);
  await cp(path.join(workspace, "skills-repo", skill), path.join(workspace, ".claude", "skills", skill), { recursive: true, filter });
  await mkdir(path.join(workspace, "out"), { recursive: true });
  await mkdir(path.join(workspace, "tmp"), { recursive: true });
}

/**
 * Create every file in `outDir` in `<project>/AI FILES/` (made if needed),
 * keeping subfolders. A taken name gets the next free `_revN`; nothing is ever
 * replaced. Returns the names used, relative to AI FILES.
 */
export async function publishOutputs(outDir: string, projects: FolderStore, project: string): Promise<string[]> {
  const files = await listFiles(outDir);
  const taken = new Map<string, Set<string>>(); // folder under AI FILES -> names in it, lower case
  const published: string[] = [];

  for (const rel of files) {
    const parts = rel.split(path.sep);
    const name = parts.pop()!;
    const folder = parts.join("/");
    const dir = [project, AI_FILES, folder].filter(Boolean).join("/");
    if (!taken.has(folder)) {
      const names = await projects.list(dir).then(
        (entries) => entries.map((e) => e.name.toLowerCase()),
        (error: unknown) => {
          if (isNotFound(error)) return [];
          throw error;
        },
      );
      taken.set(folder, new Set(names));
    }
    const names = taken.get(folder)!;
    const data = await readFile(path.join(outDir, rel));

    // Someone may add the same name between the listing and the upload: then take the next one.
    for (let attempt = 0; ; attempt += 1) {
      const free = freeName(name, names);
      names.add(free.toLowerCase());
      try {
        await projects.write(`${dir}/${free}`, data);
        published.push(folder ? `${folder}/${free}` : free);
        break;
      } catch (error) {
        if (!(error instanceof FileExistsError) || attempt >= 20) throw error;
      }
    }
  }
  return published;
}

async function listFiles(dir: string, rel = ""): Promise<string[]> {
  const entries = await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    if (SKIP.test(e.name)) continue;
    const child = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, child)));
    else if (e.isFile()) out.push(child);
  }
  return out.sort();
}

/** `name.ext`, or `name_revN.ext` with the first N not in `taken` (lower-case names), above any _revN already in the name. */
export function freeName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  const match = /^(.*)_rev(\d+)$/.exec(base);
  const stem = match ? match[1]! : base;
  for (let n = match ? Number(match[2]) + 1 : 1; ; n += 1) {
    const candidate = `${stem}_rev${n}${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function clip(text: string, max = LEDGER_TEXT_MAX): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
