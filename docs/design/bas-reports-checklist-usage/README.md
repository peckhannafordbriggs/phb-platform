# The Reports editor's Questions checklist and the Usage page (2026-11-12)

The record for the pull request that made the editor's Questions section a
checklist, replaced the two per-report caps with the module's one safety
ceiling, and gave the Usage page its figures (`docs/09-bas-what-is-built.md`
→ *Reports — the questions checklist, the safety ceiling, and a Usage page
that reads*; `WHY-ITS-BUILT-THIS-WAY.md` § 81).

| Capture | What it shows |
|---|---|
| `editor-tab-standard.png` | A new report, the *Standard weekly* tab, before any save: the twenty with a box each, grouped by section, *Select all* and *Clear* for the tab, four ticked (Q1, Q3, Q7, Q10) and *4 questions ticked* at the right of the tab row. |
| `editor-tab-daily.png` | The *Daily critical-site* tab a moment later: its six, with Q1 and Q3 already ticked because the selection is one set, the count still four. |
| `editor-tab-custom.png` | The *Custom* tab: My questions (empty, saying how to fill it), a typed question added to this report, and the box with its *save for reuse* tick. |
| `editor-show-selected.png` | *Show selected* open on the Custom tab: the whole set in the order the report will hold it. |
| `usage.png` | Reports → Usage over 30 days (first cut, 12 Nov): the five tiles, spend per day, the by-report / by-building table, the most expensive runs, and the *Safety ceiling* card - and the ground stopping 4rem short under it, the defect the next capture shows fixed. |
| `settings-general.png` | Settings → General: the Settings bar - *Back · General · Usage* - in place of the module tabs, one row, General active; the Settings screen beneath. |
| `settings-usage.png` | Settings → Usage: the same bar with Usage active, the Usage view and the ceiling card beneath, the ground reaching the bottom. |
| `ground-bas.png`, `ground-cip.png`, `ground-fp.png` | A page in each of Building Automation, Cost Intelligence and Freeze Protection in a short window, scrolled to the bottom: the ground covers the last line. |

The first cut's three flat-list captures were removed when the tabs replaced it the same day.

## Method

Headless Chrome (`--headless=new`) over the DevTools protocol against a dev
server of this branch on a spare port, the server pointed at the **test**
database rather than the development one - the branch's migration drops two
columns, and the development database is left for the owner to migrate when
the branch is pulled. The test database was seeded for the captures with the
module rows, the owner's employee row, the BAS, Cost Intelligence and Freeze
Protection grants with the module-admin flag, one building, the shared library, one report (the
standard twenty plus one typed question) and three finished runs - one of
them the $0.0397, 4,310-token run the Reports list showed while the old
Usage page said there had been none. The session is a cookie minted with
`next-auth/jwt` from `AUTH_SECRET`; no API is mocked and nothing reaches a
model. The three editor captures are the Questions section clipped from one
page, the state changed by clicking the page's own buttons and typing into
its own box, with the summary line read back between steps.

No colour changed on this branch; every value is the module's.
