# BAS data migration: office PC → Azure

One-shot move of the fourteen `bas_*` tables. Three psql files, run by a person,
in order, from one empty working directory:

1. `export.sql` — against the source. Reads only. Writes `bas-migration-data/`.
2. `import.sql` — against the target. One transaction; asks for `YES`; refuses a
   target that already holds BAS data.
3. `check.sql` — against the target, afterwards. Read-only.

`common.sql` is included by all three and holds the table list. Read every file
before running one.

The procedure, the exact commands, what the import refuses, what was verified
and what happens on a second run are in `runbook.md` → *Moving the BAS data to
the Azure database*. The collector's role for the Azure server is
`../setup-bas-collector-role.sql`. `tests/bas-migration-scripts.test.ts` drives
these files through psql against the test database.
