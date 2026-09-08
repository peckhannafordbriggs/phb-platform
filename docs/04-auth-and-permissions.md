# Authentication and permissions

Two separate systems, deliberately:

- **Entra ID** answers *who is this person*.
- **The platform database** answers *what can they see*.

## Authentication

Auth.js (NextAuth v5) with the Microsoft Entra ID provider. Single-tenant app
registration. The platform never stores a password and never creates accounts.

### Login gate — all four checks required

1. **Tenant.** Token `tid` claim must equal the configured tenant ID. The
   single-tenant setting alone is not sufficient verification.
2. **Domain.** Verified email domain must be in `ALLOWED_EMAIL_DOMAINS`. Configured,
   not hardcoded — the tenant has more than one verified domain
   (`peckhannafordbriggs.sharepoint.com` vs `@phb1899.com`), and the full list must
   be confirmed with IT.
3. **Guests rejected.** Any UPN containing `#EXT#`, or a mail domain outside the
   allow-list, is denied. B2B guests — vendors, consultants, outside estimators — have
   real accounts in the tenant. Single-tenant does not exclude them.
4. **Status.** Employee row must not be `disabled`.

A rejected login gets a plain "not authorized for this application" page. No detail.

### Self-provisioning

```
SSO success → gate checks pass
  → employee row exists?
      no  → create: entra_oid, email, names from token claims,
             zero grants, profile_completed = false
      yes → update last_login_at
  → profile_completed?
      no  → redirect to /onboarding (only reachable route besides sign-out)
      yes → continue
```

**Key on `entra_oid`, not email.** People get renamed; the object ID does not. The
`entra_oid` is captured on first sign-in and is immutable thereafter.

Anyone in the tenant can create a row by signing in. That is intended. A row with no
grants sees a shell with an empty sidebar and can reach nothing.

### Onboarding (profile completion)

This is profile completion, not account creation. The person is already
authenticated.

- **Email:** from the token, displayed **read-only**. Never user-editable. A
  user-entered email that disagrees with the authenticated identity is unresolvable.
- **First / last name:** prefilled from token claims, editable. Directory display
  names are often formatted badly or use legal names.
- **Position:** required, dropdown from the `positions` table, with "Other" revealing
  a free-text field that flags the row for admin cleanup.
- **Department:** required, dropdown from the `departments` table.

Both are informational only. Neither ever grants access — access comes from module
grants and the admin flag, nothing else.

### After onboarding

The two fields diverge once the profile exists.

| Field | Employee can change | Admin can change | Where |
|---|---|---|---|
| Position | **Yes** | Yes | `/profile` · `PATCH /api/me/position` — or admin, `PATCH /api/admin/employees/[id]/position` |
| Department | **No** | Yes | Admin only, `PATCH /api/admin/employees/[id]/department` |
| Email, name, status, admin flag | No | Status and admin flag only | Their own admin routes |

**Position stays self-reported and unverified.** Show it to admins as such — the free
text "Other" flags the row for cleanup. Both paths share one implementation, so an
admin's change and the employee's own change cannot disagree about what a valid
position is. Last write wins; the audit event records which of them it was.

**Department is admin-controlled.** It drives the admin employee filter, so an
employee setting their own would turn that filter into a record of what people call
themselves rather than of how the company is organised. There is deliberately **no
`/api/me/department`** — the absence of the route is the enforcement, not a flag
inside a shared one.

Fields nobody may change through a profile route — email, name, status, the admin
flag — are not declared on its schema. The schemas are strict objects, so sending one
is a `422`, not a `200` that quietly ignored it.

## Authorization

**Hiding a sidebar item is not authorization.**

Every request to `app/api/modules/<key>/*`:

```
Request
  → authenticated?           no → 401
  → session still valid?     no → 401   (see revocation below)
  → employee active?         no → 401
  → profile complete?        no → 403
  → has grant for <key>?     no → 404
  → execute
```

**404, not 403**, on a missing grant. Do not confirm the existence of modules the
person can't access.

### Module administrators (B7.2)

A grant can carry `is_module_admin`. It gates the module's *administrative*
surface - for `bas`, the Settings tab, which decides what gets collected.

```
Request to a module's admin surface
  → everything above                     → as normal
  → has grant for <key>?           no → 404
  → grant.is_module_admin?         no → 404
  → execute
```

