# PHB Internal Platform — context for a new module

Background for anyone building a module on the PH+B internal platform. It describes what
the platform already provides, the contract a new module has to satisfy, and the
decisions a module has to make for itself.

Two modules exist: **Change Orders** (a company-owned interface to the
`changeorder@phb1899.com` mailbox) and **BAS** (building-automation sensor data).
**Cost Intelligence** is the third, in progress. The platform itself is complete,
deployed and tested.

This document is the *design* half. `DEVELOPER-SETUP.md` is the *setup* half — read
that first if you have not run the app yet. Neither repeats the other.

---

## What the platform is

An internal web application for Peck Hannaford + Briggs. One sign-in, one frontend,
multiple internal systems appearing as modules in a sidebar, with per-employee access
controlled by an admin.

```
PHB Platform
│
├── Home
├── Change Orders     (module 1)
├── BAS               (module 2)
├── Cost Intelligence (module 3 - in progress)
└── Admin
```

The reason it exists: internal processes at PH+B tend to end up depending on one
person's laptop configuration — synced folders, locally scheduled tasks, personally
granted mailbox permissions. When that person leaves, the handover is enormous. The
platform is the company-owned place those processes live instead.

## Stack

| Layer | Choice |
|---|---|
| Frontend + backend | Next.js 15 (App Router), TypeScript, React, Tailwind |
| Database | PostgreSQL |
| ORM / migrations | Prisma |
| Auth | Auth.js (NextAuth v5), Microsoft Entra ID provider |
| External integrations | Microsoft Graph where applicable |
| Hosting | Azure Container Apps, Postgres Flexible Server, Key Vault |
| Tests | Vitest against a real Postgres test database |

One repo, one app. No microservices, no message queue, no Redis.

---

## What the platform already provides — do not rebuild any of it

**Authentication.** Entra ID SSO. No passwords are stored. Sign-in is gated on four
checks: tenant ID matches, the email domain is on an allow-list, B2B guest accounts
(`#EXT#` in the UPN) are rejected, and the employee is not disabled.

**Employee records.** Anyone with a company account can sign in. First sign-in
auto-creates an employee row with **zero module grants**, then sends them to a profile
completion step (name prefilled from the token, email locked, position and department).
Admins grant access; there is no create-employee function.

**Authorization.** A `module_grants` table and a server-side guard. Every request to
`/api/modules/<key>/*` passes through it:

```
authenticated?                     no → 401
session issued before revocation?  yes → 401
employee active?                   no → 401
profile complete?                  no → 403
grant exists for <key>?            no → 404
```

404 rather than 403 on a missing grant, so module existence isn't confirmed to someone
without access. Grants are read from the database on every request, never baked into a
session token, so revocation takes effect immediately.

**Admin screen.** Employee list with search, filters and pagination; a grant toggle per
module; enable/disable; admin flag; department assignment. Guardrails prevent an admin
removing their own admin flag, disabling themselves, or leaving zero active admins.

**Audit log.** Append-only, enforced by a database trigger. Records who granted or
revoked what, and when.

**Sidebar.** Rendered from the `modules` table joined to the signed-in employee's
grants. No hardcoded module list anywhere.

---

## The integration contract

Adding a module means four things. Substitute your own key for `yourmodule` below:

**1. A row in `modules`.**

```
key           'yourmodule'   -- stable, used by every authz check. Never a display label.
display_name  'Your Module'
description   ...
icon          ...
sort_order    ...
status        'active'
```

The sidebar and the admin grant matrix pick it up automatically. No UI changes needed
in either.

**2. An API namespace.** `app/api/modules/yourmodule/*`. Every route in it goes through
the existing guard with `moduleKey: 'yourmodule'`. Nothing else is required to make
access control work.

**3. A UI namespace.** `app/(modules)/yourmodule/*`. The page itself must also check the grant
server-side — a page guard, not just a hidden nav item.

**4. A service layer.** `lib/modules/yourmodule/*`. All module-specific logic and every
external integration lives here.

### Rules that apply to any module

- **`lib/auth`, `lib/authz` and `lib/db` must not import from `lib/modules/*`.**
  Dependencies point one way.
- **The guard is the security boundary.** Hiding a sidebar item is not authorization. A
  module route must reject an ungranted request even if no UI exists for it.
- **One service boundary per external system.** Route handlers and components never
  construct external API calls, never see tokens, never see vendor-specific IDs. They
  ask the service for domain concepts.
- **Do not duplicate an external system's data.** If some other system is the
  authoritative owner of a piece of information, read it live rather than storing a
  copy. Before creating any table, answer: *who is the authoritative owner of this
  information?* If the answer isn't "the platform," don't store it.
- **Add audit actions as needed.** There is an append-only `audit_events` table and an
  action-string union. Don't build a general audit framework; add the strings the module
  actually writes.
- **Position is self-reported and unverified.** Never use it for an access decision.
  Department is admin-controlled and can be relied on.

### What a module owns vs. what it inherits

