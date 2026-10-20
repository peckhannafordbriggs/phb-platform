-- Register the Cost Intelligence and Knowledge Base modules.
--
-- Both modules shipped their pages on 23 September 2026 (PR #25) with rows in
-- prisma/seed.ts only. The seed runs on fresh databases - every developer
-- machine, the test database, CI - and NEVER on production: it ran there once,
-- by hand, on 9 September, before either row existed, and the deploy workflow
-- deliberately does not run it (see .github/workflows/deploy.yml). So the
-- deployed platform had the pages and no rows: nothing to grant, nothing in
-- anyone's sidebar. Verified by querying the production modules table on
-- 24 September 2026 - it held bas and change-orders only.
--
-- A module row reaches production through a migration and nothing else. The
-- seed lines stay, because a fresh database still needs them; this migration
-- carries the same values, and ON CONFLICT (key) DO NOTHING makes it a no-op
-- on every database the seed has already populated. Running it twice changes
-- nothing. docs/10-adding-a-module.md is the rule and the walkthrough.
--
-- Status is 'active', deliberately, rather than 'hidden' until the modules
-- have real screens:
--
--   * active is what every other database already holds for these rows (the
--     seed takes the column default), and the point of this migration is to
--     stop production differing from everything else.
--   * A row grants nobody anything. Admins grant access; a module with no
--     grants is invisible to everyone, and in production nobody holds one.
--     Who sees the placeholder is the admin's decision, which is the
--     platform's model for every module.
--   * The placeholder page is a designed state - components/module-placeholder.tsx,
--     "Content not available ... no screens in this build yet" - behind the
--     same grant guard as a finished module. It is not a broken page.
--   * There is no admin screen that changes modules.status. A hidden row
--     would need a second migration, or a hand edit on production, to turn on
--     later. ON CONFLICT also means a later migration could not flip it
--     without an explicit UPDATE.
--
-- Only the two missing rows. bas and change-orders were seeded on production
-- by hand and are not re-stated here; tests/module-registry.test.ts carries
-- the allowlist for those two and holds every later module to this file's
-- pattern.
--
-- No email address, no person, no environment-specific value: the same
-- statement runs identically everywhere.

INSERT INTO modules (key, display_name, description, icon, sort_order, status)
VALUES
  (
    'cost-intelligence',
    'Cost Intelligence',
    'Bid estimates and the reasoning behind each cost line.',
    'calculator',
    300,
    'active'
  ),
  (
    'knowledge-base',
    'Knowledge Base',
    'Ask questions about past bids and projects, answered from the documents they came from.',
    'search',
    400,
    'active'
  )
ON CONFLICT (key) DO NOTHING;
