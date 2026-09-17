-- =============================================================================
-- restate_bas_comments
--
-- Re-states, verbatim, every COMMENT ON that 20260821151125_add_bas_comments
-- intended - twelve tables and twenty columns - with one substitution: the
-- bas_readings.status wording is the corrected one from 20260824180000, because
-- the 21 August wording was wrong and re-stating it would undo the fix.
--
-- WHY A SECOND COPY EXISTS. add_bas_comments failed on its first application
-- to the live database on 2026-08-21 at 15:13 (a || in a COMMENT ON, zero
-- steps applied) and was marked rolled back. _prisma_migrations on live carries
-- that row AND a second, finished row at 15:14: Prisma re-applies a migration
-- marked rolled back on the next deploy, and it did. So the file HAS run on
-- live, and on 2026-09-17 live and a fresh database were compared column by
-- column through bas_v_data_dictionary: 45 described columns and 19 described
-- objects on each, no difference either way.
--
-- What remains true, and is the reason for this file: an applied migration
-- never runs again anywhere it has been applied. Any comment edited or added
-- inside add_bas_comments after 21 August reaches fresh databases - and every
-- test suite builds one - and never reaches live. The old file is therefore
-- closed: its header says so, and this file is the single convergence point.
-- COMMENT ON is idempotent, so applying this to a database that already holds
-- every one of these comments changes nothing, and applying it to a fresh one
-- produces the same state. Both converge.
--
-- If a comment below needs to change, change it in a NEW migration. Do not
-- edit this file either, for the same reason.
--
-- Prisma models neither comments nor their absence, so this produces no drift.
-- =============================================================================

-- --- tables --------------------------------------------------------------

COMMENT ON TABLE bas_orgs IS
  'Portfolio owner - the customer or business unit that owns a set of '
  'buildings. One row today; the table exists so that multi-customer data '
  'never has to be retrofitted.';

COMMENT ON TABLE bas_sites IS
  'A building.';

COMMENT ON TABLE bas_stations IS
  'A running Niagara station - a JACE, or a Supervisor. One row per '
  'controller.';

COMMENT ON TABLE bas_equipment IS
  'A physical piece of equipment: AHU-3, VAV-204, Chiller-1. Expect this to '
  'be wrong at first and cheap to correct - nothing depends on its values, '
  'only on its identity.';

COMMENT ON TABLE bas_points IS
  'One trended value in the building. The natural key is (station_id, '
  'niagara_history_name); everything else references the surrogate '
  'point_id. A point renamed in Niagara therefore appears as a NEW point '
  'rather than silently rewriting the meaning of existing history - that is '
  'deliberate, and the old row should be marked inactive after a human '
  'looks at it.';

COMMENT ON TABLE bas_readings IS
  'One trend record. Append-only in practice: never UPDATE, never DELETE. '
  'Derived values and rollups belong in views or separate tables so that '
  'raw data stays reproducible when an answer is later questioned.';

COMMENT ON TABLE bas_point_roles IS
  'Controlled vocabulary describing WHAT KIND of measurement a point is. '
  'This is the highest-leverage table in the schema: without it every '
  'analytical question degenerates into string-matching against whatever '
  'naming convention a given integrator happened to use. With it, "compare '
  'supply air temperature across all AHUs" works across buildings, naming '
  'schemes, and vendors.';

COMMENT ON TABLE bas_equipment_types IS
  'Controlled vocabulary of equipment kinds. Lets questions like "compare '
  'all AHUs" work without string-matching on names.';

COMMENT ON TABLE bas_point_links IS
  'Explicit relationships between specific points, for cases the role '
  'vocabulary cannot infer - an AHU with two supply temperature sensors, a '
  'setpoint shared across zones, a meter that submeters another. Prefer '
  'inferring from point_role + equipment_id where possible; use this where '
  'that would be wrong.';

COMMENT ON TABLE bas_sync_checkpoints IS
  'Per-point high-water mark. The reason the collector self-heals: after a '
  'network drop, a station reboot, or a database outage, the next run '
  'resumes from here with no human involvement and no duplicates.';

COMMENT ON TABLE bas_ingest_runs IS
  'One row per collector execution. The audit trail - worth having from the '
  'very first run, because the alternative is discovering a gap months '
  'later with no way to explain it.';

COMMENT ON TABLE bas_data_gaps IS
  'Periods we know we are missing, and why. Recording gaps explicitly is '
  'far better than silently having holes: it lets analysis distinguish "the '
  'equipment was off" from "we were not looking". An AI answering questions '
  'about this data needs that distinction to avoid confidently reporting a '
  'shutdown that never happened.';

-- --- columns -------------------------------------------------------------

COMMENT ON COLUMN bas_sites.attributes IS
  'Open-ended site metadata (building type, year built, floors). '
  'Deliberately loose - this is the layer most likely to need fields we '
  'have not thought of.';

COMMENT ON COLUMN bas_sites.timezone IS
  'IANA timezone name, e.g. America/New_York. DISPLAY ONLY - every stored '
  'timestamp is UTC. This is what converts UTC back to "what time was it in '
  'the building", which is the only frame occupancy schedules and business '
  'hours make sense in. Must be a value from pg_timezone_names.';

