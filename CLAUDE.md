# PHB Internal Platform

Read this file before every task. It is short on purpose. Detail lives in `docs/`.

---

## What this is

An internal company platform for Peck Hannaford + Briggs. One login, one frontend,
multiple internal systems as modules, admin-controlled access per employee.

**Change Orders** is module #1. It is a company-owned interface to an existing
Microsoft 365 mailbox and automation pipeline that already works. We are building
*around* that system, not rebuilding it.

The platform is an **additional** client for change-order work. Outlook remains a
fully working path forever. Never build anything the platform is the sole route to.

---

## Stack — decided, do not re-litigate

| Layer | Choice |
|---|---|
| Frontend + backend | Next.js 15 (App Router), TypeScript, React, Tailwind |
| Database | PostgreSQL |
| ORM / migrations | Prisma |
| Auth | Auth.js (NextAuth v5), Microsoft Entra ID provider |
| Microsoft integration | Microsoft Graph via `@microsoft/microsoft-graph-client` |
| Graph credential | Azure managed identity + federated identity credential (prod) |
| Hosting | Azure Container Apps, Azure Database for PostgreSQL Flexible Server, Key Vault |
| Node | 20 LTS or newer |
| Package manager | npm |
| Tests | Vitest |

One repo. One app. No microservices, no message queue, no Redis, no Docker Compose
sprawl. If a task seems to need one of those, stop and ask.

---

## Settled decisions

Each of these has a reason. Do not build abstractions to keep the alternative open.

**Mail identity: app-only.** The platform holds one Entra app identity with Graph
`Mail.ReadWrite` + `Mail.Send` (Application), scoped to `changeorder@phb1899.com`
only via an Exchange ApplicationAccessPolicy. *Why:* onboarding must not require a
per-employee mailbox grant, and the scheduled job needs a token when nobody is
signed in. **Do not implement delegated / on-behalf-of auth.**

**Employee identity: Entra ID SSO.** The platform never stores a password and never
creates accounts. Everyone at PH+B already exists in Entra.

**Employees self-provision.** Anyone with a company account can sign in. First
sign-in creates an employee row with **zero module grants** and sends them to a
profile-completion step. Admins **grant access**; they do not create accounts.

**Exchange is the source of truth for all mail.** The platform reads live from
Graph. No message index, no local mailbox copy, no sync engine. See
`docs/03-exchange-and-graph.md`.

**No mail caching beyond short-lived in-memory.** Never persist message bodies or
attachments to the database.

**The mailbox is a licensed user mailbox**, shared with the current operator in
Outlook. Not a shared mailbox. Stop asking.

---

## Hard prohibitions

Violating any of these can break a production pipeline that PH+B runs on daily.

1. **Never auto-send email.** Every outbound message in this system is created as an
   unsent draft and sent by a human. `sendMail` appears zero times across all 11
   existing Power Automate flows — deliberately. Never add auto-send, bulk-send,
   send-all, or a scheduled send. This is the entire safety model of the
   change-order system.
2. **Never modify, disable, re-authorize, or export any Power Automate flow.**
3. **Never write these filenames anywhere:** `scrub_result.json`,
   `vendor_drafts.json`, `transfer_ready.json`, `classification_result.json`.
   They are live flow triggers.
4. **Never write `Bid Tracker.xlsx`** with a script or library. Read-only, and only
   through the Graph workbook API.
5. **Never "fix" the SharePoint path spelling.** It is `CO Managment Process` —
   one A. Every flow depends on the literal string.
6. **Never bind anything to an individual person's account** — repo, subscription,
   app registration, resource, or credential. Owners are M365 groups.
7. **Never introduce a credential that expires** in production. No client secrets or
   certificates in Azure. Local development may use a client secret in `.env.local`.
8. **Never commit secrets.** Not in code, not in tests, not in docs, not in fixtures.

Full context on what already exists: `docs/02-existing-co-system.md`. Read it before
any task that touches Microsoft 365.

---

## Development safety

Development runs against the **live** `changeorder@phb1899.com` mailbox. There is no
test mailbox. Two guards, both enforced in the mail service itself, not in route
handlers:

- **`PHB_ALLOW_SEND`** — must be `true` for any send to execute. Absent or `false`
  throws. Never set to `true` outside production.
- **`ZZTEST` convention** — when `NODE_ENV !== 'production'`, write operations
  (draft create/update, move, delete) are permitted only on messages whose subject
  begins with `ZZTEST`. Reads are unrestricted.

Everything else is recoverable: deletes go to Deleted Items, moves reverse, a broken
draft can be deleted. A send cannot be undone. That asymmetry is why the send gate
is separate and stricter.

---

## Current phase

**Phase 1 — Platform foundation.** See `PHASE-1.md` for scope and acceptance
criteria. Phase 1 makes **no Microsoft Graph calls and no Claude API calls.**

Roadmap and phase boundaries: `docs/06-roadmap.md`. Do not implement a later phase
without being told to.

---

## Working rules

**Before implementing:** read the existing code, follow existing conventions, check
whether the functionality partly exists already.

**After implementing:** run tests, run typecheck and lint, verify the build, state
what changed and what you verified.

**Use judgment without asking** on reversible, conventional, low-risk, internal
choices.

**Stop and ask** before anything that could touch the existing change-order system,
significantly alters the architecture, requires broader Microsoft permissions,
requires production data migration, adds long-term infrastructure, or conflicts with
this file.

**Every phase ships operational docs.** For each new failure mode: the symptom, the
cause, the fix. Written during the phase, in `docs/runbook.md`. The current operator
leaves in December 2026 and this platform must be operable by someone who has never
seen it.

---

## Reference docs

| File | Contents |
|---|---|
| `docs/01-vision-and-modules.md` | Product vision, module architecture, UI shape |
| `docs/02-existing-co-system.md` | **What already exists and must not break** |
| `docs/03-exchange-and-graph.md` | Exchange as source of truth, Graph rules and gotchas |
| `docs/04-auth-and-permissions.md` | Login rules, authorization contract, admin security |
| `docs/05-database-and-sources.md` | Schema ownership, source-of-truth table, migrations |
| `docs/06-roadmap.md` | Phases, what is in scope before December, what is not |
| `docs/07-conventions.md` | Code, API, errors, logging, secrets, environments |
