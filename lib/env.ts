import { z } from "zod";
import { parseBootstrapAdmins } from "./bootstrap-admins";

/**
 * Environment is parsed once, at import time, so a misconfigured deployment
 * fails on boot rather than on the first request that happens to need a value.
 *
 * Server-side only. Never import this from a client component - it would leak
 * secrets into the browser bundle.
 */

const nonEmpty = z.string().trim().min(1);

const schema = z.object({
  DATABASE_URL: nonEmpty,

  AUTH_SECRET: nonEmpty,
  AUTH_URL: z.url().optional(),

  AUTH_MICROSOFT_ENTRA_ID_ID: nonEmpty,
  // Local development only. Production authenticates with a managed identity,
  // so this is legitimately absent there.
  AUTH_MICROSOFT_ENTRA_ID_SECRET: z.string().trim().optional(),
  AUTH_MICROSOFT_ENTRA_ID_TENANT_ID: nonEmpty,

  // Comma-separated in the environment; an array everywhere in code.
  ALLOWED_EMAIL_DOMAINS: nonEmpty.transform((raw, ctx) => {
    const domains = raw
      .split(",")
      .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
      .filter((d) => d.length > 0);

    if (domains.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "must list at least one domain",
      });
      return z.NEVER;
    }
    return domains;
  }),

  // Comma-separated, like ALLOWED_EMAIL_DOMAINS above; an array everywhere in
  // code. Absent means no bootstrap admin, which is valid - the platform still
  // boots, nobody can reach /admin, and runbook.md covers the recovery.
  BOOTSTRAP_ADMIN_EMAIL: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const { emails, invalid } = parseBootstrapAdmins(raw);

      if (invalid.length > 0) {
        ctx.addIssue({
          code: "custom",
          message: `not an email address: ${invalid.join(", ")}`,
        });
        return z.NEVER;
      }

      return emails;
    }),

  // The send gate. Read live rather than from here on the hot path - see
  // lib/modules/change-orders/mail/guards.ts for why. Declared here so a
  // malformed value still fails on boot rather than at the moment of a send.
  PHB_ALLOW_SEND: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof schema>;

