#!/usr/bin/env bash
# =============================================================================
# phb-bas-collector-check: is the BAS collector still writing? Runs as the
# Container Apps Job `<baseName>-bas-collector-check` (infra/main.bicep,
# `basCollectorCheckJob`), every half hour, from the SAME image the nightly
# backup runs from (infra/db-backup/Dockerfile): that image already holds
# psql and the URL parser below, and nothing else was needed. Exits non-zero
# when the newest successful collector run is older than
# BAS_COLLECTOR_SILENCE_MINUTES, so the execution shows Failed and the
# job-failure alert rule in the template (Phase 13 Part B) is what emails
# somebody. The check IS the collector's alert: Azure Monitor cannot read a
# PostgreSQL table, and this job is the bridge between the two.
#
# WHY THIS EXISTS
#
#   The collector runs on the office PC and writes bas_readings every fifteen
#   minutes; a JACE rolls a change-of-value point's history off in as little
#   as two hours (runbook.md -> "The roll horizon column shows two numbers").
#   A collector that stops is data that stops existing, and until this job
#   the only thing that noticed was a person opening Collection Health.
#   HANDOVER.md listed "Collector host offline" with no alert beside it.
#
# WHAT IT DOES, IN ORDER
#
#   1. The connection from DATABASE_URL into libpq's own variables, exactly
#      as the backup does - this file SOURCES the backup script for its
#      parser, so there is one parser in the image and one set of tests for
#      it. psql then runs with no connection argument at all and the password
#      is on no command line. DATABASE_URL itself is unset before psql runs.
#   2. One query over bas_ingest_runs: the newest finished run whose status
#      is ok or partial. `partial` is a run that happened and found a point
#      incomplete - it is not silence, and Collection Health is where a
#      partial run is read. Older than the threshold, or no such run at all,
#      raises an exception; psql exits 3 under ON_ERROR_STOP; the execution is
#      Failed. The message names the last successful run, its age, the
#      threshold, and the newest run of any status, so the job log says what
#      a person needs before they open anything else.
#
# It reads one table and writes nothing. tests/db-backup-script.test.ts runs
# it for real against the test database through the psql on the PATH, with a
# fresh run, a stale run, a recent failed run and no run at all.
#
# Nothing here is specific to PH+B: the threshold is a parameter of the
# template, and the table is the platform's own.
# =============================================================================

# The backup script's strict mode, log/fail, the ERR trap and
# parse_database_url. Its own main does not run when it is sourced. The
# override exists for the test, which sources this file from the checkout.
# shellcheck source=backup.sh
source "${PHB_DB_BACKUP_SCRIPT:-/usr/local/bin/phb-db-backup}"

collector_check_main() {
  local v
  for v in DATABASE_URL BAS_COLLECTOR_SILENCE_MINUTES; do
    [ -n "${!v:-}" ] || fail "$v is not set"
  done
  if [[ ! "$BAS_COLLECTOR_SILENCE_MINUTES" =~ ^[0-9]+$ ]] || [ "$BAS_COLLECTOR_SILENCE_MINUTES" -le 0 ]; then
    fail "BAS_COLLECTOR_SILENCE_MINUTES must be a positive integer, got '${BAS_COLLECTOR_SILENCE_MINUTES}'"
  fi

  parse_database_url "$DATABASE_URL"
  unset DATABASE_URL
  export PGCONNECT_TIMEOUT=30
  log "database ${PGDATABASE} on ${PGHOST}:${PGPORT} as ${PGUSER}, sslmode=${PGSSLMODE}; threshold ${BAS_COLLECTOR_SILENCE_MINUTES} minutes"

  # No connection argument: libpq reads PGHOST/PGUSER/PGPASSWORD/PGDATABASE/
  # PGSSLMODE from the environment. The threshold travels as a psql variable
  # into a session setting, because a DO body is a string literal and psql
  # does not interpolate inside one. The SELECT's own row goes to /dev/null;
  # the NOTICE and any EXCEPTION are on stderr and land in the job log.
  if ! psql --no-psqlrc --quiet --tuples-only --output /dev/null \
        --set ON_ERROR_STOP=1 --set "minutes=${BAS_COLLECTOR_SILENCE_MINUTES}" <<'SQL'
SELECT set_config('phb.collector_silence_minutes', :'minutes', false);
DO $$
DECLARE
  threshold       interval := make_interval(mins => current_setting('phb.collector_silence_minutes')::int);
  last_ok         timestamptz;
  last_any        timestamptz;
  last_any_status text;
BEGIN
  SELECT max(finished_at) INTO last_ok
    FROM bas_ingest_runs
   WHERE status IN ('ok', 'partial') AND finished_at IS NOT NULL;
  SELECT started_at, status INTO last_any, last_any_status
    FROM bas_ingest_runs
   ORDER BY started_at DESC
   LIMIT 1;
  IF last_ok IS NULL THEN
    RAISE EXCEPTION 'BAS COLLECTOR SILENT: no successful collector run is recorded at all (threshold %)', threshold;
  END IF;
  IF last_ok < now() - threshold THEN
    RAISE EXCEPTION 'BAS COLLECTOR SILENT: the last successful run finished at % (% ago; threshold %); the newest run of any status started at % with status %',
      last_ok, date_trunc('second', now() - last_ok), threshold, last_any, last_any_status;
  END IF;
  RAISE NOTICE 'BAS collector ok: the last successful run finished at % (% ago; threshold %)',
    last_ok, date_trunc('second', now() - last_ok), threshold;
END $$;
SQL
  then
    fail "the collector check did not pass - the lines above say why"
  fi
  log "OK: the BAS collector has written within the last ${BAS_COLLECTOR_SILENCE_MINUTES} minutes"
}

# Sourced by the test to reach collector_check_main; run as a program otherwise.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  collector_check_main "$@"
fi
