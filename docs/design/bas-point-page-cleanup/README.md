# Point Explorer, the Projects card and Collection Health on a CEI-shaped station: before and after (2026-11-20)

The record for the pull request that judges every point against how often it
actually reports, splits "history size unknown" out of the at-risk figure, adds
an assumed history capacity per station, and adds the Data health tile, the
trend summary and compare mode (`CLAUDE.md` → *Points are judged against how
often they actually report*; `WHY-ITS-BUILT-THIS-WAY.md` § 91).

| Capture | What it shows |
|---|---|
| `before-projects-card.png` | `main` at c539cc5: the CEI card reads **334 points at risk** in the maroon mark. Every point is `roll_horizon_unknown`: no capacity entered, so no horizon. |
| `before-point-page.png` | `main`: `V4_22/SpaceTemp` over seven days. *305 breaks · longest 3.7 h*: with no interval entered the threshold fell to its 15-minute floor, so every 30-minute gap is a break - the chart is banded pink from end to end and the list under it is one line per reading. Five tiles. |
| `after-projects-card-unknown.png` | This branch, straight after the migration and before the scheduler has measured anything: **No points at risk**, and under it, in plain white text with no mark, *334 points: history size unknown*. |
| `after-health-hero-unknown.png` | Collection Health's hero, the same moment: *0 · Nothing at risk* in the muted tone (not green - unknown is not safe), and the same muted line, linked to Settings for a module admin. |
| `after-settings-history-unknown.png` | Where that link lands, `/bas/settings?history=unknown`: the station's Points list opens by itself on its unknown points, the row says *334 history size unknown*, and the new line *Assumed history capacity: 500 records (Niagara's default) — used for any point here whose capacity is not entered. Change*. (The red login banner is the seed's: it recorded a collector run and stored no credential.) |
| `after-projects-card-measured.png` | After one scheduler pass: every point measured at 30 minutes, every horizon *estimated* at 500 × 30 min, nothing unknown and nothing at risk - the card reads **No points at risk** and nothing else. |
| `after-point-page.png` | The same point, the same week. Four tiles: Latest, Average, Range and **Data health** - *7.9% missing*, *Reports about every 30 min (measured)*, *Station keeps about 10.4 days of history (assumed 500 records × measured 30 min)*. The *Trend summary* card, collapsed. The chart with bands only on the nine real breaks, and under it one line, *9 breaks, longest 3.7 h, 7.9% of the period missing*, what a break is for this point, the five longest, and *Show all 9*. The seed dropped 29 readings in twelve holes; the three one-reading holes are a 1-hour gap, exactly the two-interval line, so they are not breaks. |
| `after-trend-summary.png` | *Explain this trend* pressed: five sentences from `claude-opus-5-5`, one real call on the BAS key ($0.0275), every number in them checked against the stats it was given, with the range covered, when it was written, the cost, and *Refresh*. Its remark that the daily shape "runs backwards" is a fair reading of the seed's synthetic sine wave. |
| `after-compare-two-units.png` | *Compare points* on `V8_01/SpaceTemp` with `V8_01/Humidity` (the same VAV, the picker's default list): °F on the left axis, % on its own right axis in purple, both legends naming their axis, *Clear comparison* in the header. `compare=314` in the URL. |

## Method

Playwright's Chromium at 1440 wide against two dev servers on this machine: a
detached worktree of `main` at c539cc5 on port 3101 and this branch on 3100,
each pointed at its own scratch database on the pgvector container
(`phb_capture_before` migrated with `main`'s migrations, `phb_capture_after`
with this branch's), signed in with a session minted with `next-auth/jwt` from
the development `AUTH_SECRET` for an invented `capture@phb1899.com` employee.

**The station is CEI's shape with invented values.** Its 334 point **names**
are CEI_JCI_N2's real ones (`docs/fixtures/cei-point-names.txt`); everything
else is synthetic: one reading every 30 minutes for eight days on every point,
a daily sine wave per kind of point, twelve holes cut into `V4_22/SpaceTemp`,
no capacity, no interval and no record count - what production holds for CEI.
One piece of equipment per name prefix, so compare mode has neighbours. The
same seed went into both databases, so the before and after captures are the
same rows. The "after" sequence ran the scheduler's interval step
(`refreshMeasuredIntervals`) between the first three captures and the rest.
Both scratch databases were dropped afterwards.
