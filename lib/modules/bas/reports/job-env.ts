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

/*
 * The report email (Reports, Phase 4, the email half - 2026-11-17). Plain
 * values, never secrets: the sender app registration (phb-platform-bas-mail,
 * Vitis Request 7) is reached in production with the managed identity and a
 * federated identity credential, as the Change Orders mail app is, so there
 * is no Key Vault secret to read. A client secret exists for developer
 * machines only and is REFUSED in production (email/mailer.ts).
 */
export const BAS_MAIL_CLIENT_ID_VAR = "BAS_MAIL_CLIENT_ID";
export const BAS_MAIL_TENANT_ID_VAR = "BAS_MAIL_TENANT_ID";
export const BAS_MAILBOX_VAR = "BAS_MAILBOX";
/** Developer machines only, in .env.local. Never in the template; production refuses to send with it set. */
export const BAS_MAIL_CLIENT_SECRET_VAR = "BAS_MAIL_CLIENT_SECRET";
/**
 * The send gate, mirroring PHB_ALLOW_SEND: exactly the lowercase string
 * "true" opens it; absent, "false", "TRUE" and "1" all leave it closed, and
 * a closed gate means every delivery is recorded as not sent and nothing
 * leaves the platform.
 */
export const BAS_REPORTS_ALLOW_SEND_VAR = "BAS_REPORTS_ALLOW_SEND";
/** The platform's one user-assigned identity, named for the module that first needed it (the CIP worker reads the same one). */
export const MANAGED_IDENTITY_CLIENT_ID_VAR = "GRAPH_MANAGED_IDENTITY_CLIENT_ID";
/** Where the email's link points: the platform's own address, the template's authUrl. */
export const PLATFORM_URL_VAR = "PLATFORM_URL";
export const NODE_ENV_VAR = "NODE_ENV";

/** Two L's: the controls team's mailbox. The plan's sender (§A, §D5). */
export const DEFAULT_BAS_MAILBOX = "controlls@phb1899.com";

/** What the worker's template entry carries for the email, as plain values beside WORKER_JOB_VARS. */
export const WORKER_MAIL_VARS = [
  BAS_MAIL_CLIENT_ID_VAR,
  BAS_MAIL_TENANT_ID_VAR,
  BAS_MAILBOX_VAR,
  BAS_REPORTS_ALLOW_SEND_VAR,
  MANAGED_IDENTITY_CLIENT_ID_VAR,
  PLATFORM_URL_VAR,
] as const;

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

export interface BasMailEnv {
  clientId: string | null;
  tenantId: string | null;
  /** Lower-cased; DEFAULT_BAS_MAILBOX when unset or blank. */
  mailbox: string;
  clientSecret: string | null;
  managedIdentityClientId: string | null;
  /** True only for exactly "true". */
  allowSend: boolean;
  /** NODE_ENV is "production". Decides the credential path and the company-only fence. */
  production: boolean;
  /** No trailing slash; null when unset, and the email then names the tab instead of linking. */
  platformUrl: string | null;
}

const trimmedOrNull = (value: string | undefined): string | null => {
  const t = value?.trim() ?? "";
  return t.length === 0 ? null : t;
};

export function readWorkerMailEnv(env: EnvLike = process.env): BasMailEnv {
  const url = trimmedOrNull(env[PLATFORM_URL_VAR]);
  return {
    clientId: trimmedOrNull(env[BAS_MAIL_CLIENT_ID_VAR]),
    tenantId: trimmedOrNull(env[BAS_MAIL_TENANT_ID_VAR]),
    mailbox: (trimmedOrNull(env[BAS_MAILBOX_VAR]) ?? DEFAULT_BAS_MAILBOX).toLowerCase(),
    clientSecret: trimmedOrNull(env[BAS_MAIL_CLIENT_SECRET_VAR]),
    managedIdentityClientId: trimmedOrNull(env[MANAGED_IDENTITY_CLIENT_ID_VAR]),
    // No trim, no case-folding: the same comparison PHB_ALLOW_SEND's guard makes.
    allowSend: env[BAS_REPORTS_ALLOW_SEND_VAR] === "true",
    production: env[NODE_ENV_VAR] === "production",
    platformUrl: url === null ? null : url.replace(/\/+$/, ""),
  };
}

/**
 * Why the report email cannot be sent, naming the variables, or null when
 * it can be attempted. Names only: a value is never printed. The gate is
 * not part of this - a closed gate is a decision, not a fault.
 */
export function mailNotConfiguredReason(mail: BasMailEnv): string | null {
  const missing = [
    mail.clientId === null ? BAS_MAIL_CLIENT_ID_VAR : null,
    mail.tenantId === null ? BAS_MAIL_TENANT_ID_VAR : null,
    !mail.production && mail.clientSecret === null ? BAS_MAIL_CLIENT_SECRET_VAR : null,
  ].filter((v): v is string => v !== null);
  if (missing.length > 0) {
    return `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set, so the report email cannot be sent.`;
  }
  if (mail.production && mail.clientSecret !== null) {
    return `${BAS_MAIL_CLIENT_SECRET_VAR} is set in production. Production sends with the managed identity and a federated identity credential; remove the secret from the deployment configuration.`;
  }
  return null;
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
