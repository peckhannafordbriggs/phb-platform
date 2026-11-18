# The report with every question in its own words (2026-11-13)

The record for the pull request that laid the rendered BAS health report
out question by question (`feat/bas-report-question-layout`, PR #123):
inside each section every question the report carries is a sub-heading in
the spec's words with its answer directly beneath it, the Point Inventory
keeps only its building lines, the Summary's halves are headed by Q1 and
Q2, and cleared findings are grouped under their question
(`docs/09-bas-what-is-built.md` → *Reports — every question on the page*;
`WHY-ITS-BUILT-THIS-WAY.md` § 84; `runbook.md` → *Every question is a
sub-heading on the report, and what the line under it means*).

| Capture | What it shows |
|---|---|
| `office-report.html` | The office's weekly report (definition 2, PHB Steel Place), run 12's stored document (the period 30 September to 7 October, the same period as run 10 so the collection incident reads *Still open*) rendered by this branch's `renderReportHtml`. Open it in a browser. |
| `office-report.png` | The same page, full height, at 1200 px wide: the inventory as five lines (types, classification, coverage, occupancy source, points in scope), the Summary under Q1 and Q2, each Not Monitored section as its questions with *Not monitored — this building does not trend: …* under each, Q8 *Not applicable*, and Data Health under Q20 with the incident block and its eighteen rows. |
| `pdf-first-page.png` | Page 1 of 4 of the PDF the real renderer (`createChromiumRenderer`) printed from that HTML, drawn by pdfjs at 1.6×: Letter, the report's name and period in the header, the inventory, the Summary under Q1 and Q2 and the start of Space Comfort, *Page 1 of 4* in the footer. |

## Method

`npm run bas:report:run -- --definition 2 --period-end 2026-10-07T00:00:00Z`
against the development database (after `prisma migrate deploy` brought it
up to `main`; it lacked `20261113090000_bas_report_runs_pdf`), with the
real narrator: run 12, succeeded, one finding, $0.0219, 7 s (run 11,
minutes earlier, was the same run before the Applies-to wording fix). A
scratchpad script then read run 12's `report_json`, rendered it through
this branch's `renderReportHtml` (14,287 bytes; the page stored on the run
is the previous commit's template, with the question table, at 19,474
bytes - the document is the same), printed it with the renderer the worker
uses (184,936 bytes, four pages), served `pdfjs-dist` and the PDF from a
local HTTP server to Playwright's Chromium to draw page one on a canvas,
and took a full-page screenshot of the HTML with `page.setContent`.
Nothing was written to the database by the capture; the PDF itself is not
committed.

On the office every question but Q20 is Not Monitored or Not Applicable
(`docs/bas-reports-phase-2-verification.md` → *The office inventory,
traced*), so the positive one-line answers and the per-question findings
tables are exercised by the fixture in `tests/bas-reports-render.test.tsx`
rather than by this capture.
