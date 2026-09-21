# BAS B5 — Analyze — verification record

**Date:** 2026-09-21. **Branch:** `feat/bas-analyze`. **Spec:** `docs/BAS-B5.md`.

This file says what was observed and what was not. Where a claim was inferred
rather than seen, it says so. It was written in two passes on the same day:
the first with an Anthropic key that was refused, the second with a working
one. The second pass found three faults the first could not, and they are
the most important part of this record.

---

## Automated criteria — all met

Run against the real test database (`phb_platform_test`, PostgreSQL 17.11)
through a throwaway copy of the `bas_analyze` role built from the exact
statements the production role is built from. The model is faked in every
automated test; nothing else is.

| Criterion | Where proved | Observed |
|---|---|---|
| Build, typecheck, lint clean; all existing tests pass | `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` | Full suite green (72 files); build clean with `/bas/analyze` in the route table. Final counts in the pull request |
| The query role cannot write — real database | `tests/bas-analyze-role.test.ts` | INSERT, UPDATE, DELETE, TRUNCATE, CREATE TABLE, `nextval()` all `42501 insufficient_privilege` **with `default_transaction_read_only = off`**, so the grant is what refused. `bas_orgs` count unchanged |
| The query role cannot read `employees` or `audit_events` | same | `42501` on every platform table and on `bas_station_credentials` |
| Multi-statement SQL is rejected | guard and role tests | Guard: `SELECT 1; SELECT 2` and `SELECT 1; -- comment` both refused. Database, guard bypassed: refused over the extended protocol. **Finding A** |
| A writing CTE is rejected | both | Guard names `DELETE`. Database, guard bypassed: `0A000` from the cursor itself. **Finding C** |
| Statement timeout enforced and tested | role test | `pg_sleep(5)` under 300 ms → `57014`, `timedOut: true` |
| Row cap enforced and tested | role test | 1000 rows, cap 200 → 200 rows, `truncated: true`; exactly 200 → not truncated |
| Zero rows renders differently from a zero result | service and UI tests | No rows → `no_data`, *No data matched*, amber, no `<td>`, summariser never called. One all-NULL row → `no_data`, shown as `NULL`. `avg = 0` → `answered`, `<td>0</td>`. Markup asserted different |
| Gap overlap computed by our code, with a query spanning a known gap | service test | 64 h gap inside the range + 48 h gap straddling its end, plan silent about gaps → **68 h**, second item clipped to 4 h. Widens on no declared points, on a non-existent id, **and on a declared period alone** (Finding D). `gaps: null` only when there is no period at all |
| Unauthenticated → 401; no BAS grant → 404 | route test | On GET and POST |
| Missing API key → clear not-configured state, not a crash | route and service tests | Names returned, never values; blank counts as missing |
| Every request logged with question, SQL, row count, duration | service test | One log line and one `bas.question_asked` audit row per question |
| Rate limiting works | service and route tests | Per employee, sliding window, refusals not counted, 429 `rate_limited` before any pool or model use |

---

## Manual criteria — run live, results verbatim

`npm run bas:analyze:verify` against the **development database**
(`phb_platform`: 19 `bas_*` objects, 39 points, real PHBoffice and Spring
Grove data) with the real `bas_analyze` role and `claude-opus-5`. Schema
context 47,926 characters. Audit rows attributed to msheth@phb1899.com.

### First pass — key refused (14:15 and 14:23 UTC)

Every question returned `cannot_answer` in about 0.1 s: Anthropic answered
`401 authentication_error: "API key is invalid."` The failure was itself an
honesty path and behaved — six questions, six `cannot_answer`, zero database
queries, six audit rows — and corrected two things: a 401 rendered as *could
not be reached* (the planner's own words now reach the screen), and the
script's placeholder viewer violating the audit foreign key (it now runs as
a real employee and says which).

### Second pass — working key (15:50 to 16:05 UTC)

**"What was the average room temperature last week?"** → `clarify`, 7.2 s.
*Which building's room temperature do you mean? … PHB Steel Place — the 10 VAV
zone temperature sensors … or PHB Spring Grove — the single "points_RoomT"
sensor (note Temp1/Temp2/Temp3 there are unclassified …). Also confirm "last
week" means the seven days ending now (2026-09-14T16:01Z to 2026-09-21T16:01Z)
rather than the previous Mon–Sun local week.*

The spec expected an answer here. The clarifying question is the right
answer over two buildings, and the spec's own sixth criterion asks for
exactly this behaviour on an ambiguous question. The numeric path is the next
question.

**"What was the average zone temperature at PHB Steel Place over the last 30
days?"** (added this day; see Finding F) → `answered`, 12.1 s.

*Across the 10 zone_temp points at PHB Steel Place, the average zone
temperature was 72.73 °F, ranging from 68.6 °F to 79.43 °F over 9,650
readings. However, stored readings only run from 2026-09-11T15:00Z to
2026-09-21T16:00Z, so the first 20 days of the 30-day period have no readings
at all and this figure describes only the covered ~10 days. No gaps were
found inside that covered span.*

