import { z } from "zod";
import { ANTHROPIC_API_KEY_VAR } from "@/lib/env";

/**
 * The two variables the Analyze tab needs, read LAZILY - exactly like
 * `readGraphEnv` in lib/env.ts and `BAS_CREDENTIAL_KEY` in credentials.ts.
 *
 * The API key's NAME is decided in lib/env.ts and imported here, so this file
 * and the Key Vault wiring in infra/main.bicep cannot drift apart - the
 * deploy-guard test reads all three.
 *
 * Neither is part of the boot schema. The platform starts and every other BAS
 * screen works with both absent; the Analyze tab says which one is missing and
 * nothing else changes. docs/BAS-B5.md makes that a hard constraint.
 *
 * BAS_ASK_DATABASE_URL is NOT DATABASE_URL. The platform's own connection can
 * write, because the rest of the platform needs it to. This one is a separate
 * PostgreSQL role - `bas_analyze`, created by `npm run bas:analyze:role` - that
 * can SELECT an allowlist of bas_* objects and do nothing else. The name is the
 * spec's: it is the URL the question box asks through.
 */

export { ANTHROPIC_API_KEY_VAR };
export const ASK_DATABASE_URL_VAR = "BAS_ASK_DATABASE_URL";

/** `.env.example` ships `VAR=""`; blank is absent, not malformed. */
const blankAsAbsent = <T extends z.ZodType>(inner: T) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim().length === 0 ? undefined : value,
    inner,
  );

const schema = z.object({
  [ANTHROPIC_API_KEY_VAR]: blankAsAbsent(z.string().trim().min(1)),
  [ASK_DATABASE_URL_VAR]: blankAsAbsent(
    z
      .string()
      .trim()
      .regex(/^postgres(ql)?:\/\//, "must be a PostgreSQL connection URL"),
  ),
});

export interface AnalyzeEnv {
  apiKey: string;
  askDatabaseUrl: string;
}

export type AnalyzeEnvResult =
  | { present: true; values: AnalyzeEnv }
  | { present: false; missing: string[] };

/**
 * `missing` names variables, never values. A variable name is not a secret, and
 * naming it is the difference between a five-minute fix and an afternoon.
 */
/** A plain record rather than NodeJS.ProcessEnv, so a test can pass two keys. */
export type EnvLike = Record<string, string | undefined>;

export function readAnalyzeEnv(env: EnvLike = process.env): AnalyzeEnvResult {
  const result = schema.safeParse(env);

  if (result.success) {
    return {
      present: true,
      values: {
        apiKey: result.data[ANTHROPIC_API_KEY_VAR],
        askDatabaseUrl: result.data[ASK_DATABASE_URL_VAR],
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

/**
 * The connection string with its password removed, for logs and errors.
 * Never log the raw value.
 */
export function describeConnection(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.username || "(no user)"}@${url.host}${url.pathname}`;
  } catch {
    return "(unreadable connection string)";
  }
}
