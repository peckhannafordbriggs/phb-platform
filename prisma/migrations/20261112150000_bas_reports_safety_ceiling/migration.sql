-- AlterTable
ALTER TABLE "bas_report_definitions" DROP COLUMN "budget_usd",
DROP COLUMN "max_minutes";

-- CreateTable
CREATE TABLE "bas_report_settings" (
    "settings_id" SMALLINT NOT NULL DEFAULT 1,
    "ceiling_usd" DECIMAL(8,2) NOT NULL DEFAULT 10,
    "ceiling_minutes" INTEGER NOT NULL DEFAULT 25,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bas_report_settings_pkey" PRIMARY KEY ("settings_id")
);

-- AddForeignKey
ALTER TABLE "bas_report_settings" ADD CONSTRAINT "bas_report_settings_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- =============================================================================
-- Everything above this line is what the Prisma migration engine emits for the
-- schema.prisma change (diffed against a database at head on 2026-11-12).
-- Everything below was written by hand, because Prisma cannot express it.
--
--   Section 1  Why: one module-level safety ceiling replaces the two
--              per-report caps.
--   Section 2  CHECK constraints, and the one row.
--   Section 3  bas_v_data_dictionary excludes the new table.
--   Section 4  COMMENT ON.
-- =============================================================================


-- =============================================================================
-- SECTION 1 - what this is for
--
-- docs/bas-reports-tab-plan.md §A (Limits) and §C (Usage), as changed on
-- 2026-11-12. Until now every report carried its own cost budget and time
-- cap (budget_usd, max_minutes on bas_report_definitions), set in the
-- editor's Limits section. Nobody wanted to decide a dollar figure per
-- report; what the module needs is one ceiling that no run may pass. So:
--
--   * bas_report_settings holds ONE row - the ceiling in dollars and in
--     minutes per run - edited by BAS module admins from the Usage page and
--     read by the engine for every run. Default $10.00 and 25 minutes.
--   * budget_usd and max_minutes are DROPPED from bas_report_definitions.
--     Nothing else read them: the engine took both from the definition at
--     run time and now takes both from the settings row, and the editor's
--     Limits section is gone. The create and update APIs refuse the two
--     keys with 400 so an old client fails loudly rather than silently.
--   * bas_report_runs.budget_usd STAYS. It is the ceiling in force when the
--     run executed - the record the Reports list and the run page print as
--     "$0.0397 of $10.00" - and a run keeps it after the ceiling changes.
--
-- A run that reaches either half of the ceiling finishes partial with the
-- reason naming it (lib/modules/bas/reports/engine/run.ts); neither aborts.
--
-- The single row is held by a CHECK on the primary key, and INSERTed here
-- so a database that has applied this migration always has it. The
-- application reads the defaults if the row is ever absent (the test suite
-- truncates employees CASCADE, which takes the row with it) and upserts it
-- on the first admin edit.
-- =============================================================================


-- =============================================================================
-- SECTION 2 - CHECK constraints, and the row
-- =============================================================================

ALTER TABLE bas_report_settings
  -- One row, ever.
  ADD CONSTRAINT bas_report_settings_single_row
    CHECK (settings_id = 1),
  -- A cap of a thousand dollars is one a runaway run never meets; the same
  -- bound the per-report budget carried.
  ADD CONSTRAINT bas_report_settings_ceiling_usd_range
    CHECK (ceiling_usd > 0 AND ceiling_usd <= 1000),
  -- 25 is the most, so the worker job's 30-minute replica timeout is always
  -- above it with the worker's drain window to spare (worker.ts).
  ADD CONSTRAINT bas_report_settings_ceiling_minutes_range
    CHECK (ceiling_minutes BETWEEN 1 AND 25);

INSERT INTO bas_report_settings (settings_id, ceiling_usd, ceiling_minutes)
VALUES (1, 10.00, 25)
ON CONFLICT (settings_id) DO NOTHING;


-- =============================================================================
-- SECTION 3 - bas_v_data_dictionary excludes the new table
--
-- The same decision as add_bas_reports, Section 3, for the same reason: a
-- module setting is platform configuration, not building data, and the
-- model is refused it by role. Every bas_* table is a decision to make.
-- =============================================================================

