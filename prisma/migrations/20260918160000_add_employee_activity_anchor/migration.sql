-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "last_active_at" TIMESTAMPTZ(3),
ADD COLUMN     "previous_active_at" TIMESTAMPTZ(3);


-- =============================================================================
-- Everything above this line is what the Prisma migration engine emits for the
-- schema.prisma change. Everything below it was written by hand, because Prisma
-- cannot express it.
--
--   Section 1  Why: activity is not authentication, and a session lasts days.
--   Section 2  A CHECK that the anchor is strictly before the live value - the
--              silent-empty-digest bug as a constraint violation.
--   Section 3  COMMENT ON for the two new columns and the two they sit beside.
--
-- No data migration. Every existing row takes NULL in both columns, and NULL
-- is the honest value: nothing recorded when these people were last here.
-- Home says nothing about a previous visit for a NULL anchor - no blank, no
-- epoch date - and the anchor fills itself in on each person's second active
-- day. last_login_at and previous_login_at are NOT touched, read, or
-- reinterpreted by anything in this migration.
-- =============================================================================


-- =============================================================================
-- SECTION 1 - what this is for
--
-- Home's greeting read "Last signed in on Monday, September 14" and its digest
-- was headed "Since you last signed in". Both were dated from
-- previous_login_at, which is the AUTHENTICATION record: the sign-in before
-- the current one. A session lasts days, so somebody who used the platform
-- every day without re-authenticating saw "Monday" all week, and the digest
-- silently covered four days while reading as if it meant yesterday.
--
-- The login columns are correct and stay exactly as they are. They are the
-- record of when a session was issued and they matter for audit. What Home
-- needs is a different fact - the most recent day the person actually USED
-- the platform - so it gets different columns.
--
-- Two of them, and the split is the point:
--
--   last_active_at      the live value. Moves as the person uses the platform,
--                       throttled to one write per five minutes.
--   previous_active_at  the ANCHOR. Frozen for a whole calendar day. The only
--                       value the greeting and the digest may read.
--
-- The rollover: when a deliberate action lands on a different calendar day
-- (America/New_York - see lib/activity/rollover.ts for why not UTC) from
-- last_active_at, last_active_at is copied into previous_active_at and then
-- last_active_at starts moving again. Same day, the anchor does not move, so
-- the digest is stable all day rather than shrinking as you use it.
--
-- What counts as activity is decided in code, not here: deliberate page loads
-- and navigations only. Collection Health polls its API every minute while
-- its tab is open; if that counted, a tab left open overnight would anchor
-- the next morning at 11:59 PM and the digest would cover nothing.
-- =============================================================================


-- =============================================================================
-- SECTION 2 - the anchor is strictly before the live value
--
-- The bug this whole design exists to prevent: the greeting reads the live
-- value, so the window collapses to zero, the digest is permanently empty,
-- and the page looks completely normal while telling you nothing. The same
-- failure shape as a backup that never ran. Code that wrote
-- previous_active_at = last_active_at would produce exactly that, and would
-- render fine.
--
-- So the database refuses it. previous_active_at is either NULL or strictly
-- earlier than a non-NULL last_active_at. Equal is refused. Correct code can
-- never trip this - the anchor is always a copy of an OLDER live value - and
-- the wrong code fails loudly on its first write instead of shipping an
-- empty digest for months.
-- =============================================================================

ALTER TABLE employees
  ADD CONSTRAINT employees_previous_active_before_last CHECK (
    previous_active_at IS NULL
    OR (last_active_at IS NOT NULL AND previous_active_at < last_active_at)
  );


-- =============================================================================
-- SECTION 3 - column comments
-- =============================================================================

COMMENT ON COLUMN employees.last_active_at IS
  'ACTIVITY, not authentication: the most recent DELIBERATE page load or '
  'navigation by this person. Never a background poll, an auto-refresh or a '
  'prefetch. Written by lib/authz/guard.ts on the way through the '
  'authorization boundary, only when the stored value is more than five '
  'minutes old. The live value - nothing on screen reads it directly. NULL '
  'means no activity recorded since the column existed.';

COMMENT ON COLUMN employees.previous_active_at IS
  'The ANCHOR: the value last_active_at held before the first deliberate '
  'action of the current calendar day (America/New_York). Frozen for the '
  'whole day. The ONLY column Home''s greeting ("You were last here ...") and '
  'its "since you were last here" digest may read - reading last_active_at '
  'instead collapses the window to zero and empties the digest silently, '
  'which is why employees_previous_active_before_last refuses a row where '
  'the two are equal. NULL means no previous active day is recorded, and Home '
  'then says nothing about a previous visit.';

COMMENT ON COLUMN employees.last_login_at IS
  'AUTHENTICATION: when this person''s current session was issued. Set to '
  'now() by lib/auth/signin.ts during sign-in. A session lasts days, so this '
  'is NOT when they were last here - that is last_active_at. Kept for audit; '
  'not read by Home.';

COMMENT ON COLUMN employees.previous_login_at IS
  'AUTHENTICATION: the sign-in before the current one, carried across from '
  'the OLD last_login_at during sign-in. Kept for audit. No longer read by '
  'Home, which dates its greeting and digest from previous_active_at instead, '
  'because a session lasts days and this column could say "Monday" all week.';
