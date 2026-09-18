# Why the platform is built this way

*The decisions behind the design, why each one was made, and what breaks if you undo it.
Written August 2026, covering the platform, the Change Orders module through Phase 11, and
the BAS module through B4.*

`README.md` tells you how to run this. `runbook.md` tells you what to do when it
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
weekend is not, and that is now measured rather than estimated: 64.3 h, 64.5 h and 113.4 h
of real silence. This has already happened three times, costing 22.6, 22.8 and 71.7 hours
per point. There are two causes: a sleeping laptop, which is the whole of the August
pattern, and — new in September, and never written down before — a laptop away from the
building network, which collects nothing even awake and firing perfectly on cadence,
because the JACE is a private address and there is no VPN.

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

## 37 · A module administrator is not a platform administrator

**The decision.** `module_grants.is_module_admin` — a boolean on the grant row — carries
administrative rights over exactly one module. For `bas` that is the Settings tab, which
decides what gets collected. Checked by `requireModuleAdmin(key)`, which denies with
**404**, not 403.

**Why it exists.** Viewing building data and changing what gets collected are different
privileges. A misconfigured station stops collection silently, and silent is the failure
mode this project keeps paying for. Before B7.2 the only way to express "may change BAS
settings" was `is_platform_admin`, which also means "may disable employees" — so adding a
building would have required trusting someone with the employee directory.

**What it reverses.** `docs/04-auth-and-permissions.md` listed per-module admins under
*Deferred — do not build*. That line is struck through rather than deleted, so the
reversal is visible to whoever reads it next.

**Why a column and not a table.** Revoking someone's module access deletes the grant row,
which takes their admin rights with it in the same statement. A `module_admins` table
would let a revoked employee keep an orphaned admin row that nothing would notice — and
nothing checks for that, because nothing would think to.

**Why 404 and not 403.** 403 answers "is there a settings screen?" with yes. The whole
point of the separate right is that this surface is not for everyone, so someone probing
for it should not learn it is there. Same reasoning as a missing module grant, and the
same status.

**Why a platform admin gets nothing implicitly.** `requireModuleAccess` has never had an
`isPlatformAdmin` branch — a platform admin already gets 404 on `/bas` itself without a
grant. Making the admin surface the one exception would mean the audit row *"granted BAS
admin to Jake"* no longer describes everyone who can add a building.

**What breaks if you undo it.** Either building administration goes back to requiring the
platform admin flag — which puts the employee directory in the hands of whoever adds a
building — or the check moves into the routes, where forgetting it is possible again.

### 37.1 · Only for a module that has settings, and the declaration lives in code

**What the genericity cost.** The column knows no module keys — "Change Orders gets the
same capability by ticking a box" — so the admin screen offered *"Can change settings for
Change Orders"*, a permission whose only effect would have been to reach a page that does
not exist. Change Orders is configured in Exchange and in the flows; the platform has
nothing to offer a module admin of it.

**The declaration is `lib/module-settings.ts`, not a column on `modules`.** Whether a
settings page exists is a fact about the repository, and PLATFORM-CONTEXT's own test —
*who is the authoritative owner of this information?* — answers "the code". A boolean in
Postgres is a claim about a file that stays true after someone deletes the file, and it
would need a migration **and a re-seed** to become true: the production seed has run once,
by hand, so the column would read `false` in production and nowhere else until somebody
remembered. A code table ships in the same image as the page it describes.

**An href, not a boolean,** because a boolean cannot be checked against anything.
`tests/module-settings-surface.test.ts` walks `app/` and asserts every declared route
resolves to a real page, which is what stops the table going stale — the check the column
could never have.

**A `Map`, not an object literal, because the lookup carries a permission.**
`lookup[key]` finds inherited members of `Object.prototype`, so a module keyed
`constructor`, `toString` or `valueOf` would have come back truthy and been handed the
settings permission — a guard failing in the one direction it must not. `modules.key` is a
free-text primary key, so those are writable keys rather than theoretical ones; no such
module exists, which is the argument for closing it now rather than after one does.
`Map.get` has no prototype chain to fall through, so the hole is structurally absent
instead of guarded against — an `Object.hasOwn` check would do as well here and would have
to be remembered at the next call site. Caught in review by Codex, not by me, and pinned by
tests that fail against the old lookup.

