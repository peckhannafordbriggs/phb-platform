-- AlterTable
ALTER TABLE "bas_sync_checkpoints" ADD COLUMN     "shortest_full_span_s" INTEGER;


-- =============================================================================
-- Everything above this line is what the Prisma migration engine emits for the
-- schema.prisma change. Everything below it was written by hand, because Prisma
-- cannot express it.
--
--   Section 1  Why: three things the horizon reporting got wrong on live.
--   Section 2  Backfill of shortest_full_span_s from the one observation held.
--   Section 3  bas_v_collection_health, replaced. roll_risk gains a state,
--              horizon_s becomes the SHORTEST measured span, three columns
--              appended.
--   Section 4  COMMENT ON.
-- =============================================================================


-- =============================================================================
-- SECTION 1 - what this is for
--
-- Read against the live database on 2026-09-18. Eight active office points
-- have capacity 500 and collection_interval_s NULL. All eight are
-- change-of-value trends: they have no interval, and Workbench shows none
-- because there is none. Six had never filled their buffer -
--
--   OccupancyCommand    71 of 500 over 207 days
--   Occupied           419 of 500 over 2.5 years
--   OperatingState     320 of 500 over 2.5 years
--   OperatingStateOR   307 of 500
--   OpState            301 of 500
--   System_Enable      317 of 500
--
-- and two were full and rolling: Unit$20Status and Unit_Status_Mode, 500 of
-- 500 over 36,470 s, ten hours.
--
-- Three things were wrong with how that was reported.
--
-- 1. The six not-full points read roll_horizon_unknown, and every message
--    beside that state said to fill in capacity and interval from Workbench.
--    There is nothing to fill in. An instruction that cannot be followed
--    teaches people to ignore the warning, which is how a real one is missed.
--
-- 2. A buffer below capacity has overwritten nothing. "We have not measured
--    the horizon" and "we may be losing data" are different statements, and
--    the view treated them as one: six provably safe points were counted at
--    risk.
--
-- 3. The important one. The measured horizon was the LATEST observation. The
--    same Unit_Status_Mode point measured about two hours on 2026-09-17 and
--    ten hours a day later - a fivefold swing, because a change-of-value
--    point's horizon is how hard the equipment is cycling, and this RTU is
--    suspected of short-cycling. Storing the latest reading let a quiet
--    afternoon erase the evidence that the buffer can collapse to two hours.
--    A point whose horizon has ever been two hours is a two-hour point.
--
-- So: three distinct states, named distinctly wherever a horizon is shown.
--
--   configured   capacity x collection_interval_s, an interval trend
--   measured     the buffer has been seen full; the horizon is the SHORTEST
--                full-buffer span ever observed. The guard and every risk
--                figure use this. The current span is reported beside it.
--   not_full     the buffer has never been seen full. Nothing has been
--                overwritten. Informational, not a warning, not a risk. The
--                screen says how full: 320 of 500.
--   unknown      none of the above: capacity is not recorded, or the station
--                reports no count. Still not safe, still amber.
--
-- Nothing in this schema, this view or the collector may guess an interval
-- from a change-of-value point's average record spacing. The spacing is the
-- equipment's behaviour, not a configured setting, and writing it into
-- collection_interval_s would make a derived guess look like a fact read
-- from Workbench.
-- =============================================================================


-- =============================================================================
-- SECTION 2 - backfill
--
-- The collector keeps shortest_full_span_s from here on, taking the LEAST of
-- the stored value and each pass's full-buffer span. The only observation
-- held today is observed_span_s from the last pass, so the two full points
-- start at 36,470 s. The two-hour observation of 2026-09-17 predates any
-- column that could have kept it and is not recoverable; runbook.md says how
-- a person lowers the value by hand from a recorded observation, and that
-- nothing may ever raise it.
--
-- Only a FULL buffer's span is a horizon, so only rows with count >= capacity
-- are backfilled. The six not-full points stay NULL, correctly. Delimited so
-- tests/bas-views.test.ts can run exactly this statement against fixture
-- rows: the migration itself runs once and cannot be re-run to prove it.
-- =============================================================================

