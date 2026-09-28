# BAS value plausibility — verification record

**Date:** 2026-09-28. **Branch:** `feat/bas-value-plausibility`. **Rule:**
`lib/modules/bas/plausibility.ts`. **Runbook:** *Collection Health says a
value has stopped changing*. **Reasoning:** `WHY-ITS-BUILT-THIS-WAY.md` § 55.

This file says what was observed against the live development database
(`phb_platform`, PostgreSQL 17.11: 39 points, 82,478 readings, real PHBoffice
and Spring Grove data) and what was proved by fixture. Where a figure was
measured it says how; where a claim is inferred it says so.

---

## The acceptance test, both halves — PASS on the first run

`npm run bas:plausibility:verify`, 2026-09-28 13:27 UTC, output verbatim
apart from the table being trimmed to the judged rows. The script runs the
same `plausibilityLateral` SQL the service runs, judges every active point
with the same `judgePlausibility`, and compares reading and active-point
counts before and after.

```
Thresholds: temperature 6 h, humidity 6 h, pressure 3 h, flow 6 h, concentration 6 h,
position 168 h, speed 168 h, current 24 h, power 24 h, voltage 24 h, ratio 24 h,
energy 168 h, volume 168 h, time 168 h, count 168 h. Minimum readings 12. Lookback 90 days.
Active points: 30. Query round trip: 15.1 ms.
```

| Station | Point | Role | Kind | Verdict | Flat | Value | Last different | Readings |
|---|---|---|---|---|---|---|---|---|
| PHBoffice | OccupancyCommand | occupancy_cmd | status | not checked, state | — | — | — | — |
| PHBoffice | Occupied | occupancy_status | status | not checked, state | — | — | — | — |
| PHBoffice | OperatingState, OperatingStateOR, OpState, System_Enable, Unit$20Status, Unit_Status_Mode | — | — | not checked, no role | — | — | — | — |
| PHBoffice | Outside_Air_Damper_Analog_Output1 | oa_damper_cmd | position | changing | 0.4 h of 7.0 d | 10 percent | 08:55 today (93.7) | 6 |
| PHBoffice | Return$20Air$20Damper | ra_damper_cmd | position | changing | 0.4 h of 7.0 d | 90 percent | 08:55 today (6.25) | 6 |
| PHBoffice | Outside_Air_Temp_Analog_Input1 | outside_air_temp | temperature | changing | 0.0 h of 6.0 h | 56.87 | 15 min ago | 1 |
| PHBoffice | RV_Supply_Fan_Speed_Analog_Output | supply_fan_speed | speed | changing | 0.0 h of 7.0 d | 50.17 | 5 min ago | 1 |
| PHBoffice | Supply_Duct_Static_Pressure_Analog_Input | duct_static_pressure | pressure | changing | 0.0 h of 3.0 h | 2.396 | 5 min ago | 1 |
| PHBoffice | Supply_Duct_Static_Pressure_Setpoint | duct_static_pressure_sp | pressure | **not checked, setpoint** | — | — | — | — |
| PHBoffice | Supply_Temp_Analog_Input | supply_air_temp | temperature | changing | 0.0 h of 6.0 h | 65.11 | 15 min ago | 1 |
| PHBoffice | Temperature_Setpoint | supply_air_temp_sp | temperature | **not checked, setpoint** | — | — | — | — |
| PHBoffice | VAV-1, -2, -3, -5, -6, -7, -9, -10 ZoneTemperature | zone_temp | temperature | changing | 0.0–0.3 h of 6.0 h | 70.3–72.8 | 15–30 min ago | 1–2 |
| PHBoffice | **VAV$2d8$20104$2d105_ZoneTemperature** | zone_temp | temperature | **FLAT** | **16.9 d of 6.0 h** | **70.5 fahrenheit** | **never** | **1,627** |
| SpringGroveLabComputer | **points_RoomT** | zone_temp | temperature | **FLAT** | **35.0 d of 6.0 h** | **-40 fahrenheit** | **2026-08-24 13:00 UTC (76.1)** | **7,550** |
| SpringGroveLabComputer | Temp1, Temp2, Temp3 | — | — | not checked, no role | — | — | — | — |

```
## Flagged: 2
- PHBoffice / VAV$2d8$20104$2d105_ZoneTemperature (zone_temp)
- SpringGroveLabComputer / points_RoomT (zone_temp)

Nothing flagged beyond the two known faults.

Readings before 82516 after 82516; active points before 30 after 30.

## ACCEPTANCE: PASS - both known faults flagged; no setpoint, status or unclassified point flagged.
```

Two things the run says that the brief did not:

- `points_RoomT`'s run is **7,550** identical readings, not 6,447 - the
  brief's figure was a few days old, and the sensor is still dead.
