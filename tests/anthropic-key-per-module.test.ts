import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_API_KEY_VAR,
  CO_ANTHROPIC_API_KEY_VAR,
  readAnthropicApiKey,
  readChangeOrderAnthropicApiKey,
} from "@/lib/env";
import { readAnalyzeEnv } from "@/lib/modules/bas/analyze/env";
import { readChangeOrderAnthropicEnv } from "@/lib/modules/change-orders/anthropic-env";

/**
 * Two modules, two Anthropic keys (2026-10-16). BAS Analyze reads
 * ANTHROPIC_API_KEY; Change Orders reads CO_ANTHROPIC_API_KEY. Neither reads
 * the other's and neither falls back to it, so the two are billed,
 * rate-limited and revoked independently.
 *
 * The trap this file exists for: ANTHROPIC_API_KEY is the Anthropic SDK's
 * DEFAULT variable name. `new Anthropic()` with no `apiKey` reads it on its
 * own, so a change-order client built the lazy way would quietly run on the
 * BAS key and nothing would error. Hence the source-text half below: every
 * client under either module names its key explicitly.
 */

const projectRoot = path.resolve(process.cwd());
const ROLE_URL = "postgresql://bas_analyze:pw@localhost:5432/phb_platform";

describe("the two modules read two different variables", () => {
  it("names them differently in lib/env.ts", () => {
    expect(ANTHROPIC_API_KEY_VAR).toBe("ANTHROPIC_API_KEY");
    expect(CO_ANTHROPIC_API_KEY_VAR).toBe("CO_ANTHROPIC_API_KEY");
    expect(CO_ANTHROPIC_API_KEY_VAR).not.toBe(ANTHROPIC_API_KEY_VAR);
  });

  it("BAS Analyze reads ANTHROPIC_API_KEY and ignores the Change Orders key", () => {
    // The CO key alone does not configure Analyze - it names its own variable.
    expect(
      readAnalyzeEnv({ CO_ANTHROPIC_API_KEY: "co-key", BAS_ASK_DATABASE_URL: ROLE_URL }),
    ).toEqual({ present: false, missing: ["ANTHROPIC_API_KEY"] });

    // With both set, Analyze gets its own value, never the CO one.
    const both = readAnalyzeEnv({
      ANTHROPIC_API_KEY: "bas-key",
      CO_ANTHROPIC_API_KEY: "co-key",
      BAS_ASK_DATABASE_URL: ROLE_URL,
    });
    expect(both.present).toBe(true);
    if (both.present) expect(both.values.apiKey).toBe("bas-key");
  });

  it("Change Orders reads CO_ANTHROPIC_API_KEY and never falls back to the BAS key", () => {
    // The BAS key alone does not configure Change Orders.
    expect(readChangeOrderAnthropicEnv({ ANTHROPIC_API_KEY: "bas-key" })).toEqual({
      present: false,
      missing: ["CO_ANTHROPIC_API_KEY"],
    });
    // A blank CO key beside a real BAS key is still absent - the mutation this
    // guards against is `?? env.ANTHROPIC_API_KEY`.
    expect(
      readChangeOrderAnthropicEnv({ ANTHROPIC_API_KEY: "bas-key", CO_ANTHROPIC_API_KEY: "  " }),
    ).toEqual({ present: false, missing: ["CO_ANTHROPIC_API_KEY"] });
    expect(readChangeOrderAnthropicEnv({})).toEqual({
      present: false,
      missing: ["CO_ANTHROPIC_API_KEY"],
    });

    // With both set, Change Orders gets its own value, trimmed.
    const both = readChangeOrderAnthropicEnv({
      ANTHROPIC_API_KEY: "bas-key",
      CO_ANTHROPIC_API_KEY: " co-key ",
    });
    expect(both).toEqual({ present: true, values: { apiKey: "co-key" } });
  });

  it("the process.env readers in lib/env.ts are independent of each other", () => {
    const saved = {
      bas: process.env.ANTHROPIC_API_KEY,
      co: process.env.CO_ANTHROPIC_API_KEY,
    };
    try {
      process.env.ANTHROPIC_API_KEY = "bas-key";
      delete process.env.CO_ANTHROPIC_API_KEY;
      expect(readAnthropicApiKey()).toBe("bas-key");
      expect(readChangeOrderAnthropicApiKey()).toBeNull();

      delete process.env.ANTHROPIC_API_KEY;
      process.env.CO_ANTHROPIC_API_KEY = "co-key";
      expect(readAnthropicApiKey()).toBeNull();
      expect(readChangeOrderAnthropicApiKey()).toBe("co-key");
    } finally {
      if (saved.bas === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved.bas;
      if (saved.co === undefined) delete process.env.CO_ANTHROPIC_API_KEY;
      else process.env.CO_ANTHROPIC_API_KEY = saved.co;
    }
  });
});

/**
 * Source-text guards. The runtime tests above prove the two readers; these
 * prove nothing ELSE under either module reaches across. They walk the real
 * trees, so a call site added later is held to the rule without anyone
 * remembering to extend this file.
 */
async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(path.join(projectRoot, dir), {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name))
    .map((e) => path.join(e.parentPath ?? e.path, e.name));
}

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const CHANGE_ORDER_TREES = ["lib/modules/change-orders", "app/(modules)/change-orders"];
const BAS_TREES = ["lib/modules/bas", "app/(modules)/bas"];

