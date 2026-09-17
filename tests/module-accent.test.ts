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

  it("gives the Knowledge Base pink, the same colour at any index", () => {
    expect(moduleAccent("knowledge-base").fill).toBe("var(--phb-pink)");
    expect(moduleAccent("knowledge-base", 2).fill).toBe("var(--phb-pink)");
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
    // Three of five slots are assigned, so two are free. At one free slot the
    // palette is exhausted and the next module has to be assigned by hand.
    const taken = new Set([
      "var(--phb-red)",
      "var(--phb-cyan)",
      "var(--phb-pink)",
    ]);
    const given = [0, 1, 2].map((i) => moduleAccent(`future-${i}`, i).fill);

    for (const fill of given) expect(taken.has(fill)).toBe(false);
    expect(new Set(given).size).toBe(2);
  });

  it("wraps rather than returning undefined when the palette is exhausted", () => {
    const accent = moduleAccent("future", 99);

    expect(accent.fill).toMatch(/^var\(--phb-/);
  });

  it("is deterministic for the same key and index", () => {
    expect(moduleAccent("future", 2)).toEqual(moduleAccent("future", 2));
  });
});

/**
 * The same prototype hole as lib/module-settings.ts, found in the same review.
 *
 * With an object literal, `ASSIGNED["constructor"]` returned a function rather
 * than undefined, so the assigned branch was taken with a function where an
 * index belongs; `PALETTE[fn]` is undefined and the `?? PALETTE[0]` fallback
 * caught it. Safe, but by accident, and wrong: the module silently wore Change
 * Orders' red — the collision the positional fallback exists to prevent.
 *
 * `modules.key` is a free-text primary key, so these are writable keys.
 */
describe("keys that are members of Object.prototype", () => {
  const PROTOTYPE_KEYS = [
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "__proto__",
    "isPrototypeOf",
  ];

  it("does not hand them a settled module's colour", () => {
    const settled = new Set(["var(--phb-red)", "var(--phb-cyan)"]);

    for (const key of PROTOTYPE_KEYS) {
      expect(settled.has(moduleAccent(key, 0).fill), key).toBe(false);
    }
  });

  it("gives them a real colour from the palette", () => {
    for (const key of PROTOTYPE_KEYS) {
      const accent = moduleAccent(key, 0);

      expect(accent.fill, key).toMatch(/^var\(--phb-/);
      expect(accent.ink, key).toMatch(/^var\(--phb-/);
    }
  });

  it("treats them as unassigned, so the index still separates them", () => {
    // An assigned module ignores the index; an unassigned one does not. This is
    // what proves the lookup missed rather than matched.
    const first = moduleAccent("constructor", 0).fill;
    const second = moduleAccent("constructor", 1).fill;

    expect(first).not.toBe(second);
  });
});
