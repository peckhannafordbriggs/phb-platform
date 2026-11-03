import { FP_ANTHROPIC_API_KEY_VAR } from "@/lib/env";

/**
 * The Freeze Protection module's Anthropic API key, read LAZILY - the same
 * shape as readChangeOrderAnthropicEnv. The module works with it absent; only
 * the equipment schedule import needs it, and that says which variable is
 * missing instead of failing on boot.
 *
 * It is NOT `ANTHROPIC_API_KEY` (BAS Analyze's, and the SDK's default) and not
 * `CO_ANTHROPIC_API_KEY`. Every client under this module passes `apiKey`
 * explicitly; tests/anthropic-key-per-module.test.ts fails the build on one
 * that does not.
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
