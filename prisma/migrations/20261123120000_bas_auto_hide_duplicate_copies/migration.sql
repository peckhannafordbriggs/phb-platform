-- AlterTable
ALTER TABLE "bas_points" ADD COLUMN     "duplicate_of" BIGINT,
ADD COLUMN     "hidden_reason" TEXT,
ADD COLUMN     "hidden_source" TEXT;

-- CreateIndex
CREATE INDEX "bas_points_duplicate_of_idx" ON "bas_points"("duplicate_of");

-- AddForeignKey
ALTER TABLE "bas_points" ADD CONSTRAINT "bas_points_duplicate_of_fkey" FOREIGN KEY ("duplicate_of") REFERENCES "bas_points"("point_id") ON DELETE SET NULL ON UPDATE CASCADE;


-- =============================================================================
-- Everything above this line is what the Prisma migration engine emits for the
-- schema.prisma change (less the kb_chunks HNSW DROP INDEX it always emits,
-- which must never ship - tests/kb-schema.test.ts). Everything below it was
-- written by hand, because Prisma cannot express it.
--
--   Section 1  Why: the platform now hides dead duplicate copies by itself,
--              and a person's choice must outrank it.
--   Section 2  The CHECKs.
--   Section 3  Backfill: every visibility decision made so far was a person's.
--   Section 4  COMMENT ON.
-- =============================================================================


-- =============================================================================
-- SECTION 1 - what this is for
--
-- CEI_JCI_N2 holds AHU_7/DA_SAP, AHU_7/MA_T, AHU_7/OA_H ... - the JACE's local
-- histories of points whose controller it no longer reaches - and they log one
-- value for ever. The same measurements arrive live through the via-parent
-- station CEI_AHU_7 (DA_SAP, MA_T, OA_H). Since 2026-11-20 a hidden point is
-- out of reports, Analyze and the stuck-value check, and people were hiding the
-- copies by hand. From this migration on, the BAS Reports scheduler's point
-- pass (lib/modules/bas/auto-hide.ts) does it: a point that reads one value
-- over the last seven days, whose name matches a point on another station of
-- the same building that varies, is hidden as a copy of it. The rules are in
-- lib/modules/bas/duplicate-copies.ts.
--
-- That is only safe if the pass can tell a visibility a person chose from one
-- nobody has decided. is_visible alone cannot say it - a shown point is shown
-- whether somebody ticked it or nobody looked - so:
--
--   hidden_source  'auto'    the platform last set is_visible (the duplicate
--                            step: hid it as a copy, or showed it again).
--                  'manual'  a person did, through Settings (the Shown box,
--                            Hide/Show on a selection, Unhide). Set on every
--                            person's change.
--                  NULL      nobody has decided; shown by default.
--   hidden_reason  'duplicate_copy', only while the platform has it hidden.
--   duplicate_of   the live point it is a copy of, while it is.
--
-- The rule they serve: the automatic step NEVER writes a 'manual' point, hidden
-- or shown. The UPDATE that hides requires it, so a person's change that lands
-- between the pass's read and its write wins.
-- =============================================================================


-- =============================================================================
-- SECTION 2 - the CHECKs
--
-- A reason only while the PLATFORM has the point hidden: a person's show or
-- hide clears it (settings-service.ts), and the platform's own show clears it.
-- duplicate_of only with that reason. The reverse (the reason without a
-- duplicate_of) is allowed on purpose: the foreign key is ON DELETE SET NULL,
-- and a CHECK in that direction would turn deleting the live point into an
-- error. Points are never deleted in production; the tests delete them.
-- =============================================================================

ALTER TABLE bas_points
  ADD CONSTRAINT bas_points_hidden_source_check
  CHECK (hidden_source IS NULL OR hidden_source IN ('auto', 'manual'));

ALTER TABLE bas_points
  ADD CONSTRAINT bas_points_hidden_reason_check
  CHECK (
    hidden_reason IS NULL
    OR (hidden_reason IN ('duplicate_copy') AND hidden_source = 'auto' AND NOT is_visible)
  );

ALTER TABLE bas_points
  ADD CONSTRAINT bas_points_duplicate_of_check
  CHECK (
    duplicate_of IS NULL
    OR (hidden_reason = 'duplicate_copy' AND duplicate_of <> point_id)
  );