- `VAV-8` is flat for **16.9 days** rather than "its entire history"
  because the office history held by the platform begins on 11 September
  (the platform's copy, not the station's), and the check reports *never
  different in the readings held*, which is the honest statement.

**Nothing was flagged beyond the two.** The one candidate for a third fault
in the history - see the survey below - is not flat today.

---

## The thresholds, defended: the longest healthy run per point

Before choosing any threshold, the longest run of identical readings in
every active point's **whole history** was measured, so the defaults sit
clear of what healthy points actually do. The query, run against the live
table on 2026-09-28:

```sql
WITH r AS (
  SELECT point_id, ts, value_num,
         CASE WHEN value_num IS DISTINCT FROM lag(value_num) OVER (PARTITION BY point_id ORDER BY ts)
              THEN 1 ELSE 0 END AS chg
  FROM bas_readings
), g AS (
  SELECT point_id, ts, value_num, sum(chg) OVER (PARTITION BY point_id ORDER BY ts) AS grp FROM r
), runs AS (
  SELECT point_id, grp, min(ts) AS s, max(ts) AS e, count(*) AS n, min(value_num) AS v
  FROM g GROUP BY point_id, grp
)
SELECT p.niagara_history_name, pr.measurement, pr.is_setpoint,
       round(EXTRACT(EPOCH FROM max(e-s))/3600.0,1) AS longest_flat_h, max(n) AS longest_run_n
FROM runs JOIN bas_points p USING (point_id) LEFT JOIN bas_point_roles pr USING (point_role)
WHERE p.is_active GROUP BY 1,2,3 ORDER BY 2 NULLS LAST, 1;
```

| Point | Kind | Longest flat, ever | Readings in it | Threshold chosen |
|---|---|---|---|---|
| Ten healthy office zone temperatures | temperature | **0.8 – 1.8 h** | 4 – 8 | 6 h |
| Outside_Air_Temp_Analog_Input1 | temperature | 0.5 h | 3 | 6 h |
| Supply_Temp_Analog_Input | temperature | 0.3 h | 2 | 6 h |
| Supply_Duct_Static_Pressure_Analog_Input | pressure | **0.1 h** | 2 | 3 h |
| RV_Supply_Fan_Speed_Analog_Output | speed | 2.2 h (at exactly 50) | 27 | 7 days |
| Outside_Air_Damper_Analog_Output1 | position | **226.1 h = 9.4 days** (at 10, from 14 Sep 22:10) | 2,441 | 7 days |
| Return$20Air$20Damper | position | **226.1 h = 9.4 days** (at 90, same span) | 2,441 | 7 days |
| Temperature_Setpoint | temperature, setpoint | 378 h | 1,514 | not judged |
| Supply_Duct_Static_Pressure_Setpoint | pressure, setpoint | 406 h | 1,626 | not judged |
| Occupied, OccupancyCommand | status | 22,700 h / 4,980 h | 421 / 71 | not judged |
| points_RoomT | temperature | 840 h | 7,547 | **flagged** |
| VAV-8 | temperature | 406 h | 1,626 | **flagged** |

So: temperature at 6 h is three times the longest healthy run; pressure at
3 h is thirty times it and under the brief's "six hours is broken"; the
setpoints and status points, all flat for weeks, are outside the check by
role rather than by threshold.

**The finding the brief asked to be told about rather than tuned away.**
Both office dampers held one value - outside air at exactly 10 %, return air
at exactly 90 % - for **9.4 days**, 14 to 24 September. With the position
threshold at 7 days that run *would have been flagged* from 21 September
until the dampers moved on the 24th; at 24 h it would have been flagged for
eight days. Today both are changing (last different 30 minutes before the
run). This is not a sensor: it is the controller holding minimum outside
air, and in mid-September it is plausibly the economizer not economizing.
The threshold was **not** raised to hide it. A week is the defensible
figure for an output - hours mean nothing for something that sits at a
limit by design, and a week outlasts any schedule - and if the dampers hold
for a week again the card will say so, which is the point. Whether nine days
at minimum outside air in September is right for that unit is a question for
whoever runs it, not for the threshold.

---

## Cost, measured

`EXPLAIN (ANALYZE, BUFFERS)` of the service's SQL against the live table,
17 judged points, before the lookback bound and the bounded window count
were added (both only reduce it):

```
Execution Time: 6.478 ms      Planning Time: 10.503 ms      Buffers: shared hit=589
bas_readings: 82,478 rows, 7,056 kB
```

The plan, per judged point:

| Probe | Plan node | Rows touched |
|---|---|---|
| newest reading | `Index Scan Backward using bas_readings_pkey … LIMIT 1` | 1 |
| newest *different* reading | `Index Scan Backward … Filter (value IS DISTINCT FROM …) LIMIT 1` | 1 for a live point; the whole run for a dead one |
| run count and start | `Index Only Scan … Aggregate` | the run (541 average across the 17, dominated by 7,550 + 1,627) |
| oldest reading | `Index Only Scan … LIMIT 1` | 1 |

