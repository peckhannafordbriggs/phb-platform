# Roadmap
Two things hold across every phase:

- **Exchange stays the source of truth for mail.** No duplicate mailbox in our database.
- **The Outlook path keeps working.** The platform is an additional client, never the
  only route to change-order work.

---

## Phase 1 — Platform Foundation — COMPLETE

Basic application shell.

- Next.js frontend and API in one project
- PostgreSQL with Prisma migrations
- Environment/secret handling — `lib/env.ts`, Zod-validated at boot
- Sidebar and navigation shell
- Placeholder Home and Change Orders pages
- Structured logging, error boundaries

**Goal:** an empty but functioning company platform. ✔

---

## Phase 2 — Employee Authentication — COMPLETE

- Entra ID SSO via Auth.js. No platform passwords, ever
- Four-check login gate: tenant `tid`, allowed email domain, `#EXT#` guest rejection,
  employee not disabled
- Self-provisioning on first sign-in with zero grants
- Profile completion — name prefilled from token, email locked, position and department
- Sessions, protected pages, protected API, logout
- `sessions_valid_after` so revocation takes effect immediately

**Goal:** employees sign in securely with their existing work account. ✔

Verification record: `docs/phase-1-verification.md`. Four of six manual criteria
observed against real Microsoft tokens; two documented as not reproducible without a
second tenant or a guest account.

---

## Phase 3 — System Permissions — COMPLETE

```
Employee
  Change Orders: YES
  Future System A: NO
```

- `modules`, `module_grants` — the sidebar renders from grants, never a hardcoded list
- Server-side guard on every `/api/modules/<key>/*` route: 404 on a missing grant, not
  403
- Admin screen for granting and revoking
- Append-only audit log, enforced by a database trigger
- 62 automated tests including the negative cases — URL-bypass attempts, revocation
  mid-session, non-admin hitting admin routes

**Goal:** access is genuinely controlled by the backend, not hidden in the UI. ✔

---

## Phase 4 — Microsoft 365 Connection

Connect the backend to Microsoft. No email UI yet.

- Second app registration, separate from SSO — different permission set, so they don't
  share an identity
- Microsoft Graph, **application** permissions: `Mail.ReadWrite` + `Mail.Send`
- Exchange ApplicationAccessPolicy scoping the app to `changeorder@phb1899.com` alone
- Credentials in `.env.local` for development; Key Vault and a federated identity
  credential in production
- One successful Graph call proving the backend can reach the mailbox

The mailbox is a **licensed user mailbox**, shared with the current operator in
Outlook. Settled — no investigation needed.

**Requires:** `Test-ApplicationAccessPolicy` returning **Granted** for
`changeorder@phb1899.com` and **Denied** for any other mailbox. Do not build against
the credential before that output exists — without the policy, those permissions reach
every mailbox in the company.

**Goal:** the backend can securely talk to the real Change Order mailbox.

---

## Phase 5 — Read-Only Change Order Mailbox

First genuinely useful screen. Read-only, because the worst bug in a read-only feature
is showing nothing.

Priority order within the phase — **Drafts and Sent first.** That's the daily job. If
time runs short, ship those two and add the rest in place; no rework, since there's no
local state to backfill.

1. Drafts — list and open
2. Sent Items — list and open, so a send can be confirmed
3. Inbox
4. Folder tree with nesting, including the Projects folders
5. Message read: sender, recipients, subject, body, dates, attachments
6. Pagination and loading older messages
7. Search

Body HTML is attacker-controlled — vendors send it. Sanitize server-side, sandboxed
iframe, remote images blocked by default.

`Prefer: IdType="ImmutableId"` on every request. Message IDs otherwise change when a
Power Automate flow files something, and every cached ID goes stale silently.

**Goal:** stop opening Outlook just to read the Change Order mailbox.

---

## Phase 6 — Drafts: Review, Edit, Send

The actual daily human job and the highest-value part of the platform.

- Open a draft the automation created
- Edit recipients, subject, body; autosave via `PATCH`
- Send with `POST /messages/{id}/send` on the existing draft

Never `sendMail` with a copied body — that loses the attachments Power Automate
attached, the `[CO: Owner|Bulletin]` subject tag downstream filing depends on, and
conversation threading.

Guards: `PHB_ALLOW_SEND` must be true or a send throws; outside production, writes are
permitted only on subjects beginning with `ZZTEST`.

**No bulk send. No send-all. No auto-send. Ever.** A human sending each draft is the
entire safety model of the change-order system.

Before anyone other than the author sends from the platform: send one `ZZTEST` draft
end to end and confirm it lands in `changeorder@` Sent Items in Outlook.

**Goal:** an employee can complete the review-and-send loop without Outlook.

---

