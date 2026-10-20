-- =============================================================================
-- STEP 1 of 3: export the BAS tables from the SOURCE database to CSV files.
--
-- Reads only. Writes fourteen CSV files, a manifest and a snapshot record into
-- the directory  bas-migration-data/  under the CURRENT WORKING DIRECTORY
-- (psql's \copy cannot take a variable for the path, so the directory is fixed
-- and you choose it by choosing where you run this from). Create it first.
--
--   mkdir bas-migration-data
--   psql "<source DATABASE_URL>" -f <repo>\scripts\bas-migrate-to-azure\export.sql
--
-- Everything is read inside ONE REPEATABLE READ transaction, so the files are
-- a consistent snapshot even while the collector is writing: a reading that
-- lands during the export is in none of the files and is not in the manifest
-- either. The collector does not need to be stopped.
--
-- The manifest carries, per table, the row count, a fingerprint of the
-- contents and the highest id. import.sql loads it and refuses to commit until
-- the target measures the same; check.sql does the same again afterwards.
--
-- The export directory holds bas_station_credentials.csv, which is the
-- AES-256-GCM ciphertext of the Niagara logins. It is not the plaintext and it
-- is useless without BAS_CREDENTIAL_KEY, but treat the directory as you would
-- a database dump: it is gitignored, and delete it when the migration is done.
-- =============================================================================

\set ON_ERROR_STOP on
\set QUIET on
\pset pager off
\pset footer off
\set QUIET off

\echo ''
\echo '=== BAS export: source'
SELECT current_database() AS database,
       inet_server_addr()  AS server,
       current_user        AS connected_as,
       version()           AS server_version;

-- REPEATABLE READ is the snapshot. Not READ ONLY: that refuses the temp
-- tables common.sql creates, and nothing here writes a real table anyway.
BEGIN ISOLATION LEVEL REPEATABLE READ;

\ir common.sql

SELECT pg_temp.mig_gate();


-- --- the manifest --------------------------------------------------------------

CREATE TEMP TABLE mig_manifest AS
SELECT m.ordinal, m.table_name, t.kind, t.order_by, t.id_column, t.sequence_name,
       m.row_count, m.checksum, m.max_id
  FROM pg_temp.mig_measure() m
  JOIN mig_tables t USING (ordinal, table_name)
 ORDER BY m.ordinal;

-- Facts about the snapshot that are not per-table. The import prints them
-- back and compares the migration state; check.sql compares the readings.
CREATE TEMP TABLE mig_snapshot (key text PRIMARY KEY, value text);

INSERT INTO mig_snapshot VALUES
    ('exported_at',            now()::text),
    ('source_database',        current_database()),
    ('source_server_version',  current_setting('server_version')),
    ('latest_migration',       (SELECT max(migration_name) FROM _prisma_migrations
                                 WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)),
    ('readings_count',         (SELECT count(*)::text FROM bas_readings)),
    ('readings_min_ts',        (SELECT min(ts)::text FROM bas_readings)),
    ('readings_max_ts',        (SELECT max(ts)::text FROM bas_readings)),
    ('readings_points',        (SELECT count(DISTINCT point_id)::text FROM bas_readings)),
    ('active_points',          (SELECT count(*)::text FROM bas_points WHERE is_active)),
    ('stations',               (SELECT count(*)::text FROM bas_stations));

-- The one foreign key that leaves the bas_* family. The target has different
-- people with different ids, so the export carries the EMAIL of the employee
-- each credential row points at, and import.sql looks that email up in the
-- target. A row whose email is not found there stops the import.
CREATE TEMP TABLE mig_credentials_export AS
SELECT c.station_id, c.username, c.password_ciphertext, c.key_version, c.updated_at,
       e.email AS updated_by_email
  FROM bas_station_credentials c
  LEFT JOIN employees e ON e.id = c.updated_by
 ORDER BY c.station_id;

\echo ''
\echo '=== What will be exported'
SELECT ordinal, table_name, kind, row_count, max_id, checksum FROM mig_manifest ORDER BY ordinal;
SELECT key, value FROM mig_snapshot ORDER BY key;

