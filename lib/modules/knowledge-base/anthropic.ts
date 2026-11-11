import Anthropic from "@anthropic-ai/sdk";
import { KB_ANTHROPIC_API_KEY_VAR } from "@/lib/env";

/**
 * The Knowledge Base's Anthropic configuration, read LAZILY like the rest of
 * the KB's (env.ts): the platform boots and search works with it absent.
 * Absent means search keeps its own order (no Haiku re-sort) and no answers
 * are written; the screen says which.
 *
 * Its OWN key, KB_ANTHROPIC_API_KEY, decided in lib/env.ts. Not
 * ANTHROPIC_API_KEY, which is BAS Analyze's and also the SDK's default name:
 * a client built without `apiKey` would read it unprompted, so every client
 * here is built by `kbAnthropicClient`, which passes the key explicitly, and
 * tests/anthropic-key-per-module.test.ts fails the build on one that does not.
 * No fallback to either other key, in either direction.
 *
 * Two models, each overridable without a code change for the day Anthropic
 * retires one:
 *
 *   re-sort  claude-haiku-5-5, low effort: reads the top passages and says
 *            which answer the question, best first. Cheap and fast.
 *   answer   claude-sonnet-5-5: writes the answer from the passages Haiku
 *            kept, citing each. Thinking left at the model's default.
 */

export { KB_ANTHROPIC_API_KEY_VAR };
export const KB_RERANK_MODEL_VAR = "KB_RERANK_MODEL";
export const KB_ANSWER_MODEL_VAR = "KB_ANSWER_MODEL";
export const KB_DEFAULT_RERANK_MODEL = "claude-haiku-5-5";
export const KB_DEFAULT_ANSWER_MODEL = "claude-sonnet-5-5";

export interface KbAnthropicEnv {
  apiKey: string;
  rerankModel: string;
  answerModel: string;
}

export type KbAnthropicEnvResult =
  | { present: true; values: KbAnthropicEnv }
  | { present: false; missing: string[] };

export type EnvLike = Record<string, string | undefined>;

/** Blank is absent, not malformed: `.env.example` ships `VAR=""`. */
export function readKbAnthropicEnv(env: EnvLike = process.env): KbAnthropicEnvResult {
  const apiKey = (env[KB_ANTHROPIC_API_KEY_VAR] ?? "").trim();
  if (apiKey.length === 0) return { present: false, missing: [KB_ANTHROPIC_API_KEY_VAR] };
  return {
    present: true,
    values: {
      apiKey,
      rerankModel: (env[KB_RERANK_MODEL_VAR] ?? "").trim() || KB_DEFAULT_RERANK_MODEL,
      answerModel: (env[KB_ANSWER_MODEL_VAR] ?? "").trim() || KB_DEFAULT_ANSWER_MODEL,
    },
  };
}

/** The one way the KB builds a client: the key is always passed. */
export function kbAnthropicClient(apiKey: string, timeoutMs: number): Anthropic {
  return new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 0 });
}

/** Text inside <data> is content from documents and people, never instructions. */
export function dataBlock(text: string): string {
  // A closing tag inside the content would end the block early.
  return `<data>\n${text.replace(/<\/?data>/gi, "")}\n</data>`;
}
