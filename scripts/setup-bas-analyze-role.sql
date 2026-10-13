-- =============================================================================
-- bas_analyze: the PostgreSQL role the Analyze tab's SQL runs as - for psql.
--
-- WHY THIS FILE EXISTS
--
-- `npm run bas:analyze:role` (scripts/setup-bas-analyze-role.ts) builds this
-- role from lib/modules/bas/analyze/role.ts and needs Node, this repository
-- and a DATABASE_URL pointing at the target. Production is an Azure database
-- that you may only be able to reach from the Azure portal's Cloud Shell,
-- which has psql and az and nothing else. This file is the same role, as psql,
-- in the shape of scripts/setup-bas-collector-role.sql: an explicit allowlist,
-- a named withhold list, a gate that refuses to run on an unclassified bas_*
-- object, and a proof of the boundary before it finishes.
--
-- The lists below are a COPY of ANALYZE_ALLOWLIST, ANALYZE_WITHHELD and
-- PLATFORM_TABLES in role.ts. tests/bas-analyze-role-sql.test.ts fails the
-- build if the two drift, and runs this file through the real psql against the
-- test database under a throwaway role name. Change role.ts first, then this.
--
-- WHAT IT CAN DO
--
--   SELECT only, on the thirteen bas_* data tables and the six bas_v_* views -
--   nineteen objects, named below. That is every object the planner is shown
--   (bas_v_data_dictionary lists them) and so every object its SELECT may
--   legitimately name. It is NOT narrowed to what the platform's own code
--   reads: the platform's provenance and schema queries touch eleven of the
--   nineteen, but the model writes the question's query and a grant narrower
--   than the dictionary turns a fair question into "permission denied"
--   (runbook.md, *Analyze answers "permission denied" for every question*).
--   CONNECT on the database, USAGE on schema public.
--   Role defaults: statement_timeout 30s, default_transaction_read_only on.
--
-- WHAT IT CANNOT DO
--
--   Read bas_station_credentials (withheld by name - the Niagara logins).
--   Read any platform table: employees, audit_events, module_grants, modules,
--   positions, departments, draft_locks, _prisma_migrations (revoked by name).
--   INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER anywhere.
--   CREATE anything (no CREATE on the schema, NOCREATEDB, NOCREATEROLE).
--   Use a sequence or call a function.
--
-- RUN IT, IN PRODUCTION
--
--   As the server ADMINISTRATOR, against the Azure database. In Azure the
--   administrator login is not a superuser but owns every table and can
--   create roles, which is all this needs. You will need:
--
--     - the administrator connection URL (host, admin login, admin password,
--       database phb_platform, sslmode=require);
--     - a NEW password for bas_analyze, which YOU choose at run time. It is
--       never written in this file or anywhere in the repository, this script
--       prints it nowhere, and `az` never sees it.
--
--   From any machine with psql that can reach the server:
--
--     read -s -p "New bas_analyze password: " PW; echo
--     psql "postgresql://<admin>:<admin-password>@<server>.postgres.database.azure.com:5432/phb_platform?sslmode=require" \
--          -v pw="$PW" -f scripts/setup-bas-analyze-role.sql
--     unset PW
--
--   `read -s` keeps the password off the command line and out of the shell
--   history; -v pw= hands it to psql as a variable; :'pw' below quotes it as a
--   SQL literal, so any character is fine.
--
--   OFF THE OFFICE NETWORK: use the Azure portal's Cloud Shell (Bash), which
--   ships psql. Upload this file with the shell's Upload button, or fetch it:
--     curl -O https://raw.githubusercontent.com/peckhannafordbriggs/phb-platform/main/scripts/setup-bas-analyze-role.sql
--   The server's firewall must admit the shell. Add a temporary rule for the
--   shell's outbound address and remove it afterwards:
--     IP=$(curl -s https://ifconfig.me)
--     az postgres flexible-server firewall-rule create -g <resource-group> -n <server> \
--        --rule-name cloudshell-temp --start-ip-address $IP --end-ip-address $IP
--     ...run the script...
--     az postgres flexible-server firewall-rule delete -g <resource-group> -n <server> \
--        --rule-name cloudshell-temp --yes
--
--   Re-running rotates the password and re-asserts the grants; it never widens
--   them. It proves the boundary before it finishes and fails loudly if the
--   proof fails. Then the URL for Key Vault (BAS-ASK-DATABASE-URL; infra/README.md):
--
--     postgresql://bas_analyze:<the password you chose>@<server>.postgres.database.azure.com:5432/phb_platform?sslmode=require
--
--   Roles are cluster-wide. A password set here on a server is that server's
--   only password for the role: rotating it in Azure does not touch the office
--   PC, and the other way round.
--
--   -v role=<name> builds a role of another name from the same lists. The test
--   uses it for a throwaway; production never needs it.
-- =============================================================================

\set ON_ERROR_STOP on
\pset pager off

\if :{?pw}
\else
\echo 'ERROR: pass the password with  -v pw=yourpassword  (see the header for the read -s pattern)'
\quit 1
\endif

\if :{?role}
\else
\set role bas_analyze
\endif

-- The role name, reachable from inside the DO blocks below, which psql does
-- not substitute :variables into.
SELECT set_config('analyze.role', :'role', false) AS role_name;


-- --- the allowlist, a copy of lib/modules/bas/analyze/role.ts ------------------

CREATE TEMP TABLE analyze_ro (relname text PRIMARY KEY);
INSERT INTO analyze_ro (relname) VALUES
    -- Hierarchy and metadata.
    ('bas_orgs'),
    ('bas_projects'),
    ('bas_sites'),
    ('bas_stations'),
    ('bas_equipment'),
    -- Controlled vocabularies.
    ('bas_equipment_types'),
    ('bas_point_roles'),
    -- Points, their relationships, and the numbers.
    ('bas_points'),
    ('bas_point_links'),
    ('bas_readings'),
    -- Operational.
    ('bas_sync_checkpoints'),
    ('bas_ingest_runs'),
    ('bas_data_gaps'),
    -- The six views. The data dictionary is the planner's schema source.
    ('bas_v_point'),
    ('bas_v_reading'),
    ('bas_v_setpoint_pair'),
    ('bas_v_command_status_pair'),
    ('bas_v_collection_health'),
    ('bas_v_data_dictionary');

CREATE TEMP TABLE analyze_hold (relname text PRIMARY KEY, reason text);
INSERT INTO analyze_hold (relname, reason) VALUES
    ('bas_station_credentials', 'AES-256-GCM ciphertext of the Niagara logins; a read-only role is refused it by being a separate table');

CREATE TEMP TABLE analyze_platform (relname text PRIMARY KEY);
INSERT INTO analyze_platform (relname) VALUES
    ('employees'),
    ('audit_events'),
    ('module_grants'),
    ('modules'),
    ('positions'),
    ('departments'),
    ('draft_locks'),
    ('_prisma_migrations');


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
      FROM analyze_ro a JOIN analyze_hold h USING (relname);
    IF array_length(conflicted, 1) > 0 THEN
        RAISE EXCEPTION 'These objects are both allowed and withheld: %. Pick one.', conflicted;
    END IF;

    SELECT coalesce(array_agg(p ORDER BY p), '{}')
      INTO unclassified
      FROM unnest(present) AS p
     WHERE p NOT IN (SELECT relname FROM analyze_ro)
       AND p NOT IN (SELECT relname FROM analyze_hold);
    IF array_length(unclassified, 1) > 0 THEN
        RAISE EXCEPTION 'Unclassified bas_* object(s): %. Nothing has been granted or revoked. '
            'Add each name to ANALYZE_ALLOWLIST or ANALYZE_WITHHELD in lib/modules/bas/analyze/role.ts, '
            'then to analyze_ro or analyze_hold in this file.',
            unclassified;
    END IF;

    SELECT coalesce(array_agg(a.relname ORDER BY a.relname), '{}')
      INTO missing
      FROM analyze_ro a
     WHERE a.relname <> ALL (present);
    IF array_length(missing, 1) > 0 THEN
        RAISE EXCEPTION 'Allowlisted object(s) not found in this database: %. Apply the platform migrations first.', missing;
    END IF;

    RAISE NOTICE 'Gate passed: % bas_* object(s) present, % readable, % withheld.',
        coalesce(array_length(present, 1), 0),
        (SELECT count(*) FROM analyze_ro),
        (SELECT count(*) FROM analyze_hold);
END
$gate$;


-- --- the role ----------------------------------------------------------------
--
-- CREATE or ALTER, so re-running rotates the password. Built as text outside
-- a $$ block because psql does not substitute :variables inside one, stored
-- with \gset and run as :role_stmt rather than \gexec, which would print the
-- statement - password included - on the terminal (see the collector script).

SELECT format('%s ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',
              CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') THEN 'ALTER' ELSE 'CREATE' END,
              :'role',
              :'pw') AS role_stmt \gset
:role_stmt ;

DO $c$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), current_setting('analyze.role')); END $c$;
DO $u$ BEGIN EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', current_setting('analyze.role')); END $u$;


