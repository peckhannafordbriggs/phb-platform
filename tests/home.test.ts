import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { applyLoginGate } from "@/lib/auth/signin";
import { moduleAccent } from "@/lib/module-accent";
import {
  createEmployee,
  resetDb,
  seedChangeOrdersModule,
  testDb,
} from "./db";
import { TEST_ALLOWED_DOMAIN, TEST_TENANT_ID } from "./constants";

/**
 * Home's two silent-failure surfaces.
 *
 * Neither shows up in a typecheck, a lint run or a screenshot:
 *
 *   1. The previous sign-in. If `previousLoginAt` were written after
 *      `lastLoginAt` rather than from the value before it, every "since you
 *      last signed in" window would be zero seconds wide. The page would render
 *      perfectly and simply never have anything in it.
 *
 *   2. The filled cards' contrast. White on the sampled brights fails AA, and
 *      the failure is legible-looking text that measures 3.47:1. A person
 *      reviewing the screen cannot see the difference between 4.8 and 4.3.
 */

const claims = {
  tid: TEST_TENANT_ID,
  oid: "oid-home",
  email: `home@${TEST_ALLOWED_DOMAIN}`,
  preferred_username: `home@${TEST_ALLOWED_DOMAIN}`,
  given_name: "Home",
  family_name: "Person",
};

beforeEach(async () => {
  await resetDb();
  await seedChangeOrdersModule();
});

