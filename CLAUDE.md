# PHB Internal Platform

Read this file before every task. It is short on purpose. Detail lives in `docs/`.

---

## What this is

An internal company platform for Peck Hannaford + Briggs. One login, one frontend,
multiple internal systems as modules, admin-controlled access per employee.

**Change Orders** is module #1. It is a company-owned interface to an existing
Microsoft 365 mailbox and automation pipeline that already works. We are building
*around* that system, not rebuilding it. **BAS** (building automation) is module
#2. **Cost Intelligence** is module #3, in progress, built by Karthik
(`krachamolla@phb1899.com`) in this repository.

Two people now work in this repo. `DEVELOPER-SETUP.md` is how a new developer
gets running; `PLATFORM-CONTEXT.md` is the contract a new module satisfies.
Neither restates the other, and neither restates `runbook.md`.

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

(That is about *this* application. The BAS collector, the Grafana dashboards, the
`bas-mcp` server and the database backup and restore scripts live in a separate
repository, `phb-bas`, and always have — the database is the only seam between
them. A file's absence from this repo is not absence from version control. See
`docs/09-bas-what-is-built.md`.)

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

**Phase 7 Part A complete** — Dockerfile, CI, Bicep.

**Part B is DEPLOYED and seeded, as of 2026-09-09.** Production runs in
**eastus2**, not eastus: PostgreSQL Flexible Server is offer-restricted in
`eastus` for this CSP subscription and was available in every other region
tried, so `location` moved and every resource followed it — it is one parameter
and the whole deployment reads it. All seven resources are up, the twelve
migrations are applied, and the production seed has run **once**, by hand.

Four things were verified against the **live** resources rather than the
template, each being expensive or impossible to correct later:

- the collation sorts `Administrative` before `AI` **by actual values**, checked
  while the database was still empty (`npm run db:verify:prod`)
- the container app carries all four bootstrap addresses — a wrong value here
  means zero admins and no UI path back
- `PHB_ALLOW_SEND` is `false`, and `GRAPH_CLIENT_SECRET` is **absent** rather
  than blank
- the server reports `autoGrow: Enabled` and `state: Ready`, no auto-stop
  property exists on the resource type at all, and the budget carries contacts
  with no action group

Four employee rows exist, all `is_platform_admin`, all with `entra_oid` null
until each person's first sign-in stamps it. No module grants: being an admin is
not a grant.

**Three permission walls were hit in order, all from scope rather than from the
role names**, and all written up in `runbook.md`: provider registration is
subscription-scoped; `roleAssignments/write` is in Contributor's `notActions`;
and key vault **purge** is subscription-scoped, because a soft-deleted vault
does not live in a resource group. On that last one — `az keyvault list-deleted`
returns an **empty array rather than an error** when you lack permission, which
reads exactly like "the name is free" and is not. Use `checkNameAvailability`.

**What is NOT done.** The container app still runs the placeholder image and so
answers nothing; that is expected until CI pushes a real one, not a fault.

**CI is fully wired, and the deploy job is no longer inert.** All seven
`AZURE_*` repository **variables** are set and were verified against live Azure,
the `PRODUCTION_DATABASE_URL` **secret** is set, and the `production`
**environment** exists with no protection rules. `AZURE_CLIENT_ID` was filled in
on 2026-09-16, so the deploy job's `if:` guard now passes and **a merge to
`main` runs a real production deploy** — image build, database migration,
revision rollout — against a container app that still holds the placeholder
image. Whether that is currently gated is the platform owner's decision; check
the repository variables and the `production` environment before merging rather
than assuming either state.

**The OIDC credential is proven, not assumed.** A login-only probe job
authenticated against live Entra on 2026-09-16, and what it found corrected this
file. The subject GitHub actually sends is
`repo:peckhannafordbriggs@74662004/phb-platform@1334314549:environment:production`:
entity type **Environment** rather than Branch, *and* the organisation and
repository ids embedded, because this repository has GitHub's **immutable
subject claims** enabled. So the plain `repo:<owner>/<repo>:…` form that the
Azure portal's *GitHub Actions* credential wizard builds is **not** what this
repository sends, and neither is `ref:refs/heads/main`. Both fail as
`AADSTS70021` with no hint as to which half is wrong, and the subject has to be
typed by hand. `runbook.md` → *What to ask IT for* → Request 3a carries it.

