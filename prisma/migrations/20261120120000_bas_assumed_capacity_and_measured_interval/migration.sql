-- AlterTable
ALTER TABLE "bas_points" ADD COLUMN     "measured_interval_s" INTEGER;

-- AlterTable
ALTER TABLE "bas_stations" ADD COLUMN     "assumed_capacity" INTEGER NOT NULL DEFAULT 500;

-- CreateTable
CREATE TABLE "bas_trend_summaries" (
    "summary_id" BIGSERIAL NOT NULL,
    "point_id" BIGINT NOT NULL,
    "range_key" TEXT NOT NULL,
    "range_from" TIMESTAMPTZ NOT NULL,
    "range_to" TIMESTAMPTZ NOT NULL,
    "newest_reading_at" TIMESTAMPTZ,
    "summary" TEXT,
    "declined" TEXT,
    "stats" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_write_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "requested_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bas_trend_summaries_pkey" PRIMARY KEY ("summary_id")
);

-- CreateIndex
CREATE INDEX "bas_trend_summaries_point_id_range_key_newest_reading_at_idx" ON "bas_trend_summaries"("point_id", "range_key", "newest_reading_at");

-- CreateIndex
CREATE INDEX "bas_trend_summaries_created_at_idx" ON "bas_trend_summaries"("created_at");

