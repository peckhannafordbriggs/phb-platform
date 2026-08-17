# Runbook

Failure modes, what they look like, and what to do. Written during each phase,
not after.

Assume the reader has never seen this codebase. The current operator leaves in
December 2026.

**Nothing in this file touches the existing change-order system.** The platform
reads the mailbox through Graph and never touches the flows. Do not restart,
re-authorize, or edit a Power Automate flow while diagnosing a platform
problem — they are unrelated.

---

## The mailbox is not connected

**Symptom.** `GET /api/modules/change-orders/mailbox/health` returns `200` with

```json
{ "data": { "configured": false, "missing": ["GRAPH_CLIENT_ID", "GRAPH_TENANT_ID"], "folders": [] } }
```

**This is not a failure.** It is the deliberate answer when no Graph credential
is configured. The platform boots, signs people in, and serves the admin screen
in exactly this state — the Graph variables are *not* part of the boot-time
environment check, so a missing credential degrades the Change Orders module and
nothing else.

**Fix.** Set the variables named in `missing`. They are, in full:

| Variable | Where | Notes |
|---|---|---|
| `GRAPH_CLIENT_ID` | everywhere | The Graph app registration, **not** the SSO one |
| `GRAPH_TENANT_ID` | everywhere | The PH+B tenant |
| `GRAPH_CLIENT_SECRET` | local development **only** | Refused outright in production — see below |
| `GRAPH_MANAGED_IDENTITY_CLIENT_ID` | Azure only, optional | Omit to use the system-assigned identity |
| `CO_MAILBOX` | everywhere | `changeorder@phb1899.com` |

Restart after changing them: Next.js reads `.env.local` at boot, and the token
cache and Graph client are memoised per process.

`missing` names variables, never values. A blank variable (`GRAPH_CLIENT_ID=""`)
counts as absent rather than malformed, which is why `.env.example` can ship them
empty.

---

## The mailbox health endpoint fails

Every response below carries a non-technical message; the specific `code` and the
server log are where the diagnosis is. All of them are `500` except `not_found` —
`docs/07-conventions.md` fixes the status set, so integration failures are
distinguished by `code`, not by status.

| `code` | Log `outcome` | Cause | Fix |
|---|---|---|---|
| `mail_not_configured` | `not_configured` | No credential, or `GRAPH_CLIENT_SECRET` set in production. | See above. |
| `mail_auth_failed` | `auth_failed` | Entra refused a token. Locally: expired or wrong `GRAPH_CLIENT_SECRET` (`AADSTS7000215`). In Azure: no managed identity assigned, or the federated identity credential is missing from the app registration. | Rotate the local secret; in Azure check the identity assignment. |
| `mail_access_denied` | `mailbox_forbidden` | **Almost always the ApplicationAccessPolicy.** Graph returned 403. | See the next section. |
| `mail_busy` | `throttled` | Graph throttled us and the single retry also failed. | Wait. Do not add retries — see below. |
| `mail_unreachable` | `network` | The request never got an answer. Outbound network or DNS. | Check egress from the container app. |
| `not_found` (404) | `not_found` | The folder or message is gone. Power Automate moves messages constantly, which is why every request sends `Prefer: IdType="ImmutableId"`. | Re-read the folder listing; the ID was captured before a move. |

The log line is `"event":"mail.graph_call_failed"`, and its `reason` field carries
`operation`, `status`, `code` and Microsoft's `requestId`. **Quote the
`requestId` when opening a ticket with Microsoft.** The response body and the
access token are never logged.

---

## `mail_access_denied` — the access policy

**Symptom.** Authentication succeeds, then every mailbox read returns
`mail_access_denied` / a Graph 403.

**Cause.** The Graph app registration holds `Mail.ReadWrite` and `Mail.Send` as
**application** permissions, which reach every mailbox in the company unless an
Exchange **ApplicationAccessPolicy** restricts them to a mail-enabled security
group containing only `changeorder@phb1899.com`. A 403 means the policy is
denying the mailbox — or is denying *everything* because it was scoped wrongly.

**Two things that look identical and are not.**

- The policy applies and is correct → reads succeed.
- The policy silently did not apply → reads succeed **against every mailbox in
  the company**.

The second is the dangerous one, and it does not announce itself. That is why
Part B of Phase 4 includes reading a *different* mailbox with the same credential
and confirming a 403. IT's `Test-ApplicationAccessPolicy` output is their
verification; that read is ours.

