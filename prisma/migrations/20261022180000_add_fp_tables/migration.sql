-- CreateTable
CREATE TABLE "fp_projects" (
    "id" BIGSERIAL NOT NULL,
    "job_number" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fp_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fp_buildings" (
    "id" BIGSERIAL NOT NULL,
    "project_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fp_buildings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fp_equipment" (
    "id" BIGSERIAL NOT NULL,
    "building_id" BIGINT NOT NULL,
    "tag" TEXT NOT NULL,
    "equipment_type" TEXT,
    "area_served" TEXT,
    "coil" TEXT,
    "coil_updated_at" TIMESTAMPTZ(3),
    "notes" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fp_equipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fp_verifications" (
    "id" BIGSERIAL NOT NULL,
    "project_id" BIGINT NOT NULL,
    "verification_date" DATE NOT NULL,
    "completed_by_id" UUID,
    "completed_at" TIMESTAMPTZ(3),
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "transmitted_to" TEXT,
    "transmitted_date" DATE,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fp_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fp_results" (
    "id" BIGSERIAL NOT NULL,
    "verification_id" BIGINT NOT NULL,
    "equipment_id" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'service',
    "exposure" TEXT,
    "protection" TEXT,
    "test_fan_stops" TEXT,
    "test_damper_closes" TEXT,
    "test_valve_full_flow" TEXT,
    "test_manual_reset" TEXT,
    "trip_temp_f" DOUBLE PRECISION,
    "tested_by" TEXT,
    "test_date" DATE,
    "elements" TEXT,
    "notify_who" TEXT,
    "notify_date" DATE,
    "notify_method" TEXT,
    "notify_response" TEXT,
    "deficiency_description" TEXT,
    "deficiency_owner" TEXT,
    "deficiency_due" DATE,
    "documented_with" TEXT,
    "documented_name" TEXT,
    "documented_date" DATE,
    "documented_method" TEXT,
    "notes" TEXT,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fp_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fp_buildings_project_id_idx" ON "fp_buildings"("project_id");

-- CreateIndex
CREATE INDEX "fp_equipment_building_id_idx" ON "fp_equipment"("building_id");

-- CreateIndex
CREATE INDEX "fp_verifications_project_id_verification_date_idx" ON "fp_verifications"("project_id", "verification_date" DESC);

-- CreateIndex
CREATE INDEX "fp_results_equipment_id_idx" ON "fp_results"("equipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "fp_results_verification_id_equipment_id_key" ON "fp_results"("verification_id", "equipment_id");

-- AddForeignKey
ALTER TABLE "fp_projects" ADD CONSTRAINT "fp_projects_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fp_buildings" ADD CONSTRAINT "fp_buildings_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "fp_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fp_equipment" ADD CONSTRAINT "fp_equipment_building_id_fkey" FOREIGN KEY ("building_id") REFERENCES "fp_buildings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fp_verifications" ADD CONSTRAINT "fp_verifications_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "fp_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fp_verifications" ADD CONSTRAINT "fp_verifications_completed_by_id_fkey" FOREIGN KEY ("completed_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fp_verifications" ADD CONSTRAINT "fp_verifications_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fp_verifications" ADD CONSTRAINT "fp_verifications_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fp_results" ADD CONSTRAINT "fp_results_verification_id_fkey" FOREIGN KEY ("verification_id") REFERENCES "fp_verifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fp_results" ADD CONSTRAINT "fp_results_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "fp_equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fp_results" ADD CONSTRAINT "fp_results_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written below: rules Prisma's schema language cannot express. Each
-- closed vocabulary matches lib/modules/freeze-protection/types.ts exactly, so
-- a value the service does not know cannot be stored by any other path.
-- ---------------------------------------------------------------------------

-- Names and tags must have something in them.
ALTER TABLE "fp_projects" ADD CONSTRAINT "fp_projects_job_number_not_blank" CHECK (btrim("job_number") <> '');
ALTER TABLE "fp_projects" ADD CONSTRAINT "fp_projects_name_not_blank" CHECK (btrim("name") <> '');
ALTER TABLE "fp_buildings" ADD CONSTRAINT "fp_buildings_name_not_blank" CHECK (btrim("name") <> '');
ALTER TABLE "fp_equipment" ADD CONSTRAINT "fp_equipment_tag_not_blank" CHECK (btrim("tag") <> '');

-- A job number belongs to one project, ignoring case ("26-104a" = "26-104A").
CREATE UNIQUE INDEX "fp_projects_job_number_lower_key" ON "fp_projects" (lower("job_number"));

-- Building names are unique within a project; tags are unique within a building
-- (two buildings on one job can each have an AHU-1).
CREATE UNIQUE INDEX "fp_buildings_project_id_name_lower_key" ON "fp_buildings" ("project_id", lower("name"));
CREATE UNIQUE INDEX "fp_equipment_building_id_tag_lower_key" ON "fp_equipment" ("building_id", lower("tag"));

-- Step 2.
ALTER TABLE "fp_equipment" ADD CONSTRAINT "fp_equipment_coil_check"
  CHECK ("coil" IS NULL OR "coil" IN ('none', 'water', 'glycol', 'steam'));

-- Step 1 status and steps 3 to 6.
ALTER TABLE "fp_results" ADD CONSTRAINT "fp_results_status_check"
  CHECK ("status" IN ('not_installed', 'dry', 'filled', 'service'));
ALTER TABLE "fp_results" ADD CONSTRAINT "fp_results_exposure_check"
  CHECK ("exposure" IS NULL OR "exposure" IN ('yes', 'no', 'unknown'));
ALTER TABLE "fp_results" ADD CONSTRAINT "fp_results_protection_check"
  CHECK ("protection" IS NULL OR "protection" IN ('manual', 'auto', 'software', 'glycol', 'drainable', 'none', 'unknown'));
ALTER TABLE "fp_results" ADD CONSTRAINT "fp_results_tests_check"
  CHECK (
    ("test_fan_stops" IS NULL OR "test_fan_stops" IN ('yes', 'no')) AND
    ("test_damper_closes" IS NULL OR "test_damper_closes" IN ('yes', 'no')) AND
    ("test_valve_full_flow" IS NULL OR "test_valve_full_flow" IN ('yes', 'no')) AND
    ("test_manual_reset" IS NULL OR "test_manual_reset" IN ('yes', 'no'))
  );
ALTER TABLE "fp_results" ADD CONSTRAINT "fp_results_documented_with_check"
  CHECK ("documented_with" IS NULL OR "documented_with" IN ('owner', 'vendor', 'gc', 'rental'));

-- Step 7. A signature carries its time. Only one direction is checked, so an
-- employee row going away (ON DELETE SET NULL) can never be refused by this.
ALTER TABLE "fp_verifications" ADD CONSTRAINT "fp_verifications_completed_at_check"
  CHECK ("completed_by_id" IS NULL OR "completed_at" IS NOT NULL);
ALTER TABLE "fp_verifications" ADD CONSTRAINT "fp_verifications_reviewed_at_check"
  CHECK ("reviewed_by_id" IS NULL OR "reviewed_at" IS NOT NULL);

-- The sheet's step 7: the reviewing engineer is not the person who completed
-- the verification. The service refuses it first, with a sentence; this is the
-- floor under every other path.
ALTER TABLE "fp_verifications" ADD CONSTRAINT "fp_verifications_reviewer_not_completer"
  CHECK ("reviewed_by_id" IS NULL OR "completed_by_id" IS NULL OR "reviewed_by_id" <> "completed_by_id");
