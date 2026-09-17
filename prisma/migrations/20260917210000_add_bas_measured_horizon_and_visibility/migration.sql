-- AlterTable
ALTER TABLE "bas_stations" ADD COLUMN     "clock_measured_at" TIMESTAMPTZ,
ADD COLUMN     "clock_offset_s" INTEGER;

-- AlterTable
ALTER TABLE "bas_sync_checkpoints" ADD COLUMN     "observed_span_s" INTEGER;


-- =============================================================================
-- Everything above this line is what the Prisma migration engine emits for the
-- schema.prisma change. Everything below it was written by hand, because Prisma
-- cannot express it.
--
--   Section 1  Why: the second thing the first sync of PHBoffice taught.
--   Section 2  bas_v_collection_health, replaced. Seven columns appended and
--              roll_risk taught to prefer a MEASURED horizon.
--   Section 3  COMMENT ON for the new columns and the view.
-- =============================================================================


-- =============================================================================
-- SECTION 1 - what this is for
--
-- Three things, all found on 2026-09-17 against the live PHBoffice JACE:
--
-- 1. The completeness check added by add_bas_completeness wrote its verdict to
--    bas_sync_checkpoints and nothing read it. Not this view, not the screen,
--    not healthcheck.py. A detector for silent loss that is itself silent is
--    the 28 August failure again - gaps recorded correctly and unread for eight
--    days. This view now carries the verdict, so the screen and the health
--    check can.
--
-- 2. A change-of-value history has no collection interval, so capacity x
--    interval - the only roll horizon this schema knew - is NULL for it and
--    the guard says "unknown". But the station reports count, start and end
--    for every history, and for a FULL buffer (count >= capacity) the span
--    from start to end IS the horizon, measured rather than configured.
--    Unit_Status_Mode on PHBoffice: 500 records over about two hours. Sixty
--    times shorter than every interval point on that station, and until now
--    the most at-risk point there read "unknown". observed_span_s is written
--    by the collector every pass; the view turns it into a horizon only when
--    the buffer is full, because a half-full buffer's span is not how long it
--    retains.
--
-- 3. The JACE's clock is 22 minutes ahead of the collector host. The
--    collector used to bound every query at the host's "now", so records the
--    station stamped in the host's future were invisible until they aged past
--    it - which read as a permanent 80-record shortfall on a chattering point.
--    The collector now measures the offset from /obix/about every pass and
--    records it here, because a station clock that is wrong also hides
--    staleness in this view (now() - last_record_ts goes negative) and
--    misaligns the building's data against every other station's.
-- =============================================================================


-- =============================================================================
-- SECTION 2 - bas_v_collection_health, replaced
--
-- CREATE OR REPLACE VIEW may only append columns, so every column
-- add_bas_tables defined keeps its position, name and type. What changes:
--
--   roll_risk    computed from horizon_s - the measured span when the buffer
--                is full, else capacity x interval - instead of from
--                roll_horizon_s alone. A COV point with a full buffer stops
--                reading roll_horizon_unknown and starts reading ok / at_risk /
--                data_lost against its real two-hour horizon.
--
-- Appended:
--
--   completeness, completeness_note, station_count, held_count,
--   completeness_checked_at    from add_bas_completeness, passed through
--   observed_span_s            the station's end - start, as the collector
--                              last measured it
--   measured_horizon_s         observed_span_s when count >= capacity, else
--                              NULL. NULL when capacity is unknown too: a
--                              buffer whose size nobody has filled in cannot
--                              be known to be full
--   horizon_s                  COALESCE(measured, configured). The one the
--                              screen and the health check should use
--   horizon_source             'measured' / 'configured' / NULL, so a reader
--                              can tell which question the number answers
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
        WHEN c.last_record_ts IS NULL THEN 'never_collected'
        WHEN COALESCE(
                 CASE WHEN p.capacity IS NOT NULL AND c.station_count >= p.capacity
                      THEN c.observed_span_s END,
                 p.roll_horizon_s) IS NULL                        THEN 'roll_horizon_unknown'
        WHEN now() - c.last_record_ts
             > make_interval(secs => COALESCE(
                 CASE WHEN p.capacity IS NOT NULL AND c.station_count >= p.capacity
                      THEN c.observed_span_s END,
                 p.roll_horizon_s))                                THEN 'data_lost'
        WHEN now() - c.last_record_ts
             > make_interval(secs => COALESCE(
                 CASE WHEN p.capacity IS NOT NULL AND c.station_count >= p.capacity
                      THEN c.observed_span_s END,
                 p.roll_horizon_s) / 2.0)                          THEN 'at_risk'
        ELSE 'ok'
    END AS roll_risk,

    c.completeness,
    c.completeness_note,
    c.station_count,
    c.held_count,
    c.completeness_checked_at,
    c.observed_span_s,
    CASE WHEN p.capacity IS NOT NULL AND c.station_count >= p.capacity
         THEN c.observed_span_s END                                AS measured_horizon_s,
    COALESCE(
        CASE WHEN p.capacity IS NOT NULL AND c.station_count >= p.capacity
             THEN c.observed_span_s END,
        p.roll_horizon_s)                                          AS horizon_s,
    CASE
        WHEN p.capacity IS NOT NULL AND c.station_count >= p.capacity
             AND c.observed_span_s IS NOT NULL                     THEN 'measured'
        WHEN p.roll_horizon_s IS NOT NULL                          THEN 'configured'
    END                                                            AS horizon_source
