-- =============================================================================
-- The sign-in before the current one.
--
-- "Since you last signed in" needs a timestamp that survives the sign-in that
-- is asking the question. `last_login_at` does not: lib/auth/signin.ts sets it
-- to now() as part of authenticating, before any page renders, so it always
-- reads as seconds ago and every window it could open is empty. A successful
-- sign-in writes no audit row either - the only login action is
-- `login.denied` - so the previous sign-in was, until this column, stored
-- nowhere at all.
--
-- Nullable with no default and no backfill. Every existing row gets NULL, which
-- is the honest answer: those sign-ins happened before anything recorded them,
-- and inventing a value here would date a "what changed" list from a moment
-- nobody visited. The first sign-in after this migration fills it in.
-- =============================================================================

ALTER TABLE employees ADD COLUMN previous_login_at timestamptz(3);

COMMENT ON COLUMN employees.previous_login_at IS
  'The sign-in before the current one. Set from the OLD last_login_at during '
  'sign-in, immediately before last_login_at is overwritten with now(). This is '
  'the only column that can date a "since you last signed in" window: '
  'last_login_at is always the CURRENT session once a page can read it. NULL '
  'means no previous sign-in has been recorded - either a first-ever sign-in, '
  'or a row that last signed in before this column existed.';