**The refusal is in the service, not only the component.** `setModuleAdmin` is the single
writer of the column; `bulkGrants` never touches it. Hiding the checkbox alone would leave
the API accepting the request and writing `grant.admin_added` to the audit log for a
permission that grants nothing — a false record, in the one place an admin looks to find
out why somebody has something. It is a hard error rather than a silent no-op: an API that
discards a request it understood makes the checkbox spring back with nothing to explain it.

**422, not 403,** and not 404 like the module surfaces themselves. 403 would say the admin
lacks the standing, and they do not — no admin can make the state exist. The admin API's
own existence is not a secret (that is why it answers 403 rather than 404 to a non-admin),
so there is nothing here to conceal; the combination of values is simply invalid.

**One direction only.** Clearing the flag always succeeds. The local development database
had a `change-orders` row with `is_module_admin = true` when this was written — reachable
by clicking the box the fix removes — and hiding a live permission without leaving a way
to clear it is how it becomes permanent. Where the flag is set on a module with no
settings surface the checkbox still renders, marked, so it can be turned off.

**What breaks if you undo it.** The admin screen goes back to advertising a permission
that leads nowhere, and an audit trail records grants of it. If you undo only the service
half and keep the hidden checkbox, it is worse than before: the permission stays grantable
by API with no UI that shows it was granted.

## 38 · Decorative colour and semantic colour are disjoint sets

**The decision.** Teal, orange and maroon mean ok / warn / bad. A card tinted for
rhythm rather than for state may therefore only use cyan, purple or pink. The two
sets share no member, and `.card--tinted` in `app/globals.css` enforces which
side of the line a fill is on.

**Why.** A dashboard needs some colour for identity or it reads as a spreadsheet.
But a tile filled red for visual interest, sitting beside a tile filled maroon
because something is broken, teaches the reader that colour means nothing here —
and then the maroon one stops working. Keeping the palettes disjoint is what lets
a coloured card be decorative *and* a coloured tile be a fact, on the same
screen, without either weakening the other.

**Watch for.** `--danger` is deliberately maroon rather than red, which is what
frees red for decoration. Anyone "fixing" that to the more obvious red collapses
the two sets in one edit. The module accent is also outside the semantic set:
BAS's cyan says *you are in Building Automation* and appears on the header
diamond, the active tab and the trend line, but never on a tile — that is what
stops a healthy teal tile reading as merely module-coloured.

**If you undo it.** Nothing breaks visibly. The screen just stops being able to
say anything with colour, and the failure is that nobody notices.

## 39 · The Change Orders reading pane stays quiet while its chrome went soft

**The decision.** The soft language — larger radius, tinted shadow, rows as
rounded cards — applies to the module's own furniture: panes, folder rows,
message rows, controls. It stops at the message body. No card around a vendor's
email, no elevation competing with it.

**Why.** The test is **competing content, not which route it is**. A dashboard
has none of its own, so cards and elevation give it presence. The reading pane
renders a vendor's actual email HTML, with the vendor's own colours, tables and
signature block. Framing that in a lifted card puts the platform's styling in
argument with the sender's, and the sender's is the thing being read.

**What it costs.** The module is not uniformly styled, and that looks like an
oversight to anyone who has not read this. It is the opposite: the seam runs
between the frame and the letter.

**Watch for.** `app/globals.css` originally recorded this as "BAS AND HOME,
deliberately — and not the mail screens". That was narrowed rather than
reversed when the chrome went soft, because the test still holds and it was
always about one pane. A comment claiming the mail screens are excluded would
now be false, so it does not say that any more.

## 40 · The `Bid Tracker.xlsx` write was removed, and what justified it

**The decision.** `run_workflow.py` contained `seed_response_bid_tracker()`,
which loaded `Bid Tracker.xlsx` with openpyxl, appended a row, re-set the
`COTracker` table ref and saved the workbook back. It was removed in Phase 12
Part B — the one deliberate logic change in a part whose whole rule was that
nothing but file access changes.

**Why.** Power Automate binds to that workbook's Excel `ListObject`. Rewriting
the file with a library regenerates the internal table IDs; the file still looks
correct and the flow silently stops resolving the table. `docs/02` had already
recorded that as something which happened in production.

**The evidence, because "it might break" would not have been enough.** It had
run for real — `.BidTracker_pre_seed_backup.xlsx`, a filename only that code
ever wrote, is in the response engine's archive. And the failure it produces has
an artifact on disk beside the live workbook:
`.Bid Tracker.broken_table_uid_2026-07-31_1003.xlsx`, preserved next to a backup
taken the same minute. That the seeding caused that particular break is
inference; that it is the break the seeding produces is not.

