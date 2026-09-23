/**
 * Which modules have a settings screen a module admin can actually open.
 *
 * `is_module_admin` is a column on every grant and knows no module keys, which
 * is why the admin screen offered "Can change settings for Change Orders" — a
 * permission whose only effect would be to reach a page that does not exist.
 * This is the declaration that makes the offer honest.
 *
 * DECLARED IN CODE, NOT AS A COLUMN ON `modules`, and that is the decision worth
 * keeping. A row in `modules` is platform data; whether a settings page exists
 * is a fact about the repository, and PLATFORM-CONTEXT's own test — *who is the
 * authoritative owner of this information?* — answers "the code". A boolean in
 * Postgres is a claim about a file, and it stays true after someone deletes the
 * file. It would also need a migration and a re-seed to become true, and the
 * production seed has run once, by hand: the column would read `false` in
 * production and nowhere else until somebody remembered. A code table ships in
 * the same image as the page it describes and cannot drift that way.
 *
 * An href rather than a boolean, because a boolean cannot be checked against
 * anything. `tests/module-settings-surface.test.ts` asserts every href below
 * resolves to a real page file, which is what stops this table going stale.
 *
 * On CLAUDE.md's rule that nothing hardcodes a module key: that rule is about
 * AUTHORIZATION — grants, guards, route access — where a hardcoded key means a
 * check that silently stops matching. See the same reasoning in
 * lib/module-accent.ts. This table is consulted by a refusal, which is closer to
 * that line than a colour is, so the default is chosen to fail safe: a module
 * with no entry has no settings surface, which WITHHOLDS a permission rather
 * than granting one. A forgotten line can only under-permit.
 */

/**
 * Module key to the route its settings live at.
 *
 * A module declares itself with one line here, in the same pull request that
 * adds the page — the same extension point as `BAS_TABS` and the accent table.
 * The path is a real route, not a convention: nothing assumes `/<key>/settings`.
 *
 * A MAP RATHER THAN AN OBJECT LITERAL, and the reason is a permission check.
 * `lookup[key]` finds inherited members of `Object.prototype`, so a module keyed
 * `constructor`, `toString` or `valueOf` would have returned something truthy
 * and been handed the settings permission — a guard that fails OPEN. No such
 * key exists today, which is exactly why it was closed now rather than after one
 * does: `modules.key` is a free-text primary key and nothing rejects those
 * strings.
 *
 * `Map.get` has no prototype chain to fall through, so the failure mode is
 * structurally absent rather than guarded against. An `Object.hasOwn` check
 * would work as well at this one call site and would have to be remembered at
 * the next one; this cannot be forgotten. Pinned by
 * `tests/module-settings-surface.test.ts` with those key names, including end to
 * end through `setModuleAdmin`.
 */
export const MODULE_SETTINGS_SURFACES: ReadonlyMap<string, string> = new Map([
  ["bas", "/bas/settings"],
  ["cost-intelligence", "/cost-intelligence/settings"],
]);

/**
 * Where this module's settings live, or null if it has none.
 *
 * Null is the ordinary answer for most modules, not an error: Change Orders is
 * configured in Exchange and in the Power Automate flows, and has nothing the
 * platform could offer a module admin.
 */
export function moduleSettingsHref(moduleKey: string): string | null {
  return MODULE_SETTINGS_SURFACES.get(moduleKey) ?? null;
}

/**
 * Whether module-admin rights over this module would mean anything.
 *
 * Read by `setModuleAdmin` before it will set the flag, and by the admin screen
 * before it offers the checkbox. Both call this rather than testing the map, so
 * there is one answer to the question.
 */
export function hasSettingsSurface(moduleKey: string): boolean {
  return moduleSettingsHref(moduleKey) !== null;
}
