-- Add the bootstrap administrators to an existing database.
--
-- BOOTSTRAP_ADMIN_EMAIL is now a comma-separated list, the same shape as
-- ALLOWED_EMAIL_DOMAINS. prisma/seed.ts creates these rows on a fresh database;
-- this adds them to one that already exists, so a deployed environment does not
-- depend on someone remembering to re-run the seed.
--
-- Each row: entra_oid null, is_platform_admin true, profile_completed false.
-- Their first sign-in stamps the entra_oid onto this row rather than creating a
-- second one - lib/auth/signin.ts looks up an existing row by email with a null
-- entra_oid for exactly this case.
--
-- The names are placeholders. The employee corrects them during onboarding,
-- which is why profile_completed stays false.
--
-- ON CONFLICT DO NOTHING, so this:
--   * cannot duplicate anyone,
--   * cannot reset a row that already exists,
--   * and cannot re-promote someone who was demoted through the UI.
-- An address that already has a row is left exactly as it is, admin or not.
-- Promoting an existing non-admin row is a decision for a person in the admin
-- screen, or for the seed when no active administrator remains at all.

INSERT INTO employees (
  id, email, first_name, last_name, entra_oid,
  is_platform_admin, profile_completed, status,
  first_seen_at, created_at, updated_at
)
VALUES
  (gen_random_uuid(), 'msheth@phb1899.com',    'Platform', 'Administrator', NULL, true, false, 'active', now(), now(), now()),
  (gen_random_uuid(), 'jschwarz@phb1899.com',  'Platform', 'Administrator', NULL, true, false, 'active', now(), now(), now()),
  (gen_random_uuid(), 'jschriner@phb1899.com', 'Platform', 'Administrator', NULL, true, false, 'active', now(), now(), now()),
  (gen_random_uuid(), 'bbolten@phb1899.com',   'Platform', 'Administrator', NULL, true, false, 'active', now(), now(), now())
ON CONFLICT (email) DO NOTHING;

-- Audit only the rows this migration actually created. A row that already
-- existed is not an event.
INSERT INTO audit_events (id, actor_employee_id, action, target_employee_id, metadata, occurred_at)
SELECT
  gen_random_uuid(),
  NULL,
  'employee.provisioned',
  e.id,
  jsonb_build_object(
    'email', e.email,
    'bootstrapAdmin', true,
    'source', 'migration 20260817000200_seed_bootstrap_admins'
  ),
  now()
FROM employees e
WHERE e.email IN (
    'msheth@phb1899.com',
    'jschwarz@phb1899.com',
    'jschriner@phb1899.com',
    'bbolten@phb1899.com'
  )
  AND NOT EXISTS (
    SELECT 1 FROM audit_events a
    WHERE a.target_employee_id = e.id
      AND a.action = 'employee.provisioned'
  );

INSERT INTO audit_events (id, actor_employee_id, action, target_employee_id, metadata, occurred_at)
SELECT
  gen_random_uuid(),
  NULL,
  'employee.admin_granted',
  e.id,
  jsonb_build_object(
    'reason', 'bootstrap admin list',
    'source', 'migration 20260817000200_seed_bootstrap_admins'
  ),
  now()
FROM employees e
WHERE e.email IN (
    'msheth@phb1899.com',
    'jschwarz@phb1899.com',
    'jschriner@phb1899.com',
    'bbolten@phb1899.com'
  )
  AND e.is_platform_admin = true
  AND NOT EXISTS (
    SELECT 1 FROM audit_events a
    WHERE a.target_employee_id = e.id
      AND a.action = 'employee.admin_granted'
  );
