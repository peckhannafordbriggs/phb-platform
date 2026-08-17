-- Add "Co-Op Intern" to the positions list, and move the one row using it as
-- free text onto the listed value.
--
-- Position keeps working exactly as it did: a dropdown from the positions table
-- with an "Other" free-text option. This adds a row to that table; it changes
-- nothing about how the field behaves.
--
-- Free text on a profile is a flag for admin cleanup, not a permanent state -
-- docs/04. This is that cleanup for the one row that had it, done as a migration
-- so every environment ends up the same rather than depending on someone
-- remembering to click it.
--
-- Alphabetical placement lands it between "Administrative" and
-- "Controls Engineer". Verified under C, ICU en-US and the Windows collation,
-- because a hyphen is exactly the character whose ordering is collation
-- dependent - see the collation section of docs/runbook.md.

-- 1. The new value. Status defaults to 'active'.
INSERT INTO positions (id, name)
VALUES (gen_random_uuid(), 'Co-Op Intern')
ON CONFLICT (name) DO NOTHING;

-- 2. Record the reassignment before making it, so the old free text is still
--    readable. A null actor_employee_id is the honest record for a migration:
--    the platform acted, not a person.
--
--    Scoped to the exact free-text value it is replacing. If that row has since
--    been changed by hand or through the profile screen, this matches nothing and
--    the migration leaves it alone rather than overwriting a newer answer.
INSERT INTO audit_events (id, actor_employee_id, action, target_employee_id, metadata, occurred_at)
SELECT
  gen_random_uuid(),
  NULL,
  'employee.position_changed',
  e.id,
  jsonb_build_object(
    'from', e.position_other,
    'to', 'Co-Op Intern',
    'reason', 'free-text position replaced by migration 20260817000100_add_coop_intern_position'
  ),
  now()
FROM employees e
WHERE e.email = 'msheth@phb1899.com'
  AND e.position_other = 'CS Co-Op Intern';

-- 3. Move it onto the listed value and clear the free text. The two columns must
--    never both be populated - position_other is only meaningful when
--    position_id is null.
UPDATE employees
SET position_id = (SELECT id FROM positions WHERE name = 'Co-Op Intern'),
    position_other = NULL,
    updated_at = now()
WHERE email = 'msheth@phb1899.com'
  AND position_other = 'CS Co-Op Intern';
