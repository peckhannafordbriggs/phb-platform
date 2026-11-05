import { ANTHROPIC_API_KEY_VAR, CIP_ANTHROPIC_API_KEY_VAR } from "@/lib/env";

/**
 * The Anthropic API key for Freeze Protection's equipment schedule import:
 * Cost Intelligence's key (owner's decision, 2026-11-04), read LAZILY so the
 * module works without it and the import says which variable is missing.
 *
 * It is tied the way Cost Intelligence ties it:
 * - Production: CIP_ANTHROPIC_API_KEY, which the web app gets from Key Vault
 *   `ANTHROPIC-API-KEY-CIP` (infra/main.bicep). Required. Never falls back to
 *   ANTHROPIC_API_KEY, which in the web app is BAS Analyze's.
 * - Locally: CIP_ANTHROPIC_API_KEY if set, else ANTHROPIC_API_KEY, the same
 *   sharing the CIP worker does locally (.env.example).
 *
 * Never the Change Orders key. Every client passes `apiKey` explicitly, so the
 * key is chosen here and nowhere else; tests/fp-anthropic-key.test.ts holds it.
 */

export { CIP_ANTHROPIC_API_KEY_VAR };

export interface FreezeProtectionAnthropicEnv {
  apiKey: string;
}

export type FreezeProtectionAnthropicEnvResult =
  | { present: true; values: FreezeProtectionAnthropicEnv }
  | { present: false; missing: string[] };

export type EnvLike = Record<string, string | undefined>;

const read = (env: EnvLike, name: string) => {
  const raw = env[name];
  return typeof raw === "string" ? raw.trim() : "";
};

export function readFreezeProtectionAnthropicEnv(
  env: EnvLike = process.env,
): FreezeProtectionAnthropicEnvResult {
  const cip = read(env, CIP_ANTHROPIC_API_KEY_VAR);
  if (cip.length > 0) return { present: true, values: { apiKey: cip } };
  if (env.NODE_ENV !== "production") {
    const local = read(env, ANTHROPIC_API_KEY_VAR);
    if (local.length > 0) return { present: true, values: { apiKey: local } };
  }
  return { present: false, missing: [CIP_ANTHROPIC_API_KEY_VAR] };
}
