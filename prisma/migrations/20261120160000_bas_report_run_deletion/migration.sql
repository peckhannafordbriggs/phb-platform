-- DropIndex
DROP INDEX "bas_report_definitions_owner_employee_id_name_key";

-- AlterTable
ALTER TABLE "bas_report_definitions" ADD COLUMN     "deleted_at" TIMESTAMPTZ,
ADD COLUMN     "deleted_by_employee_id" UUID,
ADD COLUMN     "run_retention_months" INTEGER;

-- AlterTable
ALTER TABLE "bas_report_findings" ADD COLUMN     "first_seen_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "bas_report_runs" ADD COLUMN     "deleted_at" TIMESTAMPTZ,
ADD COLUMN     "deleted_by" TEXT,
ADD COLUMN     "deleted_by_employee_id" UUID,
ADD COLUMN     "restored_at" TIMESTAMPTZ;

-- CreateIndex
CREATE INDEX "bas_report_runs_deleted_at_idx" ON "bas_report_runs"("deleted_at");

-- AddForeignKey
ALTER TABLE "bas_report_definitions" ADD CONSTRAINT "bas_report_definitions_deleted_by_employee_id_fkey" FOREIGN KEY ("deleted_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_report_runs" ADD CONSTRAINT "bas_report_runs_deleted_by_employee_id_fkey" FOREIGN KEY ("deleted_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- =============================================================================
-- Everything above this line is what the Prisma migration engine emits for the
-- schema.prisma change (diffed against the test database at head on
-- 2026-11-20), less the `DROP INDEX "kb_chunks_embedding_hnsw_idx"` Prisma
-- always proposes because it cannot express HNSW (CLAUDE.md; the index stays).
-- Everything below was written by hand, because Prisma cannot express it.
--
--   Section 1  Why: deleting a report run, a recycle period, a per-report
--              retention setting, and deleting a report that has runs.
--   Section 2  Backfill: first_seen_at from the run that first saw the item.
--   Section 3  CHECK constraints.
--   Section 4  A report's name is unique among LIVE reports only.
--   Section 5  COMMENT ON.
-- =============================================================================


-- =============================================================================
-- SECTION 1 - what this is for
--
-- Until now a run was kept for ever (plan §A, Limits): nothing deleted one,
-- and a report with runs could not be deleted. From 2026-11-20:
--
--   Delete      the report's owner or a BAS module admin - the same people
--               who can see the run - moves one run or a selection to
--               Recently deleted: deleted_at, deleted_by = 'person' and
--               deleted_by_employee_id are set, and the run leaves the list,
--               the comparison and every action. Its findings, page and PDF
--               stay where they are.
--   Restore     clears the three and stamps restored_at. Nothing else
--               changes, so the run is back whole.
--   Purge       the scheduler job deletes a run RECYCLE_DAYS (15) after
--               deleted_at, and with it its findings and deliveries (both
--               ON DELETE CASCADE) and its PDF (a column of the row).
--   Retention   run_retention_months on a definition (3, 6, 12, or NULL for
--               never) makes the same scheduler pass move the report's
--               finished runs older than that to Recently deleted, as a
--               person's Delete would, with deleted_by = 'retention' - so
--               the 15-day undo applies to it too. A run a person restored
--               (restored_at set) is never taken by retention again.
--
-- A run is deleted only once it has finished (succeeded, partial or failed):
-- a queued or running one is the worker's, and the CHECK below holds that.
--
-- first_seen_at on a finding: "since 10/14" on a still-open item was read
-- through first_seen_run_id, which is ON DELETE SET NULL. Once runs can be
-- purged, the run that first saw a long-open item would take the date with
-- it, and every later report would print the item with no "since". The date
-- is now stored on the finding as well; the run is still read first, so
-- nothing changes while it exists.
--
-- Deleting a REPORT (the definition). Until now a report with runs could not
-- be deleted (409 report_has_runs; the run's foreign key is RESTRICT). Now
-- the owner or a module admin deletes it at any time except while one of
-- its runs is queued or running. A report with no runs at all is removed as
-- before. A report with runs is MARKED - deleted_at, deleted_by_employee_id
-- - because every run still reads its report for its name, its building and
-- who may see it: the report leaves every Scheduled list and never runs
-- again, its question rows are removed (they only drive future runs, and a
-- personal question they name could otherwise never be deleted), and its
-- runs are not touched - they stay on the Reports list, labelled "(schedule
-- deleted)", and open, download and email as before. Retention no longer
-- applies to them: a deleted report's runs go only by their own Delete.
-- =============================================================================


-- =============================================================================
-- SECTION 2 - backfill
-- =============================================================================

UPDATE bas_report_findings AS f
   SET first_seen_at = COALESCE(r.started_at, r.created_at)
  FROM bas_report_runs AS r
 WHERE r.run_id = f.first_seen_run_id
   AND f.first_seen_at IS NULL;


-- =============================================================================
-- SECTION 3 - CHECK constraints
-- =============================================================================

ALTER TABLE bas_report_definitions
  ADD CONSTRAINT bas_report_definitions_run_retention_months_valid
    CHECK (run_retention_months IS NULL OR run_retention_months IN (3, 6, 12));

ALTER TABLE bas_report_runs
  ADD CONSTRAINT bas_report_runs_deleted_by_valid
    CHECK (deleted_by IS NULL OR deleted_by IN ('person', 'retention')),
  -- Deleted means both: when, and by what.
  ADD CONSTRAINT bas_report_runs_deleted_pair
    CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
  -- Retention is nobody; a person may be NULL only after their row is gone.
  ADD CONSTRAINT bas_report_runs_deleted_employee_is_person
    CHECK (deleted_by_employee_id IS NULL OR deleted_by = 'person'),
  -- Only a finished run is deleted: a queued or running one is the worker's.
  ADD CONSTRAINT bas_report_runs_deleted_only_finished
    CHECK (deleted_at IS NULL OR status IN ('succeeded', 'partial', 'failed'));


-- =============================================================================
-- SECTION 4 - a report's name is unique among live reports only
--
-- The unique key on (owner_employee_id, name) is now a PARTIAL index, so a
-- deleted report gives its name back and its owner can make a new report
-- called the same. Prisma cannot express a partial index, so schema.prisma
-- carries no @@unique for it. Prisma 7.10's diff leaves it alone (checked
-- 2026-11-23: the only line it proposes is the HNSW one); if a later version
-- proposes `DROP INDEX "bas_report_definitions_owner_name_live_key"`, delete
-- that line - tests/bas-reports-run-deletion.test.tsx fails on it.
-- =============================================================================

CREATE UNIQUE INDEX bas_report_definitions_owner_name_live_key
    ON bas_report_definitions (owner_employee_id, name)
 WHERE deleted_at IS NULL;


-- =============================================================================
-- SECTION 5 - COMMENT ON
-- =============================================================================

COMMENT ON COLUMN bas_report_definitions.deleted_at IS
  'When the report was deleted. It never runs again and is on no Scheduled list; its runs stay on the Reports list, labelled "(schedule deleted)", until each is deleted by its own Delete. A report with no runs is removed outright instead of marked.';
COMMENT ON COLUMN bas_report_definitions.deleted_by_employee_id IS
  'Who deleted the report. The bas.report_deleted audit row says the same, with the runs kept.';

COMMENT ON COLUMN bas_report_definitions.run_retention_months IS
  '"Keep generated runs for": 3, 6 or 12 months, or NULL for never (the default). The scheduler moves a finished run older than this (by created_at) to Recently deleted with deleted_by = ''retention''; a run a person restored is never taken again.';
COMMENT ON COLUMN bas_report_findings.first_seen_at IS
  'When the item was first seen. Stored so the date survives the purge of the run that first saw it (first_seen_run_id goes NULL with that run); the run, while it exists, is read first.';
COMMENT ON COLUMN bas_report_runs.deleted_at IS
  'When the run was moved to Recently deleted; NULL for a run on the list. Purged by the scheduler 15 days later with its findings, deliveries and PDF. A deleted run is never the previous run of a comparison, and is never emailed.';
COMMENT ON COLUMN bas_report_runs.deleted_by IS
  'person (deleted_by_employee_id says who) or retention (the report''s run_retention_months). Set exactly when deleted_at is.';
COMMENT ON COLUMN bas_report_runs.deleted_by_employee_id IS
  'The person who deleted the run; NULL for retention. Not audited: the run is the owner''s own data, and this column is the record until the purge.';
COMMENT ON COLUMN bas_report_runs.restored_at IS
  'When a person last restored the run from Recently deleted. Retention never deletes a restored run again.';