function parseEnv(): Env {
  const result = schema.safeParse(process.env);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${details}\n\n` +
        `Copy .env.example to .env.local and fill in every value.`,
    );
  }

  return result.data;
}

export const env = parseEnv();

export const isProduction = env.NODE_ENV === "production";

/**
 * Microsoft Graph configuration, read lazily.
 *
 * Deliberately NOT part of the boot schema above. The platform has to start and
 * serve the admin screen with no Graph credential configured at all - the
 * credential is a Change Orders concern, not a platform one, and a missing one
 * must degrade that single module rather than take the whole app down.
 *
 * Read from process.env on every call rather than captured at import time, so a
 * value that changes after boot is honoured and a test can vary it. The cost is
 * four property reads and a small parse; the mail client itself is memoised, so
 * in practice this runs once per process.
 */
/**
 * `.env.example` ships these as `VAR=""`, and an Azure app setting left blank
 * arrives the same way. An empty string means "not supplied", not "supplied and
 * malformed" - without this, an optional variable left blank would be reported
 * missing forever.
 */
const blankAsAbsent = <T extends z.ZodType>(inner: T) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim().length === 0 ? undefined : value,
    inner,
  );

/**
 * Entra client and tenant IDs are GUIDs. Matched on shape rather than with
 * z.uuid(), which additionally enforces the RFC 4122 version and variant
 * nibbles - a real Entra ID that failed that check would be refused for no good
 * reason. This still catches the typo that matters: a value that is not a GUID.
 */
const guid = z
  .string()
  .trim()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "must be a GUID",
  );

const graphSchema = z.object({
  GRAPH_CLIENT_ID: blankAsAbsent(guid),
  GRAPH_TENANT_ID: blankAsAbsent(guid),
  // Local development only. Production authenticates with a managed identity;
  // lib/modules/change-orders/graph/credential.ts refuses a secret there.
  GRAPH_CLIENT_SECRET: blankAsAbsent(z.string().trim().min(1).optional()),
  // The user-assigned managed identity that federates to the Graph app
  // registration in Azure. Absent means the system-assigned identity.
  GRAPH_MANAGED_IDENTITY_CLIENT_ID: blankAsAbsent(guid.optional()),
  CO_MAILBOX: blankAsAbsent(z.email().transform((e) => e.toLowerCase())),
});

export type GraphEnv = z.infer<typeof graphSchema>;

export type GraphEnvResult =
  | { present: true; values: GraphEnv }
  | { present: false; missing: string[] };

/**
 * `missing` names the variables a deployment still has to supply. Variable
 * names are not secrets, and naming them is the difference between a five-minute
 * fix and an afternoon of guessing.
 */
export function readGraphEnv(): GraphEnvResult {
  const result = graphSchema.safeParse(process.env);

  if (result.success) {
    return { present: true, values: result.data };
  }

  const missing = [
    ...new Set(
      result.error.issues.map((issue) => String(issue.path[0] ?? "(unknown)")),
    ),
  ].sort();

  return { present: false, missing };
}

/**
 * The mailbox address on its own. Everything else in the Graph configuration is
 * about *how* to authenticate; this is *what* we are allowed to touch, and the
 * mail service needs it even when the transport is supplied from elsewhere.
 */
export function readMailboxAddress(): string | null {
  const result = graphSchema.shape.CO_MAILBOX.safeParse(process.env.CO_MAILBOX);
  return result.success ? (result.data as string) : null;
}

/**
 * The Anthropic API key, read lazily - the same shape as the Graph
 * configuration above and for the same reason. It is one feature's credential
 * (BAS Ask, B5; and the Phase 12 Part D engine calls), and a missing key
 * disables that feature and nothing else. The platform must boot without it.
 *
 * The variable name is the Anthropic SDK's own default: `new Anthropic()` in
 * this repository and `anthropic.Anthropic()` in the engine (phb-co-engine,
 * Python) both read `ANTHROPIC_API_KEY` unprompted, so one name serves both
 * repositories and there is no second name to keep in step. Neither the B5 nor
 * the Phase 12 spec names the variable; this function is where the name is
 * decided, and anything that calls the API should take the key from here rather
 * than reading process.env itself.
 *
 * In Azure it arrives from Key Vault `ANTHROPIC-API-KEY` by secret reference
 * (infra/main.bicep, `anthropicApiKeyInKeyVault`); locally from `.env.local`.
 * The value is never logged, never persisted, and never returned to a client.
 */
const anthropicApiKeySchema = blankAsAbsent(z.string().trim().min(1).optional());

/**
 * THE NAMES of the two secrets that reach the container app from Key Vault by
 * reference and nowhere else, decided here and imported everywhere else that
 * reads them (lib/modules/bas/analyze/env.ts, lib/modules/bas/credentials.ts).
 * infra/main.bicep spells the same two names in its `env:` list, and
 * tests/deploy-guards.test.ts holds the three to each other: a rename in one
 * place that misses another fails the build rather than the deployment.
 *
 * BAS_CREDENTIAL_KEY_VERSION rides with the key. It is NOT a secret - a small
 * integer stamped on each credential row at encryption time so a rotation
 * does not need a flag day - and it reaches the container as a plain value.
 * Decryption never reads it; `currentKeyVersion` in credentials.ts does, when
 * a password is saved.
 */
export const ANTHROPIC_API_KEY_VAR = "ANTHROPIC_API_KEY";
export const BAS_CREDENTIAL_KEY_VAR = "BAS_CREDENTIAL_KEY";
export const BAS_CREDENTIAL_KEY_VERSION_VAR = "BAS_CREDENTIAL_KEY_VERSION";

export function readAnthropicApiKey(): string | null {
  const result = anthropicApiKeySchema.safeParse(process.env[ANTHROPIC_API_KEY_VAR]);
  return result.success && result.data ? result.data : null;
}