**What kept it quiet was luck, not design.** Both candidate paths had stopped
resolving, so every call returned "skipped, not reachable" — and the maintainer
knowledge base was telling new operators to set `CO_BID_TRACKER_PATH`, which is
the one variable that would have armed it. Verified afterwards in six places
that it is set nowhere.

**Watch for.** Do not "fix" this by routing the write through the Part B
FileStore. That satisfies the letter of *the tracker is unreachable through the
interface* and none of its intent: the harm is the workbook rewrite, not the
plumbing that reaches it. `tests/test_no_bid_tracker_write.py` in `phb-co-engine`
fails on a path to that workbook, a `BID_TRACKER`-shaped identifier, a read of
that env var, or any workbook write to an unapproved destination. Run against
the pre-removal engine it reports eleven violations, so it is known to have
teeth.

## 41 · Arrow keys move the cursor; they do not open the message

**The decision.** In the Change Orders list, arrows and `j`/`k` move a cursor,
and `Enter` opens. Moving does not fetch.

**Why.** Opening a message is a Graph round trip. Bound to arrow keys, a held
key is one request per row against a live mailbox — and the throttle budget is
shared with the automation that actually matters. So the cursor is free and the
fetch is deliberate, which is the same separation Outlook has between its
reading cursor and its reading pane.

**What follows.** Selection and the cursor are two different states and are drawn
differently: selection is a surface plus the accent rule, the cursor is a ring.
They are usually the same row, and they have to stay legible when they are not.

**Watch for.** A roving `tabIndex` keeps exactly one row in the tab order. Without
it `Tab` walks through every row in the folder before reaching the reading pane,
which is worse than no keyboard support at all.

## 42 · The run lock was routed through the interface, not fixed

**The decision.** Phase 12 Part B put the engine's `.run_workflow.lock` through
the same `FileStore` as every other file — `create_exclusive`, `truncate_write`,
`remove` — and changed none of its behaviour.

**Why.** It is not a mutex and was never one. One of its three outcomes is
literally *proceeding unlocked*: any failure to manage the lock file logs a
warning and continues, deliberately, so lock infrastructure can never wedge a
pipeline the business runs on. And it coordinates one machine only — the
engine's own comment says so, because an `O_EXCL` create on a OneDrive-synced
folder says nothing about what another machine is doing.

**Why not fix it in Part B.** Part B's guarantee is that the extraction changed
no behaviour, and that guarantee is what the differential test could prove.
Rewriting the lock in the same commit would have made "the output is identical"
untestable — and the lock is not what protects Phase 12 anyway. **Isolation is:**
the container points only at a copy, so it can never contend for the live lock.

**Watch for.** Whether the mechanism should change at all is a Phase 14
question, decided at cutover with the live path in view. Until then, do not
describe this lock as mutual exclusion in any document — including a Part C
write-up that would find it convenient to.

## 43 · A station awaiting its login is amber, and the collector writes nothing for it

**Decision.** A direct station registered in Settings with no login stored, that has
*never* had a successful collection run, is a distinct state — *awaiting a login* —
counted separately from failures, rendered amber, and given **no** failed ingest run
by the collector. A station with no login that *has* collected before is a fault: red,
and a failed run against its row every pass. The one fact that tells them apart is
whether it ever worked, read from `bas_ingest_runs`.

**Why.** The precedent is § 28's unclassified-points tile — amber by design, "a
backlog, not a fault." Registering a station and then going to find its password is
the normal order of doing things. The first cut (2026-09-16) recorded a failed run for
that station every fifteen minutes, which means three stations registered on a Friday
afternoon would have the health check reporting failures all weekend for something
nobody needed to act on. That is how people learn to ignore red, and this is the one
system where ignoring red destroys data. The same afternoon had already shown the
opposite failure — a station with no password stopping *every other station* for 75
minutes — so the fix had to make the waiting station visible without making it loud.

**The sentence is shared.** "No login stored - this station will not be collected
until one is set." is the banner on the station's card (`AWAITING_LOGIN` in
`health-client.ts`) and the line the collector logs when it skips the station
(`AWAITING_LOGIN` in `phb-bas/collector/targets.py`). The collector's test reads this
repository's source and fails if the two drift. One state, one sentence, two places.

**What breaks if you undo it.** Make the awaiting station red and the estate learns to
scroll past red. Make the lost-login station amber and a real outage — a login somebody
removed from a station that was collecting yesterday — reads as a to-do item. Key the
distinction on whether a credential row *ever existed* instead of on the run history and
you need a table nobody has, for a question the run history already answers.

