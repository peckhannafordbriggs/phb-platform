-- =============================================================================
-- STEP 2 of 3: load the exported BAS tables into the TARGET database.
--
-- Run from the SAME directory as export.sql was, so bas-migration-data/ is
-- beside you:
--
--   psql "<target admin URL>" -f <repo>\scripts\bas-migrate-to-azure\import.sql
--
-- It prints what it is about to do, asks for the word YES, does it, measures
-- the result against the manifest, and only then commits. Anything else -
-- a failed check, a wrong answer, a lost connection - rolls back, and the
-- target is exactly as it was. ONE transaction, start to finish.
--
-- WHAT IT REFUSES
--
--   * a target whose applied migrations differ from the source's
--   * a target where any bas_* data table already holds a row - this is a
--     one-shot load into empty tables, not a merge (a second run stops here)
--   * a vocabulary row (equipment types, point roles) that exists on both
--     sides with different content - identical rows are fine and are skipped
--   * a credential row whose updated_by email has no employee in the target
--   * a bas_* table that common.sql has never heard of, on either side
--   * a non-BAS table that measures differently at the end than at the start
--
-- HOW IT IS INCAPABLE OF WRITING THE PLATFORM'S TABLES
--
-- Every row is written by a role that exists only inside this transaction:
-- bas_migrate_tmp is created after the checks pass, granted SELECT and INSERT
-- on the fourteen bas_* tables, UPDATE on their eight sequences, SELECT on
-- two columns of employees (id, email - to resolve the credential rows), and
-- nothing else. The session switches to it with SET LOCAL ROLE before the
-- first COPY and back after the last, and the role is dropped before COMMIT.
-- A statement that reached employees, modules, module_grants, positions,
-- departments, audit_events or draft_locks would fail with permission denied
-- - and if the transaction rolls back, the role never existed at all.
--
-- Belt and braces: every non-bas_* table is fingerprinted before and after,
-- and a difference refuses the commit.
--
-- THE ONE MAPPING
--
-- bas_station_credentials.updated_by points at employees. The export replaced
-- the id with that employee's EMAIL; this file finds the target employee with
-- the same email and stores that id. It is shown in the plan, before YES. To
-- point a row at somebody else, edit updated_by_email in the CSV; to store
-- NULL ("not recorded", which the column allows), blank it.
--
-- To skip the prompt (for a scripted test run, never for production):
--   psql ... -v confirm=YES -f import.sql
-- =============================================================================

\set ON_ERROR_STOP on
\set QUIET on
\pset pager off
\pset footer off
\set QUIET off

\echo ''
\echo '=== BAS import: target'
SELECT current_database() AS database,
       inet_server_addr()  AS server,
       current_user        AS connected_as,
       version()           AS server_version;

BEGIN;
SET LOCAL statement_timeout = 0;

\ir common.sql

SELECT pg_temp.mig_gate();


-- --- what the export produced -------------------------------------------------

CREATE TEMP TABLE mig_manifest (
    ordinal int, table_name text, kind text, order_by text, id_column text,
    sequence_name text, row_count bigint, checksum text, max_id bigint
);
\copy mig_manifest FROM 'bas-migration-data/manifest.csv' WITH (FORMAT csv, HEADER MATCH)

CREATE TEMP TABLE mig_snapshot (key text PRIMARY KEY, value text);
\copy mig_snapshot FROM 'bas-migration-data/snapshot.csv' WITH (FORMAT csv, HEADER MATCH)

-- The three tables that are not copied straight in are staged first so the
-- plan can show what will happen to them before anything is written.
CREATE TEMP TABLE mig_stage_equipment_types (LIKE public.bas_equipment_types);
\copy mig_stage_equipment_types FROM 'bas-migration-data/bas_equipment_types.csv' WITH (FORMAT csv, HEADER MATCH)

CREATE TEMP TABLE mig_stage_point_roles (LIKE public.bas_point_roles);
\copy mig_stage_point_roles FROM 'bas-migration-data/bas_point_roles.csv' WITH (FORMAT csv, HEADER MATCH)

CREATE TEMP TABLE mig_stage_credentials (
    station_id bigint, username text, password_ciphertext text, key_version int,
    updated_at timestamptz, updated_by_email text
);
\copy mig_stage_credentials FROM 'bas-migration-data/bas_station_credentials.csv' WITH (FORMAT csv, HEADER MATCH)


-- --- the tables that must not change: measured now, compared before COMMIT ----

CREATE TEMP TABLE mig_protected_before AS SELECT * FROM pg_temp.mig_protected();


-- --- preconditions ---------------------------------------------------------------