-- AddForeignKey
ALTER TABLE "bas_trend_summaries" ADD CONSTRAINT "bas_trend_summaries_point_id_fkey" FOREIGN KEY ("point_id") REFERENCES "bas_points"("point_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_trend_summaries" ADD CONSTRAINT "bas_trend_summaries_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- =============================================================================
-- Everything above this line is what the Prisma migration engine emits for the
-- schema.prisma change (diffed against a database at head on 2026-11-20), less
-- the `DROP INDEX "kb_chunks_embedding_hnsw_idx"` it always adds because
-- Prisma cannot express HNSW (tests/kb-schema.test.ts). Everything below was
-- written by hand, because Prisma cannot express it.
--
--   Section 1  Why.
--   Section 2  CHECK constraints.
--   Section 3  bas_v_collection_health, replaced: the horizon reads an
--              assumed capacity and a measured interval, roll_risk gains
--              short_horizon, five columns appended.
--   Section 4  bas_v_data_dictionary excludes bas_trend_summaries.
--   Section 5  COMMENT ON.
--   Section 6  A defensive REVOKE, as every platform-side bas_ table has.
-- =============================================================================


-- =============================================================================
-- SECTION 1 - what this is for
--
-- CEI_JCI_N2 (2026-11-19): 334 interval histories that report about every
-- 30 minutes, none with a capacity or an interval entered from Workbench.
-- Three screens read that as trouble that was not there:
--
--   Point Explorer   no interval, so the break threshold fell to its
--                    15-minute floor and every ordinary 30-minute gap was a
--                    "break" - about 280 per point per week, one line each.
--   Projects card    no capacity, so no horizon, so roll_horizon_unknown,
--                    which the one at-risk predicate counted: "334 points at
--                    risk", all of them unknown and none of them at risk.
--   Collection       the same 334, in the same hero tile.
--   Health
--
-- Two numbers fix the expectation, and both are labelled wherever they are
-- used so neither can be mistaken for a value read from Workbench:
--
--   bas_stations.assumed_capacity   500 by default - Niagara's standard
--                                   history capacity, which Nathan confirms
--                                   applies to nearly every point. Used only
--                                   where bas_points.capacity is NULL. A
--                                   person can change it per station in
--                                   Settings.
--   bas_points.measured_interval_s  the median gap between the point's
--                                   readings over the last seven days,
--                                   written by the scheduler pass; NULL when
--                                   the gaps are uneven (a change-of-value
--                                   trend has no interval) or there are too
--                                   few to judge. Used only where
--                                   collection_interval_s is NULL.
--
-- The 2026-09-18 rule this does not break: "nothing may guess an interval
-- from a change-of-value point's average record spacing ... writing it into
-- collection_interval_s would make a derived guess look like a fact read from
-- Workbench." measured_interval_s is a separate column, it is NULL for exactly
-- the uneven (change-of-value) trends, and collection_interval_s is untouched.
--
-- And the at-risk split. roll_horizon_unknown stays a state - "we cannot work
-- out how much history the station keeps" - but the screens stop counting it
-- as risk of data loss; it is its own muted line, "history size unknown". A
-- real roll risk is one the horizon shows: the collector has fallen behind
-- half of it (at_risk) or all of it (data_lost), or - new here - the horizon
-- itself is shorter than four collector polls (short_horizon), the
-- collector's own ROLL_SAFETY_FACTOR rule (phb-bas, sync.py): one missed run
-- and records are overwritten.
-- =============================================================================


-- =============================================================================
-- SECTION 2 - CHECK constraints
-- =============================================================================

ALTER TABLE bas_stations
  ADD CONSTRAINT bas_stations_assumed_capacity_range
    CHECK (assumed_capacity BETWEEN 1 AND 1000000);

ALTER TABLE bas_points
  ADD CONSTRAINT bas_points_measured_interval_positive
    CHECK (measured_interval_s IS NULL OR measured_interval_s > 0);

ALTER TABLE bas_trend_summaries
  ADD CONSTRAINT bas_trend_summaries_range_order
    CHECK (range_to > range_from),
  ADD CONSTRAINT bas_trend_summaries_summary_or_reason
    CHECK (summary IS NOT NULL OR declined IS NOT NULL),
  ADD CONSTRAINT bas_trend_summaries_counts_non_negative
    CHECK (input_tokens >= 0 AND output_tokens >= 0 AND cache_read_tokens >= 0
           AND cache_write_tokens >= 0 AND cost_usd >= 0);


-- =============================================================================
-- SECTION 3 - bas_v_collection_health, replaced
--
-- CREATE OR REPLACE VIEW may only append columns, so every existing column
-- keeps its position, name and type. What changes in meaning:
--
--   current_full_span_s  "full" is now station_count >= the EFFECTIVE
--                        capacity: the entered one, else the station's
--                        assumed one. A count of 500 against an assumed 500
--                        may be half of a real 1000-record buffer; its span
--                        is then SHORTER than the real horizon, so the error
--                        is towards warning, never towards calm. The collector
--                        still writes shortest_full_span_s only from an
--                        ENTERED capacity, so that stored minimum never holds
--                        an assumption.
--   not_full             the count is below the effective capacity.
--   horizon_s            COALESCE(measured, configured, estimated). The new
--                        third term is effective capacity x effective
--                        interval when either half was not entered - assumed
--                        capacity, measured interval, or both. Capped to fit
--                        the column's integer type.
--   horizon_source       'measured' / 'configured' / 'estimated' / NULL.
--   horizon_state        gains 'estimated', between configured and not_full.
--   roll_risk            gains 'short_horizon': a horizon shorter than four
--                        collector polls (900 s x 4 = 3600 s; the collector's
--                        POLL_INTERVAL_S x ROLL_SAFETY_FACTOR defaults, the
--                        same pair lib/modules/bas/types.ts names, held to
--                        this literal by tests/bas-views.test.ts). Ranked
--                        after data_lost and at_risk, which say the loss is
--                        happening, and before ok.
--
-- Appended:
--
--   effective_capacity    the capacity the horizon used
--   capacity_source       'entered' or 'assumed'
--   effective_interval_s  the interval the horizon used, or NULL
--   interval_source       'entered', 'measured' or NULL
--   estimated_horizon_s   effective capacity x effective interval when either
--                         half was not entered, else NULL
--
-- Still cheap: reads checkpoints and two columns, never the readings table.
-- =============================================================================

CREATE OR REPLACE VIEW bas_v_collection_health AS
SELECT
    p.point_id,
    COALESCE(p.display_name, p.niagara_history_name) AS point_name,
    p.point_role,
    p.unit,
    e.name AS equipment_name,
    s.site_id,
    s.name AS site_name,
    o.name AS org_name,
    st.station_id,
    st.niagara_station_name,
    p.is_active,
    p.collection_interval_s,
    p.capacity,
    p.full_policy,
    p.roll_horizon_s,

    c.last_record_ts,
    c.last_run_at,
    c.last_status,
    c.consecutive_failures,
    c.last_error,

    EXTRACT(EPOCH FROM (now() - c.last_record_ts))::bigint AS seconds_since_last_record,

    CASE
        WHEN c.last_record_ts IS NULL                                THEN 'never_collected'
        WHEN hz.horizon_s IS NOT NULL
             AND now() - c.last_record_ts
                 > make_interval(secs => hz.horizon_s)               THEN 'data_lost'
        WHEN hz.horizon_s IS NOT NULL
             AND now() - c.last_record_ts
                 > make_interval(secs => hz.horizon_s / 2.0)         THEN 'at_risk'
        -- Four collector polls of 900 s. See Section 3's header.
        WHEN hz.horizon_s IS NOT NULL AND hz.horizon_s < 3600        THEN 'short_horizon'
        WHEN hz.horizon_s IS NOT NULL                                THEN 'ok'
        WHEN hz.not_full                                             THEN 'buffer_not_full'
        ELSE 'roll_horizon_unknown'
    END AS roll_risk,

    c.completeness,
    c.completeness_note,
    c.station_count,
    c.held_count,
    c.completeness_checked_at,
    c.observed_span_s,
    hz.measured_horizon_s,
    hz.horizon_s,
    hz.horizon_source,
    c.shortest_full_span_s,
    hz.current_full_span_s,
    hz.horizon_state,
    eff.capacity              AS effective_capacity,
    eff.capacity_source,
    eff.interval_s            AS effective_interval_s,
    eff.interval_source,
    est.estimated_horizon_s
FROM bas_points p
JOIN      bas_stations         st ON st.station_id  = p.station_id
JOIN      bas_sites            s ON s.site_id       = st.site_id
JOIN      bas_orgs             o ON o.org_id        = s.org_id
LEFT JOIN bas_equipment        e ON e.equipment_id  = p.equipment_id
LEFT JOIN bas_sync_checkpoints c ON c.point_id      = p.point_id
-- The two numbers the horizon is built from, each with where it came from.
-- An entered value always wins; the assumed capacity is never NULL.
CROSS JOIN LATERAL (
    SELECT
        COALESCE(p.capacity, st.assumed_capacity)                   AS capacity,
        CASE WHEN p.capacity IS NOT NULL THEN 'entered'
             ELSE 'assumed' END                                     AS capacity_source,
        COALESCE(p.collection_interval_s, p.measured_interval_s)    AS interval_s,
        CASE WHEN p.collection_interval_s IS NOT NULL THEN 'entered'
             WHEN p.measured_interval_s IS NOT NULL   THEN 'measured' END
                                                                    AS interval_source
) eff
-- The horizon arithmetic, once. Each step reads the one before.
CROSS JOIN LATERAL (
    SELECT
        -- The span is a horizon only while the buffer is full, judged
        -- against the effective capacity.
        CASE WHEN c.station_count >= eff.capacity
             THEN c.observed_span_s END                             AS current_full_span_s,
        -- Seen with a count, and the count is below the effective capacity.
        (c.station_count IS NOT NULL
             AND c.station_count < eff.capacity)                    AS not_full
) fill
CROSS JOIN LATERAL (
    SELECT
        -- LEAST ignores a NULL operand, so this is the shortest of whatever
        -- exists and NULL only when neither does.
        LEAST(c.shortest_full_span_s, fill.current_full_span_s)     AS measured_horizon_s
) m
CROSS JOIN LATERAL (
    SELECT
        -- capacity x interval when either half was not entered. When both
        -- were, it is roll_horizon_s (the trigger's) and this stays NULL.
        CASE WHEN p.roll_horizon_s IS NULL AND eff.interval_s IS NOT NULL
             THEN LEAST(eff.capacity::bigint * eff.interval_s, 2147483647)::int
        END                                                         AS estimated_horizon_s
) est
CROSS JOIN LATERAL (
    SELECT
        m.measured_horizon_s,
        fill.current_full_span_s,
        fill.not_full,
        COALESCE(m.measured_horizon_s, p.roll_horizon_s, est.estimated_horizon_s)
                                                                    AS horizon_s,
        CASE WHEN m.measured_horizon_s IS NOT NULL   THEN 'measured'
             WHEN p.roll_horizon_s IS NOT NULL       THEN 'configured'
             WHEN est.estimated_horizon_s IS NOT NULL THEN 'estimated' END
                                                                    AS horizon_source,
        CASE WHEN m.measured_horizon_s IS NOT NULL   THEN 'measured'
             WHEN p.roll_horizon_s IS NOT NULL       THEN 'configured'
             WHEN est.estimated_horizon_s IS NOT NULL THEN 'estimated'
             WHEN fill.not_full                      THEN 'not_full'
             ELSE 'unknown' END                                     AS horizon_state
) hz;


-- =============================================================================
-- SECTION 4 - bas_v_data_dictionary excludes the new table
--
-- A trend summary is the model's own prose about a point, with what it cost:
-- a document the platform wrote, not building data. The same decision as the
-- report tables, and for the same reason - a model answering from it would be
-- reading its earlier words back as evidence.
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
        'bas_report_settings',
        'bas_report_deliveries',
        'bas_trend_summaries'
      )
  AND c.relkind IN ('r','v')
ORDER BY c.relkind DESC, c.relname, a.attnum;

COMMENT ON VIEW bas_v_data_dictionary IS
  'The entire annotated BAS schema in one query. Intended to be selected and pasted into an '
  'LLM prompt as context, so the model writes SQL against documented columns rather than '
  'guessing from names. Scoped to bas_-prefixed objects: the platform''s own employee and '
  'audit tables are deliberately NOT exposed here; bas_station_credentials is excluded by '
  'name, and so are the nine report tables (bas_report_definitions, bas_report_questions, '
  'bas_report_recipients, bas_library_questions, bas_personal_questions, bas_report_runs, '
  'bas_report_findings, bas_report_settings, bas_report_deliveries) and bas_trend_summaries - '
  'configuration people typed, documents the platform wrote and the addresses it sent them '
  'to, not building data, and the model is refused them. Keep the COMMENT ON statements '
  'current - they are not decoration, they are the model''s only description of what the '
  'data means.';


-- =============================================================================
-- SECTION 5 - COMMENT ON
-- =============================================================================

COMMENT ON VIEW bas_v_collection_health IS
'Per-point collection status. Cheap - reads checkpoints, never scans the readings table.

roll_risk is the important column. "data_lost" means more time has passed since our last
collected record than the station retains, so records have been overwritten and are gone
permanently. "at_risk" is past half that. "short_horizon" means the station keeps less history
than four collector polls (under an hour at the 15-minute poll): one missed run and records are
overwritten. Those three are a real risk of data loss. "buffer_not_full" means the station
reports fewer records than the capacity: nothing has been overwritten - informational, not a
risk. "roll_horizon_unknown" means no horizon can be worked out: no full buffer has been seen,
no interval is entered or measured to multiply the capacity by, and the station reports no count.
It is a gap in what we know, NOT safety and NOT a measured risk. Never render it green.

horizon_s is the retention the risk is judged against, in this order: the MEASURED horizon (the
SHORTEST full-buffer span ever observed, LEAST-ed with the current full span); the CONFIGURED
capacity x collection_interval_s, both entered from Workbench; the ESTIMATED effective capacity x
effective interval, where the capacity may be the station''s assumed_capacity and the interval
may be the measured one. capacity_source (entered / assumed) and interval_source (entered /
measured) say which; every screen labels an assumed or measured number as such. A buffer is
"full" when the station''s count reaches the effective capacity.

A change-of-value trend has no collection interval and none is measured for it (its gaps are
uneven): its horizon is measured once the buffer fills, and until then it reads buffer_not_full.

completeness is the second important column, from the collector''s per-pass comparison of the
station''s own record count against what we hold inside the station''s span. "incomplete" means
the station holds records the platform does not, after asking for everything - not lost yet,
and not arriving on its own. "backfilling" resolves itself. "unknown" is not green.

Filter by point_role to separate "a point is stale" from "a point that matters is stale",
and by site_id to scope to one building.';

COMMENT ON COLUMN bas_v_collection_health.roll_risk IS
  'never_collected, data_lost, at_risk, short_horizon (the horizon is under four collector polls), '
  'ok, buffer_not_full (informational) or roll_horizon_unknown (no horizon can be worked out; '
  'not a risk figure, never green). The view decides; nothing re-derives it.';
COMMENT ON COLUMN bas_v_collection_health.horizon_state IS
  'measured (the shortest full-buffer span seen), configured (capacity x interval from Workbench), '
  'estimated (capacity x interval with an assumed capacity or a measured interval), not_full, '
  'or unknown. The five-way word every screen that shows a horizon uses.';
COMMENT ON COLUMN bas_v_collection_health.horizon_source IS
  'measured, configured or estimated: which horizon horizon_s is. NULL when there is none.';
COMMENT ON COLUMN bas_v_collection_health.effective_capacity IS
  'The capacity the horizon used: bas_points.capacity when entered, else the station''s '
  'assumed_capacity (Niagara''s default of 500 unless changed in Settings).';
COMMENT ON COLUMN bas_v_collection_health.capacity_source IS
  'entered (bas_points.capacity, from Workbench) or assumed (bas_stations.assumed_capacity).';
COMMENT ON COLUMN bas_v_collection_health.effective_interval_s IS
  'The interval the horizon used: collection_interval_s when entered, else measured_interval_s, '
  'else NULL (a change-of-value trend, or nothing measured yet).';
COMMENT ON COLUMN bas_v_collection_health.interval_source IS
  'entered (collection_interval_s, from Workbench), measured (measured_interval_s, the median gap '
  'between readings) or NULL.';
COMMENT ON COLUMN bas_v_collection_health.estimated_horizon_s IS
  'effective_capacity x effective_interval_s, in seconds, when either was not entered; NULL when '
  'both were (that is roll_horizon_s) or there is no interval. An estimate, always labelled so.';

COMMENT ON COLUMN bas_stations.assumed_capacity IS
  'The history capacity assumed for this station''s points whose own capacity is not entered. '
  'Default 500, Niagara''s standard history capacity, which fits nearly every point. Edited in '
  'Settings. Read by bas_v_collection_health and the collector''s roll guard, each labelling '
  'the result "assumed"; bas_points.capacity, when entered, always wins.';
COMMENT ON COLUMN bas_points.measured_interval_s IS
  'The median gap between this point''s readings over the last seven days, in seconds, written '
  'by the platform''s scheduler pass. Set only when the gaps are even - at least 10 of them and '
  'four in five within a tenth of the median, the collector''s own spacing rule - and NULL for '
  'a change-of-value trend, which has no interval. Never copied into collection_interval_s: '
  'that column is what Workbench says, this is what the readings show.';

COMMENT ON TABLE bas_trend_summaries IS
  'One trend summary written on demand from Point Explorer (2026-11-20): the numbers code '
  'computed for one point over one range, the sentences the model wrote from them, and the '
  'tokens and dollars the call cost. Every call is a row; the screen reuses the newest row for '
  'the same point, range and newest reading. Platform data, not building data: excluded from '
  'bas_v_data_dictionary and withheld from bas_analyze and bas_collector.';
COMMENT ON COLUMN bas_trend_summaries.range_key IS
  'days:N for a preset range, dates:YYYY-MM-DD..YYYY-MM-DD for a custom one.';
COMMENT ON COLUMN bas_trend_summaries.newest_reading_at IS
  'The newest reading in the range when the numbers were computed. A newer reading makes the '
  'cached summary stale.';
COMMENT ON COLUMN bas_trend_summaries.stats IS
  'The numbers the model was given, exactly as sent. The model may use no number that is not here.';


-- =============================================================================
-- SECTION 6 - a defensive REVOKE, as add_bas_report_runs did
-- =============================================================================

DO $revoke$
DECLARE
    r text;
BEGIN
    FOREACH r IN ARRAY ARRAY['bas_readonly_platform', 'bas_analyze', 'bas_collector'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('REVOKE ALL ON TABLE public.bas_trend_summaries FROM %I', r);
        END IF;
    END LOOP;
END
$revoke$;
