-- CreateTable
CREATE TABLE "bas_report_definitions" (
    "report_id" BIGSERIAL NOT NULL,
    "owner_employee_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "site_id" BIGINT NOT NULL,
    "station_ids" BIGINT[] DEFAULT ARRAY[]::BIGINT[],
    "preset_key" TEXT,
    "analysis_window" TEXT NOT NULL DEFAULT '7d',
    "schedule_kind" TEXT NOT NULL,
    "schedule_params" JSONB NOT NULL DEFAULT '{}',
    "time_of_day" TEXT NOT NULL,
    "next_run_at" TIMESTAMPTZ,
    "state" TEXT NOT NULL DEFAULT 'draft',
    "budget_usd" DECIMAL(8,2) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "bas_report_definitions_pkey" PRIMARY KEY ("report_id")
);

-- CreateTable
CREATE TABLE "bas_report_questions" (
    "question_id" BIGSERIAL NOT NULL,
    "report_id" BIGINT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "library_question_id" BIGINT,
    "personal_question_id" BIGINT,
    "inline_text" TEXT,

    CONSTRAINT "bas_report_questions_pkey" PRIMARY KEY ("question_id")
);

-- CreateTable
CREATE TABLE "bas_library_questions" (
    "library_question_id" BIGSERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "analysis_fn" TEXT,
    "applies_to_label" TEXT NOT NULL,
    "applies_to_equipment" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "required_roles" JSONB NOT NULL DEFAULT '[]',
    "min_coverage" DECIMAL(4,3) NOT NULL DEFAULT 0.8,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "added_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bas_library_questions_pkey" PRIMARY KEY ("library_question_id")
);

-- CreateTable
CREATE TABLE "bas_personal_questions" (
    "personal_question_id" BIGSERIAL NOT NULL,
    "employee_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "bas_personal_questions_pkey" PRIMARY KEY ("personal_question_id")
);

-- CreateTable
CREATE TABLE "bas_report_recipients" (
    "recipient_id" BIGSERIAL NOT NULL,
    "report_id" BIGINT NOT NULL,
    "email" TEXT NOT NULL,
    "is_external" BOOLEAN NOT NULL,
    "confirmed_by_id" UUID,
    "confirmed_at" TIMESTAMPTZ,
    "added_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bas_report_recipients_pkey" PRIMARY KEY ("recipient_id")
);

-- CreateTable
CREATE TABLE "bas_site_occupancy" (
    "site_id" BIGINT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,

    CONSTRAINT "bas_site_occupancy_pkey" PRIMARY KEY ("site_id","weekday")
);

-- CreateIndex
CREATE INDEX "bas_report_definitions_site_id_idx" ON "bas_report_definitions"("site_id");

-- CreateIndex
CREATE INDEX "bas_report_definitions_state_next_run_at_idx" ON "bas_report_definitions"("state", "next_run_at");

-- CreateIndex
CREATE UNIQUE INDEX "bas_report_definitions_owner_employee_id_name_key" ON "bas_report_definitions"("owner_employee_id", "name");

-- CreateIndex
CREATE INDEX "bas_report_questions_report_id_position_idx" ON "bas_report_questions"("report_id", "position");

-- CreateIndex
CREATE INDEX "bas_report_questions_library_question_id_idx" ON "bas_report_questions"("library_question_id");

-- CreateIndex
CREATE INDEX "bas_report_questions_personal_question_id_idx" ON "bas_report_questions"("personal_question_id");

-- CreateIndex
CREATE UNIQUE INDEX "bas_library_questions_key_key" ON "bas_library_questions"("key");

-- CreateIndex
CREATE INDEX "bas_library_questions_section_position_idx" ON "bas_library_questions"("section", "position");

-- CreateIndex
CREATE INDEX "bas_personal_questions_employee_id_idx" ON "bas_personal_questions"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "bas_report_recipients_report_id_email_key" ON "bas_report_recipients"("report_id", "email");

