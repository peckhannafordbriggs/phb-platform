# The report PDF: Print and Download on the run page, the PDF column on the list (2026-11-13)

The record for the pull request that shipped the PDF half of Reports
Phase 4 (`feat/bas-reports-pdf`): Chromium in the job image, the PDF
stored on the run, Print and Download on the run page, the PDF column
with Download and Retry PDF on the Reports list, and the queue's spin
guard (`docs/09-bas-what-is-built.md` → *Reports — Phase 4, the PDF
half*; `WHY-ITS-BUILT-THIS-WAY.md` § 83; `runbook.md` → *Reports: the
PDF*).

| Capture | What it shows |
|---|---|
| `run-view.png` | A run whose PDF is ready, at 1440 × 900: the Reports bar with *Print* (secondary) and the red *Download* at its right end - Freeze Protection's Report pair in the bar's `actions` slot - and the report beneath, the same page the PDF prints. |
| `run-view-bar.png` | The header and the bar alone, the same run. |
| `run-view-failed-bar.png` | A run whose render failed: *Retry PDF* beside *Print*, and *Download* greyed. The greyed button's tooltip (on its wrapper, since a disabled kit button takes no pointer events) reads *The PDF failed to render. Use Retry PDF. The PDF could not be rendered: Target page, context or browser has been closed. …* |
| `reports-list-pdf-column.png` | The Reports list with the new *PDF* column over three runs of one report: *Ready · 170 KB* with a live Download; *Failed* with a greyed Download and *Retry PDF*; *Not available* (a run from before PDFs) with a greyed Download whose tooltip reads *PDF not available for this run — use Re-run*. |
| `pdf-first-page.png` | The first of the stored PDF's three pages, drawn by pdfjs from the bytes the route served: Letter, the report's name at the top left and its period at the top right, *Page 1 of 3* at the bottom right, Figtree embedded, the page's own colours and status chips printed. |

## Method

Playwright's Chromium against a dev server of this branch on port 3100,
the server pointed at the **test** database rather than the development
one (the branch carries a migration). The test database was seeded with
the module rows, the owner's employee row with their Entra OID and the
BAS grant with the module-admin flag, one building, the shared library,
one weekly report and three finished runs: the newest with the sample
document (`tests/fixtures/bas-report-document.ts`) as its page and its
PDF rendered by the real `createChromiumRenderer` through the worker's
own `drainPdfQueue` (174,201 bytes, three pages); the middle one with a
failed render written onto its PDF columns; the oldest set to
`pdf_status = 'none'`. The session cookie was minted with `next-auth/jwt`
from `AUTH_SECRET`. The page-one capture serves `pdfjs-dist` from
`node_modules` over a local HTTP server and screenshots the canvas.

Read back from the live pages during the capture, not from the test
suite: the ready run's Download is enabled and carries the primary
class; `GET /api/modules/bas/reports/runs/3/pdf` answered 200,
`application/pdf`, 174,201 bytes beginning `%PDF-`, with
`Content-Disposition: attachment; filename="Office weekly health
2026-11-02 to 2026-11-09.pdf"`; the failed run's route answered 409
`pdf_not_available` with the render's own sentence; the list's three
rows read *Ready · 170 KB*, *Failed* (Retry PDF present) and *Not
available* with the Re-run tooltip.

Afterwards the test database was dropped and recreated with
`npm run db:test:setup`, so nothing of the seed outlives the capture.