| Inherits from the platform | Owns |
|---|---|
| Sign-in, sessions, sign-out | Its own screens |
| Employee identity and profiles | Its own external integrations |
| Grants and the authz guard | Its own service layer and tables |
| Admin screen and grant toggles | Its own audit action strings |
| Sidebar rendering | Its own credentials, separate from other modules |
| Audit log infrastructure | |

Credentials are per-module deliberately. A future module must not be able to reach
another module's external system.

---

## Change Orders as a worked example

Useful as a pattern, not as a template to copy.

The Change Order process runs on Microsoft 365 — SharePoint for state, Power Automate
for I/O, a shared mailbox for correspondence. That automation was already working and
was deliberately **not** rebuilt.

The platform became an additional client of one thing: the mailbox. It reads and writes
drafts via Microsoft Graph, with app-only credentials scoped by an Exchange policy to
that single mailbox. The automation and the platform never talk to each other — both
talk to Exchange, and the mailbox is where they meet.

Three principles that came out of it and apply generally:

1. **Wrap the working system; don't replace it.** Existing infrastructure that works
   stays.
2. **Never become the sole route.** Outlook remains permanently available for
   change-order work. If the platform is down, the process still runs. Any new module
   should preserve whatever the existing route to its information is.
3. **The external system stays the source of truth.** The platform holds no copy of the
   mailbox. If a module's tables can't be dropped and rebuilt from the external system
   with no loss, a second copy has been built by accident.

---

## What your module needs to decide

These are the decision points both existing modules had to answer. Your answers will
differ, but the questions are the same, and they determine the architecture.

**1. What is the authoritative system, and what protocol reaches it?** An API, a
database, a file export, a vendor cloud service, a spreadsheet someone maintains. This
decides how the module reads, and whether the platform can reach it from Azure at all.

**2. Read-only or read-write?** Reading is a very different risk profile from writing.
If the module writes anywhere outside the platform's own tables, that needs a deliberate
gate — a human action per change, never automated, with an audit record. Change Orders
does this for sending email, and it is the single strictest rule in the codebase.

**3. What does the platform need to store, and what should it read live?** The default
is: if another system is the authoritative owner, read it live rather than storing a
copy. Change Orders stores nothing about the mailbox. BAS stores everything, because the
controller destroys its own history after 42 hours and there is no upstream to defer to.
Both are right, for opposite reasons. Whichever you choose, make the argument explicitly.

**4. Does anything need to be near-real-time?** Polling on an interval is much simpler
than a subscription or push mechanism, and is usually good enough. Change Orders
evaluated webhooks and declined them after measuring that the poll interval was the
entire user-visible delay. Reach for the complex option only when a measured need
appears.

**5. Who is allowed to see it, and is one grant enough?** Change Orders has a single
flat grant — anyone with access sees everything. If your module needs finer control, per
site or per project, that is the module's own concern layered on top of the platform
grant, not a change to the platform's authorization model.

**6. Does anything need to run on a schedule?** The platform has no background job
system yet. If yours needs one, build it as shared infrastructure rather than
module-specific, since the other modules will eventually need it too.

**7. What is the existing route to this information, and does it stay?** See principle 2
above. Whatever people use today should keep working.

---

## Practical notes — you are building in this repository

Your module is a directory in `phb-platform`, not a separate project. That is the
single most important thing to understand about the working model, and everything
below follows from it.

**Getting set up is `DEVELOPER-SETUP.md`.** Installs, databases, `.env.local`, seeds,
and the first test run are written out there in order. This document does not repeat
them. The one fact worth knowing before you start: only five variables are required at
boot, so the app runs and the whole test suite passes with no Microsoft credential at
all. Only signing in needs one.

**The schema is shared, and that is the main coupling.** Your tables live in the same
`prisma/schema.prisma` and the same migration history as everything else. A migration
that fails blocks the whole platform's deploy, not just your module. Prefix your tables
consistently — BAS uses `bas_`, so a cost module would use something equally obvious —
and keep each migration to your own tables. A migration that touches a table you do not
own is a review conversation, not a commit.

**Branch and open a pull request.** Nothing goes straight to `main`: the platform is
running change orders and building-automation collection now, so changes get a second
pair of eyes. The platform owner reviews and merges.

**CI deploys the whole application.** There is one pipeline and one container. Your
module ships when the platform ships, and a broken test in your module blocks everyone's
deploy — including a deploy that has nothing to do with your work. The suite runs
against a real PostgreSQL instance on every push.

**You probably do not need Azure access.** Deployment is CI's job, and the production
environment is already provisioned. Ask only if you find a reason.

**You share `docs/`, `runbook.md` and the root documents.** When your module gains a
failure mode, it goes in `runbook.md` with the symptom, the cause and the fix — same as
every other phase. The operator who inherits this in December 2026 will not know which
module a symptom belongs to, which is exactly why the runbook is organised by symptom
rather than by module.

---

## Two conventions worth following

- **Nothing owned by an individual account** — no repository, subscription, app
  registration, resource, or credential. Owners are groups.
- **Avoid credentials that expire** in production. Where unavoidable, the expiry date and
  the renewal owner go in the runbook, not in someone's head.

Every phase of work ships operational documentation as it goes: for each failure mode,
the symptom, the cause, and the fix — written for someone who has never seen the
codebase.