\echo ''
\echo '=== bas_station_credentials.updated_by, carried as an email'
SELECT c.station_id, s.niagara_station_name, c.username, c.key_version, c.updated_at, c.updated_by_email
  FROM mig_credentials_export c
  JOIN bas_stations s USING (station_id)
 ORDER BY c.station_id;


-- --- the files -----------------------------------------------------------------
--
-- One per table, whole rows in primary-key order, header row included. The
-- import uses HEADER MATCH, so the header written here is checked against the
-- target table's columns: a column added on one side and not the other stops
-- the import rather than shifting values one column along.
--
-- Written in mig_tables order, and the file names are the table names.

\copy (SELECT * FROM bas_orgs             ORDER BY org_id)                                TO 'bas-migration-data/bas_orgs.csv'             WITH (FORMAT csv, HEADER)
\copy (SELECT * FROM bas_projects         ORDER BY project_id)                            TO 'bas-migration-data/bas_projects.csv'         WITH (FORMAT csv, HEADER)
\copy (SELECT * FROM bas_sites            ORDER BY site_id)                               TO 'bas-migration-data/bas_sites.csv'            WITH (FORMAT csv, HEADER)
\copy (SELECT * FROM bas_equipment_types  ORDER BY equip_type)                            TO 'bas-migration-data/bas_equipment_types.csv'  WITH (FORMAT csv, HEADER)
\copy (SELECT * FROM bas_point_roles      ORDER BY point_role)                            TO 'bas-migration-data/bas_point_roles.csv'      WITH (FORMAT csv, HEADER)
\copy (SELECT * FROM bas_stations         ORDER BY station_id)                            TO 'bas-migration-data/bas_stations.csv'         WITH (FORMAT csv, HEADER)
\copy (SELECT * FROM bas_equipment        ORDER BY equipment_id)                          TO 'bas-migration-data/bas_equipment.csv'        WITH (FORMAT csv, HEADER)
\copy (SELECT * FROM bas_points           ORDER BY point_id)                              TO 'bas-migration-data/bas_points.csv'           WITH (FORMAT csv, HEADER)
\copy (SELECT * FROM bas_readings         ORDER BY point_id, ts)                          TO 'bas-migration-data/bas_readings.csv'         WITH (FORMAT csv, HEADER)
\copy (SELECT * FROM bas_point_links      ORDER BY from_point_id, to_point_id, link_type) TO 'bas-migration-data/bas_point_links.csv'      WITH (FORMAT csv, HEADER)
\copy (SELECT * FROM bas_sync_checkpoints ORDER BY point_id)                              TO 'bas-migration-data/bas_sync_checkpoints.csv' WITH (FORMAT csv, HEADER)
\copy (SELECT * FROM bas_data_gaps        ORDER BY gap_id)                                TO 'bas-migration-data/bas_data_gaps.csv'        WITH (FORMAT csv, HEADER)
\copy (SELECT * FROM bas_ingest_runs      ORDER BY run_id)                                TO 'bas-migration-data/bas_ingest_runs.csv'      WITH (FORMAT csv, HEADER)

-- Not SELECT *: updated_by is replaced by updated_by_email (see above).
\copy (SELECT station_id, username, password_ciphertext, key_version, updated_at, updated_by_email FROM mig_credentials_export ORDER BY station_id) TO 'bas-migration-data/bas_station_credentials.csv' WITH (FORMAT csv, HEADER)

\copy (SELECT ordinal, table_name, kind, order_by, id_column, sequence_name, row_count, checksum, max_id FROM mig_manifest ORDER BY ordinal) TO 'bas-migration-data/manifest.csv' WITH (FORMAT csv, HEADER)
\copy (SELECT key, value FROM mig_snapshot ORDER BY key) TO 'bas-migration-data/snapshot.csv' WITH (FORMAT csv, HEADER)

COMMIT;

\echo ''
\echo 'Exported. Files are in bas-migration-data/ under the current directory.'
\echo 'Next: read import.sql, then run it against the TARGET from this same directory.'
\echo ''