The Graph federated credential and the production redirect URI are still with
Vitis; sign-in cannot be tested until the redirect URI exists.

**Production sign-in was tested on 2026-09-16 and failed as predicted** —
`invalid_client` at the token exchange, because production carries no SSO
secret and the SSO app registration is a confidential client. The decision
went the way prohibition 7 points: **not** a secret in Azure, but the managed
identity's token presented as a `client_assertion`, matched by a federated
identity credential on the SSO app registration — the same mechanism the Graph
module already uses, now one shared implementation in
`lib/azure/managed-identity-assertion.ts`. Built on
`feat/sso-managed-identity-assertion`; **not merged**, because it cannot work
until Vitis adds that credential (`runbook.md` → *What to ask IT for* →
*Request 3*, one email, verbatim). Production refuses to boot if
`AUTH_MICROSOFT_ENTRA_ID_SECRET` is set. The logo (`public/`) fix shipped
separately.

A defect Part B surfaced: the deploy workflow's firewall step passed the server
as `--name` and the rule as `--rule-name`, so it could never have run. `-s` is
the server and `-n` is the rule. It only executes on a GitHub runner, one step
before the migration, so nothing local would ever have caught it; a test now
asserts both invocations.

The subscription id and resource group are in `infra/main.parameters.json`
(gitignored) and CI variables only; `tests/deploy-guards.test.ts` fails the build
if either appears in any deployment file **or** in the documentation, including
the verbatim access requests in `runbook.md`.

**Phase 8 complete, verified live.** Reply / reply-all / forward via Graph's own
`createReply*` operations, compose from scratch, move, delete to Deleted Items,
and attachment download / add / remove. Every one of them produces or edits a
draft that opens in the **Phase 6 editor** — there is one editing surface and
adding a second is a mistake. `permanentDelete` is exposed nowhere and a test
enforces that. `docs/phase-8-verification.md` records what Exchange actually
did, including four claims the docs had wrong; `scripts/co-verify-phase8.ts`
re-runs it and never sends.

One guard changed, deliberately: the ZZTEST fence now skips Exchange's own
`RE:` / `FW:` prefixes, because `createReply` names its draft `RE: <original>`
and every derived draft would otherwise be uneditable outside production. A reply
to a real change order is still refused. See `runbook.md`.

Folder search is subject-only as a result: `$search` returns ids that go stale on a
move, so it is not used. See the list above.

**Phase 9 Part A complete. Part B evaluated and DECLINED.** Conversation
grouping, concurrent-edit honesty and resilience shipped. Graph change
notifications were measured against and turned down: Exchange propagates a write
into a folder listing in under 250ms, so the poll interval was the entire delay.
It went from 60s to **20s** — 180 requests an hour per focused tab, 0.3% of the
~10k-per-10-minutes budget — and a subscription lifecycle, a three-day renewal
job, a public validation endpoint and dropped-notification reconciliation were
judged not worth the remaining 20 seconds for one to three users. **Do not
rebuild the case for webhooks without a new measurement**; the reasoning and the
conditions that would reopen it are in `docs/PHASE-9.md` and `runbook.md`.

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

`docs/phase-9-verification.md` records what Exchange actually did. Four of the six
sync directions still need a person acting in Outlook and are marked not-run
rather than assumed.

Grouping is scoped to the open folder, so a conversation row reads "7 in this
folder" rather than "7 messages" — a thread spans folders, and the folder-scoped
count would otherwise be a false claim about the thread.

**Phase 10 complete — the admin panel holds up at volume.** The audit log is
readable: `/admin/audit` filters by target, actor, action and date range, an
employee's own history is inline on their page, and `describeAuditEvent` renders
a row as a sentence rather than an action string beside two UUIDs. An action the
build has no wording for renders as itself and says so — a viewer that invented
prose for an unrecognised action would be worse than one that admits it, and
`KNOWN_ACTIONS` is a total record so adding an action without wording stops the
build.

Bulk grant, revoke, enable and disable, with a confirmation naming the count and
one audit row per employee. The bulk path calls the same guarded `setStatus` an
individual change does, so the four guardrails apply to every member of a
selection; refusals are reported by name and by reason rather than as a count.

