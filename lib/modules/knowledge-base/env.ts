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
 *              production, a developer's synced folder locally. Read by
 *              source.ts through the shared folder store
 *              (lib/sharepoint/folder-store.ts), not here.
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
