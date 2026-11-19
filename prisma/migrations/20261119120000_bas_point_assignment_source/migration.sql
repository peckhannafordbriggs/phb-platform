-- AlterTable
ALTER TABLE "bas_points" ADD COLUMN     "assignment_source" TEXT;


-- =============================================================================
-- Everything above this line is what the Prisma migration engine emits for the
-- schema.prisma change. Everything below it was written by hand, because Prisma
-- cannot express it.
--
--   Section 1  Why: the scheduler now assigns roles and equipment by itself,
--              and a person's choice must outrank it.
--   Section 2  The CHECK.
--   Section 3  Backfill: every point classified today was classified by a
--              person.
--   Section 4  COMMENT ON.
-- =============================================================================


-- =============================================================================
-- SECTION 1 - what this is for
--
-- Until 2026-11-19 nothing but a click wrote a point's role or equipment
-- (B8.5, and the two name-derived previews of the same day). From this
-- migration on, the BAS Reports scheduler job assigns them on every pass:
-- high-confidence name suggestions, equipment created from high-confidence
-- name prefixes (lib/modules/bas/auto-assign.ts). That is only safe if the
-- pass can tell a value it may fill from one a person chose, and a point a
-- person cleared from one nobody has looked at. Both halves are NULL in both
-- of those cases, so the halves alone cannot say it. This column does:
--
--   'auto'    the assignment pass wrote this point (on the scheduler, or a
--             module admin's "Run assignment now", which is the same code).
--   'manual'  a person did, through any control in Settings - the role and
--             equipment pickers, the bulk form, a suggestion's own Apply, and
--             the two name-derived previews. Set on every person's write,
--             whatever it was.
--   NULL      nobody has assigned anything yet.
--
-- The rule it serves: the automatic pass NEVER writes a 'manual' point, and
-- on any other point fills a half only where it is NULL. A person's write
-- always wins, because it stamps 'manual' and the pass's UPDATE requires
-- otherwise.
--
-- One column, not one per half, by decision: "manual" protects the whole
-- point. A person who touched it is the person who finishes it; a role-less
-- point still shows under "Needs a decision" whoever touched it last.
-- =============================================================================


-- =============================================================================
-- SECTION 2 - the CHECK
-- =============================================================================

ALTER TABLE bas_points
  ADD CONSTRAINT bas_points_assignment_source_check
  CHECK (assignment_source IS NULL OR assignment_source IN ('auto', 'manual'));


-- =============================================================================
-- SECTION 3 - backfill
--
-- Every point that holds a role or equipment today was given it by a person:
-- the B8.5 pickers and bulk form, the office classification of 2026-09-17
-- (SQL, by hand), or a module admin confirming one of the two name-derived
-- previews. So they are 'manual', and the first automatic pass after this
-- migration leaves every one of them exactly as it is - including the other,
-- still-empty half of a point that has only one. Points with neither half are
-- left NULL and are what the pass works on.
-- =============================================================================

DO $$
DECLARE
  marked bigint;
  left_null bigint;
BEGIN
  UPDATE bas_points
     SET assignment_source = 'manual'
   WHERE point_role IS NOT NULL OR equipment_id IS NOT NULL;
  GET DIAGNOSTICS marked = ROW_COUNT;
  SELECT count(*) INTO left_null FROM bas_points WHERE assignment_source IS NULL;
  RAISE NOTICE 'bas_points.assignment_source: % point(s) marked manual (already classified), % left NULL', marked, left_null;
END $$;


-- =============================================================================
-- SECTION 4 - COMMENT ON
-- =============================================================================

COMMENT ON COLUMN bas_points.assignment_source IS
  'Who decided this point''s role and equipment. ''auto'': the automatic assignment pass (the BAS Reports scheduler job every pass, or "Run assignment now" in Settings) wrote it from high-confidence name suggestions and prefixes. ''manual'': a person did, through any Settings control. NULL: nobody yet. The automatic pass never writes a ''manual'' point, and on any other point fills a half only where it is NULL.';