## 44 · A first sync takes everything the station holds, and every pass checks that it did

**Decision.** A point with no checkpoint starts collecting at the station's *own*
oldest record — read from the oBIX history object — and pages forward by `limit`,
capped per pass and resumed on the next. There is no bounded first-sync window and
no per-request time window. And on every pass the collector compares the count the
station reports against the rows the platform holds inside the station's own span,
and records the verdict on the point: `complete`, `backfilling`, `incomplete` or
`unknown`. A run with an `incomplete` point is `partial`, never `ok`.

**Why.** The first sync of PHBoffice on 2026-09-16 reported *28/28 points ok,
9,784 records, status ok*, and four of those points had collected nothing. The
window was 30 days; the change-of-value histories had gone quiet 35 days earlier;
every request was empty; and an empty pass was a successful pass. Against the
500-record rolling buffers the same window looked identical to *took everything*,
which is why it was never questioned. The plan is to point this collector at
customers' Supervisors holding years of history. A week of a multi-year archive,
reported as success, is the failure this whole system exists to prevent — and the
station had been saying `count=419` on every pass.

The tolerance is five records, fixed, not a percentage, because a percentage
scales the blind spot with the archive and the archive is where a hole matters.
Drift from the station writing during the pass is closed by ordering — meta first,
upper bound fixed after — not by tolerance, so what the five covers is two records
in one millisecond and a rolling buffer dropping one between two requests.

The window went for the same reason `INITIAL_BACKFILL_DAYS` did: it bounded
nothing that `limit` does not — Niagara iterates a lazy cursor and stops at
`limit`, which is why its own `unboundedQuery` preset is range-unbounded — and it
cost a sparse history one empty request per idle day, every pass. `Occupied` was
paying 36 a pass on the day this was found; a year on, it would have hit the cap
and read `backfilling` forever.

**What breaks if you undo it.** Bring back a bounded first sync and the next
Supervisor imports a window and reports success. Drop the completeness check and
the collector goes back to grading its own homework — a run's status says whether
requests succeeded, and nothing else in the pipeline can say whether the data
arrived. Make the tolerance a percentage and the check goes quiet on precisely the
histories large enough to hide a real hole. Make `backfilling` downgrade the run
and a large first sync is red for a day for something nobody needs to act on,
which is § 43's lesson again. Make `incomplete` *not* downgrade it and the run
status is back to lying in the one case it was changed to catch. The Python that
enforces all of this is in `phb-bas`; the columns it writes, and the CHECK that
holds the vocabulary closed, are in `add_bas_completeness` here.

**The same afternoon, four amendments — each from watching the first live result.**

*The query has no upper bound.* The check's first live finding was a false
positive: two chattering points 70 short, and a `--from-scratch` that fetched
nothing. The JACE's clock is 22 minutes ahead of the collector host, the query
was bounded at the host's `now`, and every record the station had written in the
last 22 minutes sat in the host's future. Two clocks, one comparison. The station
stamps the records, so the station's clock bounds the range and `limit` bounds
the response. The offset itself is measured from `/obix/about` every pass and
recorded on the station, because a wrong station clock also misaligns that
building against every other and hides staleness in the health view; it is
fixed on the station and never corrected in the data, since a corrected value is
one nobody measured.

*The roll horizon is measured where it can be.* A full buffer — `count >=
capacity` — spans exactly what it retains, and the station reports both ends.
That span is recorded every pass, the view derives a horizon from it only when
the buffer is full, and the guard, the screen and the health check prefer it to
`capacity × interval`. A change-of-value point needs only its capacity filled in.
The two numbers stay distinct: one is what the station was configured to do,
the other is what it is doing, and when they disagree the station is right.
A *measured* horizon shorter than four polls is not refused — refusing the
station because one point got chatty stops the other 25 and loses more than it
protects — it is collected, said at ERROR, made `partial`, and CRITICAL in the
health check. A *configured* one is still refused: a person wrote it.

*The verdict is read, in three places.* View, screen, health check. A detector
that wrote a column nobody read for a day was the 28 August failure in a new
coat. `incomplete` is red like `data_lost`; `backfilling` is amber like § 43's
awaiting station, because it resolves itself; `unknown` is amber because
unknown is never green; a point with no checkpoint row reads `unknown`, because
never checked is not checked and fine.

*A filter that matches nothing skips the station and writes no run.* `sync
--only OperatingState` recorded a `failed` run against the lab, which has no
such point, and check 1b reads `bas_ingest_runs` for outages. A few manual
filtered syncs were writing fake outages into the record.