Sorting by name, status and last sign-in, a "no grants at all" scope, per-value
employee counts on the positions and departments lists, and two visually distinct
empty states. Every sort carries a name-then-id tiebreak, which is load-bearing:
sorting 130 employees by status is one run of 111 ties, and without it a page
boundary repeats one row and drops another.

Tested against a deterministic 130-employee fixture, not four rows.
`runbook.md` has the operational notes under *Admin panel (Phase 10)*.

**Phase 11 complete — the automation is verified undisturbed.** Nine phases of
platform work have not touched the change-order pipeline, and this is now
*observed* rather than argued from the design. No flow ran inside any of the three
platform write windows, no new failure type appeared after the platform first
connected on 2026-08-19, `Bid Tracker.xlsx` holds no ZZTEST row and its table
binding still resolves, no sentinel was written during a platform window, and the
scheduled tasks are on cadence. Three independent sources — portal run history,
tracker state, mailbox contents — agree on the same events.

Two things a repeat run will see and should not report as new: the tracker's
pre-platform test rows use the **`ZZ`** prefix, not `ZZTEST`, so sweep it for `ZZ`
and discriminate by date; and `CO Intake 1`'s documented no-CO-form stop now ends
as **Cancelled** rather than Failed, after a deliberate change by the flow's
owner. `docs/phase-11-verification.md` is the record, and `runbook.md` has
the repeatable procedure including the portal and SharePoint steps.

Still open: the two Exchange admin checks (operator Full Access, and
`Test-ApplicationAccessPolicy`), and one unexplained weekday gap in the
scheduled-task reports on 2026-08-18 — pre-platform, so outside the phase.

**The UI redesign shipped.** Not a numbered phase; it landed across several. The
palette is sampled from `public/phb-logo.png` rather than invented, and every
value carries the measurement that justifies it — a two-tier fill/ink split
exists because only purple and maroon clear WCAG AA as text. Archivo and Figtree
are split **by role, never by size**: Archivo is signage, Figtree is anything a
person reads. The quartered diamond is the signature at three sizes, and the
tinted radial ground carries the dashboards. BAS was rebuilt around a hero tile,
Home became a personal launcher, and Change Orders was softened with resizable
panes, breakpoints and keyboard navigation.

Two rules from it that are easy to undo by accident, both enforced in code:
**decorative colour and semantic colour are disjoint sets**, and **the Change
Orders reading pane stays quiet while its chrome went soft** — the test is
competing content, and a vendor's own email is competing content. See
`WHY-ITS-BUILT-THIS-WAY.md` §§ 38–39, `docs/DESIGN-BRIEF.md`, and the token
comments in `app/globals.css`, which are the authority on any colour value.

**Phase 12 Parts A and B complete. Part C onward not started.** The change-order
engine — `run_workflow.py`, ~196 KB, which had no version control at all — is
now a repository, `phb-co-engine`, with the first commit verified byte-identical
to the SharePoint copy. `docs/12-ai-layer-inventory.md` is the inventory every
later part depends on, and it distinguishes what was observed from what was
inferred.

Two findings from it that change what a later part may assume:

- **A dormant `Bid Tracker.xlsx` write was found in the engine and removed** —
  the one deliberate logic change in Part B. It is the exact operation that
  silently breaks a Power Automate table binding, it had run before, and the
  broken-table artifact is still on disk. Guarded now by a test.
  `WHY-ITS-BUILT-THIS-WAY.md` § 40.
- **Conversation grouping is not what makes the mail screen slow.** The folder
  tree is, and its cost was serialisation rather than volume. Measured, fixed,
  and recorded in `runbook.md` → *The Change Orders screen feels slow*.

Part B extracted one file-access interface with two implementations.
`GraphFileStore` is written and **has never run** — Part C is what selects it,
against a copy, and its open questions are marked `GRAPH-TODO` in place.

Roadmap: `docs/06-roadmap.md`. Do not implement a later phase without being told to.

---

## Working rules

**Before implementing:** read the existing code, follow existing conventions, check
whether the functionality partly exists already.

**After implementing:** run tests, typecheck, lint, verify the build, and state what you
changed and what you verified. Distinguish what you observed from what you inferred.