**Also note:** an access policy change can take **up to an hour** to propagate.
A 403 immediately after IT reports the policy is in place may simply be early.
Re-check before escalating.

---

## Graph throttling

**Symptom.** `mail_busy`, and a log line `"event":"graph.throttled"` with
`outcome: retrying_once`.

**Expected behavior.** A throttled request (`429`, `503`, `504`) is retried
**exactly once**, after the delay Graph asks for in `Retry-After`, capped at 30
seconds. A second failure is surfaced to the caller.

**Do not raise the retry count.** Throttling here concentrates on one mailbox
through one app identity — roughly 10k requests per 10 minutes, about 4
concurrent in practice. Retrying harder makes the throttle deeper and longer.
If this becomes common, the cause is a polling interval that is too aggressive,
not a retry count that is too low.

---

## Nothing sends, and that is correct

**Symptom.** An attempt to send returns `mail_send_disabled`, with
`"event":"mail.send_blocked"` in the log.

**Cause.** `PHB_ALLOW_SEND` is not exactly the string `"true"`. `TRUE`, `True`,
`1` and `yes` all leave the gate shut, deliberately.

**This is the safety model, not a bug.** `CLAUDE.md` prohibition 1: nothing in
this system sends automatically, in any phase. Every outbound message is an
unsent draft that a human opens and sends. `sendMail` appears zero times across
all 11 Power Automate flows and zero times in this codebase — a test asserts the
second half of that.

**Do not set `PHB_ALLOW_SEND=true` outside production.** Development runs against
the live `changeorder@phb1899.com` mailbox and there is no test mailbox. A send
cannot be undone; everything else can.

---

## A write was refused outside production — `mail_write_disabled`

**Symptom.** A draft edit, move or delete fails with `mail_write_disabled` and
`"event":"mail.write_blocked"`.

**Cause.** Outside production, write operations are permitted only on messages
whose subject **begins with** `ZZTEST`. Contains-anywhere is not enough — a
vendor could otherwise name a real message so the platform would write to it.

The subject is read from Exchange at the moment of the check, not taken from the
caller, so passing `"ZZTEST"` in as an argument does not open the fence.

**Fix.** To exercise a write path in development, create a message in the mailbox
whose subject starts with `ZZTEST`. Do not disable the guard.

---

## Nobody can sign in — "not authorized for this application"

**Symptom.** Everyone reaches the sign-in button, gets bounced to Microsoft,
comes back, and lands on a page reading *"Not authorized for this application"*
with no further detail. The page is intentionally silent about the reason.

> **A note on SQL in this file.** Tables and columns are all snake_case, so no
> query here needs quoted identifiers. Copy them as-is.

**Where the reason actually is.** Two places, both server-side:

1. The `audit_events` table:
   ```sql
   SELECT occurred_at, metadata
   FROM audit_events
   WHERE action = 'login.denied'
   ORDER BY occurred_at DESC
   LIMIT 20;
   ```
   `metadata.reason` is one of `tenant_mismatch`, `domain_not_allowed`,
   `guest_account`, `missing_claims`, `employee_disabled`.
2. The application log — a JSON line with `"event":"signin.denied"`.

**Causes and fixes, by reason.**

| Reason | Cause | Fix |
|---|---|---|
| `tenant_mismatch` | `AUTH_MICROSOFT_ENTRA_ID_TENANT_ID` does not match the tenant issuing the token. Usually a wrong or empty value in the environment. | Set it to the PH+B tenant ID and restart. |
| `domain_not_allowed` | The person's verified email domain is not in `ALLOWED_EMAIL_DOMAINS`. The tenant has more than one verified domain. | Confirm the full list with IT, then add it — comma-separated, no `@`. |
| `guest_account` | The account is a B2B guest; its UPN contains `#EXT#`. Vendors, consultants and outside estimators have real accounts in the tenant. | Working as intended. Guests do not get platform access. |
| `missing_claims` | The token has no `oid` or no usable email. Almost always a missing optional claim on the app registration. | In the SSO app registration, ensure the token includes `oid`, `email`/`preferred_username`, `tid`. |
| `employee_disabled` | An admin disabled this person. | Re-enable them in Admin → the employee → Enable account. |

**If nothing is logged at all**, the request never reached the gate — see *SSO is
misconfigured* below.

---

## SSO is misconfigured