DO $$
DECLARE
    source_migration text;
    target_migration text;
    bad  text[];
    n    int;
BEGIN
    IF current_setting('server_version_num')::int < 160000 THEN
        RAISE EXCEPTION 'this file needs PostgreSQL 16 or newer (GRANT ... WITH SET TRUE); the target is %',
            current_setting('server_version');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolcreaterole OR rolsuper)) THEN
        RAISE EXCEPTION 'connected as %, which cannot CREATE ROLE. Connect as the server administrator.', current_user;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bas_migrate_tmp') THEN
        RAISE EXCEPTION 'role bas_migrate_tmp already exists. It is created and dropped inside this '
            'transaction and should never outlive it; look at what it owns before dropping it by hand.';
    END IF;

    SELECT value INTO source_migration FROM mig_snapshot WHERE key = 'latest_migration';
    SELECT max(migration_name) INTO target_migration
      FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
    IF target_migration IS DISTINCT FROM source_migration THEN
        RAISE EXCEPTION 'schema mismatch: the export came from a database at migration %, this one is at %. '
            'Bring both to the same migration and export again.', source_migration, target_migration;
    END IF;

    IF EXISTS (
        SELECT 1 FROM mig_manifest m FULL JOIN mig_tables t USING (ordinal, table_name)
         WHERE m.table_name IS NULL OR t.table_name IS NULL
    ) THEN
        RAISE EXCEPTION 'manifest.csv does not list the same tables in the same order as common.sql. '
            'Were the files produced by a different version of export.sql?';
    END IF;

    SELECT array_agg(format('%s (%s rows)', x.table_name, x.row_count) ORDER BY x.ordinal)
      INTO bad
      FROM pg_temp.mig_measure() x
      JOIN mig_tables t USING (table_name)
     WHERE t.kind IN ('data', 'credentials') AND x.row_count > 0;
    IF bad IS NOT NULL THEN
        RAISE EXCEPTION 'the target already holds BAS data: %. This migration is a one-shot load into '
            'empty bas_* tables; it does not merge and it does not overwrite. Nothing has been written.', bad;
    END IF;

    SELECT count(*) INTO n
      FROM mig_stage_equipment_types s JOIN public.bas_equipment_types t USING (equip_type)
     WHERE s::text <> t::text;
    IF n > 0 THEN
        RAISE EXCEPTION 'bas_equipment_types: % row(s) exist in the target under the same key with different '
            'content. Reconcile by hand before migrating. Nothing has been written.', n;
    END IF;

    SELECT count(*) INTO n
      FROM mig_stage_point_roles s JOIN public.bas_point_roles t USING (point_role)
     WHERE s::text <> t::text;
    IF n > 0 THEN
        RAISE EXCEPTION 'bas_point_roles: % row(s) exist in the target under the same key with different '
            'content. Reconcile by hand before migrating. Nothing has been written.', n;
    END IF;

    SELECT array_agg(format('station %s -> %s', s.station_id, s.updated_by_email) ORDER BY s.station_id)
      INTO bad
      FROM mig_stage_credentials s
     WHERE s.updated_by_email IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.employees e WHERE e.email = s.updated_by_email);
    IF bad IS NOT NULL THEN
        RAISE EXCEPTION 'credential row(s) point at an employee this database does not have: %. '
            'That person can sign in to production once (which creates their row), or edit '
            'updated_by_email in bas_station_credentials.csv to an employee who exists here, or blank '
            'it to store NULL. Nothing has been written.', bad;
    END IF;
END
$$;


-- --- the plan --------------------------------------------------------------------

\echo ''
\echo '=== Snapshot being loaded'
SELECT key, value FROM mig_snapshot ORDER BY key;

\echo ''
\echo '=== Rows per table: in the files, in the target now, and what will be inserted'
SELECT m.ordinal, m.table_name, m.kind,
       m.row_count                                         AS in_files,
       x.row_count                                         AS in_target_now,
       CASE m.kind
         WHEN 'vocabulary' THEN
           CASE m.table_name
             WHEN 'bas_equipment_types' THEN
               (SELECT count(*) FROM mig_stage_equipment_types s
                 WHERE NOT EXISTS (SELECT 1 FROM public.bas_equipment_types t WHERE t.equip_type = s.equip_type))
             WHEN 'bas_point_roles' THEN
               (SELECT count(*) FROM mig_stage_point_roles s
                 WHERE NOT EXISTS (SELECT 1 FROM public.bas_point_roles t WHERE t.point_role = s.point_role))
           END
         ELSE m.row_count
       END                                                 AS will_insert,
       m.max_id                                            AS highest_id,
       m.sequence_name
  FROM mig_manifest m
  JOIN pg_temp.mig_measure() x USING (table_name)
 ORDER BY m.ordinal;

