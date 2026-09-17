-- AlterTable
ALTER TABLE "bas_ingest_runs" ADD COLUMN     "points_backfilling" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "points_incomplete" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "bas_sync_checkpoints" ADD COLUMN     "completeness" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN     "completeness_checked_at" TIMESTAMPTZ,
ADD COLUMN     "completeness_note" TEXT,
ADD COLUMN     "held_count" INTEGER,
ADD COLUMN     "station_count" INTEGER,
ADD COLUMN     "station_end" TIMESTAMPTZ,
ADD COLUMN     "station_start" TIMESTAMPTZ;


-- =============================================================================
-- Everything above this line is what the Prisma migration engine emits for the
-- schema.prisma change. Everything below it was written by hand, because Prisma
-- cannot express it.
--
--   Section 1  Why these columns exist: the failure they make visible.
--   Section 2  A CHECK on the completeness vocabulary - the sixteenth CHECK in
--              this schema.
--   Section 3  COMMENT ON for every new column. All of them are in
--              bas_v_data_dictionary, which feeds an LLM prompt.
--
-- Nothing here touches bas_readings, and nothing here is a data migration: the
-- collector fills every one of these columns in on its next pass. A row that
-- has not been passed yet reads `unknown`, which is the honest state.
-- =============================================================================


-- =============================================================================
-- SECTION 1 - the failure this makes visible
--
-- On 2026-09-16 the first sync of the PHBoffice JACE reported "28/28 points ok,
-- 9,784 records, status ok". Two of those points had collected ZERO records.
-- The station held 419 and 317 records for them going back to 2024-02-21; the
-- collector's first-sync window was 30 days; the newest record on each was
-- five days older than that window; every request came back empty; and an
-- empty pass is a successful pass. Read live, it was worse than two: four
-- points held nothing and three held two records of 320.
--
-- Every oBIX history object reports count, start and end. The station was
-- saying "419" on every pass, and nothing was listening. These columns are
-- where the collector now writes what the station said, what we hold inside
-- that span, and whether the two agree - so the disagreement is a row a person
-- or a screen can read, rather than a log line nobody sees.
--
-- The columns live on bas_sync_checkpoints because that is the per-point
-- statement of "how did collection go" - last_status is already here - and on
-- bas_ingest_runs as two counts, because a run in which a point is incomplete
-- must not read `ok`.
-- =============================================================================


-- =============================================================================
-- SECTION 2 - completeness is a closed set
--
-- Four values and no others. The collector writes them; the platform reads
-- them. A fifth value invented by a typo would render as nothing in particular
-- on every screen, which for a column whose entire job is to be noticed is
-- the wrong failure mode.
--
--   unknown       no count from the station, or never checked. Not green.
--   complete      within tolerance of the station's own count.
--   backfilling   short, and this pass hit its per-point request cap; the next
--                 pass continues from the checkpoint. Expected on a large first
--                 sync, and it resolves itself.
--   incomplete    short after asking for everything the station holds. Nothing
--                 further arrives on its own. This is the alarm.
-- =============================================================================

ALTER TABLE bas_sync_checkpoints
  ADD CONSTRAINT bas_sync_checkpoints_completeness_check
  CHECK (completeness IN ('unknown','complete','incomplete','backfilling'));

ALTER TABLE bas_ingest_runs
  ADD CONSTRAINT bas_ingest_runs_completeness_counts_nonnegative
  CHECK (points_incomplete >= 0 AND points_backfilling >= 0);


-- =============================================================================
-- SECTION 3 - COMMENT ON
--
-- Every column here is in bas_v_data_dictionary, so each needs a description
-- or the model guesses from the name. tests/bas-schema.test.ts asserts that
-- described columns carry non-empty prose.
-- =============================================================================

COMMENT ON COLUMN bas_sync_checkpoints.completeness IS
  'Does the platform hold what the station says it holds for this point, as of the last '
  'collector pass. One of unknown / complete / backfilling / incomplete, enforced by '
  'bas_sync_checkpoints_completeness_check. INCOMPLETE means the station reports records the '
  'platform does not have after the collector asked for everything - nothing further will arrive '
  'on its own, and a person needs to look. BACKFILLING means the same shortfall while a large '
  'first sync is still paging through the station; it resolves itself. UNKNOWN is not green: the '
  'station reported no count, or the point has never been checked. Compare station_count against '
  'held_count for the numbers; completeness_note says the same thing in a sentence.';

COMMENT ON COLUMN bas_sync_checkpoints.completeness_checked_at IS
  'When the completeness comparison was last made. NULL means never - the collector has not '
  'passed this point since the column existed.';

COMMENT ON COLUMN bas_sync_checkpoints.completeness_note IS
  'The completeness comparison as one sentence, written by the collector: the station''s count, '
  'ours, the shortfall, and whether the run was capped. For a person reading the row, not for '
  'parsing - the numbers are in station_count and held_count.';

COMMENT ON COLUMN bas_sync_checkpoints.station_count IS
  'The record count the station''s oBIX history object reported at the last check. Over '
  '[station_start, station_end]. NULL when the station did not report one.';

COMMENT ON COLUMN bas_sync_checkpoints.station_start IS
  'The oldest record the station still held at the last check, as it reported it. This moves '
  'forward on a rolling history as records are overwritten, and stands still on a change-of-value '
  'history that has years of records. The collector also uses it to measure a roll-overwrite gap '
  'exactly, in preference to inferring one from capacity x interval.';

COMMENT ON COLUMN bas_sync_checkpoints.station_end IS
  'The newest record the station held at the last check, as it reported it.';

COMMENT ON COLUMN bas_sync_checkpoints.held_count IS
  'Rows in bas_readings for this point with ts between station_start and station_end, counted at '
  'the last check. Scoped to the station''s own span deliberately: records the station has since '
  'rolled off - which the platform keeps, that is the point of the platform - are never counted '
  'against the station''s number. station_count minus held_count is the shortfall the completeness '
  'column judges.';

COMMENT ON COLUMN bas_ingest_runs.points_incomplete IS
  'How many points ended this run with completeness = incomplete: the station holds records the '
  'platform does not, after asking for everything. A run with any is recorded as partial, never '
  'ok. Which points: bas_sync_checkpoints WHERE completeness = ''incomplete''.';

COMMENT ON COLUMN bas_ingest_runs.points_backfilling IS
  'How many points hit the per-point request cap this run and continue on the next. Expected '
  'during a large first sync against a station holding years of history. Does not by itself '
  'change the run status; the collector prints it loudly instead.';
