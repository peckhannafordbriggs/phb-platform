# The nightly database backup image: pg_dump of the server's own major
# version, curl for the blob upload, nothing else. Built ONCE into the
# platform's registry and rebuilt only when the PostgreSQL major changes;
# no application code is in it, so no merge to main touches it.
#
#   az acr build --registry <registry> --image db-backup:pg17 infra/db-backup
#
# PG_MAJOR must equal `postgresVersion` in infra/main.bicep: a pg_dump older
# than the server refuses to run ("server version mismatch"), and the
# template names the image by that same number (`db-backup:pg${postgresVersion}`),
# so the tag, the client and the server are one value.
# tests/db-backup-script.test.ts holds the default here to the template's.
ARG PG_MAJOR=17
FROM postgres:${PG_MAJOR}-alpine

# bash: the script's own language (the image ships it for its entrypoint; the
# line is explicit so a base-image change cannot take it away silently).
# curl: the identity endpoint and the two blob requests.
# openssl: the Content-MD5 the storage service checks the upload against.
RUN apk add --no-cache bash curl openssl

COPY backup.sh /usr/local/bin/phb-db-backup
RUN chmod 0555 /usr/local/bin/phb-db-backup

# Not root. The base image's unprivileged user; /tmp is where the dump lives
# for the seconds between pg_dump and the upload.
USER postgres
WORKDIR /tmp

# The template's `command` names this same path, and nothing else: no
# argument of the job could ever carry a credential.
ENTRYPOINT ["/usr/local/bin/phb-db-backup"]
