-- CreateTable
CREATE TABLE "bas_report_runs" (
    "run_id" BIGSERIAL NOT NULL,
    "report_id" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "trigger" TEXT NOT NULL,
    "period_start" TIMESTAMPTZ NOT NULL,
    "period_end" TIMESTAMPTZ NOT NULL,
    "timezone" TEXT NOT NULL,
    "started_by_id" UUID,
    "budget_usd" DECIMAL(8,2) NOT NULL,
    "cost_usd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ,
    "heartbeat_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "error" TEXT,
    "partial_reason" TEXT,
    "report_json" JSONB,
    "report_html" TEXT,
    "previous_run_id" BIGINT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bas_report_runs_pkey" PRIMARY KEY ("run_id")
);

-- CreateTable
CREATE TABLE "bas_report_findings" (
    "finding_id" BIGSERIAL NOT NULL,
    "run_id" BIGINT NOT NULL,
    "position" INTEGER NOT NULL,
    "question_key" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "subject_key" TEXT NOT NULL,
    "subject_name" TEXT NOT NULL,
    "equipment_id" BIGINT,
    "issue_code" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "likely_cause" TEXT,
    "recommended_action" TEXT,
    "fingerprint" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "first_seen_run_id" BIGINT,

    CONSTRAINT "bas_report_findings_pkey" PRIMARY KEY ("finding_id")
);