CREATE OR REPLACE VIEW bas_v_data_dictionary AS
SELECT
    c.relname AS object_name,
    CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' ELSE c.relkind::text END AS object_type,
    a.attname                            AS column_name,
    format_type(a.atttypid, a.atttypmod) AS data_type,
    NOT a.attnotnull                     AS is_nullable,
    col_description(c.oid, a.attnum)     AS column_description,
    obj_description(c.oid, 'pg_class')   AS object_description
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
WHERE n.nspname = 'public'
  AND c.relname LIKE 'bas\_%'
  AND c.relname <> 'bas_station_credentials'
  AND c.relname NOT IN (
        'bas_report_definitions',
        'bas_report_questions',
        'bas_report_recipients',
        'bas_library_questions',
        'bas_personal_questions',
        'bas_report_runs',
        'bas_report_findings',
        'bas_report_settings'
      )
  AND c.relkind IN ('r','v')
ORDER BY c.relkind DESC, c.relname, a.attnum;

COMMENT ON VIEW bas_v_data_dictionary IS
  'The entire annotated BAS schema in one query. Intended to be selected and pasted into an '
  'LLM prompt as context, so the model writes SQL against documented columns rather than '
  'guessing from names. Scoped to bas_-prefixed objects: the platform''s own employee and '
  'audit tables are deliberately NOT exposed here; bas_station_credentials is excluded by '
  'name, and so are the eight report tables (bas_report_definitions, bas_report_questions, '
  'bas_report_recipients, bas_library_questions, bas_personal_questions, bas_report_runs, '
  'bas_report_findings, bas_report_settings) - configuration people typed and documents the '
  'platform wrote, not building data, and the model is refused them. Keep the COMMENT ON '
  'statements current - they are not decoration, they are the model''s only description of '
  'what the data means.';


-- =============================================================================
-- SECTION 4 - COMMENT ON, for a person reading the catalog
-- =============================================================================

COMMENT ON TABLE bas_report_settings IS
  'The Reports module''s one safety ceiling (2026-11-12): the most a single run may spend and '
  'the longest it may take. One row (settings_id = 1), edited by BAS module admins from the '
  'Usage page, read by the engine for every run. A run that reaches either half finishes '
  'partial and says so. Platform configuration, not building data: excluded from '
  'bas_v_data_dictionary and withheld from bas_analyze and bas_collector.';
COMMENT ON COLUMN bas_report_settings.ceiling_usd IS
  'Dollars per run. Before every narrative call the engine estimates the call and stops asking '
  'the model when the run''s spend would pass this; the run finishes partial with the reason. '
  'Default $10.00; at most $1,000.';
COMMENT ON COLUMN bas_report_settings.ceiling_minutes IS
  'Minutes per run, 1 to 25. A deadline on the clock from the moment the engine starts; past '
  'it the questions and narrative still waiting are skipped and named, and the run finishes '
  'partial. Default and maximum 25, so the worker job''s 30-minute replica timeout is always '
  'above it.';
COMMENT ON COLUMN bas_report_settings.updated_by_id IS
  'The module admin who last changed the ceiling; NULL for the migration''s row. The audit row '
  'bas.report_ceiling_changed carries the previous and new values.';
COMMENT ON TABLE bas_report_definitions IS
  'One configured BAS health report (Reports, Phase 1): a building, an ordered set of '
  'questions, an analysis window, a schedule in the building''s zone, and who receives it. '
  'The owner is an employee and is ALWAYS a recipient - never as a row in '
  'bas_report_recipients, always added by the sender at send time. No per-report cost or time '
  'cap since 2026-11-12: the module''s safety ceiling (bas_report_settings) applies to every '
  'run. Platform configuration, not building data: excluded from bas_v_data_dictionary and '
  'withheld from bas_analyze.';
COMMENT ON COLUMN bas_report_definitions.preset_key IS
  'A label only (since 2026-11-12): which preset was last chosen in the editor - health_weekly '
  '(the spec''s twenty) or health_daily (Summary, Space Comfort, Data Health) - kept while the '
  'report''s shared questions still match that preset''s set and NULL as soon as they do not. '
  'It restricts nothing; the questions on any report are edited as a checklist.';
COMMENT ON COLUMN bas_report_runs.budget_usd IS
  'The module''s safety ceiling in dollars as it stood for this run: stamped from '
  'bas_report_settings when the run was queued and re-read when it executed. The Reports list '
  'and the run page print it beside cost_usd. Not a per-report setting since 2026-11-12.';
