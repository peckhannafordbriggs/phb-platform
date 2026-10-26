#!/usr/bin/env bash
# =============================================================================
# phb-db-backup: one nightly pg_dump of the production database, uploaded to
# blob storage. Runs as the Container Apps Job `<baseName>-db-backup`
# (infra/main.bicep, `dbBackupJob`), from the image infra/db-backup/Dockerfile
# builds. Exits non-zero on ANY failure, so the execution shows Failed in
# `az containerapp job execution list` rather than a green run with no dump.
#
# WHY THIS EXISTS
#
#   The BAS readings exist in exactly one place - this database. The JACE
#   rolls its own history off after about 42 hours, so a table lost here is
#   lost. Azure's point-in-time backups live with the server and die with it;
#   this is the copy that does not. runbook.md -> "Nightly database backup".
#
# WHAT IT DOES, IN ORDER
#
#   1. Takes the connection from DATABASE_URL and hands it to libpq through
#      its own variables (PGHOST, PGUSER, PGPASSWORD, ...). pg_dump is then
#      run with NO connection argument at all, so the password is never on a
#      command line - not in `ps`, not in a log line, not in a shell history.
#      DATABASE_URL itself is unset before anything else runs.
#   2. pg_dump -Fc (custom format: compressed, and pg_restore can read its
#      table of contents without a server) to a file whose name carries the
#      UTC date and time.
#   3. pg_restore --list on the file. A dump nobody has read back is a file,
#      not a backup; this catches a truncated or empty archive, and it checks
#      the platform's own marker table is in it.
#   4. A token for blob storage from the Container Apps identity endpoint, as
#      the user-assigned identity (AZURE_CLIENT_ID). No key, no secret: the
#      role assignment in the template is the only credential.
#   5. PUT the file as a block blob with Content-MD5, which the storage
#      service verifies before it accepts the blob - a corrupted upload is a
#      400, not a silent bad copy. Then a HEAD to confirm the blob is there at
#      the size that was sent.
#
# Every header that carries a credential - the identity header, the bearer
# token - is passed to curl through a config file on STDIN (`-K -`), never as
# a `-H` argument. tests/db-backup-script.test.ts holds this file to that;
# `npm run db:backup:verify` runs the built image against a throwaway
# database and a fake of the two Azure endpoints.
#
# Nothing here is specific to PH+B: the endpoint, the container and the
# identity are environment variables the template sets.
# =============================================================================

set -euo pipefail
umask 077

log()  { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "FAILED: $*"; exit 1; }
# Anything set -e stops on that no fail() below described still says so, with
# the line, rather than ending the execution silently. The exit status is the
# command's own, non-zero.
trap 'log "FAILED: unexpected error at line $LINENO (exit $?)"' ERR

# --- 1. The connection, from DATABASE_URL into libpq's own variables ---------
#
# postgresql://user:password@host:port/database?sslmode=require
#
# The URL the template writes into DATABASE-URL percent-encodes the password
# (uriComponent), so `@`, `:`, `/`, `%` and `?` inside it are safe. Decoding
# is bash's own printf %b, which understands \xHH. A URL that does not parse
# fails the run; nothing guesses.

urldecode() {
  local s="$1"
  printf '%b' "${s//%/\\x}"
}

