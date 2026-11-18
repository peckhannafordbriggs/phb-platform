# BAS Reports, Phase 2 — the engine core, verified on the office and the lab

**Written 2026-11-10, on `feat/bas-reports-phase-2`.** This is the record of
what the report engine did against the real data, kept apart from what the
tests prove with synthetic series. Where a sentence says *observed*, the
value was read from a run's output or from the database; where it says
*inferred*, it is a conclusion drawn from more than one observation. The
plan is `docs/bas-reports-tab-plan.md` (Phase 2 under §F); the spec is
`docs/BAS Health Report Build Spec.md` (Jim, 27 October 2026); the build
record is `docs/09-bas-what-is-built.md` → *Reports — Phase 2*.

**The bar, as the task set it.** A run of the standard weekly preset on the
office building stores the run and its findings; the hydronic sections are
Not Applicable; the questions needing airflow, zone setpoints or compressor
roles are Not Monitored with the missing roles named; `points_RoomT` (flat
at −40 °F) appears under Data Health only, with no equipment finding; a
second run marks every finding Still open; a synthetic fixture produces a
known percent in band and known hours outside the schedule; a budget cap
produces a partial run.

---

## 1. What was run, and against what

**The data.** The local development database, a copy of the collector's
tables whose readings end on 2026-09-29 at about 13:10 UTC (*observed*:
`max(ts)` on `bas_readings`). The period for every run below is therefore
the last full week it holds: **2026-09-22T13:00Z to 2026-09-29T13:00Z**,
the `health_weekly` preset's seven-day window ending at the instant given
on the command line. Nothing was run against the Azure database.

**The definitions.** Three `health_weekly` reports were created through the
Phase 1 service (`createReport`, the same path the editor uses), one per
building: PHB Spring Grove (the lab, station `SpringGroveLabComputer`,
four points, no equipment rows), PHB Steel Place (the office, station
`PHBoffice`, 26 active points, eleven equipment rows: RV and ten VAVs) and
North Building (no stations). The owner recorded is a bootstrap admin's
employee row. The script that created them is not committed; the
definitions are two inserts anyone can repeat from the Reports editor.

**The command.** `npm run bas:report:run -- --definition <id> --period-end
2026-09-29T13:00:00Z --as <owner email>`, with `ANTHROPIC_API_KEY` set to
the BAS key in `.env.local`, so the narrative came from `claude-opus-5-5`
and the cost is the metered cost of real calls.

**The run numbering.** Office run 1 **failed** (*observed*: its row holds
`status = 'failed'` and the error `React is not defined`): `tsx` compiled
the template with the classic JSX transform. The fix is the
`@jsxRuntime automatic` pragma at the top of `render.tsx`, and nothing else
changed between run 1 and run 2. Office runs 2 and 3 and lab run 4 are the
evidence below.

---

## 2. The office building, run 2 then run 3

Run 2 was the first run that succeeded. Run 3 is the same definition and
the same period, run again. Run 3's output, verbatim from the script:

