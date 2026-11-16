# Planner questions on the report (2026-11-16)

The record for the pull request that made a report's planner questions
run (`feat/bas-reports-phase6`; `docs/09-bas-what-is-built.md` →
*Reports — Phase 6*; `WHY-ITS-BUILT-THIS-WAY.md` § 86).

| Capture | What it shows |
|---|---|
| `planner-section.png` | The whole *Planner questions* section of office run 18 (PHB Steel Place, the seven days ending 29 September 2026), with the one header note that the answers are shown and not tracked. |
| `planner-question-1.png` | *Which zone was warmest on average during occupied hours?* - the answer, how it was read, the period and points queried, the rows, the SQL, and *2 model calls · $0.2313*. |
| `planner-question-2.png` | *How many readings did the collector store per day?* - the same parts; *187.68 hours of the period unrecorded* is the platform's gap figure, not the model's; *2 model calls · $0.0631*. |
| `cost-line.png` | The run's foot: both models, the calls, the tokens and $0.3012. |

## Method

`npm run bas:report:run -- --definition 2 --period-end
2026-09-29T13:00:00Z` on the development database, with the real
narrator (claude-opus-5-5) and the real planner (claude-opus-5, SQL as
`bas_analyze`), after the two questions were added to the report as
typed questions. Each capture is the stored `report_html` of run 18 opened
in Playwright's Chromium with `page.setContent` and an element screenshot
at 1100 px wide, device scale 1.5 - the same HTML the worker prints to
PDF.
