import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ANTHROPIC_API_KEY_VAR,
  DATABASE_URL_VAR,
  SCHEDULER_JOB_VARS,
  WORKER_JOB_VARS,
  readSchedulerJobEnv,
  readWorkerJobEnv,
} from "@/lib/modules/bas/reports/job-env";

/**
 * The Reports jobs boot with ONLY what their template entries give them
 * (2026-11-11).
 *
 * The production worker failed at startup on every execution with
 * `ALLOWED_EMAIL_DOMAINS: Invalid input: expected string, received undefined`
 * from lib/env.ts: the script imported one function from the web app's env
 * module, and that module parses the whole web-app boot schema the moment it
 * is imported. The scheduler, which imports nothing from it, succeeded on the
 * same image. tests/bas-reports-jobs.test.ts runs both scripts and passed,
 * because it hands them the developer's full .env.local - the exact thing a
 * job container does not have.
 *
 * Three guards, from the cheapest up:
 *   1. a static walk of each script's import graph: lib/env.ts is unreachable,
 *      and the only modules reading process.env are the database client and
 *      the jobs' own reader;
 *   2. the template's env list for each job covers what the reader needs, and
 *      carries nothing unexplained;
 *   3. each script is spawned under tsx from a directory with no .env file,
 *      with a clean environment holding only the template's variables, and
 *      exits 0 on an empty queue. This is the test that would have caught the
 *      failure: put the lib/env.ts import back in the worker and it fails with
 *      the production message.
 */

const ROOT = path.resolve(process.cwd());
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SCRIPTS = {
  scheduler: "scripts/bas-reports-scheduler.ts",
  worker: "scripts/bas-reports-worker.ts",
} as const;

// ---------------------------------------------------------------------------
// 1. The static import graph
// ---------------------------------------------------------------------------

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"\n]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const ENV_READ_RE = /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*(?:['"]([A-Za-z_][A-Za-z0-9_]*)['"]|([A-Za-z_][A-Za-z0-9_]*))\s*\])/g;

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function resolveImport(spec: string, from: string): string | null {
  if (spec.startsWith("node:")) return null;
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null; // a package
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return path.normalize(candidate);
  }
  return null;
}

interface Graph {
  /** Every reachable module, repo-relative with forward slashes. */
  modules: string[];
  /** How each module was reached: child -> parent. */
  parent: Map<string, string | null>;
  /** process.env reads per module: the name, or `[CONST]` for a bracketed identifier. */
  envReads: Map<string, string[]>;
}

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

function walk(entry: string): Graph {
  const start = path.join(ROOT, entry);
  const parent = new Map<string, string | null>([[start, null]]);
  const envReads = new Map<string, string[]>();
  const queue = [start];
  const modules: string[] = [];
  while (queue.length > 0) {
    const file = queue.shift()!;
    modules.push(rel(file));
    const code = stripComments(readFileSync(file, "utf8"));
    const reads = [...code.matchAll(ENV_READ_RE)].map((m) => m[1] ?? m[2] ?? `[${m[3]}]`);
    if (reads.length > 0) envReads.set(rel(file), [...new Set(reads)].sort());
    for (const m of code.matchAll(IMPORT_RE)) {
      const target = resolveImport(m[1]!, file);
      if (target !== null && !parent.has(target)) {
        parent.set(target, file);
        queue.push(target);
      }
    }
  }
  return { modules, parent, envReads };
}

function chainTo(graph: Graph, target: string): string[] {
  const full = path.join(ROOT, target);
  if (!graph.parent.has(full)) return [];
  const chain: string[] = [];
  for (let cur: string | null | undefined = full; cur; cur = graph.parent.get(cur)) chain.unshift(rel(cur));
  return chain;
}

