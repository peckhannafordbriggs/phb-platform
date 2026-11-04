import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CIP_ANTHROPIC_API_KEY_VAR } from "@/lib/env";
import { readFreezeProtectionAnthropicEnv } from "@/lib/modules/freeze-protection/anthropic-env";

/**
 * Freeze Protection's schedule import runs on Cost Intelligence's key
 * (owner's decision, 2026-11-04), tied the way CIP ties it: Key Vault
 * ANTHROPIC-API-KEY-CIP in production, ANTHROPIC_API_KEY shared locally. In
 * the web app the variable is CIP_ANTHROPIC_API_KEY, because there
 * ANTHROPIC_API_KEY is BAS Analyze's. Never the Change Orders key, and every
 * client passes `apiKey` explicitly.
 */

const root = process.cwd();
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

describe("the schedule import's Anthropic key", () => {
  it("is named in lib/env.ts", () => {
    expect(CIP_ANTHROPIC_API_KEY_VAR).toBe("CIP_ANTHROPIC_API_KEY");
  });

  it("reads the CIP key first, trimmed", () => {
    expect(
      readFreezeProtectionAnthropicEnv({ NODE_ENV: "production", CIP_ANTHROPIC_API_KEY: " cip ", ANTHROPIC_API_KEY: "bas" }),
    ).toEqual({ present: true, values: { apiKey: "cip" } });
  });

  it("in production never falls back to ANTHROPIC_API_KEY, which there is BAS Analyze's", () => {
    expect(readFreezeProtectionAnthropicEnv({ NODE_ENV: "production", ANTHROPIC_API_KEY: "bas" })).toEqual({
      present: false,
      missing: ["CIP_ANTHROPIC_API_KEY"],
    });
  });

  it("locally shares ANTHROPIC_API_KEY, the way the CIP worker does", () => {
    expect(readFreezeProtectionAnthropicEnv({ NODE_ENV: "development", ANTHROPIC_API_KEY: " local " })).toEqual({
      present: true,
      values: { apiKey: "local" },
    });
    expect(readFreezeProtectionAnthropicEnv({ NODE_ENV: "development", CIP_ANTHROPIC_API_KEY: "  " })).toEqual({
      present: false,
      missing: ["CIP_ANTHROPIC_API_KEY"],
    });
  });

  it("never uses the Change Orders key", () => {
    expect(readFreezeProtectionAnthropicEnv({ NODE_ENV: "development", CO_ANTHROPIC_API_KEY: "co" }).present).toBe(false);
  });

  it("freeze-protection code imports the names, never names the CO key, and passes apiKey on every client", async () => {
    const files = await tree(FP_TREES);
    expect(files.length).toBeGreaterThan(10);
    let clients = 0;
    for (const { file, code } of files) {
      expect(code, file).not.toMatch(/["'`](CIP_)?ANTHROPIC_API_KEY["'`]/);
      expect(code, file).not.toMatch(/process\.env\.(CIP_)?ANTHROPIC_API_KEY/);
      expect(code, file).not.toMatch(/CO_ANTHROPIC_API_KEY|readChangeOrderAnthropic/);
      const all = code.match(/new Anthropic\s*\(/g) ?? [];
      const explicit = code.match(/new Anthropic\s*\(\s*\{[^}]*\bapiKey\b/g) ?? [];
      expect(explicit.length, file).toBe(all.length);
      clients += all.length;
    }
    expect(clients).toBeGreaterThanOrEqual(1);
  });
});

describe("the web app gets the CIP key by Key Vault reference", () => {
  it("as CIP_ANTHROPIC_API_KEY from ANTHROPIC-API-KEY-CIP, behind enableCipWorker, never a plain value", async () => {
    const bicep = await readFile(path.join(root, "infra/main.bicep"), "utf8");
    expect(bicep).toMatch(
      /\.\.\.\(enableCipWorker\s*\?\s*\[\s*\{\s*name:\s*'anthropic-api-key-cip'\s*keyVaultUrl:\s*'\$\{keyVault\.properties\.vaultUri\}secrets\/ANTHROPIC-API-KEY-CIP'\s*identity:\s*identity\.id/,
    );
    expect(bicep).toMatch(/\.\.\.\(enableCipWorker\s*\?\s*\[\s*\{\s*name:\s*'CIP_ANTHROPIC_API_KEY'\s*secretRef:\s*'anthropic-api-key-cip'/);
    expect(bicep).not.toMatch(/name:\s*'CIP_ANTHROPIC_API_KEY'[\s\S]{0,80}value:/);
    // One env entry: the web app's. The worker job keeps reading it as ANTHROPIC_API_KEY.
    expect(bicep.match(/name:\s*'CIP_ANTHROPIC_API_KEY'/g)).toHaveLength(1);
    expect(bicep).not.toMatch(/FP_ANTHROPIC|fpAnthropic/);
  });
});
