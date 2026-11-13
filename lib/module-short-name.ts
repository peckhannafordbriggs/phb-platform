/**
 * The short name a module wears where its full name will not fit: the chips
 * on the Admin Employees list (2026-11-13), where a person with fifteen
 * modules needs fifteen chips on a line or two.
 *
 * The same kind of table as lib/module-accent.ts, with the same argument for
 * keying it on the module key: a lookup with no authority. A key missing from
 * the table gets a name derived from the display name - the initials of a
 * multi-word name, the first three letters of a one-word name, so "Fleet"
 * and "Training" are FLE and TRA rather than two chips both reading T - and
 * a module added tomorrow has a chip without anyone touching this file. A
 * wrong short name is cosmetic: the chip carries the full name as its
 * tooltip and accessible name either way.
 *
 * A Map rather than an object literal, for the reason the accent table gives:
 * `lookup[key]` finds `Object.prototype`'s members, and `modules.key` is free
 * text.
 */
const ASSIGNED: ReadonlyMap<string, string> = new Map([
  ["change-orders", "CO"],
  ["bas", "BAS"],
  ["cost-intelligence", "CI"],
  ["knowledge-base", "KB"],
  ["freeze-protection", "FP"],
]);

export function moduleShortName(moduleKey: string, displayName: string): string {
  const assigned = ASSIGNED.get(moduleKey);
  if (assigned !== undefined) return assigned;

  const words = displayName
    .split(/[\s\-_/]+/)
    .map((word) => word.replace(/[^A-Za-z0-9]/g, ""))
    .filter((word) => word.length > 0);

  const short =
    words.length === 1
      ? words[0]!.slice(0, 3)
      : words
          .map((word) => word.charAt(0))
          .join("")
          .slice(0, 3);

  return (short.length > 0 ? short : moduleKey.slice(0, 3)).toUpperCase();
}
