# Phase 1 — Platform Foundation

Read `CLAUDE.md` first. This file defines **what to build**. `CLAUDE.md` and `docs/`
define **how**, and override anything here on architecture.

---

## Goal

A deployable Next.js application where a PH+B employee signs in with their Microsoft
account, completes a short profile, and sees a sidebar containing only the modules an
admin has granted them. An admin can grant and revoke access. The authorization check
is enforced on the backend and provably rejects ungranted requests.

**No Microsoft Graph calls. No Claude API calls. No mailbox access of any kind.**
Change Orders is a placeholder page in this phase.

---

## In scope

1. Project setup — Next.js 15 App Router, TypeScript strict, Tailwind, Prisma,
   Vitest, ESLint, `.env.example`
2. Postgres schema and migrations per `docs/05-database-and-sources.md`
3. Seed script — the `change-orders` module row, positions, departments, bootstrap
   admin
4. Entra ID SSO via Auth.js with the four-check login gate
5. Self-provisioning on first sign-in
6. Onboarding / profile completion flow
7. Authorization layer and route middleware
8. Platform shell — persistent sidebar rendered from grants
9. Placeholder pages — Home, Change Orders
10. Admin screen — employee list, detail, grant toggles, enable/disable, admin flag
11. Audit event writing for all Phase 1 actions
12. Structured logging, error handling, error boundaries
13. `README.md` (local setup) and `docs/runbook.md` (first entries)

## Out of scope

Anything Graph or mail related. Azure deployment. Real dashboard content. Roles.
Group-based grants. Per-module admins. Email actions. Job scheduler. Prompt storage.

---

## Login gate

All four checks, in `lib/auth`. Any failure → a plain "not authorized for this
application" page with no detail.

1. Token `tid` equals `AUTH_MICROSOFT_ENTRA_ID_TENANT_ID`
2. Verified email domain is in `ALLOWED_EMAIL_DOMAINS` (comma-separated env var)
3. UPN does not contain `#EXT#`
4. Employee row, if it exists, is not `disabled`

Write an `login.denied` audit event on rejection, with the reason in metadata. Do not
create an employee row for a rejected sign-in.

## Self-provisioning

On successful sign-in with no matching employee row: create one from token claims —
`entraOid`, lowercased `email`, `firstName`, `lastName` — with `profileCompleted =
false` and **zero grants**. Audit `employee.provisioned`.

If a row exists with a null `entraOid` and a matching email, stamp the `entraOid` and
keep the row. Once set, `entraOid` is never changed.

Update `lastLoginAt` on every sign-in.

## Onboarding

While `profileCompleted` is false, every route except `/onboarding` and sign-out
redirects to `/onboarding`.

Form:

| Field | Behavior |
|---|---|
| Email | From the session, rendered **read-only / disabled**. Never accepted from the request body. |
| First name | Prefilled from claims, editable, required |
| Last name | Prefilled from claims, editable, required |
| Position | Required. Dropdown from active `Position` rows, plus "Other" which reveals a required free-text field written to `positionOther` |
| Department | Required. Dropdown from active `Department` rows |

On submit: validate server-side, set `profileCompleted = true`, audit
`employee.profile_completed`, redirect to `/`.

The server handler must ignore any `email`, `status`, or `isPlatformAdmin` field in the
request body.

## Authorization

`lib/authz` exposes a single guard used by every module route. Order:

```
authenticated?                      no → 401
session issued before
  employee.sessionsValidAfter?      yes → 401
employee.status === 'active'?       no → 401
employee.profileCompleted?          no → 403
grant exists for <moduleKey>?       no → 404
→ proceed
```

Grants are loaded from the database per request. They must not appear in the JWT or
session cookie. A cache of a few seconds is acceptable; longer is not.

`404` on a missing grant, not `403`.

An equivalent server-side check gates module pages, not only API routes.

## Shell

Persistent left sidebar:

```
PHB

  Home

SYSTEMS
  Change Orders        ← only if granted

ADMIN
  Admin                ← only if isPlatformAdmin
```

The SYSTEMS section renders by querying active `Module` rows joined to the employee's
grants, ordered by `sortOrder`. No hardcoded module list anywhere in the UI.

Home and Change Orders are placeholders — a heading and a sentence. Do not invent
dashboard content.

## Admin screen

**Employee list:** name, email, position (marked *self-reported*), department, status,
last sign-in, and a column per active module showing granted/not.

Search by name or email. Filter by module, status, and department. Paginate.
Default filter: employees with at least one grant, with a toggle to show everyone —
the table will accumulate anyone who ever signed in.

**Employee detail:** profile fields, a toggle per module, enable/disable, admin flag,
and that employee's audit history.

Multi-select on the list for bulk grant and bulk revoke.

**Guardrails — enforce server-side, not just in the UI:**

- An admin cannot remove their own admin flag
- An admin cannot disable their own account
- Any change that would leave zero active admins is rejected
- There is **no create-employee endpoint**