\echo ''
\echo '=== bas_station_credentials.updated_by: the email in the file, and the employee it resolves to here'
SELECT s.station_id, s.username, s.key_version, s.updated_at,
       s.updated_by_email,
       e.id AS target_employee_id,
       CASE WHEN s.updated_by_email IS NULL THEN 'will store NULL'
            WHEN e.id IS NULL             THEN 'NOT FOUND'
            ELSE e.first_name || ' ' || e.last_name END AS resolves_to
  FROM mig_stage_credentials s
  LEFT JOIN public.employees e ON e.email = s.updated_by_email
 ORDER BY s.station_id;

\echo ''
\echo '=== Tables that will NOT be touched (fingerprinted; compared again before COMMIT)'
SELECT table_name, row_count, checksum FROM mig_protected_before ORDER BY table_name;

\echo ''
\echo 'The rows above will be written by a role created for this transaction only, with no'
\echo 'privilege on any table outside bas_*. Sequences will be set past the highest id.'
\echo ''


-- --- confirmation ------------------------------------------------------------------

\if :{?confirm}
\else
\prompt 'Type YES to write these rows into this database (anything else rolls back; nothing is written): ' confirm
\endif

SELECT :'confirm' = 'YES' AS mig_confirmed \gset

\if :mig_confirmed
\else
\echo ''
\echo 'Not confirmed. Rolling back - nothing was written.'
ROLLBACK;
\quit
\endif


-- --- the role that does the writing ----------------------------------------------

CREATE ROLE bas_migrate_tmp NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO bas_migrate_tmp;

DO $$
DECLARE
    t record;
BEGIN
    FOR t IN SELECT * FROM mig_tables ORDER BY ordinal LOOP
        EXECUTE format('GRANT SELECT, INSERT ON public.%I TO bas_migrate_tmp', t.table_name);
        IF t.sequence_name IS NOT NULL THEN
            -- setval needs UPDATE. Nothing here calls nextval.
            EXECUTE format('GRANT UPDATE ON SEQUENCE public.%I TO bas_migrate_tmp', t.sequence_name);
        END IF;
    END LOOP;
END
$$;

-- Two columns, to turn an email into an id. Not the name, not the status,
-- not the row.
GRANT SELECT (id, email) ON public.employees TO bas_migrate_tmp;

-- The staging tables and the table list are this session's, owned by the
-- administrator; the role reads them.
GRANT SELECT ON mig_tables, mig_stage_equipment_types, mig_stage_point_roles, mig_stage_credentials
   TO bas_migrate_tmp;