```
Run 3: succeeded
PHB Steel Place · 2026-09-22T13:00:00.000Z to 2026-09-29T13:00:00.000Z · last 7 days
Building status: Watch · new 0, still open 1, cleared 0
Equipment types found: economizer · 26 points, 11 equipment
Occupancy: PHBoffice: point (Occupied (occupancy status point))

  Space Comfort: not_monitored - The points this section needs are not trended, or not trended enough; see the inventory.
    Q3 not_monitored: missing active setpoint (or heating and cooling setpoints)
    Q4 not_monitored: missing active setpoint (or heating and cooling setpoints)
    Q5 not_monitored: missing override or priority status
  VAV: not_monitored - The points this section needs are not trended, or not trended enough; see the inventory.
    Q6 not_monitored: missing airflow; airflow setpoint
    Q7 not_monitored: missing damper position; active setpoint (or heating and cooling setpoints)
    Q8 not_applicable: no vav with reheat on this building
  AHU / RTU: not_monitored - The points this section needs are not trended, or not trended enough; see the inventory.
    Q9 not_monitored: missing fan status
    Q10 not_monitored: missing duct static (coverage 72%); fan status
    Q11 not_monitored: missing heating valve or heat stage; cooling valve or compressor status
    Q12 not_monitored: missing OA damper (coverage 72%); RAT
  Hot Water: not_applicable
    Q13 not_applicable: no hydronic heating on this building
  Chilled Water: not_applicable
    Q14 not_applicable: no hydronic cooling on this building
  DX Cooling and Heat: not_monitored - The points this section needs are not trended, or not trended enough; see the inventory.
    Q15 not_monitored: missing compressor status or stage command
    Q16 not_monitored: missing compressor status; RAT or MAT
    Q17 not_monitored: missing compressor status; OA damper (coverage 72%)
    Q18 not_monitored: missing heat stage status; RAT or MAT
  Schedules: not_monitored - The points this section needs are not trended, or not trended enough; see the inventory.
    Q19 not_monitored: missing fan or equipment status
  Data Health: watch - Data Health is on watch because VAV-8 104-105_ZoneTemperature has read exactly 70.5 °F for the full 7.0 days (672 readings) since 22 Sept, 09:00, far past the 6 h limit for a temperature that should move.
    Q20 answered: 26 points judged, 1 flagged
      [watch] VAV-8 104-105_ZoneTemperature - Flat-lined: exactly 70.5 °F for 7.0 days (672 readings); expected a value that moves; the threshold for temperature is 6 h; since 22 Sept, 09:00 (still_open)
        likely: Possibly the zone sensor has stopped updating, the point is overridden or held at a fixed value in the controller, or communication to VAV-8 has dropped and the BAS is showing a stale last value.
        next: At the BAS workstation, check whether VAV-8 104-105_ZoneTemperature is in override or out of service and whether the VAV-8 controller is online and reporting other live values; if both look normal, have someone compare the reading against a handheld thermometer in room 104-105.

Cost: 1 call(s), 1353 in / 289 out, $0.0073 of $2.00
```

Run 2 differed in one line (*observed* at the time, not captured verbatim):
`Building status: Watch · new 1, still open 0, cleared 0`, and the finding
was marked `(new)`. Its cost was the same to the cent.

**Against the bar:**

| The bar | Observed |
|---|---|
| The run and its findings are stored | Rows in `bas_report_runs` (status `succeeded`, `report_json`, `report_html`, cost and tokens) and one row in `bas_report_findings` per run, fingerprint `sha256("q20_data_health\|point:<id>\|flat")` |
| Hydronic sections Not Applicable | Q13 and Q14: *no hydronic heating / cooling on this building*. Decided from equipment type: no boiler, chiller or plant row, and no water-side role on any point |
| Airflow, zone setpoints, compressor roles → Not Monitored, roles named | Q6 *airflow; airflow setpoint*; Q3/Q4/Q7 *active setpoint (or heating and cooling setpoints)*; Q15–Q17 *compressor status or stage command*; Q9/Q19 *fan status*. Fourteen questions Not Monitored, three Not Applicable, one answered |
| The flat point under Data Health only | VAV-8's zone temperature is the one finding, under Q20; Space Comfort has no finding and shows VAV-8 as skipped with the reason *missing space temp* (the excluded sensor), inside the section's own Not Monitored outcome |
| Second run marks the finding Still open | Run 3: `new 0, still open 1`, the finding `(still_open)`, `first_seen_run_id` = run 2 (*observed* on the findings row) |

**What the office cannot show** (*inferred* from the inventory): no
setpoint, no airflow, no fan status, no compressor or stage point is
trended on the office JACE, so none of Q3–Q19 can run there. The sections
that *could* run with those points are Phase 5's analyses; the one partial
reason for "could run but has no analysis yet" never fired on either
building and is exercised only by the code path, not by a live run.

### The one thing the first live run found

