# Why the platform is built this way

*The decisions behind the design, why each one was made, and what breaks if you undo it.
Written August 2026, covering the platform, the Change Orders module through Phase 11, and
the BAS module through B4.*

`README.md` tells you how to run this. `docs/runbook.md` tells you what to do when it
misbehaves. **This page is for when you want to change something** — because most of what
looks odd here is odd on purpose, and nearly every item below was decided after something
went wrong.

Read it before your first change. Not because the reasoning is sacred, but so you know
which rope you're pulling on.

It deliberately mirrors `08 WHY ITS BUILT THIS WAY.md` in the Change Order handoff set.
That document is about the automation; this one is about the platform. If you've read that
one, this format will be familiar.

---

# Part 1 — Platform-wide

## 1 · Two modules, two very different relationships to their data

The platform hosts two modules, and the single most important thing to understand before
changing anything is that they are **opposites** in one specific respect.

| | Change Orders | BAS |
|---|---|---|
| Source of truth | **Exchange.** Always | **This database.** Past ~42 hours, the only copy in existence |
| What we store | Nothing about the mailbox | Everything, permanently |
| If the platform dies | Outlook still works | Data is destroyed at the source, unrecoverably |
| Backups | Irrelevant | A correctness requirement |

A rule that is right for one is wrong for the other. When you read a decision below, check
which module it belongs to before generalizing it.

## 2 · Change Orders: the platform is never the only way to do the work

**The decision.** Outlook remains a fully functional path to `changeorder@phb1899.com`,
permanently. Nobody's mailbox permission is removed because the platform exists. No
feature is built that the platform is the sole route to.

**Why.** The change-order process runs daily and the business depends on it. A platform
that becomes load-bearing is a platform whose outage stops work — and this one was built by
an intern on a four-month clock with no confirmed maintainer afterward. With Outlook
intact, the worst case is "the platform was down for a week and the change orders went out
anyway."

**If you undo it.** You convert every platform bug from an inconvenience into a work
stoppage, on a system nobody may be maintaining.

**Watch for.** This is why the CO context panel was cut. The most attractive feature
proposed, and the only one with no Outlook equivalent — meaning people would have come to
depend on it. Deliberately not built.

## 3 · BAS: the platform *is* the only route, and that is not a mistake

**The decision.** BAS data is stored in the platform database permanently, and past the
roll horizon it is the only copy anywhere. No re-import, no vendor archive, no
station-side backup.

**Why this overrides the don't-duplicate rule.** The general rule is: before creating a
table, ask who the authoritative owner of that information is, and if it isn't the
platform, don't store it. For BAS the honest answer is that the JACE keeps roughly 42
hours and then **destroys its own history silently**. There is no upstream to defer to. The
choice isn't "store it or read it live" — it's "store it or lose it."

**Three consequences, none optional.**

- Backups are a correctness requirement, not hygiene. `Backup-BasDatabase.ps1` and
  `Test-BasRestore.ps1` (in `phb-bas`) are load-bearing.
- Anything reading BAS data for analysis connects as a role with **no write permission**.
- `--truncate-target`, or any manual `DELETE`, needs a verified backup first.

**And it is why the Azure database must never be stopped.** The container app can scale to
zero freely. A stopped database means the collector cannot write, and everything past ~42
hours is destroyed at the station while nothing is watching. Overnight is survivable. A
weekend — about 61 hours — is not. This has already happened once: a closed laptop over the
weekend of 21–24 August cost 22.6 hours per point.

**If you undo it,** you need a different place for the data to live, not no place.

## 4 · Employees self-provision. Admins grant; they never create.

**The decision.** Anyone with a company account can sign in. First sign-in creates an
employee row with **zero grants** and sends them to profile completion. There is no
create-employee endpoint anywhere.

**Why.** The onboarding goal was "sign in → admin grants access → done" without an IT
ticket per person. Self-provisioning gets there with less: no directory sync, no user
picker, no `User.ReadBasic.All` permission. The admin screen then manages a list populated
by real usage rather than one someone has to keep in step with HR.

**Why it's safe.** A row with no grants sees an empty sidebar and can reach nothing. The
login gate has already rejected anyone outside the tenant, outside the allowed domains, or
holding a guest account.

**Watch for.** The admin list accumulates everyone who ever signed in out of curiosity.
That's why it defaults to filtering on "has at least one grant."

## 5 · Guest accounts are rejected explicitly

