-- AuditEvent is append-only (docs/05-database-and-sources.md).
--
-- The application never exposes an update or delete path, but "we did not write
-- the code" is not the same guarantee as "the database refuses". This makes the
-- rule enforceable and testable rather than merely intended.
--
-- Two consequences, both deliberate:
--
--   * TRUNCATE is not blocked. It does not fire row-level triggers, and the
--     test suite needs to reset between files. Nothing in the application ever
--     issues one.
--
--   * Deleting an employee row now fails. The foreign keys on audit_events use
--     ON DELETE SET NULL, which fires this trigger as an UPDATE. That is the
--     correct outcome: docs/04 says deactivate, never delete, because a deleted
--     employee orphans their audit history. The database now enforces it.

CREATE OR REPLACE FUNCTION audit_events_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'audit_events is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE ON "audit_events"
  FOR EACH ROW
  EXECUTE FUNCTION audit_events_append_only();

CREATE TRIGGER audit_events_no_delete
  BEFORE DELETE ON "audit_events"
  FOR EACH ROW
  EXECUTE FUNCTION audit_events_append_only();
