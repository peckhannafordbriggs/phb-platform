-- =============================================================================
-- bas_collector: the PostgreSQL role the BAS collector (phb-bas) connects as.
--
-- WHY THIS FILE EXISTS
--
-- On the office PC the role was created by hand on 24 August 2026 and no file
-- in either repository records how. This is that file, written from the live
-- grants read out of pg_catalog on 29 September 2026, so the Azure database can
-- carry the SAME least privilege rather than a reconstruction from memory.
-- The collector must never connect to production as the server administrator:
-- that account owns every table, including employees and audit_events.
--
-- WHAT IT CAN DO - the live grants, exactly
--
--   SELECT, INSERT, UPDATE, DELETE   on the thirteen bas_* data tables
--   SELECT only                      on bas_station_credentials (B7.5: the
--                                    collector READS its logins; only the
--                                    platform writes them)
--   SELECT                           on the six bas_v_* views
--   USAGE                            on seven sequences - every bas_* sequence
--                                    except bas_data_gaps_gap_id_seq, which the
--                                    live role was never granted and the
--                                    collector never uses (it does not write
--                                    gaps). Kept identical on purpose; widen it
--                                    here, deliberately, if that changes.
--   CONNECT, USAGE on schema public
--
-- WHAT IT CANNOT DO
--
--   CREATE anything (no CREATE on the schema, NOCREATEDB, NOCREATEROLE), touch
--   any table outside bas_* (employees, audit_events, module_grants, modules,
--   positions, departments, draft_locks, _prisma_migrations - all revoked by
--   name below), write a credential, or run a migration.
--
-- WHY AN EXPLICIT ALLOWLIST AND A GATE
--
-- Same shape as setup_readonly_role_platform.sql (phb-bas) and the bas_analyze
-- role (lib/modules/bas/analyze/role.ts): every object is NAMED, and a bas_*
-- table or view this file does not mention stops the script. A pattern grant
-- says yes to objects nobody has looked at; that is how a read-only role was
-- once handed the credentials table. Read that file's header before turning
-- this back into `GRANT ... ON ALL TABLES`.
--
-- ALTER DEFAULT PRIVILEGES is deliberately absent, for the reason given there:
-- it cannot be filtered by table name and would grant this role the next table
-- Prisma creates, whatever it holds. After a migration that adds a bas_* object,
-- classify it below and re-run this file.
--
-- RUN IT
--
-- As the server administrator, against the target database. Locally that is
-- the postgres superuser; in Azure it is the administrator login, which is not
-- a superuser but owns every table and can create roles, which is all this
-- needs. Pass the password bare; :'pw' quotes it as a SQL literal.
--
--   psql "<admin URL>" -v pw=<a new password> -f scripts/setup-bas-collector-role.sql
--
-- Re-running rotates the password and re-asserts the grants; it never widens
-- them. It proves the boundary before it finishes and fails loudly if the
-- proof fails. Then, in the collector's .env on the host that runs it:
--
--   DATABASE_URL=postgresql://bas_collector:<password>@<host>:5432/phb_platform?sslmode=require
--
-- Roles are cluster-wide. A password set here on a server is that server's
-- only password for the role: rotating it in Azure does not touch the office
-- PC, and rotating it on the office PC does not touch Azure.
-- =============================================================================

\set ON_ERROR_STOP on
\pset pager off

\if :{?pw}
\else
\echo 'ERROR: pass the password with  -v pw=yourpassword'
\quit 1
\endif


-- --- the allowlist -----------------------------------------------------------

CREATE TEMP TABLE collector_rw (relname text PRIMARY KEY);
INSERT INTO collector_rw (relname) VALUES
    -- Hierarchy and metadata. The collector registers what it discovers.
    ('bas_orgs'),
    ('bas_projects'),
    ('bas_sites'),
    ('bas_stations'),
    ('bas_equipment'),
    -- Controlled vocabularies. Granted on the live server; the collector
    -- reads them and does not write them.
    ('bas_equipment_types'),
    ('bas_point_roles'),
    -- Points, their relationships, and the numbers.
    ('bas_points'),
    ('bas_point_links'),
    ('bas_readings'),
    -- Operational.
    ('bas_sync_checkpoints'),
    ('bas_ingest_runs'),
    ('bas_data_gaps');

CREATE TEMP TABLE collector_ro (relname text PRIMARY KEY, reason text);
INSERT INTO collector_ro (relname, reason) VALUES
    ('bas_station_credentials',   'the collector reads its Niagara logins here; only the platform writes them'),
    ('bas_v_point',               'view'),
    ('bas_v_reading',             'view'),
    ('bas_v_setpoint_pair',       'view'),
    ('bas_v_command_status_pair', 'view'),
    ('bas_v_collection_health',   'view; healthcheck.py reads it'),
    ('bas_v_data_dictionary',     'view');

