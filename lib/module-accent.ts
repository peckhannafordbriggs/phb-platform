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
  // Knowledge Base takes pink, and being assigned at all matters more than
  // which colour it is: the fallback below is keyed on a module's position in
  // whatever list is being rendered, so an unassigned module gets one colour in
  // the sidebar (its index in the granted list) and a different one in its own
  // header, which calls moduleAccent with no index. Those two marks disagreeing
  // is exactly what this file exists to prevent.
  //
  // Pink rather than orange or teal because this palette says warn in orange and
  // ok in teal. Identity and state are disjoint sets - see .card--tinted in
  // app/globals.css - and pink is in neither.
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
