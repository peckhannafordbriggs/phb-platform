import { z } from "zod";

/**
 * Knowledge Base configuration, read LAZILY - like readGraphEnv in lib/env.ts
 * and readAnalyzeEnv in lib/modules/bas/analyze/env.ts. None of it is in the
 * boot schema: the platform starts with all of it absent, and only the KB sync
 * and search say what is missing.
 *
 * Two groups, read separately, because they fail separately:
 *
 *   embedding  Azure OpenAI, which turns text into vectors. Needed by the sync
 *              and by every search.
 *   source     where the documents come from: the SharePoint library in
 *              production, a developer's synced folder locally.
 *
 * Credentials are this module's own (PLATFORM-CONTEXT.md). The KB never
 * reuses the Change Orders Graph app registration, which is fenced to one
 * mailbox and has no SharePoint access at all.
 */

export const KB_EMBEDDING_ENDPOINT_VAR = "KB_EMBEDDING_ENDPOINT";
export const KB_EMBEDDING_DEPLOYMENT_VAR = "KB_EMBEDDING_DEPLOYMENT";
export const KB_EMBEDDING_API_KEY_VAR = "KB_EMBEDDING_API_KEY";
export const KB_LOCAL_SOURCE_DIR_VAR = "KB_LOCAL_SOURCE_DIR";

/** `.env.example` ships `VAR=""`; blank is absent, not malformed. */
const blankAsAbsent = <T extends z.ZodType>(inner: T) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim().length === 0 ? undefined : value,
    inner,
  );

const guid = z
  .string()
  .trim()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "must be a GUID",
  );

export type EnvLike = Record<string, string | undefined>;

export type KbEnvResult<T> =
  | { present: true; values: T }
  | { present: false; missing: string[] };

function missingFrom(error: z.ZodError): string[] {
  return [
    ...new Set(error.issues.map((i) => String(i.path[0] ?? "(unknown)"))),
  ].sort();
}

const embeddingSchema = z.object({
  [KB_EMBEDDING_ENDPOINT_VAR]: blankAsAbsent(
    z.url().refine((u) => u.startsWith("https://"), "must be https"),
  ),
  [KB_EMBEDDING_DEPLOYMENT_VAR]: blankAsAbsent(z.string().trim().min(1)),
  // Local development only. Production authenticates with the container app's
  // managed identity (role: Cognitive Services OpenAI User), so a key there is
  // refused below rather than silently preferred - CLAUDE.md prohibition 7.
  [KB_EMBEDDING_API_KEY_VAR]: blankAsAbsent(z.string().trim().min(1).optional()),
  NODE_ENV: z.string().optional(),
});

export interface KbEmbeddingEnv {
  endpoint: string;
  deployment: string;
  /** Present locally; absent in production, where managed identity is used. */
  apiKey: string | null;
}

export function readKbEmbeddingEnv(
  env: EnvLike = process.env,
): KbEnvResult<KbEmbeddingEnv> {
  const result = embeddingSchema.safeParse(env);
  if (!result.success) {
    return { present: false, missing: missingFrom(result.error) };
  }
  const apiKey = result.data[KB_EMBEDDING_API_KEY_VAR] ?? null;
  if (apiKey !== null && result.data.NODE_ENV === "production") {
    throw new Error(
      `${KB_EMBEDDING_API_KEY_VAR} is set in production. Production uses the ` +
        "managed identity; remove the key. runbook.md -> Knowledge Base.",
    );
  }
  return {
    present: true,
    values: {
      endpoint: result.data[KB_EMBEDDING_ENDPOINT_VAR].replace(/\/+$/, ""),
      deployment: result.data[KB_EMBEDDING_DEPLOYMENT_VAR],
      apiKey,
    },
  };
}

const sharepointSchema = z.object({
  KB_GRAPH_TENANT_ID: blankAsAbsent(guid),
  KB_GRAPH_CLIENT_ID: blankAsAbsent(guid),
  // Local development only, like GRAPH_CLIENT_SECRET.
  KB_GRAPH_CLIENT_SECRET: blankAsAbsent(z.string().trim().min(1).optional()),
  KB_GRAPH_MANAGED_IDENTITY_CLIENT_ID: blankAsAbsent(guid.optional()),
  // Graph ids, not URLs: `contoso.sharepoint.com,<guid>,<guid>` and `b!...`.
  KB_SHAREPOINT_SITE_ID: blankAsAbsent(z.string().trim().min(1)),
  KB_SHAREPOINT_DRIVE_ID: blankAsAbsent(z.string().trim().min(1)),
});

export type KbSharePointEnv = z.infer<typeof sharepointSchema>;

export type KbSourceEnv =
  | { kind: "sharepoint"; values: KbSharePointEnv }
  | { kind: "local"; directory: string };

/**
 * The SharePoint library when it is configured, otherwise a local folder.
 * A local source is refused in production: production indexes the library,
 * and a path on the container's disk would be an empty index that looks fine.
 */
export function readKbSourceEnv(
  env: EnvLike = process.env,
): KbEnvResult<KbSourceEnv> {
  const sharepoint = sharepointSchema.safeParse(env);
  if (sharepoint.success) {
    return { present: true, values: { kind: "sharepoint", values: sharepoint.data } };
  }

  const directory = env[KB_LOCAL_SOURCE_DIR_VAR]?.trim() ?? "";
  if (directory.length > 0 && env.NODE_ENV !== "production") {
    return { present: true, values: { kind: "local", directory } };
  }

  return { present: false, missing: missingFrom(sharepoint.error) };
}
