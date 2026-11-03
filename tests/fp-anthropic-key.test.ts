import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_API_KEY_VAR,
  CO_ANTHROPIC_API_KEY_VAR,
  FP_ANTHROPIC_API_KEY_VAR,
  readFreezeProtectionAnthropicApiKey,
} from "@/lib/env";
import { readFreezeProtectionAnthropicEnv } from "@/lib/modules/freeze-protection/anthropic-env";

/**
 * Freeze Protection's own Anthropic key (2026-11-03), the third per-module key.
 * Same rules as tests/anthropic-key-per-module.test.ts: its own variable, no
 * fallback, every client passes apiKey, and Key Vault by reference on the web
 * app only.
 */

const root = process.cwd();
const read = (rel: string) => readFile(path.join(root, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

async function tree(dirs: string[]) {
  const out: Array<{ file: string; code: string }> = [];
  for (const dir of dirs) {
    const entries = await readdir(path.join(root, dir), { recursive: true, withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !/\.(ts|tsx)$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) continue;
      const full = path.join(e.parentPath ?? e.path, e.name);
      out.push({ file: path.relative(root, full), code: strip(await readFile(full, "utf8")) });
    }
  }
  return out;
}

const FP_TREES = [
  "lib/modules/freeze-protection",
  "app/(modules)/freeze-protection",
  "app/api/modules/freeze-protection",
];

describe("FP_ANTHROPIC_API_KEY", () => {
  it("is its own name", () => {
    expect(FP_ANTHROPIC_API_KEY_VAR).toBe("FP_ANTHROPIC_API_KEY");
    expect(FP_ANTHROPIC_API_KEY_VAR).not.toBe(ANTHROPIC_API_KEY_VAR);
    expect(FP_ANTHROPIC_API_KEY_VAR).not.toBe(CO_ANTHROPIC_API_KEY_VAR);
  });

  it("never falls back to another module's key", () => {
    expect(
      readFreezeProtectionAnthropicEnv({ ANTHROPIC_API_KEY: "bas", CO_ANTHROPIC_API_KEY: "co" }),
    ).toEqual({ present: false, missing: ["FP_ANTHROPIC_API_KEY"] });
    expect(readFreezeProtectionAnthropicEnv({ FP_ANTHROPIC_API_KEY: "  " })).toEqual({
      present: false,
      missing: ["FP_ANTHROPIC_API_KEY"],
    });
    expect(
      readFreezeProtectionAnthropicEnv({ ANTHROPIC_API_KEY: "bas", FP_ANTHROPIC_API_KEY: " fp " }),
    ).toEqual({ present: true, values: { apiKey: "fp" } });
  });

  it("the lib/env.ts reader is lazy and independent", () => {
    const saved = { fp: process.env.FP_ANTHROPIC_API_KEY, bas: process.env.ANTHROPIC_API_KEY };
    try {
      delete process.env.FP_ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = "bas";
      expect(readFreezeProtectionAnthropicApiKey()).toBeNull();
      process.env.FP_ANTHROPIC_API_KEY = " fp ";
      expect(readFreezeProtectionAnthropicApiKey()).toBe("fp");
    } finally {
      if (saved.fp === undefined) delete process.env.FP_ANTHROPIC_API_KEY;
      else process.env.FP_ANTHROPIC_API_KEY = saved.fp;
      if (saved.bas === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved.bas;
    }
  });

  it("freeze-protection code names no other key and passes apiKey on every client", async () => {
    const files = await tree(FP_TREES);
    expect(files.length).toBeGreaterThan(10);
    let clients = 0;
    for (const { file, code } of files) {
      expect(code, file).not.toMatch(/(?<!(CO|FP)_)ANTHROPIC_API_KEY/);
      expect(code, file).not.toMatch(/CO_ANTHROPIC_API_KEY/);
      expect(code, file).not.toMatch(/\breadAnthropicApiKey\b|\breadChangeOrderAnthropic/);
      expect(code, file).not.toMatch(/["'`]FP_ANTHROPIC_API_KEY["'`]/);
      const all = code.match(/new Anthropic\s*\(/g) ?? [];
      const explicit = code.match(/new Anthropic\s*\(\s*\{[^}]*\bapiKey\b/g) ?? [];
      expect(explicit.length, file).toBe(all.length);
      clients += all.length;
    }
    expect(clients).toBeGreaterThanOrEqual(1);
  });

  it("other modules never name the freeze-protection key", async () => {
    for (const { file, code } of await tree([
      "lib/modules/bas",
      "lib/modules/change-orders",
      "app/(modules)/bas",
      "app/(modules)/change-orders",
    ])) {
      expect(code, file).not.toMatch(/FP_ANTHROPIC_API_KEY|readFreezeProtectionAnthropic/);
    }
  });
});

describe("FP_ANTHROPIC_API_KEY reaches the web app only by Key Vault reference", () => {
  it("is a secretRef behind its own false-by-default flag, never a value or a parameter", async () => {
    const bicep = await read("infra/main.bicep");
    expect(bicep).toMatch(/param fpAnthropicApiKeyInKeyVault bool = false/);
    expect(bicep).toMatch(/var fpAnthropicApiKeySecretName = 'FP-ANTHROPIC-API-KEY'/);
    expect(bicep).toMatch(
      /name:\s*'fp-anthropic-api-key'\s*keyVaultUrl:\s*'\$\{keyVault\.properties\.vaultUri\}secrets\/\$\{fpAnthropicApiKeySecretName\}'\s*identity:\s*identity\.id/,
    );
    expect(bicep).toMatch(/\.\.\.\(fpAnthropicApiKeyInKeyVault\s*\?\s*\[\s*\{\s*name:\s*'fp-anthropic-api-key'/);
    expect(bicep).toMatch(/\.\.\.\(fpAnthropicApiKeyInKeyVault\s*\?\s*\[\s*\{\s*name:\s*'FP_ANTHROPIC_API_KEY'\s*secretRef:\s*'fp-anthropic-api-key'/);
    expect(bicep).not.toMatch(/name:\s*'FP_ANTHROPIC_API_KEY'[\s\S]{0,80}value:/);
    expect(bicep).not.toMatch(/vaults\/secrets@[\d-]+'\s*=\s*\{[\s\S]{0,120}name:\s*'FP-ANTHROPIC-API-KEY'/);
    // The web app only: one env entry, one secret entry, no job gets it.
    expect(bicep.match(/name:\s*'FP_ANTHROPIC_API_KEY'/g)).toHaveLength(1);
    expect(bicep.match(/name:\s*'fp-anthropic-api-key'/g)).toHaveLength(1);
    // Never wired to another module's secret.
    expect(bicep).not.toMatch(/name:\s*'FP_ANTHROPIC_API_KEY'\s*secretRef:\s*'(co-)?anthropic-api-key'/);
  });

  it("ships off in the example parameters", async () => {
    const example = JSON.parse(await read("infra/main.parameters.example.json")) as {
      parameters: Record<string, { value: unknown }>;
    };
    expect(example.parameters.fpAnthropicApiKeyInKeyVault?.value).toBe(false);
  });
});