CREATE TEMP TABLE collector_seq (relname text PRIMARY KEY);
INSERT INTO collector_seq (relname) VALUES
    ('bas_orgs_org_id_seq'),
    ('bas_projects_project_id_seq'),
    ('bas_sites_site_id_seq'),
    ('bas_stations_station_id_seq'),
    ('bas_equipment_equipment_id_seq'),
    ('bas_points_point_id_seq'),
    ('bas_ingest_runs_run_id_seq');
    -- bas_data_gaps_gap_id_seq: deliberately absent, see the header.


-- --- the gate: nothing unclassified, nothing missing ---------------------------

DO $gate$
DECLARE
    present      text[];
    unclassified text[];
    missing      text[];
    conflicted   text[];
BEGIN
    SELECT coalesce(array_agg(c.relname ORDER BY c.relname), '{}')
      INTO present
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public'
       AND c.relkind IN ('r', 'v', 'm', 'p')
       AND c.relname LIKE 'bas\_%';

    SELECT coalesce(array_agg(a.relname ORDER BY a.relname), '{}')
      INTO conflicted
      FROM collector_rw a JOIN collector_ro w USING (relname);
    IF array_length(conflicted, 1) > 0 THEN
        RAISE EXCEPTION 'These objects are both read-write and read-only: %. Pick one.', conflicted;
    END IF;

    SELECT coalesce(array_agg(p ORDER BY p), '{}')
      INTO unclassified
      FROM unnest(present) AS p
     WHERE p NOT IN (SELECT relname FROM collector_rw)
       AND p NOT IN (SELECT relname FROM collector_ro);
    IF array_length(unclassified, 1) > 0 THEN
        RAISE EXCEPTION 'Unclassified bas_* object(s): %. Nothing has been granted or revoked. '
            'Decide whether the collector writes it, reads it, or must not see it, and add '
            'each name to collector_rw or collector_ro in this file (or leave it out and note why).',
            unclassified;
    END IF;

    SELECT coalesce(array_agg(x ORDER BY x), '{}')
      INTO missing
      FROM (SELECT relname FROM collector_rw UNION ALL SELECT relname FROM collector_ro) l(x)
     WHERE x <> ALL (present);
    IF array_length(missing, 1) > 0 THEN
        RAISE EXCEPTION 'Listed object(s) not found in this database: %. A typo, or the migration '
            'that creates them has not been applied here yet.', missing;
    END IF;

    SELECT coalesce(array_agg(s.relname ORDER BY s.relname), '{}')
      INTO missing
      FROM collector_seq s
     WHERE to_regclass('public.' || s.relname) IS NULL;
    IF array_length(missing, 1) > 0 THEN
        RAISE EXCEPTION 'Listed sequence(s) not found in this database: %.', missing;
    END IF;

    RAISE NOTICE 'Gate passed: % bas_* object(s) present, % read-write, % read-only, % sequences.',
        coalesce(array_length(present, 1), 0),
        (SELECT count(*) FROM collector_rw),
        (SELECT count(*) FROM collector_ro),
        (SELECT count(*) FROM collector_seq);
END
$gate$;


