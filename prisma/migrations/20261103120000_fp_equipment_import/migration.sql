-- Freeze Protection: what the equipment schedule import leaves on a unit
-- (2026-11-03). All three are null for a unit added by hand.
--
-- exposure_suggestion / exposure_evidence: the import's reading of the
-- schedule ("likely" exposed to outside air, and the column that says so). A
-- hint beside step 3, never the answer: step 3 stays the engineer's, in
-- "exposure".
--
-- source: where the unit came from, e.g. "M-701-R · FAN SCHEDULE".

ALTER TABLE "fp_equipment"
  ADD COLUMN "exposure_suggestion" TEXT,
  ADD COLUMN "exposure_evidence" TEXT,
  ADD COLUMN "source" TEXT;

ALTER TABLE "fp_equipment" ADD CONSTRAINT "fp_equipment_exposure_suggestion_check"
  CHECK ("exposure_suggestion" IS NULL OR "exposure_suggestion" IN ('likely', 'unlikely'));

-- Evidence only explains a suggestion; it never stands alone.
ALTER TABLE "fp_equipment" ADD CONSTRAINT "fp_equipment_exposure_evidence_check"
  CHECK ("exposure_evidence" IS NULL OR "exposure_suggestion" IS NOT NULL);
