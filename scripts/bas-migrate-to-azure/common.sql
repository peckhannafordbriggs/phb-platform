-- =============================================================================
-- Shared definitions for the BAS data migration. Included by export.sql,
-- import.sql and check.sql with \ir, so the three files cannot disagree about
-- which tables move, in what order, or how a table's contents are fingerprinted.
--
-- Everything here is TEMPORARY: a temp table and functions in pg_temp. Nothing
-- is created in the public schema of either database, and it all vanishes when
-- the session ends. Requires PostgreSQL 15 or newer (COPY ... HEADER MATCH is
-- used by the files that include this one); both databases are 17.
-- =============================================================================

-- Deterministic text output. A row's fingerprint is md5 of its text form, and
-- the text form of a timestamptz depends on the session's time zone, of a
-- double on extra_float_digits. Fixed here, identically, on both sides.
-- Session-level SET rather than SET LOCAL, so check.sql gives the same answer
-- whether it runs inside import.sql's transaction or on its own afterwards;
-- SET LOCAL outside a transaction block is a no-op with a warning.
SET TimeZone = 'UTC';
SET DateStyle = 'ISO, YMD';
SET IntervalStyle = 'postgres';
SET extra_float_digits = 3;


-- --- the tables, in the order they must be inserted -------------------------
--
-- Order is topological over the foreign keys inspected on 2026-09-29:
--   orgs <- projects <- sites <- stations <- points <- readings, links,
--   checkpoints, gaps; sites <- equipment <- points; stations <- ingest_runs,
--   credentials; the two vocabularies stand alone but points reference them.
-- Self-references (point_roles, stations, equipment) need no ordering: a
-- foreign key is checked at the end of the COPY statement, not per row.
--
--   order_by      the primary key, so a fingerprint is order-independent
--   row_expr      what is fingerprinted. `t::text` is the whole row. The one
--                 exception is the credentials table, whose updated_by column
--                 is deliberately different on the two sides.
--   id_column /   the bigint id and its sequence, for the eight tables that
--   sequence_name have one. NULL for the six that do not.
--   kind          'data'        emptied-target tables, copied as they are
--                 'vocabulary'  reference rows the production seed also writes;
--                               merged, and refused if a shared row differs
--                 'credentials' one column repointed at a target employee

CREATE TEMP TABLE mig_tables (
    ordinal        int  PRIMARY KEY,
    table_name     text NOT NULL UNIQUE,
    kind           text NOT NULL CHECK (kind IN ('data', 'vocabulary', 'credentials')),
    order_by       text NOT NULL,
    row_expr       text NOT NULL DEFAULT 't::text',
    id_column      text,
    sequence_name  text
);

INSERT INTO mig_tables (ordinal, table_name, kind, order_by, id_column, sequence_name) VALUES
    ( 1, 'bas_orgs',             'data',       'org_id',                              'org_id',       'bas_orgs_org_id_seq'),
    ( 2, 'bas_projects',         'data',       'project_id',                          'project_id',   'bas_projects_project_id_seq'),
    ( 3, 'bas_sites',            'data',       'site_id',                             'site_id',      'bas_sites_site_id_seq'),
    ( 4, 'bas_equipment_types',  'vocabulary', 'equip_type',                          NULL,           NULL),
    ( 5, 'bas_point_roles',      'vocabulary', 'point_role',                          NULL,           NULL),
    ( 6, 'bas_stations',         'data',       'station_id',                          'station_id',   'bas_stations_station_id_seq'),
    ( 7, 'bas_equipment',        'data',       'equipment_id',                        'equipment_id', 'bas_equipment_equipment_id_seq'),
    ( 8, 'bas_points',           'data',       'point_id',                            'point_id',     'bas_points_point_id_seq'),
    ( 9, 'bas_readings',         'data',       'point_id, ts',                        NULL,           NULL),
    (10, 'bas_point_links',      'data',       'from_point_id, to_point_id, link_type', NULL,         NULL),
    (11, 'bas_sync_checkpoints', 'data',       'point_id',                            NULL,           NULL),
    (12, 'bas_data_gaps',        'data',       'gap_id',                              'gap_id',       'bas_data_gaps_gap_id_seq'),
    (13, 'bas_ingest_runs',      'data',       'run_id',                              'run_id',       'bas_ingest_runs_run_id_seq'),
    (14, 'bas_station_credentials', 'credentials', 'station_id',                      NULL,           NULL);