-- CreateIndex
CREATE INDEX "bas_report_runs_report_id_created_at_idx" ON "bas_report_runs"("report_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "bas_report_runs_status_idx" ON "bas_report_runs"("status");

-- CreateIndex
CREATE INDEX "bas_report_findings_run_id_position_idx" ON "bas_report_findings"("run_id", "position");

-- CreateIndex
CREATE INDEX "bas_report_findings_fingerprint_idx" ON "bas_report_findings"("fingerprint");

-- CreateIndex
CREATE INDEX "bas_report_findings_equipment_id_idx" ON "bas_report_findings"("equipment_id");

-- AddForeignKey
ALTER TABLE "bas_report_runs" ADD CONSTRAINT "bas_report_runs_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "bas_report_definitions"("report_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_report_runs" ADD CONSTRAINT "bas_report_runs_started_by_id_fkey" FOREIGN KEY ("started_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_report_runs" ADD CONSTRAINT "bas_report_runs_previous_run_id_fkey" FOREIGN KEY ("previous_run_id") REFERENCES "bas_report_runs"("run_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_report_findings" ADD CONSTRAINT "bas_report_findings_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "bas_report_runs"("run_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_report_findings" ADD CONSTRAINT "bas_report_findings_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "bas_equipment"("equipment_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_report_findings" ADD CONSTRAINT "bas_report_findings_first_seen_run_id_fkey" FOREIGN KEY ("first_seen_run_id") REFERENCES "bas_report_runs"("run_id") ON DELETE SET NULL ON UPDATE CASCADE;



-- =============================================================================
-- Everything above this line is what the Prisma migration engine emits for the
-- schema.prisma change (diffed against a database at head on 2026-11-11).
-- Everything below was written by hand, because Prisma cannot express it.
--
--   Section 1  Why: Reports, Phase 2 - the engine core. A run and its
--              findings. No deliveries, no PDF column (Phase 4).
--   Section 2  CHECK constraints.
--   Section 3  bas_v_data_dictionary, replaced to EXCLUDE the two new
--              platform-side tables as well.
--   Section 4  COMMENT ON.
--   Section 5  A defensive REVOKE, as add_bas_reports did.
-- =============================================================================


-- =============================================================================
-- SECTION 1 - what this is for
--
-- docs/bas-reports-tab-plan.md, Phase 2. A run is one execution of a report
-- definition over one period: it records what it covered (the period and the
-- building's zone at the time), what it cost (tokens and dollars, metered
-- from the model's own usage figures), how it ended (succeeded, partial with a
-- reason, failed with an error), the structured document it produced
-- (report_json) and the rendered page (report_html). Its findings are rows of
-- their own, one per equipment-or-point per issue, carrying the NUMBERS - the
-- actual value, the expected value, how long or how often, and when. The
-- model's contribution to a finding is two sentences, likely_cause and
-- recommended_action, and nothing in the renderer takes a number from them.
--
-- The run table is also the work queue Phase 3's worker claims from (status
-- queued, heartbeat_at), which is why those columns exist now with nothing
-- writing them but the dev script.
--
-- previous_run_id is the comparison: fingerprints are matched against the
-- previous finished run of the same definition to mark a finding new, still
-- open or cleared. A cleared finding is STORED on the new run, state cleared,
-- with the previous run's evidence, so the comparison is self-contained.
--
-- Both tables are PLATFORM-SIDE, like the five of Phase 1: a report document
-- is a derived artifact with the model's prose in it, not building data, and
-- bas_analyze must not read it - a model answering "what did the report say"
-- from the report would be reading its own earlier words back as evidence.
-- =============================================================================


-- =============================================================================
-- SECTION 2 - CHECK constraints
-- =============================================================================

ALTER TABLE bas_report_runs
  ADD CONSTRAINT bas_report_runs_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed')),
  ADD CONSTRAINT bas_report_runs_trigger_check
    CHECK (trigger IN ('scheduled', 'manual')),
  ADD CONSTRAINT bas_report_runs_period_order
    CHECK (period_start < period_end),
  ADD CONSTRAINT bas_report_runs_budget_positive
    CHECK (budget_usd > 0),
  ADD CONSTRAINT bas_report_runs_cost_nonnegative
    CHECK (cost_usd >= 0 AND input_tokens >= 0 AND output_tokens >= 0),
  -- A partial run says why; a failed run says what. Neither may be silent.
  ADD CONSTRAINT bas_report_runs_partial_has_reason
    CHECK (status <> 'partial' OR partial_reason IS NOT NULL),
  ADD CONSTRAINT bas_report_runs_failed_has_error
    CHECK (status <> 'failed' OR error IS NOT NULL),
  -- A finished run carries its document; a document belongs to a finished run.
  ADD CONSTRAINT bas_report_runs_finished_has_document
    CHECK (status NOT IN ('succeeded', 'partial') OR (report_json IS NOT NULL AND finished_at IS NOT NULL)),
  ADD CONSTRAINT bas_report_runs_not_its_own_previous
    CHECK (previous_run_id IS NULL OR previous_run_id <> run_id);

ALTER TABLE bas_report_findings
  ADD CONSTRAINT bas_report_findings_section_check
    CHECK (section IN ('summary', 'space_comfort', 'vav', 'ahu_rtu', 'hot_water',
                       'chilled_water', 'dx', 'schedules', 'data_health')),
  ADD CONSTRAINT bas_report_findings_priority_check
    CHECK (priority IN ('watch', 'action_needed')),
  ADD CONSTRAINT bas_report_findings_state_check
    CHECK (state IN ('new', 'still_open', 'cleared')),
  ADD CONSTRAINT bas_report_findings_subject_key_shape
    CHECK (subject_key ~ '^(equipment|point):[0-9]+$'),
  ADD CONSTRAINT bas_report_findings_fingerprint_shape
    CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT bas_report_findings_position_nonnegative
    CHECK (position >= 0),
  ADD CONSTRAINT bas_report_findings_names_not_blank
    CHECK (length(btrim(subject_name)) > 0 AND length(btrim(issue_code)) > 0 AND length(btrim(question_key)) > 0);


-- =============================================================================
-- SECTION 3 - bas_v_data_dictionary excludes the two new tables
--
-- The same decision as add_bas_reports, Section 3, for the same reason. The
-- model is told nothing about report runs or findings: it is refused them by
-- role, and a report's prose is not evidence about a building.
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
        'bas_report_findings'
      )
  AND c.relkind IN ('r','v')
