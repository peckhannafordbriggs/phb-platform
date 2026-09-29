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

**Production sign-in was tested on 2026-09-16 and failed as predicted** —
`invalid_client` at the token exchange, because production carries no SSO
secret and the SSO app registration is a confidential client. The decision
went the way prohibition 7 points: **not** a secret in Azure, but the managed
identity's token presented as a `client_assertion`, matched by a federated
identity credential on the SSO app registration — the same mechanism the Graph
module already uses, now one shared implementation in
`lib/azure/managed-identity-assertion.ts`. Merged 2026-09-17 (PR #8).
Production refuses to boot if `AUTH_MICROSOFT_ENTRA_ID_SECRET` is set. The
logo (`public/`) fix shipped separately.

**Vitis added the SSO federated credential on 2026-09-28, and sign-in still
failed as `invalid_client`.** The log could not say why: Auth.js discards
Entra's error body when it builds its error, so the AADSTS code never
reached the log, and neither the Entra sign-in logs nor `az containerapp
exec` were available to this account. The platform now logs the code itself,
from the one place that still sees the body (`lib/auth/entra-token-error.ts`,
`auth.entra_token_error`). The first deploy of that logging showed the
assertion wrapper **had never run**: the Entra provider ships a `customFetch`
of its own, and Auth.js keeps it over one passed as an option, so every
production token request since the 17th went out with no assertion
(`AADSTS7000218`). The wrapper is now set on the provider object, composed
over Auth.js's own fetch, and the test resolves the provider through Auth.js's
real `parseProviders`. **Built on `fix/sso-provider-custom-fetch`; whether it
signs in is not yet observed.** `WHY-ITS-BUILT-THIS-WAY.md` § 56;
`runbook.md` → *Production sign-in bounces to
`/signin?error=OAuthCallbackError`*.

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
`GraphFileStore` is written and **has never issued an HTTP request** — its open
questions are marked `GRAPH-TODO` in place.

**Part C is underway, and it is far less blocked than `docs/PHASE-12.md`
implies.** That doc says Part C needs `Sites.Selected`; read literally it
blocks the whole part on a request to Vitis, and it does not — that permission
gates talking to one SharePoint site with an *application* identity, which is
the last step, not the first. The engine is containerised, and running the Part
B differential inside it settled three things Part B could only infer: the
engine runs on **Linux** with all eight COs still equivalent; the `NEWLINE`
prediction holds; and the `Z`-suffixed timestamps are measured — the laptop
emits local time labelled UTC, the container emits real UTC, so the same event
stamps four to five hours later after cutover, in three fields, two of which
are inside `scrub_result.json` and `vendor_drafts.json`.

That run also found a defect in the differ itself: `normalize_text` erases line
endings **and** timestamps, so a timestamp-only difference was reported as
*"differs only in line endings"* — in a file with no CR byte. Fixed, with the
classes split, because Part E is nothing but weeks of difference
classification. `docs/phase-12-part-c-plan.md` is the reasoning and the
blocked/not-blocked split; do not re-derive it from `PHASE-12.md` alone.

**The BAS collector's first sync takes everything, and every pass checks that
it did (2026-09-17).** The first sync of PHBoffice reported 28/28 points ok with
four points at zero records: the collector's first-sync window was 30 days and
those change-of-value histories had gone quiet 35 days earlier. Now a point with
no checkpoint starts at the station's own oldest record and pages by `limit`,
and every pass compares the station's reported count with what the platform
holds, recording `complete` / `backfilling` / `incomplete` / `unknown` on
`bas_sync_checkpoints` and making a run with an incomplete point `partial`. The
columns are this repository's (`add_bas_completeness`); the logic is the
collector's (`phb-bas`). **Apply both migrations before updating the
collector** (`add_bas_completeness`, `add_bas_measured_horizon_and_visibility`)
— it refuses to run on a schema missing either. `WHY-ITS-BUILT-THIS-WAY.md`
§ 44; `runbook.md` → *A BAS run says `ok` and a point holds nothing*.

Same day, four amendments from the first live result: the query has **no upper
bound**, because the PHBoffice JACE's clock is 22 minutes ahead of the host and
a host-bounded query hid its newest records (the offset is now measured every
pass and recorded on `bas_stations`); the roll horizon is **measured** from a
full buffer's span and preferred to capacity × interval, so a change-of-value
point needs only `capacity`; the verdict is **read** by the view, the health
screen and `healthcheck.py`; and a `--only` filter that matches nothing on a
station skips it rather than recording a fake failed run. Fixing the JACE's
clock is a station change and is open. `runbook.md` → *A BAS station's clock is
wrong*.

**B8.1 complete — the point-management schema, and nothing else (2026-09-17).**
`bas_points` gained `label` (what a person calls a point) and `is_visible`
(whether it appears on the browsing screens), both defaulting to how every row
behaves today. The distinction that must not blur: **`is_active` is whether the
collector fetches a point, and turning it off loses data permanently;
`is_visible` is whether a screen shows it, and costs nothing.** Collect
everything, filter what you see. The column comments say so and a test asserts
the wording. The `display_name` trap — a person's name on stations, Niagara's
on points — was resolved with a new column rather than a rename, because the
collector writes the point column by name and a rename would fail every
collector pass until phb-bas caught up; the Prisma field is
`niagaraDisplayName` so TypeScript reads correctly. **`discover` never writes
either new column**, proven by `test_point_management.py` *(phb-bas)* against
the real migration on a throwaway cluster. No screen, no API; B8.2 onward not
started. `WHY-ITS-BUILT-THIS-WAY.md` § 45; `runbook.md` → *A point's label or
hidden state disappeared*.

**B8.2 complete — the read-only Points list (2026-09-17).** Expanding a station
in Settings lists its points: label, Niagara name, the station's own name for
it, role, equipment, collected, completeness, visible. Loaded on expansion from
`GET /api/modules/bas/settings/stations/{id}/points`; the count on the station
row is a joinless count inside the tree query, so it is right without anyone
expanding. **Uncollected points are shown**, with the reason beside them in
plain words (next entry). **The list carries its own counting guard** — `rendered` from the joined query
against `inDatabase` from `count(*)` with no joins, red on screen when they
disagree — and six mutations of the query each fail the test. No filtering on
`is_visible`, no editing, no search; the six views, Point Explorer and
Collection Health are untouched. Org scoping is a source-text assertion only,
recorded in `docs/testing-blind-spots.md`. `runbook.md` → *The Points list says
it could not place N points*.

**Why a point is not collected is now recorded (2026-09-17).**
`bas_points.inactive_reason`, five values closed by a CHECK —
`niagara_system_log`, `alarm_history`, `reconfigured_cfg0`, `manual`,
`no_longer_reported` — and a second CHECK forcing it NULL whenever `is_active`
is true, so a row cannot claim a reason for being off while it is on; anything
that reactivates a point clears the reason in the same statement.
**`Global_Alarm` is `alarm_history`, never a system log**: it is building data
that needs its own table, excluded later and deliberately. The migration
backfilled the nine inactive points on live by exact name and `_cfgN` suffix
and reports what it left. The collector *(phb-bas)* writes the reason at both
places it deactivates a point, defines the values once in
`collector/reasons.py`, and its `test_inactive_reason.py` reads the CHECK back
out of the catalog to prove the two sets match — as does
`tests/bas-schema.test.ts` for the TypeScript copy. One behaviour change rode
in with it: a point marked `manual` or `reconfigured_cfg0` **stays off across
a rediscovery**, where before the collector re-activated every history the
station reported. **Deploy the platform migration before the collector.**
`runbook.md` → *A point reads "Not collected", and what the words beside it
mean*.

**`add_bas_comments` was not the trap it looked like.** Live's
`_prisma_migrations` has it twice: rolled back at 15:13 on 21 August, re-applied
at 15:14 — Prisma retries a rolled-back migration on the next deploy. Live and
a fresh database carry the identical 45 column comments. What is true of it is
true of every applied migration: edits never reach a database that has applied
it. `20260917235000_restate_bas_comments` re-states the whole set as the
convergence point, and a `README.md` beside the old file says do not edit it —
beside, not inside, because `prisma migrate dev` treats a changed checksum on an
applied migration as grounds to reset the database. `runbook.md` → *A
migration marked `rolled_back` on live*.

**`migrate dev` has a database of its own, enforced by the CLI (2026-09-17).**
Locally `DATABASE_URL` is the database the collector writes — 44,750
`bas_readings` rows, back to February 2024, most gone from the JACE — and
`prisma migrate dev` pointed at it until Prisma offered to reset it.
`prisma.config.ts` now routes `migrate dev`, `migrate reset` and `db push` to
`MIGRATE_DEV_DATABASE_URL` and refuses them if it is unset, remote, the same
database as `DATABASE_URL` or `TEST_DATABASE_URL`, or holds any `bas_readings`
row; everything else, `migrate deploy` included, still reads `DATABASE_URL`,
so CI and deploy are untouched. Verified against the live database: both
commands refused with the row count, and `migrate dev` against the empty
`phb_platform_dev` applied all 17 migrations. **The guard is in the config,
not an npm script, because the CLI cannot connect without loading it.**
Prisma 7 separately halts `migrate reset` when run by an AI agent and asks
for a consent variable; a person runs that command, the agent does not supply
the variable. The collector side was checked too: `bas_collector` is DML-only
on `bas_*` and has no grants on the dev database. `WHY-ITS-BUILT-THIS-WAY.md`
§ 46; `runbook.md` → *Which command touches which database*.

**B8.3 complete — show/hide, and the risk rule (2026-09-18).** The *Shown*
checkbox on the Points list is editable: `PATCH /settings/points/{id}` with
`{ visible }`, one field, no `isActive`, audited as
`bas.point_visibility_changed` with `collected` recorded beside it. A hidden
point leaves the Point Explorer picker and the Collection Health table and
**nothing else** - it stays in every risk figure and completeness count, the
totals never see `is_visible`, and `describeHiddenRisk` was extended rather
than duplicated: *"No points at risk are listed in the table below, but 1
hidden point is at risk."* Tested by hiding the only at-risk point in a
building. `is_visible` is in none of the six views, on purpose.

**A hole predating B8.3, found and closed the same day:** every Collection
Health figure was `FILTER (WHERE is_active)`, so the collector marking a
vanished history `no_longer_reported` **removed it from the at-risk count** -
a deleted trend made the dashboard look better. Verified on live inside a
rolled-back transaction (6 → 5). Such points are now counted on their own
line and listed by name with their last record in an always-rendered card,
not folded into the at-risk hero; the four deliberate reasons stay out of
every figure. Both rules were mutation-checked. In phb-bas the same day: the
reconfigured-pair message now reads both halves' state from the database
(both active / resolved / exactly what was found) instead of asserting
"BOTH are registered and active" blind, and the skipped-folder line says
that `RV` may be a separate controller needing its own station row.
`runbook.md` → *Collection Health counts a point its table does not list*,
*Collection Health says a point is no longer reported by the station*.

**Roll-horizon reporting: three distinct states, and the shortest span
(2026-09-18).** Read against live: eight office points with capacity 500 and
no interval, all change-of-value trends. Six had never filled their buffer
(`OperatingState` 320/500 over 2.5 years) and read `roll_horizon_unknown`
beside an instruction to fill in an interval that does not exist; two were
full and rolling, and the same `Unit_Status_Mode` that measured about two
hours on the 17th measured ten on the 18th, because a COV point's span is how
hard the equipment cycles - storing the latest reading let a quiet afternoon
erase the evidence. Now: **configured** (capacity x interval), **measured**
(the buffer has been seen full; the horizon is the **SHORTEST** full-buffer
span ever observed, `bas_sync_checkpoints.shortest_full_span_s`, written as
`LEAST(existing, new)` by the collector every pass and LEAST-ed again with
the current span by the view; the current span is shown beside it), **not
full yet** (`roll_risk = 'buffer_not_full'`, count below capacity, nothing
overwritten, informational, in no risk figure, says how full - 320 of 500),
and **unknown** (capacity not recorded or no count from the station; still
amber). Backfilled from the one observation held; the value can only get
shorter and a person may lower it, never raise it; the one reset is a capacity
change on the station. **No code path suggests filling in an interval for a
change-of-value point**: the collector words the unknown warning from the
spacing of the readings it holds and stops when that spacing is uneven, and
its `implied_interval_s()` guess is gone. Wherever a horizon is shown - sync
output, `healthcheck.py`, Collection Health, the Points list - the three
states are named distinctly. Every rule was mutation-checked, including the
shortest-span logic replaced by the latest value. **Deploy the platform
migration (`add_bas_shortest_full_span`) before the collector.**
`WHY-ITS-BUILT-THIS-WAY.md` § 48; `runbook.md` → *The roll horizon column
shows two numbers*, *A point reads "Not full yet"*.

**One at-risk predicate (2026-09-18, same day).** The live screen read *"4
more points are at risk but hidden"* over *"0 — Nothing at risk"*: the tile
counted from `AT_RISK_ROLL_RISKS` and the hidden-point sentence counted
`roll_risk <> 'ok'` in SQL, and the roll-horizon change had moved only the
first. Two more private definitions were found (the headroom badge's unknown
share, the "N of M reporting" ratio). All of them now call `isAtRisk` /
`atRiskCount` over the one list in `lib/modules/bas/types.ts`; the only SQL
predicate left is generated from it. `tests/bas-at-risk-predicate.test.ts`
drives every surface from one fixture holding every horizon state and fails
if the list literal appears anywhere else or any source decides from `ok`.
Do not write `roll_risk <> 'ok'` or `risk === "ok"` to mean "at risk" - ever.
`runbook.md` → *Collection Health says N points are at risk but hidden, over a
tile that says none are*; `WHY-ITS-BUILT-THIS-WAY.md` § 49.

**Home dates itself from activity, not authentication (2026-09-18).** The
greeting read "Last signed in on Monday" all week because a session lasts
days and `previous_login_at` is the sign-in before the current one. Two new
columns on `employees`: `last_active_at`, the live value, written by
`requireAuthenticated` on deliberate page loads and navigations only,
throttled to one write per five minutes; and `previous_active_at`, the
**anchor**, frozen for a calendar day (**America/New_York**, never UTC) and
the ONLY value the greeting and digest read. **Do not read `lastActiveAt` on
Home** - the window collapses to zero and the digest empties silently; a
source-text test and a CHECK (`employees_previous_active_before_last`) both
refuse it, and the mutation was run: eight tests fail. Background polls are
not activity because they go to `/api/*`: the middleware stamps
`x-phb-page-request` from the **pathname** and the guard reads only that.
**Not from headers** - Next hides `rsc` and `next-router-prefetch` from both
the middleware and a render, which an end-to-end test over a socket found
after the unit tests had passed. Prefetches are excluded by structure: a
prefetch never renders past a `loading.tsx`, so `AppShell` is the one caller
passing `recordActivity: false` and every page's own guard call records. A
NULL anchor renders nothing - no "first time here". Wording: "You were last here yesterday at 4:52
PM", and the digest heading carries the same phrase. The login columns are
unchanged and remain the audit record. `lib/activity/`;
`WHY-ITS-BUILT-THIS-WAY.md` § 51; `runbook.md` → *Home*.

**B5 complete — the Analyze tab (2026-09-21).** A question box over the
sensor data, at `/bas/analyze`, between Point Explorer and Settings. The
model writes ONE `SELECT`; it runs as a dedicated PostgreSQL role
(`bas_analyze`, `npm run bas:analyze:role`, same allowlist shape as
`bas_readonly_platform`, credentials table withheld) inside a `READ ONLY`
transaction, as the body of a cursor, over the **extended protocol** — that
last word is load-bearing: `pg` falls back to the simple protocol when the
bind array is empty, and the simple protocol ran a smuggled second statement
until a test tried it. Statement timeout 15s, row cap 200, six questions a
minute per employee. **Provenance is computed by our code after the query
runs** — gap hours clipped to the resolved range from `bas_data_gaps`,
unknown-horizon points from `horizon_state = 'unknown'`, coverage from
`bas_readings` — and rendered on every result, never collapsible. **Zero
rows is not zero:** a result with no rows, or one row that is all NULL, is
its own `no_data` kind, the summariser is never called for it, and the
explanation is written from coverage. Every question is one audit row
(`bas.question_asked`) and one log line, both carrying the question and the
SQL. Two variables, both lazy: `ANTHROPIC_API_KEY` and `BAS_ASK_DATABASE_URL`;
missing either renders a not-configured state. Neither is in
`infra/main.bicep` yet.

**Verified live the same day, once a working key arrived**, and the live
runs found three things a scripted planner could not: the widening rule
keyed on `bas_readings` rather than on a declared period, so a gap question
over `bas_data_gaps` showed *Scope: none, Gaps: NOT COMPUTED* beside a
resolved range; the model wrote `now() - interval '30 days'` and declared no
range, so nothing widened at all; and a 30-day average came back from ten
days of readings with only the model happening to mention it. All three are
now the platform's: a declared period widens on its own, a time expression
with no declared range is sent back once and then flagged *Period not
stated*, and **`coverageShortfall`** compares the range with `min(ts)` /
`max(ts)` and renders amber on every answered result — *"Any figure above
describes 10 days of the 30 days asked about."* `npm run bas:analyze:verify`
asks a building-specific 30-day average precisely because that is where the
silence is dangerous, and fails the run on either fault.
`docs/bas-b5-verification.md` is the record, results pasted verbatim.
`WHY-ITS-BUILT-THIS-WAY.md` § 52; `runbook.md` → *Analyze*.

**Point Explorer takes a custom date range, in the building's zone, and
averages long ranges out loud (2026-09-22).** *Custom* beside the three
presets opens two date inputs; year buttons are offered for every calendar
year that holds readings, derived from the data, and the current year's ends
today. The dates travel as `YYYY-MM-DD` text and **PostgreSQL resolves them
against `bas_sites.timezone`** — midnight to midnight where the building is,
end exclusive, so a single day is the whole day and 9 March 2025 is 23 hours
long. The screen names the zone. The office station's 22-minute clock offset
is stated beside the range and **not** corrected for. **Up to 10,000 readings
are drawn raw; past that the trend is bucketed** on a fixed ladder (5 min to
a day, day-buckets on local midnight) and drawn as an average line with a
lowest-to-highest band, under a sentence that says so. The cap is a
**measurement**, not a guess: the real chart in headless Chrome over the
DevTools protocol on real readings — under 400 ms to draw and to zoom at
10,000, half a second per zoom from 18,000, a 2.7 s hang at 70,000 — and the
table is beside the constant in `lib/modules/bas/range.ts`. A range with no
readings names the nearest data instead of drawing an empty chart; one that
starts before the data says where the data begins; the recorded gaps from
`bas_data_gaps` are outlined on the chart. **Collection Health keeps its
presets**: its range scopes only run history and the screen spans buildings,
so there is no single zone to resolve a date in. Tested over **real
readings** committed as fixtures (`tests/fixtures/bas-live-*.json`): the
11–12 September hole, a range from before the first reading, an empty
December, the 23-hour day, and the −40 °F sensor fault of 24 August surviving
into the band; the mutations that drop min/max, assume 24-hour days or cut
day-buckets with `date_bin` each fail a named test.
`WHY-ITS-BUILT-THIS-WAY.md` § 53; `runbook.md` → *The trend chart says
"Averaged to one point per …"*, *A custom date range is refused*, *Which
time zone a Point Explorer date range is in*.

**The per-point table on Collection Health scrolls (2026-09-25).** About
seven rows, then scroll within the panel - the same `max-h-72
overflow-auto` box with a sticky header the collector-runs and data-gaps
tables use, not a second pattern - with the row count in the heading. Every
row stays in the DOM and **no figure reads the viewport**: tiles, the
hidden-risk sentence, the reporting ratio and completeness are the service's
numbers over every active point, proved in
`tests/bas-health-point-table.test.ts` with 26 points where the box would
show seven. At hundreds of points the answer is virtualisation, not a
smaller cap or paging; `runbook.md` → *The per-point table on Collection
Health is slow* carries the chart's 10,000-item knee as the reference to
measure against.

**B8.4 complete — editable labels, one precedence, three-name search
(2026-09-25).** The *Label* cell on the Points list is editable; `PATCH
/settings/points/{id}` takes `{ label }` or `{ visible }`, **one per
request**, through a strict schema that refuses any other key - `isActive`
and `niagaraHistoryName` are 422, not stripped. Audited as
`bas.point_label_changed` with previous and new label and the oBIX key. A
point's three names have a precedence, **label → Niagara's `display_name` →
`niagara_history_name`**, and the browsing screens (Point Explorer picker
and selected point, Collection Health table, gaps, vanished points) show the
first that exists through ONE fragment, `shownPointName`; a source-text test
fails on a bare `point_name` in a SELECT or ORDER BY in `service.ts`.
Settings shows all three - the key is what you match against Workbench, and
it is editable nowhere. **The six views were not changed**: `point_name` in
`bas_v_*` is still Niagara's, for Grafana, `healthcheck.py` and the model's
SQL; a label is a preference of the platform's screens, the same class as
`is_visible`. Search - the Settings box and one on the Points list - matches
all three names, so a name pasted from Workbench (`$2d` and all) finds a
point the screen calls something else, and the list opens narrowed to the
tree's term. **The fallback is the normal path**: every real point has
`label` NULL and both real stations have `display_name` NULL, so
`tests/bas-point-label.test.ts` asserts every screen with no labels first,
then with Niagara's name nulled, then the station fallback, and seeds a
label only after. `discover` still never writes `label`:
`test_point_management.py` *(phb-bas)* was re-run against this checkout,
27/27. The "six hidden points" were answered from the audit log: every hide
was the B8.3 checkbox on 18 September, and one point is hidden today;
nothing else in either repository writes `is_visible`. Roles, equipment and
bulk actions are B8.5. `WHY-ITS-BUILT-THIS-WAY.md` § 54; `runbook.md` → *A
point has one name in Point Explorer and another in Settings*, and *Who hid
it, and when* under *A point's label or hidden state disappeared*.

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

**`main` is protected by a repository ruleset** — pull request required, no
force-push, no deletion — and the ruleset is authoritative. Where this file and
the ruleset disagree, the ruleset wins and this file is what is out of date.

**The owner holds bypass rights, and they are for emergencies.** A broken
`main`, a revert that cannot wait. Not for routine work, not for a change that
seems too small to be worth a PR, and never on an agent's own judgment.

The trap is that **bypassing does not fail**. A direct push to `main` prints

```
remote: - Changes must be made through a pull request.
```

and then **succeeds**, which reads like a warning and is not — it is the
protection being overridden. On 2026-09-22 an agent pushed documentation to
`main` that way, having acted on a "commit straight to `main`" rule that
predated the ruleset. Nothing looked wrong at the time. If you see that line,
say so plainly instead of treating the exit code as permission.

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
| `WHY-ITS-BUILT-THIS-WAY.md` | **Read before changing something.** 49 decisions, why each was made, and what breaks if you undo it | Anyone changing existing behaviour |
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
| `docs/phase-12-part-c-plan.md` | **Part C: what `Sites.Selected` actually blocks**, what it does not, and what has already been settled by measurement |
