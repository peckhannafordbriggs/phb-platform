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
| Runbook SQL | `psql -f` | Every query in `docs/runbook.md` executed against the live schema |

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

### 3. Out-of-allow-list domain is rejected — NOT YET RUN

Reproducible by temporarily setting `ALLOWED_EMAIL_DOMAINS` to a value excluding
`phb1899.com` and signing in again, which drives the real gate with a real
Microsoft token.

**Covered automatically** by `tests/gate.test.ts` — "rejects a domain outside the
allow-list".

### 4. A UPN containing `#EXT#` is rejected — NOT REPRODUCIBLE MANUALLY

Requires a B2B guest account in the tenant that someone can sign in as. None was
available.

**Covered automatically** by `tests/gate.test.ts` — `#EXT#` in `upn`, `#EXT#` in
`preferred_username`, and a lowercase `#ext#` variant — and by
`tests/onboarding.test.ts`, which asserts a rejected guest creates no employee
row.

### 5. A rejected sign-in creates no employee row and writes `login.denied` — NOT YET RUN

To be observed alongside criterion 3.

**Covered automatically** by `tests/onboarding.test.ts`, which asserts both
halves for a tenant mismatch and for a guest.

### 6. A disabled employee cannot sign in — NOT YET RUN

Reproducible by disabling the employee row directly in SQL — the admin
guardrails correctly refuse self-disable — then attempting sign-in, then
re-enabling.

**Covered automatically** by `tests/onboarding.test.ts` — "rejects a disabled
employee and creates nothing" — and by `tests/authz.test.ts`, which proves a
disabled employee's next request returns 401 without signing out.

---

## Honest summary

One of six manual authentication criteria has been observed end to end.
Two are not reproducible on this tenant. Three remain to be run.

Every one of the six is covered by an automated test exercising the same code
path. The untested link for criteria 2 and 4 is whether Entra actually issues
such a token — Microsoft's behavior, not this codebase's.
