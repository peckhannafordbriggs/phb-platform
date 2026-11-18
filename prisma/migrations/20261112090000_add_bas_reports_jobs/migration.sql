-- AlterTable
ALTER TABLE "bas_report_definitions" ADD COLUMN     "max_minutes" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "paused_reason" TEXT;

-- AlterTable
ALTER TABLE "bas_report_runs" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0;



-- =============================================================================
-- Everything above this line is what the Prisma migration engine emits for the
-- schema.prisma change (diffed against a database at head on 2026-11-12).
-- Everything below was written by hand, because Prisma cannot express it.
--
--   Section 1  Why: Reports, Phase 3 - the jobs. A time cap per definition,
--              the reason a report was paused, and a claim count per run.
--   Section 2  CHECK constraints.
--   Section 3  COMMENT ON.
-- =============================================================================


-- =============================================================================
-- SECTION 1 - what this is for
--
-- docs/bas-reports-tab-plan.md, Phase 3. Reports now run unattended: a
-- scheduler queues a run when a definition's next_run_at has passed, and a
-- worker claims queued runs and executes the engine on them.
--
-- max_minutes is the wall-clock cap on one run, beside budget_usd's cap on
-- its cost. The engine reads a deadline from it and, when the deadline
-- passes, finishes the sections it has and marks the run partial, with the
-- cap and what was skipped in partial_reason. It is bounded at 25 so that
-- the worker job's replicaTimeout (30 minutes) is always above it with
-- room for the worker's own drain window (lib/modules/bas/reports/worker.ts).
--
-- paused_reason is why the scheduler paused a report: today, only that the
-- owner's account is disabled. It is set with state paused_owner_disabled
-- and cleared when a module admin transfers the owner, which resumes the
-- report; the CHECK keeps the two in step.
--
-- attempts on a run counts the claims a worker has made on it. One is the
-- normal case; two means the run stalled (no heartbeat for ten minutes) and
-- was reclaimed; a run that stalls again is failed, never reclaimed a third
-- time. The claim's WHERE and the Container Apps scaler's query both read
-- it.
-- =============================================================================


-- =============================================================================
-- SECTION 2 - CHECK constraints
-- =============================================================================

ALTER TABLE bas_report_definitions
  ADD CONSTRAINT bas_report_definitions_max_minutes_range
    CHECK (max_minutes BETWEEN 1 AND 25),
  -- A reason is for the one state the scheduler pauses into; a report in any
  -- other state carries none, so a stale reason cannot outlive its pause.
  ADD CONSTRAINT bas_report_definitions_paused_reason_matches_state
    CHECK (paused_reason IS NULL OR state = 'paused_owner_disabled');

ALTER TABLE bas_report_runs
  ADD CONSTRAINT bas_report_runs_attempts_nonnegative
    CHECK (attempts >= 0);


-- =============================================================================
-- SECTION 3 - COMMENT ON, for a person reading the catalog
-- =============================================================================

COMMENT ON COLUMN bas_report_definitions.max_minutes IS
  'The wall-clock cap on one run, in minutes (Reports, Phase 3). The engine stops starting '
  'questions and narrative calls when a run has used this long, finishes with what it has, '
  'and marks the run partial naming the cap and what was skipped. 1 to 25; the module default '
  'is 20 (lib/modules/bas/reports/service.ts, DEFAULT_REPORT_MAX_MINUTES). Bounded so the '
  'worker job''s 30-minute replica timeout is always above it.';
COMMENT ON COLUMN bas_report_definitions.paused_reason IS
  'Why the scheduler paused this report, in plain words, set with state paused_owner_disabled '
  'and only then; cleared when a module admin transfers the owner, which resumes the report. '
  'NULL in every other state.';
COMMENT ON COLUMN bas_report_runs.attempts IS
  'How many times a worker has claimed this run (Reports, Phase 3). 1 is the normal case; 2 '
  'means the first worker stopped sending heartbeats and the run was reclaimed once; a run '
  'that stalls again is failed with an error saying so, never claimed a third time.';
