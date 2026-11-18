-- AlterTable
ALTER TABLE "bas_report_runs" ADD COLUMN     "planner_answered" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "planner_asked" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "planner_cost_usd" DECIMAL(10,6) NOT NULL DEFAULT 0,
ADD COLUMN     "planner_skipped" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "planner_unanswered" INTEGER NOT NULL DEFAULT 0;



-- =============================================================================
-- Everything above this line is what the Prisma migration engine emits for the
-- schema.prisma change (diffed against the test database at head on
-- 2026-11-16). Everything below was written by hand, because Prisma cannot
-- express it.
--
--   Section 1  Why: Reports, Phase 6. Planner questions run, and a run says
--              how many were answered, unanswered and skipped, and what they
--              cost.
--   Section 2  CHECK constraints.
--   Section 3  COMMENT ON.
-- =============================================================================


-- =============================================================================
-- SECTION 1 - what this is for
--
-- docs/bas-reports-tab-plan.md, Phase 6 and D3 step 6. A report's custom,
-- personal and shared planner-kind questions are answered by the Analyze
-- planner, one call sequence per question, through the bas_analyze role.
-- The answers themselves live in the run's report_json - shown, never
-- tracked: no fingerprint, no finding row, no effect on the status - and
-- these five counters are what the Usage page and the next run read
-- without opening that document:
--
--   planner_asked       sent to the planner, so they cost something
--   planner_answered    answered from rows (a subset of asked)
--   planner_unanswered  a reason instead of an answer: no data, declined, a
--                       clarification nobody could give, not monitored or
--                       not applicable for a shared question with
--                       requirements, or not configured
--   planner_skipped     never sent: the run reached a half of the module's
--                       safety ceiling first
--   planner_cost_usd    the planner calls' share of cost_usd
--
-- The next run's per-question estimate is sum(planner_cost_usd) /
-- sum(planner_asked) over recent runs (engine/planner-questions.ts), which
-- is why the cost is kept apart from the narrative's.
-- =============================================================================


-- =============================================================================
-- SECTION 2 - CHECK constraints
-- =============================================================================

ALTER TABLE bas_report_runs
  ADD CONSTRAINT bas_report_runs_planner_counts_non_negative
    CHECK (planner_asked >= 0 AND planner_answered >= 0 AND planner_unanswered >= 0
           AND planner_skipped >= 0 AND planner_cost_usd >= 0),
  -- An answer needs a question sent; a question sent ends answered or not.
  ADD CONSTRAINT bas_report_runs_planner_answered_were_asked
    CHECK (planner_answered <= planner_asked),
  ADD CONSTRAINT bas_report_runs_planner_asked_were_decided
    CHECK (planner_asked <= planner_answered + planner_unanswered),
  -- The planner's share cannot exceed the whole.
  ADD CONSTRAINT bas_report_runs_planner_cost_within_total
    CHECK (planner_cost_usd <= cost_usd);


-- =============================================================================
-- SECTION 3 - COMMENT ON
-- =============================================================================

COMMENT ON COLUMN bas_report_runs.planner_asked IS
  'Planner questions sent to the Analyze planner in this run (Reports, Phase 6) - the ones that cost. Each ends answered or unanswered.';
COMMENT ON COLUMN bas_report_runs.planner_answered IS
  'Planner questions answered from rows. At most planner_asked.';
COMMENT ON COLUMN bas_report_runs.planner_unanswered IS
  'Planner questions with a reason instead of an answer: no data, declined, a clarification no one could give, not monitored or not applicable, or not configured. The reason is in report_json, verbatim.';
COMMENT ON COLUMN bas_report_runs.planner_skipped IS
  'Planner questions never sent because the run reached a half of the safety ceiling (bas_report_settings). Named in report_json and in partial_reason.';
COMMENT ON COLUMN bas_report_runs.planner_cost_usd IS
  'The planner calls'' share of cost_usd. With planner_asked, the history the next run''s per-question estimate is drawn from.';