**The decision.** The login gate rejects any UPN containing `#EXT#`, on top of checking the
tenant ID and the email domain.

**Why.** B2B guests — vendors, consultants, anyone invited to a Teams channel or SharePoint
site — have real accounts *in your tenant*. A single-tenant app registration does not
exclude them. Without this check, a vendor invited to a SharePoint site can sign into your
internal platform.

## 6 · Grants are read from the database on every request

**The decision.** Module grants never appear in a session token or JWT claim. Every module
route loads them fresh. A cache of a few seconds is acceptable; longer is not.

**Why.** Access changes regularly. If grants are baked into a token at sign-in, revoking
access does nothing until that person signs out, which could be days. Revocation is the
security-relevant event, not granting.

**Supporting mechanism.** `employees.sessions_valid_after` is bumped on disable, and any
session issued before that timestamp is rejected — so disabling takes effect on the next
request, not the next login.

## 7 · A missing grant returns 404, not 403 — and nothing may leak around it

**The decision.** A request to a module route without the grant returns 404. Admin routes
are the exception and return 403, since admin isn't a module.

**Why.** 403 confirms the module exists. Someone probing `/api/modules/payroll/` shouldn't
learn whether a payroll module is being built.

**The subtlety BAS surfaced.** There is deliberately **no Next.js layout wrapping the BAS
tabs**. A layout renders *around* a page that calls `notFound()`, so an ungranted employee
would have seen the module heading and tab bar wrapped around a 404 — confirming the
module's existence to exactly the person it's hidden from. The 404 has to be the whole
response, not the middle of one.

**Watch for.** Both modules have a test that walks their route directory and fails any
handler missing the guard wrapper. Keep those.

## 8 · Migrations contain no email addresses

**The decision.** Schema and reference-data deletion live in migrations. Employee rows and
admin flags live in the seed, driven by `BOOTSTRAP_ADMIN_EMAIL`. One person's profile lives
in the admin screen.

**Why.** A migration with an address in it runs on every future database. A rebuild in 2028
would resurrect a bootstrap admin list that had changed, or remap a specific person who may
no longer exist.

**How it was found.** One migration hardcoded four addresses, and a grep found the same
pattern in two others. All three were removed while a local reset was still cheap — Prisma
checksums a migration once applied, so editing one later forces a database reset.

**Watch for.** The seed creates missing rows and leaves existing ones alone, with one
exception: if there are zero active admins anywhere, it restores the flag. That's the
lockout the list exists for. An earlier version set `isPlatformAdmin: true`
unconditionally, which meant every deploy silently re-promoted anyone demoted through the
UI.

---

# Part 2 — Change Orders

## 9 · Exchange is the source of truth. There is no message index.

**The decision.** Every read goes live to Graph. No table stores messages, folders, delta
tokens, or subscriptions. Bodies and attachment content are never persisted. The only
mailbox-adjacent table is `draft_locks` — an id, a holder, an expiry.

**Why.** A local copy of a mailbox is a second mailbox, and two mailboxes disagree. The
automation moves messages several times a day, so anything cached is stale within minutes.
Worse, a stale message list during a review means acting on a draft that's already gone.

