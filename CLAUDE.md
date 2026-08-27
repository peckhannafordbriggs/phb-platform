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
| ORM / migrations | Prisma 7 (`prisma-client` generator, `@prisma/adapter-pg`) |
| Auth | Auth.js (NextAuth v5), Microsoft Entra ID provider |
| Microsoft integration | Microsoft Graph via `@microsoft/microsoft-graph-client` |
| Graph credential | Client secret locally; managed identity + federated credential in prod |
| Hosting | Azure Container Apps, Azure Database for PostgreSQL, Key Vault |
| Node | 20 LTS or newer |
| Package manager | npm |
| Tests | Vitest against a real Postgres test database |

One repo. One app. No microservices, no message queue, no Redis, no Docker Compose
sprawl. If a task seems to need one of those, stop and ask.

---

## Settled decisions

Each of these has a reason. Do not build abstractions to keep the alternative open.

**Mail identity: app-only.** One Entra app registration with Graph `Mail.ReadWrite` +
`Mail.Send` (Application), scoped to `changeorder@phb1899.com` by an Exchange
ApplicationAccessPolicy — verified `Granted` for that mailbox and `Denied` for others.
*Why:* onboarding must not require a per-employee mailbox grant, and the scheduled job
needs a token when nobody is signed in. **Do not implement delegated auth.**

**Employee identity: Entra ID SSO.** Separate app registration from the Graph one. The
platform never stores a password and never creates accounts.

**Employees self-provision.** Anyone with a company account can sign in. First sign-in
creates an employee row with **zero module grants** and sends them to profile
completion. Admins **grant access**; they do not create accounts. There is no
create-employee endpoint.

**Exchange is the source of truth for all mail.** Reads go live to Graph. No message
index, no delta tokens, no webhooks, no sync engine. See `docs/03-exchange-and-graph.md`.

**No mail caching beyond short-lived in-memory.** Never persist message bodies or
attachments.

**The mailbox is a licensed user mailbox**, shared with the current operator in Outlook.

**Bootstrap admins come from `BOOTSTRAP_ADMIN_EMAIL`** (comma-separated), applied by the
seed, never by a migration. Migrations contain no email addresses. See
`docs/05-database-and-sources.md` for what belongs in a migration versus a seed.

---

## Hard prohibitions

Violating any of these can break a production pipeline PH+B runs on daily.

1. **Never auto-send email.** Every outbound message is created as an unsent draft and
   sent by a human who has read it. `sendMail` appears zero times across all 11 Power
   Automate flows — deliberately. Never add auto-send, bulk-send, send-all, multi-select
   send, or scheduled send. One human, one draft, one deliberate action. This is the
   entire safety model of the change-order system.
2. **Never modify, disable, re-authorize, or export any Power Automate flow.**
3. **Never write these filenames anywhere:** `scrub_result.json`, `vendor_drafts.json`,
   `transfer_ready.json`, `classification_result.json`. They are live flow triggers.
4. **Never write `Bid Tracker.xlsx`** with a script or library. Read-only, and only
   through the Graph workbook API.
5. **Never "fix" the SharePoint path spelling.** It is `CO Managment Process` — one A.
   Every flow depends on the literal string.
6. **Never bind anything to an individual person's account** — repo, subscription, app
   registration, resource, or credential. Owners are M365 groups.
7. **Never introduce a credential that expires** in production. No client secrets or
   certificates in Azure; production refuses to boot with `GRAPH_CLIENT_SECRET` set.
   Local development may use a client secret in `.env.local`.
8. **Never commit secrets**, and never commit real message content as a test fixture —
   a committed fixture is persistence.

Full context: `docs/02-existing-co-system.md`. Read it before any task touching
Microsoft 365.

---

## Development safety

Development runs against the **live** `changeorder@phb1899.com` mailbox. There is no
test mailbox. Two guards, both enforced inside the mail service, not in route handlers:

- **`PHB_ALLOW_SEND`** — must be `true` for any send. Absent or `false` throws, before
  any network call. **Stays `false` except during a deliberate, supervised send test.**
- **`ZZTEST` convention** — when `NODE_ENV !== 'production'`, write operations are
  permitted only on messages whose subject begins with `ZZTEST`. The subject is read
  from Exchange, never taken from the caller.

Do not weaken, bypass, or add an override to either. Test sends go to the operator's own
address only, never to a vendor.

Everything else is recoverable: deletes go to Deleted Items, moves reverse, a broken
draft can be regenerated. A send cannot be undone. That asymmetry is why the send gate
is separate and stricter.

---

## Verify against the live mailbox, not fixtures

This has earned its place at the top level. Every phase that touched Graph found defects
that mocked transports agreed with:

- `wellKnownName` doesn't exist in Graph v1.0 — it fails the whole request, not just the
  field
- `Projects` is a child of Inbox, so project folders sit at depth 2 and their contents at
  depth 3. A tree that stops short looks empty rather than truncated
- Graph pages mail with `$skip`, not `$skiptoken` — and dropping `$orderby` on an offset
  page corrupts paging silently
- The subject tags are `[CCHMC RFI 229]` / `[CCHMC Bulletin 12]`, and some messages carry
  none. `[CO:` appears nowhere in the mailbox