Run 2, in its first form, listed `duct static` and `OA damper` as **missing**
with coverage 72 % although both points are trended. *Observed*: the
office's static-pressure and damper points declare `collection_interval_s
= 900` and hold 1,454 readings for the week — more than a 15-minute
trend can produce (672) — with one silence of about 47 hours while the
damper did not move. They log on change despite the declared interval, and
the interval-based coverage rule read the silence as a hole.

The rule now (`scope.ts`, `COV_LIKE_FACTOR = 1.5`): a point with more
readings in the period than its declared interval allows, by that factor,
is treated as change-of-value everywhere downstream - its coverage is the
period minus the collector's recorded gaps, its value holds without bound,
and it is never offline or stale for keeping quiet. The two points now
read 100 % (*observed* on a later run) and the questions that need them
remain Not Monitored for the roles they genuinely lack. The label
*(coverage 72 %)* stayed as the way a shortfall is said: present but under
the spec's 80 %, as distinct from absent.

---

## 3. The lab, run 4

Verbatim:

```
Run 4: succeeded
PHB Spring Grove · 2026-09-22T13:00:00.000Z to 2026-09-29T13:00:00.000Z · last 7 days
Building status: Watch · new 1, still open 0, cleared 0
Equipment types found: none · 4 points, 0 equipment
Occupancy: SpringGroveLabComputer: none (no occupancy point trended and no occupied hours entered for the building)

  Space Comfort: not_monitored - The points this section needs are not trended, or not trended enough; see the inventory.
    Q3 not_monitored: missing space temp; active setpoint (or heating and cooling setpoints); occupancy
    Q4 not_monitored: missing space temp; active setpoint (or heating and cooling setpoints); occupancy
    Q5 not_monitored: missing override or priority status
  VAV: not_applicable
    Q6 not_applicable: no vav on this building
    Q7 not_applicable: no vav on this building
    Q8 not_applicable: no vav with reheat on this building
  AHU / RTU: not_applicable
    Q9 not_applicable: no ahu, rtu on this building
    Q10 not_applicable: no ahu, rtu on this building
    Q11 not_applicable: no ahu, rtu on this building
    Q12 not_applicable: no ahu, rtu with economizer on this building
  Hot Water: not_applicable
    Q13 not_applicable: no hydronic heating on this building
  Chilled Water: not_applicable
    Q14 not_applicable: no hydronic cooling on this building
  DX Cooling and Heat: not_applicable
    Q15 not_applicable: no dx on this building
    Q16 not_applicable: no dx on this building
    Q17 not_applicable: no dx with economizer on this building
    Q18 not_applicable: no gas or electric heat on this building
  Schedules: not_monitored - The points this section needs are not trended, or not trended enough; see the inventory.
    Q19 not_monitored: missing fan or equipment status; occupancy schedule
  Data Health: watch - Data Health is on watch because points_RoomT has read -40 °F, well outside the expected 35 °F to 110 °F range for a room or return air temperature, for 100% of samples over 5.0 days.
    Q20 answered: 4 points judged, 1 flagged
      [watch] points_RoomT - Out of physical range: read -40 °F; expected a room or return air temperature between 35 °F and 110 °F; 14:00-16:00 (new)
        likely: Likely a sensor or wiring fault, such as an open circuit or disconnected sensor, since a steady -40 °F is a common default reading when a temperature input loses its signal.
        next: Pull up points_RoomT at the BAS workstation and check the raw input value, its input type and scaling, and whether the point is overridden. If it still reads -40 °F, send someone to check the sensor and its wiring at the controller terminals.

