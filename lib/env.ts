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
 * The Anthropic API keys, read lazily - the same shape as the Graph
 * configuration above and for the same reason. Each is one module's
 * credential, a missing key disables that module's model calls and nothing
 * else, and the platform must boot without either.
 *
 * There are TWO, one per module, since 2026-10-16:
 *
 * - `ANTHROPIC_API_KEY` is BAS Analyze's (B5). The name is the Anthropic
 *   SDK's own default - `new Anthropic()` reads it unprompted - which is
 *   exactly why the second key must NOT share it.
 * - `CO_ANTHROPIC_API_KEY` is Change Orders' (Phase 12 Part D, not yet
 *   built). A separate key so the two modules are billed, rate-limited and
 *   revoked independently: a BAS key that runs out of credit must not stop a
 *   change-order draft, and the reverse. Because the SDK falls back to
 *   `ANTHROPIC_API_KEY` whenever a client is constructed without `apiKey`,
 *   any change-order client MUST pass the key explicitly, and
 *   tests/anthropic-key-per-module.test.ts fails the build on one that does
 *   not. The reader never falls back to the BAS key: absent is absent.
 *
 * Neither spec names its variable; these functions are where the names are
 * decided, and anything that calls the API takes its key from here rather than
 * reading process.env itself. In Azure each arrives from Key Vault by secret
 * reference (`ANTHROPIC-API-KEY` / `CO-ANTHROPIC-API-KEY`, behind
 * `anthropicApiKeyInKeyVault` / `coAnthropicApiKeyInKeyVault` in
 * infra/main.bicep); locally from `.env.local`. The values are never logged,
 * never persisted, and never returned to a client.
 */
const anthropicApiKeySchema = blankAsAbsent(z.string().trim().min(1).optional());

/**
 * THE NAMES of the secrets that reach the container app from Key Vault by
 * reference and nowhere else, decided here and imported everywhere else that
 * reads them (lib/modules/bas/analyze/env.ts, lib/modules/bas/credentials.ts,
 * lib/modules/change-orders/anthropic-env.ts). infra/main.bicep spells the
 * same names in its `env:` list, and tests/deploy-guards.test.ts holds them
 * to each other: a rename in one place that misses another fails the build
 * rather than the deployment.
 *
 * BAS_CREDENTIAL_KEY_VERSION rides with the key. It is NOT a secret - a small
 * integer stamped on each credential row at encryption time so a rotation
 * does not need a flag day - and it reaches the container as a plain value.
 * Decryption never reads it; `currentKeyVersion` in credentials.ts does, when
 * a password is saved.
 */
export const ANTHROPIC_API_KEY_VAR = "ANTHROPIC_API_KEY";
/** Change Orders' own key (2026-10-16). Never the SDK default name - see above. */
export const CO_ANTHROPIC_API_KEY_VAR = "CO_ANTHROPIC_API_KEY";
export const BAS_CREDENTIAL_KEY_VAR = "BAS_CREDENTIAL_KEY";
export const BAS_CREDENTIAL_KEY_VERSION_VAR = "BAS_CREDENTIAL_KEY_VERSION";
/** The bas_analyze role's URL (2026-10-13): the third secret by reference, same shape. */
export const BAS_ASK_DATABASE_URL_VAR = "BAS_ASK_DATABASE_URL";

/** BAS Analyze's key. The tab itself reads it through `readAnalyzeEnv`. */
export function readAnthropicApiKey(): string | null {
  const result = anthropicApiKeySchema.safeParse(process.env[ANTHROPIC_API_KEY_VAR]);
  return result.success && result.data ? result.data : null;
}

/**
 * Change Orders' key. Reads `CO_ANTHROPIC_API_KEY` and nothing else - in
 * particular it does NOT fall back to `ANTHROPIC_API_KEY`, because a fallback
 * would silently bill the change-order pipeline to the BAS key the moment the
 * CO one was missing, which is the sharing this variable exists to end.
 */