describe("the previous sign-in", () => {
  it("is null on a first sign-in, because there is no previous visit", async () => {
    await applyLoginGate(claims);

    const employee = await testDb.employee.findUnique({
      where: { entraOid: "oid-home" },
    });

    expect(employee?.lastLoginAt).toBeInstanceOf(Date);
    // Not "0", not the same instant as lastLoginAt - absent.
    expect(employee?.previousLoginAt).toBeNull();
  });

  it("carries the earlier sign-in across, rather than the one being written", async () => {
    await applyLoginGate(claims);
    const first = await testDb.employee.findUnique({
      where: { entraOid: "oid-home" },
    });
    const firstLogin = first?.lastLoginAt;
    expect(firstLogin).toBeInstanceOf(Date);

    // A real gap, so "carried the old value" and "wrote now() twice" cannot
    // both satisfy the assertion.
    await new Promise((resolve) => setTimeout(resolve, 25));
    await applyLoginGate(claims);

    const second = await testDb.employee.findUnique({
      where: { entraOid: "oid-home" },
    });

    expect(second?.previousLoginAt?.getTime()).toBe(firstLogin?.getTime());
    expect(second?.lastLoginAt?.getTime()).toBeGreaterThan(firstLogin!.getTime());
  });

  it("opens a window that is not empty - the whole point of the column", async () => {
    await applyLoginGate(claims);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await applyLoginGate(claims);

    const employee = await testDb.employee.findUnique({
      where: { entraOid: "oid-home" },
    });

    /**
     * The regression this guards. Using lastLoginAt would make `since` the
     * current sign-in, so the window would be negative or zero and every
     * "since you last signed in" list would be empty forever.
     */
    const since = employee!.previousLoginAt!;
    expect(Date.now() - since.getTime()).toBeGreaterThan(0);
    expect(since.getTime()).toBeLessThan(employee!.lastLoginAt!.getTime());
  });

  it("moves forward on each sign-in, never backwards", async () => {
    await applyLoginGate(claims);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await applyLoginGate(claims);
    const second = await testDb.employee.findUnique({
      where: { entraOid: "oid-home" },
    });

    await new Promise((resolve) => setTimeout(resolve, 15));
    await applyLoginGate(claims);
    const third = await testDb.employee.findUnique({
      where: { entraOid: "oid-home" },
    });

    expect(third!.previousLoginAt!.getTime()).toBeGreaterThan(
      second!.previousLoginAt!.getTime(),
    );
  });

  it("is null for a row that existed before the column, until its next sign-in", async () => {
    // A bootstrap row seeded ahead of its owner: no entraOid, never signed in.
    await createEmployee({
      email: `seeded@${TEST_ALLOWED_DOMAIN}`,
      entraOid: null,
      firstName: "Seeded",
      lastName: "Admin",
    });

    const before = await testDb.employee.findFirst({
      where: { email: `seeded@${TEST_ALLOWED_DOMAIN}` },
    });
    expect(before?.previousLoginAt).toBeNull();

    await applyLoginGate({
      ...claims,
      oid: "oid-seeded",
      email: `seeded@${TEST_ALLOWED_DOMAIN}`,
      preferred_username: `seeded@${TEST_ALLOWED_DOMAIN}`,
    });

    const after = await testDb.employee.findFirst({
      where: { email: `seeded@${TEST_ALLOWED_DOMAIN}` },
    });

    /**
     * Still null, and that is correct rather than a miss: the row had never
     * signed in, so there is genuinely no previous visit to carry across.
     */
    expect(after?.previousLoginAt).toBeNull();
    expect(after?.lastLoginAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------- contrast

const hex = (value: string): [number, number, number] => {
  const clean = value.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
};

const channel = (c: number): number => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};

const luminance = (rgb: [number, number, number]): number =>
  0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);

const contrast = (a: string, b: string): number => {
  const [l1, l2] = [luminance(hex(a)), luminance(hex(b))];
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
};

/** srgb mix, matching what color-mix(in srgb, X p%, transparent) paints over an opaque base. */
const mix = (top: string, base: string, t: number): string => {
  const [a, b] = [hex(top), hex(base)];
  const out = a.map((c, i) => Math.round(t * c + (1 - t) * b[i]!));
  return `#${out.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
};

const WHITE = "#ffffff";
const AA_SMALL = 4.5;

/** The tokens, read from the stylesheet rather than restated here. */
async function tokens(): Promise<Record<string, string>> {
  const css = await readFile(path.join(process.cwd(), "app/globals.css"), "utf8");
  const out: Record<string, string> = {};
  for (const [, name, value] of css.matchAll(
    /(--phb-[a-z-]+):\s*(#[0-9a-f]{6})/gi,
  )) {
    out[name!] = value!;
  }
  return out;
}

describe("the filled module cards", () => {
  it("fills with the ink value, because white on the brights fails AA", async () => {
    const t = await tokens();

    /**
     * The measurement that decided the fill. If these ever pass, the ink tier
     * has changed meaning and the cards should be revisited - not the other way
     * around.
     */
    expect(contrast(WHITE, t["--phb-red"]!)).toBeLessThan(AA_SMALL);
    expect(contrast(WHITE, t["--phb-cyan"]!)).toBeLessThan(AA_SMALL);

    expect(contrast(WHITE, t["--phb-red-ink"]!)).toBeGreaterThanOrEqual(AA_SMALL);
    expect(contrast(WHITE, t["--phb-cyan-ink"]!)).toBeGreaterThanOrEqual(AA_SMALL);
  });

  it("shades the card downward only, so the ink measurement is a floor", async () => {
    const css = await readFile(path.join(process.cwd(), "app/globals.css"), "utf8");
    const rule = css.match(/\.card--filled::after\s*\{[\s\S]*?\}/);
    expect(rule).not.toBeNull();

    const gradient = rule![0];

    /**
     * The rule this replaced mixed the card's own BRIGHT hue in at a measured
     * 15%, which was safe as authored and unsafe as shipped: the bundler emits
     * a no-color-mix fallback that drops the percentage and paints the bright
     * hue at full strength, putting both cards under AA (red 4.22, cyan 3.47)
     * on any engine taking that path.
     *
     * So the highlight may not lighten and may not depend on color-mix. A
     * gradient that only darkens keeps the plain ink as the lightest pixel on
     * the card, which is what makes 4.81 / 4.82 a floor at every point rather
     * than an average across one.
     */
    expect(gradient).not.toContain("color-mix");
    expect(gradient).not.toContain("--card-bright");
    expect(gradient).not.toMatch(/#fff|255\s+255\s+255|white/i);
    expect(gradient).toMatch(/rgb\(0 0 0/);
  });

  it("hands the card no bright value that could lighten it", async () => {
    const page = await readFile(
      path.join(process.cwd(), "app/(platform)/page.tsx"),
      "utf8",
    );
    const code = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

    // The fill is the ink; the bright hue never reaches the card.
    expect(code).toContain("--card-fill");
    expect(code).not.toContain("--card-bright");
    expect(code).toContain("accent.ink");
    expect(code).not.toContain("accent.fill");
  });

  it("uses each module's identity colour, and its ink for the fill", () => {
    // Red is Change Orders and cyan is BAS, as settled in lib/module-accent.ts.
    expect(moduleAccent("change-orders").fill).toBe("var(--phb-red)");
    expect(moduleAccent("change-orders").ink).toBe("var(--phb-red-ink)");
    expect(moduleAccent("bas").fill).toBe("var(--phb-cyan)");
    expect(moduleAccent("bas").ink).toBe("var(--phb-cyan-ink)");
  });

  it("puts no semantic tone on a card filled for identity", async () => {
    const page = await readFile(
      path.join(process.cwd(), "app/(platform)/page.tsx"),
      "utf8",
    );
    const code = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

    /**
     * teal, orange and maroon mean ok / warn / bad. A card filled in an identity
     * colour that also carried one of them would let the fill be read as a
     * state, which is exactly what makes a red card look like an alarm.
     */
    for (const tone of ["--phb-teal", "--phb-orange", "--phb-maroon"]) {
      expect(code).not.toContain(tone);
    }
  });
});

describe("the watermark", () => {
  it("stays under the opacity where muted text drops below AA", async () => {
    const css = await readFile(path.join(process.cwd(), "app/globals.css"), "utf8");
    const rule = css.match(/\.home-ground::before\s*\{[\s\S]*?\}/);
    expect(rule).not.toBeNull();

    const opacity = Number(rule![0].match(/opacity:\s*([\d.]+)/)![1]);

    /**
     * The bound is measured, not conventional: `--muted` over the darkest part
     * of the mark (#4A1896) over the darkest possible ground - all four washes
     * at full strength, which cannot physically co-occur.
     *
     * 0.06 is NOT asserted as a failure, deliberately. It measures 4.48 on
     * unrounded floats and 4.51 if the ground is rounded to 8-bit first, so it
     * sits inside the precision of the method and an assertion either way would
     * be testing the rounding rather than the design. 0.05 is the last value
     * that clears AA under both treatments, which is why it is the ceiling.
     */
    const GROUND = "#c2c7c9";
    const MARK = "#4a1896";
    const MUTED = "#53495f";

    expect(opacity).toBeLessThanOrEqual(0.05);
    expect(contrast(MUTED, mix(MARK, GROUND, opacity))).toBeGreaterThanOrEqual(
      AA_SMALL,
    );
    // The ceiling itself clears, so shipping anywhere at or under it is safe.
    expect(contrast(MUTED, mix(MARK, GROUND, 0.05))).toBeGreaterThanOrEqual(
      AA_SMALL,
    );
  });

  it("is painted as a background layer, so it cannot move anything", async () => {
    const css = await readFile(path.join(process.cwd(), "app/globals.css"), "utf8");
    const rule = css.match(/\.home-ground::before\s*\{[\s\S]*?\}/)![0];

    /**
     * An absolutely positioned pseudo-element at inset:0 fills the parent's
     * padding box exactly and a background-image is painted rather than laid
     * out, so no viewport width can produce a scrollbar from it. An <img> or a
     * sized block could.
     */
    expect(rule).toContain("position: absolute");
    expect(rule).toContain("inset: 0");
    expect(rule).toContain("background-image");
    expect(rule).toContain("pointer-events: none");
    expect(rule).not.toMatch(/\bwidth:/);
    expect(rule).not.toMatch(/\bheight:/);
  });

  it("uses the alpha-cut mark, not the logo with its white background", async () => {
    const css = await readFile(path.join(process.cwd(), "app/globals.css"), "utf8");
    const rule = css.match(/\.home-ground::before\s*\{[\s\S]*?\}/)![0];

    /**
     * public/phb-logo.png is a palette PNG with no alpha channel: 53% of it is
     * opaque white. Used here it would paint a white square over the four-light
     * ground instead of reading as atmosphere.
     */
    expect(rule).toContain("phb-logo-mark.png");
    expect(rule).not.toContain("phb-logo.png\"");
  });
});
