-- CreateTable
CREATE TABLE "bas_equipment_types" (
    "equip_type" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,

    CONSTRAINT "bas_equipment_types_pkey" PRIMARY KEY ("equip_type")
);

-- CreateTable
CREATE TABLE "bas_point_roles" (
    "point_role" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "measurement" TEXT,
    "typical_unit" TEXT,
    "is_setpoint" BOOLEAN NOT NULL DEFAULT false,
    "is_command" BOOLEAN NOT NULL DEFAULT false,
    "is_status" BOOLEAN NOT NULL DEFAULT false,
    "setpoint_for" TEXT,
    "status_of" TEXT,

    CONSTRAINT "bas_point_roles_pkey" PRIMARY KEY ("point_role")
);

-- CreateTable
CREATE TABLE "bas_orgs" (
    "org_id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bas_orgs_pkey" PRIMARY KEY ("org_id")
);

-- CreateTable
CREATE TABLE "bas_sites" (
    "site_id" BIGSERIAL NOT NULL,
    "org_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "timezone" TEXT NOT NULL,
    "area_sqft" INTEGER,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bas_sites_pkey" PRIMARY KEY ("site_id")
);

-- CreateTable
CREATE TABLE "bas_stations" (
    "station_id" BIGSERIAL NOT NULL,
    "site_id" BIGINT NOT NULL,
    "niagara_station_name" TEXT NOT NULL,
    "base_url" TEXT,
    "host_id" TEXT,
    "model" TEXT,
    "niagara_version" TEXT,
    "parent_station_id" BIGINT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "first_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ,

    CONSTRAINT "bas_stations_pkey" PRIMARY KEY ("station_id")
);

-- CreateTable
CREATE TABLE "bas_equipment" (
    "equipment_id" BIGSERIAL NOT NULL,
    "site_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "equip_type" TEXT,
    "parent_equipment_id" BIGINT,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bas_equipment_pkey" PRIMARY KEY ("equipment_id")
);

-- CreateTable
CREATE TABLE "bas_points" (
    "point_id" BIGSERIAL NOT NULL,
    "station_id" BIGINT NOT NULL,
    "equipment_id" BIGINT,
    "niagara_history_name" TEXT NOT NULL,
    "niagara_history_ord" TEXT,
    "display_name" TEXT,
    "point_role" TEXT,
    "unit" TEXT,
    "data_type" TEXT NOT NULL DEFAULT 'unknown',
    "source_timezone" TEXT,
    "collection_interval_s" INTEGER,
    "capacity" INTEGER,
    "full_policy" TEXT,
    "roll_horizon_s" INTEGER,
    "tags" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "first_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ,

    CONSTRAINT "bas_points_pkey" PRIMARY KEY ("point_id")
);

-- CreateTable
CREATE TABLE "bas_readings" (
    "point_id" BIGINT NOT NULL,
    "ts" TIMESTAMPTZ NOT NULL,
    "value_num" DOUBLE PRECISION,
    "value_bool" BOOLEAN,
    "value_str" TEXT,
    "status" TEXT,

    CONSTRAINT "bas_readings_pkey" PRIMARY KEY ("point_id","ts")
);

-- CreateTable
CREATE TABLE "bas_point_links" (
    "from_point_id" BIGINT NOT NULL,
    "to_point_id" BIGINT NOT NULL,
    "link_type" TEXT NOT NULL,
    "confidence" TEXT NOT NULL DEFAULT 'manual',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bas_point_links_pkey" PRIMARY KEY ("from_point_id","to_point_id","link_type")
);

-- CreateTable
CREATE TABLE "bas_sync_checkpoints" (
    "point_id" BIGINT NOT NULL,
    "last_record_ts" TIMESTAMPTZ,
    "last_run_at" TIMESTAMPTZ,
    "last_status" TEXT NOT NULL DEFAULT 'never_run',
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "bas_sync_checkpoints_pkey" PRIMARY KEY ("point_id")
);

-- CreateTable
CREATE TABLE "bas_ingest_runs" (
    "run_id" BIGSERIAL NOT NULL,
    "station_id" BIGINT,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,
    "status" TEXT NOT NULL DEFAULT 'running',
    "window_start" TIMESTAMPTZ,
    "window_end" TIMESTAMPTZ,
    "points_attempted" INTEGER NOT NULL DEFAULT 0,
    "points_succeeded" INTEGER NOT NULL DEFAULT 0,
    "records_written" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "collector_version" TEXT,
    "collector_host" TEXT,

    CONSTRAINT "bas_ingest_runs_pkey" PRIMARY KEY ("run_id")
);