Cost: 1 call(s), 1319 in / 252 out, $0.0064 of $2.00
```

`points_RoomT` is the lab's dead sensor, the same one the plausibility check
flagged on 2026-09-28. Here it is caught by the **physical range** rule
(−40 °F against 35–110 °F for a room temperature) rather than the flatness
rule, and the finding carries the rule's expected range. The *5.0 days* is
the point's coverage of the week (*observed*: the lab's readings in that
week stop short of the period's end); the *when* of 14:00–16:00 is the
busiest two-hour window of the out-of-range time, which for a sensor that
is always wrong is simply the first full window the profile finds - true,
and not informative. A later phase may suppress the time-of-day for a
finding that spans the whole period.

The lab has no equipment rows, so every equipment section is Not Applicable
and the room sensor belongs to no unit; Space Comfort is Not Monitored for
the roles it lacks (space temp is *missing* here because the one zone
temperature was excluded by Data Health before the inventory ran, which is
the rule - a flagged point is not offered to any equipment question).
Occupancy: *none*, said in words, because the lab has no occupancy point
and nobody has entered occupied hours for it.

---

## 4. What the tests prove with synthetic series

Three new files, 41 tests, green on 2026-11-10 (`npm test -- <file>`):

| File | Tests | What it holds |
|---|---|---|
| `tests/bas-reports-analysis.test.ts` | 26 | Series arithmetic (hold, cut by gaps, carry-in; the 25-hour clock-change day; the persistence rule; the busiest window); q03/q04 — a zone 4 °F over for 40 % of occupied hours is **60 % in band**, Watch, *14:00–16:00*, Action Needed at half the hours or five degrees, nothing under ten percent, unoccupied misses ignored, the heating/cooling pair when there is no single setpoint, an excluded point never judged; q19 — **6.5 h on 2 days** outside a weekday 08:00–18:00 schedule, Watch, Action Needed past twenty hours, nothing for a fan that follows the schedule; q05 — an override held long enough with *since when*, a five-minute one ignored, one still on at the period's end *active and counting*; q20 — flat, out-of-range, offline and stale each flagged and excluded, a setpoint, a status and a change-of-value point never judged for flatness, the physical ranges by role and unit; the inventory — Step 1 classification, hydronic questions applying to nothing on a DX-only building, Not Applicable / Not Monitored / runnable with a coverage shortfall as a miss, a building-level role taken from the station; comparison — fingerprint on question, subject and issue only, New / Still open / Cleared with first-seen kept and Action Needed carried forward; the roll-up ignoring cleared, NA and NM; pricing from the usage counts |
| `tests/bas-reports-render.test.tsx` | 7 | The template's order (inventory, summary, sections, Data Health, carried forward); a Not Applicable section dropped, Not Monitored listed with the missing points, low coverage named; every finding marked New / Still open / Cleared and the carry-forward with its first-seen date; every number read from the evidence and the model's two sentences in their own columns; the standalone page from the same component; the narrative prompt's voice rules; the data block and the index matching of replies to findings |
| `tests/bas-reports-engine.test.ts` | 8 | A synthetic building (RTU, two VAVs, an occupancy point, a weekday schedule) run end to end through `executeReportRun` against the real schema: the run and findings stored and every question decided; the flat zone a Data Health row and nothing else; the second run all Still open with first-seen kept; a fixed zone Cleared with the previous run's evidence; the **budget cap** → partial with the reason; no key → partial with the reason; the occupancy fallback (point → manual hours → none) and the Settings route that sets it, audited and admin-only; who sees a run (owner and module admin; another BAS user is told it does not exist); a report with runs cannot be deleted |

Changed in the existing suites: `tests/bas-schema.test.ts` (the two new
tables in the dictionary-view exclusion list, `report_html` and
`likely_cause` among the columns the model must never see),
`tests/db.ts` (the reset order), and the three gated role scripts' tests,
which run the real files against the real schema.

---

## 5. What this does not prove

- **No scheduler, no worker, no PDF, no email.** The dev script is the only
  trigger. A run under a job, under the budget *and time* caps, and a
  delivery are Phases 3 and 4.
- **Fifteen of the twenty analyses are not built** (Q6–Q18; Q1 and Q2 are
  derived). Their inventory decisions are real - the office shows them
  Not Monitored with the right roles named - and a question that *could*
  run on a better-trended building would make the run partial with
  *"Qn could run but has no analysis yet"*. That branch is not exercised
  live, because no local building can run any of them.
- **The hydronic Not Applicable decision was observed on a building with no
  plant**, which is the easy case. A building with a boiler row and no
  water-side point would read Not Monitored, by the rule; it has not been
  seen.
- **Occupancy from a trended point was observed once** (the office's
  `Occupied` point), from manual hours only in the test, and the Settings
  field that writes those hours has been used through the route and not
  by a person at the screen.
- **The narrative was read, not graded.** Two sections, two buildings. The
  prompt's rules are held by a test; the model's compliance with them is
  observed on these two outputs and nowhere else.
- **Cost at scale is not measured.** Two calls, under a cent each. A
  building that answers all nine sections would make nine.

---

## 6. Deviations from the plan, and why

| Plan | Built | Why |
|---|---|---|
| D1: `bas_report_runs` with `pdf`; `bas_report_deliveries` | Runs and findings only; `partial_reason` added; no `pdf` column, no deliveries table | The task scoped both to Phase 4. A `partial` status with no stored reason is a status a reader cannot act on |
| D3.3: hydronic / DX / heat classified from roles present | Hydronic from plant equipment types **or** water-side roles; DX from unit type (`rtu`, `split_system`, `crac`, `vrf_*`) **or** compressor roles; staged heat from the role | The office has an RTU with no compressor point trended. By roles alone it would be *Not Applicable* for DX, which is false: the unit exists and is unmonitored. Type decides whether a question applies; roles decide whether it is monitored |
| Findings keyed by `equipment_id` | `subject_key` (`equipment:<id>` or `point:<id>`) and `subject_name` beside a nullable `equipment_id` | A Data Health finding is about a point, and a lab point belongs to no equipment; the fingerprint has to name *something* stable |
| D3.5: overrides from the "override role the vocabulary has" | q05 reads `occupancy_override` only | It is the one override role in the 91; a per-point priority array is not trended by anything. The limit is on the question's outcome text and in the runbook |
| Coverage "at the point's measured interval" | Interval rule for interval points; recorded-gap rule for change-of-value points, **declared or detected** (`COV_LIKE_FACTOR`) | Section 2 above: two office points declare an interval and log on change |
| Narrative model | `claude-opus-5-5`, effort medium, one call per section | The Analyze planner's model is older; the narrative is prose in the `docs/11` voice and the newer model was chosen for it. The price table carries both |
| Generated view | Lists runs and opens one; no *Run now*, *History*, *Resend*, PDF | Phase 3 and 4 by the task's own scope |

---

## 7. Where the evidence is

- The runs: `bas_report_runs` rows 1–5 in the local development database
  (`report_json`, `report_html`, cost, tokens, `partial_reason`,
  `previous_run_id`), and `bas_report_findings` beneath them. Run 5 is the
  office again with the canned narrator (`--fixed-narrative`), made after
  `renderReportHtml` moved into `engine/html.ts` to confirm the script path;
  its finding is the same, *still open*, and its sentences are the fixture's.
- The outputs above, verbatim from the script.
- The audit rows: `bas.report_run_started` and `bas.report_run_finished`
  per run, the latter with the status, counts and cost; `bas.building_occupancy_updated` for the Settings field
  (test only).
- The log line per run: `event: "bas.report_run"`, `outcome`, `reason`.

---

## 8. The office inventory, traced, and the rendered report corrected (2026-11-12)

**Why.** The first production run of the office report (`fix/bas-report-rendering`)
read *Equipment types found: economizer* and *Required points found: 0 of 70*
for a building with one rooftop unit and ten VAVs whose zone temperatures
are trended, showed ten points offline since the same minute as ten rows,
and rolled the building up to Watch. The question was whether the lookup
was wrong or the points were.

### The trace, on the development database's office station

*Observed* (`bas_equipment`, `bas_points`, `bas_point_roles`, station 6,
site 7, 2026-11-12): eleven equipment rows - `RV` (`rtu`) and `VAV-1` to
`VAV-10` (`vav`, each a child of `RV`) - and 26 active points, every one
attached to a unit. The roles present:

| Unit | Points with a role | Points with no role |
|---|---|---|
| RV | `occupancy_cmd` (OccupancyCommand), `occupancy_status` (Occupied), `oa_damper_cmd`, `outside_air_temp`, `supply_fan_speed` (RV_Supply_Fan_Speed_Analog_Output), `ra_damper_cmd`, `duct_static_pressure`, `duct_static_pressure_sp`, `supply_air_temp` (Supply_Temp_Analog_Input), `supply_air_temp_sp` (Temperature_Setpoint) | OpState, OperatingState, OperatingStateOR, System_Enable, Unit Status, Unit_Status_Mode |
| VAV-1 … VAV-10 | one `zone_temp` each | none |

How the engine reads that (`inventory.ts`, `scope.ts`):

- **"Equipment types found: economizer"** came from `equipmentTypesFound`,
  which printed Jim's Step 1 words - hydronic / DX / staged heat /
  economizer, decided from the ROLES on the unit - under a heading that
  reads as the equipment list. RV carries `oa_damper_cmd` and no compressor
  or stage role, so the only Step 1 word was *economizer*. The line was
  true and labelled wrong. It now lists the types from
  `bas_equipment.equip_type` by count - *VAV Box × 10, Rooftop Unit × 1* -
  and a separate *Classification* line says *RV: DX (by type; compressors
  not trended) with economizer*.
- **"Required points found: 0 of 70"** counted question-and-unit checks:
  Q3 and Q4 over the ten VAVs with a zone temperature (20), Q5 over all
  eleven units (11), Q6 and Q7 over ten VAVs (20), Q9–Q12 and Q15–Q18 over
  RV (8), Q19 over eleven units (11) - 70, none met. The label now says so:
  *Required point checks met: 0 of 70 (one check per question per unit it
  applies to)*.
- **The role matching is right.** `checkRequirements` finds a role on the
  unit's own points (or, for `outside_air_temp` and `outside_air_humidity`,
  anywhere on the station), each requirement group met by any one of its
  alternatives. Checked by hand against the roles above, every Not
  Monitored decision follows: Q3/Q4 miss the zone setpoint on every VAV;
  Q9 has DAT and DAT setpoint on RV and misses `supply_fan_status`; Q19
  misses every status role; Q20 needs nothing and ran. The office's points
  lack the roles because the points are not trended, not because they are
  unassigned - the 32 names the JACE reports
  (`tests/fixtures/bas-office-classification.json`) hold no setpoint, no
  airflow, no fan status and no compressor point.

**What each question needs before it can run on the office** (*inferred*
from the library's required roles against the points above):

| Question | Has | Needs, and where it has to come from |
|---|---|---|
| Q3, Q4 zone comfort | `zone_temp` on each VAV; occupancy from `Occupied` | A zone setpoint on each VAV: a point with role `zone_temp_sp`, or both `zone_temp_cooling_sp` and `zone_temp_heating_sp`. **No setpoint history exists on the JACE**: the controls team adds the histories on the station, the collector discovers them, then Settings → Points assigns the role and the VAV |
| Q9 DAT holds setpoint | `supply_air_temp` and `supply_air_temp_sp` on RV | A point with role `supply_fan_status` on RV. The office trends the fan SPEED command, not a status; whether `System_Enable` (bool), `Unit Status` (enum, string values the engine cannot read) or `Unit_Status_Mode` (real) is a fan or unit status is a controls question - if one is, assign it in Settings → Points; if none is, a status history has to be added on the JACE |
| Q19 run outside schedule | occupancy from `Occupied` | Any one status role on a unit: `supply_fan_status`, `return_fan_status`, `exhaust_fan_status`, `pump_status`, `chiller_status`, `boiler_status`, `compressor_status`, `tower_fan_status` - the same fan status as Q9 would do |
| Q20 data health | everything | Nothing; it always runs and ran |

Nothing in Settings → Points alone makes Q3, Q4 or Q19 run today: the
points do not exist on the station. The spec forbids substituting (fan
speed for fan status, say), and the engine does not.

### Run 9 - the September week again, on the corrected page

The same period as runs 2, 3, 5 and 6, with the real narrator. Verbatim:

```
Run 9: succeeded
PHB Steel Place · 2026-09-22T13:00:00.000Z to 2026-09-29T13:00:00.000Z · last 7 days
Building status: Watch · new 1, still open 0, cleared 18
Equipment types found: VAV Box × 10, Rooftop Unit × 1 · 26 points, 11 equipment
Classification: RV: DX (by type; compressors not trended) with economizer
Required point checks met: 0 of 70 (one check per question per unit it applies to)
Occupancy: PHBoffice: point (Occupied (occupancy status point))

  Space Comfort: not_monitored - Not monitored — needs active setpoint (or heating and cooling setpoints); override or priority status; see Point Inventory.
    Q3 not_monitored: missing active setpoint (or heating and cooling setpoints)
    Q4 not_monitored: missing active setpoint (or heating and cooling setpoints)
    Q5 not_monitored: missing override or priority status
  VAV: not_monitored - Not monitored — needs airflow; airflow setpoint; damper position; active setpoint (or heating and cooling setpoints); see Point Inventory.
    Q6 not_monitored: missing airflow; airflow setpoint
    Q7 not_monitored: missing damper position; active setpoint (or heating and cooling setpoints)
    Q8 not_applicable: no vav with reheat on this building
  AHU / RTU: not_monitored - Not monitored — needs fan status; duct static (coverage 72%); heating valve or heat stage; cooling valve or compressor status; OA damper (coverage 72%); RAT; see Point Inventory.
    Q9 not_monitored: missing fan status
    Q10 not_monitored: missing duct static (coverage 72%); fan status
    Q11 not_monitored: missing heating valve or heat stage; cooling valve or compressor status
    Q12 not_monitored: missing OA damper (coverage 72%); RAT
  Hot Water: not_applicable
    Q13 not_applicable: no hydronic heating on this building
  Chilled Water: not_applicable
    Q14 not_applicable: no hydronic cooling on this building
  DX Cooling and Heat: not_monitored - Not monitored — needs compressor status or stage command; compressor status; RAT or MAT; OA damper (coverage 72%); heat stage status; see Point Inventory.
    Q15 not_monitored: missing compressor status or stage command
    Q16 not_monitored: missing compressor status; RAT or MAT
    Q17 not_monitored: missing compressor status; OA damper (coverage 72%)
    Q18 not_monitored: missing heat stage status; RAT or MAT
  Schedules: not_monitored - Not monitored — needs fan or equipment status; see Point Inventory.
    Q19 not_monitored: missing fan or equipment status
  Data Health: watch - Data Health is on watch because VAV-8 104-105_ZoneTemperature has read exactly 70.5 °F for the full 7.0 days since 22 Sept, 09:00, against a 6 h limit for a temperature to sit unchanged.
    Q20 answered: 26 points judged, 1 flagged
      [watch] VAV-8 104-105_ZoneTemperature - Flat-lined: exactly 70.5 °F for 7.0 days (672 readings); expected a value that moves; the threshold for temperature is 6 h; since 22 Sept, 09:00 (new)
        likely: Possibly the point is overridden or stuck at a fixed value in the controller, or the sensor or its wiring has stopped reporting a live reading, since a real zone temperature rarely holds exactly 70.5 °F for 672 readings in a row.
        next: From the BAS workstation, check whether VAV-8 104-105_ZoneTemperature is in override or out of service and compare it against the box's airflow and damper position to see if the zone is actually responding.
  Cleared: Outside_Air_Damper_Analog_Output1 (No readings), Outside_Air_Temp_Analog_Input1 (No readings), Return Air Damper (No readings), ROOM 107 (No readings), ROOM 130-132 (No readings), RV_Supply_Fan_Speed_Analog_Output (No readings), Supply_Duct_Static_Pressure_Analog_Input (No readings), Supply_Duct_Static_Pressure_Setpoint (No readings), Supply_Temp_Analog_Input (No readings), Temperature_Setpoint (No readings), VAV-2 122-125_ZoneTemperature (No readings), VAV-3 120-121_ZoneTemperature (No readings), VAV-4 114-115_ZoneTemperature (No readings), VAV-5 117-118_ZoneTemperature (No readings), VAV-6 113_ZoneTemperature (No readings), VAV-7 111-112_ZoneTemperature (No readings), VAV-8 104-105_ZoneTemperature (No readings), VAV-9 106_ZoneTemperature (No readings)

