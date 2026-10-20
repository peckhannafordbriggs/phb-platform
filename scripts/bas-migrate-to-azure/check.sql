-- =============================================================================
-- STEP 3 of 3: check a TARGET database against the export in bas-migration-data/.
--
-- Read-only. Run from the same directory as the export and the import, after
-- the import has committed - and again any time later, for as long as the
-- files are kept:
--
--   psql "<target admin URL>" -f <repo>\scripts\bas-migrate-to-azure\check.sql
--
-- import.sql includes this same file inside its transaction, so the checks
-- that gated the commit and the checks you run afterwards are one set:
--
--   * every table's row count equals the manifest (vocabularies: at least,
--     and every exported row present with identical content)
--   * every table's fingerprint equals the manifest (the credentials table
--     excluding updated_by, which is meant to differ)
--   * every table's highest id equals the manifest
--   * readings: count, earliest, latest and distinct points equal the snapshot
--   * no foreign key from a bas_* table points at a missing row - including
--     credentials -> employees
--   * every sequence stands at or past its table's highest id
--   * the applied migrations match the source's
--
-- Exits non-zero, with the failing lines marked, if anything is off.
-- =============================================================================

\set ON_ERROR_STOP on
\set QUIET on
\pset pager off
\pset footer off
\set QUIET off

-- common.sql is already loaded when this file is included from import.sql.
SELECT to_regclass('mig_tables') IS NULL AS mig_need_common \gset
\if :mig_need_common
\ir common.sql
SELECT pg_temp.mig_gate();
\endif

CREATE TEMP TABLE mig_check_manifest (
    ordinal int, table_name text, kind text, order_by text, id_column text,
    sequence_name text, row_count bigint, checksum text, max_id bigint
);
\copy mig_check_manifest FROM 'bas-migration-data/manifest.csv' WITH (FORMAT csv, HEADER MATCH)

CREATE TEMP TABLE mig_check_snapshot (key text PRIMARY KEY, value text);
\copy mig_check_snapshot FROM 'bas-migration-data/snapshot.csv' WITH (FORMAT csv, HEADER MATCH)

-- The vocabularies are compared row by row against the files, not by
-- fingerprint: the target may legitimately hold MORE vocabulary rows than the
-- export (the production seed writes them too), and then the fingerprints
-- differ while nothing is wrong. What must hold is that every exported row is
-- present and identical.
CREATE TEMP TABLE mig_check_equipment_types (LIKE public.bas_equipment_types);
\copy mig_check_equipment_types FROM 'bas-migration-data/bas_equipment_types.csv' WITH (FORMAT csv, HEADER MATCH)

CREATE TEMP TABLE mig_check_point_roles (LIKE public.bas_point_roles);
\copy mig_check_point_roles FROM 'bas-migration-data/bas_point_roles.csv' WITH (FORMAT csv, HEADER MATCH)

CREATE TEMP TABLE mig_check_results (
    seq        serial PRIMARY KEY,
    subject    text,
    check_name text,
    expected   text,
    actual     text,
    ok         boolean
);

-- Row counts.
INSERT INTO mig_check_results (subject, check_name, expected, actual, ok)
SELECT m.table_name, 'row count',
       CASE WHEN m.kind = 'vocabulary' THEN '>= ' || m.row_count ELSE m.row_count::text END,
       x.row_count::text,
       CASE WHEN m.kind = 'vocabulary' THEN x.row_count >= m.row_count ELSE x.row_count = m.row_count END
  FROM mig_check_manifest m
  JOIN pg_temp.mig_measure() x USING (table_name)
 ORDER BY m.ordinal;

-- Fingerprints, for everything but the vocabularies.
INSERT INTO mig_check_results (subject, check_name, expected, actual, ok)
SELECT m.table_name, 'fingerprint', m.checksum, x.checksum, m.checksum = x.checksum
  FROM mig_check_manifest m
  JOIN pg_temp.mig_measure() x USING (table_name)
 WHERE m.kind <> 'vocabulary'
 ORDER BY m.ordinal;

