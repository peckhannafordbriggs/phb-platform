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
 *
 * A Map rather than an object literal, for the same reason as
 * lib/module-settings.ts: `lookup[key]` finds inherited members of
 * `Object.prototype`, so a module keyed `constructor` or `toString` took the
 * assigned branch below with a function where an index should be, and fell
 * through to PALETTE[0] — silently wearing Change Orders' red, the one outcome
 * the positional fallback exists to prevent. `modules.key` is a free-text
 * primary key, so those keys are writable.
 *
 * Nothing here carries authority and a wrong colour is cosmetic, which is why
 * this was safe by accident rather than broken. Closed anyway: safe by accident
 * is one refactor away from unsafe, and the fallback that makes it safe is the
 * very line a tidy-up would remove.
 */
const ASSIGNED: ReadonlyMap<string, number> = new Map([
  ["change-orders", 0],
  ["bas", 1],
  // Assigned rather than left to the fallback: the sidebar passes a list index
  // and the module header passes none, so an unassigned key gets two different
  // colours in the two places that have to agree.
  ["cost-intelligence", 3],
  ["knowledge-base", 4],
]);

/**
 * `index` is the module's position in whatever list is being rendered, used
 * only when the key has no assignment. Passing it is optional; a module with no
 * assignment and no index gets the first colour, which is wrong but never blank.
 */
export function moduleAccent(moduleKey: string, index = 0): ModuleAccent {
  const assigned = ASSIGNED.get(moduleKey);

  if (assigned !== undefined) {
    return PALETTE[assigned] ?? PALETTE[0]!;
  }

  /**
   * Unassigned modules take colours from the end of the palette backwards, so a
   * new module cannot collide with a settled one until the palette is exhausted.
   * Reserved slots are skipped rather than overwritten.
   */
  const reserved = new Set(ASSIGNED.values());
  const available = PALETTE.filter((_, i) => !reserved.has(i));
  const fallback = available[index % Math.max(available.length, 1)];

  return fallback ?? PALETTE[0]!;
}

/**
 * The fills a DECORATIVE filled card may take, in order (2026-09-30).
 *
 * For the BAS Projects tab's cards, which are filled like Home's module
 * cards but are all the same module - so the colour cannot mean "which
 * system", and it is not allowed to mean anything else either. It is rhythm:
 * the same set of brand hues in the order the mark reads them, so a row of
 * projects looks like the logo rather than like a row of alarms.
 *
 * Every entry is an INK value, or purple, which clears AA unmodified: white
 * on each measures between 4.82 and 9.13, so full-white text is legible on
 * any of them (tests/bas-dashboard-colours.test.ts reads the tokens and
 * checks). Two brand colours are deliberately absent:
 *
 *   red     - Change Orders' identity on Home, and the one hue a person reads
 *             as an alarm without being told. A project card in it would say
 *             "something is wrong here" about a project that is fine.
 *   maroon  - the at-risk MARK's colour, everywhere. A card filled in it
 *             would be one large alarm mark with a project's name on it.
 *
 * Maroon against any of these fills measures under 2:1 (1.03 on purple), so
 * the mark on a filled card does not read by its colour at all. It reads by
 * its white edge and its white words - see .card-mark in app/globals.css -
 * which is the rule the brief states: colour is decorative, the mark and the
 * wording carry the state.
 */
export const DECORATIVE_CARD_FILLS: readonly string[] = [
  "var(--phb-cyan-ink)",
  "var(--phb-orange-ink)",
  "var(--phb-teal-ink)",
  "var(--phb-pink-ink)",
  "var(--phb-purple)",
  "var(--phb-gold-ink)",
];

/**
 * The fill for the n-th thing in a stable order. Wraps once the palette is
 * exhausted - a seventh project shares the first's colour, which is a
 * limitation of having six and not a fault: the colour never had to be
 * unique, because it never meant anything.
 */
export function decorativeCardFill(rank: number): string {
  const n = DECORATIVE_CARD_FILLS.length;
  const index = ((Math.trunc(rank) % n) + n) % n;
  return DECORATIVE_CARD_FILLS[index]!;
}

/**
 * The accent variables as an inline style, for any element that needs to open a
 * module's colour scope.
 *
 * ModuleHeader sets these on its own <header>, which is enough for the header
 * itself - but a module's page content sits outside that element, so a chart
 * line asking for `var(--module-accent)` would resolve to the platform default.
 * A shell that wraps its whole page in this gets one scope for both.
 */
export function moduleAccentStyle(moduleKey: string): React.CSSProperties {
  const accent = moduleAccent(moduleKey);

  return {
    "--module-accent": accent.fill,
    "--module-accent-ink": accent.ink,
  } as React.CSSProperties;
}
