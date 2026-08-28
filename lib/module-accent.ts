/**
 * Which quadrant colour belongs to which module.
 *
 * The colour is an IDENTITY, not a decoration: it tells someone which system
 * they are in, and it appears in the sidebar's active diamond, the module header
 * and nowhere else. So it has to be stable. An earlier version derived it from
 * the module's position in the granted list, which meant reordering the modules
 * table silently reassigned every module's colour - Change Orders would go cyan
 * because somebody changed a sort order. An identity that moves is not one.
 *
 * Keyed on the module key instead. CLAUDE.md's rule that nothing may hardcode a
 * module key is about AUTHORIZATION - grants, guards, route access - where a
 * hardcoded key means a permission check that silently stops matching. A lookup
 * from key to colour carries no authority: a key missing from this table gets a
 * colour anyway, and a wrong colour is a cosmetic problem, not an access one.
 *
 * The positional fallback is what makes that true. A module added tomorrow with
 * no entry here still gets a distinct colour rather than rendering blank or
 * defaulting to the chrome purple and looking broken.
 */

export interface ModuleAccent {
  /** Fills a shape - the diamond, a rule. Never carries a glyph. */
  fill: string;
  /**
   * The same hue darkened to clear WCAG AA as text. See app/globals.css: only
   * purple and maroon pass unmodified, so everything else has an ink sibling.
   */
  ink: string;
}

/**
 * The quadrant colours, in the order the mark reads them, as CSS custom
 * property references so a palette change happens in one file.
 */
const PALETTE: readonly ModuleAccent[] = [
  { fill: "var(--phb-red)", ink: "var(--phb-red-ink)" },
  { fill: "var(--phb-cyan)", ink: "var(--phb-cyan-ink)" },
  { fill: "var(--phb-orange)", ink: "var(--phb-orange-ink)" },
  { fill: "var(--phb-teal)", ink: "var(--phb-teal-ink)" },
  { fill: "var(--phb-pink)", ink: "var(--phb-pink-ink)" },
];

/**
 * The assignments that are settled, from the design brief: Change Orders takes
 * the red of the PH+B letters, BAS takes the cyan of the lower-right quadrant.
 *
 * Values are indices into PALETTE rather than colours, so a module cannot be
 * given a colour that is not one of the mark's own.
 */
const ASSIGNED: Readonly<Record<string, number>> = {
  "change-orders": 0,
  bas: 1,
};

/**
 * `index` is the module's position in whatever list is being rendered, used
 * only when the key has no assignment. Passing it is optional; a module with no
 * assignment and no index gets the first colour, which is wrong but never blank.
 */
export function moduleAccent(moduleKey: string, index = 0): ModuleAccent {
  const assigned = ASSIGNED[moduleKey];

  if (assigned !== undefined) {
    return PALETTE[assigned] ?? PALETTE[0]!;
  }

  /**
   * Unassigned modules take colours from the end of the palette backwards, so a
   * new module cannot collide with a settled one until the palette is exhausted.
   * Reserved slots are skipped rather than overwritten.
   */
  const reserved = new Set(Object.values(ASSIGNED));
  const available = PALETTE.filter((_, i) => !reserved.has(i));
  const fallback = available[index % Math.max(available.length, 1)];

  return fallback ?? PALETTE[0]!;
}
