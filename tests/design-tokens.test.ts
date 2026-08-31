import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards for two font bugs that both failed silently and looked identical from
 * the outside: the platform renders in the wrong typeface while the font files
 * download perfectly, the @font-face rules are correct, and the config reads as
 * if everything is fine.
 *
 * They are worth a test rather than a comment because neither is visible in a
 * diff, in a typecheck, in a lint run, or in the build output. The only symptom
 * is "the text looks wrong", which is exactly the kind of thing a person notices
 * three commits later.
 */

const CSS = "app/globals.css";
const UI_ROOTS = ["app", "components"];

/**
 * The stylesheet with comments removed.
 *
 * Necessary rather than tidy: globals.css explains the self-reference bug by
 * quoting it, so a naive search finds the prose describing the problem and
 * reports it as the problem.
 */
async function declarations(): Promise<string> {
  const css = await readFile(path.join(process.cwd(), CSS), "utf8");
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

async function sourceFiles(root: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      // Generated Prisma output is not UI and is regenerated wholesale.
      if (entry.name === "generated" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) found.push(full);
    }
  }

  await walk(path.join(process.cwd(), root));
  return found;
}

describe("BUG 1: a font variable that references itself", () => {
  /**
   * `--font-display: var(--font-display)` is invalid at computed-value time, so
   * the property resolves to nothing and every `var(--font-display)` falls back.
   * It was introduced by declaring the families in `:root` AND again in
   * `@theme inline`, which is a natural-looking thing to do.
   */
  it("declares each family exactly once in globals.css", async () => {
    const css = await declarations();

    for (const name of ["--font-display", "--font-ui", "--font-mono"]) {
      const declarations = css.match(new RegExp(`^\\s*${name}:`, "gm")) ?? [];
      expect(declarations, `${name} must be declared exactly once`).toHaveLength(1);
    }
  });

  it("never declares a family as a reference to itself", async () => {
    const css = await declarations();

    for (const name of ["--font-display", "--font-ui", "--font-mono"]) {
      expect(css, `${name} must not reference itself`).not.toMatch(
        new RegExp(`${name}:\\s*var\\(${name}\\)`),
      );
    }
  });

  it("points each family at a next/font variable", async () => {
    const css = await declarations();

    // The chain that has to hold: utility -> semantic family -> next/font
    // variable -> @font-face. This asserts the middle link.
    expect(css).toMatch(/--font-display:\s*var\(--font-archivo\)/);
    expect(css).toMatch(/--font-ui:\s*var\(--font-figtree\)/);
    expect(css).toMatch(/--font-mono:\s*var\(--font-jetbrains-mono\)/);
  });
});

describe("BUG 2: the arbitrary font syntax generates no rule", () => {
  /**
   * `font-[family-name:var(--font-display)]` produces no CSS at all under this
   * Tailwind setup. The class lands on the element, nothing matches it, and the
   * element inherits the body font - so the wordmark silently rendered in the
   * body face while the markup looked correct.
   *
   * The families live in `@theme`, which generates `font-display`, `font-ui`
   * and `font-mono` as real utilities. Use those.
   */
  it("uses no font-[family-name:...] arbitrary values anywhere in the UI", async () => {
    for (const root of UI_ROOTS) {
      for (const file of await sourceFiles(root)) {
        const source = await readFile(file, "utf8");

        expect(
          source,
          `${file}: use the font-display / font-ui / font-mono utilities, not font-[family-name:...] - it generates nothing`,
        ).not.toMatch(/font-\[family-name/);
      }
    }
  });

  it("still finds the utilities in use, so the check is not vacuous", async () => {
    let seen = 0;
    for (const root of UI_ROOTS) {
      for (const file of await sourceFiles(root)) {
        const source = await readFile(file, "utf8");
        if (/\bfont-(display|ui|mono)\b/.test(source)) seen += 1;
      }
    }

    expect(seen).toBeGreaterThan(0);
  });
});

describe("the palette keeps its measured values", () => {
  /**
   * These two exist because a first instinct overrides both, and the reason is
   * a contrast measurement rather than a preference. See the note at the top of
   * globals.css.
   */
  it("keeps a button red distinct from the fill red", async () => {
    const css = await declarations();

    // White on --phb-red is 4.22, under AA, on the most important control in
    // the platform.
    expect(css).toMatch(/--phb-red-btn:/);
  });

  it("keeps a focus gold distinct from the fill gold", async () => {
    const css = await declarations();

    // The bright gold is 1.17 on a light surface and fails WCAG 2.2's 3:1 for
    // focus indicators.
    expect(css).toMatch(/--phb-gold-ring:/);
    expect(css).toMatch(/--focus:\s*var\(--phb-gold-ring\)/);
  });
});

describe("the dashboard ground stays readable", () => {
  /**
   * The tinted ground is the one background in the platform that is not a flat
   * token, so the contrast it produces cannot be read off a variable. These pin
   * the two things that were measured before it was built.
   */
  it("keeps the ground's base neutral, so the washes only ever lighten a grey", async () => {
    const css = await declarations();

    // A saturated base would make every composite unpredictable.
    expect(css).toMatch(/\.dashboard-ground\s*\{[^}]*background-color:\s*var\(--neutral-100\)/);
  });

  it("overrides the card edge on the tinted ground", async () => {
    const css = await declarations();

    /**
     * neutral-200 measures 1.00:1 against the purple region of the wash - the
     * border disappears rather than fading. Without this rule a card keeps its
     * edge in one corner of the page and loses it in another.
     */
    expect(css).toMatch(/\.dashboard-ground\s+\.card\s*\{/);
  });

  it("draws the washes from the quadrant colours and nothing else", async () => {
    const css = await declarations();
    const ground = /\.dashboard-ground\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? "";

    expect(ground).toContain("--phb-purple");
    expect(ground).toContain("--phb-cyan");
    expect(ground).toContain("--phb-orange");
    expect(ground).toContain("--phb-teal");

    // Not the semantic reds. The ground is atmosphere, not state.
    expect(ground).not.toContain("--phb-maroon");
    expect(ground).not.toContain("--phb-red");
  });
});