ORDER BY c.relkind DESC, c.relname, a.attnum;

COMMENT ON VIEW bas_v_data_dictionary IS
  'The entire annotated BAS schema in one query. Intended to be selected and pasted into an '
  'LLM prompt as context, so the model writes SQL against documented columns rather than '
  'guessing from names. Scoped to bas_-prefixed objects: the platform''s own employee and '
  'audit tables are deliberately NOT exposed here; bas_station_credentials is excluded by '
  'name, and so are the seven report tables (bas_report_definitions, bas_report_questions, '
  'bas_report_recipients, bas_library_questions, bas_personal_questions, bas_report_runs, '
  'bas_report_findings) - configuration people typed and documents the platform wrote, not '
  'building data, and the model is refused them. Keep the COMMENT ON statements current - '
  'they are not decoration, they are the model''s only description of what the data means.';


-- =============================================================================
-- SECTION 4 - COMMENT ON, for a person reading the catalog
-- =============================================================================

COMMENT ON TABLE bas_report_runs IS
  'One execution of a report definition over one period (Reports, Phase 2). Status is queued '
  '(waiting for the worker, Phase 3), running, succeeded, partial (finished with what it had - '
  'partial_reason says why: the budget, no model key, a declined call) or failed (error says '
  'what). report_json is the structured document the renderer draws from; report_html is the '
  'same document rendered, for Phase 4''s PDF. Platform-side: excluded from '
  'bas_v_data_dictionary and withheld from bas_analyze.';
COMMENT ON COLUMN bas_report_runs.timezone IS
  'bas_sites.timezone at run time. The document''s local times are computed from it, so a '
  'later zone change does not re-read an old report.';
COMMENT ON COLUMN bas_report_runs.cost_usd IS
  'Dollars spent on model calls this run, metered from the model''s own usage counts through '
  'lib/modules/bas/reports/engine/pricing.ts. Compared with budget_usd before every call.';
COMMENT ON COLUMN bas_report_runs.previous_run_id IS
  'The previous finished run of the same definition, against which findings were marked new, '
  'still open or cleared. NULL on a definition''s first run: everything is new.';
COMMENT ON COLUMN bas_report_runs.heartbeat_at IS
  'Phase 3: the worker touches this while a run is in progress, so a run whose worker died '
  'can be told from one that is still working. The dev script sets it once.';

COMMENT ON TABLE bas_report_findings IS
  'The structured findings of a run, one per subject (an equipment or a point) per issue, in '
  'report order. evidence holds the numbers - actual, expected, duration or percent, when - '
  'and the renderer takes every number from here; likely_cause and recommended_action are the '
  'model''s two sentences, worded as likely, never as fact. state is new, still_open or '
  'cleared against the run''s previous_run_id; a cleared row carries the previous run''s '
  'evidence so the comparison is self-contained. Platform-side, like the run.';
COMMENT ON COLUMN bas_report_findings.fingerprint IS
  'sha256 of question_key, subject_key and issue_code. Stable across runs for the same '
  'problem on the same thing, which is what lets two runs be compared without the prose.';
COMMENT ON COLUMN bas_report_findings.subject_key IS
  'equipment:<bas_equipment.equipment_id> for an equipment finding, point:<bas_points.point_id> '
  'for a Data Health finding. The id part is what the fingerprint keys on; subject_name is '
  'what the report shows.';


-- =============================================================================
-- SECTION 5 - a defensive REVOKE, as add_bas_reports did
-- =============================================================================

DO $revoke$
DECLARE
    r text;
    t text;
BEGIN
    FOREACH r IN ARRAY ARRAY['bas_readonly_platform', 'bas_analyze', 'bas_collector'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            FOREACH t IN ARRAY ARRAY['bas_report_runs', 'bas_report_findings'] LOOP
                EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
            END LOOP;
        END IF;
    END LOOP;
END
$revoke$;
