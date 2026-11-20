-- Hidden points leave analysis (2026-11-20). Comments only: no column,
-- constraint, view or grant changes, and nothing for the collector to know.
--
-- bas_points.is_visible was "COSMETIC": a hidden point left the Point
-- Explorer picker and the Collection Health table and nothing else. Since this
-- change a hidden point is ALSO left out of reports, the Analyze catalogue and
-- the stuck-value (plausibility) check. The case: CEI_JCI_N2 holds local
-- copies of CEI_AHU_7's histories (AHU_7/*) that log a constant 0, while the
-- real data is collected on CEI_AHU_7 itself through the parent. Those copies
-- are not building data; flagging them as stuck sensors and answering
-- questions from them is wrong.
--
-- What did NOT change, and the comment keeps saying so: a hidden point is
-- still collected, still checked for completeness, and still counted in every
-- data-loss risk figure (roll risk, vanished points). B8.3's rule for those
-- figures stands. bas_v_* views are unchanged - Grafana, healthcheck.py and
-- the views' own readers still see every point.

COMMENT ON COLUMN bas_points.is_visible IS
  'Whether this point is SHOWN: on the browsing screens and, since 2026-11-20, in reports, in '
  'the Analyze catalogue and in the stuck-value (plausibility) check. Hidden is for a point that '
  'is not building data - typically a JACE''s local copy of a history that is collected on its '
  'own via-parent station, logging a constant 0. REVERSIBLE, and never a collection decision: a '
  'hidden point is still collected, still checked for completeness, and must still be counted in '
  'every data-loss risk figure - a hidden point that starts losing history and says nothing is '
  'the 28 August failure again. Compare is_active, which controls whether the point is FETCHED '
  'at all and whose cost is permanent. To take a point out of view, hide; never deactivate. '
  'Global rather than per-user, so one person''s hide is everyone''s. Set in Settings -> Points, '
  'one point or a selection, audited as bas.point_visibility_changed. Never written by the '
  'collector. The bas_v_* views do not filter on it.';

COMMENT ON COLUMN bas_points.is_active IS
  'Whether the collector FETCHES this point. Turning it off is PERMANENT in effect: the station '
  'overwrites its own history - the office JACE holds about five days, and one status point '
  'about two hours - so a point not collected on Tuesday cannot be recovered on Friday. To take '
  'a point out of view - the screens, reports and Analyze - use is_visible instead; it keeps '
  'collecting. discover sets this true for every history it finds and false for one the station '
  'no longer reports, except the four Niagara system logs (AuditHistory, LogHistory, '
  'SecurityHistory, Global_Alarm), which are registered inactive and thereafter left exactly as '
  'a human set them.';