-- --- the role ----------------------------------------------------------------
--
-- CREATE or ALTER, so re-running rotates the password. Built as text outside
-- a $$ block because psql does not substitute :variables inside one
-- (runbook.md, "psql does not substitute :variables inside a dollar-quoted
-- block"). Stored with \gset and run as :role_stmt rather than with \gexec:
-- \gexec PRINTS the generated statement, password included, on the terminal
-- (measured 2026-09-29, psql 17; the phb-bas role scripts do this). \gset
-- prints nothing, and the only echo is the command tag.

SELECT format('%s ROLE bas_collector WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',
              CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bas_collector') THEN 'ALTER' ELSE 'CREATE' END,
              :'pw') AS role_stmt \gset
:role_stmt ;

DO $c$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO bas_collector', current_database()); END $c$;
GRANT USAGE ON SCHEMA public TO bas_collector;


-- --- grants, on the allowlist and nothing else ---------------------------------

DO $grant$
DECLARE
    r record;
BEGIN
    FOR r IN SELECT relname FROM collector_rw ORDER BY relname LOOP
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO bas_collector', r.relname);
        -- Never more than those four. TRUNCATE, REFERENCES and TRIGGER are
        -- schema-shaped powers a data writer does not need.
        EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.%I FROM bas_collector', r.relname);
    END LOOP;
    FOR r IN SELECT relname FROM collector_ro ORDER BY relname LOOP
        EXECUTE format('REVOKE ALL ON public.%I FROM bas_collector', r.relname);
        EXECUTE format('GRANT SELECT ON public.%I TO bas_collector', r.relname);
    END LOOP;
    FOR r IN SELECT relname FROM collector_seq ORDER BY relname LOOP
        EXECUTE format('GRANT USAGE ON SEQUENCE public.%I TO bas_collector', r.relname);
    END LOOP;
    RAISE NOTICE 'Granted: read-write on % tables, read-only on % objects, usage on % sequences.',
        (SELECT count(*) FROM collector_rw), (SELECT count(*) FROM collector_ro), (SELECT count(*) FROM collector_seq);
END
$grant$;


-- --- everything else, withheld by name -------------------------------------------

REVOKE CREATE ON SCHEMA public FROM bas_collector;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM bas_collector;

REVOKE ALL ON public.employees          FROM bas_collector;
REVOKE ALL ON public.audit_events       FROM bas_collector;
REVOKE ALL ON public.module_grants      FROM bas_collector;
REVOKE ALL ON public.modules            FROM bas_collector;
REVOKE ALL ON public.positions          FROM bas_collector;
REVOKE ALL ON public.departments        FROM bas_collector;
REVOKE ALL ON public.draft_locks        FROM bas_collector;
REVOKE ALL ON public._prisma_migrations FROM bas_collector;

-- Sequences not on the list, including bas_data_gaps_gap_id_seq.
DO $seq$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'S'
           AND c.relname NOT IN (SELECT relname FROM collector_seq)
    LOOP
        EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM bas_collector', r.relname);
    END LOOP;
END
$seq$;

COMMENT ON ROLE bas_collector IS
  'The BAS collector (phb-bas). Read/write on bas_* data tables, read-only on '
  'bas_station_credentials and the bas_v_* views, nothing else. '
  'scripts/setup-bas-collector-role.sql in phb-platform creates it and proves the boundary.';


-- --- prove it, before anyone relies on it ------------------------------------------

DO $proof$
DECLARE
    fail text[] := '{}';
BEGIN
    IF NOT has_table_privilege('bas_collector', 'public.bas_readings', 'INSERT')             THEN fail := fail || 'cannot INSERT bas_readings'; END IF;
    IF NOT has_table_privilege('bas_collector', 'public.bas_points', 'UPDATE')               THEN fail := fail || 'cannot UPDATE bas_points'; END IF;
    IF NOT has_table_privilege('bas_collector', 'public.bas_station_credentials', 'SELECT')  THEN fail := fail || 'cannot SELECT bas_station_credentials (B7.5 needs it)'; END IF;
    IF NOT has_table_privilege('bas_collector', 'public.bas_v_collection_health', 'SELECT')  THEN fail := fail || 'cannot SELECT bas_v_collection_health'; END IF;
    IF NOT has_sequence_privilege('bas_collector', 'public.bas_points_point_id_seq', 'USAGE') THEN fail := fail || 'no USAGE on bas_points_point_id_seq'; END IF;

    IF has_table_privilege('bas_collector', 'public.bas_station_credentials', 'INSERT')      THEN fail := fail || 'CAN INSERT bas_station_credentials'; END IF;
    IF has_table_privilege('bas_collector', 'public.bas_station_credentials', 'UPDATE')      THEN fail := fail || 'CAN UPDATE bas_station_credentials'; END IF;
    IF has_table_privilege('bas_collector', 'public.employees', 'SELECT')                    THEN fail := fail || 'CAN SELECT employees'; END IF;
    IF has_table_privilege('bas_collector', 'public.audit_events', 'SELECT')                 THEN fail := fail || 'CAN SELECT audit_events'; END IF;
    IF has_table_privilege('bas_collector', 'public._prisma_migrations', 'SELECT')           THEN fail := fail || 'CAN SELECT _prisma_migrations'; END IF;
    IF has_table_privilege('bas_collector', 'public.module_grants', 'SELECT')                THEN fail := fail || 'CAN SELECT module_grants'; END IF;
    IF has_table_privilege('bas_collector', 'public.bas_readings', 'TRUNCATE')               THEN fail := fail || 'CAN TRUNCATE bas_readings'; END IF;
    IF has_schema_privilege('bas_collector', 'public', 'CREATE')                             THEN fail := fail || 'CAN CREATE in public'; END IF;
    IF has_sequence_privilege('bas_collector', 'public.bas_data_gaps_gap_id_seq', 'USAGE')   THEN fail := fail || 'has USAGE on bas_data_gaps_gap_id_seq (not on the live server; widen deliberately or not at all)'; END IF;
    IF (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname = 'bas_collector') THEN fail := fail || 'has a role attribute it must not'; END IF;

    IF array_length(fail, 1) > 0 THEN
        RAISE EXCEPTION 'bas_collector boundary proof FAILED: %. The role exists and has been granted; '
            'do not hand out its password until this passes.', fail;
    END IF;
    RAISE NOTICE 'bas_collector: writes bas_* data, reads credentials and views, refused everywhere else. OK.';
END
$proof$;

DROP TABLE collector_rw, collector_ro, collector_seq;

\echo ''
\echo 'Created/updated role: bas_collector on this database.'
\echo 'Connection string for the collector''s .env (add ?sslmode=require for Azure):'
\echo '  postgresql://bas_collector:<the password you passed>@<host>:5432/<database>'
\echo ''
\echo 'Prove the refusals from the outside as well - a grant that lets the right thing'
\echo 'through proves nothing on its own:'
\echo '  psql "<that string>" -c "SELECT count(*) FROM bas_points"      -- must work'
\echo '  psql "<that string>" -c "SELECT count(*) FROM employees"       -- must be DENIED'
\echo '  psql "<that string>" -c "CREATE TABLE zz (x int)"              -- must be DENIED'
\echo ''