-- The administrator that created the role gets membership automatically on
-- PostgreSQL 16+, but WITHOUT the SET attribute, so SET ROLE would be refused;
-- and DROP OWNED BY at the end needs "the privileges of" the role, which is
-- INHERIT. Granted explicitly with both, so the switch and the teardown work
-- for an administrator that is not a superuser (Azure's is not). Measured on
-- 2026-09-29 against a throwaway cluster: with INHERIT FALSE the whole load
-- succeeded and the teardown was refused, rolling everything back.
DO $$
BEGIN
    EXECUTE format('GRANT bas_migrate_tmp TO %I WITH SET TRUE, INHERIT TRUE', current_user);
END
$$;

SET LOCAL ROLE bas_migrate_tmp;

\echo ''
\echo '=== Writing as'
SELECT current_user AS writing_as, session_user AS connected_as;


-- --- the load, in dependency order -------------------------------------------------
--
-- Straight into the real tables. HEADER MATCH checks the file's header against
-- the table's columns and refuses on any difference. Each COPY is its own
-- statement, so a foreign key that points within the same table (point roles,
-- stations, equipment) is checked once the whole table is in.

\copy public.bas_orgs             FROM 'bas-migration-data/bas_orgs.csv'             WITH (FORMAT csv, HEADER MATCH)
\copy public.bas_projects         FROM 'bas-migration-data/bas_projects.csv'         WITH (FORMAT csv, HEADER MATCH)
\copy public.bas_sites            FROM 'bas-migration-data/bas_sites.csv'            WITH (FORMAT csv, HEADER MATCH)

-- Vocabularies: rows the target does not have. Rows it has were proven
-- identical above, so skipping them loses nothing.
INSERT INTO public.bas_equipment_types
SELECT s.* FROM mig_stage_equipment_types s
 WHERE NOT EXISTS (SELECT 1 FROM public.bas_equipment_types t WHERE t.equip_type = s.equip_type)
 ORDER BY s.equip_type;

INSERT INTO public.bas_point_roles
SELECT s.* FROM mig_stage_point_roles s
 WHERE NOT EXISTS (SELECT 1 FROM public.bas_point_roles t WHERE t.point_role = s.point_role)
 ORDER BY s.point_role;

\copy public.bas_stations         FROM 'bas-migration-data/bas_stations.csv'         WITH (FORMAT csv, HEADER MATCH)
\copy public.bas_equipment        FROM 'bas-migration-data/bas_equipment.csv'        WITH (FORMAT csv, HEADER MATCH)
\copy public.bas_points           FROM 'bas-migration-data/bas_points.csv'           WITH (FORMAT csv, HEADER MATCH)
\copy public.bas_readings         FROM 'bas-migration-data/bas_readings.csv'         WITH (FORMAT csv, HEADER MATCH)
\copy public.bas_point_links      FROM 'bas-migration-data/bas_point_links.csv'      WITH (FORMAT csv, HEADER MATCH)
\copy public.bas_sync_checkpoints FROM 'bas-migration-data/bas_sync_checkpoints.csv' WITH (FORMAT csv, HEADER MATCH)
\copy public.bas_data_gaps        FROM 'bas-migration-data/bas_data_gaps.csv'        WITH (FORMAT csv, HEADER MATCH)
\copy public.bas_ingest_runs      FROM 'bas-migration-data/bas_ingest_runs.csv'      WITH (FORMAT csv, HEADER MATCH)

-- Credentials: the email becomes this database's employee id. The
-- precondition above already refused any email with no employee here.
INSERT INTO public.bas_station_credentials
       (station_id, username, password_ciphertext, key_version, updated_at, updated_by)
SELECT s.station_id, s.username, s.password_ciphertext, s.key_version, s.updated_at, e.id
  FROM mig_stage_credentials s
  LEFT JOIN public.employees e ON e.email = s.updated_by_email
 ORDER BY s.station_id;


-- --- sequences: past the highest id copied ------------------------------------------
--
-- The rows arrived with their ids, and the sequences were never called, so the
-- next nextval() would hand out 1. setval(seq, max, true) makes it max + 1.

DO $$
DECLARE
    t record;
    hi bigint;
BEGIN
    FOR t IN SELECT * FROM mig_tables WHERE sequence_name IS NOT NULL ORDER BY ordinal LOOP
        EXECUTE format('SELECT max(%I) FROM public.%I', t.id_column, t.table_name) INTO hi;
        IF hi IS NULL THEN
            RAISE NOTICE 'sequence %: table % is empty, left alone', t.sequence_name, t.table_name;
        ELSE
            EXECUTE format('SELECT setval(%L, %s, true)', 'public.' || t.sequence_name, hi);
            RAISE NOTICE 'sequence % set to %; next value is %', t.sequence_name, hi, hi + 1;
        END IF;
    END LOOP;
END
$$;

RESET ROLE;


-- --- the role is gone before anything is committed ----------------------------------

DROP OWNED BY bas_migrate_tmp;
DROP ROLE bas_migrate_tmp;


-- --- verification: the same checks check.sql runs afterwards --------------------------

\ir check.sql

-- And the one check only this file can make: nothing outside bas_* changed.
DO $$
DECLARE
    bad text[];
BEGIN
    SELECT array_agg(coalesce(b.table_name, a.table_name) ORDER BY 1)
      INTO bad
      FROM mig_protected_before b
      FULL JOIN pg_temp.mig_protected() a USING (table_name)
     WHERE b.row_count IS DISTINCT FROM a.row_count
        OR b.checksum  IS DISTINCT FROM a.checksum;
    IF bad IS NOT NULL THEN
        RAISE EXCEPTION 'REFUSING TO COMMIT: table(s) outside bas_* measure differently than before the load: %', bad;
    END IF;
    RAISE NOTICE 'every table outside bas_* is unchanged (% tables compared)', (SELECT count(*) FROM mig_protected_before);
END
$$;

\echo ''
\echo '=== Result'
SELECT x.ordinal, x.table_name, x.row_count AS rows_in_target, m.row_count AS rows_in_files, x.max_id
  FROM pg_temp.mig_measure() x
  JOIN mig_manifest m USING (table_name)
 ORDER BY x.ordinal;

SELECT * FROM pg_temp.mig_sequences();

SELECT rolname FROM pg_roles WHERE rolname = 'bas_migrate_tmp';
\echo '(the line above lists bas_migrate_tmp if it still exists; it should list nothing)'

COMMIT;

\echo ''
\echo 'Committed.'
\echo 'Next: run check.sql against the same target, from this directory, and read every line.'
\echo ''