-- =============================================================================
-- SECTION 3 - backfill
--
-- Until today only a person wrote is_visible (B8.3's box, 2026-09-18; Hide and
-- Show on a selection, 2026-11-20). So every point hidden now was hidden by a
-- person, and every point that has EVER had its visibility changed - the audit
-- log holds a bas.point_visibility_changed row for each change, single or bulk
-- - had it decided by a person, including the ones shown again. All of them are
-- 'manual', and the first automatic pass leaves every one exactly as it is: a
-- copy somebody already hid by hand stays hidden by hand, and is not counted as
-- hidden automatically. Everything else is left NULL.
-- =============================================================================

DO $$
DECLARE
  hidden_marked bigint;
  shown_marked bigint;
BEGIN
  UPDATE bas_points
     SET hidden_source = 'manual'
   WHERE NOT is_visible;
  GET DIAGNOSTICS hidden_marked = ROW_COUNT;

  UPDATE bas_points p
     SET hidden_source = 'manual'
   WHERE p.hidden_source IS NULL
     AND EXISTS (
       SELECT 1
         FROM audit_events a
        WHERE a.action = 'bas.point_visibility_changed'
          AND a.metadata ->> 'pointId' ~ '^[0-9]{1,18}$'
          AND (a.metadata ->> 'pointId')::bigint = p.point_id
     );
  GET DIAGNOSTICS shown_marked = ROW_COUNT;

  RAISE NOTICE 'bas_points.hidden_source: % hidden point(s) marked manual, % shown point(s) a person had shown again marked manual', hidden_marked, shown_marked;
END $$;


-- =============================================================================
-- SECTION 4 - COMMENT ON
-- =============================================================================

COMMENT ON COLUMN bas_points.hidden_source IS
  'Who last decided is_visible. ''auto'': the duplicate-copy step of the automatic point pass '
  '(the BAS Reports scheduler job every pass, or "Run assignment now" in Settings) hid the point as '
  'a dead copy, or showed it again. ''manual'': a person did, through Settings - the Shown box, Hide '
  'or Show on a selection, or Unhide. NULL: nobody has decided; shown. The automatic step never '
  'writes a ''manual'' point, hidden or shown. Backfilled ''manual'' for every point hidden before '
  '2026-11-23 and every point whose visibility a person ever changed.';

COMMENT ON COLUMN bas_points.hidden_reason IS
  'Why the platform hid this point. ''duplicate_copy'': over the last seven days it read one value '
  '(or 99% of its readings were one value) while the point it matches by name on another station of '
  'the same building had at least 10 readings, more than 3 distinct values and a non-zero range - a '
  'JACE''s dead local copy of a history collected live elsewhere. Set only while hidden_source is '
  '''auto'' and the point is hidden; NULL otherwise. lib/modules/bas/duplicate-copies.ts holds the rules.';

COMMENT ON COLUMN bas_points.duplicate_of IS
  'The live point this one is a dead copy of, while hidden_reason is ''duplicate_copy''. Point '
  'Explorer links to it from the hidden copy. SET NULL if that point is ever deleted.';

COMMENT ON COLUMN bas_points.is_visible IS
  'Whether this point is SHOWN: on the browsing screens and, since 2026-11-20, in reports, in '
  'the Analyze catalogue and in the stuck-value (plausibility) check. Hidden is for a point that '
  'is not building data - typically a JACE''s local copy of a history that is collected on its '
  'own via-parent station, logging a constant 0; since 2026-11-23 the platform hides such a copy '
  'itself (hidden_source, hidden_reason, duplicate_of). REVERSIBLE, and never a collection '
  'decision: a hidden point is still collected, still checked for completeness, and must still be '
  'counted in every data-loss risk figure - a hidden point that starts losing history and says '
  'nothing is the 28 August failure again. Compare is_active, which controls whether the point is '
  'FETCHED at all and whose cost is permanent. To take a point out of view, hide; never '
  'deactivate. Global rather than per-user, so one person''s hide is everyone''s. Set by a person '
  'in Settings -> Points, one point or a selection, audited as bas.point_visibility_changed; set by '
  'the platform only for a duplicate copy, audited as bas.point_auto_hidden / bas.point_auto_shown. '
  'Never written by the collector. The bas_v_* views do not filter on it.';
