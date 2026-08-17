-- Add "Co-Op Intern" to the positions list.
--
-- Position keeps working exactly as it did: a dropdown from the positions table
-- with an "Other" free-text option. This adds a row to that table; it changes
-- nothing about how the field behaves.
--
-- Alphabetical placement lands it between "Administrative" and
-- "Controls Engineer". Verified under C, ICU en-US and the Windows collation,
-- because a hyphen is exactly the character whose ordering is collation
-- dependent - see the collation section of docs/runbook.md.
--
-- prisma/seed.ts lists this value too, so a fresh database gets it from the seed
-- and never needs this migration. It stays for a database that already exists and
-- is upgraded in place. Both are idempotent, and running both changes nothing.
--
-- No employee is moved onto it here. Reassigning a specific person means naming
-- them, and a migration that hardcodes an email address bakes one individual into
-- the schema history. Free text is a flag for admin cleanup - docs/04 - and the
-- admin employee screen is where that cleanup happens.

INSERT INTO positions (id, name)
VALUES (gen_random_uuid(), 'Co-Op Intern')
ON CONFLICT (name) DO NOTHING;
