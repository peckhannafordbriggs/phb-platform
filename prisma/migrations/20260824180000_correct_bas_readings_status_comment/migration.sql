-- =============================================================================
-- Correct what bas_readings.status means. Comments only.
--
-- NO structural change and no data change. Two COMMENT ON statements and
-- nothing else - `\d bas_readings` before and after this migration differ only
-- in the description text.
--
-- WHY A FORWARD MIGRATION RATHER THAN AN EDIT
--
-- The wrong text lives in 20260821151125_add_bas_comments, which is applied.
-- Editing an applied migration breaks its checksum, and the documented recovery
-- for that is `prisma migrate reset` - see docs/runbook.md, *Editing a migration
-- that has already been applied*. That advice was written in August against
-- synthetic data, before the collector wrote here. It is now the wrong advice
-- for this database: since the cutover the collector writes bas_readings
-- directly, the standalone `bas` database is no longer being written to, and the
-- station holds 41.7 hours. A reset would destroy readings that exist nowhere
-- else. So the applied migration is left exactly as it is.
--
-- WHY THE DATABASE AND NOT JUST THE DOCS
--
-- bas_v_data_dictionary selects column comments and exists to be pasted into an
-- LLM prompt (docs/08, *The vocabularies are tables, not Postgres enums*, and
-- the B5 Ask tool). The comment in the database is therefore not a note for
-- developers - it is an instruction to a model that will write SQL against this
-- column. Leaving the old text there would keep telling the model that a NULL
-- status is a Niagara "no flags" report.
-- =============================================================================

-- The old text described a capability that has never existed, and inverted the
-- meaning of the data while doing it: a reader seeing NULL concluded "the
-- station reported no problems", when the truth is "the station was never asked
-- and never told us". Those are opposite readings of the same empty column.
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

-- bas_v_reading is the relation docs/08 tells an analyst and the AI to prefer,
-- so it carried this column with no description at all - which invited the
-- reader to fall back on the base table's comment. Same text, same reason.
COMMENT ON COLUMN bas_v_reading.status IS
  'ALWAYS NULL over the current extraction path, and NULL means "not supplied" '
  '- never "no fault". See the comment on bas_readings.status. Do not write a '
  'query that treats a NULL here as evidence the station considered the reading '
  'good; it is evidence of nothing.';