FROM bas_points p
JOIN      bas_stations         st ON st.station_id  = p.station_id
JOIN      bas_sites            s ON s.site_id       = st.site_id
JOIN      bas_orgs             o ON o.org_id        = s.org_id
LEFT JOIN bas_equipment        e ON e.equipment_id  = p.equipment_id
LEFT JOIN bas_sync_checkpoints c ON c.point_id      = p.point_id;


-- =============================================================================
-- SECTION 3 - COMMENT ON
-- =============================================================================

COMMENT ON VIEW bas_v_collection_health IS
'Per-point collection status. Cheap - reads checkpoints, never scans the readings table.

roll_risk is the important column. "data_lost" means more time has passed since our last
collected record than the station retains, so records have been overwritten and are gone
permanently. "roll_horizon_unknown" means no horizon is known - capacity or
collection_interval_s not filled in from Workbench AND no measured span for a full buffer -
so we cannot tell; treat that as a gap in our knowledge, NOT as safety. Never render it green.

horizon_s is the retention the risk is judged against: the MEASURED span (station end minus
start, when the station reports count >= capacity, i.e. the buffer is full and rolling) in
preference to the CONFIGURED capacity x collection_interval_s. horizon_source says which. A
change-of-value history has no interval and only ever has a measured horizon.

completeness is the second important column, from the collector''s per-pass comparison of the
station''s own record count against what we hold inside the station''s span. "incomplete" means
the station holds records the platform does not, after asking for everything - not lost yet,
and not arriving on its own. "backfilling" resolves itself. "unknown" is not green.

Filter by point_role to separate "a point is stale" from "a point that matters is stale",
and by site_id to scope to one building.';

COMMENT ON COLUMN bas_sync_checkpoints.observed_span_s IS
  'The station''s reported end minus start for this history, in seconds, as the collector '
  'last measured it. Re-measured every pass because a change-of-value history''s span moves '
  'with how often the point changes. This is a HORIZON only when the buffer is full - '
  'station_count >= bas_points.capacity - which is the condition bas_v_collection_health '
  'applies; a half-full buffer''s span is how much it holds so far, not how long it retains. '
  'Kept distinct from bas_points.roll_horizon_s (capacity x interval, configured) on purpose: '
  'one is measured and one is configured, and they answer different questions.';

COMMENT ON COLUMN bas_stations.clock_offset_s IS
  'The station''s clock minus the collector host''s clock, in seconds, measured from '
  '/obix/about serverTime on the collector''s last pass. Positive means the station is '
  'ahead. PHBoffice measured +1336 s on 2026-09-17 - 22 minutes - which made every record it '
  'wrote invisible to a query bounded at the host''s "now", and which makes '
  'seconds_since_last_record in bas_v_collection_health run 22 minutes optimistic for that '
  'station. Anything beyond a minute is worth fixing on the station (Workbench, or NTP), and '
  'is the station''s fault, not the collector''s.';

COMMENT ON COLUMN bas_stations.clock_measured_at IS
  'When clock_offset_s was last measured. NULL means the collector has not passed this '
  'station since the column existed.';