**One branch per change. Nothing goes straight to `main`.** Branch from an
up-to-date `main`, commit, push, open a pull request, merge, delete the branch.
This applies to everyone, the platform owner included — nobody has a standing
personal branch. `DEVELOPER-SETUP.md` states this for the person; this is the
same rule for an agent working on their behalf.

Name the branch for what the change is:

| Prefix | For |
|---|---|
| `feat/` | new functionality |
| `fix/` | bug fixes |
| `refactor/` | restructuring without changing behaviour |
| `chore/` | tooling, dependencies, config, documentation |
| `release/` | release preparation |

Documentation is `chore/`. There is no `docs/` prefix.

**An agent stops at the push.** Create the branch, commit, push, and report the
branch name — the human opens the pull request.

**Use judgment without asking** on reversible, conventional, low-risk, internal choices.

**Stop and ask** before anything that could touch the existing change-order system,
sends more than one message per human action, weakens either send guard, adds a table
holding mailbox data, requires broader Microsoft permissions, adds long-term
infrastructure, or conflicts with this file.

**Every phase ships operational docs, and that includes module work.** For each new
failure mode: the symptom, the cause, the fix. Written during the phase, in
`runbook.md` — one runbook for the whole platform, organised by symptom rather than
by module, because whoever hits a symptom will not know which module owns it.

The reason is a deadline, not a preference: the current operator leaves in December
2026, and this platform must be operable by someone who has never seen it. A module
whose failure modes live only in its author's head fails that test no matter how
well it is written.

---

## Reference docs

**At the repo root, because they are what somebody reaches for first:**

| File | Contents | Who it is for |
|---|---|---|
| `DEVELOPER-SETUP.md` | **Start here if you are a new developer.** Installs, databases, `.env.local`, seeds, first test run — and the things that bite before they bite | Someone about to write code |
| `PLATFORM-CONTEXT.md` | **Read before designing a module.** What the platform already provides, the four-part integration contract, and the seven decisions a module makes for itself | Someone about to design one |
| `HANDOVER.md` | **Start here if you are inheriting this.** What this is, what must not break, what will fail and when, what to do first | Whoever owns it after December 2026 |
| `WHY-ITS-BUILT-THIS-WAY.md` | **Read before changing something.** 43 decisions, why each was made, and what breaks if you undo it | Anyone changing existing behaviour |
| `runbook.md` | Failure modes, recovery, what expires and when | Anyone with a broken thing |

Setup instructions live in `DEVELOPER-SETUP.md` and the per-variable detail lives
in `runbook.md` → *Filling in `.env.local` on a new machine*. Do not restate
either anywhere else — point at them.

**Reference, in `docs/`:**

| File | Contents |
|---|---|
| `docs/01-vision-and-modules.md` | Product vision, module architecture, UI shape |
| `docs/02-existing-co-system.md` | **What already exists and must not break** |
| `docs/03-exchange-and-graph.md` | Exchange as source of truth, Graph rules and gotchas |
| `docs/04-auth-and-permissions.md` | Login rules, authorization contract, admin security |
| `docs/05-database-and-sources.md` | Schema ownership, migration vs seed, source of truth |
| `docs/06-roadmap.md` | Phases 1–14 |
| `docs/07-conventions.md` | Code, API, errors, logging, secrets, environments |
| `docs/08-bas-and-niagara.md` | **BAS: why the module is shaped this way** — Niagara, oBIX, the roll horizon, headroom |
| `docs/09-bas-what-is-built.md` | BAS: what exists, and which of the two repos owns each piece |
| `docs/12-ai-layer-inventory.md` | **Phase 12: what the change-order engine reads, writes and decides.** The input to every later part |
| `docs/DESIGN-BRIEF.md` | The redesign brief as issued, plus what the build actually chose where the two differ |
| `docs/phase-1-verification.md` | Manual verification record |
| `docs/phase-8-verification.md` | What Exchange actually did for the email actions |
| `docs/phase-9-verification.md` | Grouping, conflicts, and the latency that decides Part B |
| `docs/phase-11-verification.md` | Evidence the platform has not disturbed the automation |
| `docs/phase-12-part-b-verification.md` | The file-access extraction: what was measured, and what is still unproven |