**Symptom.** The Microsoft sign-in page shows an `AADSTS…` error, or the browser
returns to the platform on an error URL, and **no `login.denied` row is
written**. The gate never ran.

**Cause and fix, by AADSTS code.**

| Code | Cause | Fix |
|---|---|---|
| `AADSTS50011` | Redirect URI mismatch. | Register the exact callback on the SSO app registration: `http://localhost:3000/api/auth/callback/microsoft-entra-id` locally, and the deployed origin plus that same path in Azure. It must match character for character, including scheme and port. |
| `AADSTS7000215` | Invalid client secret. | Local development only — regenerate the secret and put it in `.env.local`. Production must not use a secret at all; it uses a managed identity. |
| `AADSTS700016` / `AADSTS90002` | Wrong client ID or tenant ID. | Check `AUTH_MICROSOFT_ENTRA_ID_ID` and `AUTH_MICROSOFT_ENTRA_ID_TENANT_ID`. |
| `AADSTS65001` | Admin consent not granted. | Have a tenant admin consent to the SSO app registration. |

**Also check:** `AUTH_SECRET` is set. Without it Auth.js cannot decrypt its own
session cookie, and sign-in appears to succeed and then immediately loop back to
`/signin`.

**Do not** merge the SSO app registration with the Graph mail app registration
(Phase 4). They are separate on purpose.

---

## What expires, and when

| Credential | Where | Expires | Breaks what |
|---|---|---|---|
| SSO client secret | `AUTH_MICROSOFT_ENTRA_ID_SECRET` in `.env.local` | **13 August 2028** | Local development only |
| Graph client secret | `GRAPH_CLIENT_SECRET` in `.env.local` | *recorded when the app registration exists* | Local development only |

Nothing in Azure expires. Both secrets above exist solely because a developer
machine cannot use a managed identity.

For the Graph credential this is enforced in code, not by convention:
`createGraphCredential` in
`lib/modules/change-orders/graph/credential.ts` **throws** if
`GRAPH_CLIENT_SECRET` is set while `NODE_ENV=production`. Production authenticates
with a managed identity plus a federated identity credential, so an expiring
Graph secret can only ever affect a developer machine. If one ever appears to
break production, the fault is that a secret was deployed at all — fix that, do
not rotate it.

**Graph app registration** — client ID, tenant ID and secret expiry date to be
recorded here once IT creates it (Phase 4 Part B). It is a **second, separate**
registration from the SSO one; do not merge them.

**SSO app registration** — client ID `220921c1-f23e-4d01-b354-736884ba3d00`,
tenant `48f37f84-1c36-4b3e-986c-b8b7196ad49d`. Neither is a secret; both appear
in every authorization URL the app generates. They are recorded here so the next
operator can find the right registration without guessing.

### This secret must never reach Azure

`CLAUDE.md` prohibition 7: no credential that expires may exist in production.
Production authenticates with a **managed identity plus a federated identity
credential**, which does not expire. The client secret exists solely because
local development cannot use a managed identity.

So when this expires on 13 August 2028, **production is unaffected** — only
developer machines stop being able to sign in. If an expiring secret ever *does*
break production, the real fault is that a secret was deployed at all; fix that,
do not rotate it.

### Symptom when it expires

Sign-in fails at Microsoft with `AADSTS7000215: Invalid client secret provided`,
before the platform's login gate runs. Nothing is written to `audit_events`,
because no token ever reached the application.

### Rotating it

1. Azure portal → Microsoft Entra ID → App registrations → the SSO registration
   (client ID above) → **Certificates & secrets** → **New client secret**.
2. Copy the **Value**, not the Secret ID. The value is shown once.
3. Put it in `.env.local` as `AUTH_MICROSOFT_ENTRA_ID_SECRET`.
4. Restart the dev server — Next.js reads `.env.local` at boot.
5. Delete the expired secret from the registration.

**Never commit it.** `.env.local` is gitignored; keep it that way.

### Before 13 August 2028

Set a calendar reminder for roughly a month ahead. Ownership of the app
registration must sit with an M365 group, not a person — prohibition 6 — so the
reminder should go to that group, not to an individual who may have left.

---

## The only admin is locked out

**Symptom.** Nobody can reach `/admin`. The sidebar shows no Admin item for
anyone, and `/api/admin/*` returns `403` for everyone.

