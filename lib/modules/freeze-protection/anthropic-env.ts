import { FP_ANTHROPIC_API_KEY_VAR } from "@/lib/env";

/**
 * Freeze Protection's own Anthropic API key, for the equipment schedule
 * import, read LAZILY so the module works without it and the import says
 * which variable is missing instead of failing on boot.
 *
 * FP_ANTHROPIC_API_KEY and nothing else (2026-11-04): Key Vault
 * `FP-ANTHROPIC-API-KEY` in production, `.env.local` locally. Never BAS
 * Analyze's ANTHROPIC_API_KEY (the SDK's default) or the Change Orders key,
 * and no fallback to either. Every client passes `apiKey` explicitly;
 * tests/fp-anthropic-key.test.ts holds that.
 */

export { FP_ANTHROPIC_API_KEY_VAR };

export interface FreezeProtectionAnthropicEnv {
  apiKey: string;
}

export type FreezeProtectionAnthropicEnvResult =
  | { present: true; values: FreezeProtectionAnthropicEnv }
  | { present: false; missing: string[] };

export type EnvLike = Record<string, string | undefined>;

export function readFreezeProtectionAnthropicEnv(
  env: EnvLike = process.env,
): FreezeProtectionAnthropicEnvResult {
  const raw = env[FP_ANTHROPIC_API_KEY_VAR];
  const apiKey = typeof raw === "string" ? raw.trim() : "";
  if (apiKey.length === 0) {
    return { present: false, missing: [FP_ANTHROPIC_API_KEY_VAR] };
  }
  return { present: true, values: { apiKey } };
}
