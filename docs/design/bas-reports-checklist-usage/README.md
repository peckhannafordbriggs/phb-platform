# The Reports editor's Questions checklist and the Usage page (2026-11-12)

The record for the pull request that made the editor's Questions section a
checklist, replaced the two per-report caps with the module's one safety
ceiling, and gave the Usage page its figures (`docs/09-bas-what-is-built.md`
→ *Reports — the questions checklist, the safety ceiling, and a Usage page
that reads*; `WHY-ITS-BUILT-THIS-WAY.md` § 81).

| Capture | What it shows |
|---|---|
| `editor-questions-empty.png` | A new report, before any save: every enabled shared question with a box, grouped by section, the four buttons above, My questions and the custom-question box below. Nothing ticked. |
| `editor-questions-standard-weekly.png` | After one click on *Standard weekly*: the twenty ticked, the summary reading *20 questions · Standard weekly health report*. |
| `editor-questions-custom.png` | After typing a question and clicking *Add*: the twenty plus one custom question of this report, with its *save for reuse* tick; *21 questions · Standard weekly health report + 1 custom*. |
| `usage.png` | Usage over 30 days: the five tiles, spend per day, the by-report / by-building table, the most expensive runs, and the *Safety ceiling* card at the bottom with its inputs (the viewer is a module admin). |

## Method

Headless Chrome (`--headless=new`) over the DevTools protocol against a dev
server of this branch on a spare port, the server pointed at the **test**
database rather than the development one - the branch's migration drops two
columns, and the development database is left for the owner to migrate when
the branch is pulled. The test database was seeded for the captures with the
two module rows, the owner's employee row, the BAS grant with the
module-admin flag, one building, the shared library, one report (the
standard twenty plus one typed question) and three finished runs - one of
them the $0.0397, 4,310-token run the Reports list showed while the old
Usage page said there had been none. The session is a cookie minted with
`next-auth/jwt` from `AUTH_SECRET`; no API is mocked and nothing reaches a
model. The three editor captures are the Questions section clipped from one
page, the state changed by clicking the page's own buttons and typing into
its own box, with the summary line read back between steps.

No colour changed on this branch; every value is the module's.