**What breaks if you undo these.** Put `end = host now` back and any station
whose clock runs ahead loses its newest records to every query and reads
`incomplete` forever. Call a half-full buffer's span a horizon and a young
chattering point refuses or alarms the whole station. Refuse on a measured
horizon and one chatty point stops a building. Stop reading the verdict and the
check is silent again.

## 45 · Showing a point is not collecting it, and the schema keeps them apart

**Decision.** `bas_points` carries two independent booleans. `is_active` says
whether the collector *fetches* the point. `is_visible`, added by B8.1 on
2026-09-17, says whether a browsing screen *shows* it. Both default to on. A
user label lives in a third column, `label`, beside Niagara's own
`display_name`, and `discover` writes neither `label` nor `is_visible` — ever.
The six `bas_v_*` views were left alone: none filters on `is_visible`, and none
may.

**Why.** Users asked to "choose which points to pull". What they want is a
shorter list on screen. The two requests look alike and cost differently: a
hidden point is still collected and can be un-hidden at any moment for free,
while a point that is not collected is being overwritten on the station — the
office JACE holds about five days and one status point about two hours — so a
point not collected on Tuesday cannot be recovered on Friday. If the platform
offered one switch, it would be the destructive one, flipped for a cosmetic
reason, and the loss would surface months later as a question with no answer.

The label is a new column rather than a rename because the existing names are
a trap that could not be safely disarmed: `bas_stations.display_name` is what a
person calls the station, and `bas_points.display_name` is what *Niagara* calls
the point. Renaming the point column to make the tables agree was evaluated.
The collector reads and writes it by name in its upsert, its active-points
reader and its sync path, so the rename is a two-repository change that has to
land in one breath, and between the halves every collector pass fails against
a station whose shortest history holds two hours. The SQL name stays; the
Prisma field became `niagaraDisplayName`; both columns carry a `COMMENT` naming
the other and saying it means the opposite; and `tests/bas-schema.test.ts`
asserts that wording.

`discover` re-reads every history on every run and upserts every point. If it
wrote either new column, an afternoon of naming would vanish the next time a
history was added, and nobody would know until they looked. The upsert names
the columns it writes, and `test_point_management.py` *(phb-bas)* proves the
rest by running it: the real migration applied with `prisma migrate deploy` to
a throwaway cluster, a point labelled and hidden, the station's displayName
renamed underneath, and the label and the hide come out unchanged while the
Niagara name beside them updated. Two mutations of the upsert each failed
seven of its checks.

Global rather than per-user, because that is how it was asked for and a join
table is a thing nobody wanted. The trade-off — one person's hide is
everyone's — is on the column comment, where the next person will read it.

**What breaks if you undo this.** Merge the two booleans, or make a screen's
"hide" write `is_active`, and a cosmetic choice destroys data with no error
and no gap marker. Filter a `bas_v_*` view on `is_visible` and Collection
Health can look healthier than the system is — the 28 August failure again,
recorded and read by nobody. Add `label` or `is_visible` to the collector's
upsert and every rediscovery erases the hand-typed names; the phb-bas test
fails, which is what it is for. Rename `bas_points.display_name` in one
repository without the other and the collector stops on its next pass.

## 46 · `migrate dev` has a database of its own, and the CLI is what enforces it

On a development machine the database `DATABASE_URL` names is not a development
database. It is where the collector writes `bas_readings` — 44,750 rows on 17
September 2026, back to February 2024, most of them long since rolled off the
JACE. It is also where `prisma migrate dev` pointed, and while an edit to an
applied migration was being tested, Prisma offered to reset it.

Prisma does ask first. But a prompt is a convention: it is answered by a person
who has typed `y` to it a hundred times on databases that did not matter. The
rule that came out of this is the same one the send gate and the ZZTEST fence
already follow — **a convention someone has to remember is not a guard.**

**Where the guard lives, and why there.** Not in an npm script, because
`npx prisma migrate dev` typed directly skips a script. In `prisma.config.ts`,
because the CLI cannot open a connection without loading it. The config reads
the command from the CLI's own arguments and routes `migrate dev`,
`migrate reset` and `db push` — the three that can drop tables or reset a
database as part of doing their job — to `MIGRATE_DEV_DATABASE_URL`. There is
no fallback to `DATABASE_URL`; a fallback is the accident being prevented.
Everything else, `migrate deploy` included, still goes to `DATABASE_URL`, so
CI, the deploy workflow and the Dockerfile did not change.

