# Testing blind spots

Claims the suite can only check by **reading source text**, because the database
cannot be put into the state that would prove them. A source-text assertion is
not coverage: it proves the code is written the way the claim needs, not that the
claim holds. Each entry says what the claim is, why it cannot be provoked, what is
actually asserted, and what would turn it into a real test.

This file is canonical. It began in the Claude Project; the repository copy
supersedes it.

---

## The station counting guard cannot be made to fire

**Recorded:** 17 September 2026, from B7.6. **Test:**
`tests/bas-settings-filters.test.ts` → *raises the alarm when rendered
disagrees with matched*.

**The claim.** When the Settings tree renders fewer stations than the
independent count says match the filter, the screen goes red and names the
shortfall.

**Why it cannot be provoked.** At the current schema the tree cannot lose a
station: `bas_stations.site_id` and `bas_sites.project_id` are both NOT NULL
with foreign keys, and a station whose building is missing from the hierarchy
still lands in `unassignedStations`, which `rendered` counts. There is no row
that Prisma will let a test insert which the tree then drops.

**What is asserted instead.** The rule lives in `settingsCountState`, a pure
function, and is tested with hand-built counts. That proves the rule; it does not
prove the tree ever produces mismatched counts, because it cannot. B8.2's points
guard has the same shape and the same gap, and closed half of it by stubbing the
count query so the service is seen to report the database's number.

**What would make it real.** Relaxing either NOT NULL, or adding a join to the
tree that is not one-to-one — which is exactly the change the guard exists to
catch. Until then the mutation record in the test files is the evidence: each
join made inner fails the tests, and that is what a guard is for.

---

## Org scoping of Collection Health, Point Explorer and the Settings tree

**Recorded:** 17 September 2026, from B7. **Test:** `tests/bas-cascade.test.ts`
(the `siteFilter(entitled` source-text assertion) and the same reasoning in
every BAS screen test.

**The claim.** An employee sees only the sites they are entitled to; a site
outside the entitlement is 404, indistinguishable from a site that does not
exist.

**Why it cannot be provoked.** `basSiteScope` returns `entitled: null` — every
employee holding the module sees every site — and the estate is one
organisation. No viewer outside an org can be constructed.

**What is asserted instead.** The queries compose `siteFilter(entitled, …)`,
read from `basSiteScope`, rather than inventing a predicate. Source text.

**What would make it real.** `bas_site_grant`, or any per-employee entitlement.
The day `basSiteScope` returns a list, seed two orgs and assert the 404 on every
screen, and delete this entry and the next.

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

---

## For B8.4: the label fallback must be tested with the label actually NULL

**Recorded:** 17 September 2026. **Not yet a test** — a note for the phase that
will need one.

**The state of the data.** `bas_stations.display_name` is NULL on both
stations. The Settings UI falls back to `niagara_station_name`, which is why
nobody has noticed that no station has ever been given a display name. Every
row the fallback has ever rendered took the fallback path.

**Why it matters for points.** B8.4 adds the same label-with-fallback pattern to
points: `label` wins when present, `display_name` (Niagara's) otherwise. Every
real point today has `label` NULL. A test that seeds a label and asserts it
shows proves the branch nobody is on. The test that matters seeds a point with
`label` NULL and a Niagara `display_name` set, and asserts the Niagara name
renders — and a second with both NULL, asserting the history name renders and
never an empty cell. `bas_points_label_not_blank` guarantees NULL is the only
spelling of "no label", so those two cases are the whole space.

**Also worth asserting then:** that search matches both the label and the
Niagara name for a point whose label is NULL, since that is every point.

## Analyze (B5): the model is faked in every automated test

`tests/bas-analyze-service.test.ts` drives every honesty path against the real
test database and a throwaway copy of the `bas_analyze` role, with the planner
replaced by a scripted one. The guard, the cursor, the READ ONLY transaction,
the provenance queries, the audit write and the log line are real. What the
suite therefore cannot see:

- whether `claude-opus-5` actually writes a `SELECT` that the guard accepts
  and the role can run, for the questions people ask;
- whether it declares the time range and point ids its SQL reads — the
  provenance is computed from those declarations, and a plan that names the
  wrong points produces a gap figure about the wrong points (the scope is
  widened to every point when it names none, or names one that does not exist,
  but a plausible wrong id is not detectable);
- whether the summary paragraph states only numbers that are in the rows.

The procedure for those is `npm run bas:analyze:verify`, and the record is
`docs/bas-b5-verification.md`. It was run to completion on 2026-09-21 once a
working key arrived, and it found three faults the scripted planner could
not — which is the point of this section: the fake planner always declared
its range and its points, and the real one did not. Each fault became a
platform rule with its own scripted test, so the suite now covers the
*shapes* that were seen; it still cannot see the next shape the model
produces. Re-run the script after any change to `planner.ts`.

One more, structural: `basSiteScope` returns `null` (every site) for everyone
today, and free-form SQL cannot be confined to a subset of sites. The service
refuses outright the day the scope becomes a list. That refusal is written but
untested, because nothing in the suite can make `basSiteScope` return a list
without mocking the module the service imports it from.

---

## An inclusive range end cannot be made to miscount

**Recorded:** 22 September 2026, from the custom date range. **Test:**
`tests/bas-custom-range.test.ts`.

**The claim.** A custom range is `ts >= from AND ts < to`, end exclusive, so a
reading stamped exactly at the next day's midnight belongs to the next day.

**Why it cannot be provoked.** Every reading in the two fixture files sits a
few milliseconds past its minute (`14:20:00.028`), because that is when the
station wrote it. No row lands on a midnight boundary, so `ts <= to` and
`ts < to` agree on every count the tests make. The mutation was run and
nothing failed.

**What is asserted instead.** The resolved `range.to` instants themselves
(`2026-09-15T04:00:00.000Z` for an end date of 14 September; `04:00Z` after
the clock change where `05:00Z` was before it). That proves the bound the
query is built with; it does not prove the comparison operator.

**What would make it real.** A committed reading stamped exactly on a local
midnight. None exists in the live data, and a synthetic one would be the one
synthetic row in a fixture whose whole value is that it is not synthetic.