-- updated_by is a uuid into employees, and the two databases hold different
-- people. The fingerprint covers every other column, so content is still
-- compared while the one column that is meant to differ is left out.
UPDATE mig_tables
   SET row_expr = '(t.station_id, t.username, t.password_ciphertext, t.key_version, t.updated_at)::text'
 WHERE table_name = 'bas_station_credentials';


-- --- the gate ---------------------------------------------------------------
--
-- Every bas_* base table in this database must be listed above, and every
-- table listed must exist. A table this file has never heard of stops the run:
-- copying a subset and calling it a migration is the failure this exists to
-- prevent, and a typo in the list is the other one.

CREATE FUNCTION pg_temp.mig_gate() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    present      text[];
    unlisted     text[];
    missing      text[];
BEGIN
    SELECT coalesce(array_agg(c.relname ORDER BY c.relname), '{}')
      INTO present
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       -- 'bas\_%' with the underscore escaped: unescaped, '_' matches any one
       -- character and 'basement_survey' would qualify.
       AND c.relname LIKE 'bas\_%';

    SELECT coalesce(array_agg(p ORDER BY p), '{}')
      INTO unlisted
      FROM unnest(present) AS p
     WHERE p NOT IN (SELECT table_name FROM mig_tables);

    IF array_length(unlisted, 1) > 0 THEN
        RAISE EXCEPTION 'bas_* table(s) this migration does not know about: %. '
            'Add each one to mig_tables in common.sql, in dependency order, '
            'and decide its kind. Nothing has been written.', unlisted;
    END IF;

    SELECT coalesce(array_agg(m.table_name ORDER BY m.table_name), '{}')
      INTO missing
      FROM mig_tables m
     WHERE m.table_name <> ALL (present);

    IF array_length(missing, 1) > 0 THEN
        RAISE EXCEPTION 'table(s) listed in common.sql are not in this database: %. '
            'Either the name is wrong or the schema here is behind. Nothing has been written.',
            missing;
    END IF;

    RAISE NOTICE 'gate: % bas_* table(s) present, all % listed', array_length(present, 1), (SELECT count(*) FROM mig_tables);
END
$$;


-- --- measuring a table ------------------------------------------------------
--
-- One row per table: count, fingerprint, highest id. Run on the source it
-- produces the manifest; run on the target it produces what is compared with
-- the manifest. Same function, same session settings, so the two are
-- comparable byte for byte.

CREATE FUNCTION pg_temp.mig_measure()
RETURNS TABLE (ordinal int, table_name text, row_count bigint, checksum text, max_id bigint)
LANGUAGE plpgsql AS $$
DECLARE
    t record;
BEGIN
    FOR t IN SELECT * FROM mig_tables ORDER BY mig_tables.ordinal LOOP
        RETURN QUERY EXECUTE format(
            'SELECT %s::int, %L::text, count(*)::bigint, '
            '       coalesce(md5(string_agg(%s, E''\n'' ORDER BY %s)), ''empty'')::text, '
            '       %s::bigint '
            '  FROM public.%I t',
            t.ordinal, t.table_name, t.row_expr, t.order_by,
            CASE WHEN t.id_column IS NULL THEN 'NULL' ELSE format('max(t.%I)', t.id_column) END,
            t.table_name);
    END LOOP;
END
$$;


-- --- foreign keys -----------------------------------------------------------
--
-- Every foreign key whose child is a bas_* table, read from the catalog rather
-- than listed, with the number of child rows whose referenced row is missing.
-- Includes the one that leaves the bas_* family (credentials -> employees).
-- A non-zero count anywhere is a failed migration.

