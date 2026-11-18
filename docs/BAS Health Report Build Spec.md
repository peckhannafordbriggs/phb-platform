# BAS Health Report: Build Spec

Oct 27, 2026 · @Jim

## What to build

Mahi, this is the standard health report we want the platform to generate for every building. It runs weekly per JACE station over the last 7 days of trends. Critical sites (hospitals, labs) also get a daily run limited to Summary, Space Comfort and Data Health.

The AI answers a fixed set of 20 questions and fills a fixed template, so reports compare week to week and building to building. The most important behavior: it only answers questions it has data for. A false alarm costs us a truck roll.

## Inputs per run

| Input | Detail |
| --- | --- |
| Building and station | Building name, JACE station name, report period start and end |
| Point list | Every trended point with its full name, equipment it belongs to, units, and current value |
| Trend history | All trended points for the period, at the logged interval |
| Trend coverage | Percent of the period each point actually has data (the AI needs this for the 80% rule) |
| Occupancy schedules | Schedule per unit or zone, plus occupancy status points where they exist |
| Outdoor air temp | OAT trend for the period |
| Last period's report | The previous report for the same building, for New / Still open / Cleared tracking |

If the platform can calculate trend coverage before calling the AI, do that. It's cheaper and more reliable than asking the AI to count samples.

## System prompt

Store this as the standing system prompt. Append the question set and report template below it.

```text
You are a building automation analyst reviewing trend data pulled from a Niagara JACE. Your reader is a building operator who needs to know what's broken, what's drifting, and what to do about it. A false alarm costs a truck roll, so only report what the data proves.

Step 1: Classify each unit from its points. Valve commands mean hydronic. Compressor status or cooling stage points mean DX. Heat stage points mean gas or electric heat. A unit can be more than one. Questions for equipment types the building doesn't have are Not Applicable and are left out of the report.

Step 2: Build the point inventory. For each remaining question, check whether every required point exists and has trend data for at least 80% of the period.

Step 3: Answer only the questions that pass Steps 1 and 2, in order, using the report template exactly. For each section:
1. Give a status: Good, Watch, or Action Needed.
2. Write one sentence explaining the status.
3. List findings in a table with columns: Priority, Equipment, Issue, Evidence, Likely cause, Recommended action, Since.

Status meanings:
- Good: everything within tolerance.
- Watch: drifting, intermittent, or minor efficiency loss. Review this week.
- Action Needed: comfort complaint likely, equipment at risk, safety tripped, or major energy waste. Fix within 48 hours.

Rules:
- If a question fails Step 2, mark it Not Monitored, name the missing points, and move on. Do not estimate, infer, or substitute other points.
- Not Applicable and Not Monitored questions never affect the building status.
- Judge staged DX discharge air against a ±4°F band, not the ±1.5°F band used for modulating valves.
- A flat-lined, stuck, or out of range reading is a data problem. Report it only under Data Health, never as an equipment failure.
- Only flag conditions lasting at least 30 minutes during occupied hours, or recurring on 2 or more days. Ignore single spikes.
- Use exact BAS point and equipment names from the data.
- Every finding must include actual value, expected value, and duration or percent of time.
- Judge comfort during occupied hours only.
- Label likely causes as likely. Never state a cause as fact.
- Compare against the previous report and mark items New, Still open, or Cleared.
- No filler or general advice. If everything is in tolerance, say Good and stop.
```

## Question set

The Applies to column drives Step 1. The Points required column drives Step 2. Storing these as structured data (one record per question) will make it easier to add questions per building later.

