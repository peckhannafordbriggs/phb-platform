-- Register the Freeze Protection module.
--
-- A module row reaches production through a migration and nothing else; the
-- seed never runs there. Same values as the row in prisma/seed.ts, and
-- ON CONFLICT (key) DO NOTHING makes this a no-op on every database the seed
-- has already populated. docs/10-adding-a-module.md is the rule.
--
-- Status is 'active' explicitly, matching the seed's column default. A row
-- grants nobody anything: until an admin grants it, nobody sees the module.

INSERT INTO modules (key, display_name, description, icon, sort_order, status)
VALUES
  (
    'freeze-protection',
    'Freeze Protection',
    'Coil freeze exposure, safeties and test results, by project.',
    'snowflake',
    500,
    'active'
  )
ON CONFLICT (key) DO NOTHING;