describe("neither job script can reach the web app's env schema", () => {
  for (const [job, script] of Object.entries(SCRIPTS)) {
    it(`${job}: lib/env.ts is not on the import graph of ${script}`, () => {
      const graph = walk(script);
      expect(graph.modules.length).toBeGreaterThan(20);
      expect(graph.modules).toContain("lib/db/client.ts");
      const chain = chainTo(graph, "lib/env.ts");
      expect(chain, `lib/env.ts reached by: ${chain.join(" -> ")}`).toEqual([]);
      // The names module it may use instead has no imports and no side effects.
      const names = stripComments(readFileSync(path.join(ROOT, "lib/env-names.ts"), "utf8"));
      expect(names).not.toMatch(/^\s*import\b/m);
      expect(names).not.toMatch(/process\.env/);
    });

    it(`${job}: the only module reading process.env directly is the database client; the jobs' reader takes env as a parameter`, () => {
      const graph = walk(script);
      expect([...graph.envReads.keys()]).toEqual(["lib/db/client.ts"]);
      expect(graph.envReads.get("lib/db/client.ts")).toEqual(["DATABASE_URL", "NODE_ENV"]);
      // The reader is on the graph, reads through the imported names and never
      // a literal, and defaults its parameter to process.env rather than
      // reaching for it inside.
      expect(graph.modules).toContain("lib/modules/bas/reports/job-env.ts");
      const reader = stripComments(readFileSync(path.join(ROOT, "lib/modules/bas/reports/job-env.ts"), "utf8"));
      expect(reader).toMatch(/env\[DATABASE_URL_VAR\]/);
      expect(reader).toMatch(/env\[ANTHROPIC_API_KEY_VAR\]/);
      expect(reader).not.toMatch(/["'`]ANTHROPIC_API_KEY["'`]/);
      expect(reader).toMatch(/from "@\/lib\/env-names"/);
      expect(reader).not.toMatch(/from "@\/lib\/env"/);
    });
  }

  it("the Cost Intelligence worker, the pattern the jobs follow, does not reach it either", () => {
    expect(chainTo(walk("scripts/cip-worker.ts"), "lib/env.ts")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. The template's env lists against the readers
// ---------------------------------------------------------------------------

function jobEnvNamesInTemplate(resource: string): string[] {
  const bicep = readFileSync(path.join(ROOT, "infra/main.bicep"), "utf8").split(/\r?\n/).filter((l) => !l.trim().startsWith("//")).join("\n");
  const start = bicep.indexOf(`resource ${resource} `);
  expect(start, resource).toBeGreaterThan(-1);
  const rest = bicep.slice(start + 1);
  const end = Math.min(...[rest.indexOf("\nresource "), rest.indexOf("\nvar "), rest.indexOf("\noutput ")].filter((i) => i > 0));
  const block = rest.slice(0, end);
  const envList = /\n\s*env: \[([\s\S]*?)\n\s*\]/.exec(block)?.[1] ?? "";
  return [...envList.matchAll(/name: '([A-Z0-9_]+)'/g)].map((m) => m[1]!).sort();
}

describe("the template gives each job exactly what its reader needs, and nothing unexplained", () => {
  it("scheduler: DATABASE_URL by reference and NODE_ENV", () => {
    const names = jobEnvNamesInTemplate("basReportsSchedulerJob");
    expect(names).toEqual([...SCHEDULER_JOB_VARS, "NODE_ENV"].sort());
  });

  it("worker: DATABASE_URL and ANTHROPIC_API_KEY by reference, NODE_ENV, and BAS_ASK_DATABASE_URL carried for Phase 6", () => {
    const names = jobEnvNamesInTemplate("basReportsWorkerJob");
    for (const required of WORKER_JOB_VARS) expect(names, required).toContain(required);
    // BAS_ASK_DATABASE_URL is on the worker for the planner questions of a
    // later phase; nothing on the worker's import graph reads it today, and
    // the graph test above would notice if something started to. Anything
    // else appearing here needs a reader and a line in the runbook.
    expect(names).toEqual([...WORKER_JOB_VARS, "BAS_ASK_DATABASE_URL", "NODE_ENV"].sort());
  });

  it("the readers take what they declare, trimmed, and name DATABASE_URL when it is missing", () => {
    expect(DATABASE_URL_VAR).toBe("DATABASE_URL");
    expect(ANTHROPIC_API_KEY_VAR).toBe("ANTHROPIC_API_KEY");
    expect(readSchedulerJobEnv({ DATABASE_URL: " postgresql://x " })).toEqual({ databaseUrl: "postgresql://x" });
    expect(readWorkerJobEnv({ DATABASE_URL: "postgresql://x", ANTHROPIC_API_KEY: " k " })).toEqual({ databaseUrl: "postgresql://x", anthropicApiKey: "k" });
    expect(readWorkerJobEnv({ DATABASE_URL: "postgresql://x", ANTHROPIC_API_KEY: "  " }).anthropicApiKey).toBeNull();
    expect(() => readWorkerJobEnv({ ANTHROPIC_API_KEY: "k" })).toThrow(/DATABASE_URL is not set/);
    expect(() => readSchedulerJobEnv({})).toThrow(/scheduler job/);
    // The web app's variables mean nothing to them.
    expect(readWorkerJobEnv({ DATABASE_URL: "postgresql://x", ALLOWED_EMAIL_DOMAINS: "", AUTH_SECRET: "" })).toEqual({ databaseUrl: "postgresql://x", anthropicApiKey: null });
  });
});

// ---------------------------------------------------------------------------
// 3. Boot each script with ONLY the template's variables, from a bare directory
// ---------------------------------------------------------------------------

/**
 * Operating-system plumbing the child process needs to exist at all - PATH and
 * the Windows system root for sockets, a temp directory, a home. None of it is
 * application configuration. Everything else, .env.local included, is withheld:
 * scripts/load-env.ts reads .env.local from the working directory, and the
 * working directory here is an empty temporary one, as /app in the image has
 * no .env file either (.dockerignore).
 */
const OS_PLUMBING = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL"];

function cleanEnv(templateVars: Record<string, string>): NodeJS.ProcessEnv {
  // Built up from nothing; the project's ProcessEnv augmentation makes NODE_ENV
  // required, and the template variables supply it below.
  const env = {} as NodeJS.ProcessEnv;
  for (const name of OS_PLUMBING) if (process.env[name] !== undefined) env[name] = process.env[name];
  // tsx finds tsconfig.json (the `@/` alias) from the working directory, which
  // is deliberately not the repository; point it at the repository's.
  env.TSX_TSCONFIG_PATH = path.join(ROOT, "tsconfig.json");
  return { ...env, ...templateVars };
}

describe("each job boots and exits cleanly with only its template variables and no .env file", () => {
  let bareDir: string;
  beforeAll(async () => {
    bareDir = await mkdtemp(path.join(os.tmpdir(), "phb-job-env-"));
  });
  afterAll(async () => {
    await rm(bareDir, { recursive: true, force: true });
  });

  const run = (script: string, env: NodeJS.ProcessEnv, args: string[] = []) =>
    spawnSync(process.execPath, [TSX_CLI, path.join(ROOT, script), ...args], {
      cwd: bareDir,
      env,
      encoding: "utf8",
      timeout: 120_000,
    });

  /**
   * The child's output without its stack frames. A frame line (`    at …`) in
   * an assertion message is parsed by vitest as part of the test's own stack,
   * and it then tries to load source maps for the child's files and aborts
   * the run - which is how the first mutation run of this file hid its own
   * result.
   */
  const shown = (result: { stdout: string; stderr: string }) =>
    `${result.stderr}\n${result.stdout}`
      .split(/\r?\n/)
      .filter((line) => !/^\s+at\s/.test(line))
      .slice(0, 16)
      .join("\n");

  /** The failure this file exists for, checked before the exit code so it is the message a reader sees. */
  const notTheWebAppSchema = (result: { stdout: string; stderr: string }) => {
    expect(result.stderr, `the job booted the web app's env schema:\n${shown(result)}`).not.toMatch(
      /Invalid environment configuration|ALLOWED_EMAIL_DOMAINS|AUTH_SECRET|AUTH_MICROSOFT_ENTRA_ID/,
    );
  };

  it("the scheduler: DATABASE_URL and NODE_ENV=production, empty queue, exit 0", () => {
    const result = run(SCRIPTS.scheduler, cleanEnv({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: "production" }));
    notTheWebAppSchema(result);
    expect(result.status, shown(result)).toBe(0);
    expect(result.stdout).toMatch(/\[bas-reports-scheduler\] \d+ queued, \d+ paused, \d+ skipped/);
  }, 150_000);

  it("the worker: DATABASE_URL, BAS_ASK_DATABASE_URL, a dummy ANTHROPIC_API_KEY and NODE_ENV=production, empty queue, exit 0", () => {
    const result = run(
      SCRIPTS.worker,
      cleanEnv({
        DATABASE_URL: process.env.DATABASE_URL!,
        BAS_ASK_DATABASE_URL: "postgresql://bas_analyze:unused@localhost:5432/unused",
        ANTHROPIC_API_KEY: "sk-ant-test-never-called",
        NODE_ENV: "production",
      }),
      ["--once"],
    );
    notTheWebAppSchema(result);
    expect(result.status, shown(result)).toBe(0);
    // The key was read: a narrator exists and names its model. No run was
    // queued, so it was never called.
    expect(result.stdout).toMatch(/\[bas-reports-worker\] narrator: claude-/);
    expect(result.stdout).toContain("[bas-reports-worker] 0 run(s) worked");
  }, 150_000);

  it("the worker without the key still boots, and says the runs will finish partial", () => {
    const result = run(SCRIPTS.worker, cleanEnv({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: "production" }), ["--once"]);
    notTheWebAppSchema(result);
    expect(result.status, shown(result)).toBe(0);
    expect(result.stdout).toContain(`narrator: none (${ANTHROPIC_API_KEY_VAR} unset; runs finish partial)`);
  }, 150_000);
});
