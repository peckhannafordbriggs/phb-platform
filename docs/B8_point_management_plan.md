# B8 — Point management

**Written:** 17 September 2026
**Status:** designed, not started
**Prerequisite:** none. B7 is complete and the office JACE is collecting.

---

## Why this exists

On 17 September we classified a real building by hand — 26 points on the
office JACE — entirely in SQL, because the platform has no way to set a role,
create a piece of equipment, rename a point, or mark one inactive.

That was deliberate. The plan was to do it manually once and find out what the
tool actually needs to do. This document is the answer.

**It took about thirty minutes for 26 points.** A project with ten JACEs and
600 points would take a week, and nobody would ever do it. That is the whole
case for B8.

---

## The central distinction: showing is not collecting

The most important decision in this phase, and the easiest to get wrong.

| | Controls | Default | Consequence of turning it off |
|---|---|---|---|
| **Collected** (`is_active`) | Whether the collector fetches it at all | on | **Permanent.** The station overwrites its own history — the office JACE holds ~5 days, and one status point holds ~2 hours. A point not collected on Tuesday cannot be recovered on Friday. |
| **Shown** (new) | Whether it appears on the browsing screens | on | Cosmetic. Reversible at any moment with no loss. |

Users asked for "let me choose which points to pull." What they actually want
is a shorter list on screen. Those are not the same request, and conflating
them destroys data.

**So: collect everything, filter what you see.**

The cost of keeping everything is negligible — all 26 points on the office
station produce under a million rows a year, and the difference to the JACE
between polling 18 points and 26 is not measurable. The cost of *not* keeping
something is absolute and only discovered months later, when someone asks
"was the outside air damper stuck open during that hot week in January" and
there is no answer and no way to ever get one.

`is_active` stays, because genuine exclusions exist: the Niagara audit and
security logs (not building data), and the dead half of a reconfigured
`_cfg0` pair. But **on is the default**, and turning it off must state plainly
what it costs.

---

## Hidden points must not hide risk

A hidden point is still collected, so it can still fail, lose data, or fall
behind its roll horizon.

**Collection Health must keep counting hidden points in its risk figures.**
Leave them out of the table if that is what the user asked for — but never out
of "points at risk of data loss" or the completeness count. A hidden point that
starts losing history and says nothing is the 28 August failure again: recorded
correctly, read by nobody, found eight days late.

This is the same rule B7.6 already implements for filters — `describeHiddenRisk`
says *"No points are at risk in Liberty Center, but 1 is at risk elsewhere."*
Reuse that pattern rather than inventing a second one. A screen must never be
able to look healthier than the system is.

**Point Explorer is different.** It is a browsing screen; hiding a point from
its picker costs nothing.

---

## Renaming

Three fields, in precedence order:

1. **`niagara_history_name`** — the key. `VAV$2d8$20104$2d105_ZoneTemperature`.
   Goes into the oBIX URL verbatim. **Never editable, by anyone, ever.**
   Changing it stops that point collecting.
2. **Station display name** — what Niagara reports (`VAV-8 104-105_ZoneTemperature`).
   Refreshed by `discover`. Not ours to edit.
3. **User label** — new. What a person typed. Wins on screen when present.

**Where each one is visible.** The Niagara name stays out of the browsing
screens — nobody reading Point Explorer needs it — but it must remain visible
on that point's row in **Settings**, because it is what you match against
Workbench when something breaks. Hidden from the people browsing, one click
away from the person troubleshooting.

**Search must match both.** Someone will paste a name out of Workbench, or type
`VAV$2d8`, and it must find the point even though the screen shows
"Zone Temp 104-105". The ugly name keeps its diagnostic value without cluttering
anything.

**The rule that is easy to get wrong: `discover` must never overwrite a user
label.** Discover re-reads everything from the station on every run. If it
clobbers hand-typed names, somebody's afternoon disappears the next time a
point is added.

**Much of this need disappears with classification.** Once a point is
`zone_temp` on equipment `VAV-8` which `Serves 104-105`, a screen can render
*"VAV-8 · Zone Temperature"* from structure alone. Renaming becomes the
exception rather than the default chore — which is the right outcome, since a
hand-typed name is unstructured and a role is queryable.

---

## What can be automated, and what cannot

From doing it by hand, the honest split:

| Task | Automatable? |
|---|---|
| Finding the points | **Already automatic** — `discover` |
| Excluding Niagara system logs | **Already automatic** — exact-name match |
| Flagging `_cfg0` reconfigured pairs | **Already automatic** — warns, refuses to choose |
| Choosing which `_cfg0` half is dead | **Yes** — the dead one has no recent records. We worked it out from record counts; so can the collector |
| Interval vs change-of-value | **Yes** — evenly spaced records means a timed trend and the spacing *is* the interval. We had to read this from Workbench; it is derivable from the data |
| Measured roll horizon | **Yes, and it matters** — a COV status point on the office JACE cycles every 15 seconds, so its 500-record buffer holds **two hours**, not the 125 hours every interval point gets. Sixty times shorter, and the system currently reports it as "unknown" |
| Assigning roles | **Suggest, don't decide.** `VAV-1 130-132_ZoneTemperature` → zone temperature is obvious. The next integrator writes `VAV1_ZN_T` or `AHU1_SAT` and no pattern catches everything |
| Creating equipment | **Suggest, don't decide.** `VAV-1`…`VAV-10` are right there in the names |

**Suggestions must never auto-apply.** The standing rule holds: `Temp1`–`Temp3`
on the lab are deliberately unclassified because nobody knows what they
represent, and a made-up role makes the AI answer confidently about something
untrue. A suggestion a human confirms is fine. A guess written silently is not.

---

## The screen

A **Points** section in Settings, nested under each station — the level below
JACE in the existing Project → Building → Station tree.

Per point:

- **Show** — a checkbox, following the module-grant checkbox pattern on the
  admin page
- **Label** — editable, blank means "use the station's name"
- **Niagara name** — read-only, shown on the row for troubleshooting
- **Role** — a picker, with a suggestion offered when one is confident
- **Equipment** — a picker, with a suggestion offered
- **Collected** — read-only status. A point that is not collected says **why**
  (Niagara system log; retired `_cfg0` half) rather than showing a bare
  unchecked box

At 26 points a plain list works. At 600 it does not, so from the start:

- Select all / none, and select-by-filter
- Bulk assign role and equipment to a selection
- Filter the list by role, equipment, collected state and completeness
- Search matching both the label and the Niagara name

The bulk path is the feature, not a nicety. Ten VAV zone temperatures should be
one action.

---

## Build phases

### B8.1 — Schema
User label column; visibility column. Both nullable/defaulted so existing rows
behave exactly as now. `discover` must not overwrite the label.

**Done when:** a labelled, hidden point survives a `discover` unchanged.

### B8.2 — The Points list, read-only
The tree gains a Points level. Shows everything: label, Niagara name, role,
equipment, collected state with reason, completeness. No editing.

**Done when:** every point on both stations is visible with its real state, and
the counts match the database independently of the tree's joins — the same
`stationsAccountedFor` guard B7.2 uses.

### B8.3 — Show/hide, and the risk rule
The checkbox. Hidden points leave the Point Explorer picker and the Collection
Health table.

**Done when:** a hidden point that is at risk of data loss **still** appears in
the risk figures, with the `describeHiddenRisk` wording. Test it explicitly:
hide the only at-risk point and the screen must not read as all-clear.

### B8.4 — Labels
Editable label, precedence, search across both names, audit event.

### B8.5 — Roles and equipment, with suggestions
Pickers, bulk assign, create equipment inline, parent relationships.
Suggestions from name patterns, always confirmed, never applied silently.

**Done when:** the office JACE's classification can be reproduced through the
UI and lands on the same 20 roles, one RTU and ten VAVs we set by hand in SQL.
That is the acceptance test, and it exists because we did it manually first.

### B8.6 — Automatic derivation
Trend type and measured roll horizon derived from what the station reports.
Dead `_cfg0` half detected from record counts. All surfaced as suggestions.

---

## Open questions

**Does the AI see hidden points?** Hiding is a screen preference and the AI is
not a screen, so the argument is that it sees everything. But a user who hid
forty points may be surprised when the answer mentions them. Decide before B5
ships, not after.

**Should `is_active = false` points appear in the Points list at all?** Leaning
yes — you need to see that a point exists and why it is not collected.
Invisible exclusions are how the `_cfg0` question went unnoticed.

**Bulk-hiding at scale.** If someone hides 400 of 600 points, the risk rule
above means Collection Health is permanently reporting on things nobody looks
at. That is correct, but it may be unbearable. Watch it at the first big site.