**How this happens.** It should not. Three guardrails prevent it server-side: an
admin cannot remove their own admin flag, cannot disable their own account, and
no change may leave zero active admins. It is still reachable by direct database
edits, by restoring an old database backup, or by the bootstrap admin never
having signed in.

**Fix — preferred.** Set `BOOTSTRAP_ADMIN_EMAIL` and re-run the seed. It is
idempotent and will promote the matching employee row:

```bash
npm run seed
```

That row keeps `entra_oid = NULL` until its owner signs in for the first time,
at which point the object ID is stamped onto the existing row.

**Fix — direct, when the seed is not available.**

```sql
UPDATE employees
SET is_platform_admin = true, status = 'active'
WHERE email = 'someone@phb1899.com';
```

Then record why, because this bypasses the audit trail:

```sql
INSERT INTO audit_events (id, action, target_employee_id, metadata, occurred_at)
SELECT gen_random_uuid(),
       'employee.admin_granted',
       id,
       '{"reason":"manual recovery - locked out","actor":"direct database edit"}'::jsonb,
       now()
FROM employees WHERE email = 'someone@phb1899.com';
```

A null `actor_employee_id` means the platform acted rather than a person, which
is the honest record for a manual recovery.

**Do not** delete the employee row and let them sign in again. Deleting an
employee is refused by the database (see below), and it would orphan their audit
history.

---

## A migration fails

**Symptom.** `npx prisma migrate dev` or `migrate deploy` exits non-zero. The
`_prisma_migrations` table shows a row with `finished_at` null and
`rolled_back_at` null — the migration is stuck half-applied.

**First: do not edit the database by hand to "help it along".** That desynchronises
the migration history from the schema and every later migration fails in a more
confusing way.

**Diagnose.**

```bash
npx prisma migrate status
```

**Common causes.**

| Cause | What you will see | Fix |
|---|---|---|
| The database user lacks privileges | `permission denied for schema public` | Grant ownership of the database to the application user. |
| A unique index cannot be created | `could not create unique index … duplicate key` | Existing rows violate the new constraint. Find and fix the duplicates, then re-run. |
| Drift between schema and database | `Drift detected` | Someone changed the schema by hand. In development, `npx prisma migrate reset` (destroys data). In production, write a corrective migration — never reset. |
| The migration was interrupted | A row in `_prisma_migrations` with `finished_at` null | See below. |

**Resolving a stuck migration.**

```bash
# The SQL did apply; the process died before recording it:
npx prisma migrate resolve --applied 20260814000100_audit_append_only

# The SQL did not apply, or applied partially and you have reverted it by hand:
npx prisma migrate resolve --rolled-back 20260814000100_audit_append_only
```

Then re-run `npx prisma migrate deploy`.

**Never** run `migrate reset` against production. It drops every table.

---

## Deployment: check this when the Azure database is created

**Verify the collation before anything is loaded into it.** Changing a database's
collation afterwards is a dump and restore, not a setting.

```sql
SELECT datcollate, datctype FROM pg_database WHERE datname = current_database();
```

Expect a locale-aware collation — `en_US.utf8` is the Azure Database for PostgreSQL
Flexible Server default and is correct. **`C` or `POSIX` is wrong for this
application.**

**Why it matters.** Every list of departments and positions — the onboarding
dropdowns, the admin list editor, the admin employee filter — is ordered with
`ORDER BY name ASC`, so the ordering is whatever the database's collation says. A
locale-aware collation compares letters and ignores case at the first level. `C` and
`POSIX` compare raw bytes, where every uppercase letter sorts before every lowercase
one.

The department list makes the difference visible:

| Collation | Order |
|---|---|
| `en_US.utf8`, `English_United States.1252` | Administrative, **AI**, Controls, … |
| `C`, `POSIX` | **AI**, Administrative, Controls, … |

`AI` and `VDC` are the ones to look at — an all-caps name is where byte ordering
stops matching what a person expects. It is cosmetic, not a data problem, but it is
the kind of thing that gets reported as "the list is in a weird order" and takes an
afternoon to trace back to the database.

**Confirm it with the actual values rather than reading the collation name:**

```sql
SELECT name FROM (VALUES ('Administrative'), ('AI')) AS t(name) ORDER BY name;
```

`Administrative` must come first.

**If it is wrong.** Before go-live, drop and recreate the database with an explicit
collation — cheapest by far:

```sql
CREATE DATABASE phb_platform
  LC_COLLATE = 'en_US.utf8'
  LC_CTYPE   = 'en_US.utf8'
  TEMPLATE   = template0;
```

After go-live it is a `pg_dump` / `pg_restore` into a correctly created database.
Do not instead patch the application's `ORDER BY` clauses: Prisma cannot express a
per-query `COLLATE`, so it would mean raw SQL in five places to work around one
database setting.

---

## The database is unreachable

**Symptom.** Every page returns the generic error boundary. The log carries
`"event":"admin.route_failed"` or a Prisma error, and the message names one of
the codes below.

| Error | Cause | Fix |
|---|---|---|
| `P1000: Authentication failed` | Wrong username or password in `DATABASE_URL`. | Verify with `psql` directly: `psql -U postgres -h localhost -d postgres -c "select 1"`. If `psql` also fails, the credential is wrong — not the application. If the password contains `@ : / ? # [ ] %` or a space, it must be percent-encoded in the URL. |
| `P1001: Can't reach database server` | Postgres is not running, or is not listening on the configured host and port. | On Windows: `Get-Service postgresql*` and start it. Confirm the port with `psql -p 5432`. |
| `P1003: Database does not exist` | The database was never created. Migrations do not create it. | `createdb phb_platform` (and `phb_platform_test`). |
| `P2024: Timed out fetching a connection` | The pool is exhausted. In development this is usually a dev-server reload leak. | The client is cached on `globalThis` in non-production for exactly this reason — see `lib/db/client.ts`. If it recurs in production, raise the pool size or look for a query that never finishes. |
| `too many clients already` | Postgres `max_connections` reached across all applications. | Reduce the pool, or raise `max_connections` and restart Postgres. |

**Health check, fastest path:**

```bash
psql "$DATABASE_URL" -c "select count(*) from employees;"
```

If that works and the application still cannot connect, the application is
reading a different `DATABASE_URL` than you are — check `.env.local` versus the
deployed configuration.

---

## "audit_events is append-only" errors

**Symptom.** A write fails with
`audit_events is append-only; UPDATE is not permitted`.

**Cause.** A database trigger refuses `UPDATE` and `DELETE` on `audit_events`.
This is deliberate — see the `20260814000100_audit_append_only` migration.

**The most common way to hit it is deleting an employee.** The audit foreign
keys are `ON DELETE SET NULL`, so removing an employee row tries to rewrite
audit history and is refused.

**Fix.** Do not delete employees. Disable them:

Admin → the employee → **Disable account**. That also bumps
`sessions_valid_after`, so the person is rejected on their very next request
rather than at next sign-out.

If a row genuinely must be removed — a GDPR-style erasure, say — that is a
deliberate, specified task, not an incidental fix. It requires dropping the
trigger, making the change, recording why, and recreating the trigger in one
transaction.

---

## Someone was revoked but still has access

**Symptom.** An admin removed a grant, and the person reports they can still
open the module.

**Expected behavior.** Revocation is immediate. Grants are read from the
database on every request and are deliberately never stored in the session
token. The next request returns `404`.

**Therefore, if it persists, it is not a stale session.** Check in order:

1. Was the grant actually removed?
   ```sql
   SELECT * FROM module_grants WHERE employee_id = '<id>';
   ```
2. Is the person hitting a cached page rather than the server? Ask them to hard-
   reload. Module pages are `force-dynamic`, so this should not happen.
3. Is there a second employee row for the same person? This is possible only if
   a row was created by hand. Key is `entra_oid`, not email.
   ```sql
   SELECT id, email, entra_oid FROM employees WHERE email ILIKE '%name%';
   ```

**What is *not* the fix:** forcing a sign-out. If a sign-out were needed, the
grant would be baked into the token, and that is exactly what this design
avoids.

---

## npm install warns about install scripts

**Symptom.** `npm install` prints
`npm warn allow-scripts N packages have install scripts not yet covered by allowScripts`,
and afterwards Prisma or Vitest fails with a missing binary.

**Cause.** npm 11 does not run package install scripts unless they are approved.
Prisma's query engine, esbuild and sharp all need theirs.

**Fix.** The approvals are pinned in `package.json` under `allowScripts` and are
committed, so this should not happen on a clean clone. If it does — after adding
a dependency, say:

```bash
npm approve-scripts <package-name>
```

Then commit the `package.json` change. Do not disable the check globally.
