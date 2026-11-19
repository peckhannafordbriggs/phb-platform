-- =============================================================================
-- bas_collector: the PostgreSQL role the BAS collector (phb-bas) connects as.
--
-- WHY THIS FILE EXISTS
--
-- On the office PC the role was created by hand on 24 August 2026 and no file
-- in either repository records how. This is that file, first written from the
-- live grants read out of pg_catalog on 29 September 2026, so the Azure database
-- could carry the SAME least privilege rather than a reconstruction from memory.
-- The collector must never connect to production as the server administrator:
-- that account owns every table, including employees and audit_events.
--
-- WHAT BROKE, AND WHY THIS FILE WAS WRONG (2026-11-19)
--
-- Until 19 November this file withheld USAGE on bas_data_gaps_gap_id_seq, on
-- the stated belief that "the collector never uses it (it does not write
-- gaps)". It does: phb-bas collector/db.py record_gap INSERTs a row whenever a
-- station has overwritten records past a checkpoint. The file also REVOKEd the
-- grant on every run and its proof FAILED if the grant existed, so every run of
-- it removed the grant. On the Azure database the collector therefore could
-- not record a NEW loss, and nothing noticed until it first had to: from
-- 6 November every pass died on that INSERT ("permission denied for sequence
-- bas_data_gaps_gap_id_seq"), every point after it and every later station went
-- uncollected for thirteen days, and the run row said nothing. The grant was
-- made by hand on 19 November. No migration was involved - the only migration
-- that touched bas_data_gaps after it was created, add_bas_data_gaps_unique
-- (2026-09-22), adds an index, and an index cannot change a grant.
-- runbook.md -> "The collector stops on "permission denied" for a bas_* table
-- or sequence" has the whole account and the production re-run.
--
-- WHAT IT CAN DO
--
--   SELECT, INSERT, UPDATE, DELETE   on the thirteen bas_* data tables
--                                    (collector_rw)
--   SELECT only                      on bas_station_credentials (B7.5: the
--                                    collector READS its logins; only the
--                                    platform writes them) and the six bas_v_*
--                                    views (collector_ro)
--   USAGE, SELECT                    on the eight sequences owned by those
--                                    tables (collector_seq) - every one, the
--                                    gaps sequence included. USAGE is what
--                                    nextval needs; SELECT is what was granted
--                                    by hand on 19 November and is harmless.
--   USAGE, SELECT, BY DEFAULT        on every sequence the administrator creates
--                                    in public from now on (below)
--   CONNECT, USAGE on schema public
--
-- WHAT THE COLLECTOR ACTUALLY WRITES (collector_writes)
--
-- Six of the thirteen, read off the SQL in phb-bas collector/db.py, which holds
-- the same six in Repository.REQUIRED_PRIVILEGES and checks them at the start
-- of every pass. Each is listed with the migration that created the table as it
-- stands, and tests/bas-collector-grant-guard.test.ts holds that to the
-- migrations: a migration that drops and recreates one of these tables - which
-- creates it with NO grants, and its sequence with none either - fails the
-- build until this list names it, and the failure says to re-run this file in
-- production. The proof below checks INSERT and UPDATE on all six and USAGE on
-- every sequence they own, so this file can never again prove a boundary that
-- the collector cannot work inside.
--
-- WHAT IT CANNOT DO
--
--   CREATE anything (no CREATE on the schema, NOCREATEDB, NOCREATEROLE), touch
--   any table outside bas_* (employees, audit_events, module_grants, modules,
--   positions, departments, draft_locks, _prisma_migrations - all revoked by
--   name below), write a credential, or run a migration.
--
-- WHY AN EXPLICIT ALLOWLIST AND A GATE - FOR TABLES
--
-- Same shape as setup_readonly_role_platform.sql (phb-bas) and the bas_analyze
-- role (lib/modules/bas/analyze/role.ts): every TABLE is NAMED, and a bas_*
-- table or view this file does not mention stops the script. A pattern grant
-- says yes to objects nobody has looked at; that is how a read-only role was
-- once handed the credentials table. Read that file's header before turning
-- this back into `GRANT ... ON ALL TABLES`.
--
-- WHY DEFAULT PRIVILEGES - FOR SEQUENCES ONLY (2026-11-19)
--
-- ALTER DEFAULT PRIVILEGES cannot be filtered by name, which is why tables are
-- not granted that way: a default table grant would hand this role the next
-- table Prisma creates, credentials or report recipients included. A sequence
-- is different in kind. USAGE and SELECT on one let the role draw a number
-- (nextval) and read the last one - never a row of any table. The exposure is
-- that the collector could burn an id or learn a counter; the protection is
-- that a migration which recreates a table the collector writes cannot take
-- away the sequence grant its INSERTs need, which is exactly the failure above.
-- Two limits, both real:
--
--   * Default privileges apply to objects created by the role that set them.
--     This file sets them as whoever runs it, so it must be run as the same
--     login the migrations run as - in production both are the server
--     administrator (DATABASE-URL and PRODUCTION_DATABASE_URL), locally both
--     are the postgres superuser. The proof checks the entry exists for the
--     role running this file.
--   * They cover the sequence, not the table. A recreated table still arrives
--     with no table grants until this file is re-run; the guard test above is
--     what makes that impossible to forget.
--
-- A re-run REVOKEs every sequence grant not on collector_seq, including ones
-- the default added for a sequence the collector does not use. Between a
-- migration and a re-run the collector may hold USAGE on a sequence it never
-- touches; after a re-run it holds exactly the list.
--
-- RUN IT
--
-- As the server administrator, against the target database. Locally that is
-- the postgres superuser; in Azure it is the administrator login, which is not
-- a superuser but owns every table and can create roles, which is all this
-- needs.
--
--   First time, or to rotate the password - pass it bare; :'pw' quotes it:
--     psql "<admin URL>" -v pw=<a new password> -f scripts/setup-bas-collector-role.sql
--
--   After a migration, to re-assert the grants WITHOUT touching the password:
--     psql "<admin URL>" -f scripts/setup-bas-collector-role.sql
--
-- The second form exists because the role's password lives in one place, the
-- collector host's .env (C:\dev\bas-collector\.env), and not in Key Vault: a
-- re-run that had to rotate it would stop the collector until somebody edited
-- that file on the office PC. Without a password the script refuses unless the
-- role already exists. Either way it gates before changing anything, never
-- widens a table grant, proves the boundary before it finishes, and exits
-- non-zero if the proof fails. Then, the first time, in the collector's .env:
--
--   DATABASE_URL=postgresql://bas_collector:<password>@<host>:5432/phb_platform?sslmode=require
--
-- Roles are cluster-wide. A password set here on a server is that server's
-- only password for the role: rotating it in Azure does not touch the office
-- PC, and rotating it on the office PC does not touch Azure.
--
-- To reach the Azure server from a laptop the server needs a firewall rule for
-- that laptop's address:
--   az postgres flexible-server firewall-rule create -g <rg> -s <server> -n <rule> --start-ip-address <ip> --end-ip-address <ip>
-- (-s is the server and -n the rule.) Delete the rule afterwards.
-- =============================================================================

\set ON_ERROR_STOP on
\pset pager off

-- Refusals below RAISE rather than \quit: psql's \quit takes no exit status
-- (`\quit 1` prints "extra argument ignored" and exits 0, measured 2026-11-19,
-- psql 17), so a refusal by \quit reads as success to whoever checks the exit
-- code. A RAISE under ON_ERROR_STOP exits 3.

SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bas_collector') AS role_exists \gset

\if :{?pw}
SELECT length(:'pw') = 0 AS pw_empty \gset
\if :pw_empty
DO $empty$ BEGIN
    RAISE EXCEPTION 'pw is empty. Pass a real password with -v pw=..., or leave pw out entirely to keep the existing one.';
END $empty$;
\endif
\set keep_password false
\else
\if :role_exists
\set keep_password true
\else
DO $nopw$ BEGIN
    RAISE EXCEPTION 'bas_collector does not exist on this server yet, so there is no password to keep. '
        'Pass one the first time:  -v pw=yourpassword  (or, from PowerShell, \getenv pw <VAR>).';
END $nopw$;
\endif
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

-- The six tables the collector WRITES (phb-bas collector/db.py; the collector
-- checks the same six as Repository.REQUIRED_PRIVILEGES), each with the
-- migration that created the table as it stands. A migration that recreates
-- one of these must be named here - tests/bas-collector-grant-guard.test.ts
-- fails the build until it is - and this file re-run in production afterwards.
CREATE TEMP TABLE collector_writes (relname text PRIMARY KEY, created_by text NOT NULL);
INSERT INTO collector_writes (relname, created_by) VALUES
    ('bas_stations',         '20260821150733_add_bas_tables'),
    ('bas_points',           '20260821150733_add_bas_tables'),
    ('bas_readings',         '20260821150733_add_bas_tables'),
    ('bas_sync_checkpoints', '20260821150733_add_bas_tables'),
    ('bas_ingest_runs',      '20260821150733_add_bas_tables'),
    ('bas_data_gaps',        '20260821150733_add_bas_tables');

CREATE TEMP TABLE collector_ro (relname text PRIMARY KEY, reason text);
INSERT INTO collector_ro (relname, reason) VALUES
    ('bas_station_credentials',   'the collector reads its Niagara logins here; only the platform writes them'),
    ('bas_v_point',               'view'),
    ('bas_v_reading',             'view'),
    ('bas_v_setpoint_pair',       'view'),
    ('bas_v_command_status_pair', 'view'),
    ('bas_v_collection_health',   'view; healthcheck.py reads it'),
    ('bas_v_data_dictionary',     'view');

-- Withheld by name: bas_* objects the collector must not see at all. Listed
-- so the gate can tell "decided to withhold" from "nobody has looked", and
-- REVOKEd below so a re-run removes a grant an earlier hand-run may have made.
CREATE TEMP TABLE collector_none (relname text PRIMARY KEY, reason text);
INSERT INTO collector_none (relname, reason) VALUES
    -- Reports, Phase 1 (2026-11-10): platform-side configuration a person
    -- types through the Reports tab. The collector reads occupancy from the
    -- station, never from bas_site_occupancy, and has no business with the rest.
    ('bas_report_definitions',  'report configuration'),
    ('bas_report_questions',    'report configuration, including typed text'),
    ('bas_report_recipients',   'email addresses'),
    ('bas_library_questions',   'the shared question library'),
    ('bas_personal_questions',  'an employee''s own saved questions'),
    ('bas_site_occupancy',      'occupied hours a person entered; the collector reads occupancy from the station'),
    -- Reports, Phase 2 (2026-11-11): documents the platform wrote.
    ('bas_report_runs',         'report runs'),
    ('bas_report_findings',     'report findings'),
    -- 2026-11-12: the Reports safety ceiling, a module setting.
    ('bas_report_settings',     'the Reports safety ceiling'),
    -- 2026-11-17: report email addresses and send state.
    ('bas_report_deliveries',   'report email deliveries');

-- Every sequence owned by a collector_rw table. The gate below derives that set
-- from the catalog and refuses if this list differs from it, so a new serial
-- column on one of these tables stops the script until somebody looks.
CREATE TEMP TABLE collector_seq (relname text PRIMARY KEY);
INSERT INTO collector_seq (relname) VALUES
    ('bas_orgs_org_id_seq'),
    ('bas_projects_project_id_seq'),
    ('bas_sites_site_id_seq'),
    ('bas_stations_station_id_seq'),
    ('bas_equipment_equipment_id_seq'),
    ('bas_points_point_id_seq'),
    ('bas_ingest_runs_run_id_seq'),
    -- Withheld until 2026-11-19 on the false belief that the collector never
    -- inserts a gap. record_gap does. See the header.
    ('bas_data_gaps_gap_id_seq');


-- --- the gate: nothing unclassified, nothing missing ---------------------------

DO $gate$
DECLARE
    present      text[];
    unclassified text[];
    missing      text[];
    conflicted   text[];
    owned        text[];
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
    SELECT coalesce(array_agg(x ORDER BY x), '{}')
      INTO conflicted
      FROM (SELECT relname FROM collector_rw UNION ALL SELECT relname FROM collector_ro) l(x)
      JOIN collector_none n ON n.relname = l.x;
    IF array_length(conflicted, 1) > 0 THEN
        RAISE EXCEPTION 'These objects are both granted and withheld: %. Pick one.', conflicted;
    END IF;

    SELECT coalesce(array_agg(w.relname ORDER BY w.relname), '{}')
      INTO conflicted
      FROM collector_writes w
     WHERE w.relname NOT IN (SELECT relname FROM collector_rw);
    IF array_length(conflicted, 1) > 0 THEN
        RAISE EXCEPTION 'The collector writes % but collector_rw does not grant it. Add it to collector_rw.', conflicted;
    END IF;

    SELECT coalesce(array_agg(p ORDER BY p), '{}')
      INTO unclassified
      FROM unnest(present) AS p
     WHERE p NOT IN (SELECT relname FROM collector_rw)
       AND p NOT IN (SELECT relname FROM collector_ro)
       AND p NOT IN (SELECT relname FROM collector_none);
    IF array_length(unclassified, 1) > 0 THEN
        RAISE EXCEPTION 'Unclassified bas_* object(s): %. Nothing has been granted or revoked. '
            'Decide whether the collector writes it, reads it, or must not see it, and add '
            'each name to collector_rw, collector_ro or collector_none in this file.',
            unclassified;
    END IF;

    SELECT coalesce(array_agg(x ORDER BY x), '{}')
      INTO missing
      FROM (SELECT relname FROM collector_rw UNION ALL SELECT relname FROM collector_ro
            UNION ALL SELECT relname FROM collector_none) l(x)
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

    -- The sequences the catalog says the collector_rw tables own - serial
    -- ('a') and identity ('i') columns alike - against collector_seq. Derived,
    -- so a table recreated under a new sequence name, or a serial column added
    -- to one of these tables, stops here rather than leaving an INSERT the
    -- collector cannot make.
    SELECT coalesce(array_agg(s.relname ORDER BY s.relname), '{}')
      INTO owned
      FROM pg_class s
      JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass
                      AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
      JOIN pg_class t ON t.oid = d.refobjid
      JOIN pg_namespace ns ON ns.oid = t.relnamespace
     WHERE s.relkind = 'S' AND ns.nspname = 'public'
       AND t.relname IN (SELECT relname FROM collector_rw);
    SELECT coalesce(array_agg(o ORDER BY o), '{}')
      INTO missing
      FROM unnest(owned) AS o
     WHERE o NOT IN (SELECT relname FROM collector_seq);
    IF array_length(missing, 1) > 0 THEN
        RAISE EXCEPTION 'Sequence(s) owned by a collector table but not in collector_seq: %. Nothing '
            'has been granted. An INSERT into that table needs USAGE on its sequence; add it to '
            'collector_seq.', missing;
    END IF;

    -- Each collector-written table's migration must be applied here. If it is
    -- not, this checkout describes a table this database does not have yet.
    SELECT coalesce(array_agg(DISTINCT w.created_by ORDER BY w.created_by), '{}')
      INTO missing
      FROM collector_writes w
     WHERE NOT EXISTS (SELECT 1 FROM public._prisma_migrations m
                        WHERE m.migration_name = w.created_by
                          AND m.finished_at IS NOT NULL AND m.rolled_back_at IS NULL);
    IF array_length(missing, 1) > 0 THEN
        RAISE EXCEPTION 'Migration(s) % are not applied to this database, and collector_writes says '
            'they created tables the collector writes. Let the deploy apply them first.', missing;
    END IF;

    RAISE NOTICE 'Gate passed: % bas_* object(s) present, % read-write (% written by the collector), % read-only, % withheld, % sequences.',
        coalesce(array_length(present, 1), 0),
        (SELECT count(*) FROM collector_rw),
        (SELECT count(*) FROM collector_writes),
        (SELECT count(*) FROM collector_ro),
        (SELECT count(*) FROM collector_none),
        (SELECT count(*) FROM collector_seq);
END
$gate$;


-- --- the role ----------------------------------------------------------------
--
-- CREATE or ALTER. With pw, the password is set (a rotation on a re-run);
-- without it, the role must exist and only its attributes are re-asserted.
-- Built as text outside a $$ block because psql does not substitute :variables
-- inside one (runbook.md, "psql does not substitute :variables inside a
-- dollar-quoted block"). Stored with \gset and run as :role_stmt rather than
-- with \gexec: \gexec PRINTS the generated statement, password included, on the
-- terminal (measured 2026-09-29, psql 17; the phb-bas role scripts do this).
-- \gset prints nothing, and the only echo is the command tag.

\if :keep_password
SELECT 'ALTER ROLE bas_collector WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS' AS role_stmt \gset
\else
SELECT format('%s ROLE bas_collector WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',
              CASE WHEN :'role_exists'::boolean THEN 'ALTER' ELSE 'CREATE' END,
              :'pw') AS role_stmt \gset
\endif
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
        EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO bas_collector', r.relname);
        -- Never UPDATE: that is setval, which can move a counter backwards.
        EXECUTE format('REVOKE UPDATE ON SEQUENCE public.%I FROM bas_collector', r.relname);
    END LOOP;
    FOR r IN SELECT relname FROM collector_none ORDER BY relname LOOP
        EXECUTE format('REVOKE ALL ON public.%I FROM bas_collector', r.relname);
    END LOOP;
    RAISE NOTICE 'Granted: read-write on % tables, read-only on % objects, usage on % sequences; withheld % by name.',
        (SELECT count(*) FROM collector_rw), (SELECT count(*) FROM collector_ro), (SELECT count(*) FROM collector_seq),
        (SELECT count(*) FROM collector_none);
END
$grant$;

-- Sequences the administrator creates from now on - including the new sequence
-- of a table a migration drops and recreates. See the header for why this is
-- sequences only, and why it must be run as the login the migrations run as.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO bas_collector;


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

-- Sequences not on the list, including any the default above granted for a
-- sequence the collector does not use.
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
  'The BAS collector (phb-bas). Read/write on bas_* data tables and USAGE on their sequences, read-only on '
  'bas_station_credentials and the bas_v_* views, nothing else. '
  'scripts/setup-bas-collector-role.sql in phb-platform creates it and proves the boundary.';


-- --- prove it, before anyone relies on it ------------------------------------------

DO $proof$
DECLARE
    fail text[] := '{}';
    r    record;
BEGIN
    -- Everything the collector does, table by table and sequence by sequence.
    -- This half is what the proof lacked until 2026-11-19: it checked one
    -- INSERT and one sequence, and asserted the gaps sequence was ABSENT.
    FOR r IN SELECT relname FROM collector_writes ORDER BY relname LOOP
        IF NOT has_table_privilege('bas_collector', 'public.' || r.relname, 'SELECT') THEN fail := fail || ('cannot SELECT ' || r.relname); END IF;
        IF NOT has_table_privilege('bas_collector', 'public.' || r.relname, 'INSERT') THEN fail := fail || ('cannot INSERT ' || r.relname); END IF;
        IF NOT has_table_privilege('bas_collector', 'public.' || r.relname, 'UPDATE') THEN fail := fail || ('cannot UPDATE ' || r.relname); END IF;
    END LOOP;
    FOR r IN
        SELECT s.relname
          FROM pg_class s
          JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass
                          AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
          JOIN pg_class t ON t.oid = d.refobjid
         WHERE s.relkind = 'S' AND t.relname IN (SELECT relname FROM collector_writes)
    LOOP
        IF NOT has_sequence_privilege('bas_collector', 'public.' || r.relname, 'USAGE') THEN
            fail := fail || ('no USAGE on ' || r.relname || ' - the collector''s INSERT into its table would fail');
        END IF;
    END LOOP;
    IF NOT has_sequence_privilege('bas_collector', 'public.bas_data_gaps_gap_id_seq', 'USAGE') THEN fail := fail || 'no USAGE on bas_data_gaps_gap_id_seq (record_gap INSERTs; this was the 2026-11-06 outage)'; END IF;
    IF NOT has_table_privilege('bas_collector', 'public.bas_station_credentials', 'SELECT')  THEN fail := fail || 'cannot SELECT bas_station_credentials (B7.5 needs it)'; END IF;
    IF NOT has_table_privilege('bas_collector', 'public.bas_v_collection_health', 'SELECT')  THEN fail := fail || 'cannot SELECT bas_v_collection_health'; END IF;
    IF NOT EXISTS (
        SELECT 1
          FROM pg_default_acl d
          JOIN pg_namespace n ON n.oid = d.defaclnamespace
         CROSS JOIN LATERAL aclexplode(d.defaclacl) a
         WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
           AND n.nspname = 'public' AND d.defaclobjtype = 'S'
           AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'bas_collector')
           AND a.privilege_type = 'USAGE'
    ) THEN
        fail := fail || ('no default USAGE on new sequences created by ' || current_user);
    END IF;

    IF has_table_privilege('bas_collector', 'public.bas_station_credentials', 'INSERT')      THEN fail := fail || 'CAN INSERT bas_station_credentials'; END IF;
    IF has_table_privilege('bas_collector', 'public.bas_station_credentials', 'UPDATE')      THEN fail := fail || 'CAN UPDATE bas_station_credentials'; END IF;
    IF has_table_privilege('bas_collector', 'public.employees', 'SELECT')                    THEN fail := fail || 'CAN SELECT employees'; END IF;
    IF has_table_privilege('bas_collector', 'public.bas_report_recipients', 'SELECT')        THEN fail := fail || 'CAN SELECT bas_report_recipients'; END IF;
    IF has_table_privilege('bas_collector', 'public.bas_report_definitions', 'SELECT')       THEN fail := fail || 'CAN SELECT bas_report_definitions'; END IF;
    IF has_table_privilege('bas_collector', 'public.bas_report_settings', 'SELECT')          THEN fail := fail || 'CAN SELECT bas_report_settings'; END IF;
    IF has_table_privilege('bas_collector', 'public.bas_site_occupancy', 'SELECT')           THEN fail := fail || 'CAN SELECT bas_site_occupancy'; END IF;
    IF has_table_privilege('bas_collector', 'public.audit_events', 'SELECT')                 THEN fail := fail || 'CAN SELECT audit_events'; END IF;
    IF has_table_privilege('bas_collector', 'public._prisma_migrations', 'SELECT')           THEN fail := fail || 'CAN SELECT _prisma_migrations'; END IF;
    IF has_table_privilege('bas_collector', 'public.module_grants', 'SELECT')                THEN fail := fail || 'CAN SELECT module_grants'; END IF;
    IF has_table_privilege('bas_collector', 'public.bas_readings', 'TRUNCATE')               THEN fail := fail || 'CAN TRUNCATE bas_readings'; END IF;
    IF has_sequence_privilege('bas_collector', 'public.bas_points_point_id_seq', 'UPDATE')   THEN fail := fail || 'CAN setval bas_points_point_id_seq'; END IF;
    IF has_sequence_privilege('bas_collector', 'public.bas_report_runs_run_id_seq', 'USAGE') THEN fail := fail || 'has USAGE on bas_report_runs_run_id_seq, a sequence it never uses'; END IF;
    IF has_schema_privilege('bas_collector', 'public', 'CREATE')                             THEN fail := fail || 'CAN CREATE in public'; END IF;
    IF (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname = 'bas_collector') THEN fail := fail || 'has a role attribute it must not'; END IF;

    IF array_length(fail, 1) > 0 THEN
        RAISE EXCEPTION 'bas_collector boundary proof FAILED: %. The role exists and has been granted; '
            'do not hand out its password until this passes.', fail;
    END IF;
    RAISE NOTICE 'bas_collector: writes bas_* data, reads credentials and views, refused everywhere else. OK.';
END
$proof$;

DROP TABLE collector_rw, collector_writes, collector_ro, collector_none, collector_seq;

\echo ''
\if :keep_password
\echo 'Re-asserted role bas_collector on this database. Its password was NOT changed: the'
\echo 'collector host''s .env keeps working as it is, and nothing needs restarting.'
\else
\echo 'Created/updated role: bas_collector on this database, with the password you passed.'
\echo 'Connection string for the collector''s .env (add ?sslmode=require for Azure):'
\echo '  postgresql://bas_collector:<the password you passed>@<host>:5432/<database>'
\endif
\echo ''
\echo 'Prove the refusals from the outside as well - a grant that lets the right thing'
\echo 'through proves nothing on its own. As the collector, on the collector host:'
\echo '  python -m collector check                                     -- Database: privileges OK'
\echo '  psql "<collector URL>" -c "SELECT count(*) FROM employees"       -- must be DENIED'
\echo '  psql "<collector URL>" -c "CREATE TABLE zz (x int)"              -- must be DENIED'
\echo ''