-- BACKFILL BEGIN
UPDATE bas_sync_checkpoints c
   SET shortest_full_span_s = c.observed_span_s
  FROM bas_points p
 WHERE p.point_id = c.point_id
   AND p.capacity IS NOT NULL
   AND c.station_count IS NOT NULL
   AND c.station_count >= p.capacity
   AND c.observed_span_s IS NOT NULL
   AND c.shortest_full_span_s IS NULL;
-- BACKFILL END

DO $$
DECLARE
  filled integer;
  not_full integer;
BEGIN
  SELECT count(*) INTO filled FROM bas_sync_checkpoints WHERE shortest_full_span_s IS NOT NULL;
  SELECT count(*) INTO not_full
    FROM bas_sync_checkpoints c JOIN bas_points p USING (point_id)
   WHERE p.capacity IS NOT NULL AND c.station_count IS NOT NULL
     AND c.station_count < p.capacity;
  RAISE NOTICE 'add_bas_shortest_full_span: % point(s) hold a shortest full span; % point(s) have a buffer below capacity and stay NULL', filled, not_full;
END $$;


-- =============================================================================
-- SECTION 3 - bas_v_collection_health, replaced
--
-- CREATE OR REPLACE VIEW may only append columns, so every existing column
-- keeps its position, name and type. Three existing columns change MEANING:
--
--   measured_horizon_s   was the span of the buffer as last observed, when
--                        full. Now the SHORTEST full-buffer span ever
--                        observed: LEAST(shortest_full_span_s, the current
--                        full span). The LEAST is deliberate - if a writer
--                        ever records observed_span_s without maintaining the
--                        shortest, a shorter current span still governs.
--   horizon_s            still COALESCE(measured, configured), so it inherits
--                        the change. Everything downstream - roll_risk here,
--                        healthcheck.py check 2c, the screen's headroom and
--                        the shortest-horizon figure - guards on the shortest.
--   roll_risk            gains 'buffer_not_full', ranked after the three
--                        horizon-judged states and before unknown. A point
--                        with a configured horizon is judged by it whether or
--                        not its buffer is full: an interval trend fills at a
--                        known rate, and capacity x interval is what it will
--                        retain.
--
-- Appended:
--
--   shortest_full_span_s  the stored column, passed through
--   current_full_span_s   observed_span_s when count >= capacity now, else
--                         NULL. The span the station reports today, for the
--                         screen to show beside the shortest
--   horizon_state         'measured' / 'configured' / 'not_full' / 'unknown'.
--                         horizon_source keeps its two values and NULL for
--                         readers that already branch on it; this is the
--                         four-way word the screens use
--
-- Still cheap: reads checkpoints, never scans the readings table.
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
    hz.horizon_state
FROM bas_points p
JOIN      bas_stations         st ON st.station_id  = p.station_id
JOIN      bas_sites            s ON s.site_id       = st.site_id
JOIN      bas_orgs             o ON o.org_id        = s.org_id
LEFT JOIN bas_equipment        e ON e.equipment_id  = p.equipment_id
LEFT JOIN bas_sync_checkpoints c ON c.point_id      = p.point_id
-- The horizon arithmetic, once. Three steps because each reads the one before.
CROSS JOIN LATERAL (
    SELECT
        -- The span is a horizon only while the buffer is full. NULL when
        -- capacity is unknown too: a count of 500 looks like Niagara's default
        -- and is half of a 1000-record buffer.
        CASE WHEN p.capacity IS NOT NULL AND c.station_count >= p.capacity
             THEN c.observed_span_s END                             AS current_full_span_s,
        -- Seen with a count, and the count is below capacity: nothing has
        -- been overwritten.
        (p.capacity IS NOT NULL AND c.station_count IS NOT NULL
             AND c.station_count < p.capacity)                      AS not_full
) fill
CROSS JOIN LATERAL (
    SELECT
        -- LEAST ignores a NULL operand, so this is the shortest of whatever
        -- exists and NULL only when neither does.
        LEAST(c.shortest_full_span_s, fill.current_full_span_s)     AS measured_horizon_s
) m
CROSS JOIN LATERAL (
    SELECT
        m.measured_horizon_s,
        fill.current_full_span_s,
        fill.not_full,
        COALESCE(m.measured_horizon_s, p.roll_horizon_s)            AS horizon_s,
        CASE WHEN m.measured_horizon_s IS NOT NULL THEN 'measured'
             WHEN p.roll_horizon_s IS NOT NULL     THEN 'configured' END
                                                                    AS horizon_source,
        CASE WHEN m.measured_horizon_s IS NOT NULL THEN 'measured'
             WHEN p.roll_horizon_s IS NOT NULL     THEN 'configured'
             WHEN fill.not_full                    THEN 'not_full'
             ELSE 'unknown' END                                     AS horizon_state
) hz;


