# Planner questions on the report (2026-11-16)

The record for the pull request that made a report's planner questions
run (`feat/bas-reports-phase6`; `docs/09-bas-what-is-built.md` →
*Reports — Phase 6*; `WHY-ITS-BUILT-THIS-WAY.md` § 86), after the display
revision of the same day: the page and the PDF show the answer, a small
table and one grey line; how it was answered is behind a button on the
web run view only.

| Capture | What it shows |
|---|---|
| `web-panel-closed.png` | The *Planner questions* section of office run 18 (PHB Steel Place, the seven days ending 29 September 2026) on the web run view at 1440 px: each answer in prose, its results table with local dates (*22 Sept 2026*, not an ISO instant), the grey *Read N points on PHBoffice for … ; occupied hours from the Occupied point.* line - the occupancy clause only on the question about occupied hours - and the kit secondary Button *Show how this was answered*, collapsed. |
| `web-panel-open.png` | The first answer after a click: the button reads *Hide* and the panel shows how the question was read, the period queried, all 11 points, the SQL and *2 model calls · $0.2313 · 41.4 s*. |
| `pdf-planner-page-1.png`, `pdf-planner-page-2.png` | Pages 3 and 4 of run 18 re-rendered from its stored document and printed by the worker's Chromium renderer: where the section begins, and the first answer's list, table and grey line. No button, no panel, no SQL, no cost - checked in the PDF's own text as well as by eye. |
| `cost-line.png` | The run's foot: both models, the calls, the tokens and $0.3012. |

## Method

Run 18 is `npm run bas:report:run -- --definition 2 --period-end
2026-09-29T13:00:00Z` on the development database with the real narrator
(claude-opus-5-5) and planner (claude-opus-5, SQL as `bas_analyze`). The
web captures are the real run page from `npx next dev -p 3100` against
that database, signed in with a session cookie minted from `AUTH_SECRET`,
driven by Playwright (element screenshots; the toggle clicked in the
page). The PDF is `renderReportHtml(report_json)` printed with
`createChromiumRenderer`, the pages drawn by pdfjs onto a canvas. Nothing
on the run was rewritten: its stored `report_html` and PDF columns are as
the run left them.