CREATE FUNCTION pg_temp.mig_fk_orphans()
RETURNS TABLE (child_table text, constraint_name text, parent_table text, orphans bigint)
LANGUAGE plpgsql AS $$
DECLARE
    fk record;
    child_cols text;
    parent_cols text;
BEGIN
    FOR fk IN
        SELECT c.oid, c.conname, c.conrelid, c.confrelid, c.conkey, c.confkey
          FROM pg_constraint c
         WHERE c.contype = 'f'
           AND c.conrelid::regclass::text LIKE 'bas\_%'
         ORDER BY c.conrelid::regclass::text, c.conname
    LOOP
        SELECT string_agg(format('ch.%I', a.attname), ', ' ORDER BY k.ord)
          INTO child_cols
          FROM unnest(fk.conkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = fk.conrelid AND a.attnum = k.attnum;

        SELECT string_agg(format('pa.%I', a.attname), ', ' ORDER BY k.ord)
          INTO parent_cols
          FROM unnest(fk.confkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = fk.confrelid AND a.attnum = k.attnum;

        RETURN QUERY EXECUTE format(
            'SELECT %L::text, %L::text, %L::text, count(*)::bigint '
            '  FROM %s ch '
            ' WHERE (%s) IS NOT NULL '
            '   AND NOT EXISTS (SELECT 1 FROM %s pa WHERE (%s) = (%s))',
            fk.conrelid::regclass::text, fk.conname, fk.confrelid::regclass::text,
            fk.conrelid::regclass, child_cols,
            fk.confrelid::regclass, parent_cols, child_cols);
    END LOOP;
END
$$;


-- --- sequences ---------------------------------------------------------------
--
-- For each table with a bigint id: the highest id held and where its sequence
-- stands. `next_value_ok` is the property that matters - the next nextval()
-- must be greater than every id in the table. pg_sequence_last_value() is NULL
-- for a sequence that has never been called, which on a table with rows is
-- exactly the collision waiting to happen.

CREATE FUNCTION pg_temp.mig_sequences()
RETURNS TABLE (table_name text, sequence_name text, max_id bigint, last_value bigint, next_value_ok boolean)
LANGUAGE plpgsql AS $$
DECLARE
    t record;
BEGIN
    FOR t IN SELECT * FROM mig_tables WHERE mig_tables.sequence_name IS NOT NULL ORDER BY mig_tables.ordinal LOOP
        RETURN QUERY EXECUTE format(
            'SELECT %L::text, %L::text, max(%I)::bigint, '
            '       pg_sequence_last_value(%L::regclass)::bigint, '
            '       (max(%I) IS NULL OR coalesce(pg_sequence_last_value(%L::regclass), 0) >= max(%I))::boolean '
            '  FROM public.%I',
            t.table_name, t.sequence_name, t.id_column,
            'public.' || t.sequence_name,
            t.id_column, 'public.' || t.sequence_name, t.id_column,
            t.table_name);
    END LOOP;
END
$$;


-- --- the tables that must not change -----------------------------------------
--
-- Every base table in public that is NOT a bas_* table, fingerprinted whole.
-- Read from the catalog, not listed, so a table added after this was written
-- is covered without anyone remembering to add it. import.sql takes this
-- before and after and refuses to commit if any line differs.

CREATE FUNCTION pg_temp.mig_protected()
RETURNS TABLE (table_name text, row_count bigint, checksum text)
LANGUAGE plpgsql AS $$
DECLARE
    t record;
BEGIN
    FOR t IN
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'p')
           AND c.relname NOT LIKE 'bas\_%'
         ORDER BY c.relname
    LOOP
        RETURN QUERY EXECUTE format(
            'SELECT %L::text, count(*)::bigint, '
            '       coalesce(md5(string_agg(t::text, E''\n'' ORDER BY t::text)), ''empty'')::text '
            '  FROM public.%I t',
            t.relname, t.relname);
    END LOOP;
END
$$;
