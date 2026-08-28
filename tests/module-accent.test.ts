import { describe, expect, it } from "vitest";
import { moduleAccent } from "@/lib/module-accent";

/**
 * A module's colour is an identity, so the property that matters is stability:
 * the same key produces the same colour regardless of what else is on screen or
 * what order the modules table happens to be in.
 *
 * An earlier version derived it from position, which meant a sort-order change
 * silently repainted every module. These tests exist so that cannot come back.
 */

describe("the settled assignments", () => {
  it("gives Change Orders the red of the PH+B letters", () => {
    expect(moduleAccent("change-orders").fill).toBe("var(--phb-red)");
  });

  it("gives BAS the cyan of the lower-right quadrant", () => {
    expect(moduleAccent("bas").fill).toBe("var(--phb-cyan)");
  });

  it("pairs every fill with an ink that clears AA as text", () => {
    // The fill fills shapes; the ink carries glyphs. app/globals.css explains
    // why they cannot be the same value for anything but purple and maroon.
    expect(moduleAccent("change-orders").ink).toBe("var(--phb-red-ink)");
    expect(moduleAccent("bas").ink).toBe("var(--phb-cyan-ink)");
  });
});

describe("stability - the reason this is keyed rather than positional", () => {
  it("ignores the index entirely for an assigned module", () => {
    // Reordering the modules table must not repaint anything.
    for (const index of [0, 1, 2, 7, 40]) {
      expect(moduleAccent("change-orders", index).fill).toBe("var(--phb-red)");
      expect(moduleAccent("bas", index).fill).toBe("var(--phb-cyan)");
    }
  });

  it("does not swap the two when their order swaps", () => {
    const asListed = [moduleAccent("change-orders", 0), moduleAccent("bas", 1)];
    const reversed = [moduleAccent("bas", 0), moduleAccent("change-orders", 1)];

    expect(reversed[0]?.fill).toBe(asListed[1]?.fill);
    expect(reversed[1]?.fill).toBe(asListed[0]?.fill);
  });
});

describe("a module with no assignment", () => {
  it("still gets a colour rather than nothing", () => {
    const accent = moduleAccent("some-future-module", 0);

    expect(accent.fill).toMatch(/^var\(--phb-/);
    expect(accent.ink).toMatch(/^var\(--phb-/);
  });

  it("does not collide with a settled module until the palette runs out", () => {
    // Three unassigned modules, three colours, none of them the two that are spoken for.
    const taken = new Set(["var(--phb-red)", "var(--phb-cyan)"]);
    const given = [0, 1, 2].map((i) => moduleAccent(`future-${i}`, i).fill);

    for (const fill of given) expect(taken.has(fill)).toBe(false);
    expect(new Set(given).size).toBe(3);
  });

  it("wraps rather than returning undefined when the palette is exhausted", () => {
    const accent = moduleAccent("future", 99);

    expect(accent.fill).toMatch(/^var\(--phb-/);
  });

  it("is deterministic for the same key and index", () => {
    expect(moduleAccent("future", 2)).toEqual(moduleAccent("future", 2));
  });
});