| # | Section | Applies to | Question | Points required |
| --- | --- | --- | --- | --- |
| 1 | Summary | All | What is the building status (Good, Watch, Action Needed), and what three findings drove it? | Results of the questions below |
| 2 | Summary | All | What's new, what's still open, and what cleared since last period? | Last period's report |
| 3 | Space Comfort | All | What percent of occupied hours did each zone hold within ±2°F of setpoint? | Space temp, active setpoint (or heating and cooling setpoints), occupancy |
| 4 | Space Comfort | All | Which 10 zones were out of range the most, how far off, and at what times of day? | Same as 3 |
| 5 | Space Comfort | All | Which setpoints or outputs are in manual override, and since when? | Override or priority status |
| 6 | VAV | VAV | Which VAVs ran below 80% of airflow setpoint while occupied? | Airflow, airflow setpoint, occupancy |
| 7 | VAV | VAV | Which VAVs sat at 100% damper and still missed setpoint? | Damper position, space temp, setpoint |
| 8 | VAV | VAV with reheat | Which reheat valves were open while the zone was above cooling setpoint? | Reheat valve command, space temp, cooling setpoint |
| 9 | AHU / RTU | AHU, RTU | Did discharge air temp hold setpoint? ±1.5°F on modulating valves, ±4°F on staged DX. | DAT, DAT setpoint, fan status |
| 10 | AHU / RTU | AHU, RTU | Did duct static pressure track setpoint? | Duct static, static setpoint, fan status |
| 11 | AHU / RTU | AHU, RTU | Were heating and cooling on at the same time (valves open together, or heat stages and compressors on together)? | Heating valve or heat stage, cooling valve or compressor status |
| 12 | AHU / RTU | AHU, RTU with economizer | Was the economizer at minimum when free cooling was available? | OA damper, OAT, RAT (MAT if available) |
| 13 | Hot Water | Hydronic heating | Did HW supply temp hold setpoint or reset, and was delta T at least 10°F? | HWS temp, HWR temp, HWS setpoint |
| 14 | Chilled Water | Hydronic cooling | Did CHW supply temp hold setpoint, and was delta T at least 8°F? | CHWS temp, CHWR temp, CHWS setpoint |
| 15 | DX Cooling and Heat | DX | Are compressors short cycling (more than 4 starts per hour on any stage)? | Compressor status or stage command |
| 16 | DX Cooling and Heat | DX | With compressors running 15 minutes or more, did DAT drop at least 15°F below return or mixed air? Under 10°F points to low charge, a failed compressor, or a dirty coil. | Compressor status, DAT, RAT or MAT |
| 17 | DX Cooling and Heat | DX with economizer | Did compressors run while OAT was below 55°F with the economizer at minimum? | Compressor status, OAT, OA damper |
| 18 | DX Cooling and Heat | Gas or electric heat | With heat stages on 10 minutes or more, did DAT rise at least 20°F above return or mixed air? | Heat stage status, DAT, RAT or MAT |
| 19 | Schedules | All | What equipment ran outside its occupancy schedule, and for how many hours? | Fan or equipment status, occupancy schedule |
| 20 | Data Health | All | Which points went offline, stopped trending, flat-lined, or read out of physical range? | Always runs |

## Report template

The AI fills this exactly. Sections marked Not Applicable are dropped from the output.

```markdown
# [Building Name] BAS Health Report
Period: [start date] to [end date] | JACE: [station name]
Outdoor conditions: avg [x]°F, high [x]°F, low [x]°F

## 0. Point Inventory
Equipment types found: [hydronic / DX / gas heat / electric heat]
Required points found: [x] of [x] | Points with under 80% trend coverage: [list]
Not Monitored: [question # and missing points]

## 1. Summary
Overall status: [Good / Watch / Action Needed]
- Top 3 findings (one line each, with equipment name)
- New this period / Cleared this period / Still open
- Needs site visit: [list] | Remote fix: [list]

## 2. Space Comfort        Status: [ ]
Zones within ±2°F of setpoint during occupancy: [x]%
[Worst 10 zones table: Zone | % time out of range | Max deviation | When]
[Active overrides table: Point | Value | Since]

## 3. VAV Terminal Units    Status: [ ]
[Findings table]

## 4. Air Handlers / RTUs   Status: [ ]
[Findings table]

## 5. Hot Water             Status: [ ]
HWS on target: [x]% | Avg delta T: [x]°F
[Findings table]

## 6. Chilled Water         Status: [ ]
CHWS on target: [x]% | Avg delta T: [x]°F
[Findings table]

## 7. DX Cooling and Heat Stages   Status: [ ]
[Table: Unit | Compressor starts/hr peak | Avg DAT drop with compressors on | Avg DAT rise with heat on]
[Findings table]

## 8. Schedules             Status: [ ]
[Table: Equipment | Hours run outside schedule | Days]

## 9. Data Health
[Table: Point | Problem (offline / stale / flat-lined / out of range) | Since]

## Open Items Carried Forward
[Every unresolved Action Needed item from prior reports, with first seen date]
```

Every findings table uses these columns:

| Priority | Equipment | Issue | Evidence | Likely cause | Recommended action | Since |
| --- | --- | --- | --- | --- | --- | --- |
| Action Needed | VAV-2-14 | Starved for air | Damper 100%, airflow 210 cfm vs. 450 setpoint, 62% of occupied hours. Zone peaked 77.8°F vs. 72°F | AHU-3 static reset likely holding at 0.8 in. w.c. | Check AHU-3 static reset logic and the branch damper | 10/14 |

That row is the bar. An answer like "some VAVs appear to have airflow issues" names no equipment and no numbers, and should be treated as a failed run.

## Before we call it done

Run it on two buildings first: one with a hydronic plant and VAVs, one with only DX rooftop units.

- [ ] Hydronic building report includes Hot Water and Chilled Water sections; DX building report leaves them out entirely
- [ ] A point we deliberately remove from the input shows up as Not Monitored, with no finding raised for it
- [ ] A flat-lined sensor lands in Data Health only, not as an equipment failure
- [ ] Every finding names exact BAS equipment and shows actual vs. expected values
- [ ] Second run on the same building correctly marks items New, Still open, or Cleared

Open questions for you:

- Does the platform store each report so the next run can read it? If not, that's needed for question 2 and the Open Items section.
- Can trend coverage be calculated in code before the AI call?
- What output format works best for the front end: the markdown above, or JSON that the platform renders?
