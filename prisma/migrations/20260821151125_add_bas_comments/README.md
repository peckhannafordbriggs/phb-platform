# Do not edit `migration.sql` in this folder

This migration is applied on the live database. On 2026-08-21 it failed once at
15:13 (a `||` inside a `COMMENT ON`; marked `rolled_back`, zero steps) and was
re-applied successfully at 15:14 after the fix. `_prisma_migrations` on live
carries both rows, and that is correct: Prisma retries a migration marked rolled
back on the next deploy, and it did. The comments are on live — compared column
by column against a fresh database on 2026-09-17, no difference either way.

Like every applied migration, it will never run again anywhere it has been
applied. Anything edited into `migration.sql` reaches every **fresh** database
(the test suites build one, and would pass) and never reaches live.

**Why this note is a README and not a comment inside `migration.sql`.** Prisma
records a checksum of `migration.sql` when it applies it. Changing even a comment
in that file makes `prisma migrate dev` report *"was modified after it was
applied"* and offer to **reset the database** — and the development database is
the one the BAS collector writes to. `migrate status` and `migrate deploy` do not
check the checksum, but `migrate dev` does. A file beside the migration is not
checksummed.

To change or add a comment, write a **new** migration.
`20260917235000_restate_bas_comments` re-states this file's whole intended set
and is the convergence point and the model. See `runbook.md` → *A migration
marked `rolled_back` on live, and why an applied migration is never edited*.
