-- AlterTable
ALTER TABLE "bas_points" ADD COLUMN     "inactive_reason" TEXT;


-- =============================================================================
-- Everything above this line is what the Prisma migration engine emits for the
-- schema.prisma change. Everything below it was written by hand, because Prisma
-- cannot express it.
--
--   Section 1  Why: a screen that cannot tell a deliberate exclusion from a
--              point that silently stopped.
--   Section 2  Two CHECKs - the nineteenth and twentieth in this schema. The
--              second is the one that matters.
--   Section 3  Backfill of the nine points inactive on 2026-09-17, by exact
--              name and by the _cfgN pattern. Reports what it did and what it
--              left.
--   Section 4  COMMENT ON.
-- =============================================================================


-- =============================================================================
-- SECTION 1 - what this is for
--
-- B8.2's Points list showed nine points as "Not collected - reason not
-- recorded", because the reason was stored nowhere: the collector set
-- is_active false without saying why, and so did the person who retired the
-- two _cfg0 halves. A screen that cannot tell "we chose not to collect this"
-- from "this stopped and nobody noticed" is a screen that will one day show
-- the second as the first.
--
-- FIVE values, not four, and not three.
--
--   niagara_system_log   AuditHistory, LogHistory, SecurityHistory. The station
--                        talking about itself. Never wanted as building data.
--
--   alarm_history        Global_Alarm. NOT a system log, and it must never be
--                        filed as one. It is real building data - what tripped,
--                        when, at what priority, whether anyone acknowledged it
--                        - and directly useful for fault detection. Excluded
--                        today only because an alarm is an event with a state
--                        and an acknowledgement, not a number at a timestamp,
--                        so it does not fit (point, ts, value) and needs a table
--                        of its own. "Later, deliberately." Filed under
--                        niagara_system_log it would never be revisited.
--
--   reconfigured_cfg0    The retired half of a reconfigured _cfgN pair. The
--                        collector never decides which half is dead; a person
--                        does, and writes this.
--
--   manual               A human turned it off.
--
--   no_longer_reported   The station stopped reporting the history - a rename
--                        or a reconfiguration - and discover marked the point
--                        inactive rather than deleting it. This is the fifth
--                        value, added because discover deactivates points in
--                        two places and the brief's four values covered only
--                        the first; the second would otherwise have to write
--                        nothing, or write a lie.
--
-- The values are defined once more in the collector (phb-bas,
-- collector/reasons.py) and its test_inactive_reason.py reads the CHECK back
-- out of pg_constraint and asserts the two sets are identical.
-- =============================================================================


-- =============================================================================
-- SECTION 2 - two CHECKs
--
-- The first keeps the set closed. The second is the important one: the reason
-- must be NULL whenever is_active is true. Without it a row can claim a reason
-- for being off while being on, and nothing would ever notice - the reason
-- would read on a screen as history, and the point would be collecting.
--
-- The consequence for every writer: anything that sets is_active = true must
-- clear inactive_reason in the same statement. The collector's upsert does; a
-- hand-run UPDATE that does not is refused, which is the point.
-- =============================================================================

ALTER TABLE bas_points
  ADD CONSTRAINT bas_points_inactive_reason_check
  CHECK (inactive_reason IS NULL OR inactive_reason IN (
    'niagara_system_log',
    'alarm_history',
    'reconfigured_cfg0',
    'manual',
    'no_longer_reported'
  ));

ALTER TABLE bas_points
  ADD CONSTRAINT bas_points_inactive_reason_only_when_inactive
  CHECK (inactive_reason IS NULL OR is_active = false);


