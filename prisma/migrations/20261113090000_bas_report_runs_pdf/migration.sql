-- AlterTable
ALTER TABLE "bas_report_runs" ADD COLUMN     "pdf" BYTEA,
ADD COLUMN     "pdf_bytes" INTEGER,
ADD COLUMN     "pdf_error" TEXT,
ADD COLUMN     "pdf_queued_at" TIMESTAMPTZ,
ADD COLUMN     "pdf_rendered_at" TIMESTAMPTZ,
ADD COLUMN     "pdf_status" TEXT NOT NULL DEFAULT 'none';

-- CreateIndex
CREATE INDEX "bas_report_runs_pdf_status_idx" ON "bas_report_runs"("pdf_status");



-- =============================================================================
-- Everything above this line is what the Prisma migration engine emits for the
-- schema.prisma change (diffed against the test database at head on
-- 2026-11-13). Everything below was written by hand, because Prisma cannot
-- express it.
--
--   Section 1  Why: Reports, Phase 4, the PDF half. A run's report as a PDF,
--              rendered by the worker, stored on the run.
--   Section 2  CHECK constraints: the five columns beside the bytea agree
--              with pdf_status, and a run with no page has no PDF state.
--   Section 3  COMMENT ON.
-- =============================================================================


-- =============================================================================
-- SECTION 1 - what this is for
--
-- docs/bas-reports-tab-plan.md, Phase 4 and D6. After the engine stores a
-- run's report_html, the worker prints that same HTML to PDF with headless
-- Chromium (Letter, backgrounds, the report name and period in the header,
-- page numbers in the footer) and stores the bytes here, as bytea, per D6:
-- a report is a few hundred KB and a building reporting weekly adds tens
-- of MB a year. The runbook carries D6's tripwire - move to the backup
-- storage account's blob service when the table passes about 2 GB or more
-- than about twenty buildings report weekly - and the query that measures
-- it.
--
-- pdf_status is the small state machine beside the bytes:
--
--   none    no PDF and none asked for. Every run from before this migration,
--           and every run that has not finished. Download is offered greyed
--           with "use Re-run"; there is no Retry for it.
--   queued  a render is waiting for a worker: set by the engine the moment it
--           stores report_html, and by Retry PDF on a failed one. The worker
--           job's scaler counts these beside queued runs, so a retry wakes a
--           worker on its own. pdf_queued_at is set exactly while queued; the
--           scheduler's pass fails a render queued for more than an hour and
--           never picked up, the same guard it applies to a run.
--   ready   pdf holds the bytes; pdf_bytes is their length (so the Reports
--           list never reads the bytea) and pdf_rendered_at says when.
--   failed  pdf_error says why. A worker CLAIMS a queued render by writing
--           this state first, with a sentence saying a render started and
--           has not finished, and overwrites it with ready on success - so a
--           worker that dies mid-render leaves an honest row rather than a
--           render that reads "queued" forever, and Retry PDF is offered.
--
-- A failed render never fails the run: status, report_html and the findings
-- are what they were, and the page is still shown. The PDF is a copy of the
-- page, not the record.
-- =============================================================================


-- =============================================================================
-- SECTION 2 - CHECK constraints
-- =============================================================================

ALTER TABLE bas_report_runs
  ADD CONSTRAINT bas_report_runs_pdf_status_known
    CHECK (pdf_status IN ('none', 'queued', 'ready', 'failed')),
  -- The bytes, their length and their time exist exactly when the PDF is ready.
  ADD CONSTRAINT bas_report_runs_pdf_ready_has_bytes
    CHECK ((pdf_status = 'ready') = (pdf IS NOT NULL)),
  ADD CONSTRAINT bas_report_runs_pdf_ready_has_length
    CHECK ((pdf_status = 'ready') = (pdf_bytes IS NOT NULL)),
  ADD CONSTRAINT bas_report_runs_pdf_ready_has_time
    CHECK ((pdf_status = 'ready') = (pdf_rendered_at IS NOT NULL)),
  -- An error exists exactly when the render failed (or is in progress, which
  -- is recorded as a failure until it finishes).
  ADD CONSTRAINT bas_report_runs_pdf_failed_has_error
    CHECK ((pdf_status = 'failed') = (pdf_error IS NOT NULL)),
  -- The queue time exists exactly while queued.
  ADD CONSTRAINT bas_report_runs_pdf_queued_has_time
    CHECK ((pdf_status = 'queued') = (pdf_queued_at IS NOT NULL)),
  -- Nothing can be rendered from a run that stored no page: a queued, running
  -- or failed run has no PDF state at all.
  ADD CONSTRAINT bas_report_runs_pdf_needs_html
    CHECK (pdf_status = 'none' OR report_html IS NOT NULL);


-- =============================================================================
-- SECTION 3 - COMMENT ON, for a person reading the catalog
-- =============================================================================

COMMENT ON COLUMN bas_report_runs.pdf IS
  'The report as a PDF (Reports, Phase 4): report_html printed by the worker with headless '
  'Chromium - Letter, backgrounds, the report name and period in the header, page numbers in '
  'the footer. Stored as bytea per the plan''s D6; the runbook entry "Reports: the PDF" carries '
  'the tripwire for moving it to blob storage. Omitted from every Prisma read by the client''s '
  'global omit; a reader selects it by name. NULL unless pdf_status is ready.';
COMMENT ON COLUMN bas_report_runs.pdf_status IS
  'none (no PDF and none asked for: a run from before 2026-11-13, or one not finished), queued '
  '(a render is waiting for a worker; the worker job''s scaler counts it), ready (pdf holds it), '
  'failed (pdf_error says why; Retry PDF on the run page or the Reports list queues it again). '
  'A failed render never changes the run''s own status.';
COMMENT ON COLUMN bas_report_runs.pdf_error IS
  'Why the last PDF render failed, in plain words, or that a render started at a given time and '
  'has not finished - the worker writes that sentence when it claims a queued render and replaces '
  'it with ready on success, so a worker that dies mid-render leaves an honest row. Set exactly '
  'when pdf_status is failed.';
COMMENT ON COLUMN bas_report_runs.pdf_bytes IS
  'octet_length(pdf), stored when the PDF is rendered so the Reports list can show the size '
  'without reading the bytea. Set exactly when pdf_status is ready.';
COMMENT ON COLUMN bas_report_runs.pdf_queued_at IS
  'When the PDF render was asked for - by the engine as it stored the page, or by Retry PDF. '
  'Set exactly while pdf_status is queued; the scheduler''s pass fails a render queued for more '
  'than an hour and never picked up, with an error saying so.';
COMMENT ON COLUMN bas_report_runs.pdf_rendered_at IS
  'When the PDF was produced. Set exactly when pdf_status is ready.';
