import { CO_ANTHROPIC_API_KEY_VAR } from "@/lib/env";

/**
 * The Change Orders module's Anthropic API key, read LAZILY - the same shape
 * as `readAnalyzeEnv` in lib/modules/bas/analyze/env.ts, for the same reason:
 * the platform boots and every change-order screen works with it absent, and
 * whatever Phase 12 Part D builds on top of it says which variable is missing
 * rather than failing on boot.
 *
 * The NAME is decided in lib/env.ts and imported here, so this file and the
 * Key Vault wiring in infra/main.bicep cannot drift apart; the deploy-guard
 * test reads both.
 *
 * It is NOT `ANTHROPIC_API_KEY`. That is BAS Analyze's key, and it is also the
 * Anthropic SDK's default - a client built without `apiKey` reads it on its
 * own. So every change-order call site takes `values.apiKey` from here and
 * passes it explicitly, and tests/anthropic-key-per-module.test.ts fails the
 * build on a `new Anthropic(` under this module that does not. There is no
 * fallback from one key to the other in either direction.
 *
 * As of 2026-10-16 nothing calls this yet: the engine's judgment still runs
 * as Cowork scheduled tasks (docs/12-ai-layer-inventory.md), and Part D is the
 * phase that moves it to the API. This is the door it will come through.
 */

export { CO_ANTHROPIC_API_KEY_VAR };

export interface ChangeOrderAnthropicEnv {
  apiKey: string;
}

export type ChangeOrderAnthropicEnvResult =
  | { present: true; values: ChangeOrderAnthropicEnv }
  | { present: false; missing: string[] };

/** A plain record rather than NodeJS.ProcessEnv, so a test can pass two keys. */
export type EnvLike = Record<string, string | undefined>;

/**
 * `missing` names the variable, never a value. A variable name is not a
 * secret, and naming it is the difference between a five-minute fix and an
 * afternoon. Blank is absent, not malformed: `.env.example` ships `VAR=""`.
 */
export function readChangeOrderAnthropicEnv(
  env: EnvLike = process.env,
): ChangeOrderAnthropicEnvResult {
  const raw = env[CO_ANTHROPIC_API_KEY_VAR];
  const apiKey = typeof raw === "string" ? raw.trim() : "";

  if (apiKey.length === 0) {
    return { present: false, missing: [CO_ANTHROPIC_API_KEY_VAR] };
  }

  return { present: true, values: { apiKey } };
}
