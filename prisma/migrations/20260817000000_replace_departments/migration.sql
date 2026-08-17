-- Replace the placeholder department list with the real one.
--
-- The seven original departments were explicitly a placeholder: docs/05 said the
-- real list was "to be confirmed with the operator". This is that list, confirmed.
--
-- There is no delete path for a department in the application - hiding must not
-- break employees already assigned to a value, and employees.department_id is
-- ON DELETE RESTRICT. Removing rows is therefore a migration, which is also the
-- only way this gets applied to every environment identically.
--
-- 'Service' appears in both the old list and the new one. Its row is KEPT rather
-- than deleted and reinserted: churning its id would detach the employees
-- already assigned to it and gain nothing.
--
-- Departments an admin created by hand are left alone. Only the six placeholder
-- names below are removed; deleting anything else would be this migration
-- guessing about data it did not create.

-- 1. The confirmed list. Status defaults to 'active'. ON CONFLICT so a database
--    that already has one of these names (notably Service) is left as it is.
INSERT INTO departments (id, name)
VALUES
  (gen_random_uuid(), 'Administrative'),
  (gen_random_uuid(), 'AI'),
  (gen_random_uuid(), 'Controls'),
  (gen_random_uuid(), 'Engineer'),
  (gen_random_uuid(), 'Estimator'),
  (gen_random_uuid(), 'Foreman'),
  (gen_random_uuid(), 'Piping'),
  (gen_random_uuid(), 'Project Manager'),
  (gen_random_uuid(), 'Service'),
  (gen_random_uuid(), 'Sheet Metal'),
  (gen_random_uuid(), 'VDC')
ON CONFLICT (name) DO NOTHING;

-- 2. Everyone still pointing at a removed department loses the value.
--
--    Nulling it rather than guessing a mapping is deliberate. 'Estimating' is not
--    obviously 'Estimator', and 'Field Operations' could be Foreman, Piping or
--    Sheet Metal. Inventing an answer would put unverified data in front of an
--    admin as though someone had reported it. department_id is nullable and the
--    employee stays profile-complete; an admin sets the real value.
--
--    Applied uniformly. No employee is named here: a migration that hardcodes an
--    address bakes a person into the schema history and behaves differently for
--    them than for everyone else. Per-person corrections belong in the admin
--    screen, which now has them.
--
--    One audit row per affected employee, so a department that vanished from
--    someone's profile is explainable rather than mysterious.
INSERT INTO audit_events (id, actor_employee_id, action, target_employee_id, metadata, occurred_at)
SELECT
  gen_random_uuid(),
  NULL,
  'employee.department_changed',
  e.id,
  jsonb_build_object(
    'from', d.name,
    'to', NULL,
    'reason', 'department removed by migration 20260817000000_replace_departments'
  ),
  now()
FROM employees e
JOIN departments d ON d.id = e.department_id
WHERE d.name IN (
  'Accounting',
  'Administration',
  'Estimating',
  'Executive',
  'Field Operations',
  'Project Management'
);

UPDATE employees
SET department_id = NULL,
    updated_at = now()
WHERE department_id IN (
  SELECT id FROM departments WHERE name IN (
    'Accounting',
    'Administration',
    'Estimating',
    'Executive',
    'Field Operations',
    'Project Management'
  )
);

-- 3. Record the removals, then remove them.
INSERT INTO audit_events (id, actor_employee_id, action, target_employee_id, metadata, occurred_at)
SELECT
  gen_random_uuid(),
  NULL,
  'department.deleted',
  NULL,
  jsonb_build_object(
    'departmentId', d.id,
    'name', d.name,
    'reason', 'placeholder department list replaced by migration 20260817000000_replace_departments'
  ),
  now()
FROM departments d
WHERE d.name IN (
  'Accounting',
  'Administration',
  'Estimating',
  'Executive',
  'Field Operations',
  'Project Management'
);

-- If any employee still referenced one of these, ON DELETE RESTRICT raises here
-- and the whole migration rolls back. That is the intended outcome: better a
-- failed migration than a silently detached employee.
DELETE FROM departments
WHERE name IN (
  'Accounting',
  'Administration',
  'Estimating',
  'Executive',
  'Field Operations',
  'Project Management'
);
