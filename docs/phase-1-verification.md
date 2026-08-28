# Phase 1 verification record

What was verified, how, and what was observed. `docs/07-conventions.md` requires
manual checks to be documented rather than merely ticked.

Last updated **14 August 2026**.

---

## Automated

Run from a clean working tree against PostgreSQL 17 installed natively.

| Check | Command | Result |
|---|---|---|
| Test suite | `npm test` | **62 passed**, 5 files |
| Types | `npm run typecheck` | Clean |
| Lint | `npm run lint` | Clean |
| Build | `npm run build` | 25 routes, exit 0 |
| Migrations | `npx prisma migrate deploy` | Both applied, to the development and test databases |
| Seed | `npm run seed` | 1 module, 9 positions, 7 departments, bootstrap admin |
| Dev seed | `npm run seed:dev` | 130 employees — 14 disabled, 13 incomplete, 11 free-text position, 6 grants |
| Runbook SQL | `psql -f` | Every query in `runbook.md` executed against the live schema |

The tests run against a real database. The only mocked thing is `auth()`, so a
test can act as a given employee; every query, guard and route handler in the
path is the real one.

---

## Manual — authentication

The six criteria in `PHASE-1.md` under **Authentication**.

### 1. A `@phb1899.com` account signs in successfully — PASS

**Observed, 14 August 2026.** Signed in at `http://localhost:3000` as
`msheth@phb1899.com` against SSO app registration
`220921c1-f23e-4d01-b354-736884ba3d00`. Landed on `/onboarding`, completed the
form, reached Home and then the admin screen.

Database state afterwards:

- `entra_oid` stamped onto the **existing** seeded bootstrap row — real employee
  rows stayed at 1, so no duplicate was created
- `is_platform_admin` survived the stamp
- `last_login_at` set
- **No** `employee.provisioned` event — correct: that row was seeded, not
  self-provisioned
- `employee.profile_completed` written, actor and target both the employee,
  metadata `{"usedFreeTextPosition": true}`
- Position saved as free text `CS Co-Op Intern` with `position_id` null

Incidentally exercised in the same session: `grant.added` then `grant.removed`
against a seeded employee from the admin UI, both recording the acting admin as
actor.

### 2. Sign-in with a wrong `tid` is rejected — NOT REPRODUCIBLE MANUALLY

The app registration is single-tenant, so Entra will not issue a token carrying
a different `tid` for this client. Producing one requires a second tenant, which
PH+B does not have.

**Covered automatically** by `tests/gate.test.ts` — "rejects a token from another
tenant" and "rejects a token with no tenant claim at all" — and by
`tests/onboarding.test.ts`, which asserts a tenant mismatch writes `login.denied`
and creates no employee row.

Retest properly if a second tenant ever becomes available.

### 3. Out-of-allow-list domain is rejected — PASS

**Observed, 14 August 2026.** `ALLOWED_EMAIL_DOMAINS` was temporarily set to
`example.invalid`, the dev server restarted, and a real sign-in attempted as
`msheth@phb1899.com`. Microsoft authenticated normally — it knows nothing about
the platform's allow-list — and the gate then rejected the token. The plain
"Not authorized for this application" page appeared, with no indication of which
check failed.

`ALLOWED_EMAIL_DOMAINS` was restored to `phb1899.com` immediately afterwards.

This is the strongest of the manual checks: it drives the real gate with a real
Microsoft-issued token rather than a synthetic claim set.

### 4. A UPN containing `#EXT#` is rejected — NOT REPRODUCIBLE MANUALLY

Requires a B2B guest account in the tenant that someone can sign in as. None was
available.

**Covered automatically** by `tests/gate.test.ts` — `#EXT#` in `upn`, `#EXT#` in
`preferred_username`, and a lowercase `#ext#` variant — and by
`tests/onboarding.test.ts`, which asserts a rejected guest creates no employee
row.

### 5. A rejected sign-in creates no employee row and writes `login.denied` — PASS

**Observed, 14 August 2026**, from the criterion 3 attempts.

- Three `login.denied` events, each with metadata
  `{"reason": "domain_not_allowed", "email": "msheth@phb1899.com"}`
- `target_employee_id` **NULL** on all three
- Employee rows unchanged: 131 total, 1 real — nothing created
- No `employee.provisioned` event
- The existing row was not touched at all: `last_login_at` still read
  `20:02:03` from criterion 1, so the gate rejects before any write

### 6. A disabled employee cannot sign in — PASS

**Observed, 14 August 2026.** The employee row was set to `status = 'disabled'`
directly in SQL — the admin guardrails correctly refuse self-disable through the
UI — and a real sign-in attempted. Rejected with the same undifferentiated page.

- `login.denied` written with `reason: employee_disabled`
- `target_employee_id` **set**, pointing at the employee row
- `last_login_at` not bumped
- The account was re-enabled immediately afterwards and confirmed `active`,
  `is_platform_admin`, `profile_completed`, with `entra_oid` intact

**Worth noting:** `employee_disabled` carries a `target_employee_id` while
`domain_not_allowed` leaves it NULL. That is deliberate — the platform links an
audit event to a row only when the identity is already known. A rejected
stranger creates nothing to point at.

---

## Honest summary

| # | Criterion | Status |
|---|---|---|
| 1 | Company account signs in | **PASS** — observed |
| 2 | Wrong `tid` rejected | Not reproducible — needs a second tenant |
| 3 | Out-of-allow-list domain rejected | **PASS** — observed |
| 4 | `#EXT#` UPN rejected | Not reproducible — needs a B2B guest account |
| 5 | Rejected sign-in → no row, `login.denied` written | **PASS** — observed |
| 6 | Disabled employee cannot sign in | **PASS** — observed |

Four of six observed end to end against real Microsoft-issued tokens. Two are
not reproducible on a single-tenant registration with no guest accounts.

All six are covered by automated tests exercising the same code path. For 2 and
4 the only untested link is whether Entra actually issues such a token — that is
Microsoft's behavior, not this codebase's. Retest both if a second tenant or a
guest account becomes available.