## Phase 7 — Deploy to Production

Somewhere other than one laptop, deployed from CI, reachable at a URL.

**See `docs/PHASE-7.md`** — scope, the Part A / Part B split around the Azure
subscription, and the acceptance criteria. Kept there rather than duplicated here, so
there is one source.

**Requires:** an Azure subscription owned by a group rather than an individual, plus
Contributor access on the resource group. Without the second, nothing can be deployed
into it — that permission is routinely forgotten when a subscription is created.

**Goal:** other employees can actually use it.

---

## Phase 8 — Full Email Actions

Turn the mailbox view into a real client. All against Exchange, never a local copy.

- New email
- Reply, reply all, forward — via `createReply`, `createReplyAll`, `createForward`, so
  quoting and threading come from Exchange rather than string assembly
- Add and remove attachments — simple upload under 3 MB, upload session above
- Move between folders
- Delete (to Deleted Items; never expose permanent delete)

**Goal:** normal Change Order email work happens entirely inside the platform.

---

## Phase 9 — Two-Way Sync and Reliability

Make it feel live.

```
Create draft in Outlook  → appears in platform
Edit in platform         → updated in Outlook
Send from platform       → appears in Outlook Sent Items
Move in Outlook          → moves in platform
```

Investigate Graph change notifications versus polling here, and pick based on measured
need rather than ambition. Webhooks bring subscription renewal, a validation handshake,
and dropped-notification reconciliation — real work. At low user counts, polling the
open folder is close to indistinguishable.

Also handle: concurrent edits between Outlook and the platform (last write wins — take
an advisory lock and show it), API failures, rate limits (throttling concentrates on
one mailbox through one app identity), and retry behavior.

### Conversation grouping

Group messages by `conversationId` into collapsible threads, the way Outlook does.

It belongs in this phase because a thread is the unit people actually reason about — "where
did the CCHMC RFI 229 pricing land" is a question about a conversation, not about six rows
that happen to share a subject. A flat list of near-identical subjects is the single most
confusing thing about the current message pane.

**The data is already there.** `conversationId` is selected on every message summary and
has been since Phase 4, so nothing new needs fetching to group a folder that has already
been listed. Phase 8 verified against the live mailbox that `createReply`,
`createReplyAll` and `createForward` all preserve the source `conversationId`, so a draft
the platform creates groups with its own thread without any help.

**It aligns the UI with the automation, which is worth more than it sounds.** Intake 6
matches replies by conversation ID. So grouping by that same key means the platform shows
threads the way the automation files them — and a thread that looks wrong on screen is a
thread the automation will also mis-file. The grouping doubles as a diagnostic for the
filing bug that is otherwise silent.

**The hard decision is folder scope, and it should be made deliberately rather than
discovered.** A conversation spans folders: one thread routinely has messages in Inbox, a
project folder, Sent Items and Drafts at the same time. Two options, and they are
different products:

```
Within the open folder   group the rows already listed — cheap, no extra request,
                         but every thread is partial and says so

Across the mailbox       $filter=conversationId eq '<id>' on /messages — complete
                         threads, one extra request per thread opened
```

**Both were tried against the live mailbox before writing this down**, and the gap is
larger than it looks. One ZZTEST thread returned **1 message** from the folder-scoped
query and **4** from the mailbox-wide one, spread across two folders. Whichever is chosen,
a within-folder group has to say it is partial, because most of the time it will be.

Three things confirmed while checking, all of which the eventual implementation depends
on:

- `conversationId` **is** filterable, on `/messages` and on a folder alike.
- Both forms return **immutable ids**, because `$filter` is an ordinary collection
  request. `$search` would not — see `docs/runbook.md`, *Folder search*.
- `conversationIndex` is populated, so reply nesting is available if it is ever wanted.

And one wrinkle that will otherwise be found the hard way: **a mailbox-wide conversation
query includes Deleted Items.** The test thread's other three messages were drafts that
had been deleted, and they came back as full members of the conversation. Outlook hides
those from its conversation view; the platform will have to decide to as well, or a thread
will show messages somebody deliberately threw away.

`$filter` combined with `$orderby` is refused with `400 InefficientFilter` — the Phase 8
finding — so a thread has to be ordered in-process, exactly as `searchMessages` already
does. That comparator and its "undated sorts last" rule are reusable as-is.

Order within a thread by `receivedDateTime`. `conversationIndex` encodes reply nesting, so
it is the option if a thread ever needs to render as a tree rather than a list — but flat
and chronological is what Outlook shows and what people expect.

**No conversation table.** Grouping is computed from messages read live, like everything
else in this module. `docs/03-exchange-and-graph.md` — no message index, no second copy
of mailbox state; if the grouping cannot be rebuilt from Graph on demand, a mailbox has
been built by accident.