**The test.** If the mail module's tables can't be dropped and rebuilt from Graph with no
loss, a second mailbox has been built by accident. (Note this test does **not** apply to
`bas_*` — see #3.)

**The one exception.** Folders are cached in memory for 30 seconds. A cold walk is 11 Graph
requests and ~1.3 seconds, and a stale folder list is cosmetic. Message lists are
explicitly not cached, and a test asserts four message reads make four requests.

## 10 · App-only auth, fenced to one mailbox

**The decision.** One Entra app registration holds Graph `Mail.ReadWrite` and `Mail.Send`
as **application** permissions, scoped by an Exchange ApplicationAccessPolicy to a
mail-enabled group containing only `changeorder@phb1899.com`.

**Why app-only.** Delegated auth needs every employee granted mailbox permission
individually — recreating the per-person setup the platform exists to eliminate. And a
scheduled job needs a token when nobody is signed in.

**Why the fence is not optional.** Application-level `Mail.ReadWrite` reaches **every
mailbox in the tenant** by default. That's how Microsoft grants it. The access policy is
the only thing making this app safe, and it was verified empirically: `Granted` for
`changeorder@`, `Denied` for another user's mailbox.

**What it costs.** Exchange records the *application* as sender, not the person. The
platform's `mail.sent` audit row is therefore the only record of who sent a message. Treat
it as a deliverable, not as logging.

**Watch for.** The credential has no SharePoint access at all — 403 on everything. Correct
today. A future phase needing SharePoint requires a new consent grant with
`Sites.Selected` on the AISandbox site only.

## 11 · Nothing is ever sent automatically

**The decision.** Every outbound message is created as an unsent draft and sent by a human
who has read it. `sendMail` appears nowhere. No bulk send, no send-all, no multi-select
send, no "send and next", no scheduled send. Reply, forward and compose all create a draft
first and send from it — so even a message a human writes from scratch exists as a
reviewable draft before it goes.

**Why.** Inherited directly from the automation, where it's decision #1, and the reasoning
transfers exactly: the failure mode of every upstream bug becomes "a draft sat there and
nobody sent it," which is visible and harmless. The alternative — mail to a vendor with the
wrong scope — cannot be recalled.

**If you undo it.** You trade a fully reversible failure for an unrecoverable one, on a
system whose characteristic bug is silently wrong data. If the goal is less clicking, make
review faster; don't remove the human.

**Watch for.** Phase 8 was where this was most tempting — a mail client naturally wants a
multi-select toolbar. Conversation grouping is display-only for the same reason: the moment
a thread can be acted on as a unit, one action can send several messages.

## 12 · Two send guards, enforced in the service

**The decision.** `PHB_ALLOW_SEND` must be `true` or a send throws, before any network
call. Outside production, writes are permitted only on messages whose subject begins with
`ZZTEST`. Both live inside the mail service, not in route handlers.

**Why in the service.** A guard in a route handler protects that route. A guard in the
service protects every call site, including ones written later by someone who didn't read
this document.

**Why the subject comes from Exchange.** An earlier design took it from the caller, meaning
a caller passing `"ZZTEST"` as an argument opened the fence. `assertWritable` now fetches
the subject from Exchange and tests that.

**Why "begins with" and not "contains".** Otherwise a vendor could name a real message so
the platform would write to it.

**The one exception, documented.** Compose has no existing message, so its subject comes
from the caller. It's fenced before the create and re-fenced from Exchange after. That's
why "New message" asks for a subject before opening the editor.

**Watch for.** `isZzTestSubject` strips leading `RE:` / `FW:` / `FWD:` before testing,
because `createReply` names its draft `RE: <original>` and every derived draft would
otherwise be uneditable in development. `RE: [CCHMC RFI 229] …` is still refused.

**And a naming trap.** The Bid Tracker's own test rows use `ZZ`, not `ZZTEST` —
`ZZ FLOW1 | PR-04`, `ZZ Test Owner | PR-77`. A `ZZTEST` sweep of that workbook returns
nothing and looks clean. Two conventions are live and they are not the same string.

## 13 · Send the existing draft; never `sendMail`

**The decision.** `POST /messages/{id}/send` on the draft that already exists.

**Why.** `sendMail` with a copied body loses three things the automation depends on: the
attachments Power Automate attached, the `[CCHMC RFI 229]`-style subject tag that
downstream filing reads, and conversation threading. Intake 6 matches vendor replies by
conversation ID — a broken thread means a message that never gets filed, with no error
anywhere.

**Same reasoning for replies.** Use `createReply` / `createReplyAll` / `createForward`
rather than concatenating the original body. Graph sets `In-Reply-To` and `References`
correctly; string assembly doesn't.

## 14 · `Prefer: IdType="ImmutableId"` on every request, set once in the client

**The decision.** A default header on the Graph client, not something call sites add.

**Why.** By default a message ID changes when the message moves folders, and Power
Automate moves messages constantly. A stale ID returns 400, not 404 — it reads as a
malformed request rather than a moved message.

**Watch for.** `$search` ignores the header and returns standard IDs anyway. Part of why
search now uses `$filter` — see #17.

## 15 · The body editor splices text into raw bytes

**The decision.** Draft editing shows a sandboxed preview beside labelled text fields. Each
field maps to a text node's exact byte range in the original HTML, and saving splices the
changed text back at those offsets. Everything outside an edited run is byte-identical by
construction, not by careful re-serialization.

**Why.** The obvious approach — sanitize, edit that, save it back — was measured against
six real automation messages. Body loss 59–83%. Style attributes surviving 0 of 12–28. The
`<style>` block 0 of 6. Concretely: a change-order table keeps its borders but loses the
grey header row, loses Calibri 11pt in every cell, and loses `border-collapse`. The vendor
receives a visibly cheaper email, permanently, after the first save.

**Why not a WYSIWYG editor on raw HTML.** That means vendor-controlled HTML executing in
our origin. Not a tradeoff — an XSS hole next to a send button.

**What it costs.** You can edit text, not structure. There's an "add a paragraph at the
end" affordance and an "edit HTML source" escape hatch that replaces the whole body and
says so.

**Watch for.** The gate before this shipped: parse a real body, splice zero edits, assert
byte-identical output. Nine real bodies, 45 checks. If you change the splice, run it again
— it's the only thing that proves the claim.

## 16 · The CSS allowlist works by omission

**The decision.** `style` attributes are allowed one declaration at a time against a fixed
property list. `<style>` elements are discarded with their contents; `class` and `id` are
stripped.

**Why allow CSS at all.** These bodies keep all their formatting in `style` attributes and
nowhere else. A pane labelled "how the recipient sees it," next to a send button, has to
show what the recipient gets.

**Why omission rather than filtering.** Nothing on the list can name a URL —
`background-image`, the `background` shorthand, `cursor`, `content`, `list-style-image`,
`filter` are absent. So CSS cannot become the read receipt that blocking remote images
exists to prevent. `url(` and `expression(` are unspellable rather than filtered. Nothing
can position, either.

**If you extend the list**, ask whether the property can reference a URL or move an
element. If either, don't. The second layer — sandboxed iframe, `default-src 'none'`,
`script-src 'none'`, no-referrer — stays unchanged.

## 17 · Search is subject-only, by `$filter`

**The decision.** `$filter=contains(subject,'…')`, scoped to the current folder, collected
to a cap and sorted newest-first in our process.

**Why not `$search`.** It ignores `Prefer: IdType="ImmutableId"` and returns standard
folder-scoped IDs, which break the moment a flow moves the message. A stale ID is a
correctness bug; full-text search is a convenience.

**What it costs.** Subject only. Judged acceptable because people hunting a change order
know the project tag — that's what `[CCHMC RFI 229]` is for.

**A correction worth recording.** This was approved partly on the belief that `$filter`
would restore date ordering. It doesn't — Exchange refuses `$filter` with `$orderby`,
returning `InefficientFilter`. Sorting happens in our process. The immutable IDs were
always the real reason.

## 18 · Grouping collects the whole folder; grouping is display-only

**The decision.** With grouping on, the service collects the folder to a cap (500 messages,
5 requests) and groups the complete set. No cursor. Grouping off restores paged reads.

**Why not group page by page.** A group header makes a factual claim — "4 messages, newest
08-25". If messages 5 through 9 are on the next page, that header is *wrong*, not merely
incomplete. A truncated list shows less than there is; a truncated group shows a false
number.

**Why it can't be labelled instead.** Graph gives no conversation message count on a
message summary, so there's no way to know which groups are partial. You'd mark every
group "may be incomplete" until people ignore the label, or mark none and lie silently.

**Why the cap is safe.** The grouped read keeps `$orderby=receivedDateTime desc`, so
truncation drops the *oldest* messages, never the newest.

**Watch for.** Subject is not a usable grouping key. `CCHMC Bulletin 12` holds two
conversations with byte-identical subjects — two vendors answering the same scope request.
Subject grouping would have merged 11 messages into one thread with a false count.

## 19 · Polling at 20 seconds. Webhooks evaluated and declined.

**The decision.** The message list polls every 20 seconds while the tab is focused. Graph
change notifications are not used.

**Why.** Measured: a platform write appeared in the folder listing on the first 250 ms
poll, every time. Exchange isn't the slow part — the interval was the entire user-visible
delay. Changing one number captured nearly all the benefit.

**What webhooks would have cost.** A public HTTPS validation endpoint, a subscription
lifecycle, a renewal job (~3-day expiry), dropped-notification reconciliation, and polling
retained anyway as the floor since delivery is best-effort.

**Budget.** 180 requests per hour per focused tab against roughly 10,000 per 10 minutes.
About 0.3%.

**What would reopen it.** Not user count. A background job that must react to inbound mail
with no human present. Or a sync direction that proves to take minutes — four of six were
never measured, since they need a person acting in Outlook.

**Watch for a coupling nobody would guess.** Tripling the poll rate triples how often the
workspace re-renders. The editor used to reset itself on every parent render, so a faster
interval would have tripled a data-loss bug. Fixed — the callbacks ref in
`draft-editor.tsx` is what makes 20 seconds safe.

## 20 · Delete moves to Deleted Items explicitly

**The decision.** `deleteMessage` issues a move to `deleteditems` rather than a Graph
`DELETE`.

**Why.** `DELETE` does not put the message in Deleted Items. On this mailbox it goes to
Recoverable Items \ Deletions — the dumpster — while Deleted Items never sees it. Nothing
is destroyed, but recovery needs Outlook's "Recover Deleted Items from Server" dialog and
is bounded by the retention window.

The confirmation dialog promises Deleted Items. Softening the promise to match the code
would make a reversible action feel irreversible in a mailbox a daily process depends on.
So the code changed instead.

**And `permanentDelete` appears nowhere.** No legitimate need, and it destroys the audit
trail. A test fails if it appears.

## 21 · The service is the only thing that talks to Graph

**The decision.** `lib/modules/change-orders/mail/service.ts` is the sole path. Route
handlers and components get platform types — no `@odata` fields, no `changeKey`, no Graph
pagination URLs. Failures arrive as a typed `MailError` with a `kind`.

**Why.** Every rule above — the send gate, the ZZTEST fence, immutable IDs, the mailbox not
being overridable by a caller — lives in one place because it has to be enforced once
rather than remembered at every call site.

**Watch for.** The write-method allowlist test. It began as "no write methods exist" in
Phase 4, and Phase 6 converted it to an allowlist rather than deleting it. The value was
never the empty list — it's that adding a new way to change the mailbox requires naming it
in a test first.

---

# Part 3 — BAS

Fuller detail in `docs/09baswhatisbuilt.md` and `docs/08-bas-and-niagara.md`. What follows
is the reasoning most likely to be undone by someone who doesn't know why.

## 22 · Two repositories, and the database is the only seam

**The decision.** `phb-platform` owns the `bas_*` schema, the module, its screens and the
verification tooling. `phb-bas` owns the Python collector, the Grafana dashboards, the MCP
server, and the backup and restore scripts.

**Why.** The collector knows Niagara and nothing about the platform. The platform knows the
schema and nothing about Niagara. Neither can break the other except through the database,
which is what makes them separately deployable.

**What it costs, and this matters when reading any BAS document.** Neither repository's
tests can exercise the other. `npm test` here covers the schema, the module and the
tooling, and reaches none of the collector, the dashboards, the MCP server or the backups.
So roughly half of what's written about BAS will never be caught drifting by a green suite
here. Know which side a claim belongs to before going looking for it.

## 23 · Point identity is a surrogate key, never a name

**The decision.** A point's identity is a database key. A point renamed in Niagara becomes
a **new row** rather than silently reinterpreting years of history.

**Why.** The alternative attaches history to a string an integrator can change at will. The
Change Order automation has the same scar from the other direction — `co_key` derived
independently in two places eventually disagreed, and one change order existed twice with
neither copy complete.

**Related, and equally deliberate.** History names are stored **exactly as Niagara returns
them**, `$`-hex escapes included, because that string goes into the oBIX URL verbatim.
"Tidying" it breaks the fetch.

## 24 · Every timestamp is UTC

**The decision.** Storage is UTC throughout. Local time is display only.

**Why.** There is no way to unwind a DST bug afterwards. An hour that exists twice, or not
at all, silently corrupts a year of trend data and you cannot tell which readings were
affected.

**It also cross-checks.** The 24 August sensor fault appeared at 13:05 UTC in our data and
09:05 EDT in Workbench — which confirmed both the fault and our timestamp handling at once.

## 25 · `bas_readings` carries no names, units or equipment

**The decision.** The readings table holds a point reference, a timestamp and a value.
Nothing denormalized.

**Why.** Denormalizing multiplies storage roughly 5× and turns a rename into a
billion-row rewrite. At 15-minute collection across a real building, that's the difference
between a schema that scales and one that doesn't.

## 26 · `roll_horizon_s` is maintained by a trigger, not a generated column

**The decision.** A trigger keeps it correct. It is deliberately not
`GENERATED ALWAYS AS`.

**Why — this one is a Prisma trap, not a data-modelling choice.** Prisma reads
`GENERATED ALWAYS AS` as a default it can't express, and proposes an `ALTER … DROP DEFAULT`
that PostgreSQL rejects on a generated column. That permanently blocks **every later
migration**. Prisma ignores triggers, so a trigger keeps the value correct and the schema
diff empty.

**What follows.** `schema.prisma` is not the whole schema. The trigger, 13 CHECK
constraints and the six views live in migration SQL. Prisma models columns and indexes; it
ignores constraints and triggers. Don't assume the Prisma file is authoritative.

## 27 · The `bas_v_` prefix is load-bearing

**The decision.** Every view is prefixed `bas_v_`.

**Why.** `bas_v_data_dictionary` selects objects matching `bas\_%`. An unprefixed view is
invisible to it, and therefore invisible to anything reading the dictionary to understand
the schema — including the AI, when B5 ships.

**Same class of bug as the four sentinel filenames in the automation.** A name is a
contract; breaking it fails silently.

## 28 · Unknown never renders green

**The decision.** *Points at risk* counts both `data_lost` — records the station overwrote
before we collected them, gone permanently — and `roll_horizon_unknown`, meaning capacity
hasn't been filled in from Workbench so we cannot tell.

**Why.** "We don't know whether this point is losing data" is not a passing state. Rendering
it green means a dashboard that says everything is fine while data is being destroyed.

**By contrast**, *unclassified points* is amber by design: a point with no role is invisible
to role-based questions, which is a backlog item rather than a fault. The distinction is
deliberate — one is "we might be losing data," the other is "this is less useful than it
could be."

## 29 · Distinct values, not standard deviation

**The decision.** Sensor liveness is judged by distinct-value count.

**Why.** A standard-deviation threshold is unit-dependent and untunable across buildings —
it missed a sensor frozen at 64.5 with σ = 0.08. Distinct-value count is unit-independent
and doesn't need a per-building threshold nobody will maintain.

**Same instinct elsewhere.** Fault rules are value-based because `bas_readings.status` is
always NULL — Niagara doesn't send status with history records over oBIX, and the
`#RecordDef` declares only timestamp and value. **NULL means "not supplied", never "no
fault."** A rule saying −40 °F is not a room temperature also works on Johnson Controls and
Siemens.

## 30 · The chart breaks across gaps, three ways

**The decision.** Where data is missing: an inserted null with `connectNulls={false}`, a
shaded band, and a written list of gaps beneath the chart.

**Why three.** A line drawn straight through a hole asserts readings that never existed —
and in this system, were destroyed. But a break alone reads as a rendering artifact, so
someone dismisses it. Three mechanisms make the gap unmistakably a fact about the data.

**This is the irreplaceability rule showing up in the UI.** A gap recorded is a gap
analysis can account for. The 64.3-hour outage of 21–24 August is visible for exactly this
reason.

## 31 · Three accounts, and the Postgres grants are table-by-table

**The decision.** `bas_collector` in Niagara can read histories and cannot write to the
station at all. `bas_collector` in Postgres can read and write `bas_*` only, and is refused
on `employees` and `audit_events`. `bas_readonly_platform` has SELECT on `bas_*` only, and
is what Grafana and the MCP server use.

**Why table-by-table rather than `ALTER DEFAULT PRIVILEGES`.** Default privileges can't be
filtered by name, so they'd grant access to whatever table Prisma creates next — including
`employees`. The cost is that a new `bas_*` table is invisible until granted, which fails
loudly rather than silently. That's the right direction for this trade.

**Every refusal was tested, not assumed.** A grant that lets the right thing through proves
nothing on its own.

## 32 · Verification is by content, not row counts

**The decision.** `bas-checksum.ts` and `npm run bas:verify` compare content.

**Why.** The import once reported "12/12 tables reconciled, 3,481 rows" and was wrong:
every timestamp had lost its microseconds and a JSON array had become an object. Counts
confirm a row exists, not that it is the same row.

**Keep this in mind for any future migration or restore.** A row count is the easiest
reassurance to produce and the least informative.

## 33 · Synthetic data is left unclassified on purpose

**The decision.** `Temp1`–`Temp3` are History Emulator output and nobody knows what they
represent, so they carry no role.

**Why.** Inventing a role would make the AI answer confidently about something untrue. An
unclassified point is visibly incomplete; a wrongly classified one is invisibly wrong.

**Worth knowing.** The lab station is not PH+B's asset — its licence belongs to Building
Controls & Solutions under a Columbus Temperature Controls project.

---

# Part 4 — The pattern across both modules

## 34 · The recurring defect

The Change Order handoff set names its own defect class: *a rule updated in one place and
not in the other place that restates it.*

This codebase has two, and both are worth stating plainly.

### Documentation was wrong about Graph, repeatedly, and only the live mailbox found it

| What the docs said | What Exchange does |
|---|---|
| `wellKnownName` identifies folders | Beta-only; asking v1.0 fails the entire request |
| The folder tree is one level deep | `Projects` is a child of Inbox — project folders at depth 2, contents at depth 3 |
| Graph pages mail with `$skiptoken` | It uses `$skip`; dropping `$orderby` on an offset page corrupts paging silently |
| Subject tags are `[CO: Owner\|Bulletin]` | `[CCHMC RFI 229]`, `[CCHMC Bulletin 12]`, or no tag. `[CO:` appears nowhere |
| A literal U+00A0 round-trips | Exchange rewrites it as `&nbsp;` |
| A table cell is `<td>value</td>` | Outlook writes pasted cells as `<td><p>value</p></td>` |
| `DELETE` moves to Deleted Items | It goes to Recoverable Items |
| `$search` honours immutable IDs | It ignores the header and returns standard IDs |

The pagination one is the sharpest: the fixtures *invented* `$skiptoken` continuation
links, so the tests agreed with the bug and every listing silently stopped at one page.

**What follows.** Fixtures are right for hostile-HTML tests and error mapping. Anything
about an external system's actual behaviour needs the real thing. When a spec and the
system disagree, the system is right and the spec gets corrected.

### A green test suite covers less than it looks like it does

Two bugs were found by a person clicking, not by any test: the folder tree rendered fully
collapsed (identical in appearance to a truncated tree), and the editor wiped itself every
60 seconds because an inline arrow function sat in an effect's dependency array.

And structurally, `npm test` here cannot reach the BAS collector, the dashboards, the MCP
server or the backups at all — they're in `phb-bas`. Nor can it reach the JACE, the
network, the Postgres grants, or anything that is a fact about a building rather than a
file.

**Click through what you build, and know what your suite can't see.**

## 35 · What is deliberately not built

Listing these so nobody assumes they were forgotten.

**Change Orders** — the CO context panel (a draft alongside its `co_key`, run report and
Q&A log: the most attractive feature proposed, and the only one with no Outlook fallback).
Graph webhooks, declined with a measurement. A message index. Mailbox-wide conversation
grouping — a thread genuinely spans folders, and going mailbox-wide needs a
`conversationId eq` query per thread plus a decision about Deleted Items, which Graph
returns and Outlook hides.

**BAS** — B5, plain-English questions over the data: designed, not started, blocked on a
company Anthropic API key. Point classification tooling, deferred because the right shape
depends on how a given integrator named things and most fault rules need `equipment_id`,
which nothing currently sets. Production deployment, blocked on Azure. Multiple buildings —
the schema and filters already support it; the lab station caps around two or three
buildings, beyond which a Niagara Supervisor is a purchase nobody has owned.

**Platform** — roles (there is `is_platform_admin` and there are module grants, nothing
else), per-module admins (schema room left, not implemented), group-based grants mapped to
Entra security groups (worth revisiting past ~50 employees).

## 36 · The judgment I'd most want to pass on

Three things, none of them technical.

**When a spec and the running system disagree, the running system is right.** True of
Graph, and just as true of the automation. The eleven flows have documented defects —
`/me/` in three of them working by coincidence, Office Scripts in a personal OneDrive,
fixed waits standing in for race handling. All of it is load-bearing and none of it should
be tidied without a specific reason and a plan.

**A rule you can't operationalize isn't a rule.** "Don't break working systems" told nobody
anything until it became a list: eleven flows, four sentinel filenames, one misspelled
path, one Excel file that must never be written by a library. Specificity is what makes a
prohibition followable.

**The failure mode to design against is silence.** It's the thread running through
everything here. A sentinel file saved as `scrub_result (1).json`. A folder tree that
renders collapsed. A conversation group with a false count. An import reporting 12/12
tables reconciled while every timestamp lost its microseconds. A dashboard tile rendering
green because capacity was unknown. Data being destroyed at a station over a weekend
because a laptop was closed.

None of those crashed. When you add something, ask what it looks like when it silently
doesn't work — and make that state visible.