parse_database_url() {
  local url="$1" rest userinfo hostpart user pass hostport dbq db query host port
  # `if` throughout, never `[ test ] && assign`: under set -e a false test at
  # the end of a function is the function's exit status, and the script dies
  # there with no message.
  rest="${url#postgresql://}"
  if [ "$rest" = "$url" ]; then rest="${url#postgres://}"; fi
  if [ "$rest" = "$url" ]; then fail "DATABASE_URL is not a postgresql:// URL"; fi
  if [[ "$rest" != *@* ]]; then fail "DATABASE_URL has no user@host part"; fi
  userinfo="${rest%@*}"          # up to the LAST @; the password is encoded, the host never holds one
  hostpart="${rest##*@}"
  if [[ "$userinfo" != *:* ]]; then fail "DATABASE_URL carries no password"; fi
  user="${userinfo%%:*}"
  pass="${userinfo#*:}"
  if [ -z "$user" ]; then fail "DATABASE_URL has an empty user"; fi
  if [ -z "$pass" ]; then fail "DATABASE_URL has an empty password"; fi
  if [[ "$hostpart" != */* ]]; then fail "DATABASE_URL names no database"; fi
  hostport="${hostpart%%/*}"
  dbq="${hostpart#*/}"
  db="${dbq%%\?*}"
  query=""
  if [[ "$dbq" == *\?* ]]; then query="${dbq#*\?}"; fi
  if [ -z "$db" ]; then fail "DATABASE_URL names no database"; fi
  host="${hostport%%:*}"
  port="5432"
  if [[ "$hostport" == *:* ]]; then port="${hostport#*:}"; fi
  if [ -z "$host" ]; then fail "DATABASE_URL has an empty host"; fi
  if [[ ! "$port" =~ ^[0-9]+$ ]]; then fail "DATABASE_URL has a non-numeric port"; fi

  export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE
  PGHOST="$(urldecode "$host")"
  PGPORT="$port"
  PGUSER="$(urldecode "$user")"
  PGPASSWORD="$(urldecode "$pass")"
  PGDATABASE="$(urldecode "$db")"
  # sslmode from the query string if it names one; otherwise required, which
  # is what the Azure server demands and what every URL in this platform says.
  PGSSLMODE="require"
  local kv k v
  local IFS='&'
  for kv in $query; do
    k="${kv%%=*}"
    v="${kv#*=}"
    if [ "$k" = "sslmode" ] && [ -n "$v" ]; then PGSSLMODE="$(urldecode "$v")"; fi
  done
  return 0
}

main() {
  local v
  for v in DATABASE_URL BACKUP_BLOB_ENDPOINT BACKUP_CONTAINER AZURE_CLIENT_ID IDENTITY_ENDPOINT IDENTITY_HEADER; do
    [ -n "${!v:-}" ] || fail "$v is not set"
  done

  parse_database_url "$DATABASE_URL"
  unset DATABASE_URL
  export PGCONNECT_TIMEOUT=30
  log "database ${PGDATABASE} on ${PGHOST}:${PGPORT} as ${PGUSER}, sslmode=${PGSSLMODE}"

  # --- 2. The dump -------------------------------------------------------------
  # UTC in the name, and it says so: the job's cron is UTC and the Z keeps a
  # reader from doing the time-zone arithmetic twice.
  local stamp name file out head
  stamp="$(date -u +%Y-%m-%d_%H%MZ)"
  name="${PGDATABASE}_${stamp}.dump"
  file="${TMPDIR:-/tmp}/${name}"
  out="${TMPDIR:-/tmp}/response.txt"
  head="${TMPDIR:-/tmp}/head.txt"
  # Whatever happens from here, the dump does not outlive the run: a partial
  # or unverified file is worse than none, because it looks like a backup.
  # Expanded now, in double quotes: the three are locals, gone by the time
  # the trap runs, and set -u would otherwise fail the trap itself.
  trap "rm -f '$file' '$out' '$head'" EXIT
  rm -f "$file"

  log "pg_dump $(pg_dump --version | sed 's/^pg_dump //') -> ${name}"
  # No connection argument. libpq reads PGHOST/PGUSER/PGPASSWORD/PGDATABASE/
  # PGSSLMODE from the environment. Ownership and privileges are KEPT in the
  # archive - a restore drops them with --no-owner --no-privileges when the
  # target's roles differ (runbook.md), and a dump that holds them loses
  # nothing by it.
  if ! pg_dump --format=custom --file="$file"; then
    fail "pg_dump exited non-zero"
  fi
  local bytes
  bytes="$(stat -c %s "$file")"
  if [ "$bytes" -le 0 ]; then fail "pg_dump wrote an empty file"; fi
  log "wrote ${bytes} bytes"

  # --- 3. Read it back ----------------------------------------------------------
  local toc tables
  if ! toc="$(pg_restore --list "$file")"; then
    fail "pg_restore cannot read the archive it just wrote"
  fi
  tables="$(printf '%s\n' "$toc" | grep -c ' TABLE DATA ' || true)"
  if [ "$tables" -le 0 ]; then fail "the archive holds no table data"; fi
  # The platform's own marker: every database Prisma has migrated has this
  # table, and a dump without it is a dump of the wrong database.
  if ! printf '%s\n' "$toc" | grep -q ' TABLE DATA public _prisma_migrations '; then
    fail "the archive holds no _prisma_migrations table - is this the platform database?"
  fi
  log "archive readable: ${tables} tables with data"

  # --- 4. A token for blob storage, as the job's identity ------------------------
  # The Container Apps identity endpoint. The identity header goes to curl on
  # stdin, never as an argument.
  local token
  token="$(
    printf 'header = "X-IDENTITY-HEADER: %s"\n' "$IDENTITY_HEADER" |
      curl --silent --show-error --fail --config - --connect-timeout 20 --max-time 60 --get "$IDENTITY_ENDPOINT" \
        --data-urlencode "api-version=2019-08-01" \
        --data-urlencode "resource=https://storage.azure.com/" \
        --data-urlencode "client_id=${AZURE_CLIENT_ID}" |
      sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p'
  )" || fail "the identity endpoint refused the token request"
  if [ -z "$token" ]; then fail "the identity endpoint returned no access_token"; fi

  # --- 5. Upload, with the MD5 the service checks, then confirm ------------------
  local md5 url status
  md5="$(openssl dgst -md5 -binary "$file" | base64 | tr -d '\n')"
  url="${BACKUP_BLOB_ENDPOINT%/}/${BACKUP_CONTAINER}/${name}"
  # One PUT. Put Blob takes a block blob of up to 5000 MiB in a single request
  # (x-ms-version 2019-12-12 and later); a dump of this database is megabytes.
  if [ "$bytes" -gt 4000000000 ]; then
    fail "${bytes} bytes is past the single-request limit; this script needs block upload before it can back a database this size up"
  fi
  status="$(
    printf 'header = "Authorization: Bearer %s"\n' "$token" |
      curl --silent --show-error --config - --connect-timeout 20 --max-time 1200 --request PUT --output "$out" --write-out '%{http_code}' \
        --header "x-ms-version: 2023-11-03" \
        --header "x-ms-blob-type: BlockBlob" \
        --header "Content-Type: application/octet-stream" \
        --header "Content-MD5: ${md5}" \
        --header "x-ms-blob-content-md5: ${md5}" \
        --data-binary @"$file" \
        "$url"
  )" || fail "the upload request did not complete"
  if [ "$status" != "201" ]; then
    fail "upload returned HTTP ${status}: $(tr -d '\r\n' < "$out" | cut -c1-400)"
  fi

  local length
  status="$(
    printf 'header = "Authorization: Bearer %s"\n' "$token" |
      curl --silent --show-error --config - --connect-timeout 20 --max-time 60 --head --output /dev/null --dump-header "$head" --write-out '%{http_code}' \
        --header "x-ms-version: 2023-11-03" \
        "$url"
  )" || fail "the confirmation request did not complete"
  if [ "$status" != "200" ]; then fail "the blob is not there after the upload (HEAD returned HTTP ${status})"; fi
  length="$(tr -d '\r' < "$head" | awk 'tolower($1)=="content-length:" {print $2}' | tail -n 1)"
  if [ "$length" != "$bytes" ]; then fail "the blob is ${length:-?} bytes, the dump was ${bytes}"; fi

  log "OK: ${BACKUP_CONTAINER}/${name}, ${bytes} bytes, ${tables} tables, md5 ${md5}"
}

# Sourced by the test to reach parse_database_url; run as a program otherwise.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