**The CO context panel will want this same grouping.** A change order *is* effectively a
conversation — the thread is the change order's history — so the panel that eventually
shows a draft next to its run report and Q&A log is assembling the same set of messages by
the same key. Build the grouping as a reusable function over message summaries rather than
as state inside the message-list component, and the context panel gets it for free instead
of growing a second, subtly different implementation.

**Goal:** Outlook and the platform behave like two interfaces to one mailbox, and a
change-order thread reads as one thing in both.

---

## Phase 10 — Admin Panel Refinement

The core shipped in Phase 3. What's left is scale and polish.

- Search, filters, pagination at real volume
- Bulk grant and revoke
- Positions and departments management
- Audit log views

Note the onboarding model, which differs from a conventional admin panel: **there is no
create-employee function.** Anyone with a company account can sign in and gets a row
with zero grants. Admins grant access; they don't create accounts.

```
Sarah signs in          → row created, empty sidebar
Admin toggles Change Orders ON
Sarah's next request    → Change Orders appears
```

No Claude configuration. No SharePoint connection. No Power Automate setup on Sarah's
computer.

**Goal:** onboarding is centrally managed and takes one toggle.

---

## Phase 11 — Verify the Existing Automation Still Works

Mostly a verification phase, not a build phase. The platform and the flows never talk
to each other — both talk to Exchange and SharePoint. That independence is what makes
this safe.

```
Existing automation → creates Outlook draft → Exchange
                                                 ↓
                                          Platform sees draft
                                                 ↓
                                          Employee reviews → sends
```

Confirm end to end that the 11 Power Automate flows, the SharePoint structure, inbound
email processing, folder organization, and the two morning scheduled tasks all continue
untouched while employees use the platform as their interface.

**Goal:** the platform coexists with the existing automation, provably.

---

## Phase 12 — Centralize the AI Logic

Reproduce the current AI behavior in the backend without changing the employee
experience. **Do not shut down the existing setup during this phase.**

Inventory what the Claude layer does today: project instructions, the two scheduled
prompts, SharePoint access, decision logic, draft generation, language review,
classification.

Then translate:

```
Project instruction  → versioned prompt in the repo, loaded from the database
Claude desktop app   → Claude API from a Python worker
Local folder access  → Graph Files against the same SharePoint library
```

The hard part isn't the API. It's that `run_workflow.py` is ~196 KB of proven logic
reading a locally-synced OneDrive folder with Windows paths. Extract a file-access
interface first, keep everything else unmodified, containerize, then **shadow-run
against a copy** and diff the outputs — sentinel JSON, `state/*.json`, run reports —
against the real runs for weeks before cutover. Never run both against live: the lock
file and duplicate detection make double-running dangerous.

Prompts move to the repo as source of truth **only at cutover**, with the SharePoint
copies re-labeled as mirrors the same day. Two authoritative copies is the failure
this project exists to prevent.

**Goal:** the AI logic runs centrally and produces identical output.

---

## Phase 13 — Centralize the Scheduled Jobs

Move the two morning tasks off a personal laptop.

```
Scheduled time → backend job → gathers CO state and email context
              → Claude API → determines action
              → writes the sentinel file → Power Automate creates the draft
              → draft appears in the Change Orders tab
```

Add: job history, success/failure status, retries, duplicate prevention, and **an alert
when the morning run doesn't happen.** That last one fixes the documented failure mode
where the pipeline goes quiet with no error anywhere.

Single-fire semantics via a Postgres advisory lock, replacing the current lock file.

Worth doing independently and early, well before this phase: move the two scheduled
tasks to an always-on host with no code change at all. It removes the single largest
point of failure in the current system and costs a day.

**Goal:** the automation runs whether or not anyone's laptop is on.

---

## Phase 14 — Cutover and Production Hardening

Prove the centralized version is correct, then retire the old path.

```
CO email arrives → Power Automate runs → SharePoint updated
   → scheduled AI processing → Claude API generates the draft
   → draft created in Exchange → employee reviews and sends
   → Exchange sends → appears in Sent Items
```

Then: audit logs, error monitoring, security and permission review, backups,
failed-job alerts, email action logging, AI execution logs, release process, recovery
procedures.

Retire the laptop-dependent workflow only after the centralized version has run
correctly in parallel for a sustained period. Keep the old path documented as rollback
for at least a month after cutover.

**Goal:** Change Orders is a genuinely centrally hosted company system.

---

## Migration principle

```
Existing working system
    ↓
Build the platform beside it
    ↓
Prove the employee workflow
    ↓
Integrate the automation
    ↓
Centralize the AI
```

No big-bang rewrite. At every point along the way, the Outlook path still works.