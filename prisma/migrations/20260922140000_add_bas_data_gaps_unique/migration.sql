-- One row per loss per point.
--
-- On 8 September 2026 the collector recorded the 3-8 September roll-overwrite
-- loss for each of the four Spring Grove points and then timed out against
-- the station before it could advance the checkpoint. On the 9th it saw the
-- same checkpoint, computed the same start and a later end, and recorded the
-- same loss again. Both rows survived, and every sum over bas_data_gaps
-- counted 71.7 hours twice per point. record_gap (phb-bas) now extends the
-- existing row for the same point, start and cause instead of inserting
-- beside it; this constraint makes a second row impossible rather than merely
-- unwritten.
--
-- Cause is part of the key on purpose: a collector_down gap and a
-- roll_overwrite gap can legitimately share a start and mean different
-- things.
--
-- ORDER MATTERS. This fails on a database that still holds the duplicates,
-- and `migrate deploy` stops here. The four live duplicates (gap_ids 17-20,
-- the shorter halves) were deleted on 2026-09-22 after a verified backup,
-- and the overlapping-pairs query in runbook.md returned zero rows before
-- this was written. If it fails elsewhere, that query names what to clean.
CREATE UNIQUE INDEX "bas_data_gaps_point_id_gap_start_cause_key"
    ON "bas_data_gaps"("point_id", "gap_start", "cause");

COMMENT ON INDEX "bas_data_gaps_point_id_gap_start_cause_key" IS
  'One row per loss per point. The collector extends an existing gap for the same point, start and cause '
  'rather than inserting beside it (phb-bas record_gap, 2026-09-21); this makes a duplicate impossible. '
  'Cause is in the key because collector_down and roll_overwrite can share a start and mean different things.';