-- =============================================================================
-- SECTION 3 - backfill
--
-- The nine points inactive on the live database on 2026-09-17, as queried:
--
--   AuditHistory, LogHistory, SecurityHistory      one each per station (6)
--   Global_Alarm                                   PHBoffice (1)
--   RV_Supply_Fan_Speed_Analog_Output_cfg0         PHBoffice (1)
--   Supply_Duct_Static_Pressure_Analog_Input_cfg0  PHBoffice (1)
--
-- By EXACT NAME for the first four - the same rule the collector applies, and
-- for the same reason: a pattern would one day swallow a real point - and by
-- the _cfgN suffix for the retired halves, restricted to rows that are
-- ALREADY inactive so a live _cfg0 half is never touched. Only rows with no
-- reason yet are written, so re-running this is harmless.
--
-- No-op on a fresh database. On live, the NOTICE below should read
-- "6 system log(s), 1 alarm history, 2 reconfigured half(ves) ... 0 inactive
-- point(s) still without a reason". Anything else means the list above was
-- wrong, and the person applying this should say so.
-- =============================================================================

DO $backfill$
DECLARE
  n_sys   integer;
  n_alarm integer;
  n_cfg   integer;
  n_left  integer;
BEGIN
  UPDATE bas_points
     SET inactive_reason = 'niagara_system_log'
   WHERE NOT is_active
     AND inactive_reason IS NULL
     AND niagara_history_name IN ('AuditHistory', 'LogHistory', 'SecurityHistory');
  GET DIAGNOSTICS n_sys = ROW_COUNT;

  UPDATE bas_points
     SET inactive_reason = 'alarm_history'
   WHERE NOT is_active
     AND inactive_reason IS NULL
     AND niagara_history_name = 'Global_Alarm';
  GET DIAGNOSTICS n_alarm = ROW_COUNT;

  UPDATE bas_points
     SET inactive_reason = 'reconfigured_cfg0'
   WHERE NOT is_active
     AND inactive_reason IS NULL
     AND niagara_history_name ~ '_cfg[0-9]+$';
  GET DIAGNOSTICS n_cfg = ROW_COUNT;

  SELECT count(*) INTO n_left FROM bas_points WHERE NOT is_active AND inactive_reason IS NULL;

  RAISE NOTICE 'add_bas_inactive_reason: % system log(s), % alarm history, % reconfigured half(ves) backfilled; % inactive point(s) still without a reason.',
    n_sys, n_alarm, n_cfg, n_left;
END
$backfill$;


-- =============================================================================
-- SECTION 4 - COMMENT ON
--
-- In bas_v_data_dictionary, so described or the model guesses. The is_active
-- comment from add_bas_point_label_and_visibility is re-stated with one added
-- sentence pointing here.
-- =============================================================================

COMMENT ON COLUMN bas_points.inactive_reason IS
  'WHY the collector does not fetch this point, when is_active is false. One of '
  'niagara_system_log (AuditHistory, LogHistory, SecurityHistory - the station talking about '
  'itself), alarm_history (Global_Alarm - real building data that needs a table of its own, '
  'excluded later and deliberately, NOT a system log), reconfigured_cfg0 (the retired half of a '
  'reconfigured _cfgN pair, decided by a person), manual (a human turned it off) or '
  'no_longer_reported (the station stopped reporting the history and discover marked it '
  'inactive). Enforced by bas_points_inactive_reason_check. MUST be NULL whenever is_active is '
  'true - bas_points_inactive_reason_only_when_inactive refuses otherwise - so anything that '
  'reactivates a point clears this in the same statement. NULL on an inactive point means the '
  'reason was not recorded, and the Points list says so rather than guessing.';

COMMENT ON COLUMN bas_points.is_active IS
  'Whether the collector FETCHES this point. Turning it off is PERMANENT in effect: the station '
  'overwrites its own history - the office JACE holds about five days, and one status point '
  'about two hours - so a point not collected on Tuesday cannot be recovered on Friday. To take '
  'a point off a screen use is_visible instead; it costs nothing. discover sets this true for '
  'every history it finds and false for one the station no longer reports, except the Niagara '
  'system logs and Global_Alarm, which are registered inactive and thereafter left exactly as a '
  'human set them. WHY it is false is inactive_reason, which must be cleared in the same '
  'statement that sets this true.';