Every action writes an audit event with the acting admin's ID.

Positions and departments are admin-editable (add, rename, hide). Hiding must not
break employees already assigned to that value.

## API surface

```
GET    /api/me
POST   /api/onboarding

GET    /api/admin/employees                       list, search, filter, paginate
GET    /api/admin/employees/:id
POST   /api/admin/employees/:id/grants            { moduleKey }
DELETE /api/admin/employees/:id/grants/:moduleKey
POST   /api/admin/employees/:id/status            { status }
POST   /api/admin/employees/:id/admin-flag        { isPlatformAdmin }
POST   /api/admin/grants/bulk                     { employeeIds[], moduleKey, action }
GET    /api/admin/positions        POST / PATCH
GET    /api/admin/departments      POST / PATCH
GET    /api/admin/audit                           filter by target, actor, action

GET    /api/modules/change-orders/ping             grant-gated stub
```

`/api/me` returns the employee, `profileCompleted`, granted module keys, and
`isPlatformAdmin`. It is the only source the sidebar uses.

`/api/modules/change-orders/ping` exists solely to prove the guard works. It returns
`{ data: { ok: true } }` and touches nothing.

Every `/api/admin/*` route independently verifies `isPlatformAdmin`.

---

## Acceptance criteria

Phase 1 is done when every line below is verified. Automated where marked; otherwise
document the manual steps and what was observed.

**Setup**
- [ ] `npm install && npx prisma migrate dev && npm run seed && npm run dev` works from
      a clean clone with only `.env.example` copied and filled
- [ ] `npm run build`, `npm run typecheck`, `npm run lint` all pass
- [ ] `npm test` passes
- [ ] No secret appears in any committed file

**Authentication** *(manual, documented)*
- [ ] A `@phb1899.com` account signs in successfully
- [ ] Sign-in with a wrong `tid` is rejected
- [ ] Sign-in with an out-of-allow-list domain is rejected
- [ ] A UPN containing `#EXT#` is rejected
- [ ] A rejected sign-in creates **no** employee row and writes `login.denied`
- [ ] A disabled employee cannot sign in

**Provisioning and onboarding**
- [ ] First sign-in creates an employee row with zero grants *(automated)*
- [ ] A new employee is redirected to `/onboarding` from any route *(automated)*
- [ ] The email field cannot be changed — posting a different email is ignored
      *(automated)*
- [ ] Submitting an incomplete profile fails validation server-side *(automated)*
- [ ] After completion, the employee reaches Home and the sidebar shows no systems
      *(automated)*

**Authorization — the tests that matter**
- [ ] Unauthenticated `GET /api/modules/change-orders/ping` → `401` *(automated)*
- [ ] Authenticated, **no grant** → `404` *(automated)*
- [ ] Authenticated, grant present → `200` *(automated)*
- [ ] Revoking the grant makes the next request `404` **without signing out**
      *(automated)*
- [ ] Disabling the employee makes the next request `401` without signing out
      *(automated)*
- [ ] Navigating directly to `/change-orders` without a grant does not render the
      module *(automated)*
- [ ] A non-admin gets `403` from every `/api/admin/*` route *(automated)*

**Admin**
- [ ] Grant and revoke work and take effect on the target's next request *(automated)*
- [ ] Bulk grant and bulk revoke work *(automated)*
- [ ] An admin cannot remove their own admin flag *(automated)*
- [ ] An admin cannot disable themselves *(automated)*
- [ ] The last active admin cannot be demoted or disabled *(automated)*
- [ ] No endpoint exists that creates an employee *(automated — assert 404/405)*
- [ ] Search, filters, and pagination work with 100+ seeded employees *(automated)*

**Audit**
- [ ] Every Phase 1 action writes an event with actor, target, and timestamp
      *(automated)*
- [ ] Audit rows cannot be updated or deleted through any endpoint *(automated)*

**Documentation**
- [ ] `README.md` covers local setup, env vars, migrations, seeding, tests
- [ ] `docs/runbook.md` exists with entries for: SSO misconfiguration, a locked-out
      admin, a failed migration, and a database connection failure
- [ ] `.env.example` lists every variable with no real values

---

## Notes for the implementer

**Build the authorization guard and its negative tests before the admin UI.** The
screen is a convenience; the guard is the security boundary. If the ungranted request
returns data, the toggle is decoration.

**Seed realistically.** 100+ fake employees, a handful granted, some disabled, some
with incomplete profiles. Search and pagination bugs only appear at volume.

**`PHB_ALLOW_SEND` belongs in `.env.example` now, set to `false`,** even though
nothing reads it in this phase. It should exist before the code that needs it.

**Stop and ask** if a task appears to require Graph access, a new npm dependency of
any significance, a schema change beyond `docs/05`, or anything that conflicts with
`CLAUDE.md`.