-- =============================================================================
-- SECTION 4 - COMMENT ON
-- =============================================================================

COMMENT ON VIEW bas_v_collection_health IS
'Per-point collection status. Cheap - reads checkpoints, never scans the readings table.

roll_risk is the important column. "data_lost" means more time has passed since our last
collected record than the station retains, so records have been overwritten and are gone
permanently. "at_risk" is past half that. "buffer_not_full" means the station reports fewer
records than its capacity: the buffer has never been seen full, nothing has been overwritten,
and there is no horizon to measure yet - informational, not a risk, and nothing to fill in.
"roll_horizon_unknown" means no horizon is known AND the buffer is not known to be below
capacity - capacity is not recorded, or the station reports no count. Treat unknown as a gap
in our knowledge, NOT as safety. Never render it green.

horizon_s is the retention the risk is judged against: the MEASURED horizon in preference to
the CONFIGURED capacity x collection_interval_s. The measured horizon is the SHORTEST
full-buffer span ever observed for the point (bas_sync_checkpoints.shortest_full_span_s,
LEAST-ed with the current full span), not the latest: a change-of-value point''s span moves
with how hard the equipment cycles, and a point whose buffer has ever spanned two hours is a
two-hour point. current_full_span_s is the span the station reports now, for display beside
it. horizon_source says measured / configured; horizon_state adds not_full / unknown.

A change-of-value trend has no collection interval. Never fill one in for it: its horizon is
measured once the buffer fills, and until then it reads buffer_not_full.

completeness is the second important column, from the collector''s per-pass comparison of the
station''s own record count against what we hold inside the station''s span. "incomplete" means
the station holds records the platform does not, after asking for everything - not lost yet,
and not arriving on its own. "backfilling" resolves itself. "unknown" is not green.

Filter by point_role to separate "a point is stale" from "a point that matters is stale",
and by site_id to scope to one building.';

COMMENT ON COLUMN bas_sync_checkpoints.shortest_full_span_s IS
  'The SHORTEST station end-minus-start span, in seconds, ever observed for this history '
  'while its buffer was full (station_count >= bas_points.capacity). Written by the '
  'collector every pass as LEAST(existing, this pass''s full span), so it only ever gets '
  'shorter. That is correct: a change-of-value point''s span is how hard the equipment is '
  'cycling, Unit_Status_Mode measured two hours one day and ten the next, and the horizon '
  'the guard must hold is the worst the buffer has been seen to do, not the latest. Never '
  'raise it by hand. The one legitimate reset is NULL after the history''s capacity is '
  'raised on the station, because the old observations describe a smaller buffer - and say '
  'so in bas_points.notes. Backfilled on 2026-09-18 from observed_span_s where the buffer '
  'was full. NULL means the buffer has never been seen full, which is not a risk.';

COMMENT ON COLUMN bas_sync_checkpoints.observed_span_s IS
  'The station''s reported end minus start for this history, in seconds, as the collector '
  'last measured it. Re-measured every pass because a change-of-value history''s span moves '
  'with how often the point changes. This is the CURRENT span, for display; the horizon the '
  'guard uses is shortest_full_span_s, and only while the buffer is full - station_count >= '
  'bas_points.capacity. A half-full buffer''s span is how much it holds so far, not how long '
  'it retains, and such a point has overwritten nothing. Kept distinct from '
  'bas_points.roll_horizon_s (capacity x interval, configured) on purpose: one is measured '
  'and one is configured, and they answer different questions.';