-- --- grants: SELECT on the allowlist and nothing else --------------------------

DO $grant$
DECLARE
    r    record;
    role text := current_setting('analyze.role');
BEGIN
    FOR r IN SELECT relname FROM analyze_ro ORDER BY relname LOOP
        EXECUTE format('REVOKE ALL ON public.%I FROM %I', r.relname, role);
        EXECUTE format('GRANT SELECT ON public.%I TO %I', r.relname, role);
    END LOOP;
    -- Withheld: revoked if present. A withheld name may legitimately not
    -- exist yet, unlike an allowlisted one.
    FOR r IN SELECT relname FROM analyze_hold ORDER BY relname LOOP
        IF to_regclass('public.' || r.relname) IS NOT NULL THEN
            EXECUTE format('REVOKE ALL ON public.%I FROM %I', r.relname, role);
        END IF;
    END LOOP;
    -- Everything that is not a read, everywhere in public.
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM %I', role);
    EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', role);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', role);
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', role);
    -- The platform's own tables, by name, so a reader can see the question
    -- was asked. TEMP is deliberately not revoked: it is a PUBLIC grant on
    -- the database and revoking it from one role has no effect (role.ts).
    FOR r IN SELECT relname FROM analyze_platform ORDER BY relname LOOP
        IF to_regclass('public.' || r.relname) IS NOT NULL THEN
            EXECUTE format('REVOKE ALL ON public.%I FROM %I', r.relname, role);
        END IF;
    END LOOP;
    -- Role-level defaults. A client can turn read-only off (runbook.md, *Two
    -- independent layers stop writes*), which is why the grants above are the
    -- layer that counts; the platform's pool opens READ ONLY anyway.
    EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', role, '30s');
    EXECUTE format('ALTER ROLE %I SET default_transaction_read_only = on', role);
    EXECUTE format('COMMENT ON ROLE %I IS %L', role,
        'The Analyze tab (B5). SELECT on an allowlist of bas_* tables and views, nothing else. '
        'scripts/setup-bas-analyze-role.sql in phb-platform creates it and proves the boundary; '
        'lib/modules/bas/analyze/role.ts is the list it copies.');
    RAISE NOTICE 'Granted SELECT on % objects to %, withheld %, revoked % platform tables by name.',
        (SELECT count(*) FROM analyze_ro), role,
        (SELECT count(*) FROM analyze_hold), (SELECT count(*) FROM analyze_platform);