-- Vocabularies: exported rows missing from the target or different in it.
INSERT INTO mig_check_results (subject, check_name, expected, actual, ok)
SELECT 'bas_equipment_types', 'exported rows missing or different', '0', count(*)::text, count(*) = 0
  FROM mig_check_equipment_types s
 WHERE NOT EXISTS (SELECT 1 FROM public.bas_equipment_types t WHERE t::text = s::text)
UNION ALL
SELECT 'bas_point_roles', 'exported rows missing or different', '0', count(*)::text, count(*) = 0
  FROM mig_check_point_roles s
 WHERE NOT EXISTS (SELECT 1 FROM public.bas_point_roles t WHERE t::text = s::text);

-- Highest ids.
INSERT INTO mig_check_results (subject, check_name, expected, actual, ok)
SELECT m.table_name, 'highest id', m.max_id::text, x.max_id::text, m.max_id IS NOT DISTINCT FROM x.max_id
  FROM mig_check_manifest m
  JOIN pg_temp.mig_measure() x USING (table_name)
 WHERE m.id_column IS NOT NULL
 ORDER BY m.ordinal;

-- Readings, against the snapshot.
INSERT INTO mig_check_results (subject, check_name, expected, actual, ok)
SELECT 'bas_readings', s.key, s.value, a.actual, s.value = a.actual
  FROM mig_check_snapshot s
  JOIN (VALUES
          ('readings_count',  (SELECT count(*)::text FROM public.bas_readings)),
          ('readings_min_ts', (SELECT min(ts)::text FROM public.bas_readings)),
          ('readings_max_ts', (SELECT max(ts)::text FROM public.bas_readings)),
          ('readings_points', (SELECT count(DISTINCT point_id)::text FROM public.bas_readings)),
          ('active_points',   (SELECT count(*)::text FROM public.bas_points WHERE is_active)),
          ('stations',        (SELECT count(*)::text FROM public.bas_stations))
       ) AS a(key, actual) USING (key)
 ORDER BY s.key;

-- Foreign keys: read from the catalog, so a new one is covered.
INSERT INTO mig_check_results (subject, check_name, expected, actual, ok)
SELECT child_table, 'orphans via ' || constraint_name || ' -> ' || parent_table, '0', orphans::text, orphans = 0
  FROM pg_temp.mig_fk_orphans();

-- Sequences.
INSERT INTO mig_check_results (subject, check_name, expected, actual, ok)
SELECT table_name, 'sequence ' || sequence_name || ' past highest id',
       '>= ' || coalesce(max_id::text, '(empty)'),
       coalesce(last_value::text, 'never called'),
       next_value_ok
  FROM pg_temp.mig_sequences();

-- Schema.
INSERT INTO mig_check_results (subject, check_name, expected, actual, ok)
SELECT '_prisma_migrations', 'latest applied migration', s.value, t.latest, s.value = t.latest
  FROM mig_check_snapshot s,
       (SELECT max(migration_name) AS latest FROM public._prisma_migrations
         WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) t
 WHERE s.key = 'latest_migration';

\echo ''
\echo '=== Checks'
SELECT CASE WHEN ok THEN 'ok  ' ELSE 'FAIL' END AS result, subject, check_name, expected, actual
  FROM mig_check_results
 ORDER BY seq;

\echo ''
\echo '=== bas_station_credentials.updated_by, as stored'
SELECT c.station_id, s.niagara_station_name, c.username, c.key_version, c.updated_at,
       c.updated_by, e.email AS updated_by_email
  FROM public.bas_station_credentials c
  JOIN public.bas_stations s USING (station_id)
  LEFT JOIN public.employees e ON e.id = c.updated_by
 ORDER BY c.station_id;

DO $$
DECLARE
    failed int;
    total  int;
BEGIN
    SELECT count(*) FILTER (WHERE NOT ok), count(*) INTO failed, total FROM mig_check_results;
    IF failed > 0 THEN
        RAISE EXCEPTION '% of % checks FAILED - see the lines marked FAIL above', failed, total;
    END IF;
    RAISE NOTICE 'all % checks passed', total;
END
$$;

DROP TABLE mig_check_manifest, mig_check_snapshot, mig_check_equipment_types,
           mig_check_point_roles, mig_check_results;
