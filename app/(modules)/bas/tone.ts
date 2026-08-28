import type { Tone } from "./health-client";

/**
 * How a semantic tone looks, in one place.
 *
 * Both BAS screens render tones and both used to carry their own copy of the
 * mapping. The tones encode facts about data loss, so two copies free to drift
 * is the wrong kind of duplication: a screen that quietly disagreed with the
 * other about what amber means would be worse than one that was simply ugly.
 *
 * The values come from the sampled logo palette. Semantic colour is deliberately
 * separate from the module accent - the module's cyan says "you are in Building
 * Automation" and appears on the header diamond, the active tab and the trend
 * line, but never on a tile. That is what stops a healthy teal tile reading as
 * merely module-coloured.
 *
 * Every ink value clears WCAG AA as text on its own tint. See the ink tier in
 * app/globals.css.
 */

export const tint = (token: string, percent: number) =>
  `color-mix(in srgb, var(${token}) ${percent}%, transparent)`;

/** Border and ground. */
export const TONE_STYLE: Record<Tone, React.CSSProperties> = {
  ok: { borderColor: tint("--phb-teal", 55), background: tint("--phb-teal", 12) },
  warn: {
    borderColor: tint("--phb-orange", 55),
    background: tint("--phb-orange", 12),
  },
  bad: {
    borderColor: tint("--phb-maroon", 40),
    background: tint("--phb-maroon", 8),
  },
  neutral: { borderColor: "var(--border)", background: "var(--surface)" },
};

/** The colour a number, a badge label or a stripe takes. */
export const TONE_INK: Record<Tone, string> = {
  ok: "var(--phb-teal-ink)",
  warn: "var(--phb-orange-ink)",
  bad: "var(--phb-maroon)",
  neutral: "var(--foreground)",
};

/**
 * The gradient wash behind a tile, in its own tone.
 *
 * Light enough to give the tile presence without becoming a filled area, which
 * the brief rules out for saturated colour. Neutral tiles get none at all, so a
 * count with no opinion attached does not look like a state.
 */
export const TONE_WASH: Record<Tone, React.CSSProperties> = {
  ok: { "--tile-wash": tint("--phb-teal", 16) } as React.CSSProperties,
  warn: { "--tile-wash": tint("--phb-orange", 16) } as React.CSSProperties,
  bad: { "--tile-wash": tint("--phb-maroon", 12) } as React.CSSProperties,
  neutral: {} as React.CSSProperties,
};
