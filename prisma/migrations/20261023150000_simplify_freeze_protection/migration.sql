-- Simplify Freeze Protection (2026-10-23, after the first release was tested).
--
--   * No buildings: a unit belongs to its project directly.
--   * A project is verified once: the verification date, step 7 signoff and
--     transmittal move onto fp_projects, and each unit's status and steps 3 to 6
--     move onto its fp_equipment row. fp_verifications and fp_results go.
--   * The unit's "tag" is called "name".
--   * History is the audit log (append-only, timestamped). Nothing here stores
--     a second copy.
--
-- Production held only test data (confirmed by the module owner), so the rows
-- are cleared rather than migrated. DELETE, not TRUNCATE ... RESTART IDENTITY:
-- the id sequences keep counting, so a new unit can never take an old test
-- unit's id and inherit its audit history (unit history is read from
-- audit_events by metadata.equipmentId).

DELETE FROM "fp_results";
DELETE FROM "fp_verifications";
DELETE FROM "fp_equipment";
DELETE FROM "fp_buildings";
DELETE FROM "fp_projects";

DROP TABLE "fp_results";
DROP TABLE "fp_verifications";

-- DropForeignKey / DropIndex / AlterTable: equipment leaves buildings
ALTER TABLE "fp_equipment" DROP CONSTRAINT "fp_equipment_building_id_fkey";
DROP INDEX "fp_equipment_building_id_tag_lower_key";
DROP INDEX "fp_equipment_building_id_idx";
ALTER TABLE "fp_equipment" DROP COLUMN "building_id",
DROP COLUMN "coil_updated_at";

DROP TABLE "fp_buildings";

-- RenameColumn: tag -> name
ALTER TABLE "fp_equipment" RENAME COLUMN "tag" TO "name";
ALTER TABLE "fp_equipment" RENAME CONSTRAINT "fp_equipment_tag_not_blank" TO "fp_equipment_name_not_blank";

-- AlterTable: the unit belongs to the project and carries its results.
-- NOT NULL without a default is safe: the table was emptied above.
ALTER TABLE "fp_equipment" ADD COLUMN "project_id" BIGINT NOT NULL,
ADD COLUMN "status" TEXT NOT NULL DEFAULT 'service',
ADD COLUMN "exposure" TEXT,
ADD COLUMN "protection" TEXT,
ADD COLUMN "test_fan_stops" TEXT,
ADD COLUMN "test_damper_closes" TEXT,
ADD COLUMN "test_valve_full_flow" TEXT,
ADD COLUMN "test_manual_reset" TEXT,
ADD COLUMN "trip_temp_f" DOUBLE PRECISION,
ADD COLUMN "tested_by" TEXT,
ADD COLUMN "test_date" DATE,
ADD COLUMN "elements" TEXT,
ADD COLUMN "notify_who" TEXT,
ADD COLUMN "notify_date" DATE,
ADD COLUMN "notify_method" TEXT,
ADD COLUMN "notify_response" TEXT,
ADD COLUMN "deficiency_description" TEXT,
ADD COLUMN "deficiency_owner" TEXT,
ADD COLUMN "deficiency_due" DATE,
ADD COLUMN "documented_with" TEXT,
ADD COLUMN "documented_name" TEXT,
ADD COLUMN "documented_date" DATE,
ADD COLUMN "documented_method" TEXT,
ADD COLUMN "updated_by_id" UUID;

-- AlterTable: the project carries its one verification.
ALTER TABLE "fp_projects" ADD COLUMN "verification_date" DATE NOT NULL,
ADD COLUMN "completed_by_id" UUID,
ADD COLUMN "completed_at" TIMESTAMPTZ(3),
ADD COLUMN "reviewed_by_id" UUID,
ADD COLUMN "reviewed_at" TIMESTAMPTZ(3),
ADD COLUMN "transmitted_to" TEXT,
ADD COLUMN "transmitted_date" DATE;

-- CreateIndex
CREATE INDEX "fp_equipment_project_id_idx" ON "fp_equipment"("project_id");

-- AddForeignKey
ALTER TABLE "fp_projects" ADD CONSTRAINT "fp_projects_completed_by_id_fkey" FOREIGN KEY ("completed_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fp_projects" ADD CONSTRAINT "fp_projects_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fp_equipment" ADD CONSTRAINT "fp_equipment_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "fp_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fp_equipment" ADD CONSTRAINT "fp_equipment_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written below: the rules that moved with the columns. Each closed
-- vocabulary matches lib/modules/freeze-protection/vocab.ts exactly
-- (tests/fp-schema.test.ts reads them back and compares).
-- ---------------------------------------------------------------------------

-- A unit's name is unique within its project, ignoring case.
CREATE UNIQUE INDEX "fp_equipment_project_id_name_lower_key" ON "fp_equipment" ("project_id", lower("name"));

-- Status and steps 3 to 6 (coil, step 2, kept its check through the rename).
ALTER TABLE "fp_equipment" ADD CONSTRAINT "fp_equipment_status_check"
  CHECK ("status" IN ('not_installed', 'dry', 'filled', 'service'));
ALTER TABLE "fp_equipment" ADD CONSTRAINT "fp_equipment_exposure_check"
  CHECK ("exposure" IS NULL OR "exposure" IN ('yes', 'no', 'unknown'));
ALTER TABLE "fp_equipment" ADD CONSTRAINT "fp_equipment_protection_check"
  CHECK ("protection" IS NULL OR "protection" IN ('manual', 'auto', 'software', 'glycol', 'drainable', 'none', 'unknown'));
ALTER TABLE "fp_equipment" ADD CONSTRAINT "fp_equipment_tests_check"
  CHECK (
    ("test_fan_stops" IS NULL OR "test_fan_stops" IN ('yes', 'no')) AND
    ("test_damper_closes" IS NULL OR "test_damper_closes" IN ('yes', 'no')) AND
    ("test_valve_full_flow" IS NULL OR "test_valve_full_flow" IN ('yes', 'no')) AND
    ("test_manual_reset" IS NULL OR "test_manual_reset" IN ('yes', 'no'))
  );
ALTER TABLE "fp_equipment" ADD CONSTRAINT "fp_equipment_documented_with_check"
  CHECK ("documented_with" IS NULL OR "documented_with" IN ('owner', 'vendor', 'gc', 'rental'));

-- Step 7. A signature carries its time (one direction only, so an employee row
-- going away under ON DELETE SET NULL can never be refused by this).
ALTER TABLE "fp_projects" ADD CONSTRAINT "fp_projects_completed_at_check"
  CHECK ("completed_by_id" IS NULL OR "completed_at" IS NOT NULL);
ALTER TABLE "fp_projects" ADD CONSTRAINT "fp_projects_reviewed_at_check"
  CHECK ("reviewed_by_id" IS NULL OR "reviewed_at" IS NOT NULL);

-- The reviewing engineer is not the person who completed the verification.
-- The service refuses it first, with a sentence; this is the floor.
ALTER TABLE "fp_projects" ADD CONSTRAINT "fp_projects_reviewer_not_completer"
  CHECK ("reviewed_by_id" IS NULL OR "completed_by_id" IS NULL OR "reviewed_by_id" <> "completed_by_id");