export function readChangeOrderAnthropicApiKey(): string | null {
  const result = anthropicApiKeySchema.safeParse(process.env[CO_ANTHROPIC_API_KEY_VAR]);
  return result.success && result.data ? result.data : null;
}

/**
 * The Needs Review folder (Change Orders, 2026-10-21): the SharePoint folder
 * `_needs_review` that the change-order automation writes its "I need a
 * human" notes into, read by the platform and never written.
 *
 * Read lazily, the same shape as the Graph configuration and for the same
 * reason: the platform must boot and serve every other screen with none of
 * this set, and the Needs Review tab reports itself not configured until the
 * folder grant lands.
 *
 * A SEPARATE app registration from the mail one, deliberately. The mail app is
 * fenced to one mailbox by an Exchange ApplicationAccessPolicy, and that fence
 * is load-bearing (HANDOVER.md); widening that registration to SharePoint
 * would muddy the one story that makes it safe. This registration follows the
 * Cost Intelligence pattern instead: `Files.SelectedOperations.Selected`,
 * granted Read on the one folder, nothing else in the tenant visible to it.
 * The folder value is `ids:<driveId>/<itemId>` or the folder's browser URL.
 * The secret is for developer machines only; production presents the managed
 * identity's token, exactly as the mail app does, and
 * lib/modules/change-orders/graph/credential.ts refuses a secret there.
 */
export const CO_REVIEW_APP_TENANT_ID_VAR = "PHB_PLATFORM_CO_REVIEW_APP_TENANT_ID";
export const CO_REVIEW_APP_CLIENT_ID_VAR = "PHB_PLATFORM_CO_REVIEW_APP_CLIENT_ID";
/** Local development only. Never a template parameter, never in Azure. */
export const CO_REVIEW_APP_SECRET_VAR = "PHB_PLATFORM_CO_REVIEW_APP_SECRET";
export const CO_REVIEW_SHAREPOINT_FOLDER_VAR = "CO_REVIEW_SHAREPOINT_FOLDER";

const reviewSchema = z.object({
  [CO_REVIEW_APP_CLIENT_ID_VAR]: blankAsAbsent(guid),
  [CO_REVIEW_APP_TENANT_ID_VAR]: blankAsAbsent(guid),
  [CO_REVIEW_APP_SECRET_VAR]: blankAsAbsent(z.string().trim().min(1).optional()),
  [CO_REVIEW_SHAREPOINT_FOLDER_VAR]: blankAsAbsent(z.string().trim().min(1)),
  // The same user-assigned identity the mail app federates to. Absent means
  // the system-assigned identity, as for GRAPH_*.
  GRAPH_MANAGED_IDENTITY_CLIENT_ID: blankAsAbsent(guid.optional()),
});

export interface ReviewEnv {
  clientId: string;
  tenantId: string;
  clientSecret: string | null;
  managedIdentityClientId: string | null;
  /** `ids:<driveId>/<itemId>`, or the folder URL. Resolved by the service. */
  folder: string;
}

export type ReviewEnvResult =
  | { present: true; values: ReviewEnv }
  | { present: false; missing: string[] };

export function readReviewEnv(): ReviewEnvResult {
  const result = reviewSchema.safeParse(process.env);

  if (result.success) {
    const values = result.data;
    return {
      present: true,
      values: {
        clientId: values[CO_REVIEW_APP_CLIENT_ID_VAR],
        tenantId: values[CO_REVIEW_APP_TENANT_ID_VAR],
        clientSecret: values[CO_REVIEW_APP_SECRET_VAR] ?? null,
        managedIdentityClientId: values.GRAPH_MANAGED_IDENTITY_CLIENT_ID ?? null,
        folder: values[CO_REVIEW_SHAREPOINT_FOLDER_VAR],
      },
    };
  }

  const missing = [
    ...new Set(
      result.error.issues.map((issue) => String(issue.path[0] ?? "(unknown)")),
    ),
  ].sort();

  return { present: false, missing };
}
