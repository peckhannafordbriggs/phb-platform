import { ANTHROPIC_API_KEY_VAR, BAS_ASK_DATABASE_URL_VAR } from "@/lib/env-names";

/**
 * What the two Reports jobs read from their environment, and nothing else
 * (2026-11-11).
 *
 * The jobs run the same code as the web app but not the same process, and
 * their containers carry only what infra/main.bicep gives them: the scheduler
 * DATABASE_URL, the worker DATABASE_URL, ANTHROPIC_API_KEY and
 * BAS_ASK_DATABASE_URL (the bas_analyze role, which the planner questions
 * of Phase 6 run their SQL through), plus NODE_ENV. lib/env.ts is the WEB APP's boot schema -
 * AUTH_SECRET, the Entra ids, ALLOWED_EMAIL_DOMAINS - and it parses that
 * schema at import time, on purpose, so a misconfigured web deployment fails
 * on boot. A job that imports it, even for one name, boots the web app's
 * requirements and fails on the first of them it does not carry; the worker
 * did exactly that on every production execution until this file existed.
 *
 * So, the same shape as the Cost Intelligence worker (workerConfigFromEnv in
 * lib/modules/cost-intelligence/worker.ts): each job reads its own few
 * variables, lazily, through here. The NAMES come from lib/env-names.ts,
 * which has no side effects, never from lib/env.ts.
 * tests/bas-reports-jobs-env.test.ts walks each script's import graph and
 * fails if lib/env.ts is reachable, holds the template's env lists to the
 * lists below, and boots each script with ONLY those variables.
 */

export const DATABASE_URL_VAR = "DATABASE_URL";
export { ANTHROPIC_API_KEY_VAR, BAS_ASK_DATABASE_URL_VAR };

/** What the scheduler's template entry must carry. NODE_ENV rides beside it as a plain value. */
export const SCHEDULER_JOB_VARS = [DATABASE_URL_VAR] as const;
/** What the worker's template entry must carry. The key and the ask URL may be unset: runs then finish partial and say so. */
export const WORKER_JOB_VARS = [DATABASE_URL_VAR, ANTHROPIC_API_KEY_VAR, BAS_ASK_DATABASE_URL_VAR] as const;

/** A plain record rather than NodeJS.ProcessEnv, so a test can pass a few keys. */
export type EnvLike = Record<string, string | undefined>;

export interface SchedulerJobEnv {
  databaseUrl: string;
}

export interface WorkerJobEnv extends SchedulerJobEnv {
  /** null when unset or blank: the worker runs, and every run finishes partial naming the variable. */
  anthropicApiKey: string | null;
  /** The bas_analyze role's URL, or null: a run with planner questions then finishes partial naming it. */
  askDatabaseUrl: string | null;
}

function requireDatabaseUrl(env: EnvLike, job: string): string {
  const url = env[DATABASE_URL_VAR]?.trim() ?? "";
  if (url.length === 0) {
    throw new Error(
      `${DATABASE_URL_VAR} is not set. The ${job} job reads it by Key Vault reference (infra/main.bicep); locally, .env.local.`,
    );
  }
  return url;
}

export function readSchedulerJobEnv(env: EnvLike = process.env): SchedulerJobEnv {
  return { databaseUrl: requireDatabaseUrl(env, "scheduler") };
}

export function readWorkerJobEnv(env: EnvLike = process.env): WorkerJobEnv {
  const key = env[ANTHROPIC_API_KEY_VAR]?.trim() ?? "";
  const ask = env[BAS_ASK_DATABASE_URL_VAR]?.trim() ?? "";
  return {
    databaseUrl: requireDatabaseUrl(env, "worker"),
    anthropicApiKey: key.length === 0 ? null : key,
    askDatabaseUrl: ask.length === 0 ? null : ask,
  };
}

/**
 * Why a run cannot answer planner questions, naming the variables, or null
 * when both are there. Names only: a value is never printed.
 */
export function plannerUnavailableReason(env: Pick<WorkerJobEnv, "anthropicApiKey" | "askDatabaseUrl">): string | null {
  const missing = [
    env.anthropicApiKey === null ? ANTHROPIC_API_KEY_VAR : null,
    env.askDatabaseUrl === null ? BAS_ASK_DATABASE_URL_VAR : null,
  ].filter((v): v is string => v !== null);
  return missing.length === 0 ? null : `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set, so the planner could not be asked.`;
}