| | Can | Cannot |
|---|---|---|
| BAS grant | See Collection Health and Point Explorer | Open Settings — 404, and the tab is not rendered |
| BAS grant + `is_module_admin` | Also open Settings | Reach `/admin`, grant anything, disable anyone |
| `is_platform_admin` | Grant module admin to others | Open Settings without being granted it — **404**, same as anyone |

**A platform admin gets no implicit module access**, here or anywhere:
`requireModuleAccess` has never had an `isPlatformAdmin` branch, and the admin
surface is not the place to introduce one. If it did, the audit row *"granted
BAS admin to Jake"* would stop describing everyone who can add a building.

**Hiding the tab is not authorization.** `visibleBasTabs` omits Settings for a
non-admin so the tab bar does not announce a surface the 404 conceals. The page
behind it calls `requireModuleAdmin` and so does every route it fetches.

### Rules

- **Grants are read from the database on every request.** Never baked into a session
  token or JWT claim. A cache of a few seconds is acceptable; anything longer means
  revocation doesn't take effect until sign-out.
- **The middleware is the security boundary.** The sidebar and the admin toggle are
  conveniences. A module route must reject an ungranted request even if no UI exists
  for it.
- **Never trust client-supplied roles, permissions, or employee IDs.**
- Authorization lives in one place (`lib/authz`). Services do not reimplement it.

### Revocation

Immediate, because grants are read live. For disabling a person or forcing re-auth,
`employees.sessions_valid_after` is bumped and any session issued before that
timestamp is rejected.

Deactivate, never delete — a deleted employee row orphans their audit history.

Entra is the outer backstop: when IT disables someone's account, SSO stops working
regardless of platform state.

## Admin

Admin is privileged functionality, protected server-side. Hiding the nav item is not
protection.

Admin-only operations: granting and revoking module access, enabling/disabling
employees, managing the admin flag, managing the positions and departments lists, and
setting any employee's department or position.

Admins do **not** create employees. There is no create-employee endpoint.

### Guardrails

- An admin cannot remove their own admin flag.
- The system refuses any change that would leave zero active admins.
- An admin cannot disable their own account.

Without these, one wrong click needs database access to undo.

### Bootstrap

`BOOTSTRAP_ADMIN_EMAIL` is a **comma-separated list**, the same shape as
`ALLOWED_EMAIL_DOMAINS`. Every address on it is seeded as a platform admin at deploy
time. Every admin after those is made in the UI.

Each seeded row has `entra_oid` null, `is_platform_admin` true and
`profile_completed` false. The row exists before its owner does anything; their first
sign-in finds it by email, stamps the Entra object ID onto it, and does **not**
create a second row. Someone on the list who signs in before the seed has run gets
the flag at provisioning instead — both paths are covered.

**Re-running the seed is idempotent, and deliberately not a reset.**

| Situation | What the seed does |
|---|---|
| No row for the address | Creates it as an admin |
| Row exists and is an admin | Nothing |
| Row exists, demoted through the UI, other active admins remain | **Nothing** — the demotion was a decision, and a deploy must not undo it |
| Row exists, demoted, and **no active admin remains anywhere** | Promotes it — this is the lockout the list exists for |

That last row is the recovery path in `runbook.md`. Only the admin flag is
touched: a disabled account stays disabled, because re-enabling one is a decision for
a person rather than for a deploy. If the only bootstrap admin is also disabled, use
the direct SQL in the runbook.

Nothing in the seed ever resets a name, an email, a status, or a completed profile.

## Deferred — do not build

- **Roles.** There is no role system. There is `is_platform_admin` and there are
  module grants. Do not add a `roles` field to the session context.
- ~~**Per-module admins.**~~ **Implemented 8 September 2026 (B7.2).** Reversed
  deliberately, and this line is kept rather than deleted so the reversal is
  visible. `module_grants.is_module_admin` carries administrative rights over
  ONE module; `requireModuleAdmin(key)` checks it and denies with **404**, the
  same as a missing grant, because a module's administrative surface is a
  surface. It is a column on the grant row, so revoking access revokes admin
  rights in the same statement. It is still **not** a role system: there is no
  list of permissions, no role table, and nothing in the session context.
  See below.
- **Group-based grants** mapped to Entra security groups. Worth revisiting past ~50
  employees.
