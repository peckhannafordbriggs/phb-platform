# Testing blind spots

Claims the suite can only check by **reading source text**, because the database
cannot be put into the state that would prove them. A source-text assertion is
not coverage: it proves the code is written the way the claim needs, not that the
claim holds. Each entry says what the claim is, why it cannot be provoked, what is
actually asserted, and what would turn it into a real test.

This file mirrors `claude/testing-blind-spots.md` in the Claude Project, which
held two entries before this one. Those two belong here too; they have not been
copied because the agent that wrote this entry could not reach the Project.

---

## Org scoping of the Settings Points list

**Recorded:** 17 September 2026, B8.2. **Test:**
`tests/bas-settings-points.test.ts` → *scopes the station lookup through the
shared entitlement (source text)*.

**The claim.** A point is never returned to someone outside its organisation.
`GET /api/modules/bas/settings/stations/{id}/points` answers 404 for a station
outside the viewer's entitlement, indistinguishable from a station that does not
exist.

**Why it cannot be provoked.** `basSiteScope` in `lib/modules/bas/service.ts`
returns `entitled: null` for every viewer — everyone holding the module sees every
site. The estate is one organisation. No viewer can be constructed who is outside
an org, so a test that seeded two orgs and asserted a 404 would pass whether or
not the query scoped anything: the 404 would never be reached, and the 200 it got
instead would be correct under the current rule.

**What is asserted instead.** The body of `getStationPoints` in
`lib/modules/bas/settings-service.ts` contains `basSiteScope(viewer)` and applies
`entitlementSql(entitled, …)` to the station lookup, and that lookup appears
before any read of `bas_points`. `entitlementSql` is the same function the
Settings tree composes, so the two cannot scope differently.

**What would make it real.** The day `bas_site_grant` (or any per-employee
entitlement) exists and `basSiteScope` returns a list: seed two orgs, grant a
viewer one of them, and assert the other org's station returns
`station_not_found` from the service and 404 from the route, with a body that
names nothing. The same day, the equivalent assertions for the tree
(`getBasSettingsTree`), Collection Health and Point Explorer stop being blind
spots too, and this entry should be deleted rather than kept as history.