-- CreateTable
CREATE TABLE "bas_data_gaps" (
    "gap_id" BIGSERIAL NOT NULL,
    "point_id" BIGINT NOT NULL,
    "gap_start" TIMESTAMPTZ NOT NULL,
    "gap_end" TIMESTAMPTZ NOT NULL,
    "detected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cause" TEXT NOT NULL,
    "notes" TEXT,

    CONSTRAINT "bas_data_gaps_pkey" PRIMARY KEY ("gap_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bas_orgs_name_key" ON "bas_orgs"("name");

-- CreateIndex
CREATE UNIQUE INDEX "bas_sites_org_id_name_key" ON "bas_sites"("org_id", "name");

-- CreateIndex
CREATE INDEX "bas_stations_site_id_idx" ON "bas_stations"("site_id");

-- CreateIndex
CREATE UNIQUE INDEX "bas_stations_site_id_niagara_station_name_key" ON "bas_stations"("site_id", "niagara_station_name");

-- CreateIndex
CREATE INDEX "bas_equipment_site_id_idx" ON "bas_equipment"("site_id");

-- CreateIndex
CREATE INDEX "bas_equipment_equip_type_idx" ON "bas_equipment"("equip_type");

-- CreateIndex
CREATE INDEX "bas_equipment_parent_equipment_id_idx" ON "bas_equipment"("parent_equipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "bas_equipment_site_id_name_key" ON "bas_equipment"("site_id", "name");

-- CreateIndex
CREATE INDEX "bas_points_station_id_idx" ON "bas_points"("station_id");

-- CreateIndex
CREATE INDEX "bas_points_equipment_id_idx" ON "bas_points"("equipment_id");

-- CreateIndex
CREATE INDEX "bas_points_point_role_idx" ON "bas_points"("point_role");

-- CreateIndex
CREATE INDEX "bas_points_is_active_idx" ON "bas_points"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "bas_points_station_id_niagara_history_name_key" ON "bas_points"("station_id", "niagara_history_name");

-- CreateIndex
CREATE INDEX "bas_readings_ts_idx" ON "bas_readings" USING BRIN ("ts");

-- CreateIndex
CREATE INDEX "bas_point_links_to_point_id_idx" ON "bas_point_links"("to_point_id");

-- CreateIndex
CREATE INDEX "bas_ingest_runs_started_at_idx" ON "bas_ingest_runs"("started_at" DESC);

-- CreateIndex
CREATE INDEX "bas_data_gaps_point_id_gap_start_idx" ON "bas_data_gaps"("point_id", "gap_start");

-- AddForeignKey
ALTER TABLE "bas_point_roles" ADD CONSTRAINT "bas_point_roles_setpoint_for_fkey" FOREIGN KEY ("setpoint_for") REFERENCES "bas_point_roles"("point_role") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_point_roles" ADD CONSTRAINT "bas_point_roles_status_of_fkey" FOREIGN KEY ("status_of") REFERENCES "bas_point_roles"("point_role") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_sites" ADD CONSTRAINT "bas_sites_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "bas_orgs"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_stations" ADD CONSTRAINT "bas_stations_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "bas_sites"("site_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_stations" ADD CONSTRAINT "bas_stations_parent_station_id_fkey" FOREIGN KEY ("parent_station_id") REFERENCES "bas_stations"("station_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_equipment" ADD CONSTRAINT "bas_equipment_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "bas_sites"("site_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_equipment" ADD CONSTRAINT "bas_equipment_equip_type_fkey" FOREIGN KEY ("equip_type") REFERENCES "bas_equipment_types"("equip_type") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_equipment" ADD CONSTRAINT "bas_equipment_parent_equipment_id_fkey" FOREIGN KEY ("parent_equipment_id") REFERENCES "bas_equipment"("equipment_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_points" ADD CONSTRAINT "bas_points_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "bas_stations"("station_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_points" ADD CONSTRAINT "bas_points_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "bas_equipment"("equipment_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_points" ADD CONSTRAINT "bas_points_point_role_fkey" FOREIGN KEY ("point_role") REFERENCES "bas_point_roles"("point_role") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_readings" ADD CONSTRAINT "bas_readings_point_id_fkey" FOREIGN KEY ("point_id") REFERENCES "bas_points"("point_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_point_links" ADD CONSTRAINT "bas_point_links_from_point_id_fkey" FOREIGN KEY ("from_point_id") REFERENCES "bas_points"("point_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_point_links" ADD CONSTRAINT "bas_point_links_to_point_id_fkey" FOREIGN KEY ("to_point_id") REFERENCES "bas_points"("point_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_sync_checkpoints" ADD CONSTRAINT "bas_sync_checkpoints_point_id_fkey" FOREIGN KEY ("point_id") REFERENCES "bas_points"("point_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_ingest_runs" ADD CONSTRAINT "bas_ingest_runs_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "bas_stations"("station_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bas_data_gaps" ADD CONSTRAINT "bas_data_gaps_point_id_fkey" FOREIGN KEY ("point_id") REFERENCES "bas_points"("point_id") ON DELETE CASCADE ON UPDATE CASCADE;


-- =============================================================================
-- Everything above this line was generated by `prisma migrate dev --create-only`.
-- Everything below it was written by hand, because Prisma cannot express it.
--
-- Prisma models tables, columns and indexes. It does not model CHECK
-- constraints, triggers, or views. So three things live here rather than in
-- prisma/schema.prisma:
--
--   Section 1  bas_points.roll_horizon_s, kept correct by a trigger.
--   Section 2  Thirteen CHECK constraints. Prisma neither creates these nor
--              reports them missing - they are invisible to it in both
--              directions, which is why they cannot be left to it.
--   Section 3  Six views. The `views` preview feature was deliberately not
--              enabled (21 Aug), so these are queried through $queryRaw with
--              hand-written types in lib/modules/bas/.
--
-- The BRIN index on bas_readings(ts) is NOT here - Prisma expresses PostgreSQL
-- index types natively and emitted it above. Only the pages_per_range storage
-- parameter cannot be expressed, and it was left at the default deliberately:
-- a tuning choice, not a correctness one.
--
-- Hand-additions belong INSIDE this file rather than in a migration of their
-- own. `migrate dev` replays the migration history into a shadow database and
-- diffs it against schema.prisma; anything applied here becomes part of the
-- state it replays, so the diff stays empty. See docs/runbook.md, "The BAS
-- schema lives in two places".
--
-- Translated from C:\dev\bas-db\migrations\001-005, which passed 34/34
-- checks as raw SQL. Two things changed in translation, both deliberate:
--
--   * Objects live in `public` with a bas_ prefix, not a separate `bas` schema
--     (decision D3). Views are bas_v_*, and that prefix is load-bearing - see
--     the comment above bas_v_data_dictionary.
--   * Column names are unchanged, which is what makes scripts/bas-import.ts a
--     straight copy rather than a mapping exercise.
-- =============================================================================


-- =============================================================================
-- SECTION 1 - roll_horizon_s, maintained by a trigger
--
-- capacity * collection_interval_s: how far back a history reaches before the
-- station destroys data. Nothing should ever write it by hand.
--
-- WHY A TRIGGER AND NOT `GENERATED ALWAYS AS ... STORED`
--
-- The generated column was tried first and had to be abandoned. It works
-- perfectly in the database - but Prisma reads the GENERATED expression as a
-- column DEFAULT, cannot express it in schema.prisma, and so every subsequent
-- `prisma migrate dev` emits a corrective migration:
--
--     ALTER TABLE "bas_points" ALTER COLUMN "roll_horizon_s" DROP DEFAULT;
--
-- PostgreSQL refuses that on a generated column, so the migration fails and the
-- developer is stuck: they cannot apply it and they cannot make Prisma stop
-- generating it. Declaring the field in schema.prisma does NOT prevent this -
-- it prevents a DROP COLUMN, which is a different problem.
--
-- A trigger has none of that. Prisma does not model triggers at all, so it
-- neither creates them nor notices them - exactly like the CHECK constraints in
-- Section 2. The precedent is already in this repo: the
-- audit_events_append_only triggers from migration 20260814000100 appear
-- nowhere in schema.prisma and have survived every migration since without
-- producing a diff.
--
-- Prisma emitted `roll_horizon_s INTEGER` in the CREATE TABLE above, which is a
-- plain nullable column and matches schema.prisma exactly. Nothing needs
-- altering; the trigger is simply added on top.
--
-- THE ONE BEHAVIOURAL DIFFERENCE, stated plainly: a generated column REJECTS a
-- direct write. This trigger silently overwrites it instead. The stored value
-- is correct either way, but a caller that tries to set roll_horizon_s gets no
-- error. Nothing in the platform or the collector writes it - the collector
-- only reads it (collector/db.py) - so this is a lost warning, not a lost
-- guarantee.
--
-- NULL propagates: NULL * 300 is NULL, so a point whose capacity has not been
-- filled in from Workbench still reports roll_horizon_unknown rather than a
-- number. That distinction is load-bearing and must never render as safe.
-- =============================================================================

CREATE OR REPLACE FUNCTION bas_points_roll_horizon()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.roll_horizon_s := NEW.capacity * NEW.collection_interval_s;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION bas_points_roll_horizon() IS
  'Keeps bas_points.roll_horizon_s equal to capacity * collection_interval_s. '
  'Replaces a GENERATED ALWAYS column, which Prisma could not tolerate - see the '
  'migration that installs this, and docs/runbook.md.';

-- UPDATE OF includes roll_horizon_s itself, so an attempt to set it directly is
-- recomputed rather than accepted. Updates to unrelated columns do not fire the
-- trigger, because the inputs cannot have changed.
CREATE TRIGGER bas_points_roll_horizon_maintain
  BEFORE INSERT OR UPDATE OF capacity, collection_interval_s, roll_horizon_s
  ON bas_points
  FOR EACH ROW
  EXECUTE FUNCTION bas_points_roll_horizon();

COMMENT ON COLUMN bas_points.roll_horizon_s IS
  'capacity * collection_interval_s: how far back this history reaches before the station '
  'destroys data. Maintained by the bas_points_roll_horizon trigger - never write it by '
  'hand, the trigger will overwrite you. The collector must poll far more often than this - '
  'polling slower loses data permanently, with no error and no gap marker anywhere.';


-- =============================================================================
-- SECTION 2 - CHECK constraints
--
-- Thirteen of them. Prisma models columns and indexes but not constraints, so
-- these are invisible to it in both directions: it will not generate them, and
-- it will not report them as drift.
--
-- These are not decoration. bas_readings_at_most_one_value is what makes "a
-- reading cannot carry two typed values" true rather than merely intended, and
-- it is one of the 34 checks the standalone schema passed.
--
-- The closed-set constraints are deliberately CHECK-over-text rather than
-- Postgres enums: decision D1 says the collector changes only its connection
-- string, and enum columns would change how its inserts bind their parameters.
-- =============================================================================

-- --- closed value sets -------------------------------------------------------

ALTER TABLE bas_points
  ADD CONSTRAINT bas_points_data_type_check
  CHECK (data_type IN ('real','int','bool','str','enum','abstime','unknown'));

ALTER TABLE bas_points
  ADD CONSTRAINT bas_points_full_policy_check
  CHECK (full_policy IN ('roll','stop'));

ALTER TABLE bas_point_links
  ADD CONSTRAINT bas_point_links_link_type_check
  CHECK (link_type IN ('setpoint_for','status_of','feedback_for','serves','measures_same'));

ALTER TABLE bas_point_links
  ADD CONSTRAINT bas_point_links_confidence_check
  CHECK (confidence IN ('manual','inferred'));

ALTER TABLE bas_sync_checkpoints
  ADD CONSTRAINT bas_sync_checkpoints_last_status_check
  CHECK (last_status IN ('never_run','ok','error','skipped'));

ALTER TABLE bas_ingest_runs
  ADD CONSTRAINT bas_ingest_runs_status_check
  CHECK (status IN ('running','ok','partial','failed'));

ALTER TABLE bas_data_gaps
  ADD CONSTRAINT bas_data_gaps_cause_check
  CHECK (cause IN ('roll_overwrite','collector_down','station_unreachable',
                   'point_added_later','station_clock_change','unknown'));

-- --- positive-integer guards -------------------------------------------------

ALTER TABLE bas_points
  ADD CONSTRAINT bas_points_collection_interval_positive
  CHECK (collection_interval_s IS NULL OR collection_interval_s > 0);

ALTER TABLE bas_points
  ADD CONSTRAINT bas_points_capacity_positive
  CHECK (capacity IS NULL OR capacity > 0);

-- --- structural integrity ----------------------------------------------------

ALTER TABLE bas_equipment
  ADD CONSTRAINT bas_equipment_not_own_parent
  CHECK (parent_equipment_id IS DISTINCT FROM equipment_id);

ALTER TABLE bas_point_links
  ADD CONSTRAINT bas_point_links_not_self
  CHECK (from_point_id <> to_point_id);

ALTER TABLE bas_data_gaps
  ADD CONSTRAINT bas_data_gaps_ordered
  CHECK (gap_end >= gap_start);

ALTER TABLE bas_readings
  ADD CONSTRAINT bas_readings_at_most_one_value
  CHECK (
      (value_num  IS NOT NULL)::int
    + (value_bool IS NOT NULL)::int
    + (value_str  IS NOT NULL)::int <= 1
  );

COMMENT ON CONSTRAINT bas_readings_at_most_one_value ON bas_readings IS
  'At most one typed value column is populated. ZERO populated columns is valid and '
  'meaningful: it is a record the station returned as null - a sensor fault or a real gap. '
  'That is different from no row at all, which means we never collected it.';


-- =============================================================================
-- SECTION 3 - views
--
-- These exist because of a specific, measurable problem: an LLM asked to write
-- SQL against a normalised schema gets the joins wrong. Not occasionally -
-- routinely, and in ways that produce plausible wrong numbers rather than
-- errors. A six-table join through station and org to get from a reading to a
-- building name is exactly the shape that goes wrong.
--
-- So the normalised tables stay normalised (they are correct, and they are what
-- the collector writes to) and these give the analysis layer something that
-- reads like one flat table per question.
--
-- bas_v_collection_health is the 005 version - 003's original was superseded by
-- 004 (which added point_role, unit and equipment_name) and again by 005 (which
-- added site_id, org_name and station_id, because filtering a dashboard on a
-- building NAME breaks the moment a building is called "St. Mary's"). Only the
-- final form is created here; there is no history to replay.
-- =============================================================================


-- --- bas_v_point: every point with its full context -------------------------

CREATE VIEW bas_v_point AS
SELECT
    p.point_id,
    COALESCE(p.display_name, p.niagara_history_name) AS point_name,
    p.point_role,
    pr.display_name AS point_role_name,
    pr.description  AS point_role_description,
    pr.measurement,
    pr.is_setpoint,
    pr.is_command,
    pr.is_status,
    pr.setpoint_for,
    pr.status_of,
    p.unit,
    p.data_type,

    e.equipment_id,
    e.name          AS equipment_name,
    e.equip_type,
    et.display_name AS equipment_type_name,
    parent.name     AS parent_equipment_name,

    s.site_id,
    s.name     AS site_name,
    s.timezone AS site_timezone,
    o.org_id,
    o.name     AS org_name,

    st.station_id,
    st.niagara_station_name,
    p.niagara_history_name,

    p.collection_interval_s,
    p.capacity,
    p.full_policy,
    p.roll_horizon_s,
    p.is_active,
    p.first_seen_at,
    p.last_seen_at
FROM bas_points p
JOIN      bas_stations        st     ON st.station_id       = p.station_id
JOIN      bas_sites           s      ON s.site_id           = st.site_id
JOIN      bas_orgs            o      ON o.org_id            = s.org_id
LEFT JOIN bas_equipment       e      ON e.equipment_id      = p.equipment_id
LEFT JOIN bas_equipment       parent ON parent.equipment_id = e.parent_equipment_id
LEFT JOIN bas_equipment_types et     ON et.equip_type       = e.equip_type
LEFT JOIN bas_point_roles     pr     ON pr.point_role       = p.point_role;

COMMENT ON VIEW bas_v_point IS
  'Every point with its equipment, building, station, and semantic role flattened into one '
  'row. Start here when answering "what points exist" or "which points measure X".';


-- --- bas_v_reading: the main analytical surface ------------------------------

CREATE VIEW bas_v_reading AS
SELECT
    r.ts,
    (r.ts AT TIME ZONE s.timezone)                         AS ts_local,
    EXTRACT(HOUR FROM (r.ts AT TIME ZONE s.timezone))::int AS local_hour,
    EXTRACT(DOW  FROM (r.ts AT TIME ZONE s.timezone))::int AS local_dow,

    r.value_num,
    r.value_bool,
    r.value_str,
    r.status,

    p.point_id,
    COALESCE(p.display_name, p.niagara_history_name) AS point_name,
    p.point_role,
    p.unit,
    p.data_type,

    e.equipment_id,
    e.name AS equipment_name,
    e.equip_type,

    s.site_id,
    s.name     AS site_name,
    s.timezone AS site_timezone,
    o.name     AS org_name
FROM bas_readings r
JOIN      bas_points   p  ON p.point_id     = r.point_id
JOIN      bas_stations st ON st.station_id  = p.station_id
JOIN      bas_sites    s  ON s.site_id      = st.site_id
JOIN      bas_orgs     o  ON o.org_id       = s.org_id
LEFT JOIN bas_equipment e ON e.equipment_id = p.equipment_id;

COMMENT ON VIEW bas_v_reading IS
'Trend data with full context on every row. This is the primary relation to query for
analysis. Always filter on ts (or point_id) - the underlying table is large and the planner
needs a bound.

ts is UTC. ts_local is the same instant in the building''s own timezone, which is the only
frame in which "overnight", "business hours", or "last Tuesday" mean anything. local_hour
and local_dow (0=Sunday) are precomputed for occupancy-shaped questions.

A row with all three value columns NULL is a record the station returned as null - a sensor
fault or a real gap. That is NOT the same as no row at all, which means we never collected
it. Check bas_data_gaps before concluding equipment was off.';

COMMENT ON COLUMN bas_v_reading.ts_local IS
  'The reading instant expressed in the building''s local time. Use this for anything '
  'schedule-related; use ts for anything comparing across sites in different timezones.';


-- --- bas_v_setpoint_pair: measurement paired with its governing setpoint -----

CREATE VIEW bas_v_setpoint_pair AS
SELECT
    e.equipment_id,
    e.name AS equipment_name,
    e.equip_type,
    s.site_id,
    s.name AS site_name,

    m.point_id   AS measured_point_id,
    COALESCE(m.display_name, m.niagara_history_name) AS measured_point_name,
    m.point_role AS measured_role,
    m.unit       AS measured_unit,

    sp.point_id   AS setpoint_point_id,
    COALESCE(sp.display_name, sp.niagara_history_name) AS setpoint_point_name,
    sp.point_role AS setpoint_role,
    sp.unit       AS setpoint_unit,

    (m.unit IS DISTINCT FROM sp.unit) AS unit_mismatch
FROM bas_points sp
JOIN bas_point_roles spr ON spr.point_role   = sp.point_role
                        AND spr.setpoint_for IS NOT NULL
JOIN bas_points m        ON m.point_role     = spr.setpoint_for
                        AND m.equipment_id   = sp.equipment_id
JOIN bas_equipment e     ON e.equipment_id   = sp.equipment_id
JOIN bas_sites s         ON s.site_id        = e.site_id
WHERE sp.is_active AND m.is_active;

COMMENT ON VIEW bas_v_setpoint_pair IS
'Every measured point matched to the setpoint that governs it, derived automatically from
point_role rather than configured per point. This is what makes "which zones never reached
setpoint last week" a single generic query instead of a per-building script.

Pairing requires both points to be assigned to the SAME equipment. A point with no
equipment_id will never appear here - which is the main practical reason to bother assigning
equipment.

Check unit_mismatch before comparing values. A setpoint in degC against a measurement in
degF produces a confident, wrong answer.';


-- --- bas_v_command_status_pair: command paired with its proof of operation ---

CREATE VIEW bas_v_command_status_pair AS
SELECT
    e.equipment_id,
    e.name AS equipment_name,
    e.equip_type,
    s.site_id,
    s.name AS site_name,

    c.point_id   AS command_point_id,
    COALESCE(c.display_name, c.niagara_history_name) AS command_point_name,
    c.point_role AS command_role,

    stat.point_id   AS status_point_id,
    COALESCE(stat.display_name, stat.niagara_history_name) AS status_point_name,
    stat.point_role AS status_role
FROM bas_points stat
JOIN bas_point_roles sr ON sr.point_role = stat.point_role
                       AND sr.status_of  IS NOT NULL
JOIN bas_points c       ON c.point_role   = sr.status_of
                       AND c.equipment_id = stat.equipment_id
JOIN bas_equipment e    ON e.equipment_id = stat.equipment_id
JOIN bas_sites s        ON s.site_id      = e.site_id
WHERE stat.is_active AND c.is_active;

COMMENT ON VIEW bas_v_command_status_pair IS
  'Every command point matched to the status point that proves whether it actually happened. '
  'Commanded-on-but-not-running is one of the most common and most expensive faults in a '
  'building, and it is invisible on an alarm screen. This view makes detecting it generic.';


-- --- bas_v_collection_health: operational, and deliberately cheap -----------

CREATE VIEW bas_v_collection_health AS
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
        WHEN p.roll_horizon_s IS NULL THEN 'roll_horizon_unknown'
        WHEN now() - c.last_record_ts
             > make_interval(secs => p.roll_horizon_s)       THEN 'data_lost'
        WHEN now() - c.last_record_ts
             > make_interval(secs => p.roll_horizon_s / 2.0) THEN 'at_risk'
        ELSE 'ok'
    END AS roll_risk
FROM bas_points p
JOIN      bas_stations         st ON st.station_id  = p.station_id
JOIN      bas_sites            s ON s.site_id       = st.site_id
JOIN      bas_orgs             o ON o.org_id        = s.org_id
LEFT JOIN bas_equipment        e ON e.equipment_id  = p.equipment_id
LEFT JOIN bas_sync_checkpoints c ON c.point_id      = p.point_id;

COMMENT ON VIEW bas_v_collection_health IS
'Per-point collection status. Cheap - reads checkpoints, never scans the readings table.

roll_risk is the important column. "data_lost" means more time has passed since our last
collected record than the station retains, so records have been overwritten and are gone
permanently. "roll_horizon_unknown" means capacity or collection_interval_s has not been
filled in from Workbench yet, so we cannot tell - treat that as a gap in our knowledge, NOT
as safety. Never render it green.

Filter by point_role to separate "a point is stale" from "a point that matters is stale",
and by site_id to scope to one building.';


-- --- bas_v_data_dictionary: the schema, annotated, in one query --------------
--
-- READ THIS BEFORE EDITING THE PREDICATE.
--
-- The standalone version filtered on `n.nspname = 'bas'`, because the tables
-- lived in their own schema. They now live in `public` alongside the platform's
-- own tables, so that predicate has to change - and both obvious ways of
-- changing it are wrong in a way that is silent:
--
--   * Keep nspname = 'bas'      -> returns zero rows. The AI gets no schema
--                                  context and starts guessing column names.
--   * Use nspname = 'public'    -> returns employees, audit_events, module_grants
--     alone                        and draft_locks as well. Their structure ends
--                                  up in an LLM prompt. Neither failure raises
--                                  an error.
--
-- So it filters on the bas_ prefix. That is also why the views are named
-- bas_v_* rather than v_*: unprefixed views would be excluded from the
-- dictionary and the AI would not know they exist.

CREATE VIEW bas_v_data_dictionary AS
SELECT
    c.relname AS object_name,
    CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' ELSE c.relkind::text END AS object_type,
    a.attname                            AS column_name,
    format_type(a.atttypid, a.atttypmod) AS data_type,
    NOT a.attnotnull                     AS is_nullable,
    col_description(c.oid, a.attnum)     AS column_description,
    obj_description(c.oid, 'pg_class')   AS object_description
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
WHERE n.nspname = 'public'
  AND c.relname LIKE 'bas\_%'
  AND c.relkind IN ('r','v')
ORDER BY c.relkind DESC, c.relname, a.attnum;

COMMENT ON VIEW bas_v_data_dictionary IS
  'The entire annotated BAS schema in one query. Intended to be selected and pasted into an '
  'LLM prompt as context, so the model writes SQL against documented columns rather than '
  'guessing from names. Scoped to bas_-prefixed objects: the platform''s own employee and '
  'audit tables are deliberately NOT exposed here. Keep the COMMENT ON statements current - '
  'they are not decoration, they are the model''s only description of what the data means.';