The cost is proportional to the length of the flat runs, not to the table:
a healthy point costs four index probes at any table size. What grows is the
walk down a dead sensor's run, about 1 ms per 1,500 rows here, and
`LOOKBACK_DAYS = 90` bounds it - a sensor dead for a year at five-minute
sampling reads as "at least 90 days" after roughly 26,000 rows, some 20 ms,
instead of 105,000. Through Prisma the full round trip measured 25.4 ms on
the first run and 15.1 ms on the second (plan cached).

**Decision: compute on page load, do not store.** Storing a verdict per
collector pass would put the rule in `phb-bas`, need a migration, and go
stale whenever a threshold here changed; at 6.5 ms it buys nothing. The
condition to revisit is 200 ms on the live screen, measured with this
EXPLAIN, or an estate of hundreds of judged points.

---

## What the fixture proves — `tests/bas-plausibility.test.ts`, 32 tests

Twenty seeded points across two buildings, every span relative to one
captured `now`. The live estate holds no change-of-value point that is
judged (all eight are status points), so the change-of-value path is proved
only here - recorded in `docs/testing-blind-spots.md`.

| Claim | Proved by |
|---|---|
| A flat setpoint, a flat status point and a flat point with no role are not flagged, and read *setpoint* / *status or command point* / *role not set* | seeded 70 identical readings on each; not in `flat`; the reason word asserted |
| Both fault shapes: 76.1 then -40 (33 readings, 8 h); 70.5 forever (30 readings) | flagged, with value, last-different value and instant, run count, `runIsWholeHistory` |
| Thresholds are per kind | the same 17-reading, 4 h run: *changing* as temperature, *flat* as pressure; 5 days flat *changing* and 8 days *flat* as position |
| Three readings are not stuck, nor five spread over ten hours | both *too few readings*, with the count |
| Change-of-value: flat from the last record to the collector's last **ok** pass; a stalled collector is *changing* with 0 h known | `flatUntil` equals the checkpoint's `last_run_at`; with `last_status = 'error'` it equals the last record |
| A run of empty records is flat at *no value* | 30 NULL-valued rows |
| The lookback bound reports a floor: *at least 84.0 days*, *no different value in the last 90 days* | a different value 100 days ago, then 15 identical readings inside the window |
| Nothing deactivated, nothing modified | reading count, active count and `sum(value_num)` identical before and after; the module and the query contain no write (source text) |
| A flagged point stays in every figure; a hidden flagged point is listed and says so | every flagged id is still in `health.points`; `activePoints` equals the view's count; the card names the hidden point |
| The building filter scopes the card and says *1 more outside* | site A selected; `unfiltered.pointsFlat` carries the estate figure |
| SQL and TypeScript agree on every role | all 91 vocabulary roles plus the fixture's five, each run through `checkedRoleSql` as a `VALUES` row and through the judge; every measurement kind is judged, a state word, or `unclassified` |
| The judge refuses a disagreeing row | throws on `pl_checked` set for a setpoint, and on unset for a temperature |

## Mutations run, each reverted, the module byte-identical afterwards

| Mutation | What failed |
|---|---|
| **A1** drop `AND NOT pr.is_setpoint` from `checkedRoleSql` (the SQL half of the exclusion) | 26 tests: the judge throws *SQL evaluated a point TypeScript would not check (setpoint, role …_sp)* on every service call - the agreement guard, on the fixture's setpoint and on the vocabulary's |
| **A2** A1 plus drop the judge's setpoint branch (both halves) | 8 tests, first among them **"a flat setpoint is not flagged, and reads 'not checked, setpoint'"**: the setpoint is in `flat`, the flagged set is wrong, the exclusion counts are wrong, and the card names it |
| **B** pressure threshold 3 h → 6 h | 7 tests: "the same four-hour run is changing for a temperature and flat for a pressure", the threshold-visibility test, and every flagged-set assertion |
| **C** `MIN_READINGS` 12 → 3 | 7 tests: "three readings are not stuck …", the change-of-value window guard, and every flagged-set assertion (the sparse point is now flagged) |
| **D** measure a change-of-value point to `now()` instead of the last ok pass | 1 test: "flat to that pass" - `flatUntil` is no longer the checkpoint instant |

---

## Not observed, and said so

- A change-of-value point being flagged on live. None is judged today.
- The screens in a browser. Both cards and the Points list column are
  rendered statically in the tests and their text asserted; the live
  numbers above come from the script, not from the page.
- The threshold for humidity, flow, concentration, current, power, voltage,
  ratio, energy, volume, time and count against live data: the estate has
  no judged point of any of those kinds yet. Each carries its reason in
  `PLAUSIBILITY_THRESHOLDS`; the first building that has one should re-run
  the longest-run survey above before trusting it.
