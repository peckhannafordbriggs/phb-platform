-- No schema.prisma change: this migration is hand-written in full, because
-- the one thing it changes is a CHECK constraint Prisma cannot see.
--
--   Section 1  Why: a Data Health collection incident is one finding whose
--              subject is a station and a time, not a point.
--   Section 2  The CHECK, widened.
--   Section 3  COMMENT ON.

-- =============================================================================
-- SECTION 1 - what this is for
--
-- The first production run of the office report (2026-11-12) listed ten of
-- the building's points as "No readings" since the same minute on the same
-- station - one event, read by the page as ten separate faults. From this
-- date the engine groups the points on one station whose last readings fall
-- within fifteen minutes of each other, three or more of them, into ONE
-- finding with issue_code collection_stopped: the points stay as rows in the
-- Data Health table, carried inside the finding's evidence, and the status
-- roll-up, the summary, the New / Still open / Cleared counts and the
-- narrative see one finding (lib/modules/bas/reports/engine/analysis/
-- data-health.ts). Its subject is the station and the minute the first point
-- stopped - station:<bas_stations.station_id>@<UTC minute, ISO> - so the
-- fingerprint keys on both: the same stop is Still open next week, a later
-- stop on the same station is a new incident.
--
-- add_bas_report_runs held subject_key to equipment:<id> or point:<id>. The
-- third shape is added here, as narrowly as it is written.
-- =============================================================================


-- =============================================================================
-- SECTION 2 - the CHECK
-- =============================================================================

ALTER TABLE bas_report_findings
  DROP CONSTRAINT bas_report_findings_subject_key_shape;

ALTER TABLE bas_report_findings
  ADD CONSTRAINT bas_report_findings_subject_key_shape
    CHECK (subject_key ~ '^(equipment|point):[0-9]+$'
        OR subject_key ~ '^station:[0-9]+@[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$');


-- =============================================================================
-- SECTION 3 - COMMENT ON
-- =============================================================================

COMMENT ON COLUMN bas_report_findings.subject_key IS
  'equipment:<bas_equipment.equipment_id> for an equipment finding, point:<bas_points.point_id> '
  'for a Data Health finding about one point, station:<bas_stations.station_id>@<UTC minute, ISO '
  'to the minute> for a Data Health collection incident - several points on the station whose '
  'last readings fall within fifteen minutes of each other, carried as one finding with the '
  'points in its evidence (2026-11-12). The id part, and for an incident the minute, is what '
  'the fingerprint keys on; subject_name is what the report shows.';