- Exchange rewrites a literal U+00A0 as `&nbsp;` on write
- Outlook writes a pasted table cell as `<td><p>value</p></td>`
- `DELETE /messages/{id}` does **not** move a message to Deleted Items. It goes to
  Recoverable Items \ Deletions, which needs Outlook's *Recover Deleted Items from
  Server* dialog. A platform delete is a `move` to `deleteditems` instead
- `$search` ignores `Prefer: IdType="ImmutableId"` even with the header on the wire, so
  it is not used at all — search is `$filter=contains(subject,…)`, which honours it. A
  GET cannot translate between the forms; Graph echoes back whichever one addressed the
  resource
- `$filter` and `$orderby` together on messages are refused with `400 InefficientFilter`,
  so Graph will not order a search. The service collects the whole result set and sorts
  it — page-by-page sorting looks ordered and is not
- An attachment's `size` is not its content length. A 337,145-byte PDF reports 337,527,
  and 337,532 after a forward copies it. Compare content, never the reported size

Fixtures are right for hostile-HTML tests and error mapping. Anything about Graph's
actual behaviour needs the real mailbox.

---

## Current state

**Phases 1–6 complete.** Platform shell, Entra SSO with the full login gate,
self-provisioning and onboarding, employees / grants / audit, authorization middleware,
admin screen, Graph connection, read-only mailbox with folder tree and search, and draft
review / edit / send verified end to end.

**Phase 7 Part A complete** — Dockerfile, CI, Bicep. Part B waits on the Azure
subscription.

**Phase 8 implemented, live verification outstanding.** Reply / reply-all /
forward via Graph's own `createReply*` operations, compose from scratch, move,
delete to Deleted Items, and attachment download / add / remove. Every one of
them produces or edits a draft that opens in the **Phase 6 editor** — there is
one editing surface and adding a second is a mistake. `permanentDelete` is
exposed nowhere and a test enforces that.

One guard changed, deliberately: the ZZTEST fence now skips Exchange's own
`RE:` / `FW:` prefixes, because `createReply` names its draft `RE: <original>`
and every derived draft would otherwise be uneditable outside production. A reply
to a real change order is still refused. See `docs/runbook.md`.

**Phase 8 complete.** Live verification is done and `docs/phase-8-verification.md`
records what Exchange actually did, including four claims the docs had wrong.
`scripts/co-verify-phase8.ts` re-runs it and never sends.

Folder search is subject-only as a result: `$search` returns ids that go stale on a
move, so it is not used. See the list above.

**Phase 9 Part A complete.** Conversation grouping, concurrent-edit honesty and
resilience. Part B — Graph change notifications — is **not started** and needs
the Azure subscription plus the Outlook-side latency numbers.

The one design decision that phase turned on: **a grouped listing collects the
folder to a cap and groups the complete set. It does not group a page and it has
no cursor.** A group assembled from one page renders a factual claim — "4
messages, newest 08-25" — that is false when the rest of the thread is on page
two, and Graph offers no per-message conversation size to notice it with. The
collection is ordered newest-first with no `$filter`, so what a cap drops is the
oldest; a thread can be missing early replies and never its newest message, and
the banner says exactly that. Flat mode keeps the paged cursor and is the way
past the cap. Do not add paging to `listConversations`.

Grouping is on `conversationId`, never subject: `CCHMC Bulletin 12` really does
hold two different conversations with a byte-identical subject line, and merging
them would have produced one thread of eleven with a false count.

Grouping is display only. No action anywhere takes a conversation.

`docs/phase-9-verification.md` records what Exchange actually did, including the
measurement that decides Part B: a platform write is visible in a folder listing
on the first 250ms poll, so Exchange is not the slow part — the platform's own
60-second poll interval is the entire user-visible delay. Four of the six sync
directions still need a person acting in Outlook and are marked not-run rather
than assumed.

Roadmap: `docs/06-roadmap.md`. Do not implement a later phase without being told to.

---

## Working rules

**Before implementing:** read the existing code, follow existing conventions, check
whether the functionality partly exists already.

**After implementing:** run tests, typecheck, lint, verify the build, and state what you
changed and what you verified. Distinguish what you observed from what you inferred.

**Commit straight to main.** No branches unless asked.

**Use judgment without asking** on reversible, conventional, low-risk, internal choices.

**Stop and ask** before anything that could touch the existing change-order system,
sends more than one message per human action, weakens either send guard, adds a table
holding mailbox data, requires broader Microsoft permissions, adds long-term
infrastructure, or conflicts with this file.

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
| `docs/05-database-and-sources.md` | Schema ownership, migration vs seed, source of truth |
| `docs/06-roadmap.md` | Phases 1–14 |
| `docs/07-conventions.md` | Code, API, errors, logging, secrets, environments |
| `docs/runbook.md` | Failure modes, recovery, what expires and when |
| `docs/phase-1-verification.md` | Manual verification record |
| `docs/phase-8-verification.md` | What Exchange actually did for the email actions |
| `docs/phase-9-verification.md` | Grouping, conflicts, and the latency that decides Part B |
