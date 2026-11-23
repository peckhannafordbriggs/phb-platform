# Deleting report runs, Recently deleted, retention, deleting a report, and paging both lists (2026-11-20 / 23)

The record for the pull request that made report runs deletable to a 15-day
*Recently deleted*, gave each report a *Keep generated runs for* setting, and
let a report with runs be deleted without touching any of them
(`WHY-ITS-BUILT-THIS-WAY.md` § 94; `runbook.md` → *Reports: a run is missing
from the list, or Recently deleted*, *Deleting a report, and what happens to
its generated reports*).

| Capture | What it shows |
|---|---|
| `runs-list-selection.png` | Reports → Reports with two finished runs ticked: the header box half-ticked, *2 selected · Delete 2 runs · Clear* on the left of the toolbar, *Recently deleted* on the right, a box and a *Delete* on every finished row, and both greyed on the one row still *Running*. |
| `runs-delete-confirm.png` | *Delete 2 runs* opened the confirmation: the count in the heading, where the runs go and for how long, Cancel holding the focus. |
| `runs-after-delete-undo.png` | Confirmed: the two rows gone from the list at once, and the notice *2 runs moved to Recently deleted.* with *Undo*. |
| `recently-deleted.png` | *Recently deleted*, opened by the button: five runs, newest deletion first, each with when and by whom - an address, or *Retention (6 months)* - and the days left, the last day in amber; *Restore* on each. One row's report was itself deleted and says *(schedule deleted)*. |
| `editor-retention.png` | The editor's Schedule section with *Keep generated runs for* set to 6 months, and the sentence saying what that does. |
| `scheduled-summary-line.png` | Scheduled: *Keeps runs 6 months* on the report's summary line, nothing on the one that keeps runs for ever, the deleted report *Lab monthly energy* on nobody's list, and *Delete* greyed on the report whose run is in flight. |
| `report-delete-confirm.png` | *Delete* on a report: *This stops future runs. The 4 generated reports stay.* - four counting the one in Recently deleted. Cancelled. |
| `runs-schedule-deleted.png` | A deleted report's run, still on the Reports list with its PDF, its email and its own *Delete*, labelled *(schedule deleted)*. |
| `runs-page-2.png` | Paging (2026-11-23): page 2 of the runs, *26–33 of 33*, reached with *Next* - the address bar says `?page=2` - *Next* greyed at the end; the Report, Building and Status filters above the table at *All*. |
| `runs-filtered.png` | *Office weekly health* chosen in Report and *Partial* in Status through the dropdowns: back to page 1, *1–5 of 5*, both buttons greyed; `?report=1&status=partial`, and a reload keeps it. |
| `scheduled-pager.png` | Scheduled, newest first (it was by name), with *1–2 of 2* and the pager under the table. |

## Method

Playwright's Chromium at 1440 x 900 against a dev server of this branch on a
spare port, the server pointed at the **test** database (a throwaway
`pgvector/pgvector:pg17` container) rather than the development one, because
the branch carries a migration. The session is a cookie minted with
`next-auth/jwt` from the local `AUTH_SECRET` for a fictional employee row
(*Morgan Lee*) holding the BAS grant with the module-admin flag. The seed made
two buildings, the shared library, three reports - one keeping runs six
months, one keeping them for ever, one deleted by the service after two runs -
ten runs inserted directly with plausible periods, costs, a ready PDF and one
sent delivery each, and three of them already in Recently deleted (two by the
owner, one by retention). Every state was reached by clicking in the page; the
harness printed each state back (rows before and after, the dialog text, the
days left and who deleted each, which buttons were disabled) before taking the
picture. Captures were taken after the full suite and the build, and the test
database was dropped afterwards. The three paging captures (2026-11-23) came
from the same seed with 24 more weekly runs - 33 on the list - and the
harness also checked, without a picture, that "No runs match these filters"
and *Clear filters* work and that `?page=9` opens page 2 with the address bar
corrected. They wait 0.7 s before each picture: the kit button fades its
opacity, and an immediate capture shows a disabled button mid-fade.