Cost: 1 call(s), 1529 in / 277 out, $0.0129 (safety ceiling $10.00); took 5 s
```

The eighteen *Cleared* rows are run 8's per-point "No readings" findings
(a period after the data stopped, before the incident grouping existed):
they do not recur in this period, so they clear - the one-time shift the
runbook names.

### Run 10 - the week after the data stopped: one incident, eighteen rows

The period 30 September to 7 October, which the development database has
no readings for. Verbatim:

```
Run 10: succeeded
PHB Steel Place · 2026-09-30T00:00:00.000Z to 2026-10-07T00:00:00.000Z · last 7 days
Building status: Watch · new 1, still open 0, cleared 1
Equipment types found: VAV Box × 10, Rooftop Unit × 1 · 26 points, 11 equipment
Classification: RV: DX (by type; compressors not trended) with economizer
Required point checks met: 0 of 70 (one check per question per unit it applies to)
Occupancy: PHBoffice: point (Occupied (occupancy status point))

  Space Comfort: not_monitored - Not monitored — needs space temp; active setpoint (or heating and cooling setpoints); override or priority status; see Point Inventory.
    Q3 not_monitored: missing space temp; active setpoint (or heating and cooling setpoints)
    Q4 not_monitored: missing space temp; active setpoint (or heating and cooling setpoints)
    Q5 not_monitored: missing override or priority status
  VAV: not_monitored - Not monitored — needs airflow; airflow setpoint; damper position; space temp; active setpoint (or heating and cooling setpoints); see Point Inventory.
    Q6 not_monitored: missing airflow; airflow setpoint
    Q7 not_monitored: missing damper position; space temp; active setpoint (or heating and cooling setpoints)
    Q8 not_applicable: no vav with reheat on this building
  AHU / RTU: not_monitored - Not monitored — needs DAT; DAT setpoint; fan status; duct static; static setpoint; heating valve or heat stage; cooling valve or compressor status; OA damper; OAT; RAT; see Point Inventory.
    Q9 not_monitored: missing DAT; DAT setpoint; fan status
    Q10 not_monitored: missing duct static; static setpoint; fan status
    Q11 not_monitored: missing heating valve or heat stage; cooling valve or compressor status
    Q12 not_monitored: missing OA damper; OAT; RAT
  Hot Water: not_applicable
    Q13 not_applicable: no hydronic heating on this building
  Chilled Water: not_applicable
    Q14 not_applicable: no hydronic cooling on this building
  DX Cooling and Heat: not_monitored - Not monitored — needs compressor status or stage command; compressor status; DAT; RAT or MAT; OAT; OA damper; heat stage status; see Point Inventory.
    Q15 not_monitored: missing compressor status or stage command
    Q16 not_monitored: missing compressor status; DAT; RAT or MAT
    Q17 not_monitored: missing compressor status; OAT; OA damper
    Q18 not_monitored: missing heat stage status; DAT; RAT or MAT
  Schedules: not_monitored - Not monitored — needs fan or equipment status; see Point Inventory.
    Q19 not_monitored: missing fan or equipment status
  Data Health: watch - Data Health is on watch because 18 points on the PHBoffice station stopped reporting together, with last readings on 29 Sept between 13:00 and 13:10, and nothing has come in for 7.3 days since.
    Q20 answered: 26 points judged, 1 flagged
      [watch] PHBoffice - Collection stopped: 18 points stopped reporting at the same time, last readings 29 Sept, 13:00-13:10; expected each point reporting at its interval; since 29 Sept, 13:00 (new)
          Outside_Air_Damper_Analog_Output1 - No readings: no readings in the period; last reading 29 Sept, 13:10
          Outside_Air_Temp_Analog_Input1 - No readings: no readings in the period; last reading 29 Sept, 13:00
          Return Air Damper - No readings: no readings in the period; last reading 29 Sept, 13:10
          ROOM 107 - No readings: no readings in the period; last reading 29 Sept, 13:00
          ROOM 130-132 - No readings: no readings in the period; last reading 29 Sept, 13:00
          RV_Supply_Fan_Speed_Analog_Output - No readings: no readings in the period; last reading 29 Sept, 13:10
          Supply_Duct_Static_Pressure_Analog_Input - No readings: no readings in the period; last reading 29 Sept, 13:10
          Supply_Duct_Static_Pressure_Setpoint - No readings: no readings in the period; last reading 29 Sept, 13:00
          Supply_Temp_Analog_Input - No readings: no readings in the period; last reading 29 Sept, 13:00
          Temperature_Setpoint - No readings: no readings in the period; last reading 29 Sept, 13:00
          VAV-2 122-125_ZoneTemperature - No readings: no readings in the period; last reading 29 Sept, 13:00
          VAV-3 120-121_ZoneTemperature - No readings: no readings in the period; last reading 29 Sept, 13:00
          VAV-4 114-115_ZoneTemperature - No readings: no readings in the period; last reading 29 Sept, 13:00
          VAV-5 117-118_ZoneTemperature - No readings: no readings in the period; last reading 29 Sept, 13:00
          VAV-6 113_ZoneTemperature - No readings: no readings in the period; last reading 29 Sept, 13:00
          VAV-7 111-112_ZoneTemperature - No readings: no readings in the period; last reading 29 Sept, 13:00
          VAV-8 104-105_ZoneTemperature - No readings: no readings in the period; last reading 29 Sept, 13:00
          VAV-9 106_ZoneTemperature - No readings: no readings in the period; last reading 29 Sept, 13:00
        likely: Likely the device network trunk from the JACE to its controllers is down, possibly the histories stopped on the station, or possibly the collector stopped pulling data, checked in that order.
        next: From the BAS workstation, open the PHBoffice station and check whether the controllers on the trunk from the JACE show online and are giving live values for points like Supply_Temp_Analog_Input and the VAV zone temperatures.
  Cleared: VAV-8 104-105_ZoneTemperature (Flat-lined)

Cost: 1 call(s), 4150 in / 249 out, $0.0170 (safety ceiling $10.00); took 6 s
```

*Observed*: one `bas_report_findings` row for the incident, subject
`station:6@2026-09-29T17:00Z`, with the eighteen points in its evidence,
plus one cleared row for VAV-8; `report_html` holds the incident block
above the Data Health table and eighteen rows below it; the narrative
named the three causes in the order asked and its recommended action is
the first of them. The building status is Watch, by the decision recorded
in `runbook.md` → *Data Health rolled up to Watch with half the building
offline*.

The rendered HTML of both runs is on the pull request.