-- AddForeignKey
ALTER TABLE "bas_report_definitions" ADD CONSTRAINT "bas_report_definitions_owner_employee_id_fkey" FOREIGN KEY ("owner_employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_report_definitions" ADD CONSTRAINT "bas_report_definitions_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "bas_sites"("site_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_report_questions" ADD CONSTRAINT "bas_report_questions_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "bas_report_definitions"("report_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_report_questions" ADD CONSTRAINT "bas_report_questions_library_question_id_fkey" FOREIGN KEY ("library_question_id") REFERENCES "bas_library_questions"("library_question_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_report_questions" ADD CONSTRAINT "bas_report_questions_personal_question_id_fkey" FOREIGN KEY ("personal_question_id") REFERENCES "bas_personal_questions"("personal_question_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_library_questions" ADD CONSTRAINT "bas_library_questions_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_personal_questions" ADD CONSTRAINT "bas_personal_questions_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_report_recipients" ADD CONSTRAINT "bas_report_recipients_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "bas_report_definitions"("report_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_report_recipients" ADD CONSTRAINT "bas_report_recipients_confirmed_by_id_fkey" FOREIGN KEY ("confirmed_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_report_recipients" ADD CONSTRAINT "bas_report_recipients_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_site_occupancy" ADD CONSTRAINT "bas_site_occupancy_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "bas_sites"("site_id") ON DELETE CASCADE ON UPDATE CASCADE;



-- =============================================================================
-- Everything above this line is what the Prisma migration engine emits for the
-- schema.prisma change (diffed against a database at head on 2026-11-10).
-- Everything below was written by hand, because Prisma cannot express it.
--
--   Section 1  Why: the Reports tab, Phase 1 - schema, the shared library,
--              report definitions. No runs, no jobs, no email, no PDF.
--   Section 2  CHECK constraints: the closed value sets, and the rules a
--              column cannot hold on its own.
--   Section 3  bas_v_data_dictionary, replaced to EXCLUDE the five
--              platform-side tables. Read that section before touching the
--              predicate.
--   Section 4  COMMENT ON.
--   Section 5  The shared library: the twenty questions of the build spec,
--              inserted with ON CONFLICT DO NOTHING so the seed and this file
--              converge on every database.
-- =============================================================================


-- =============================================================================
-- SECTION 1 - what this is for
--
-- docs/bas-reports-tab-plan.md, approved 2026-11-10, Phase 1. A person with the
-- BAS grant configures a health report - a building, a set of questions, an
-- analysis window, a schedule in the building's own zone, and who receives it
-- - and the platform stores the configuration. Running it is Phase 2 and 3:
-- bas_report_runs, bas_report_findings and bas_report_deliveries are NOT here,
-- deliberately, because nothing in this phase needs a foreign key to them.
--
-- Six tables:
--
--   bas_report_definitions   one configured report
--   bas_report_questions     its questions, in order; each from the shared
--                            library, the owner's personal library, or typed
--   bas_library_questions    the shared library (the spec's twenty, as
--                            'computed'; 'planner' rows arrive later)
--   bas_personal_questions   an employee's own saved questions
--   bas_report_recipients    ADDITIONAL recipients. The owner is never a row
--   bas_site_occupancy       occupied hours a person enters per building, the
--                            fallback when no occupancy point is trended.
--                            Nothing writes it in Phase 1
--
-- THE OWNER IS NOT A RECIPIENT ROW. The sender (Phase 4) adds the owner's
-- address from the employee record at send time, so no UI path and no API
-- path can drop the owner from a report; the recipients API refuses the
-- owner's address on the way in and on the way out. A row-based "owner
-- recipient" would be exactly the thing a bulk delete could remove.
--
-- Five of the six are PLATFORM-SIDE: configuration people typed, email
-- addresses, a person's own words. They match the bas_ prefix, and three
-- things key on that prefix - the data dictionary view (Section 3), the
-- bas_analyze allowlist and the collector role. Each has been told about them
-- by name; each is a decision recorded in its own file. bas_site_occupancy is
-- building data and stays visible.
-- =============================================================================


-- =============================================================================
-- SECTION 2 - CHECK constraints
--
-- CHECK-over-text rather than Postgres enums, as everywhere in this schema. The
-- two that matter most: an ACTIVE report must carry a next run (a scheduler
-- that finds an active report with no next_run_at has nothing to advance), and
-- an EXTERNAL recipient must carry a confirmation (the warn-and-confirm step
-- is enforced by the service, and this is what makes a row that skipped it
-- unstorable).
--
-- Prisma emits scalar-list columns without NOT NULL. The two list columns are
-- held NOT NULL here instead, as CHECKs, which Prisma neither sees nor drifts
-- on: the empty list is the "all" spelling and NULL would be a second one.
-- =============================================================================

ALTER TABLE bas_report_definitions
  ADD CONSTRAINT bas_report_definitions_name_not_blank
    CHECK (length(btrim(name)) > 0),
  ADD CONSTRAINT bas_report_definitions_station_ids_not_null
    CHECK (station_ids IS NOT NULL),
  ADD CONSTRAINT bas_report_definitions_preset_key_check
    CHECK (preset_key IS NULL OR preset_key IN ('health_weekly', 'health_daily')),
  ADD CONSTRAINT bas_report_definitions_analysis_window_check
    CHECK (analysis_window IN ('24h', '3d', '7d', '14d', '30d')),
  ADD CONSTRAINT bas_report_definitions_schedule_kind_check
    CHECK (schedule_kind IN ('daily', 'every_n_days', 'weekly', 'monthly')),
  ADD CONSTRAINT bas_report_definitions_time_of_day_check
    CHECK (time_of_day ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD CONSTRAINT bas_report_definitions_state_check
    CHECK (state IN ('draft', 'active', 'paused', 'paused_owner_disabled')),
  ADD CONSTRAINT bas_report_definitions_active_has_next_run
    CHECK (state <> 'active' OR next_run_at IS NOT NULL),
  ADD CONSTRAINT bas_report_definitions_budget_positive
    CHECK (budget_usd > 0);

ALTER TABLE bas_report_questions
  ADD CONSTRAINT bas_report_questions_kind_check
    CHECK (kind IN ('library', 'personal', 'inline')),
  ADD CONSTRAINT bas_report_questions_position_nonnegative
    CHECK (position >= 0),
  -- Exactly one source, decided by kind. A row carrying two would render as
  -- one question and run as another.
  ADD CONSTRAINT bas_report_questions_one_source
    CHECK (
         (kind = 'library'  AND library_question_id  IS NOT NULL AND personal_question_id IS NULL     AND inline_text IS NULL)
      OR (kind = 'personal' AND personal_question_id IS NOT NULL AND library_question_id  IS NULL     AND inline_text IS NULL)
      OR (kind = 'inline'   AND inline_text IS NOT NULL AND length(btrim(inline_text)) > 0
                            AND library_question_id IS NULL AND personal_question_id IS NULL)
    );

ALTER TABLE bas_library_questions
  ADD CONSTRAINT bas_library_questions_key_shape
    CHECK (key ~ '^[a-z0-9_]+$'),
  ADD CONSTRAINT bas_library_questions_section_check
    CHECK (section IN ('summary', 'space_comfort', 'vav', 'ahu_rtu', 'hot_water',
                       'chilled_water', 'dx', 'schedules', 'data_health')),
  ADD CONSTRAINT bas_library_questions_kind_check
    CHECK (kind IN ('computed', 'planner')),
  -- A computed question IS its function. A row without one would be a
  -- question nothing can answer.
  ADD CONSTRAINT bas_library_questions_computed_has_fn
    CHECK (kind <> 'computed' OR analysis_fn IS NOT NULL),
  ADD CONSTRAINT bas_library_questions_text_not_blank
    CHECK (length(btrim(text)) > 0),
  ADD CONSTRAINT bas_library_questions_applies_to_not_null
    CHECK (applies_to_equipment IS NOT NULL),
  ADD CONSTRAINT bas_library_questions_min_coverage_range
    CHECK (min_coverage >= 0 AND min_coverage <= 1),
  ADD CONSTRAINT bas_library_questions_position_positive
    CHECK (position > 0);

ALTER TABLE bas_personal_questions
  ADD CONSTRAINT bas_personal_questions_text_not_blank
    CHECK (length(btrim(text)) > 0);

ALTER TABLE bas_report_recipients
  ADD CONSTRAINT bas_report_recipients_email_shape
    CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'),
  -- Stored lower-cased, so the unique key on (report_id, email) means what it
  -- says and Jim@ and jim@ are one recipient.
  ADD CONSTRAINT bas_report_recipients_email_lower
    CHECK (email = lower(email)),
  ADD CONSTRAINT bas_report_recipients_external_confirmed
    CHECK (NOT is_external OR confirmed_at IS NOT NULL);

ALTER TABLE bas_site_occupancy
  ADD CONSTRAINT bas_site_occupancy_weekday_check
    CHECK (weekday BETWEEN 1 AND 7),
  ADD CONSTRAINT bas_site_occupancy_minutes_check
    CHECK (start_minute >= 0 AND end_minute <= 1440 AND start_minute < end_minute);


-- =============================================================================
-- SECTION 3 - bas_v_data_dictionary excludes the five platform-side tables
--
-- READ THIS BEFORE TOUCHING THE PREDICATE. add_bas_tables carries the first
-- warning about this view's filter; add_bas_projects the second. This is the
-- fourth exclusion and the same reasoning: the view is pasted into an LLM
-- prompt, and everything matching bas\_% goes in unless named here.
--
-- The five report tables are configuration people typed, email addresses, and
-- an employee's own questions. None of it is building data, the bas_analyze
-- role is refused all five by name (lib/modules/bas/analyze/role.ts), and a
-- model told about a table it will then be refused writes a query that fails
-- with "permission denied" and reports it could not answer. Telling it
-- nothing is the honest schema.
--
-- bas_site_occupancy IS included, deliberately. Occupied hours are building
-- data, "was the building occupied at 3am" is a fair question, and the role
-- may read it.
--
-- Phase 2's bas_report_runs, bas_report_findings and bas_report_deliveries
-- will need the same decision, in a new migration.
--
-- CREATE OR REPLACE: the column list is unchanged and nothing depends on it.
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
        'bas_personal_questions'
      )
  AND c.relkind IN ('r','v')
ORDER BY c.relkind DESC, c.relname, a.attnum;

COMMENT ON VIEW bas_v_data_dictionary IS
  'The entire annotated BAS schema in one query. Intended to be selected and pasted into an '
  'LLM prompt as context, so the model writes SQL against documented columns rather than '
  'guessing from names. Scoped to bas_-prefixed objects: the platform''s own employee and '
  'audit tables are deliberately NOT exposed here; bas_station_credentials is excluded by '
  'name, and so are the five report-configuration tables (bas_report_definitions, '
  'bas_report_questions, bas_report_recipients, bas_library_questions, '
  'bas_personal_questions) - configuration people typed, not building data, and the model '
  'is refused them. Keep the COMMENT ON statements current - they are not decoration, they '
  'are the model''s only description of what the data means.';


-- =============================================================================
-- SECTION 4 - COMMENT ON
--
-- bas_site_occupancy is in the dictionary, so every column is described for
-- the model. The other five are described for a person reading the catalog.
-- =============================================================================

COMMENT ON TABLE bas_site_occupancy IS
  'Occupied hours a person entered for a building, one range per weekday, in minutes from '
  'local midnight in bas_sites.timezone. The FALLBACK occupancy source for a scheduled health '
  'report when no station on the building trends an occupancy point (point_role '
  'occupancy_status or occupancy_cmd); a report says which source it used. A weekday with no '
  'row is unoccupied all day. Entered through the platform; nothing in Phase 1 writes it yet.';
COMMENT ON COLUMN bas_site_occupancy.site_id IS
  'The building (bas_sites).';
COMMENT ON COLUMN bas_site_occupancy.weekday IS
  'ISO weekday: 1 is Monday, 7 is Sunday.';
COMMENT ON COLUMN bas_site_occupancy.start_minute IS
  'When occupancy starts, as minutes after local midnight (480 is 08:00). Inclusive.';
COMMENT ON COLUMN bas_site_occupancy.end_minute IS
  'When occupancy ends, as minutes after local midnight (1080 is 18:00; 1440 is the end of the '
  'day). Exclusive, and always after start_minute.';

COMMENT ON TABLE bas_report_definitions IS
  'One configured BAS health report (Reports, Phase 1): a building, an ordered set of '
  'questions, an analysis window, a schedule in the building''s zone, a cost budget, and who '
  'receives it. The owner is an employee and is ALWAYS a recipient - never as a row in '
  'bas_report_recipients, always added by the sender at send time. Platform configuration, not '
  'building data: excluded from bas_v_data_dictionary and withheld from bas_analyze.';
COMMENT ON COLUMN bas_report_definitions.station_ids IS
  'The JACEs the report covers. EMPTY means every station on the building; a non-empty list is '
  'a subset. Never NULL (bas_report_definitions_station_ids_not_null).';
COMMENT ON COLUMN bas_report_definitions.preset_key IS
  'health_weekly (the spec''s twenty, fixed order) or health_daily (Summary, Space Comfort, '
  'Data Health). A preset report''s questions are the preset''s and cannot be edited; NULL is a '
  'custom report.';
COMMENT ON COLUMN bas_report_definitions.analysis_window IS
  'How far back each run looks: 24h, 3d, 7d, 14d or 30d. Independent of the schedule.';
COMMENT ON COLUMN bas_report_definitions.schedule_kind IS
  'daily, every_n_days, weekly or monthly. The kind''s parameters are schedule_params.';
COMMENT ON COLUMN bas_report_definitions.schedule_params IS
  'JSON for the kind: {} for daily; {intervalDays, anchorDate} for every_n_days; {weekdays: '
  '[1..7]} (ISO, Monday is 1) for weekly; {dayOfMonth} for monthly, clamped to the month.';
COMMENT ON COLUMN bas_report_definitions.time_of_day IS
  'Local wall-clock time of the run in bas_sites.timezone, as HH:MM. The stored thing is the '
  'LOCAL time; next_run_at is derived from it and the zone on every advance, never by adding '
  '24 hours to an instant, so a clock change cannot move a 06:00 report to 05:00.';
COMMENT ON COLUMN bas_report_definitions.next_run_at IS
  'The UTC instant of the next scheduled run, computed by lib/modules/bas/reports/schedule.ts. '
  'NOT NULL whenever state is active (bas_report_definitions_active_has_next_run). Phase 3''s '
  'scheduler reads and advances it; nothing in Phase 1 or 2 does.';
COMMENT ON COLUMN bas_report_definitions.state IS
  'draft (being set up; never runs), active (runs on schedule), paused (by a person), or '
  'paused_owner_disabled (the scheduler paused it because the owner''s account was disabled; '
  'a module admin reassigns the owner to resume). Nothing writes paused_owner_disabled before '
  'Phase 3.';
COMMENT ON COLUMN bas_report_definitions.budget_usd IS
  'Per-run model spend cap in US dollars. Stored in Phase 1; enforced by the worker from Phase 3, '
  'which finishes with what it has and marks the run partial when the cap bites.';

COMMENT ON TABLE bas_report_questions IS
  'The questions on one report, in position order. Each row has exactly one source, decided by '
  'kind: a shared-library question, one of the owner''s personal questions, or text typed into '
  'the report. A preset report''s rows are the preset expanded at write time, so Phase 2 reads '
  'one shape whatever the report''s origin.';
COMMENT ON COLUMN bas_report_questions.position IS
  'Zero-based order within the report. Rewritten 0..n-1 by the service on every change.';

COMMENT ON TABLE bas_library_questions IS
  'The shared question library. The twenty rows keyed q01_..q20_ are the build spec''s '
  'questions, kind computed: each is answered by the analysis function analysis_fn names, '
  'over the equipment types in applies_to_equipment, and only when every requirement in '
  'required_roles is met by points with at least min_coverage of the period trended. Rows of '
  'kind planner (added by module admins, later) are answered by the Analyze planner instead. '
  'Seeded by prisma/seed.ts and by the add_bas_reports migration from one TypeScript source.';
COMMENT ON COLUMN bas_library_questions.key IS
  'Stable identifier a preset names. qNN_ is the spec''s row number.';
COMMENT ON COLUMN bas_library_questions.position IS
  'The spec''s row number: the order questions appear in the standard report.';
COMMENT ON COLUMN bas_library_questions.analysis_fn IS
  'The function (Phase 2, lib/modules/bas/reports/) that computes this question. Required when '
  'kind is computed; NULL for planner questions.';
COMMENT ON COLUMN bas_library_questions.applies_to_label IS
  'The spec''s own "Applies to" wording, verbatim - "VAV with reheat", "DX with economizer". '
  'Shown beside the keys; the keys are what the engine uses.';
COMMENT ON COLUMN bas_library_questions.applies_to_equipment IS
  'Equipment type keys (bas_equipment_types.equip_type) the question applies to. EMPTY means '
  'the whole building. The spec''s Step 1 classifies units from their points; this is the '
  'widest set the question could apply to and the classifier narrows it per unit.';
COMMENT ON COLUMN bas_library_questions.required_roles IS
  'JSON array of requirement groups: [{label, anyOf: [[role, ...], ...]}]. A group is met when '
  'ANY alternative is met; an alternative is role keys (bas_point_roles.point_role) that must '
  'ALL be present. The spec''s Step 2: a question whose groups are not all met is Not '
  'Monitored, and the missing group''s label is what the report names.';
COMMENT ON COLUMN bas_library_questions.min_coverage IS
  'Fraction of the period each required point must have trend data for before the question '
  'is answered. The spec''s 80% rule: 0.800.';
COMMENT ON COLUMN bas_library_questions.enabled IS
  'A disabled question stays in the table (reports may reference it) and is offered to no new '
  'report.';

COMMENT ON TABLE bas_personal_questions IS
  'Questions an employee wrote and saved for reuse in their own reports. Theirs alone: listed '
  'to nobody else, usable in nobody else''s report. Deleting one that a report still uses is '
  'refused.';

COMMENT ON TABLE bas_report_recipients IS
  'ADDITIONAL recipients of a report, one row per address. The report''s owner is never a row '
  'here - the sender adds the owner''s address from the employee record at send time, which is '
  'what makes the owner impossible to drop. An address outside the company domain is '
  'is_external and must carry confirmed_by/confirmed_at: the person adding it saw the warning '
  'and confirmed (bas_report_recipients_external_confirmed).';
COMMENT ON COLUMN bas_report_recipients.email IS
  'The address, lower-cased. Unique per report.';
COMMENT ON COLUMN bas_report_recipients.is_external IS
  'TRUE for any address that is not a company address. Decided by the service when the row is '
  'added and recorded on the audit row beside it.';


-- =============================================================================
-- SECTION 5 - the shared library
--
-- The spec''s twenty questions, as rows. Same values as
-- lib/modules/bas/reports/library.ts, from which this block was generated; the
-- seed upserts the same rows, and ON CONFLICT (key) DO NOTHING makes this file
-- a no-op wherever the seed has already run. Never UPDATE here: `enabled` is
-- an admin''s decision and a deploy must not undo it.
-- =============================================================================

-- LIBRARY SEED BEGIN
-- Generated from lib/modules/bas/reports/library.ts; tests/bas-reports-library.test.ts
-- runs this block verbatim and compares the rows with that file. Edit the
-- TypeScript, then a NEW migration - never this block.
INSERT INTO bas_library_questions
  (key, section, position, text, kind, analysis_fn, applies_to_label, applies_to_equipment,
   required_roles, min_coverage, enabled)
VALUES
  ('q01_building_status', 'summary', 1,
   'What is the building status (Good, Watch, Action Needed), and what three findings drove it?',
   'computed', 'q01_building_status', 'All', ARRAY[]::text[],
   '[]'::jsonb, 0.800, true),
  ('q02_changes_since_last', 'summary', 2,
   'What''s new, what''s still open, and what cleared since last period?',
   'computed', 'q02_changes_since_last', 'All', ARRAY[]::text[],
   '[]'::jsonb, 0.800, true),
  ('q03_zone_comfort', 'space_comfort', 3,
   'What percent of occupied hours did each zone hold within ±2°F of setpoint?',
   'computed', 'q03_zone_comfort', 'All', ARRAY[]::text[],
   '[{"label":"space temp","anyOf":[["zone_temp"]]},{"label":"active setpoint (or heating and cooling setpoints)","anyOf":[["zone_temp_sp"],["zone_temp_cooling_sp","zone_temp_heating_sp"]]},{"label":"occupancy","anyOf":[["occupancy_status"],["occupancy_cmd"]]}]'::jsonb, 0.800, true),
  ('q04_worst_zones', 'space_comfort', 4,
   'Which 10 zones were out of range the most, how far off, and at what times of day?',
   'computed', 'q04_worst_zones', 'All', ARRAY[]::text[],
   '[{"label":"space temp","anyOf":[["zone_temp"]]},{"label":"active setpoint (or heating and cooling setpoints)","anyOf":[["zone_temp_sp"],["zone_temp_cooling_sp","zone_temp_heating_sp"]]},{"label":"occupancy","anyOf":[["occupancy_status"],["occupancy_cmd"]]}]'::jsonb, 0.800, true),
  ('q05_manual_overrides', 'space_comfort', 5,
   'Which setpoints or outputs are in manual override, and since when?',
   'computed', 'q05_manual_overrides', 'All', ARRAY[]::text[],
   '[{"label":"override or priority status","anyOf":[["occupancy_override"]]}]'::jsonb, 0.800, true),
  ('q06_vav_starved_airflow', 'vav', 6,
   'Which VAVs ran below 80% of airflow setpoint while occupied?',
   'computed', 'q06_vav_starved_airflow', 'VAV', ARRAY['vav']::text[],
   '[{"label":"airflow","anyOf":[["supply_air_flow"]]},{"label":"airflow setpoint","anyOf":[["supply_air_flow_sp"]]},{"label":"occupancy","anyOf":[["occupancy_status"],["occupancy_cmd"]]}]'::jsonb, 0.800, true),
  ('q07_vav_damper_full_missed_setpoint', 'vav', 7,
   'Which VAVs sat at 100% damper and still missed setpoint?',
   'computed', 'q07_vav_damper_full_missed_setpoint', 'VAV', ARRAY['vav']::text[],
   '[{"label":"damper position","anyOf":[["vav_damper_cmd"]]},{"label":"space temp","anyOf":[["zone_temp"]]},{"label":"active setpoint (or heating and cooling setpoints)","anyOf":[["zone_temp_sp"],["zone_temp_cooling_sp","zone_temp_heating_sp"]]}]'::jsonb, 0.800, true),
  ('q08_reheat_open_above_cooling_sp', 'vav', 8,
   'Which reheat valves were open while the zone was above cooling setpoint?',
   'computed', 'q08_reheat_open_above_cooling_sp', 'VAV with reheat', ARRAY['vav']::text[],
   '[{"label":"reheat valve command","anyOf":[["reheat_valve_cmd"]]},{"label":"space temp","anyOf":[["zone_temp"]]},{"label":"cooling setpoint","anyOf":[["zone_temp_cooling_sp"]]}]'::jsonb, 0.800, true),
  ('q09_dat_holds_setpoint', 'ahu_rtu', 9,
   'Did discharge air temp hold setpoint? ±1.5°F on modulating valves, ±4°F on staged DX.',
   'computed', 'q09_dat_holds_setpoint', 'AHU, RTU', ARRAY['ahu', 'rtu']::text[],
   '[{"label":"DAT","anyOf":[["supply_air_temp"],["discharge_air_temp"]]},{"label":"DAT setpoint","anyOf":[["supply_air_temp_sp"],["discharge_air_temp_sp"]]},{"label":"fan status","anyOf":[["supply_fan_status"]]}]'::jsonb, 0.800, true),
  ('q10_static_tracks_setpoint', 'ahu_rtu', 10,
   'Did duct static pressure track setpoint?',
   'computed', 'q10_static_tracks_setpoint', 'AHU, RTU', ARRAY['ahu', 'rtu']::text[],
   '[{"label":"duct static","anyOf":[["duct_static_pressure"]]},{"label":"static setpoint","anyOf":[["duct_static_pressure_sp"]]},{"label":"fan status","anyOf":[["supply_fan_status"]]}]'::jsonb, 0.800, true),
  ('q11_simultaneous_heating_cooling', 'ahu_rtu', 11,
   'Were heating and cooling on at the same time (valves open together, or heat stages and compressors on together)?',
   'computed', 'q11_simultaneous_heating_cooling', 'AHU, RTU', ARRAY['ahu', 'rtu']::text[],
   '[{"label":"heating valve or heat stage","anyOf":[["heating_valve_cmd"],["heating_stage_cmd"]]},{"label":"cooling valve or compressor status","anyOf":[["cooling_valve_cmd"],["compressor_status"],["compressor_cmd"],["cooling_stage_cmd"]]}]'::jsonb, 0.800, true),
  ('q12_economizer_at_minimum', 'ahu_rtu', 12,
   'Was the economizer at minimum when free cooling was available?',
   'computed', 'q12_economizer_at_minimum', 'AHU, RTU with economizer', ARRAY['ahu', 'rtu']::text[],
   '[{"label":"OA damper","anyOf":[["oa_damper_cmd"]]},{"label":"OAT","anyOf":[["outside_air_temp"]]},{"label":"RAT","anyOf":[["return_air_temp"]]}]'::jsonb, 0.800, true),
  ('q13_hw_supply_and_delta_t', 'hot_water', 13,
   'Did HW supply temp hold setpoint or reset, and was delta T at least 10°F?',
   'computed', 'q13_hw_supply_and_delta_t', 'Hydronic heating', ARRAY['boiler', 'plant_hw']::text[],
   '[{"label":"HWS temp","anyOf":[["hw_supply_temp"]]},{"label":"HWR temp","anyOf":[["hw_return_temp"]]},{"label":"HWS setpoint","anyOf":[["hw_supply_temp_sp"]]}]'::jsonb, 0.800, true),
  ('q14_chw_supply_and_delta_t', 'chilled_water', 14,
   'Did CHW supply temp hold setpoint, and was delta T at least 8°F?',
   'computed', 'q14_chw_supply_and_delta_t', 'Hydronic cooling', ARRAY['chiller', 'plant_chw']::text[],
   '[{"label":"CHWS temp","anyOf":[["chw_supply_temp"]]},{"label":"CHWR temp","anyOf":[["chw_return_temp"]]},{"label":"CHWS setpoint","anyOf":[["chw_supply_temp_sp"]]}]'::jsonb, 0.800, true),
  ('q15_compressor_short_cycling', 'dx', 15,
   'Are compressors short cycling (more than 4 starts per hour on any stage)?',
   'computed', 'q15_compressor_short_cycling', 'DX', ARRAY['rtu', 'ahu', 'split_system', 'crac', 'vrf_outdoor']::text[],
   '[{"label":"compressor status or stage command","anyOf":[["compressor_status"],["compressor_cmd"],["cooling_stage_cmd"]]}]'::jsonb, 0.800, true),
  ('q16_dx_cooling_delta', 'dx', 16,
   'With compressors running 15 minutes or more, did DAT drop at least 15°F below return or mixed air? Under 10°F points to low charge, a failed compressor, or a dirty coil.',
   'computed', 'q16_dx_cooling_delta', 'DX', ARRAY['rtu', 'ahu', 'split_system', 'crac', 'vrf_outdoor']::text[],
   '[{"label":"compressor status","anyOf":[["compressor_status"],["compressor_cmd"]]},{"label":"DAT","anyOf":[["supply_air_temp"],["discharge_air_temp"]]},{"label":"RAT or MAT","anyOf":[["return_air_temp"],["mixed_air_temp"]]}]'::jsonb, 0.800, true),
  ('q17_compressors_during_economizer', 'dx', 17,
   'Did compressors run while OAT was below 55°F with the economizer at minimum?',
   'computed', 'q17_compressors_during_economizer', 'DX with economizer', ARRAY['rtu', 'ahu', 'split_system', 'crac', 'vrf_outdoor']::text[],
   '[{"label":"compressor status","anyOf":[["compressor_status"],["compressor_cmd"]]},{"label":"OAT","anyOf":[["outside_air_temp"]]},{"label":"OA damper","anyOf":[["oa_damper_cmd"]]}]'::jsonb, 0.800, true),
  ('q18_heat_stage_delta', 'dx', 18,
   'With heat stages on 10 minutes or more, did DAT rise at least 20°F above return or mixed air?',
   'computed', 'q18_heat_stage_delta', 'Gas or electric heat', ARRAY['rtu', 'ahu', 'unit_heater', 'split_system']::text[],
   '[{"label":"heat stage status","anyOf":[["heating_stage_cmd"]]},{"label":"DAT","anyOf":[["supply_air_temp"],["discharge_air_temp"]]},{"label":"RAT or MAT","anyOf":[["return_air_temp"],["mixed_air_temp"]]}]'::jsonb, 0.800, true),
  ('q19_run_outside_schedule', 'schedules', 19,
   'What equipment ran outside its occupancy schedule, and for how many hours?',
   'computed', 'q19_run_outside_schedule', 'All', ARRAY[]::text[],
   '[{"label":"fan or equipment status","anyOf":[["supply_fan_status"],["return_fan_status"],["exhaust_fan_status"],["pump_status"],["chiller_status"],["boiler_status"],["compressor_status"],["tower_fan_status"]]},{"label":"occupancy schedule","anyOf":[["occupancy_status"],["occupancy_cmd"]]}]'::jsonb, 0.800, true),
  ('q20_data_health', 'data_health', 20,
   'Which points went offline, stopped trending, flat-lined, or read out of physical range?',
   'computed', 'q20_data_health', 'All', ARRAY[]::text[],
   '[]'::jsonb, 0.800, true)
ON CONFLICT (key) DO NOTHING;
-- LIBRARY SEED END


-- =============================================================================
-- SECTION 6 - a defensive REVOKE on the five platform-side tables
--
-- Belt and braces, as add_bas_projects did for the credentials table. No role
-- holds a grant on a table that did not exist a moment ago, so these change
-- nothing today; they are here so that a role script run out of order, or a
-- hand GRANT, is undone by the next deploy rather than kept. Guarded on each
-- role existing: a fresh database or CI has none of them, and an unguarded
-- REVOKE would fail the migration there.
--
-- The real boundary is each role's own script, which refuses to run until it
-- has been told about these tables by name: scripts/setup-bas-analyze-role.sql,
-- scripts/setup-bas-collector-role.sql, and setup_readonly_role_platform.sql
-- in phb-bas (runbook.md, *Reports (Phase 1)*).
-- =============================================================================

DO $revoke$
DECLARE
    r text;
    t text;
BEGIN
    FOREACH r IN ARRAY ARRAY['bas_readonly_platform', 'bas_analyze', 'bas_collector'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            FOREACH t IN ARRAY ARRAY['bas_report_definitions', 'bas_report_questions',
                                     'bas_report_recipients', 'bas_library_questions',
                                     'bas_personal_questions'] LOOP
                EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
            END LOOP;
        END IF;
    END LOOP;
END
$revoke$;
