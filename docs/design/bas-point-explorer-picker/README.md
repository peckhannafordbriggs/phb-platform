# Point Explorer: the equipment picker and the multi-line chart (2026-11-20)

Captures for the PR that replaced Point Explorer's Point dropdown with an
Equipment multi-select and a grouped Point list, and let one chart draw up to
six lines.

**What they were taken from.** The test database, not a real building: a
station named like CEI_JCI_N2 holding the real 334 point names from
`docs/fixtures/cei-point-names.txt`, put through the production assignment
pass (`autoAssignStation`) so the equipment and roles are what the scheduler
gives CEI, with units set on the temperatures and the static pressure, and a
week of synthetic 30-minute readings on the four plotted points. The values
are invented; the names, the equipment and the roles are not.

**How.** Headless Chromium (Playwright) against `next dev` on the branch,
signed in with a session cookie minted from the local `AUTH_SECRET`, driving
the screen the way a person does: open the Equipment list, choose AHU_7 and
V4_22, choose a point, *Choose another point*, *Tick several*, tick three,
*Plot selected*.

| File | Shows |
|---|---|
| `01-equipment-select-open.png` | The Equipment multi-select open: search, *Select all*, *Clear*, each equipment with its type and point count, two ticked |
| `02-picker-two-equipment.png` | AHU_7 and V4_22 chosen, a chip each; the Point list shows only their points, grouped, the role beside each name |
| `03-point-list-ticked.png` | *Tick several*: the point on screen pre-ticked, three more ticked; a fan status greyed out as needing a third axis; the ticked chips and *Plot selected (4)* |
| `04-four-line-chart.png` | The four lines: three °F on the left axis, the static pressure in inWC on the right, the legend saying which is which, lines 3 and 4 dashed, the shared cursor reading all four |
| `05-four-line-page.png` | The same, with the picker above and the note that the tiles describe the first line |