**Why it also looks at the data.** Name checks catch the configuration accidents
— unset, remote, same-as-`DATABASE_URL`. They do not catch a variable pointed
at a copy of the live database, or a dump restored into the development one.
So the last check connects and counts `bas_readings`, and refuses if there are
any. Only that table: employees come back on sign-in and reference data comes
from the seed, but readings exist nowhere else. A database that does not exist
yet passes — `migrate dev` creates it.

**The seed follows the command.** `migrate reset` runs the seed afterwards, and
the seed reads `DATABASE_URL`. The config redirects that variable in-process for
a dev-only command, so a reset of the development database seeds the
development database. Without that line the two databases would be cross-wired
in the other direction.

**What breaks if you undo it.** Remove the routing and `migrate dev` is one
`y` away from the only copy of two and a half years of building history. Add a
fallback to `DATABASE_URL` "for convenience" and you have rebuilt the original
hazard with an extra variable. Move the check into an npm script and it protects
the people who use the script. Drop the row count and a restored dump under the
wrong name is a development database until the moment it isn't. The verification
that this works is in `runbook.md` → *Which command touches which database*,
and the test runs the real CLI against a database holding one reading.

## 48 · A horizon is the shortest span the buffer has ever held, and a buffer that has never filled is not a risk

**Decision.** The measured roll horizon of a point is the **shortest**
full-buffer span the station has ever reported for it, kept on
`bas_sync_checkpoints.shortest_full_span_s` and only ever lowered; the span the
station reports today is recorded and shown beside it and governs nothing. A
buffer the station reports below capacity is its own state — `buffer_not_full`,
*Not full yet · 320 of 500* — outside every risk figure, and no message about
it, or about a measured point, names a collection interval.

**Why.** Three things were wrong at once on the live database on 2026-09-18,
and each of them was a screen saying something true-looking that was false.

*The horizon was the latest observation.* `Unit_Status_Mode` measured about two
hours on 17 September and ten hours on the 18th. It is a change-of-value trend
on an RTU suspected of short-cycling: how long 500 records span is how hard the
unit is working, and a quiet afternoon stretches it fivefold. A guard that
reads the latest span forgets the two hours the moment the unit calms down —
and the next bad afternoon overwrites records against a ten-hour horizon nobody
had reason to doubt. The value the poll interval has to beat is the worst the
buffer has been seen to do. So the collector writes `LEAST(existing, new)`
every pass, the view LEASTs once more with the current span, and the column
comment says in as many words that it only ever gets shorter and must never be
raised by hand. A point whose horizon has ever been two hours is a two-hour
point.

*A buffer below capacity was "unknown".* Six office points at 71 to 419 of 500
records — over 207 days to 2.5 years — had never filled and had overwritten
nothing, and were counted at risk. "We have not measured the horizon" and "we
may be losing data" are different statements; the view treated them as one.
Now the view says `buffer_not_full`, the tile does not count it, the headroom
badge names it on its own line, and the tone is neutral: not amber, because
there is nothing to act on, and not green, because green means *inside half a
known horizon* and this point has none.

*The instruction beside "unknown" could not be followed.* It said to fill in
capacity and interval from Workbench. Every one of the eight points is
change-of-value; Workbench shows no interval because there is none. A warning
whose instruction is impossible trains people to scroll past it, which is how
a real one is missed. The collector now words the unknown warning from the
spacing of the readings it already holds — regular spacing may ask for an
interval, uneven spacing says *change-of-value, leave it NULL* and stops — and
that classifier writes nothing anywhere. `HistoryMeta.implied_interval_s()`,
an unused average-spacing guess, was removed rather than left as a temptation:
written into `collection_interval_s`, a derived guess becomes a fact the
trigger mints a `roll_horizon_s` from, and every risk figure is then judged
against a number nobody measured.

**What breaks if you undo it.** Read the latest span and the guard is only as
strict as the last quiet afternoon; `test_completeness.py` *(phb-bas)* and
`tests/bas-views.test.ts` both fail on exactly that mutation, and both were run
with it. Fold not-full back into unknown and six safe points go amber, the
at-risk tile lies by six, and the only instruction offered cannot be carried
out. Suggest an interval for a change-of-value point and someone will type one
in. The one thing the shortest span cannot know is that the buffer got
**bigger**: raising a history's capacity on the station is the one legitimate
reason to reset the column to NULL, and `runbook.md` → *The roll horizon column
shows two numbers* says how.

## 47 · The judgment I'd most want to pass on

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