END
$grant$;


-- --- prove it, before anyone relies on it ------------------------------------------
--
-- The same proofs scripts/setup-bas-analyze-role.ts runs, asked of the catalog.
-- A grant that lets the right thing through proves nothing on its own; the
-- refusals are the test.

DO $proof$
DECLARE
    role text := current_setting('analyze.role');
    fail text[] := '{}';
BEGIN
    IF NOT has_table_privilege(role, 'public.bas_points', 'SELECT')                 THEN fail := fail || 'cannot SELECT bas_points'; END IF;
    IF NOT has_table_privilege(role, 'public.bas_v_data_dictionary', 'SELECT')      THEN fail := fail || 'cannot SELECT bas_v_data_dictionary (the planner''s schema source)'; END IF;
    IF NOT has_table_privilege(role, 'public.bas_readings', 'SELECT')               THEN fail := fail || 'cannot SELECT bas_readings'; END IF;

    IF to_regclass('public.bas_station_credentials') IS NOT NULL
       AND has_table_privilege(role, 'public.bas_station_credentials', 'SELECT')    THEN fail := fail || 'CAN SELECT bas_station_credentials'; END IF;
    IF has_table_privilege(role, 'public.employees', 'SELECT')                      THEN fail := fail || 'CAN SELECT employees'; END IF;
    IF has_table_privilege(role, 'public.audit_events', 'SELECT')                   THEN fail := fail || 'CAN SELECT audit_events'; END IF;
    IF has_table_privilege(role, 'public.module_grants', 'SELECT')                  THEN fail := fail || 'CAN SELECT module_grants'; END IF;
    IF has_table_privilege(role, 'public._prisma_migrations', 'SELECT')             THEN fail := fail || 'CAN SELECT _prisma_migrations'; END IF;
    IF has_table_privilege(role, 'public.bas_orgs', 'INSERT')                       THEN fail := fail || 'CAN INSERT bas_orgs'; END IF;
    IF has_table_privilege(role, 'public.bas_readings', 'UPDATE')                   THEN fail := fail || 'CAN UPDATE bas_readings'; END IF;
    IF has_table_privilege(role, 'public.bas_readings', 'DELETE')                   THEN fail := fail || 'CAN DELETE bas_readings'; END IF;
    IF has_table_privilege(role, 'public.bas_readings', 'TRUNCATE')                 THEN fail := fail || 'CAN TRUNCATE bas_readings'; END IF;
    IF has_schema_privilege(role, 'public', 'CREATE')                               THEN fail := fail || 'CAN CREATE in public'; END IF;
    IF has_sequence_privilege(role, 'public.bas_points_point_id_seq', 'USAGE')      THEN fail := fail || 'has USAGE on bas_points_point_id_seq'; END IF;
    IF (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit FROM pg_roles WHERE rolname = role)
                                                                                     THEN fail := fail || 'has a role attribute it must not'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role
                    AND 'statement_timeout=30s' = ANY (rolconfig)
                    AND 'default_transaction_read_only=on' = ANY (rolconfig))      THEN fail := fail || 'role defaults not set'; END IF;

    IF array_length(fail, 1) > 0 THEN
        RAISE EXCEPTION '% boundary proof FAILED: %. The role exists and has been granted; '
            'do not put its URL anywhere until this passes.', role, fail;
    END IF;
    RAISE NOTICE '%: reads the allowlist, refused everywhere else. OK.', role;
END
$proof$;

DROP TABLE analyze_ro, analyze_hold, analyze_platform;

\echo ''
\echo 'Created/updated role: ' :role ' on this database.'
\echo 'Connection URL for Key Vault (BAS-ASK-DATABASE-URL) or .env.local (BAS_ASK_DATABASE_URL):'
\echo '  postgresql://' :role ':<the password you passed>@<host>:5432/<database>?sslmode=require'
\echo ''
\echo 'Prove the refusals from the outside as well:'
\echo '  psql "<that URL>" -c "SELECT count(*) FROM bas_points"                -- must work'
\echo '  psql "<that URL>" -c "SELECT count(*) FROM bas_station_credentials"   -- must be DENIED'
\echo '  psql "<that URL>" -c "SELECT count(*) FROM employees"                 -- must be DENIED'
\echo '  psql "<that URL>" -c "INSERT INTO bas_orgs (name) VALUES (''x'')"      -- must be DENIED'
\echo ''