COMMENT ON COLUMN bas_stations.niagara_station_name IS
  'The station name EXACTLY as Niagara spells it, including capitalization. '
  'This appears literally in every oBIX URL. Get the case wrong and every '
  'request 404s.';

COMMENT ON COLUMN bas_stations.parent_station_id IS
  'The Supervisor this station reports to, if any. NULL for a standalone '
  'JACE. This single nullable self-reference is how a Supervisor stays '
  'optional forever - introducing one later needs no schema change at all.';

COMMENT ON COLUMN bas_equipment.parent_equipment_id IS
  'Equipment served by this one, e.g. a VAV box under the AHU that feeds '
  'it. Enables "show me everything downstream of AHU-3".';

COMMENT ON COLUMN bas_points.capacity IS
  'Maximum records the station retains for this history before the Full '
  'Policy applies. Niagara defaults to 500. From Workbench/BQL only.';

COMMENT ON COLUMN bas_points.collection_interval_s IS
  'How often Niagara logs this point, in seconds. From the history '
  'extension in Workbench, or BQL. NOT available over oBIX.';

COMMENT ON COLUMN bas_points.full_policy IS
  '"roll" = oldest records are overwritten (Niagara default, and silent). '
  '"stop" = logging halts when full.';

COMMENT ON COLUMN bas_points.niagara_history_name IS
  'The history name EXACTLY as Niagara returns it, INCLUDING $-hex escapes '
  '($20 = space, $2d = dash). This string goes into the oBIX URL verbatim. '
  'Never store the pretty decoded form here - decoding and re-encoding is '
  'not reliably round-trippable and produces 404s that look exactly like '
  'missing points.';

COMMENT ON COLUMN bas_points.point_role IS
  'What KIND of measurement this is. The single most important field for '
  'analysis. A point with no role is invisible to every cross-equipment '
  'comparison and every generic fault rule - so unclassified points should '
  'be an explicit, visible backlog.';

COMMENT ON COLUMN bas_points.unit IS
  'Engineering unit as reported by oBIX, with the "obix:units/" prefix '
  'stripped. Captured at ingest because recovering it for historical data '
  'afterwards ranges from painful to impossible - and comparing 55 degF '
  'against 12.8 degC silently produces a confident wrong answer.';

-- Corrected wording from 20260824180000_correct_bas_readings_status_comment,
-- NOT the 21 August wording: the original claimed Niagara status flags
-- arrive here, and 0 of 5,759 readings carried one. Re-stating the old text
-- would have silently reverted that correction.
COMMENT ON COLUMN bas_readings.status IS
  'ALWAYS NULL over the current extraction path, and NULL means "not supplied" '
  '- never "no fault". Measured, not assumed: 0 of 5,759 readings across all '
  'four points carry a value, and the oBIX ~historyQuery #RecordDef prototype '
  'declares exactly two fields for these histories, timestamp and value. '
  'Niagara does not send status with history records this way; the collector is '
  'not dropping it. NEVER read a NULL here as the station reporting a healthy '
  'reading - we have no opinion from the station at all. Fault detection on '
  'this data is value-based only. The column is kept because a Supervisor or a '
  'different extraction path may populate it later, and an always-null column '
  'is cheaper than a migration.';

COMMENT ON COLUMN bas_readings.ts IS
  'Instant the value was recorded, UTC. Convert to bas_sites.timezone for '
  'display or for any question about occupancy, business hours, or "last '
  'Tuesday".';

COMMENT ON COLUMN bas_point_roles.measurement IS
  'Physical quantity: temperature, humidity, pressure, flow, position, '
  'power, energy, speed, status, mode, time. Null for roles that are not a '
  'physical measurement.';

COMMENT ON COLUMN bas_point_roles.setpoint_for IS
  'If this role is a setpoint, the role it targets. Join point-to-point on '
  'matching equipment_id to pair a setpoint with its measurement.';

COMMENT ON COLUMN bas_point_roles.status_of IS
  'If this role is a feedback/status, the command role it reports on. A '
  'command that is on while its status is off is a fault.';

COMMENT ON COLUMN bas_equipment_types.category IS
  'Coarse grouping: air_side, water_side, plant, terminal, metering, other.';

COMMENT ON COLUMN bas_point_links.confidence IS
  '"manual" = a human asserted it. "inferred" = derived by a script from '
  'naming or structure. Analysis that matters should be able to tell the '
  'difference.';

COMMENT ON COLUMN bas_sync_checkpoints.last_record_ts IS
  'Timestamp of the newest record successfully COMMITTED for this point. '
  'Advanced only after a successful write - never before. Deliberately not '
  'derived from MAX(ts) on the readings table, because that cannot express '
  '"we tried and failed", cannot support backfill running independently of '
  'forward collection, and cannot distinguish a point that is idle from one '
  'that is broken.';

COMMENT ON COLUMN bas_data_gaps.cause IS
  '"roll_overwrite" is the unrecoverable one - the station destroyed the '
  'data before we collected it. Every occurrence is a signal that the poll '
  'cadence is wrong for that point.';