Provenance (platform): range 2026-08-22T16:01:47Z to 2026-09-21T16:01:47Z;
scope declared, 10 VAV points; gaps 0 h in 0; unknown horizon 0; coverage
9,650 readings 2026-09-11T15:00Z to 2026-09-21T16:00Z; **coverage shortfall:
"The period asked about is only partly covered … the first 20 days of the
period has no readings at all. Any figure above describes 10 days of the 30
days asked about."**; unclassified excluded 9. One row.

**"What was the average value of the point called Humidity Setpoint Foo last
week?"** → `cannot_answer`, 5.2 s. *There is no point named "Humidity Setpoint
Foo" in the system. The 39 registered points … include no humidity point of
any kind …* Nothing was queried. ✔ never-collected point says so.

**"What was the average room temperature in March 2023?"** → `cannot_answer`,
10.4 s. *There is no room-temperature data for March 2023 … Collection had not
begun in March 2023, so the period cannot be answered …* ✔ period before
collection says so. (The model's claim about the earliest reading is the
model's; the platform did not query.)

**"Which air handling unit serves the room temperature sensor?"** → `clarify`,
10.1 s. *Which room temperature sensor do you mean? There are twelve zone_temp
points …*

Then, named: **"Which air handling unit serves the VAV-1 130-132_ZoneTemperature
sensor at PHB Steel Place?"** → `answered`, 29.3 s. *… assigned to equipment
VAV-1 (type: vav). That VAV's parent equipment is "RV", recorded as type rtu …
This comes solely from the parent-equipment link in bas_equipment, since no
point-link records exist to corroborate it.* One row: `VAV-1 / vav / RV / rtu`.

The spec expected "nothing has set them". On this database that is not true:
`bas_equipment` holds 11 rows and 26 points are assigned; only
`bas_point_links` is empty, and the answer said so. The criterion is
**not reachable on this data** and the honest answer was given instead.

**"How many hours of data gaps were recorded in the last 30 days, by
point?"** → `answered`, 14.3 s, 10 rows. Provenance: range declared; scope
**all_points** (the plan named no ids); **gaps 1,162.3 h in 32 gaps**, listed
by point with cause, all `roll_overwrite`; unknown horizon 0. ✔ — but see
Findings D and E for what the first two runs of this question showed.

**"What was the temperature?"** → `clarify`, 5.6 s. *Which temperature, and
over what period? …* ✔ ambiguous question asks rather than guesses.

**"The SQL shown actually matches what ran."** Inferred, not separately
observed: the SQL rendered is the guarded string that was passed to `DECLARE
… CURSOR FOR`, byte for byte, and the service test asserts the audit row's
`sql` equals it. There is no second string.

### What is still open

- The 64-hour gap the spec names is not in this window for the building the
  numeric question was asked about; the Spring Grove points carry the gaps
  (239 h each in 30 days). A "last week" question about Spring Grove would
  exercise the gap-beside-a-number case directly and was not asked.
- The verify script fails the run on either fault it knows (Findings D, E).
  It cannot fail on a fault it does not know.

---

## Findings

**A. `pg` used the simple protocol with an empty bind array.** With `values:
[]`, node-postgres 8.23 sends a simple Query and `DECLARE … FOR SELECT 1;
SELECT 2` ran both statements; the test that tried it resolved instead of
rejecting. `queryMode: "extended"` forces the Parse message. `pool.ts`,
runbook, WHY § 52.

**B. `REVOKE TEMP … FROM bas_analyze` does nothing.** TEMP is a PUBLIC grant.
Revoking from PUBLIC would change the collector. Statement and proof removed;
READ ONLY refuses `CREATE` (`25006`) and the test pins both halves.

**C. A writing CTE is refused by the cursor first** (`0A000`), before READ
ONLY or the grant. Any of the three is a refusal; the test accepts any and
asserts nothing changed.

**D. The widening rule keyed on the table, not the period.** Live: the gap
question reads `bas_data_gaps`, declared a range and no points, and got
*Scope: none, Gaps: NOT COMPUTED* beside a resolved range. A declared period
now widens on its own. Reported by the operator; pinned by a service test.

**E. The model wrote `now() - interval '30 days'` and declared no range.** The
prompt required one only when readings were read, so the fix for D never
engaged and the verify check did not fire. Now in code: a time expression
with no declared range is sent back once; if still missing the result carries
`periodUndeclared`, rendered *Period not stated* in amber, never *does not
apply*. On the next run the model declared the range first time.

**F. A 30-day average from ten days of readings.** 72.73 °F was correct about
ten days and labelled with thirty; only the model happened to mention it. No
recorded gap covers this — `bas_data_gaps` describes outages inside
collection, not collection never having reached back that far.
`coverageShortfall` compares the declared range with `min(ts)` / `max(ts)`
over the points in scope and renders on every answered result. The verify
script now asks this question on purpose, because a numeric answer over a
month is where the silence is dangerous rather than odd.

**G. `END` cannot be a refused keyword.** Every `CASE` needs it.

---

## Not done in this phase

- Production wiring: `ANTHROPIC_API_KEY` and `BAS_ASK_DATABASE_URL` are not in
  `infra/main.bicep`; the `bas_analyze` role does not exist on the Azure
  database.
- Per-site entitlement: the service refuses outright if `basSiteScope` ever
  returns a list. Written, untested (`docs/testing-blind-spots.md`).
- Server-side refusal fallbacks on the model call: considered, left out.