async function readTrees(trees: string[]): Promise<Array<{ file: string; code: string }>> {
  const out: Array<{ file: string; code: string }> = [];
  for (const tree of trees) {
    for (const file of await sourceFiles(tree)) {
      out.push({
        file: path.relative(projectRoot, file).replace(/\\/g, "/"),
        code: stripComments(await readFile(file, "utf8")),
      });
    }
  }
  return out;
}

describe("nothing under either module reads the other module's key", () => {
  it("walks real files - the trees are not empty", async () => {
    expect((await readTrees(CHANGE_ORDER_TREES)).length).toBeGreaterThan(10);
    expect((await readTrees(BAS_TREES)).length).toBeGreaterThan(10);
  });

  it("change-order code never names ANTHROPIC_API_KEY or the BAS readers", async () => {
    for (const { file, code } of await readTrees(CHANGE_ORDER_TREES)) {
      // The identifier and the literal, in any quoting; CO_ANTHROPIC_API_KEY
      // is allowed because the lookbehind excludes it.
      expect(code, file).not.toMatch(/(?<!CO_)ANTHROPIC_API_KEY/);
      expect(code, file).not.toMatch(/\breadAnthropicApiKey\b/);
      expect(code, file).not.toMatch(/\breadAnalyzeEnv\b/);
      expect(code, file).not.toMatch(/lib\/modules\/bas\/analyze/);
    }
  });

  it("BAS code never names CO_ANTHROPIC_API_KEY or the change-order reader", async () => {
    for (const { file, code } of await readTrees(BAS_TREES)) {
      expect(code, file).not.toMatch(/CO_ANTHROPIC_API_KEY/);
      expect(code, file).not.toMatch(/\breadChangeOrderAnthropic/);
      expect(code, file).not.toMatch(/change-orders\/anthropic-env/);
    }
  });

  it("every Anthropic client under either module names its key explicitly", async () => {
    // `new Anthropic()` and `new Anthropic({ timeout })` both read the SDK's
    // default ANTHROPIC_API_KEY on their own. Under Change Orders that is the
    // BAS key; under BAS it is a second, implicit route to the same key. Both
    // modules pass `apiKey` on every construction.
    let clients = 0;
    for (const { file, code } of await readTrees([...CHANGE_ORDER_TREES, ...BAS_TREES])) {
      const constructions = code.match(/new Anthropic\s*\(/g) ?? [];
      const explicit = code.match(/new Anthropic\s*\(\s*\{[^}]*\bapiKey\b/g) ?? [];
      expect(explicit.length, `${file}: every new Anthropic(...) must pass apiKey`).toBe(
        constructions.length,
      );
      clients += constructions.length;
    }
    // The BAS planner is one; the walk is not vacuous.
    expect(clients).toBeGreaterThanOrEqual(1);
  });
});
