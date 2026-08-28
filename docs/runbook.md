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

## Filling in `.env.local` on a new machine

`cp .env.example .env.local` gives you the variable names. This is where each
value comes from.

**You can generate most of them yourself.** Only three things have to be
requested, and two of those are already written down below.

### Generate yourself

| Variable | How |
|---|---|
| `DATABASE_URL` | Your own local Postgres. `createdb phb_platform`, then `postgresql://USER:PASSWORD@localhost:5432/phb_platform?schema=public` with your own local credentials. Nobody else needs to know this password. |
| `TEST_DATABASE_URL` | Same server, **different database**. `npm run db:test:setup` creates it. The suite truncates every table and refuses to start if this matches `DATABASE_URL`. |
| `AUTH_SECRET` | `npx auth secret`. Yours alone — it only signs session cookies on your machine, so it does not need to match anyone else's. Do not ask IT for this. |
| `AUTH_URL` | `http://localhost:3000`. |
| `BOOTSTRAP_ADMIN_EMAIL` | Your own work address is enough locally. It seeds an admin row in *your* database and has no effect anywhere else. |
| `PHB_ALLOW_SEND` | `false`. Always. Never set it to `true` outside production — development runs against the live `changeorder@phb1899.com` mailbox and there is no test mailbox. |
| `CO_MAILBOX` | `changeorder@phb1899.com`. |
| `ALLOWED_EMAIL_DOMAINS` | `phb1899.com`. Confirm the full verified-domain list with IT only if a legitimate account is being rejected with `domain_not_allowed`. |

### Copy from this runbook

These are identifiers, not credentials. They appear in every authorization URL
the app generates, so there is nothing to protect and no request to make:

| Variable | Value |
|---|---|
| `AUTH_MICROSOFT_ENTRA_ID_ID` | `220921c1-f23e-4d01-b354-736884ba3d00` |
| `AUTH_MICROSOFT_ENTRA_ID_TENANT_ID` | `48f37f84-1c36-4b3e-986c-b8b7196ad49d` |

Both are also in *What expires, and when* below, which is where they are
maintained.

### Request from IT

Only these. Everything else above you can do without talking to anyone.

| Variable | Who owns it | What to ask for |
|---|---|---|
| `AUTH_MICROSOFT_ENTRA_ID_SECRET` | Owner of the **SSO** app registration (client ID above) | The current client secret **value**, sent over something that is not email. Needed only to sign in — see below. |
| `GRAPH_CLIENT_ID`, `GRAPH_TENANT_ID` | Owner of the **Graph** app registration | Both IDs. Not secret. |
| `GRAPH_CLIENT_SECRET` | Same | A client secret value for local development. Production never has one. |

`GRAPH_MANAGED_IDENTITY_CLIENT_ID` is **Azure only**. Leave it empty locally.

**Wording that gets a useful answer**, because "send me the client secret" gets
the Secret ID about half the time:

> For the app registration with client ID `<id>`: I need the **Value** of a
> current client secret (not the Secret ID — the Value is only shown once, at
> creation, so a new one may need to be generated). It is for local development
> on the PHB Platform. Please send it over Teams rather than email.

### What you can do before those requests come back

The app boots and the test suite runs with **no Microsoft values at all beyond
the two IDs above**. `lib/env.ts` requires exactly five variables at boot:
`DATABASE_URL`, `AUTH_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_ID`,
`AUTH_MICROSOFT_ENTRA_ID_TENANT_ID`, `ALLOWED_EMAIL_DOMAINS`. A missing one
fails on boot naming the variable.

So, waiting on IT:

| | Without the SSO secret | Without the Graph values |
|---|---|---|
| `npm run dev`, pages render | works | works |
| `npm test` | works — the suite never authenticates against Microsoft | works |
| Signing in | **fails** at Microsoft with `AADSTS7000215` | works |
| Change Orders mailbox health | n/a | reports `configured: false` and names the missing variables — this is a normal state, not an error |

The Graph values are the ones you can most safely be missing: the module reports
itself unconfigured and nothing else degrades.

### Never

Do not copy `.env.local` from another developer, and do not paste one into chat
or a ticket. It contains a database password and a client secret in plain text.
The file is gitignored and must stay that way — `.gitignore` covers it with
`.env.*`.

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

## The Change Orders tab shows a problem

The mailbox screen has four states that are not failures, and they are the ones
most likely to be reported as bugs.

| What the user sees | What it means | What to do |
|---|---|---|
| **"Nothing to review"** in Drafts | The Drafts folder is empty. It is empty most of the day — the automation produces drafts in bursts. | Nothing. This is the normal resting state and the default view. |
| **"The mailbox is not connected yet"** | No Graph credential is configured. Every pane shows this together, not one pane failing. | *The mailbox is not connected*, above. |
| **"That message is no longer here"** | The message was moved or sent between the list being drawn and the row being clicked. Power Automate moves messages constantly. | Nothing. The list refreshes itself. It is a normal event, not an error. |
| **"N inline images are part of this message and are not shown here yet"** | The message has `cid:` images — attachments on the message itself, not remote content. The platform does not turn them into bytes yet. | Nothing, unless somebody needs to see them: Outlook renders them. See *Images in a message body* below. |
| **"N remote images were blocked"** with a *Show images* button | Genuinely remote images. Loading one tells the sender the message was opened, by whom and when, so it is a per-message decision. | Nothing. Click it if the images matter. |
| **"N subject matches, newest first. Search does not look inside messages."** | Search matches the subject only, by design — `$search` returns ids that go stale on a move, so it is not used. Results are sorted by the service, because Graph will not sort a filtered collection. | Nothing. To find text inside a message, use Outlook. See *Folder search* below. |
| **"Showing the first N subject matches — there are more"** | The search hit its 500-match cap. | Narrow the term. The cap and why it is reported are under *Folder search* below. |

**Real failures** show "That did not load" with a Try again button, and the
underlying code is in the log as `"event":"mail.graph_call_failed"`. The
`outcome` field names which — `auth_failed`, `mailbox_forbidden`, `throttled`,
`network`. Each has its own section above.

---

## The Change Orders screen feels slow

**Measure before changing anything.** `scripts/co-measure.ts` instruments the
transport and attributes every Graph request to the operation that caused it:

```bash
npx tsx scripts/co-measure.ts     # read-only, writes nothing, never sends
```

What it reported against the live mailbox, and what each number means:

| Operation | Graph requests | Wall | Note |
|---|---|---|---|
| `listFolders()` | **11** | **~1,300ms** | The folder pane, on every mount. Sequential by necessity. |
| `listMessages()` | 1 | 90–520ms | The message list. |
| `getMessage()` | 1 | ~120ms | Opening a message. |
| `listAttachments()` | 1 | ~90ms | Second call the reading pane makes. |
| `searchMessages()` | 1 | ~90ms | One subject search. |
| `getDraftForEdit()` | 1 | ~95ms | One lock-refresh tick. |

So a cold page load was ~1.3s of folder walking plus ~0.5s of message listing
before anything was interactive, and **eleven of the fifteen requests were the
folder tree**.

### Why the folder walk is eleven requests

One listing of the top level, then one per parent per level - a level's paths are
not known until the level above comes back, so it cannot be parallelised - plus
four well-known alias lookups (`/mailFolders/inbox`, `drafts`, `sentitems`,
`deleteditems`) which do run in parallel. `wellKnownName` is beta-only, which is
why those four exist at all.

**It is now cached in memory for 30 seconds**, which docs/03 permits explicitly:
"Short-lived in-memory cache only (seconds), for list views." Re-measured: the
second read is **0 requests, 0ms**. The cache holds the in-flight promise, not
just the result, so the folder pane and the message list mounting together share
one walk instead of starting two.

The cost: a folder created or renamed in Outlook can take up to 30 seconds to
appear. The pane's *Try again* and any reload after that window pick it up.

**Messages are deliberately NOT cached.** A stale folder list is cosmetic; a stale
message list during a review means somebody could act on a draft that has already
been sent. `tests/mail-folder-cache.test.ts` asserts four reads make four
requests, so that boundary cannot drift.

### What was NOT the cause

Both were checked rather than assumed:

- **Dev-mode compilation** is a one-off, not persistent. First hit to a route
  ~640ms, then 25–50ms warm. Real, but it does not explain a screen that stays
  slow. Note that authed API routes answer 401 in ~10ms because middleware
  short-circuits before the route compiles, so timing those measures nothing.
- **A fast polling loop.** The message list polls every **20s** (**60s** when
  this was investigated; lowered in Phase 9 once the latency was measured) and
  only while the tab is visible; the draft lock refreshes every **45s** and only
  while the editor is open. No effect in either component can re-trigger itself - the one that
  could was the bug below. `reactStrictMode` is unset and there is no
  `<StrictMode>` in the tree, so effects are not double-invoked in dev either.

### The bug that was hiding in there: the editor reset itself every 60 seconds

Found while auditing effect dependencies for a loop, and worth its own note
because the symptom was reported as something else entirely.

The draft editor's open effect had `onGone` in its dependency array, and the
workspace passes `onGone` as an inline arrow - a new function identity on every
one of ITS renders. That effect resets `loaded`, `state`, `saved`, `sourceMode`
and `save` to their initial values, releases the advisory lock in its cleanup,
and re-reads the draft.

The workspace re-renders on every poll of the message list - every 20 seconds
since Phase 9, and 60 when this was found, so the fix matters more now. So
the editor wiped itself roughly **every 60 seconds**: anything typed since the
last autosave was lost, the paragraph box emptied, and the lock was dropped and
retaken. It was reported as *"the page refreshed mid-sentence and my text ended up
in a different field"* - the same words as the append bug above, and both were
real.

**The rule this leaves behind:** an effect's dependency array must not contain a
callback the parent rebuilds each render. Those callbacks live in a ref
(`callbacks.current`) and the open effect is keyed on the draft only -
`messageId` and whether images are on. If the editor ever starts losing keystrokes
again, check that array first.

---

## The dev overlay says `[object Event]` and the page keeps reloading

**Symptom.** In development only: Next's error overlay shows a runtime error whose
whole message is `[object Event]`, attributed to `coerceError` /
`onUnhandledRejection`. There is no stack worth reading and no clue what failed.
The page reloads itself, repeatedly, and anything typed is lost.

**This is not application code.** Next coerces a rejection with
`new Error('' + reason)`, so `[object Event]` means the rejected value was a DOM
`Event` rather than an `Error`. Nothing in this codebase rejects with an Event —
every promise the mail module starts with `void` ends in a catch-all. The two
places in the dependency tree that reject with an Event are:

```
react-dom-client.development.js    linkInstance.onerror = reject   (a stylesheet)
next/dist/client/app-bootstrap.js  el.onerror = reject             (a script)
```

Both mean **a CSS or JS chunk failed to load**. The reload is Next's dev client
trying to recover.

**The usual cause: something rewrote `.next` while `next dev` was serving.**
Running `npm run build` is the common one — `next build` and `next dev` share the
same `distDir`, so a build replaces the chunk files a browser tab is already
holding URLs for. The next chunk request 404s, the promise rejects with the load
event, and the page reloads. Anything half-typed in the draft editor goes with
it.

**Fix.** Restart the dev server, then hard-reload the tab. To confirm that is all
it was:

```bash
curl -s http://localhost:3000/signin -o /tmp/page.html
grep -oE '/_next/static/[^"?]+' /tmp/page.html | sort -u |
  while read -r a; do echo "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:3000$a") $a"; done
```

Every line should be `200`. A `404` is the whole story.

**Avoid it:** do not run `npm run build`, `npm test` in watch mode, or anything
else that writes `.next` while a dev server is up and somebody is using the page.
Nothing about this can happen in production — the overlay does not exist there and
chunks are immutable.

---

## The folder tree looks wrong or incomplete

**Symptom.** A folder that exists in Outlook is missing from the tree, or
`Projects` appears with nothing under it.

**First, the shape is not what it looks like.** `Projects` is a **child of
Inbox**, not a top-level folder. Project folders are at depth 2 and their
contents at depth 3. The live mailbox has **19 folders**, and the tree walks to
depth 5.

| Cause | What you will see | Fix |
|---|---|---|
| The tree was truncated | `"event":"mail.folder_tree_capped"` in the log, with `reason` naming `MAX_FOLDER_DEPTH` or `MAX_FOLDERS` | Raise the constant in `lib/modules/change-orders/mail/service.ts`. It is logged rather than silent precisely so this is answerable. |
| A folder is nested deeper than 5 levels | Same log line, `reason: MAX_FOLDER_DEPTH` | As above. Consider whether the mailbox structure is what you want first. |
| A well-known folder has no label | `"event":"mail.well_known_folder_unresolved"` | The mailbox is missing that special folder, or Graph refused the alias. The tree still renders; only the label is absent. |

**Do not add `wellKnownName` to a `$select` to "fix" a missing label.** It is a
beta-only property and asking v1.0 for it fails every folder read — see the next
section.

---

## Images in a message body — two kinds, two different notes

Reported as a bug — *"I opened a message and only saw broken placeholders, and
the Show images banner never appeared."* The banner was working. The message had
no remote images at all.

A mail body can carry three kinds of image, and they are not interchangeable:

| In the source | What it is | What the platform does |
|---|---|---|
| `src="https://…"` | **Remote.** Loading it tells the sender the mail was opened, from which IP, and when. | src removed, counted as `remoteImagesBlocked`, amber note with a *Show images* button. |
| `src="cid:…"` | **Inline.** An attachment on this very message. No privacy question — loading it costs nothing and tells nobody anything. | src removed, counted as `inlineImages`, neutral note with **no** button, because there is nothing to consent to. |
| `src="data:…"` | Inline bytes, already in the body. | Left completely alone. It needs no fetch. |

**Why a `cid:` src is removed rather than left in place.** A browser cannot
resolve the `cid:` scheme, and the platform does not yet fetch the attachment and
inline it. Leaving the src produced the browser's broken-image glyph, which reads
as *"this application is broken"* rather than *"this image lives in an
attachment"* — which is exactly how it was reported. With the src gone, the
stylesheet draws a labelled placeholder with the image's alt text and the note
above explains it. `cid:` was dropped from the CSP's `img-src` at the same time:
nothing in the document can carry one any more.

**In this mailbox, nearly every message with images has inline ones.** Measured
across Inbox: the automation's own failure notifications carry 4 remote and 2–4
inline; the `RE: Reminder — Change Order pricing` thread carries 2–3 inline and
**no** remote at all. So a message showing only the inline note is the normal
case, not a defect.

**If somebody needs inline images rendered**, that is real work and deliberately
not done: fetching each attachment and rewriting the body to `data:` URIs. It
inflates the body, and the reading pane is the one screen where vendor content
meets a send button. Outlook renders them today.

---

## Folder listing fails with 400 BadRequest

**Symptom.** Every folder read fails. The log shows
`"outcome":"unexpected"` with `status=400 code=BadRequest`, and the Graph body
reads *"Parsing OData Select and Expand failed: Could not find a property named
'wellKnownName' on type 'microsoft.graph.mailFolder'."*

**Cause.** `wellKnownName` exists on `mailFolder` in the Graph **beta** endpoint
only. Asking v1.0 for it in `$select` fails the entire request — it is not
ignored. This happened once, in Phase 4 Part B, the first time the real credential
was used.

**How the platform avoids it.** `FOLDER_SELECT` in
`lib/modules/change-orders/mail/service.ts` does not include it, and
`resolveWellKnownFolders()` identifies the special folders by requesting their
aliases instead — `/mailFolders/inbox`, `/drafts`, `/sentitems`,
`/deleteditems`. A test asserts no request ever contains `wellKnownName`.

**If you add a folder property**, check it exists in **v1.0** first. The published
`@microsoft/microsoft-graph-types` package is a reliable signal: if the property
is missing from the type, it is usually beta-only, and casting around the type is
how this bug got written in the first place.

**Do not match special folders on `displayName`.** It is localised to the
mailbox's language and any user can rename a folder in Outlook.

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

### The fence was verified from our side on 19 August 2026

IT's `Test-ApplicationAccessPolicy` reported Granted for
`changeorder@phb1899.com` and Denied for another user's mailbox. That is their
check. Ours, run with the real credential against a different real mailbox in the
tenant, returned:

```
403  ErrorAccessDenied
Access to OData is disabled: [RAOP] : Blocked by tenant configured AppOnly
AccessPolicy settings.
```

Both halves matter, and a policy that silently did not apply looks identical to
one that did until something tries. **Re-run this check whenever the app
registration's permissions change, or the policy is edited, or the credential is
replaced.** The mail service cannot perform it — the mailbox is not a parameter on
any of its methods, by design — so it needs a throwaway script that builds a raw
Graph client with the same credential and points it at another mailbox:

```ts
const raw = createGraphClient({ tokenProvider: graphTokenProvider() });
await raw.api(`/users/${someone.else}/mailFolders`).select("id").top(1).get();
// expect 403 ErrorAccessDenied
```

`$select=id` only, so that if the fence is ever broken the check reads as little
of someone's mailbox as possible. **A 200 here is an incident**: stop using the
credential and tell IT.

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

**What the Change Orders screen contributes.** It polls the selected folder every
**20 seconds**, and **only while the tab is visible** — switching away stops the
timer, and returning fires one catch-up read. A search is never polled, and
neither is a flat list somebody has paged back through.

The arithmetic, against the ~10,000 requests per 10 minutes above:

| | requests / 10 min | share of budget |
|---|---|---|
| one focused tab | 30 | 0.3% |
| three focused tabs | 90 | 0.9% |
| one focused tab, folder over 100 messages | 150 | 1.5% |

**180 requests an hour per focused tab.** One request per poll, because every
folder in this mailbox fits inside a single page of 100; a folder that outgrew
that would make a grouped poll up to 5 *sequential* requests, which is the 1.5%
row. The budget would take roughly 300 simultaneously-focused tabs at this
interval, against an expected 1–3.

The **4-concurrent-per-mailbox** limit is not the binding one either. A poll is
one sequential request of ~200ms, so a single tab never has more than one in
flight, and three tabs at 20s overlap only by accident.

A backgrounded tab costs nothing, which is the part that matters most — it is
what stops a tab left open over a weekend being the real bill.

**It was 60 seconds until Phase 9.** Lowered because the latency was measured
rather than guessed: a platform write is visible in a folder listing on the first
250ms poll, so Exchange contributes almost nothing and the interval was the
entire user-visible delay. See *Is Part B (change notifications) worth building?*
below.

If throttling does become a problem, raise `POLL_INTERVAL_MS` in
`app/(modules)/change-orders/mailbox-workspace.tsx` before touching anything in
the retry path. Check first whether a browser tab was left open somewhere with
the polling still running — that is the likelier cause than the interval itself.

---

## Who sent a message, and when

**`audit_events` is the only record.** Under app-only auth Exchange records the
*application* as the sender, not the person — the Sent Items copy in
`changeorder@phb1899.com` says nothing about which employee clicked send. This
row is it.

```sql
SELECT a.occurred_at,
       e.email                AS sent_by,
       a.metadata->>'subject' AS subject,
       a.metadata->'to'       AS recipients
FROM audit_events a
LEFT JOIN employees e ON e.id = a.actor_employee_id
WHERE a.action = 'mail.sent'
ORDER BY a.occurred_at DESC
LIMIT 50;
```

`mail.draft_edited` records who changed a draft and which fields, never the
content.

**A send with no audit row is possible, and is logged.** The row is written after
Exchange confirms the send, because recording a send that never happened is worse
than the alternative — a false entry is a false alibi. If the insert itself then
fails, the same facts go to the application log as
`"event":"mail.sent_audit_failed"` with `outcome: sent_without_audit_row`. Search
the logs for that before concluding a message was never sent from the platform.

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

## How draft editing preserves the message

Worth understanding before changing anything in the editor, because the
obvious simplification is the one that breaks it.

A "New CO logged" draft is 1.3-4KB of Outlook HTML: one table, 12-28 `style`
attributes, a `<style>` block. **Sanitizing it discards 59-83% of that**,
including the grey header row and the Calibri 11pt on every cell. Sanitizing is
right for *rendering* - it is what makes vendor HTML safe to display - but a
draft saved back in sanitized form would reach the vendor visibly degraded.

So the editor never re-emits the body. It parses the raw HTML, records the
exact source offsets of each run of text, and splices edits into the original
string. Everything outside an edited run survives **by construction** rather
than by careful round-tripping.

| The screen | What it writes |
|---|---|
| Message text fields | Only the edited runs, spliced by offset. Markup untouched. |
| Add a paragraph | An insertion before `</body>`, **on an explicit click only** — see below. |
| Edit HTML source | **Replaces the whole body.** The escape hatch, for structural changes. |
| Subject / recipients only | The body is not sent at all, so it cannot change. |

### Adding a paragraph is a deliberate click, never an autosave

**Do not move `appendNote` back into the debounced autosave.** It was there once
and it mangled message bodies.

An append is not idempotent. Autosaving it meant every 1.2-second pause committed
whatever had been typed so far and then cleared the field, so one sentence typed
with two pauses became three paragraphs. Measured against the live mailbox:

```
typed: "Hello Joel," ... " thanks for the pricing" ... " on RFI 229."
stored: <p>Hello Joel,</p><p>thanks for the pricing</p><p>on RFI 229.</p>
```

To the reviewer it looked like the text jumping into a different box mid-sentence,
because each committed chunk came back as its own editable segment while the note
field emptied itself. It was reported as two separate bugs — "my text ended up in
a different field" and "Add a paragraph did nothing" — and both were this.

How it works now:

- The debounced autosave carries **only idempotent writes**: subject, recipients,
  segment splices, and the source-view body. Sending any of those twice is
  harmless.
- The paragraph is appended when somebody clicks **Add this paragraph**, or as
  part of the flush immediately before a send — both single actions, so both
  append once. The hint under the box says which state it is in.
- Dropping a typed-but-uncommitted paragraph at send time would be worse than
  either, so the send flush includes it.

`tests/draft-note.test.ts` pins the operation down, including that calling it
three times produces three paragraphs — the behaviour to avoid, asserted so the
reason stays visible.

### An autosave no longer overwrites what you are still typing

The rebase after a successful save used to adopt the server's value for every
field unconditionally, so a keystroke that landed while the request was in flight
was silently reverted. It now compares what is on screen against what was
actually sent: if they differ, the person has typed since and their text wins.

`bodyEdits` is still reset on rebase, deliberately — segment ids are recomputed
from the new body, and splicing with a stale id would write to the wrong place,
which is worse than losing one in-flight character.

Two consequences to keep in mind:

- **The text fields cannot change structure.** No new table rows, no
  formatting. That is the trade that keeps the automation's output intact; the
  source view is the way round it.
- **Autosave sends only changed fields.** Editing the subject does not rewrite
  the body. If that ever regresses, a draft could be rewritten by someone who
  only fixed a typo in the subject line.

Exchange itself was the open question - a store that normalised HTML on write
would defeat all of the above. It does not. Verified against a ZZTEST draft
containing a real pasted table: PATCHing a body back verbatim returns the same
3,513 bytes, and splicing one table cell stored exactly the bytes intended -
table, 2 rows, 8 cells, 29 `style` attributes, 11 classes, the `<style>` block,
CRLFs and `&nbsp;` all identical either side of the write.

One thing Exchange *does* rewrite: a literal U+00A0 comes back as `&nbsp;`, so
the encoder emits `&nbsp;` itself. Without that, every edit touching a
non-breaking space differed from what was sent by five bytes.

The preview beside the fields renders the body **Exchange currently holds**,
not a copy fetched when the message was opened. It arrives with the draft and
again with every save, so it cannot disagree with the fields. It used to: the
preview came from the read API and was never re-read, so a saved edit appeared
in the field and not in the pane beside it, which reads as "nothing saved".
While a keystroke is still inside the autosave window the pane is marked
*updating…* rather than left to silently disagree.

**The preview keeps the message's formatting.** The sanitizer allows inline
`style` attributes, one declaration at a time, against a fixed list of visual
properties - colours, fonts, borders, padding, alignment. It still discards
`<style>` ELEMENTS along with their contents, and still drops `class` and `id`.

The reason that allowance is narrow rather than absent: nothing on the list can
name a URL (`background-image`, the `background` shorthand, `cursor`, `content`,
`list-style-image` and `filter` are all unlisted) and nothing on it can position
an element (`position`, `top`, `left`, `z-index`, `transform`). So CSS cannot
make a network request - it cannot become the read receipt that blocking remote
images exists to prevent - and cannot lay message content over anything. Values
are pattern-matched as well: only `rgb()`/`rgba()` admit a parenthesis at all,
so `url(` and `expression(` cannot be spelled by any accepted value.

If a draft ever renders unstyled, the cause is usually a declaration whose value
does not match its pattern, and the fix belongs in the pattern rather than in
the property list. Two were found that way against a real draft: Outlook writes
`aptos_embeddedfont` in its default font stack and the pattern rejected the
underscore, and `direction` / `box-sizing` appear on every body it generates but
were missing. Both are covered in `tests/mail-sanitize.test.ts` now.
Fields are labelled by **priority, not nesting depth**. Outlook writes a pasted
table cell as `<td><p>value</p></td>`, so taking the innermost element called
all eight cells of an automation table "paragraph" - accurate and useless when
the labels exist so a reviewer knows which value they are changing.
The guarantee is tested two ways: `tests/body-text.test.ts` covers it with
synthetic fixtures shaped like the real thing, and a one-off gate ran the same
properties against nine real bodies before any of it shipped. Real message
bodies are deliberately **not** committed as fixtures - CLAUDE.md forbids
persisting message content, and a test fixture is persistence.

---
## Editing a draft goes wrong

| What the user sees | Code | Cause | What to do |
|---|---|---|---|
| **"This draft changed in Outlook while you were editing"** | `mail_conflict` | Somebody edited the same draft in Outlook, or an autosave landed late. The platform refused rather than overwriting. | Reload the draft. Nothing was lost in Exchange — the Outlook version is intact. |
| **"Someone else in the platform is editing this draft"** | `mail_locked` | Another employee has it open. Locks lapse after 90 seconds, so a closed tab frees it. | Wait, or check who: `SELECT held_by_id, expires_at FROM draft_locks;` |
| **"This message has already been sent"** | `mail_not_draft` | The draft was sent — possibly from Outlook — while it was open here. | Nothing. Sent messages are immutable in Exchange; this is the correct refusal. |
| **"Not saved"** in the editor | varies | Any save failure. **The send button is disabled while this shows.** | Fix the underlying error. Do not work around it: an unsaved edit means the content on screen is not the content that would send. |

### Deleting a draft in Outlook does not make it vanish from the platform

Worth knowing, because the opposite is the natural assumption. Deleting a draft
in Outlook **moves it to Deleted Items**, and the platform addresses messages by
their *immutable* id — which is the whole point of
`Prefer: IdType="ImmutableId"` and survives a move between folders. So the draft
stays readable and editable through the platform, from the bin. Verified against
the live mailbox.

What actually produces each outcome:

| In Outlook | The platform then reports |
|---|---|
| Delete (to Deleted Items) | Nothing changes. Still a draft, still editable. |
| Delete permanently (Shift+Delete, or emptying the bin) | `not_found` — pane clears, list refreshes |
| Send the draft | `mail_not_draft` — a sent message is immutable in Exchange |
| Edit and save the draft | `mail_conflict` on the next save from the platform |

**A stranded lock cannot block a send for long.** `draft_locks` holds only a
message id, a holder and an expiry, and every read treats an expired row as
absent. To clear one by hand:

```sql
DELETE FROM draft_locks WHERE message_id = '<immutable id>';
```

That table is disposable. Dropping it entirely loses nothing but a few seconds of
coordination between two people in the platform — **it is not a permission
system**, and Outlook holds no lock at all.

---

## A write was refused outside production — `mail_write_disabled`

**Symptom.** A draft edit, reply, forward, compose, move, delete or attachment
change fails with `mail_write_disabled` and `"event":"mail.write_blocked"`.

**Cause.** Outside production, write operations are permitted only on messages
whose subject **begins with** `ZZTEST`. Contains-anywhere is not enough — a
vendor could otherwise name a real message so the platform would write to it.

The subject is read from Exchange at the moment of the check, not taken from the
caller, so passing `"ZZTEST"` in as an argument does not open the fence. There is
**one** exception, and it is structural rather than a loophole: creating a draft
from scratch has no message in Exchange to read a subject from, so the fence is
applied to the subject the caller asked for — and then applied a second time to
what Exchange actually stored, before the draft is handed back. A caller who lies
about the subject affects only the empty draft it is about to create.

**Exchange's reply and forward prefixes are skipped.** `RE:`, `FW:` and `FWD:`
are stripped, repeatedly, before the `ZZTEST` test:

| Subject | Inside the fence? |
|---|---|
| `ZZTEST anything` | yes |
| `RE: ZZTEST anything` | yes |
| `FW: RE: ZZTEST anything` | yes |
| `[CCHMC RFI 229] New CO logged` | no |
| `RE: [CCHMC RFI 229] New CO logged` | **no** |
| `Notes RE: ZZTEST` | no — the prefix has to be at the front |

**Why that was necessary, and not a weakening.** `createReply` names the draft it
produces `RE: <original>`. Without stripping the prefix, replying to a ZZTEST
message in development produced a draft called `RE: ZZTEST …` that the platform
would then refuse to edit or send — so the whole reply path was unverifiable
outside production, which is the only place verifying it is possible at all.
The case that protects the live pipeline is unchanged: a reply to a real change
order is still refused.

en-US prefixes only. `AW:`, `WG:` and other locales are deliberately absent —
this mailbox is en-US and will never produce them.

**Fix.** To exercise a write path in development, create a message in the mailbox
whose subject starts with `ZZTEST`. Do not disable the guard.

---

# Change Orders — full email actions (Phase 8)

## Reply and forward must come from Exchange, never from string assembly

**Read this before touching anything in the respond path.** It is the entry in
this file most likely to be "simplified" into a silent production failure.

The platform creates a reply by asking Exchange for one:

```
POST /users/{mailbox}/messages/{id}/createReply
POST /users/{mailbox}/messages/{id}/createReplyAll
POST /users/{mailbox}/messages/{id}/createForward
```

The body of that POST is `{}`. Nothing about the message comes from the caller.

**What Exchange gives back that hand-building would lose:** the quoted original,
the `In-Reply-To` and `References` headers, the recipient list derived from the
original headers, and — the load-bearing one — the **same `conversationId` as the
message being replied to**.

**Intake 6 matches replies by conversation ID.** A reply that breaks the thread
breaks the automation's filing, and it breaks it *silently* — no error, no
bounce. Nobody notices until somebody asks why a message was never filed. That
is the failure this design exists to prevent, and it is why the route schema
rejects a `comment`, a `body`, or recipients: `createReply` would happily accept a
`comment` and put it in the draft, which would be a second way to get content
into an outbound message. There is exactly one — the editor, with a human looking
at it.

**Attachments come along on a forward.** `createForward` copies them; the
platform does not enumerate or re-upload anything. Verified against the live
mailbox rather than assumed — see the verification record below.

---

## A reply draft opens in the same editor as everything else

There is one editing surface. Reply, reply-all, forward and compose all end the
same way: a draft id, opened in the Phase 6 editor, with the same splice-based
body editing, the same autosave, the same advisory lock, the same send
confirmation and the same audit row.

**If you are about to add a second one, don't.** A separate compose window would
mean a second place for the splice logic, the changeKey conflict check and the
send confirmation to drift — and the send confirmation is the last thing standing
between a draft and a vendor.

**A composed draft starts genuinely empty**, which is the one case the editor's
*Add a paragraph at the end* field exists for: an empty body has no text runs to
splice into, so the segment fields have nothing to show. The field is open by
default when there are no segments, precisely so an empty draft does not look
like one that cannot be edited. The draft is created with an explicitly empty
**HTML** body rather than no body at all, so `bodyFormat` is deterministic
instead of whatever Graph defaults to.

---

## Moving a message

```
POST /users/{mailbox}/messages/{id}/move   { "destinationId": "<folder id>" }
```

**The message keeps its id.** Exchange assigns a moved message a *new* id
normally, but `Prefer: IdType="ImmutableId"` is set on every request by
middleware, and immutable ids survive a move. This is not taken on trust: the
service compares the id before and after, returns `idChanged`, and logs
`"event":"mail.move_changed_id"` at warn level if it ever differs.

**If you see that log line, treat it as serious.** It means the immutable-id
header has stopped taking effect, and every id the browser is holding is one move
away from being stale. The symptom users would report is messages that cannot be
reopened. Start at `ImmutableIdMiddleware` in
`lib/modules/change-orders/graph/client.ts`.

| What the user sees | Code | Cause | What to do |
|---|---|---|---|
| **"That item is no longer in the mailbox"** after picking a folder | `not_found` | The destination folder was renamed or deleted in Outlook since the tree was read. Graph answers `ErrorFolderNotFound`. | Reload the page to re-read the tree, then move again. |
| Same, on the message rather than the folder | `not_found` | The message id is stale — Power Automate filed it already, or somebody moved it in Outlook. A stale id is a **400** from Graph, not a 404, and is mapped to `not_found` deliberately. | Nothing. The list refreshes. |
| **"Its identifier changed during the move"** in the moved banner | n/a | `idChanged` was true. Should be impossible. | The paragraph above. |

The folder picker opens every folder that has children, unlike the sidebar. That
is deliberate: `Projects` is a child of Inbox, so a collapsed tree in a *picker*
hides every destination anybody actually wants.

---

## Deleting a message — it is not permanent, and it never will be

```
POST /users/{mailbox}/messages/{id}/move   { "destinationId": "deleteditems" }
```

**A move, not `DELETE`, and that is a correction the live mailbox forced.**

`docs/03` and `PHASE-8.md` both said `DELETE /messages/{id}` moves a message to
Deleted Items. It does not. Verified twice in Phase 8, on a draft and on a
received message: after `DELETE`, the message's `parentFolderId` resolves to a
folder named **`Deletions`** — Recoverable Items \ Deletions, the dumpster, 209
items in this mailbox — while the user-visible **Deleted Items** folder held 4 and
never saw it.

Nothing is destroyed either way, and the message stays addressable by the same
immutable id. But recovery from Recoverable Items needs Outlook's **Recover
Deleted Items from Server** dialog and is bounded by the deleted-item retention
window, where recovery from Deleted Items is opening a folder and dragging.

So the platform issues an explicit move instead. The message lands in **Deleted
Items** in `changeorder@phb1899.com` and stays there until Exchange's retention
removes it. Anyone with the mailbox open in Outlook can drag it back. The
confirmation dialog says so in those words, deliberately: a person who believes a
delete is permanent avoids an operation that is safe, or goes looking for one that
is not.

**If you are tempted to "simplify" this back to `DELETE`** — that is the change
this entry exists to prevent. It is one request either way; the difference is
entirely in where the message ends up.

`destinationId` accepts a well-known folder name, so this costs no extra request to
resolve the folder, and a test asserts no `/mailFolders/` lookup happens.

**`permanentDelete` is not exposed, and must never be.** Not behind a
confirmation, not in an admin screen, not behind an environment variable.
`CLAUDE.md` and `docs/03-exchange-and-graph.md` both forbid it, it destroys the
audit trail, and there is no legitimate need for it in a change-order mailbox.
Three tests enforce this: no service method whose name contains `permanent`,
`purge` or `harddelete`; the string `permanentDelete` appears in no source file
under `lib/modules/change-orders`, `app/api/modules/change-orders` or
`app/(modules)/change-orders` outside a comment; and the service write allowlist
must be edited by hand before any new write can ship.

**Deleting a message somebody already deleted** answers `not_found`. Ordinary,
not an error.

---

## Folder search: subject-only, sorted here, and capped

**Read this before "restoring" full-text search or adding an `$orderby`.** Both
look like obvious improvements. One of them breaks every search outright.

Searching a folder sends:

```
GET /users/{mailbox}/mailFolders/{id}/messages
    ?$filter=contains(subject,'<term>')
    &$select=<metadata>
    &$top=<n>
```

### Why not `$search`

`$search` **ignores** `Prefer: IdType="ImmutableId"`. The header is on the request
— a test asserts that for every request without exception — and Graph returns
standard, folder-scoped ids from a search anyway.

Measured against the live mailbox, same message, same folder, header on both:

```
$filter listing   AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A…TPFR8QAA   immutable
$search           AAMkADE0NjQyNmExLTYzMTEtNGYwYS04Mj…M8YDjAAA=   standard
```

The way to confirm the header still works at all is to strip it and compare: a
listing without it returns the `AAMkAD…` form, with it the `AAkALg…` form.

**A standard id changes when the message moves**, which is the entire reason the
header exists, and Power Automate moves messages constantly. So every id the
search box produced was one move away from being dead — and a platform `move`
performed with one succeeded while leaving the caller holding a 404. That was
found by the Phase 8 move verification failing.

**A GET cannot translate one.** Asking for a message by its standard id returns
that same standard id; Graph echoes back whichever form addressed the resource.
Only a collection request yields an immutable id, which is why the fix was to
change how search queries rather than to convert its results.

### The cost, which is real

Subject only. Not the body, not the sender, not attachment names.

Accepted because subjects here carry the bracketed project tag people actually
search for — `[CCHMC RFI 229]` — and because a stale id is a correctness bug
where a narrower search is a smaller feature. If somebody needs to find text
inside a message, Outlook is still a fully working path and always will be.

Matching is case-insensitive: `zztest` finds `ZZTEST`.

### Do not add an `$orderby`

Exchange answers **`400 InefficientFilter`** to `$filter` combined with `$orderby`
on a message collection. Verified for `contains` and `startswith`, both with and
without the ordering:

| Request | Result |
|---|---|
| `$filter=contains(subject,'x')` | 200, immutable ids |
| `$filter=contains(subject,'x')` + `$orderby=receivedDateTime desc` | **400 InefficientFilter** |
| `$filter=startswith(subject,'x')` | 200, immutable ids |
| `$filter=startswith(subject,'x')` + `$orderby` | **400 InefficientFilter** |
| `$search="x"` | 200, standard ids |

`tests/mail-search.test.ts` asserts no `$orderby` is ever sent, with this reason
attached. If search starts failing with *"Something went wrong reaching the
mailbox"* and the log shows `code=InefficientFilter`, an ordering has been added
back. It does not degrade search, it breaks every search.

### So the service does the sorting, over the whole result set

Graph will not order a filtered collection, and the order it returns is neither
date nor relevance — a real folder came back 08-19, 08-19, 08-18, 08-25, 08-06. So
`searchMessages` collects every match up to a cap, sorts newest-first, and returns
the lot in one response.

**A search therefore has no cursor**, and the UI shows no "Load older messages"
button for search results. That is not an omission.

**Why not sort each page as it arrives**, which would have been free: Exchange's
underlying order is arbitrary, so page two can hold messages newer than the last
row of page one. The list would look ordered and not be — and somebody scanning
for the newest thing would find it below a "Load older" button. A subtly wrong
order is worse than an openly absent one.

| Bound | Value | What happens at it |
|---|---|---|
| Matches collected | 500 | `truncated: true` in the response, `"event":"mail.search_capped"` in the log |
| Requests per search | 5 | same |
| Page size | 100 | — |

In this mailbox a search is **one request** — the largest folder holds 13
messages. The loop exists for the project folder that has grown to thousands by
2030.

**Truncation is reported, not just logged.** The API returns `truncated` and the
list pane says *"Showing the first N subject matches, newest first — there are
more."* A search that quietly stopped at 500 would look exactly like a complete
answer, which is the failure mode this file cares about most.

**Results are deduplicated by id** as they accumulate. `$skip` into a collection
with no guaranteed order can return the same row on two pages if Exchange's order
shifts between the requests, and a duplicated row in a list somebody is about to
move or delete is not acceptable.

**A message with no usable `receivedDateTime` sorts last**, never first — an
unknown date must not be presented as the newest thing in the mailbox. An
unparseable date string is treated as absent.

### The apostrophe

The term goes into an OData string literal, so a quote is escaped by **doubling**
it — not with a backslash. Get it wrong and searching for `P&G Reese's` sends
`contains(subject,'P&G Reese's')` and Graph answers 400 on a query that looks
completely ordinary. This mailbox has a folder called `P&G Reese's`, so it is not
hypothetical. Control characters are stripped rather than escaped.

### Paging, internally

`$skip`, with Graph's `nextLink` repeating the filter. This is now an
implementation detail of collecting the result set rather than something the
caller sees — the caller gets one sorted response. The overlap hazard that paging
an unordered collection carries is handled by the dedupe above.

---

## Attachments

### Downloading

The bytes stream **through the backend** from Graph:

```
GET /messages/{messageId}/attachments/{attachmentId}          # metadata first
GET /messages/{messageId}/attachments/{attachmentId}/$value   # then the bytes
```

**Why not hand the browser a Graph URL.** It would need the app-only token
attached, and that token can read the entire mailbox. Nothing that reaches a
browser may be able to do that.

**Nothing is written to disk or to the database, ever** — not even briefly. The
bytes live in memory for the length of one response. `docs/03`: never persist
attachment content.

Metadata is read first so the size is known before anything large is pulled into
memory, and so `contentBytes` is never selected on a message read. An attachment
over 25 MB is refused with `mail_attachment_too_large` before any content is
fetched.

**An attachment's `size` is not its content length.** It carries per-attachment
storage overhead, and the overhead is not preserved when Exchange copies the
attachment:

| | Reported `size` | Actual content |
|---|---|---|
| A PDF on a received message | 337,527 | 337,145 |
| The same PDF on a forward of it | 337,532 | 337,145 |

So never compare sizes to answer "is this the same file" or "did the download
complete" — compare content, or a hash of it. `size` is only ever displayed. The
Phase 8 verification script asserted size equality at first and reported a
meaningless 5-byte failure on a forward whose bytes were identical.

**Three independent reasons the browser will not execute a downloaded
attachment**, because a vendor chooses its declared type and one of these being
enough is not something to rely on:

1. A renderable content type — `text/html`, `image/svg+xml`, `text/xml`,
   `application/xhtml+xml` — is served as `application/octet-stream` instead.
2. `Content-Disposition: attachment`, never `inline`.
3. `X-Content-Type-Options: nosniff`.

**The filename never reaches a header in the form a vendor wrote it.**
`safeAttachmentName` discards everything before the last `/` **or** `\` (both,
because the platform runs on Linux in Azure and Windows locally), strips control
characters — CR and LF above all, where a newline would be header injection
rather than an odd filename — neutralises Windows device names like `CON.pdf`,
and never returns an empty string. The header carries both spellings per RFC
6266: an ASCII-reduced `filename=` and the real UTF-8 name in `filename*`.

A message forwarded as an attachment (an *item* attachment) is a message rather
than a file, so it is served as `message/rfc822` and named `.eml` — otherwise it
downloads with no extension and will not open.

### Adding

Under 3 MB is a single POST. At or above 3 MB Graph requires
`createUploadSession`, and the chunks are PUT to the pre-authenticated
`uploadUrl` **without** an Authorization header — Microsoft documents that, and
sending one can fail the upload. That is the one place in this codebase where a
request to Microsoft does not go through the Graph client; it uses the service's
injected `uploadFetch` so it stays inside the service boundary and stays
testable.

Chunks are sequential, 3.2 MB each, in order. Not parallel — Graph requires the
ranges in order, and parallel PUTs against one mailbox through one app identity
is how throttling starts.

**A throttled chunk fails the whole upload rather than retrying.** An upload
session cannot be resumed by replaying a chunk blindly, and a half-uploaded
attachment that looks complete is worse than asking the person to add the file
again. The user sees *"The mailbox is busy. Try again in a moment."*

### What is refused, and why

| Refusal | Code | Rule |
|---|---|---|
| Program or script content | `mail_attachment_rejected` | Blocked by **extension** and by **content type**, independently. Extension because the content type is whatever the browser guessed and an attacker picks it; content type because the name can be anything. **Every** extension in the name is tested, not only the last — `invoice.pdf.exe` ends in `.exe`, and `invoice.exe.pdf` is the trick that relies on Windows hiding known extensions. |
| Over 25 MB | `mail_attachment_too_large` | Exchange Online's own per-message ceiling is 25 MB for most tenants, and a message over it is rejected **at send time** — after the human clicked send, which is the worst possible moment to find out. |
| An empty file | `mail_attachment_rejected` | Nothing useful, and an ambiguous request. |
| Removing an attachment from a sent or received message | `mail_not_permitted` | A sent message is the record of what actually went. Editing that record would be falsifying it. Exchange refuses it anyway; this is the honest error rather than a Graph failure. |

A refused attachment is answered as **422**, not 500: the request was well-formed
and the value in it was not acceptable. The browser shows the reason next to the
file picker rather than a failure pane.

### The assertion that matters most

**A draft the automation created already carries attachments that downstream
flows expect.** Adding or removing one must not disturb the others.

Two things make that true rather than hoped-for. The add request never names the
existing attachments — it adds a sibling rather than replacing a set, so Exchange
has nothing to interpret as "the whole collection". And every add and remove
returns the **refreshed list read back from Exchange**, which is what the browser
displays. So "the other attachments survived" is something the person sees, not
something they assume.

---

## Who moved, deleted or attached — the audit trail

Same reasoning as `mail.sent`: under app-only auth Exchange records the
*application* as having done it, so these rows are the only record of which
person did.

```sql
SELECT a.occurred_at,
       a.action,
       e.email                 AS by,
       a.metadata->>'subject'  AS subject,
       a.metadata
FROM audit_events a
LEFT JOIN employees e ON e.id = a.actor_employee_id
WHERE a.action IN ('mail.moved', 'mail.deleted', 'mail.draft_created',
                   'mail.attachment_added', 'mail.attachment_removed')
ORDER BY a.occurred_at DESC
LIMIT 50;
```

| Action | Metadata worth reading |
|---|---|
| `mail.moved` | `destinationFolderId`, `subject`, and `idChanged` — see the move section |
| `mail.deleted` | `subject`, and `destination: "deleteditems"` so the row says where to go looking |
| `mail.draft_created` | `mode` — `reply`, `replyAll`, `forward` or `compose` — and `sourceMessageId`, which is null for a composed one. A reply draft nobody remembers making is otherwise indistinguishable from one the automation produced. |
| `mail.attachment_added` | `name` and `sizeBytes`. **Never content** — an audit row is not a place to start persisting attachment bytes. |
| `mail.attachment_removed` | `attachmentId` and how many remain |

---

## The service write allowlist — read this before adding a write

`tests/mail-guards.test.ts` asserts that the set of write-shaped methods on the
mail service is **exactly** a list written out by hand in that test. Adding a new
way to change the mailbox fails the suite until somebody comes to that list and
names it.

That is the point, and it is not a formality: the list is where the reviewer
finds out that a new write exists at all. It currently holds eleven entries,
including `createDerivedDraft` — the private method the three `createReply*`
methods share. Private is a compile-time notion in TypeScript, so a private write
method is still a write method at runtime, and naming it is the honest outcome.

The same file also asserts that `sendMail` and `permanentDelete` appear nowhere in
the module, its API routes or its UI — comments that forbid them excepted.

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

## Sign-in lands on `{"message":"Not found"}`

**Symptom.** Sign-in appears to work — Microsoft accepts the login — and the
browser lands on a blank page reading `{"message":"Not found"}`. The URL is
`localhost:3000/api/auth/callback/microsoft-entra-id?code=...`

**Cause.** Something else already owns port 3000, so Next.js quietly started on
3001. Entra redirected to the URI registered on the app registration, which is
port **3000**, and hit whatever is actually listening there.

On a machine with Grafana installed, that is Grafana. `{"message":"Not found"}`
is Grafana's 404 format — Next.js returns an HTML error page, not JSON. **The
JSON body is the diagnosis:** a second application answered.

**Confirm it.**

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen |
  ForEach-Object { Get-Process -Id $_.OwningProcess } | Select-Object Id, ProcessName
```

**Fix.** The platform must own 3000. Changing the Entra redirect URI needs Azure
portal access; a port number is a local config file. So the other application
moves.

For Grafana, in an **elevated** shell — the config is under Program Files:

```powershell
Set-Content 'C:\Program Files\GrafanaLabs\grafana\conf\custom.ini' `
  -Value @('[server]', 'http_port = 3001') -Encoding ASCII
Restart-Service grafana
```

Three details that each cost time on 21 August:

- Edit **`custom.ini`, never `defaults.ini`.** Grafana layers the former over the
  latter, and an upgrade overwrites the latter — so a port set there silently
  reverts. Create `custom.ini` if it does not exist.
- **Give it 15–30 seconds** before checking the port. The service reports
  `Running` well before Grafana binds, and if Grafana was installed through NSSM
  the service is the *wrapper*, which reports `Running` even when the app it
  wraps has crashed.
- If the service path points at `nssm.exe`, it tells you nothing about where
  Grafana lives. Find the config by searching for `defaults.ini` instead.

**Why the dev server is pinned.** `package.json` runs `next dev -p 3000`. With an
explicit port, Next fails immediately with `EADDRINUSE` naming the port. Without
it, Next moves to 3001 and you discover the problem twenty minutes later as a
broken auth callback. **Do not remove the `-p`.**

---

## What expires, and when

| Credential | Where | Expires | Breaks what |
|---|---|---|---|
| SSO client secret | `AUTH_MICROSOFT_ENTRA_ID_SECRET` in `.env.local` | **13 August 2028** | Local development only |
| Graph client secret | `GRAPH_CLIENT_SECRET` in `.env.local` | **13 August 2028** — *unconfirmed, see below* | Local development only |

> **The Graph secret's expiry date needs confirming in the portal.** `.env.local`
> carries a note reading `Expiry Date of Entra : 8/13/2028`, but the same note
> appears twice and the earlier one belongs to the SSO secret. A secret created in
> August 2026 with a default 24-month lifetime would expire in August 2028 too, so
> the date is plausible either way and that is exactly why it should not be taken
> on trust. Open the Graph app registration → Certificates & secrets, read the
> real date, and correct this row.

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

**Graph app registration** — client ID `d1795907-d017-4a5e-9da3-033c4bee4ec1`,
tenant `48f37f84-1c36-4b3e-986c-b8b7196ad49d`. Neither is a secret. It is a
**second, separate** registration from the SSO one; do not merge them.

Application permissions: `Mail.ReadWrite` + `Mail.Send`, scoped to
`changeorder@phb1899.com` alone by an Exchange ApplicationAccessPolicy.

### The Graph secret cannot affect production

Same reasoning as the SSO secret above, and worth repeating because it is the
question someone will ask when this expires.

Production authenticates to Graph with a **managed identity and a federated
identity credential**. Nothing in that path expires, and there is no
`GRAPH_CLIENT_SECRET` in Azure at all — `createGraphCredential` in
`lib/modules/change-orders/graph/credential.ts` **throws on startup** if one is
set with `NODE_ENV=production`, and `infra/main.bicep` does not define the
variable. So when this secret expires, only developer machines are affected. The
mailbox keeps working, the scheduled jobs keep working, and nobody outside
development notices.

If an expiring Graph secret ever *does* break production, the fault is that a
secret was deployed at all. Fix that; do not rotate it.

### Symptom when the Graph credential fails

The mailbox health endpoint returns `500` with code `mail_auth_failed`, and the
log carries `"event":"mail.graph_call_failed"` with `"outcome":"auth_failed"`.
The user-facing message is *"The platform could not sign in to the change-order
mailbox."*

| What happened | What you will see |
|---|---|
| Secret expired or wrong | `mail_auth_failed`. Underneath, Entra returns `AADSTS7000215: Invalid client secret provided`. |
| Client ID or tenant ID wrong | `mail_auth_failed`, with `AADSTS700016` (application not found) or `AADSTS90002` (tenant not found). |
| Secret missing entirely | The module reports `configured: false` and names `GRAPH_CLIENT_SECRET`, rather than failing — outside production the credential factory requires one. |
| Permissions not consented | `mail_access_denied` (403), not `mail_auth_failed`. A token was issued; Exchange refused it. See *`mail_access_denied` — the access policy*. |

**Rotating it.** Azure portal → Microsoft Entra ID → App registrations → the
Graph registration (client ID above) → Certificates & secrets → New client
secret. Copy the **Value**, not the Secret ID — the Value is shown once. Put it in
`.env.local` as `GRAPH_CLIENT_SECRET` and restart the dev server. Delete the
expired secret afterwards. Never commit it; `.env.local` is gitignored.

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

**Fix — preferred.** Set `BOOTSTRAP_ADMIN_EMAIL` and re-run the seed:

```bash
npm run seed
```

It is comma-separated — list every address that should be an admin. Missing rows
are created; existing rows are promoted **only because no active administrator
remains**, which is exactly this situation. In normal operation the seed never
re-promotes anyone, so a deploy cannot quietly undo a demotion made in the UI.

A row it creates keeps `entra_oid = NULL` until its owner signs in for the first
time, at which point the object ID is stamped onto the existing row.

**It only sets the admin flag.** A bootstrap admin whose account is *disabled*
stays disabled, and the platform is still locked out. Re-enabling an account is a
decision for a person, not for a deploy — so if every bootstrap admin is also
disabled, use the direct SQL below, which sets both.

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

## A deploy fails

**Symptom.** The Deploy workflow is red, or it is green and the site still serves the
old build.

**First: which step?** The workflow is ordered so the step name is the diagnosis.

| Step that failed | Cause | Fix |
|---|---|---|
| *Sign in to Azure* | The OIDC federated credential is missing, or its subject does not match this repository and branch. | Check the credential on the app registration: subject `repo:<owner>/<repo>:ref:refs/heads/main`. It is not a secret and not expiring — if it looks right, confirm `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` in repository *variables*. |
| *Build and push the image* | `az acr build` failed. Usually the Dockerfile, occasionally registry quota on Basic. | Reproduce locally: `docker build -t phb-platform:test .` |
| *Open the database firewall* | The identity lacks rights on the server, or `AZURE_POSTGRES_SERVER` is wrong. | The deploy identity needs Contributor on the resource group. |
| *Apply migrations* | See *A migration fails on deploy* below. |  |
| *Deploy the new image* | The revision was rejected. | `az containerapp revision list -n <app> -g <rg> -o table`, then `az containerapp logs show -n <app> -g <rg>`. |
| *Verify the deployment responds* | The revision deployed but never returned 200 from `/api/health`. | The container started and died, or never started. See the next section. |

**The deploy job is skipped entirely.** That is the intended state before the
subscription exists — it is gated on three repository variables being set. A grey
check, not a red one. Set `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and
`AZURE_SUBSCRIPTION_ID` to enable it.

**Green but serving the old build.** Container Apps kept the previous revision because
the new one never became healthy. `az containerapp revision list` shows both. The
verify step should have caught this — if it did not, the probe answered 200 from the
old revision while the new one was still failing.

---

## The container starts and immediately exits

**Symptom.** Revisions cycle. `az containerapp logs show` shows the process starting
and stopping with no request ever served.

| Cause | What you will see | Fix |
|---|---|---|
| A required environment variable is missing | `Invalid environment configuration:` and the variable named. `lib/env.ts` parses at boot and fails loudly on purpose. | Set it on the container app, or add it to Key Vault and reference it. |
| `AUTH_SECRET` missing or unreadable | The same message naming `AUTH_SECRET`. | The container app reads it from Key Vault through the managed identity — check the `Key Vault Secrets User` role assignment still exists. |
| `GRAPH_CLIENT_SECRET` is set | `GRAPH_CLIENT_SECRET is set in production` | Working as intended. Remove it. Production authenticates with the managed identity; prohibition 7 forbids a credential that expires. |
| The image is for the wrong architecture | `exec format error` | Build for `linux/amd64`. `az acr build` does this by default. |

**It is not Prisma's query engine.** That is the usual guess and it does not apply
here: Prisma 7 with the `@prisma/adapter-pg` driver adapter compiles queries with
WebAssembly embedded in `@prisma/client/runtime`, so there is no native engine binary to
mismatch a libc. Confirm with `ls node_modules/@prisma/client/runtime | grep
query_compiler`. The platform-specific piece is the *schema* engine, used only by
`prisma migrate deploy`, which runs on the CI runner and is not in the image.

---

## A migration fails on deploy

**Symptom.** The *Apply migrations* step is red. The app is untouched — migrations run
before the new revision, so a failure here leaves the old revision serving.

**Diagnose first, and do not re-run the workflow.** A retry runs the same migration
against the same database.

```bash
npx prisma migrate status     # with DATABASE_URL pointing at production
```

Then see *A migration fails* below for the causes and for resolving a half-applied
migration. **Never `migrate reset` against production** — it drops every table.

**If the firewall step opened a rule and the job died before closing it**, the rule is
left behind. It is scoped to one runner IP, but remove it:

```bash
az postgres flexible-server firewall-rule list -g <rg> -n <server> -o table
az postgres flexible-server firewall-rule delete -g <rg> -n <server> --rule-name gh-deploy-<run-id> --yes
```

The close step runs under `always()`, so this only happens if the runner itself is
killed.

---

## The app is up but the database is unreachable

**Symptom.** `/api/health` returns 200. Every real page returns the error boundary.
Logs carry a Prisma error code.

**That combination is by design.** The health probe deliberately does not touch the
database: a probe that fails during a brief Postgres outage makes Container Apps
restart a process that was working, turning a short blip into a restart loop that
outlasts it. Liveness answers "should this process be killed", and the answer is no.

| Error | Cause | Fix |
|---|---|---|
| `P1001: Can't reach database server` | The firewall rule allowing Azure services was removed, or the server is stopped. Burstable tier servers can be stopped to save money and stay stopped — **which is why one may have been, and why it must not be.** Stopping this server destroys building data rather than merely postponing access to it: see `docs/08-bas-and-niagara.md`, *Azure: the container app may sleep, the database may not*. Restart it, then check the Collection Health screen for new `roll_overwrite` gaps. | `az postgres flexible-server show -g <rg> -n <server> --query state`. Confirm the `AllowAllAzureServicesAndResourcesWithinAzureIps` rule exists. |
| `P1000: Authentication failed` | The admin password was rotated on the server but not in Key Vault. | Update the `DATABASE-URL` secret, then restart the revision — the container reads Key Vault at start, not per request. |
| `P2024: Timed out fetching a connection` | More replicas than the server's connection limit allows. Burstable tiers have low limits. | Lower `maxReplicas`, or move up a tier. |

Nothing here needs a redeploy. Fix the database or the secret and restart the revision.

---

## Zero admins after seeding

**Symptom.** Everyone can sign in. Nobody sees the Admin item, and `/api/admin/*`
returns 403 for everyone. A brand-new production with no way in.

**Cause.** `BOOTSTRAP_ADMIN_EMAIL` was empty or wrong when the production seed ran. It
is the only way the first admin is created — there is deliberately no create-employee
endpoint and no UI path to grant the first admin flag.

**Confirm it:**

```sql
SELECT email, is_platform_admin, entra_oid IS NULL AS awaiting_first_signin
FROM employees WHERE is_platform_admin = true;
```

**Fix.** Correct the variable on the container app, restart the revision so it is read,
then run the seed once more:

```bash
# From a machine that can reach the production database.
DATABASE_URL='<production-url>' BOOTSTRAP_ADMIN_EMAIL='a@…,b@…' npm run seed
```

It is idempotent. Missing rows are created; existing rows are promoted **only** because
no active administrator remains, which is exactly this situation. In normal operation
it never re-promotes anyone, so this cannot quietly undo a demotion made in the UI.

**It only sets the admin flag.** A bootstrap admin whose account is *disabled* stays
disabled and the platform stays locked out — use the direct SQL in *The only admin is
locked out* above, which sets both.

**Do not** run `npm run seed:dev` to "get some data in". It creates 130 fake employees,
and it refuses twice over: once on `NODE_ENV=production`, and again if `DATABASE_URL`
points anywhere other than localhost. The second guard is the one that matters here —
the first only reports intent, and a production URL in your environment with
`NODE_ENV` unset is the realistic accident. Neither check opens a connection before it
fires.

Those fake rows are not a mess you can clean up afterwards: `audit_events` is
append-only and its foreign keys are `ON DELETE SET NULL`, so a fake employee cannot be
deleted at all once it has any audit history.

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

---

## Rebuilding a development database needs BOTH seeds

**Symptom.** After a reset the platform works and you can sign in, but the
employee list is nearly empty — the sample users are gone. It reads as data loss.

**Cause.** There are two seed scripts, and `migrate reset` runs neither.

| Script | What it creates |
|---|---|
| `npm run seed` | modules, positions, departments, bootstrap admins |
| `npm run seed:dev` | the sample employees used to exercise the admin screen |

Running only the first leaves a correct platform with almost nobody in it.

**Fix — the full sequence after any `migrate reset` on a development machine:**

```bash
npx prisma migrate reset
npm run seed
npm run seed:dev
npx tsx scripts/bas-import.ts --apply    # if the bas_* tables are in use
```

`seed:dev` refuses to run against production twice over — once on `NODE_ENV`,
and again if `DATABASE_URL` does not point at localhost. See *Zero admins after
seeding* for why that second guard is the one that matters.

---

# Change Orders — conversations, sync and reliability (Phase 9)

## A conversation row shows a message count that looks wrong

**Symptom.** A collapsed thread says "4 messages" and expanding it shows four,
but the folder plainly contains more of that conversation.

**Cause, if it ever happens.** Grouping was applied to one page of a folder
rather than to the whole folder. This is the failure the design exists to
prevent, so seeing it means `listConversations` has been changed to page.

**Why grouping collects instead of paging.** A group assembled from one page is
incomplete and *looks complete*: the row does not merely show fewer messages, it
renders a factual claim — "4 messages, newest 08-25" — that is false when the
rest of the thread is on page two. Nor can the partial groups be marked, because
Graph puts no conversation size on a message summary (`conversationIndex` encodes
threading position, not count). The only honest options were "mark every group as
possibly incomplete", which is noise nobody reads, or "collect the folder and
group the complete set". The second was chosen — it is the same collect-then-order
approach `searchMessages` already uses, for the same reason.

So a grouped read has **no cursor**. `nextCursor` is always null and the *Load
older messages* button does not appear. Turning grouping off restores the paged
flat listing, which is the way to page back through a folder that has outgrown
the cap.

**The fix.** Do not add paging to `listConversations`. If a folder is too large
to collect, that is what the truncation banner and the grouping toggle are for.

## "Grouped from the newest 500 messages in this folder"

**Symptom.** An amber banner above a grouped list.

**Cause.** The folder holds more than `MAX_CONVERSATION_MESSAGES` (500) or needed
more than `MAX_CONVERSATION_PAGES` (5) requests. As of Phase 9 the largest folder
in this mailbox holds 17 messages, so nobody has seen this yet.

**What it means, precisely.** The collection carries
`$orderby=receivedDateTime desc` and no `$filter`, so Exchange really does order
it and the messages that did not fit are **the oldest in the folder**. A
conversation can be missing early replies. It cannot be missing its newest
message, which is why the row's date and subject are still trustworthy.

**The search banner is a different sentence and must stay different.** A search
is `$filter=contains(subject,…)`, and Exchange refuses `$filter` with `$orderby`
(`400 InefficientFilter`), so a search's result set comes back in no order at all
— a capped search dropped an *arbitrary* subset and no such reassurance is
available. `truncationNotice()` in `mailbox-client.ts` owns which sentence
applies; a test asserts they are not the same string.

**The fix.** Narrow the search, or switch grouping off to page through the folder.

## Two threads in one folder have the same subject

**This is correct.** `CCHMC Bulletin 12` genuinely contains two conversations
whose subject line is byte-identical:

```
RE: CCHMC Liberty Expansion — Change Order Scope Request — Due 08-11-2026
  AAQk…AHcoEcU5y8FHr_WeTEv1zng=   7 messages   changeorder · Brandon Parker · Horvath, Brian
  AAQk…ADKTXXwiLfdLkdbBoawVZiE=   4 messages   Joel Schriner · Josh Bittner · Erich Knemeyer
```

Two vendors answering the same scope request start two threads. Grouping on
subject would merge 11 messages into one thread with one false count and a
participant list mixing two unrelated conversations. Grouping is on
`conversationId` — the same field Intake 6 matches vendor replies by — and it
separates them correctly.

**Do not "fix" this by grouping on subject.**

## A draft is inside a collapsed thread and I cannot see it

**You can, and this is enforced.** `conversationRows()` emits every draft in a
group whether the group is expanded or not — a collapsed row shows its header,
then its drafts, and states how many read messages it is holding back. Reviewing
drafts is the job the platform exists to do, so a draft folded behind a chevron
is not an acceptable state.

A `tests/mailbox-grouping-ui.test.ts` case fails if a collapsed group ever stops
emitting its drafts.

## "This draft changed in Outlook"

**Symptom.** An amber panel in the editor. Saving and sending are blocked and a
*Reload* button is offered.

**Cause.** The `changeKey` the editor is holding no longer matches the one in
Exchange, so something else wrote to the draft — almost always Outlook, which is
a peer client of the same mailbox and has never heard of our editor.

**This is not preventable and the platform does not pretend otherwise.** Graph
offers no concurrency control worth the name; last write wins. What the platform
does is *notice*, and refuse to be the write that wins over an edit somebody made
deliberately.

**Two things set it,** and the second is the useful one:

1. A save refused by the service with `kind=conflict`.
2. The lock-refresh poll. It already re-reads the draft every 45 s to renew the
   advisory lock, so comparing the `changeKey` on that read costs nothing — and
   it raises the banner while somebody is still typing rather than after they
   have finished a paragraph they are about to lose.

**The fix.** Copy anything still needed out of the fields, then reload. The
button says so when there are unsaved changes; reloading replaces them with what
Exchange holds. There is no merge, and there should not be one.

**Verified against Exchange**, not assumed: a subject-only PATCH does change the
`changeKey` (`…AABNDuK1` → `…AABND+Zx`), and a save carrying the stale key is
refused. See `docs/phase-9-verification.md`.

## Someone else is editing this draft — when does it free?

The advisory lock has a **90-second TTL** and an open editor renews it every
**45 seconds**. The banner now names the wall-clock time it lapses rather than
saying only that saving is blocked.

Those two numbers are a pair and neither is arbitrary. Expiry rather than an
explicit release is what stops a closed tab stranding a draft — a closing tab
never lands its release. Renewing at *half* the TTL is what stops an editor
somebody is actively typing in losing its own lock: one lost renewal — a dropped
request, a throttle, a laptop that slept — still leaves a whole interval.

`tests/draft-locks.test.ts` fails if `LOCK_REFRESH_MS` ever exceeds half of
`LOCK_TTL_MS`.

The lock is a courtesy between colleagues in the platform, not an authorization
boundary. An unlocked draft is writable, and Outlook holds no lock at all.

## The pane says "the mailbox was busy, that took an extra Ns"

**Cause.** Graph throttled one of the requests behind that response, and the
middleware retried it once after honouring `Retry-After`.

**Why it is said afterwards rather than during.** The retry happens *inside* the
single HTTP request the browser made, so there is nothing to stream — by the time
the browser has a response the wait is over. Two separate things cover the two
halves:

- **During**: any request outstanding for more than 2.5 s puts "Still loading —
  the mailbox may be busy" under the list. That is the part the browser can
  actually observe.
- **After**: `withMailbox` runs every mail route inside an `AsyncLocalStorage`
  scope and answers with `x-phb-mail-retried` and `x-phb-mail-retry-wait` when
  something in it was throttled.

**Why `AsyncLocalStorage` and not a counter.** The Graph client is memoised
process-wide, so its middleware instances are shared by every concurrent request.
A module-level counter would attribute one request's throttle to whichever other
request read it next — a pane claiming the mailbox was busy when its own request
sailed through, which is worse than saying nothing.

**If it appears constantly**, the mailbox is genuinely being throttled; see
*Graph throttling* above. Retrying harder is not the answer — throttling
concentrates on one mailbox through one app identity, so a second retry makes it
worse.

## Older messages failed to load and I lost the ones I had

**This was a real defect and it is fixed.** A failed *Load older messages* used
to call `setListError`, which swaps the whole pane for an error state — throwing
away every message already loaded in order to report a failure. The error now
appears beside the button, the loaded messages stay, and the button reads *Try
again*.

The same class of problem existed on the *success* path: a poll re-reads page one,
so in flat mode a poll landing after somebody had paged back would silently
discard those pages. Polling now skips while extra pages are loaded, the same way
it already skips during a search. Reselect the folder to go live again.

## The mailbox pane says "Not connected to the mailbox"

**Three different causes, one state**, deliberately — from the employee's side
they are the same situation and have the same answer, which is Outlook.

| code | cause | fix |
|---|---|---|
| `mail_not_configured` | no `GRAPH_*` credential | *The mailbox is not connected* above |
| `mail_auth_failed` | Entra would not issue a token — an expired local secret, or a misconfigured federated credential after a redeploy | renew it; production must never hold one that expires |
| `mail_access_denied` | the ApplicationAccessPolicy | *`mail_access_denied` — the access policy* above |

What it must never be is a crash or a raw Graph error string. It is a whole-module
state rather than a per-pane one, so three panes do not each report the same
broken credential.

## An error state with no button

**Report it.** Phase 9 treats a dead end as a defect: every error state offers a
retry, a way back, or both. `MailErrorState` takes `onRetry` and `onBack` and
renders whichever it is given — a `not_found` gets the way back rather than a
retry that cannot possibly work, a `mail_busy` gets the retry.

## Re-running the Phase 9 checks

```bash
npx tsx scripts/co-verify-phase9.ts survey
    Read-only. Groups every folder, and checks the grouped and flat listings
    contain exactly the same messages. Prints each folderId.

npx tsx scripts/co-verify-phase9.ts groups <folderId>
    One folder in detail: conversations, participants, and each message in the
    order the expanded pane shows them. Prints draft ids.

npx tsx scripts/co-verify-phase9.ts propagate <draftId>
    Times how long a platform write takes to appear in a folder LISTING.
    ZZTEST only; restores the subject afterwards.

npx tsx scripts/co-verify-phase9.ts conflict <draftId>
    Proves the concurrent-edit refusal. ZZTEST only; restores the subject.

npx tsx scripts/co-verify-phase9.ts watch <folderId> <needle> appear|vanish
    Do the thing in Outlook; this times how long Graph takes to agree.
```

The script contains no call to `sendDraft`, and never reads or sets
`PHB_ALLOW_SEND`.

## Part B (Graph change notifications) was evaluated and DECLINED

**Do not rebuild the case for it without a new measurement.** This entry exists
so the next person to think "we should use webhooks" finds the reason it was
turned down rather than the intuition that it sounds better.

**The measurement.** A platform write was visible in a folder listing on the very
first 250 ms poll, on every one of three runs
(`scripts/co-verify-phase9.ts propagate`). Exchange's own propagation is
sub-second. So the delay a user experienced was **not** Exchange — it was the
platform's polling interval, in its entirety.

**The decision.** The interval went from 60 seconds to 20. That is one constant,
it costs 0.3% of the throttling budget per focused tab, and it removed
two-thirds of the delay that was actually there.

Change notifications would have bought the remaining ~20 seconds in exchange for:

- a subscription lifecycle to create and tear down
- a renewal job, because mail subscriptions expire in roughly three days, plus
  the monitoring to notice a renewal that silently stopped happening
- a public HTTPS validation endpoint Microsoft can reach, which also means it is
  reachable by everyone else, so `clientState` validation and treating every
  notification as untrusted input
- reconciliation for dropped notifications, since delivery is best-effort — which
  means keeping the polling anyway, as the floor

That is four new failure modes, one of them a public endpoint and one of them a
credential-shaped thing that expires, for 20 seconds of latency on a screen used
by one to three people. `CLAUDE.md` forbids introducing anything that expires in
production; a three-day subscription renewal is exactly that shape.

**What would change the answer.** Not user count on its own — the budget takes
roughly 300 focused tabs at 20s. It would take a *background job that must react
to inbound mail with no human present*, which is the criterion
`docs/03-exchange-and-graph.md` already sets. Nothing in the roadmap needs one
today. If one appears, re-measure first: the number above is from August 2026 and
Exchange's behaviour is not a promise.

**What was never measured.** Four of the six sync directions in
`docs/phase-9-verification.md` need a person acting in Outlook and are recorded
as not-run. They measure the same Exchange propagation from the other side, and
nothing suggests it differs — but if one of them ever comes back in minutes
rather than milliseconds, that is a genuine reason to reopen this and the numbers
here do not cover it. `scripts/co-verify-phase9.ts watch` is the instrument.

---

# Change Orders — verifying the automation is undisturbed (Phase 11)

## Has the platform disturbed the automation?

**Run this after any phase that writes to the mailbox, and before trusting a
release.** It is the check `docs/PHASE-11.md` specifies, and it was first run on
2026-08-27/28 — that run is recorded in `docs/phase-11-verification.md`, which is
also the worked example of what a clean result looks like.

**A clean result is the expected result.** Do not manufacture findings. And do not
fix anything you find in the automation — a flow, a sentinel, the tracker are
outside the platform's scope, and a fix applied without understanding can break a
daily process. Report and stop.

### Before anything: this check is READ-ONLY

- Do not modify, disable, re-authorize, rename or export a flow. Reading run
  history is fine.
- Do not write `scrub_result.json`, `vendor_drafts.json`, `transfer_ready.json`
  or `classification_result.json`.
- Do not write `Bid Tracker.xlsx`. Open it read-only; do not save, even if Excel
  offers.
- Do not create a message or file that would satisfy a trigger.
- Do not run the scheduled tasks off-schedule.
- `PHB_ALLOW_SEND` stays `false`.

### Step 1 — write down the platform's write windows

**Everything else is compared against these**, so get them first. A platform write
window is any period the platform created, edited, moved or deleted a message in
`changeorder@phb1899.com`.

Sources, in order of reliability:

- `git log --date=short` for the phase commits — the mailbox cannot have been
  written before the code existed.
- The `receivedDateTime` of the ZZTEST drafts the phase left behind (step 2).
- Any verification script run recorded in that phase's own verification doc.

The windows from the first run, kept as an example of the shape:

```
2026-08-26  14:35-16:05   Phase 8: drafts, replies, forwards, moves, deletes
2026-08-19  18:00-19:00   Phase 6: draft edit testing
2026-08-27  11:25-11:40   Phase 9: two subject edits, restored
```

Note the platform's first-ever mailbox connection: **2026-08-19**, Phase 4 Part B.
Nothing before that date can be the platform's doing, and that single fact
disposes of most apparent findings.

### Step 2 — the mailbox half, from here

Read-only, and the only part that needs no other person.

```bash
# Every folder: conversations, counts, and a grouped-vs-flat cross-check.
npx tsx scripts/co-verify-phase9.ts survey

# One folder in detail, including draft ids.
npx tsx scripts/co-verify-phase9.ts groups <folderId>
```

What to pull out of it:

- **Every message whose subject contains `ZZTEST`**, with its folder. Those are
  the platform's artifacts, and step 3 checks whether any of them reached a flow.
- **Where the platform's drafts ended up.** They should be in Deleted Items. The
  first run found one that was not — see *One draft in the Projects tree* below.
- **Whether the automation kept filing.** Automation-shaped subjects — `New CO
  logged (Bid Tracker)`, `Change Order Scope Request`, `Additional Information
  Needed`, `Reminder`, `Handoff` — appearing in Sent Items and in the `Projects`
  tree on and after the write windows.
- **The `Projects` tree is intact.** `Projects` is a child of Inbox; project
  folders sit at depth 2 and their contents at depth 3. Intake 6 and 7 file into
  it.

**Why a `ZZTEST` search is sufficient here.** The non-production write fence
(`isZzTestSubject`) strips `RE:`/`FW:`/`FWD:` and *then* still requires the
subject to begin with `ZZTEST`. So every draft the platform wrote outside
production contains that literal string. A draft without it — the first run found
`Fw: Test run for Change Order Process` — was written by a person in Outlook, not
by the platform.

**This does not hold for the tracker.** See step 4.

### Step 3 — the Power Automate portal (needs a person)

`make.powerautomate.com`, default environment, flows owned by
`changeorder@phb1899.com`. Eleven flows: `CO Intake 1-7`, `CO Response 1-4`.

**The question that matters, first:** did any flow run *inside* a write window from
step 1? A run inside one, on a ZZTEST conversation, is a leak. Everything else is
ordinary traffic. On the first run the answer was none, and the closest approach
was four hours clear.

Then:

- Per flow: last success, last failure, and the failure message.
- **Any failure type that appears on or after the platform's first connection and
  not before it.** This is the "did the pattern change" question, and it is the
  one worth care — a flow that always failed is not news.
- Confirm the two documented non-failures are still the only two:
  `CO Intake 1`'s "ordinary email, no CO form, stop", and `CO Response 3`'s Bid
  Tracker read hiccup of 6 August 2026.
- If the Drafts folder looked empty in step 2, check whether `CO Intake 3` has run
  recently. Empty Drafts means "caught up" if it has, and something worth chasing
  if it has not.

**`CO Intake 1`'s no-CO-form stop now ends as `Cancelled`, not `Failed`** — a
deliberate change made by the flow's owner, observed 2026-08-27. `docs/02` calls
it "a stop"; read that as Cancelled in the portal. Three benign cancellations a
day are normal and are not a platform effect.

### Step 4 — SharePoint (needs a person)

Site `peckhannafordbriggs.sharepoint.com/sites/AISandbox`, library
`AI Sandbox - Documents`, folder `CO Managment Process` — **one A, do not fix the
spelling.**

**`Bid Tracker.xlsx` — open read-only, do not save.**

- **Search for `ZZ`, not `ZZTEST`.** This is the trap. The platform can only ever
  write `ZZTEST` subjects, but the tracker's own test-data convention is `ZZ`, so
  a `ZZTEST` search returns nothing and looks clean while `ZZ` rows sit in the
  sheet. Search `ZZ`, then discriminate.
- The known pre-platform test rows, so they are recognised rather than reported:

  ```
  ZZ FLOW1 | PR-04        8/6/2026
  ZZ Test Owner | PR-77   7/17/2026
  ```

  Anything dated on or before 2026-08-18 predates the platform entirely.
- **Confirm the ListObject still resolves**: click into the table and check the
  **Table Design** tab appears in the ribbon. If it does not, the workbook has
  been rewritten by a library and Power Automate will silently stop resolving the
  table — that is the failure mode `docs/02` warns about, and it has happened in
  production.
- Spot-check that real rows look right: a recent CO with a plausible date and
  status.

**Sentinel files.** Read modification timestamps only, never write. None should
fall inside a write window. The platform has no code path that writes any of the
four names, so a hit here means something is badly wrong and is worth stopping
for.

**CO state JSON.** File count and modification times consistent with the
automation writing them.

### Step 5 — scheduled task evidence (needs the machine)

The two Cowork tasks run on one Windows laptop and cannot be inspected remotely.

- Run reports should appear **twice daily, morning and noon**.
- **Weekend gaps are expected.** Check the day of week before reporting a gap —
  the first run of this check found gaps on 08-22 and 08-23, which were Saturday
  and Sunday, and one on 08-18, which was a Tuesday and is a real gap.
- **Report a gap; do not investigate it by running anything.** Running a task
  off-schedule is explicitly out of bounds.

The reports sync locally to a path under the operator's user profile
(`C:\Users\<user>\Peck Hannaford + Briggs\AI Sand…`). That path is
machine-specific — the durable address is the SharePoint library.

### Step 6 — the Outlook path (needs an Exchange admin)

CLAUDE.md: the platform must never be the only route to change-order work.

- The operator still has Full Access to `changeorder@phb1899.com`.
- `Test-ApplicationAccessPolicy` still returns **Granted** for
  `changeorder@phb1899.com` and **Denied** for another mailbox.

### Answering "can this credential even see that?"

The fastest way, and worth knowing before planning any check: base64-decode the
middle segment of the Graph access token and read the `roles` claim. It lists the
application permissions actually granted.

As of 2026-08-28 that is **`Mail.ReadWrite` and `Mail.Send`, and nothing else** —
so SharePoint, `Bid Tracker.xlsx`, the CO state JSON and the sentinel files return
`403 accessDenied` from the platform and always will until someone grants more.

**That limitation is a feature here.** A credential that cannot reach the tracker
cannot corrupt it, and half of why this verification comes back clean is that
there is no path from the platform to most of what it is checking.

### Writing it up

`docs/phase-11-verification.md` is the model. The one rule that matters:

**Distinguish what was observed from what was inferred, and record anything that
could not be checked as *not run*, never as a pass.** A verification document that
rounds an unchecked item to "fine" is worse than no document, because the next
person believes it.

### Known findings carried forward

Things a repeat run will see and should not re-report as new:

- **One draft in the Projects tree.** `ZZTEST phase 8 attachment draft`
  (2026-08-26 14:40) sits in `Projects/ZZ FLOW1 …/ZZ PR-04` instead of Deleted
  Items. It triggered nothing and wrote nothing. Left in place deliberately —
  removing it is the mailbox owner's decision, not a correction to make quietly.
- **Two `ZZ` rows in the tracker**, `PR-04` and `PR-77`, both pre-platform.
- **`CO Intake 1` cancellations**, roughly three a day, the documented no-CO-form
  stop.
- **The 2026-08-18 scheduled-task gap**, a Tuesday, unexplained and pre-platform.
  Four odd things happened that day — the task gap, an `Intake 1` failure at
  14:08, an afternoon `scrub_result` write at 15:10, and two ZZTEST test drafts at
  19:05 and 19:11. Whether that is one event or four was never established, and it
  is outside the platform's scope either way.

# BAS — Building Automation module

## The BAS schema lives in two places, and `schema.prisma` is not all of it

**Read this before changing anything about the `bas_*` tables.** It is the one
thing about this module that is not discoverable from the code.

**The rule, stated so it predicts rather than lists:** Prisma models **columns
and indexes**. It ignores **constraints** and **triggers** entirely.

That cuts both ways, and the two halves behave very differently.

*Safe to hand-append, because Prisma cannot see them at all:* CHECK constraints,
triggers, views. They survive every future migration untouched.

*NOT safe to leave unmodelled, because Prisma does diff them:* indexes. An index
that exists in the database but not in `schema.prisma` gets a **drop proposal**
on the next `migrate dev`. This is why the original partial indexes
(`WHERE equipment_id IS NOT NULL`) are declared as plain indexes instead — on
metadata tables of a few hundred rows the partial-ness saves nothing, and it
avoids the trap. It is the same trap as the generated column below.

So three things are defined in the migration SQL rather than in
`prisma/schema.prisma`:

| What | Where | Does Prisma notice it? |
|---|---|---|
| `bas_points_roll_horizon` trigger, keeping `roll_horizon_s` correct | migration SQL | No |
| 13 CHECK constraints | migration SQL | No. Invisible to it in both directions |
| 6 views, `bas_v_*` | migration SQL | No |

The BRIN index on `bas_readings(ts)` **is** in `schema.prisma`, as
`@@index([ts], type: Brin)`. Prisma expresses PostgreSQL index types natively.
Only the `pages_per_range` storage parameter cannot be expressed, and it was
deliberately left at the default — it is a tuning choice, not a correctness one.

The source of these definitions is `prisma/bas/hand-additions.sql` if that file
still exists, and the `add_bas_tables` migration if it has been deleted as
intended. The migration is authoritative.

**Why the CHECK constraints matter.** `bas_readings_at_most_one_value` is what
makes "a reading cannot carry two typed values" true rather than merely
intended. Zero populated value columns is *valid* — it is a record the station
returned as null, a sensor fault or a real gap — and that is different from no
row at all, which means we never collected it. If these constraints are ever
dropped, nothing will complain and bad rows will accumulate silently.

## `migrate dev` emits `ALTER COLUMN roll_horizon_s DROP DEFAULT`, and it fails

**This one cost an afternoon on 21 August. Do not re-derive it.**

**Symptom.** `npx prisma migrate dev` generates a migration whose entire content
is:

```sql
ALTER TABLE "bas_points" ALTER COLUMN "roll_horizon_s" DROP DEFAULT;
```

Applying it fails with `column "roll_horizon_s" of relation "bas_points" is a
generated column`. You can neither apply it nor stop Prisma generating it.

**Cause.** Somebody has made `roll_horizon_s` a `GENERATED ALWAYS AS (...)
STORED` column again. Prisma reads that expression as a column DEFAULT, has no
syntax for it in `schema.prisma`, and therefore believes the database has a
default the schema does not — so every `migrate dev` proposes removing it,
forever.

Declaring the field in `schema.prisma` does **not** fix this. Declaring it
prevents a `DROP COLUMN`, which is a different problem. The generated-column
conflict is unavoidable while the column is generated.

**Fix.** Use the trigger, which is what the `add_bas_tables` migration installs:

```sql
CREATE OR REPLACE FUNCTION bas_points_roll_horizon() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.roll_horizon_s := NEW.capacity * NEW.collection_interval_s;
  RETURN NEW;
END; $$;

CREATE TRIGGER bas_points_roll_horizon_maintain
  BEFORE INSERT OR UPDATE OF capacity, collection_interval_s, roll_horizon_s
  ON bas_points FOR EACH ROW EXECUTE FUNCTION bas_points_roll_horizon();
```

`roll_horizon_s` stays an ordinary nullable `INTEGER`, which is exactly what
`schema.prisma` declares, so the diff is empty. Prisma does not model triggers —
the same reason it ignores the `audit_events_append_only` triggers, which have
survived every migration since August 2026 without producing a diff.

**The one behavioural difference.** A generated column *rejects* a direct write;
the trigger *overwrites* it. The stored value is right either way, but a caller
that sets `roll_horizon_s` gets no error. Nothing writes it — the collector only
reads it — so this is a lost warning, not a lost guarantee.

**Delete the corrective migration** if one was generated and committed. It can
never be applied.

**After any change here,** confirm:

```sql
SELECT count(*) FROM bas_points
 WHERE capacity IS NOT NULL AND collection_interval_s IS NOT NULL
   AND roll_horizon_s IS DISTINCT FROM capacity * collection_interval_s;
```

Zero is the only acceptable answer. `roll_horizon_s` is what every data-loss
warning in this module is computed from — a point whose horizon reads NULL is
reported as `roll_horizon_unknown`, which is deliberately **not** treated as
safe and must never be rendered green.

## After `prisma migrate reset`, nobody can reach `/admin`

**Symptom.** Following a reset, the sidebar is empty for everyone and `/admin`
is unreachable. `SELECT count(*) FROM modules` returns **0**.

**Cause.** `npx prisma migrate reset` does **not** run the seed in this repo,
despite `prisma.config.ts` declaring `seed: "tsx prisma/seed.ts"`. The database
comes back schema-correct and content-empty. With no module rows there is
nothing to grant, and with no bootstrap admin there is nobody to grant it.

**Fix.**

```bash
npm run seed
```

**The detail that makes this confusing:** `1 position, 11 departments` appear
anyway, because reference data is inserted by migrations rather than by the
seed. So the database looks partially populated, which reads like a seed that
ran and half-worked rather than one that never ran at all. **Check the `modules`
count, not the department count.**

## Editing a migration that has already been applied

**Symptom.** Prisma reports that an applied migration's checksum no longer
matches the file on disk.

**Cause.** Someone edited a migration after it was applied. Prisma checksums
applied migrations precisely to catch this — the file and the database now
disagree about what was run.

**Fix, locally:** `npx prisma migrate reset`, then `npm run seed` (see above),
then re-run `scripts/bas-import.ts`. Safe on a development machine because BAS
data re-imports from the standalone `bas` database and everything else comes
from the seed.

**Not safe once the platform is deployed.** After Azure exists, a change of this
kind is a **new forward migration**, never an edit. Resetting a deployed
database destroys `bas_readings`, and beyond the JACE's ~42-hour roll horizon
those rows cannot be re-fetched from anywhere.

This happened once, on 21 August, fixing the `roll_horizon_s` generated column
inside `20260821150733_add_bas_tables` after it was already live in the dev
database. It was the right moment for it to happen — before deployment, against
synthetic data.

## The views are named `bas_v_*`, and that is load-bearing

**Not cosmetic.** `bas_v_data_dictionary` — the view whose entire purpose is to
be pasted into an LLM prompt so the model writes SQL against documented columns
instead of guessing — selects objects matching `relname LIKE 'bas\_%'` in the
`public` schema. A view named `v_point` would be excluded from the dictionary,
so the AI would not know it exists.

The predicate was `nspname = 'bas'` in the standalone database, where these
tables had a schema of their own. Both obvious ways of updating it are wrong and
neither raises an error:

- leaving it as `'bas'` → returns zero rows, and the AI starts guessing column names
- changing it to `nspname = 'public'` alone → returns `employees`, `audit_events`,
  `module_grants` and `draft_locks` as well, putting the platform's own tables
  into an LLM prompt

If someone reports that the AI is inventing column names, check this view first.

## `prisma generate` fails with a 403 from `binaries.prisma.sh`

**Symptom.**

```
Error: Failed to fetch sha256 checksum at
https://binaries.prisma.sh/.../schema-engine.gz.sha256 - 403 Forbidden
```

**Cause.** The environment cannot reach `binaries.prisma.sh` — a restricted
network, an egress allowlist, or an air-gapped CI runner. Prisma 7's *query*
engine is WebAssembly inside `@prisma/client` and needs nothing downloaded, but
the *schema* engine is a separate binary and the CLI checks for it.

**Fix, when you only need to generate the client:**

```bash
touch /tmp/fake && chmod +x /tmp/fake
PRISMA_SCHEMA_ENGINE_BINARY=/tmp/fake npx prisma generate
```

`generate` only checks that the path exists; it never invokes the engine.

**What this does NOT fix.** `prisma migrate dev` and `prisma validate` both
genuinely invoke the engine. Pointing them at a stub makes them exit 0 having
checked *nothing*, which is worse than the 403 — you get a passing result that
means nothing. If you need to validate a schema without the engine, run
`generate`: it has to parse the schema to emit a client, so an invalid schema
fails.

`PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1` does not help. It skips the checksum
fetch; the engine download then 403s on the next line.

**To apply migrations without the engine,** run the migration `.sql` files
directly — they are plain SQL. This does not record them in
`_prisma_migrations`, so it is for test databases only. A real database needs
`prisma migrate deploy` from a machine that can reach the binary host.

## Importing the standalone BAS database — `scripts/bas-import.ts`

Moves the `bas` schema of the standalone database (`C:\dev\bas-db`) into the
platform's `bas_*` tables. Needed once now, and again when the platform moves to
Azure — which is the reason it is a script.

```bash
# read-only inspection, always safe
BAS_SOURCE_DATABASE_URL="postgresql://.../bas" npx tsx scripts/bas-import.ts
# then
npx tsx scripts/bas-import.ts --apply
```

**Point ids are preserved deliberately.** `bas_sync_checkpoints` and
`bas_readings` both key on `point_id`. If the ids changed, every checkpoint
would refer to the wrong point and the collector would either re-fetch
everything or silently skip data. The script inserts ids explicitly and then
advances each sequence past the highest value.

**It refuses to import onto a populated target.** A dry run against a populated
target still exits 0 and reports the blocker — a read-only inspection must not
fail. `--apply` against a populated target exits 1. `--truncate-target` replaces
the rows, and should be preceded by a backup: beyond the JACE's ~42-hour roll
horizon, `bas_readings` **is the only copy of that data in existence** and
cannot be re-fetched from the station.

**"`bas_points.point_id` has no sequence."** The column has probably been
changed to `GENERATED ALWAYS AS IDENTITY`. The inserts then need `OVERRIDING
SYSTEM VALUE`. The script fails loudly rather than renumbering rows.

**Everything is one transaction, and verification happens before the commit.**
It compares the two databases **by content** - see *Verifying a BAS import by
content* below - counts the tables AND the columns it compared, and rolls back
with `INCONCLUSIVE` if either count is short. That check exists because
`Test-BasRestore.ps1` once printed `RESTORE VERIFIED` after a bad format string
threw inside its comparison loop and skipped all ten tables. **Always count what
you actually checked, and refuse to pass on zero.**

It used to compare row counts, and that is how it shipped a corruption - see
*The first BAS import corrupted every timestamp* below.


---

## The first BAS import corrupted every timestamp, and said IMPORT VERIFIED

**This is the reference case for why row counts are not verification.** The
import of 21 August 2026 reported `12/12 tables reconciled, 3,481 rows` and was
believed. Compared by content afterwards, two columns-worth of data were wrong.

**What was actually wrong.**

| | Symptom | Scope |
|---|---|---|
| Timestamps | Microseconds truncated to milliseconds | **107 of 107** timestamptz values in the target ended `.xxx000`. **0 of 137** on the source did |
| jsonb arrays | An array became an object | `bas_ingest_runs.errors` was jsonb `[]` in all 60 source rows and jsonb `{}` in all 45 target rows |

Concretely: `2026-08-20 12:31:32.995363` was stored as `2026-08-20
12:31:32.995000`.

**Cause, and it is one line of library behaviour in each case.** node-postgres
parses some PostgreSQL types into JavaScript values that cannot hold what the
server sent, and the import wrote that JavaScript value straight back:

- `timestamptz` becomes a JS `Date`, which has **millisecond** resolution. The
  microseconds are gone before the script ever sees the value.
- `jsonb` becomes a plain JS value. For an array, node-postgres then serialises
  it as a **PostgreSQL array literal** rather than as JSON, so `[]` is written as
  `{}`. This one was harmless only because every array was empty; a real error
  payload would have been mangled or rejected.

Verified in isolation, with nothing else involved:

```
timestamptz -> Date "2026-08-20T12:31:32.995Z"   written back as 995000
jsonb []    -> JS Array []                       written back as jsonb object
float8      -> number 55.123456789012344         exact
```

**What was NOT wrong**, checked rather than assumed:

- `bas_readings.value_num` — the IEEE 754 bytes are identical across all 3,303
  shared rows. Floats survived, because a JS number *is* a double.
- `bas_readings.ts` — no shared reading differs. The collector writes
  millisecond precision there, so there were no microseconds to lose. **The
  irreplaceable table was intact.** The damage was confined to metadata written
  by `now()`.
- `niagara_history_name`, `unit`, `display_name` — identical. With a caveat worth
  stating: no value in this dataset contains a `$`-hex escape (the points are
  `Temp1`, `points_RoomT`, `AuditHistory`), so the escape-mangling risk was never
  exercised by this data. The comparison would catch it; this import did not test
  it.
- NULL versus empty string — no empty strings on either side, NULLs preserved.
- No timezone or offset shift. The comparison is UTC-normalised, and only the
  sub-millisecond digits differed.

**The fix, in scripts/bas-import.ts.** Every lossy type is now read as raw text
via `types.setTypeParser`, and handed straight back to PostgreSQL to parse -
exactly what a dump and restore does. `timestamptz`, `timestamp`, `date`, `json`,
`jsonb`, `float8` and `float4`. A type parser is never called for NULL, so NULL
is unaffected.

There is also a whitelist, `LOSSLESS_TYPES`, checked against the live source
schema before anything is written. A column whose type is not on it stops the
import. That is the part that matters for next time: the next
timestamptz-shaped bug should be a refusal, not a discovery.

**Re-importing is how the existing data gets fixed.** The standalone database is
still the source of truth for these rows, so this is recoverable - until that box
goes away.

```bash
# Back up first. bas_readings beyond the ~42-hour roll horizon is the only copy.
npx tsx scripts/bas-import.ts --apply --truncate-target
npm run bas:verify
```

---

## Verifying a BAS import by content — `npm run bas:verify`

```bash
npm run bas:verify              # or: npx tsx scripts/bas-verify-import.ts
npm run bas:verify -- --examples 20
```

Read-only on both sides, writes nothing, and needs `BAS_SOURCE_DATABASE_URL` and
`DATABASE_URL`. `scripts/bas-import.ts` runs the same comparison inside its
transaction before committing; this is that comparison run after the fact,
against an import that already happened. **Run it while the standalone database
still exists.**

Expected output ends:

```
12/12 tables compared by content. Every table matches. CONTENT VERIFIED.
```

### Reading a failure

Every difference is classified, because they do not all mean the same thing:

| Category | What it means |
|---|---|
| **present on both sides but DIFFERENT** | Corruption. The import did not copy the row faithfully. This is the one that matters |
| **only in source** | Almost always the standalone collector, which keeps running after the import. Not a fault |
| **only in target** | Should be impossible. Rows the source does not have |

`bas_sync_checkpoints` is the exception worth knowing about: the collector
**updates** those rows in place, so a shared key legitimately differs once the
source has moved on. Four of seven differed by several hours for exactly that
reason. Judge corruption on the immutable columns - `created_at`,
`first_seen_at` - which cannot have changed since the import.

### How the comparison works, and why each choice is deliberate

`scripts/bas-checksum.ts`. Per table: every value is turned into text by an
expression chosen for its type, the values for one row become a JSON array, that
is hashed, and the row hashes are hashed in explicit key order.

| Type | Expression | Why not `::text` |
|---|---|---|
| `double precision` | `encode(float8send(x),'hex')` | `::text` goes through a formatter. At `extra_float_digits = -15` two **different** doubles both render as `6e+01` and compare equal. Measured |
| `timestamptz` | `to_char(x AT TIME ZONE 'UTC','...US')` | `::text` depends on the session `TimeZone`. This catches a lost microsecond and a shifted offset with the same string |
| `date` | `to_char(x,'YYYY-MM-DD')` | `::text` depends on `DateStyle` |
| `bytea` | `encode(x,'hex')` | `::text` depends on `bytea_output` |
| `jsonb` | `::text` | jsonb output is canonical: keys sorted, whitespace normalised |
| `json` | `::text` | Deliberately different from jsonb - `json` keeps its input text, so two equal documents can differ. Reported rather than smoothed over |

Three rules hold the whole thing up:

1. **Coerce nothing.** Above.
2. **A type with no rule is an error.** Never a skip, never a `::text` fallback.
   A fallback is how a comparison quietly stops comparing.
3. **Count what was compared.** Tables *and* columns. `md5` over zero columns is
   a stable value that matches on both sides forever, so a comparison that
   narrowed its column list would pass. The import compares the column total
   against the expected 103, not against zero - a comparison that dropped **one**
   column would satisfy a `> 0` check.

NULL is kept distinct from the empty string by building the row payload as a JSON
array: `[null]` and `[""]` are different strings. Ordering uses `COLLATE "C"` on
text keys, so the checksum does not change with the database locale - both
databases are `English_United States.1252` today and Azure will not be.

### The source is read in one snapshot

Both scripts open `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` on the
source. The standalone collector writes every 15 minutes, and without a snapshot
the count, the copy and the verification are three reads of a moving target: a
row written between the copy and the verify reads as a failed import. The cost is
a held snapshot on the source for the duration of the run.

### Scale limit, stated rather than discovered

The checksum is `md5(string_agg(...))`, which holds 32 bytes per row in one
PostgreSQL value against a 1GB cap - so it runs out somewhere near 33 million
rows. `bas_readings` is thousands today. A real building at 1,000 points and
15-minute intervals reaches that in about a year. The engine catches the
allocation failure and says so, including what to do: split the comparison by key
range, and **do not fall back to comparing counts.**

### Checking that the comparison can still fail

The point of all of this is that it fails when it should. On a throwaway clone of
the target, corrupt one value and re-run - each of these was measured, and each
names the table, the row, the column and both values:

| Mutation | Reported as |
|---|---|
| One character in a history name | `bas_points` — `"points_RoomT" != "points_Roomt"` |
| One ULP in `value_num` | `bas_readings` — `"4050275b20000000" != "4050275b20000001"` |
| One microsecond on a timestamp | `bas_ingest_runs` — `.500134 != .500135` |
| A one-hour offset shift | `bas_ingest_runs` — `12:32 != 13:32` |
| NULL to the empty string | `bas_points` — `unit: source NULL != target ""` |

Exit code 1 in every case. `tests/bas-checksum.test.ts` covers the same ground in
`npm test`, against a table built for the purpose, and those tests were
themselves checked by breaking the engine three ways: float8 as `::text` fails
the `extra_float_digits` test, timestamptz as `::text` fails the TimeZone and
DateStyle tests, and coalescing NULL to `''` fails both NULL tests.

The two INCONCLUSIVE guards were checked the same way, by patching the import:

- narrowing every column list by one → `INCONCLUSIVE: compared 91 of 103 columns`
- breaking out of the table loop early → `INCONCLUSIVE: compared 3 of 12 tables`

Both roll back and exit 1.

---

## Back up before any destructive BAS operation

`--truncate-target` on the import script, any manual `DELETE` against
`bas_readings`, and any `migrate reset` on a database holding real BAS data all
need a verified backup first. Beyond the JACE's ~42-hour roll horizon those rows
exist nowhere else.

**Take it:**

```powershell
$db = ((Select-String -Path .env.local -Pattern '^DATABASE_URL="?([^"]+)"?').Matches[0].Groups[1].Value.Trim()) -replace '\?.*$',''
pg_dump $db -Fc -f "C:\dev\phb_platform_$(Get-Date -Format yyyy-MM-dd_HHmm).dump"
```

`-Fc` is the custom format: compressed, and `pg_restore` can read its table of
contents without needing a database to restore into.

The `?schema=public` suffix must be stripped. `libpq` rejects it as an unknown
URI parameter and the error names the connection string rather than the suffix,
which sends you looking in the wrong place.

**Verify it before relying on it** — a dump that has never been read back is a
file, not a backup:

```powershell
pg_restore --list "C:\dev\phb_platform_....dump" | Select-String 'TABLE DATA public bas_readings'
```

No output means the readings are not in there, whatever the exit code said.

**Restoring into a scratch database and comparing row counts is stronger still**,
and is what `C:\dev\bas-collector\Test-BasRestore.ps1` does for the standalone
database. The same approach applies here. A backup that has never been restored
is a hypothesis.

---

## BAS irreplaceability — read before any destructive operation

**The JACE overwrites its own history roughly every 42 hours.** Once a row is in
`bas_readings`, that row is **the only copy of it in existence.** There is no
re-import, no vendor archive, and no station-side backup. A bad `DELETE` cannot
be undone from the source.

This is the one place the platform's own rule — *if the platform is not the
authoritative owner of some information, do not store it* (`docs/05`) — is
deliberately overridden, and it is overridden for **history only**. Current
values, point configuration and station metadata stay owned by the JACE and are
re-derived, never treated as truth.

Consequences, all non-optional:

- Backups of the platform database are a correctness requirement, not hygiene
- Anything that reads BAS data for analysis connects as a role with no write
  permission — see the AI SQL tool, which uses its own read-only pool rather
  than the Prisma client precisely because the Prisma client can write
- `--truncate-target` on the import script, and any manual `DELETE`, needs a
  verified backup first

---

## The test database is a separate database, and migrations do not reach it

**Symptom.** `npm test` passes, and then the first test that touches a new table
fails with either a raw `relation "bas_readings" does not exist` or — for a BAS
route — a `500 bas_unavailable` where a `200` was expected. Nothing else in the
suite complains.

**Cause.** `prisma migrate deploy` applies migrations to whatever `DATABASE_URL`
points at, which is the *development* database. The suite runs against
`TEST_DATABASE_URL`, a different database, and the only thing that migrates it is
`npm run db:test:setup`.

This bit B2. B1 added twelve `bas_*` tables and 416/416 tests still passed,
because no B1 test read one of them — the test database was twelve tables behind
and the suite had no way to notice. The first BAS test to expect a `200` got a
`500` instead.

**Fix.**

```
npm run db:test:setup
```

Idempotent, and it prints the migrations it applies. Run it **after every
migration**, not just after a new clone. `No pending migrations to apply.` means
you were already up to date.

**Check what the test database actually has** before believing a schema-shaped
test failure:

```powershell
$u = ((Select-String -Path .env.local -Pattern '^TEST_DATABASE_URL="?([^"]+)"?').Matches[0].Groups[1].Value.Trim()) -replace '\?.*$',''
psql $u -c '\dt bas_*'
```

`Did not find any relation named "bas_*"` is the whole answer. The `?schema=`
suffix has to be stripped for the same reason as in the backup section above.

---

## `bas_unavailable` — the BAS tables are not in this database

**Symptom.** Every BAS route answers `500` with
`{"error":{"code":"bas_unavailable","message":"Building automation data is not
available right now. Contact IT."}}`. The rest of the platform, Change Orders
included, works normally.

**Cause.** One of two, and the response deliberately does not say which — the
distinction matters to an operator and not to a browser. The log line
`bas.unavailable` names it in `outcome`:

| `outcome` | Meaning |
|---|---|
| `schema_missing` | `public.bas_readings` does not exist. The `add_bas_tables` migration has not been applied to this database |
| `unreachable` | The query itself failed. The database is down, or the connection string is wrong — not specific to BAS |

**Fix.** For `schema_missing`, apply the migration:

```
npx prisma migrate deploy
```

For `unreachable`, see *The database is unreachable* above — BAS is just where
you noticed.

**Why the check exists at all.** Without it Prisma raises
`relation "bas_points" does not exist` once per screen panel, which reads as a
code defect rather than an unapplied migration. `withBas` asks
`to_regclass('public.bas_readings')` once per request — a catalog lookup, not a
table scan — and turns it into one honest answer. It is deliberately **not
cached**: a database that gained the migration a minute ago must not keep
reporting it missing until the process restarts.

---

## An unauthenticated HTTP probe cannot tell you whether a route exists

**Symptom.** You add a module page and a module API route, curl them while signed
out, get a `302 /signin` and a `401`, and conclude they are wired up. They may
not exist at all.

**Cause.** `middleware.ts` runs before routing and answers every unauthenticated
request itself — a redirect for a page path, a `401` for anything under `/api/`.
It never consults the route table. Measured on the running dev server:

| Request | Response |
|---|---|
| `/bas` | `302 → /signin` |
| `/definitely-not-a-page` | `302 → /signin` |
| `/api/modules/bas/ping` | `401` |
| `/api/modules/bas/definitely-not-a-route` | `401` |

**Fix — what does prove it.** In order of cost:

- `npm run typecheck`. Next regenerates `.next/types/routes.d.ts` and
  `.next/types/validator.ts` from the files on disk, and `tsc` checks each page
  and route handler against the generated contract for its path. A page that does
  not exist is not in `AppRoutes`; one with the wrong signature fails to compile.
- `grep '"/bas"' .next/types/routes.d.ts` — the generated route table, straight
  from the filesystem. Stale until a dev server or a build has run since your
  edit.
- A test that imports the page or handler and calls it. `tests/bas-module.test.ts`
  does this, and it is the only one of the three that also proves the guard runs.

---

## Asserting that a page 404s needs the digest, not just the throw

**Symptom.** A test asserting `await expect(Page()).rejects.toThrow()` passes,
and the page is still broken — a missing import, a bad Prisma query, or a typo in
the module key all throw too.

**Cause.** `notFound()` from `next/navigation` signals the 404 by throwing. As of
Next 15.5 it is a plain `Error` whose `message` and `digest` are both the string
`NEXT_HTTP_ERROR_FALLBACK;404`. There is no exported type guard to check against,
so "it threw" is all a naive assertion tests.

**Fix.** Assert on the digest, which is the only part that carries the status:

```ts
const NOT_FOUND_DIGEST = "NEXT_HTTP_ERROR_FALLBACK;404";
// ...
expect((error as { digest?: unknown }).digest).toBe(NOT_FOUND_DIGEST);
```

`tests/bas-module.test.ts` wraps this in `expectPageNotFound`, whose default
value is a *message* rather than a throw — so a page that returns normally fails
the assertion instead of silently satisfying it. The digest string is a Next
internal and could change on a major upgrade; when it does, this assertion fails
loudly, which is the correct outcome.

---

## A new module is registered and still nobody can see it

**Symptom.** The row is in `modules`, the page and routes exist, the tests pass —
and the sidebar shows nothing. Signing out and back in does not help.

**Cause.** Three separate things have to be true, and adding the module only
does the first:

1. **The row exists.** `prisma/seed.ts` inserts it. The seed does not run by
   itself — `npm run seed` locally, and on deploy.
2. **The employee holds a grant.** The seed issues **no grants** and there is no
   endpoint that creates one implicitly. An admin grants it at `/admin`. This is
   deliberate: first sign-in creates an employee with zero modules.
3. **The row is `active`.** A module an admin hid stays hidden, and re-seeding
   does not un-hide it — `status` is absent from the upsert's `update` block on
   purpose. A grant on a hidden module still gets a `404`.

**Fix.** Check them in that order:

```sql
SELECT key, display_name, sort_order, status FROM modules ORDER BY sort_order;
SELECT m.key FROM module_grants g JOIN modules m ON m.key = g.module_key
  JOIN employees e ON e.id = g.employee_id WHERE e.email = 'you@phb1899.com';
```

**Also worth knowing:** `modules.icon` is stored and served but nothing renders
it — `components/sidebar.tsx` draws labels only. `icon: "gauge"` on the `bas` row
is metadata for a later screen, not a missing image.

---

## Why an ungranted employee gets 404 and not 403

Not a failure — the behaviour someone will eventually try to "fix". Both the BAS
page and every BAS route answer a missing grant with `404 Not found.`, and the
body names nothing: no module key, no table, no mention of the word building.

The platform does not confirm that a module exists to someone who cannot use it.
`403` would confirm it. This is decided once, in `lib/authz/http.ts`, and both
`withBas` and `withMailbox` inherit it; the page reaches the same outcome through
`notFound()`.

The order inside `withBas` carries the same intent: **authorization, then
validation, then availability.** A caller without the grant must not learn what a
valid request body looks like, so the Zod parser does not run until the grant
check has passed — asserted in `tests/bas-module.test.ts`, which fails if the
parser is called at all.

---

## `prisma.basPoint` is undefined, and the schema looks fine

**Symptom.** `prisma.basPoint`, `tx.basOrg`, any BAS model — `undefined` at
runtime, `TypeError: Cannot read properties of undefined (reading 'create')`.
`schema.prisma` declares all twelve models. The database has all twelve tables.
`npx prisma validate` is happy.

**Cause.** The generated client under `lib/generated/prisma` is stale. It is
written by `prisma generate`, and:

- `prisma migrate dev` runs `generate` for you
- `prisma migrate deploy` does **not**
- editing `schema.prisma` and hand-writing the migration SQL does **not**
- `lib/generated/` is in `.gitignore`, so a fresh clone, a new machine or a CI
  runner has no client at all until something generates one

B1 landed this way. `lib/generated/prisma/models/` held seven files — the Phase-1
models — and none of the twelve `Bas*` ones, for the whole of B1 and B2. Nothing
complained because no code referenced a BAS model yet. The first line of B3 would
have.

**Fix.**

```bash
npx prisma generate
```

**Check it, rather than assuming:**

```bash
ls lib/generated/prisma/models/
```

Nineteen files today: seven platform models and twelve `Bas*`. If `BasPoint.ts`
is missing, nothing that touches BAS data can work.

**This is now prevented rather than documented.** `package.json` declares
`"postinstall": "prisma generate"`, so `npm ci` and `npm install` cannot leave a
stale client behind. You should only see the symptom above on a `node_modules`
installed before that hook existed — reinstall, or run `npx prisma generate`.

**The hook changes the Dockerfile, and would have broken it.** Stage 1 copied
only `package.json` and `package-lock.json` before `npm ci`, so the postinstall
had no schema to read. Reproduced exactly, by simulating that stage:

```
> prisma generate
Error: Could not find Prisma Schema that is required for this command.
npm error code 1
```

So stage 1 now copies `prisma/` and `prisma.config.ts` before `npm ci`. Those two
are all `prisma generate` reads; it needs no database, because
`prisma.config.ts` resolves `DATABASE_URL` to `""` when unset and `generate`
never connects.

**The cost, so nobody rediscovers it:** that layer used to be cached on the
lockfile alone, and a schema edit now invalidates `npm ci` as well. That is the
price of the hook failing loudly. **Do not** reach for `|| true` or
`--ignore-scripts` instead — a generate that silently does nothing is the exact
failure the hook exists to prevent, and it would put you back here without the
error message.

**Also worth knowing:** npm 11 gates *dependency* install scripts behind
`allowScripts` in `package.json`, but the root package's own `postinstall` runs
regardless. It is not affected by that list. Verified by running `npm ci`.

`npm run typecheck` catches a stale client the moment any code references a BAS
model, because the types come from the same schema. It cannot catch it before
then, which is why the hook matters.

---

## Prisma `///` comments are not SQL comments, and the AI can only see SQL ones

**Read this before adding a table or column to the BAS schema.**

**The rule.** Prisma models columns and indexes. It does **not** emit `///` doc
comments as SQL `COMMENT ON`. A `///` comment reads beautifully in
`schema.prisma` and is completely invisible from inside a query.

That matters here more than in most projects, because
`bas_v_data_dictionary` — the view whose entire purpose is to be selected and
pasted into an LLM prompt — reads `col_description()` and `obj_description()`
straight out of the PostgreSQL catalog. It can only ever see what a migration
wrote.

**What went wrong once.** The port from the standalone database dropped the
comments, and nothing noticed for two phases:

| | standalone `bas` | platform, before | platform, now |
|---|---|---|---|
| `COMMENT ON TABLE` | 12 | 0 | **12** |
| `COMMENT ON COLUMN` | 22 | 2 | **22** |
| `COMMENT ON VIEW` | 6 | 6 | 6 |

The dictionary was 211 rows carrying two annotations: column names and types,
which a model could have guessed, and no statement of what any of it means.
Restored by the `add_bas_comments` migration. Now 18 of 18 objects have a
description and 22 columns are annotated, which is the floor verify.py asserted.

**So when you add a `bas_*` table or column:** write the prose in
`schema.prisma` as usual *and* add a `COMMENT ON` to the migration. The `///`
comment is for whoever reads the schema; the SQL comment is for whatever queries
the database. `tests/bas-schema.test.ts` fails if any object has no description,
so a new table cannot land without one — but it cannot force a *column* comment,
so that part is on you.

**Check it:**

```sql
SELECT count(*) FILTER (WHERE column_description IS NOT NULL) AS annotated,
       count(DISTINCT object_name) FILTER (WHERE object_description IS NOT NULL) AS described,
       count(*) AS rows
  FROM bas_v_data_dictionary;
```

`22 | 18 | 211` today. An `annotated` count near zero is this failure returning.

**Safe to hand-write.** Prisma does not diff comments, so `COMMENT ON` in a
migration produces no drift and no future `migrate dev` proposal — the same
reason the triggers, CHECK constraints and views in `add_bas_tables` are
invisible to it. `COMMENT ON` replaces rather than appends, touches no data, and
takes no lock worth the name.

**Two things `add_bas_comments` deliberately does not restate:**
`bas_points.roll_horizon_s` and `bas_v_reading.ts_local`. `add_bas_tables`
already carries both, and its `roll_horizon_s` wording is *better* than the
original because it names the trigger that maintains the column — which the
standalone schema had no reason to mention. Re-stating the original would be a
downgrade, and there is a test asserting it has not happened.

---

## A migration fails with `syntax error at or near "||"`

**Symptom.** `prisma migrate deploy` stops on a `COMMENT ON` statement and points
at the second line:

```
COMMENT ON TABLE bas_orgs IS
  'Portfolio owner - the customer or business unit that owns a set of ' ||
```

```
DbError { severity: "ERROR", code: SqlState(E42601),
          message: "syntax error at or near \"||\"" }
```

**Cause.** `COMMENT ON ... IS` takes a string **constant**, not an expression.
`'a' || 'b'` is a perfectly good expression and is rejected outright here. The
same text works fine in a `SELECT`, which is what makes it surprising.

**Fix.** Adjacent string literals, separated by whitespace that contains a
newline. SQL joins those into one constant, and `COMMENT ON` accepts it:

```sql
COMMENT ON TABLE bas_orgs IS
  'Portfolio owner - the customer or business unit that owns a set of '
  'buildings. One row today; the table exists so that multi-customer data '
  'never has to be retrofitted.';
```

No operator. Just two quoted parts on separate lines. Every long comment in
`add_bas_tables` and `add_bas_comments` is written this way, and so was the
original `001_core_schema.sql`.

### Then clear the failed migration before retrying

A `migrate deploy` that fails partway leaves the migration recorded in
`_prisma_migrations` with `finished_at` NULL. Every later `deploy` refuses to
proceed until that is resolved, and it is the same state
`tests/global-setup.ts` reports as *started but not finished*:

```sql
SELECT migration_name, finished_at, applied_steps_count
  FROM _prisma_migrations ORDER BY started_at;
```

`applied_steps_count = 0` means nothing from the file was applied — check that
before deciding, because the answer changes what you do next.

**Nothing applied** — mark it rolled back, fix the SQL, deploy again:

```bash
npx prisma migrate resolve --rolled-back 20260821151125_add_bas_comments
npx prisma migrate deploy
```

**Partly applied** — a migration with no transaction wrapper can get halfway.
Undo the applied part by hand first, or the retry fails on an object that already
exists. Prisma wraps each migration in a transaction, so for these files
`applied_steps_count = 0` is the normal case.

This is safe for a comments-only migration: `COMMENT ON` touches no data, so a
failed attempt destroys nothing. It would not be safe to assume for a migration
that writes rows.
---

## The vocabularies are empty, and nothing errors

**Symptom.** `SELECT count(*) FROM bas_point_roles` returns **0**. Every point
reads as unclassified, `bas_v_setpoint_pair` and `bas_v_command_status_pair`
return nothing at all, and every cross-equipment question silently has no answer.

**Why this is the nastiest shape of failure in this module.** Nothing errors.
`point_role` is nullable by design — an unclassified point is a visible backlog
item, not an error — so an empty vocabulary looks exactly like a building nobody
has labelled yet, and both pairing views returning zero rows looks like a
building with no setpoints.

**Cause.** The seed has not been run. The 91 point roles and 25 equipment types
are reference data and live in `prisma/bas-vocabularies.ts`, installed by
`prisma/seed.ts` alongside positions and departments. They used to be created by
nothing at all: they reached the development database only because
`scripts/bas-import.ts` copied them out of the standalone `bas` database, so a
fresh database came up empty and said nothing about it.

**Fix.**

```bash
npm run seed
```

It prints what it wrote, and the count is the point:

```
Seeded 91 BAS point roles (12 setpoint links, 8 status links) and 25 equipment types.
```

**Check:**

```sql
SELECT count(*) FROM bas_point_roles;      -- 91
SELECT count(*) FROM bas_equipment_types;  -- 25
SELECT count(*) FROM bas_point_roles WHERE setpoint_for IS NOT NULL;  -- 12
SELECT count(*) FROM bas_point_roles WHERE status_of IS NOT NULL;     -- 8
```

**The test database is empty on purpose**, and that is not this failure.
`npm run db:test:setup` applies migrations and deliberately does not seed,
because `tests/setup.ts` truncates between files. The BAS tests build their own
`zztest_` vocabulary, so they depend on neither a seed nor an import having run.
`tests/bas-vocabularies.test.ts` runs the real seeder inside a rolled-back
transaction, which is how the 91 / 25 / 12 / 8 counts are asserted without
leaving 116 rows behind.

### Adding a role

Add it to `prisma/bas-vocabularies.ts` and re-run the seed. Never as an ad-hoc
string at ingest time — a role that is not in that file is invisible to every
generic rule and every cross-equipment comparison.

**The seeder writes in two passes, and the order is not optional.**
`setpoint_for` and `status_of` are self-referencing foreign keys on
`bas_point_roles`, so a single ordered pass would depend on every role appearing
after the role it points at — one reordering away from a foreign-key violation.
Every row is written first with no links, then the links are applied once all 91
exist. `002_vocabularies.sql` does the same thing for the same reason.

**It never deletes.** A role a point already references cannot be removed — the
foreign key is `RESTRICT` — and silently dropping vocabulary out from under
existing data would be worse than saying so. A role in the database that the repo
does not declare is reported and left alone:

```
bas_point_roles contains 1 role(s) this repo does not declare: ...
```

Add it to the file, or remove it by hand once nothing references it.

**Links are declarative including their absence.** Pass two writes
`setpoint_for` and `status_of` for *every* role, null included, so deleting a
link from the file deletes it from the database rather than leaving a stale one.

### How the port was verified, and why counts were not enough

The 116 rows were parsed out of
`C:\dev\bas-db\migrations\002_vocabularies.sql` and then compared field by field
against the same rows in the development database, which the import had populated
from that same source. Both had 91 and 25, and the counts agreed at every stage.

The field-by-field comparison found a corrupted value anyway: one description had
been broken across a line at a hyphen and rejoined with a space, turning
`reviewed-but-not-mappable` into `reviewed-but-not- mappable`. Every count-based
check passed with that in place.

**Counts do not verify a data port. Compare the rows.**

## The BAS tests, and how to check that they can still fail

`tests/bas-schema.test.ts` and `tests/bas-views.test.ts` cover the half of the
schema Prisma cannot see: thirteen CHECK constraints, the `roll_horizon_s`
trigger, and the six views. They are ported from
`C:\dev\bas-db\scripts\verify.py`.

**Every test runs inside a transaction that is always rolled back.**
`tests/bas-fixture.ts` does this deliberately rather than for tidiness:
`bas_readings` rows cannot be re-fetched from anywhere, so the BAS suite is
written so that it cannot leave a row behind even when it throws halfway
through. `resetDb()` is not involved and never truncates a `bas_*` table.

**Confirm no residue after a run:**

```powershell
$u = ((Select-String -Path .env.local -Pattern '^TEST_DATABASE_URL="?([^"]+)"?').Matches[0].Groups[1].Value.Trim()) -replace '\?.*$',''
psql $u -c 'SELECT (SELECT count(*) FROM bas_orgs), (SELECT count(*) FROM bas_readings)'
```

Both zero. Anything else means a test committed.

**To check the tests can actually fail** — worth doing after editing them, and
the reason two real defects were found while writing them — break the schema on a
throwaway clone rather than on the test database:

```bash
ADMIN="postgresql://postgres:PASSWORD@localhost:5432/postgres"
MUT="postgresql://postgres:PASSWORD@localhost:5432/phb_mutant"

psql "$ADMIN" -c 'CREATE DATABASE phb_mutant TEMPLATE phb_platform_test'
psql "$MUT"   -c 'ALTER TABLE bas_readings DROP CONSTRAINT bas_readings_at_most_one_value'
TEST_DATABASE_URL="$MUT" npx vitest run tests/bas-schema.test.ts
psql "$ADMIN" -c 'DROP DATABASE phb_mutant'
```

`TEMPLATE` needs no open connections to the source database, and the clone is
instant. Measured results — each mutation must fail the tests named and no
others:

| Mutation | Tests that must fail |
|---|---|
| Drop `bas_readings_at_most_one_value` | 2 — the two-value and three-value refusals |
| Drop the `bas_points_roll_horizon_maintain` trigger | 9 — every horizon test plus the three `roll_risk` classifications |
| Drop `bas_readings_pkey` | 3 — both idempotency tests and the duplicate refusal |
| Dictionary predicate to `nspname = 'public'` alone | 3 — platform tables, stray objects, platform columns |
| Dictionary predicate left at `nspname = 'bas'` | 6 — everything about the dictionary |
| `bas_v_reading` timezone hardcoded to `'EST'` | 1 — the summer/EDT assertion, and only that one |
| `COMMENT ON TABLE bas_* IS NULL` for all twelve | 1 — every-object-has-a-description |
| Drop the 20 restored column comments | 1 — column-level annotation |
| Overwrite `roll_horizon_s` with the pre-trigger wording | 1 — column-level annotation |
| Set one description to `'   '` | 1 — column-level annotation, via the empty-prose check |

The vocabulary tests are mutated in the declaration rather than the database,
because the seeder is what writes it. Restore the file afterwards and confirm by
checksum:

| Mutation to `prisma/bas-vocabularies.ts` | Tests that must fail |
|---|---|
| Point a `setpointFor` at a role that does not exist | 9 — the declaration check fires first and names the cause |
| Delete one role | 3 — both count assertions and idempotency |
| Remove `isSetpoint` from a role that has a `setpointFor` | 1 — flags-agree-with-links |

**Three defects this found**, all of which had passing tests before the mutation:

1. `expectRejection` committed its fixture when the body unexpectedly *succeeded*
   — so dropping one constraint turned 4 expected failures into 15, and left
   `bas_*` rows in the test database. A helper that expects a failure has to roll
   back on success too.
2. The annotated-column floor of twenty, ported from verify.py, was asserting a
   state the schema had never been in. Held at 2 until `add_bas_comments` made
   twenty true, then raised.
3. A word broken across a line during the vocabulary port. Not found by mutation
   but by the same instinct — see *How the port was verified* above. No count
   check would ever have caught it.

---

## The suite refuses to start when the test database is behind

The guard the earlier entry asks for now exists: `tests/global-setup.ts`, wired
in as vitest's `globalSetup`, so it runs **once** before any test file rather
than once per file.

It compares the directory names under `prisma/migrations` against
`_prisma_migrations` in the test database and stops the run if any migration is
missing, unfinished, or rolled back. On success it prints what it checked:

```
[test-db] 6/6 migrations applied; latest 20260821150733_add_bas_tables
```

**That count is the point.** A guard that verifies nothing and reports success is
the failure this repo has hit three times — see the `RESTORE VERIFIED` note under
*Importing the standalone BAS database*. If the count ever reads `0/0`, the guard
is broken, not the database.

On failure it exits non-zero before collecting a single test, and names the
missing migrations. Verified against all three failure modes: a database with no
`_prisma_migrations` table at all, one behind by a single migration, and one with
a migration recorded as started but never finished.

**What it deliberately does not check:** checksum drift. Prisma detects an edited
migration and reports it far better than this could — see *Editing a migration
that has already been applied*.

---

## Timestamps written through Prisma were four hours out

**Found on 24 August 2026, building B3. It had been true since Phase 1 and
nothing had caught it.** Read this before writing any query that compares a
timestamp against `now()`.

**Symptom.** A reading written five minutes ago reported as **235 minutes in the
future**. `SELECT now()` read back through Prisma was four hours behind the
process clock. Nothing threw, nothing logged, and every existing test passed.

**Cause.** Prisma's driver-adapter layer moves a `timestamptz` across the
boundary as a naive wall-clock string with the offset **discarded**. The
PostgreSQL session's `TimeZone` then supplies one. Measured against
`phb_platform_test`, whose session timezone was `America/New_York`:

```
JS  new Date()                     2026-08-24T12:59:30.599Z
  written through Prisma, stored   2026-08-24 12:59:30.599-04   (+4 h)
SELECT now(), as text              2026-08-24 08:59:30.809-04
  the same now(), parsed by Prisma 2026-08-24T08:59:30.809Z     (-4 h)
```

**Why nobody noticed.** Writes gain the offset and reads lose it, so the two
cancel exactly. A value written through Prisma and read back through Prisma is
unchanged, which is what almost every test does. Everything that crosses the
boundary once is wrong:

- any SQL comparing a Prisma-written timestamp against `now()`, `age()` or
  another server-side clock — which is every number on Collection Health;
- any timestamp Prisma hands to a browser;
- and the error moves with DST, so it is five hours for half the year.

It is also invisible on a UTC machine, so it would have reproduced in Ohio and
not in CI.

**Fix.** `lib/db/adapter.ts` — one place, used by the application, the test
suite and the scripts:

```ts
new PrismaPg({ connectionString, options: "-c timezone=UTC" })
```

With the session pinned to UTC the discarded offset is `+00` and both directions
become exact. **Do not remove it, and do not construct a `PrismaPg` anywhere
without going through `createPgAdapter`.** A second connection configured by
hand reintroduces this silently.

This changes only how a connection *interprets and renders* timestamps. Nothing
is stored differently — `timestamptz` is an absolute instant on disk in every
session — so no migration and no backfill is involved.

**What was already stored wrong, and what was not.**

| | Affected? |
|---|---|
| Columns with `@default(now())` — `created_at`, `audit_events.created_at` | **No.** PostgreSQL computed them |
| `bas_*` rows | **No.** The collector and `scripts/bas-import.ts` use raw `pg`, not Prisma |
| Columns Prisma wrote from a JavaScript `Date` — `employees.last_login_at`, `sessions_valid_after`, `draft_locks.expires_at` | **Yes**, by the offset in force when they were written |

Nothing has been rewritten. The affected columns are development-database
metadata and each is either re-derived on the next sign-in or expired already.
**Decide before go-live** whether any production row needs correcting; the
correction is `column - interval '4 hours'` scoped by when it was written, and
getting the DST boundary wrong makes it worse rather than better.

**The regression test** is in `tests/bas-collection-health.test.ts`, *a timestamp
written through Prisma survives a comparison in SQL*. It has to cross the
boundary in both directions to have teeth: a JS `Date` written by Prisma, and
the subtraction done by PostgreSQL. A test that writes and reads back through
Prisma alone passes either way, which is exactly how this survived four phases.

---

## Collection Health disagrees with Grafana

**Grafana is the oracle, not the other way round.** It reads the same data and
its queries were run against it before the dashboard shipped. If a number
disagrees, the screen is wrong.

```bash
npx tsx scripts/bas-health-oracle.ts            # the screen vs Grafana's own SQL
npx tsx scripts/bas-health-oracle.ts --source   # platform db vs standalone db
```

The default run calls `getCollectionHealth` — the real service the route calls —
and runs the dashboard's panel SQL against the same database in the same moment,
then prints both answers side by side. Read-only on every connection. Exit code
1 on any disagreement.

The only edit made to a Grafana query is the schema rename: the standalone
database calls these `bas.reading` and `bas.v_collection_health`, the platform
calls them `public.bas_readings` and `public.bas_v_collection_health`.

**Two differences are expected and are not defects.**

*Drift, on `--source` only.* Grafana's datasource is the **standalone** `bas`
database, whose collector keeps running after an import. One collector cycle of
difference — twelve more readings, one more run, fifteen fewer minutes of
staleness — is the standalone database being ahead, not the platform being
wrong. Measured on 24 August: nine panels differed and every one of them was
exactly one 15-minute cycle. Anything structural differing — active points,
unclassified, points at risk, gap counts, roll horizons — is a real
disagreement.

*Fractional seconds.* The screen carries a `timestamptz` to the browser as a
JavaScript `Date`, which holds milliseconds, so `12:35:45.386223` arrives as
`12:35:45.386`. The two sides also *spell* the same instant differently:
PostgreSQL prints `14:05:00.02` where `toISOString` prints `14:05:00.020`. The
comparison pads to exactly three digits as well as truncating to them — a rule
that only truncated reported a difference between two spellings of one number. The screen renders to the minute and never writes, so this is
display truncation and nothing more. **It is not the same as the import bug** —
see *The first BAS import corrupted every timestamp*, where the truncated value
was written back and the microseconds were destroyed. The oracle script compares
timestamps at millisecond resolution and says why, in a comment, so that nobody
later "fixes" it into a comparison that stops comparing.

---

## Collection Health says everything is fine and you know it is not

**The screen is deliberately built so that a healthy present cannot hide a
damaged past.** If it looks calm, check these four things before believing it —
each answers a different question and they routinely disagree.

| What it answers | Where |
|---|---|
| Is the collector running **right now** | *Since newest reading* tile, and the *Recent collector runs* list |
| Is data being lost **right now** | *Points at risk of data loss* tile |
| Did the collector **stop for longer than the station remembers** | *Longest collector silence* banner |
| Has data **already been destroyed** | *Recorded data gaps* table, `roll_overwrite` rows |

The development database on 24 August 2026 is the worked example, and it is
worth understanding because it is the case a naive screen gets wrong:

- Every tile reads healthy. Four active points, all `roll_risk = 'ok'`, **zero**
  at risk. That is correct — the collector ran half an hour ago and Grafana says
  zero too.
- The *longest collector silence* banner is **red**: `64.3 h (2.7 days)` between
  21 Aug 16:05 and 24 Aug 08:20 — the laptop was closed over the weekend —
  against a **41.7 h** roll horizon.
- The *recorded data gaps* table has **four** `roll_overwrite` rows of 22.6 h
  each. That data existed on the station and the station destroyed it before we
  read it.

So roughly ninety point-hours are gone permanently, and **the five tiles are
still right to be green.** `roll_risk` is computed from
`now() - last_record_ts`, which is a question about the present. Once collection
resumes, every point returns to `ok` and the tiles have no memory of the outage.

That is why the banner and the gaps table exist. **A Collection Health screen
built only from the tiles would have shown four green points and nothing else
on the morning after ninety hours of data were destroyed.**

The run chart carries the same signal a third way: it is plotted on a real time
axis rather than by run number, so the outage is a hole with a 2,000-record
backfill spike on the far side of it. A bar chart spaced evenly by run would
have drawn 21 August and 24 August adjacent and shown nothing at all.

---

## The Building Automation screen is blank, or every panel errors at once

**First, `/api/modules/bas/ping`.** It reads no BAS rows and answers 200 only if
the grant and the schema are both fine — see *B2* in `docs/08-bas-and-niagara.md`.

| Ping says | Meaning | Fix |
|---|---|---|
| 401 | Not signed in | Sign in |
| 404 | No `bas` grant, or the module row is hidden | Grant it in `/admin`. **404 is deliberate** — the platform does not confirm a module exists to someone who cannot use it |
| 403 | Profile incomplete | Finish onboarding |
| 500 `bas_unavailable` | The `bas_*` tables are missing, or Postgres is unreachable | `npx prisma migrate deploy`. The log line says which of the two; the browser is not told |

**`bas_unavailable` after the migration has been applied.** `withBas` caches the
affirmative answer for the life of the process, and only the affirmative one —
so a database that *gains* the tables is picked up on the very next request with
no restart. If you see it persist, the tables really are absent on the connection
the app is using; check `DATABASE_URL` rather than restarting.

**Ping is 200 but the screen is empty.** Then it is not authorization. The screen
fetches `/api/modules/bas/collection-health` once per minute while the tab is
visible; open it directly. A `422` means the `days` parameter is outside 1–90.
Anything else is in the server log under `bas.route_failed`.

**Every panel is empty but nothing errors.** The tables are present and empty.
That is a real state on a fresh database and each panel says so in words rather
than rendering as broken — *No active points*, *The collector has never recorded
a run in this database*, *No gaps recorded*. Run
`scripts/bas-import.ts --apply`, or point the collector at this database (B6).

---

## The Collection Health controls, and what each one does not do

Two controls, added after B3 shipped. Both send their value to the server and
refetch; **neither hides rows in the browser.** Filtering happens in the SQL
`WHERE` clause — `siteFilter` in `lib/modules/bas/service.ts` — so a building
that is filtered out is not in the response at all. At ten buildings, a filter
that shipped the rows it claimed to exclude would be a lie rather than a filter.

**Building.** `All`, or one site. It scopes **every** panel: the five tiles, the
per-point table, the run chart, the run list, the collector-silence banner and
the recorded gaps. A tile that silently ignored it would be worse than no
filter, so `tests/bas-collection-health.test.ts` has a case per panel, and each
one asserts that something was *excluded* rather than that something was
returned. That is why the test fixture builds a second building: with one site,
`All` and `the only building` return identical rows and a filter that was
ignored entirely would pass every assertion.

**Range.** 24 hours, 7 days, 30 days. It scopes the run list, the run chart and
the collector-silence calculation, and **nothing else**. The tiles, the
per-point table and the recorded gaps are statements about the present —
`roll_risk` is computed from `now() - last_record_ts` — and windowing them would
mean nothing.

### Three things about the controls that look like bugs and are not

**A run with no building appears under every building.** `bas_ingest_runs`
allows a NULL `station_id`, which is what a run that failed *before* it
identified a station looks like. Grafana keeps those under every value of its
`$site` variable (`WHERE st.site_id IN ($site) OR st.site_id IS NULL`) and so do
we. Attributing such a run to a building is not possible, and it is exactly the
run worth seeing — hiding it behind a filter would hide the failures.

**The run list obeys the range; Grafana's does not.** Grafana's *Recent
collector runs* panel carries no `$__timeFilter`, so with a 24-hour range
selected it still lists runs from last week. That is a wart, not a decision: the
list and the chart sit side by side and would disagree about which runs exist.
The platform windows both. `scripts/bas-health-oracle.ts` applies the window to
its copy of panel 8 for the same reason, and says so in a comment — otherwise it
would report a difference on every run that is real and expected, which is how a
verification tool teaches people to ignore it.

**An empty run list is never just empty.** `describeEmptyRuns` distinguishes
*the collector has never run against this database* from *it last ran on 21
August, outside this window — widen the range to see it*. Both render as an
empty table and only one of them is fine. If you ever see a bare "no runs",
something has regressed.

---

## The per-point table reshuffles itself every refresh

**Fixed on 24 August 2026. Recorded because the cause is not guessable from the
symptom.**

**Symptom.** The rows of *Per-point collection status* change order on their own
roughly once a minute, under the reader's cursor. Every row is correct; only the
order moves.

**Cause.** `seconds_since_last_record` in `bas_v_collection_health` is whole
seconds, and the collector writes every point in a single poll — the four lab
points are 9 milliseconds apart, so all four tie **exactly**. `ORDER BY
seconds_since_last_record DESC NULLS FIRST` therefore leaves them unordered
relative to each other, and PostgreSQL is free to return tied rows differently
on each execution. It does.

**Fix.** A deterministic tie-break, in the service's per-point query:

```sql
ORDER BY seconds_since_last_record DESC NULLS FIRST, point_name, point_id
```

`point_id` is there so that two points sharing a display name still order
stably. Grafana's query has the same instability and it does not matter there,
because a dashboard nobody is reading does not reshuffle under anyone.

**How it was found**, which is the part worth keeping: `npm run bas:oracle` ran
the screen and Grafana's SQL against the same rows in the same second and got
two different orders. Nothing else would have noticed — the numbers were right,
the rows were right, and a single run of either query looks perfectly correct.
`scripts/bas-health-oracle.ts` carries the same tie-break for the same reason.

**The general rule.** Any `ORDER BY` on this screen that can tie needs a
tie-break. Truncated durations tie constantly, because that is what truncation
does.

---

## The dev platform database gets staler every day, and that is correct

**Symptom.** On a development machine, *Since newest reading* climbs past 30
minutes, then past 60, and eventually every point moves to `at_risk` and then to
`data_lost`. Nothing is broken.

**Cause.** The collector writes to the **standalone** `bas` database at
`C:\dev\bas-db`. The platform's `bas_*` tables are a copy taken by
`scripts/bas-import.ts` and they are frozen at the moment of that import.
Nothing writes to them until the next import, or until B6 points the collector
at this database directly.

So the screen is reporting the literal truth: no reading has arrived in the
platform's database since the import. **Do not "fix" this by relaxing a
threshold.** The thresholds are Grafana's and they are right.

**To confirm that is all it is:**

```bash
npm run bas:oracle -- --source
```

Every difference should be the standalone database being *ahead* — more
readings, more runs, fewer minutes of staleness. If the platform is ahead of the
standalone database on anything, that is a real problem and the import is not
what you think it is.

**To make it current again**, back up first and re-import — see *Importing the
standalone BAS database*.

---

## B6 is blocked: the collector cannot write to the platform database

**Attempted 24 August 2026 and stopped before any change was made. Read this
before trying again — the obvious approach does not work and the failure mode is
expensive.**

**What B6 was expected to be.** One line: change `DATABASE_URL` in
`C:\dev\bas-collector\.env` from the standalone `bas` database to the platform
database, and the collector starts writing where the screen reads.

**Why it does not work.** The collector's SQL is **schema-qualified and
singular** throughout: `bas.reading`, `bas.point`, `bas.station`, `bas.org`,
`bas.site`, `bas.sync_checkpoint`, `bas.data_gap`, `bas.ingest_run`,
`bas.v_collection_health`. Roughly thirty statements across
`collector/db.py`, plus `collector/cli.py`. The platform has none of those. It
has `public.bas_readings`, `public.bas_points`, `public.bas_stations` and so on —
different schema, different names, plural.

Measured, not inferred:

```
$ DATABASE_URL=postgresql://.../phb_platform python -m collector check
  database       localhost:5432/phb_platform
Database
  FAIL  connected, but the bas schema is missing.
        Run the migrations in the bas-db project first.
Station
  OK    atlashost - Niagara AX 4.15.4.24
```

It connects fine and reaches the station fine. `schema_present()` in
`collector/db.py` is `SELECT to_regclass('bas.reading') IS NOT NULL`, which is
NULL against the platform database.

**`collector sync` has no such guard** — `cmd_sync` goes straight into `sync()`
without calling `schema_present()`. Its first write would be
`INSERT INTO bas.org …`, which fails inside `with self.transaction()`:

```
ERROR:  relation "bas.org" does not exist
ROLLBACK
```

So it fails safe — nothing is written and nothing is corrupted — but it fails
with a raw psycopg error rather than the clear message `check` gives.

**Why repointing anyway would be actively harmful.** The scheduled task *BAS
Collector Sync* runs every 15 minutes and is currently the only thing collecting
anything. Point it at a database it cannot write to and collection stops
completely — while the station keeps overwriting its own history every **41.7
hours**. Nothing alarms. Within two days there is a permanent hole, which is the
exact outcome this entire module exists to prevent. **Do not repoint `.env`
until the collector speaks the platform's schema.**

### The three ways forward, and why two of them do not work

| Approach | Verdict |
|---|---|
| Views in a `bas` schema mapping onto `public.bas_*` | **No.** Single-table views are auto-updatable, but `collector/db.py` uses `INSERT … ON CONFLICT` everywhere and PostgreSQL does not support `ON CONFLICT` on a view |
| `search_path` | **No.** The names are schema-qualified (`bas.reading`), so the search path is never consulted |
| Rename the table references in the collector | **The only option.** Roughly thirty statements in `collector/db.py` plus a handful in `cli.py` |

The third is a real change to the one component validated against real hardware,
which `docs/08-bas-and-niagara.md` deliberately keeps outside this repo. It needs
its own decision, and its own before-and-after run against the live station. It
is **not** a configuration change and must not be scheduled as one.

**Until then**, keep the collector on the standalone database and refresh the
platform copy with `scripts/bas-import.ts --apply --truncate-target`, which is
what *The dev platform database gets staler every day* describes.

---

## Repointing the collector also repoints the nightly backup — and breaks it

**Checked by running it, 24 August 2026. Both halves of this are true and the
second one is the dangerous one.**

`Backup-BasDatabase.ps1` reads `DATABASE_URL` from the **same**
`C:\dev\bas-collector\.env` the collector uses:

```powershell
$match = Select-String -Path $envFile -Pattern '^DATABASE_URL=(.+)$' | Select-Object -First 1
```

So changing that one line also moves the nightly 02:15 *BAS Database Backup*
task onto whatever database it names. There is no second setting.

**The dump itself is correct and complete.** Run against the platform database it
contains all twelve `bas_*` tables **and** the platform's own:

```
TABLE DATA public bas_readings          TABLE DATA public employees
TABLE DATA public bas_points            TABLE DATA public audit_events
TABLE DATA public bas_ingest_runs       TABLE DATA public module_grants
TABLE DATA public bas_data_gaps         TABLE DATA public modules
… all 12 …                              TABLE DATA public positions
                                        TABLE DATA public departments
                                        TABLE DATA public draft_locks
                                        TABLE DATA public _prisma_migrations
```

**But the script's own verification fails, every time.** It looks for the
standalone schema's names:

```powershell
foreach ($t in @('reading', 'point', 'site', 'sync_checkpoint')) {
    if ($toc -notmatch "TABLE DATA bas $t") { … exit 1 }
}
```

Against the platform database the table of contents says
`TABLE DATA public bas_readings`, which does not match `TABLE DATA bas reading`.
Observed:

```
[10:18:15] Backing up to …\bas_2026-08-24_1018.dump
[10:18:16] Wrote 0.15 MB
[10:18:16] FAILED VERIFICATION: table 'reading' is missing from the dump.
EXITCODE=1
```

**Two consequences, and the second is worse than the first.** The exit happens
*after* the dump is written and *before* the rotation step — so old backups are
never rotated out, and the scheduled task reports failure every single night
while a perfectly good dump sits on disk. An operator who learns that the
nightly "backup failed" line means nothing has no backup at all.

### The fix

Not yet applied — `C:\dev\bas-collector` is outside this repository. Apply it
**before** repointing `.env`, whenever B6 happens. Replace the `foreach` block in
the *Verify* section of `Backup-BasDatabase.ps1` with:

```powershell
# The same data lives under two different names, and which one a dump uses
# depends entirely on which database .env points at:
#
#   standalone bas database   TABLE DATA bas reading
#   platform database         TABLE DATA public bas_readings
#
# The trailing \s matters: without it 'bas point' also matches 'bas point_link',
# so a dump missing bas.point could pass.
function Test-TocHasTables($toc, [string[]]$tables) {
    foreach ($t in $tables) {
        $pattern = [regex]::Escape("TABLE DATA $t") + '\s'
        if ($toc -notmatch $pattern) { return $false }
    }
    return $true
}

$standaloneTables = @('bas reading', 'bas point', 'bas site', 'bas sync_checkpoint')
$platformTables   = @('public bas_readings', 'public bas_points',
                      'public bas_sites', 'public bas_sync_checkpoints')

if (Test-TocHasTables $toc $standaloneTables) {
    $layout = 'standalone bas schema'
} elseif (Test-TocHasTables $toc $platformTables) {
    $layout = 'platform public.bas_* tables'
} else {
    Write-Log "FAILED VERIFICATION: the dump has neither the standalone bas schema nor the platform bas_* tables. Core tables are missing."
    exit 1
}
Write-Log "Verified: archive readable, core tables present ($layout)"
```

Measured on a copy of the script, against real dumps:

| Case | Result |
|---|---|
| Platform database | `Verified … (platform public.bas_* tables)`, exit 0 |
| Standalone `bas` database | `Verified … (standalone bas schema)`, exit 0 — no regression |
| A dump of `public.positions` only | Refused, neither layout matched |
| A TOC with `bas point_link` but no `bas point` | Refused. **The old check passed this** |

That last row is a latent bug in the original, fixed in passing: `TABLE DATA bas
point` matches `TABLE DATA bas point_link`, so a dump missing `bas.point` would
have verified clean.

### One more thing to decide before repointing

The backup destination is **OneDrive**. Today it holds building sensor readings.
Pointed at the platform database it would also hold `employees` — real names and
work email addresses — plus `audit_events` and `module_grants`. That is company
data going to company OneDrive, so it is not a leak, but it is a change in what
the file *is*, and whoever owns that folder should know before it happens rather
than after.

---

## Refreshing the platform copy from the standalone database

Routine, and the answer to *The dev platform database gets staler every day*.
Roughly 12 readings per point per 15-minute cycle accumulate in the standalone
database and nowhere else until this is run.

```bash
# 1. Back up BOTH. --truncate-target is destructive and bas_readings beyond the
#    ~42-hour roll horizon is the only copy in existence.
pg_dump "postgresql://…/phb_platform" -Fc --no-owner --no-privileges -f "C:\dev\phb_platform_$(date +%F_%H%M).dump"
pg_dump "postgresql://…/bas"          -Fc --no-owner --no-privileges -f "C:\dev\bas_standalone_$(date +%F_%H%M).dump"

# 2. Prove the dumps are readable. A dump never read back is a file, not a backup.
pg_restore --list <platform dump>   | grep "TABLE DATA public bas_readings"
pg_restore --list <standalone dump> | grep "TABLE DATA bas reading"

# 3. Dry run first. Always safe, exits 0 even when it reports a blocker.
npx tsx scripts/bas-import.ts

# 4. Apply, then verify by content.
npx tsx scripts/bas-import.ts --apply --truncate-target
npm run bas:verify
```

Both steps 4 and 5 must end in the word VERIFIED:

```
12/12 tables and 103/103 columns compared by content, 5798 rows written,
roll_horizon_s recomputed. IMPORT VERIFIED.
12/12 tables compared by content. Every table matches. CONTENT VERIFIED.
```

**The count in step 3 tells you what you are about to gain.** On 24 August the
dry run reported `bas_readings 5591 source / 5519 target` and `bas_ingest_runs
70 / 64` — three hours of drift. If source and target already agree, there is
nothing to do and the truncate is pure risk.

**`bas_verify` reports `bas_points: roll_horizon_s` as "present in the target and
NOT compared", and that is correct.** It is maintained by a trigger on the target
and has no counterpart in the source. See *`migrate dev` emits ALTER COLUMN
roll_horizon_s DROP DEFAULT*.

Afterwards, `npm run bas:oracle -- --source` should show the two databases
agreeing except for whatever the collector wrote during the run itself.

---

## The BAS read-only role on the platform database

**Created 24 August 2026, when Grafana and the MCP server were moved off the
standalone `bas` database.** `bas_readonly_platform`, created by
`C:\dev\bas-mcp\setup_readonly_role_platform.sql`.

It is a **different role** from the standalone database's `bas_readonly`, and
that is not tidiness. PostgreSQL roles are cluster-wide, so there is exactly one
password per role name. `bas_readonly`'s password is `bas_readonly_local`,
committed in `setup_readonly_role.sql` on purpose, and that file says never to
reuse it. Granting that role on `phb_platform` would hand a committed password
read access to real building data. Both roles now exist; `bas_readonly` has no
privileges on `phb_platform` and must not be given any.

**Every grant is per-table, on names matching `bas\_%`.** The standalone database
had a schema of its own, so `GRANT SELECT ON ALL TABLES IN SCHEMA bas` was
precise. `phb_platform` keeps the twelve `bas_*` tables and six `bas_v_*` views in
`public` alongside `employees`, `audit_events`, `module_grants`, `modules`,
`positions`, `departments`, `draft_locks` and `_prisma_migrations`. A role that
can read the employee directory is not a read-only BAS role. This is the same
shape used for `bas_collector`.

The pattern is `'bas\_%'` with the underscore escaped. Unescaped, `_` is a
single-character wildcard and `'bas_%'` would also match a table called
`basement_survey`.

### Proving it, which is the only part that counts

The grant that lets the right thing through proves nothing on its own. Run all
three:

```powershell
$ro = "postgresql://bas_readonly_platform:<password>@localhost:5432/phb_platform"
psql "$ro" -c "SELECT count(*) FROM bas_points"       # must succeed
psql "$ro" -c "SELECT count(*) FROM employees"        # must be DENIED
psql "$ro" -c "SELECT count(*) FROM audit_events"     # must be DENIED
```

Measured on creation: 18 objects readable (12 tables + 6 views), 8 platform
tables refused with `permission denied for table ...`.

### Two independent layers stop writes, and only one of them holds

```powershell
# Layer 1: the role default. A client can turn this off.
psql "$ro" -c "INSERT INTO bas_orgs (name) VALUES ('x')"
#   ERROR: cannot execute INSERT in a read-only transaction

# Layer 2: the grant. Nothing the client sends can change this.
$env:PGOPTIONS="-c default_transaction_read_only=off"
psql "$ro" -c "INSERT INTO bas_orgs (name) VALUES ('x')"
#   ERROR: permission denied for table bas_orgs
```

**Test layer 2 the way the second block does.** `default_transaction_read_only`
is a role *default*, not a lock — `SET default_transaction_read_only = off` is
permitted. A write test that leaves it on only ever proves the layer that the
client controls. Both were measured; `CREATE TABLE` fails with `permission denied
for schema public` and nothing was written in any case.

### `ALTER DEFAULT PRIVILEGES` is deliberately absent, and this is the cost

The standalone script uses it so that objects created by future migrations are
covered automatically. **That mechanism cannot be used here.** Default privileges
apply per schema and per creating role, and there is no way to filter them by
table name. `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES`
would silently grant this role `SELECT` on the next table Prisma creates,
whatever it happens to hold.

So a new `bas_*` table or view is invisible to Grafana and the MCP server until
the script is re-run. That failure is loud — a permissions error in a panel — and
the fix is one command. The alternative fails silently and without limit.

**After any migration that adds a `bas_*` object:**

```powershell
cd C:\dev\bas-mcp
psql "$dsn" -v pw=<the existing password> -f setup_readonly_role_platform.sql
```

Re-running is safe and is also how the password is rotated.

---

## `psql` does not substitute `:variables` inside a dollar-quoted block

**Cost twenty minutes on 24 August. The error names the wrong thing.**

**Symptom.** A setup script that takes a password as `-v pw=...` fails with:

```
psql:setup_readonly_role_platform.sql:70: ERROR:  syntax error at or near ":"
LINE 4: ...TE ROLE bas_readonly_platform WITH LOGIN PASSWORD %L', :pw);
```

**Cause.** The `CREATE ROLE` was inside `DO $$ ... $$`. psql performs variable
interpolation on its input *before* sending it to the server, but it deliberately
skips the interior of dollar-quoted strings — otherwise every PL/pgSQL body
containing a colon would be mangled. So `:pw` is sent to the server literally,
and the server has no idea what it means.

The error points at the colon, which reads like a quoting mistake in the SQL
rather than a psql feature working as designed.

**Fix.** Build the statement as text outside the block and run it with `\gexec`:

```sql
SELECT format('CREATE ROLE bas_readonly_platform WITH LOGIN PASSWORD %L', :'pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bas_readonly_platform')
UNION ALL
SELECT format('ALTER ROLE bas_readonly_platform WITH LOGIN PASSWORD %L', :'pw')
 WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bas_readonly_platform');
\gexec
```

`:'pw'` — with the inner quotes — asks psql to quote the value as a SQL literal,
which is also what escapes a password containing a quote. The `UNION ALL` makes
the script re-runnable and turns it into the password-rotation path as well.

---

## Retargeting a reader: the checks that pass without checking

**The pattern that keeps recurring in this project, seen twice more on 24 August
while moving Grafana and the MCP server onto the platform database.**

When SQL is retargeted from `bas.reading` to `bas_readings`, the *tests* usually
contain the old names too — and a test against a table that no longer exists does
not necessarily fail. It can pass for the wrong reason.

`C:\dev\bas-mcp\test_tools.py` had three distinct behaviours in one file:

| Check | Against the stale name |
|---|---|
| `run_sql("DELETE FROM bas.reading")` is refused | **Passes vacuously.** The validator rejects it on the string before the database ever sees it, so it would pass against any nonsense table |
| `"bas.reading" in describe_schema()` | Fails — loudly and correctly |
| The role-level write test, `DELETE FROM bas.reading WHERE false` | Fails, but **for the wrong reason**: it expects `InsufficientPrivilege` and gets `UndefinedTable`, so the message sends you to the permissions system when the problem is the table name |

Only the first is dangerous, and it is the one that looks fine. **Retarget the
test file in the same pass as the code, and read the assertions rather than the
pass count.**

The same class of thing in `server.py`: `describe_schema` built its headings as
`f"## bas.{current}"`, where `current` comes from `bas_v_data_dictionary`. On the
platform that column already carries the prefix, so the output read
`## bas.bas_v_reading` — a relation that does not exist, handed to a language
model as documentation. Nothing errors; the model just writes SQL against a name
it was told about.

---

## A Grafana panel disagrees with the chart beside it

**Fixed 24 August 2026 in `bas-collection-health.json`, panel 8.**

**Symptom.** Set the dashboard range to 24 hours. *Records written per collector
run* shows 12 bars. *Recent collector runs*, directly beside it, lists 30 runs
going back a week.

**Cause.** Panel 8's query had no `$__timeFilter`, so the dashboard's time range
did not reach it. Only its `LIMIT 30` bounded the output.

**Fix**, one clause:

```sql
WHERE $__timeFilter(ir.started_at) AND (st.site_id IN ($site) OR st.site_id IS NULL)
```

Measured before and after:

| Range | Panel 7 (chart) | Panel 8, before | Panel 8, after |
|---|---|---|---|
| 24 hours | 12 | 30 | **12** |
| 7 days | 74 | 30 | 30 *(its own LIMIT)* |

The platform's own Collection Health screen already windowed both, so this brings
Grafana into line with it rather than the other way round. `npm run bas:oracle`
compares the two and has a comment explaining why it applies the window to its
copy of panel 8.

---

## Editing a dashboard JSON is not the same as the query running

**Both dashboards were rewritten and then every query was executed.** Do the
second part. 19 queries across two files, and a rewrite that produces valid JSON
and invalid SQL looks identical in a diff.

The Grafana macros have to be expanded first, the way Grafana expands them:

| Macro | Expands to |
|---|---|
| `$__timeFilter(col)` | `col BETWEEN <from> AND <to>` |
| `$site` | a **comma-separated list of ids**, because the variable is `multi` with `includeAll` — never the literal string `All` |
| `$point` | a single `point_id` |

Run them **as `bas_readonly_platform`**, not as a superuser. That is the account
Grafana uses, and it is the one that will hit a missing grant.

`README.md` in `bas-grafana` also carries five hand-written fallback queries for
rebuilding a panel by hand. Those were retargeted and executed too — documentation
someone will paste is code.

---

## The Building Automation tabs are routes, not state

`/bas` is Collection Health. `/bas/points` is Point Explorer. Each is a real
route, so each bookmarks, survives a refresh, and opens in a new tab from a
middle-click. Adding B5's *Ask* is one entry in
`app/(modules)/bas/tabs.ts` plus `app/(modules)/bas/ask/page.tsx`.

**Every tab guards itself.** A tab bar is navigation, not authorization.
`/bas/points` calls `requireModuleAccess` in its own `page.tsx`, and the API
route it fetches repeats the check independently. Reaching a URL directly is the
case that matters and the tab bar is not involved in it.

### Why the chrome is not a Next.js layout

**Do not move `BasShell` into `app/(modules)/bas/layout.tsx`.** It looks like the
obvious refactor and it opens a hole.

A layout renders *around* a page that calls `notFound()`. So an employee without
the grant would get the "Building Automation" heading and the tab bar wrapped
around a 404 body — which confirms the module exists to exactly the person who
must not learn that. `docs/04-auth-and-permissions.md` is why the guard answers
404 rather than 403 in the first place; a layout would undo that at the
presentation layer.

Rendering the chrome from inside each guarded page means the guard throws before
any of it exists. `tests/bas-module.test.ts`, *every tab is guarded on its own
route*, asserts the digest for both tabs, unauthenticated and ungranted, and with
the module row hidden.

**The sidebar keeps exactly one entry.** `components/sidebar.tsx` renders from
the `modules` table and knows nothing about tabs. One module, one row, one
sidebar item — however many tabs it grows.

---

## The filters live in the URL, and that is what makes them trustworthy

`site`, `days` and `point` are query parameters, not React state. Three things
follow, and none of them are free any other way:

- **They survive a tab switch.** `tabHref` carries the whole query string, so
  selecting a building on Collection Health and moving to Point Explorer keeps
  it. A filter that silently resets is worse than no filter at all: a filtered
  zero and a real zero look identical, and the reader has no way to tell which
  one they are looking at.
- **They are bookmarkable.** `/bas/points?site=5&days=1&point=41` is a URL that
  goes in a ticket.
- **They survive a refresh**, because there is nothing to survive — the URL is
  the state.

Two conventions worth knowing before editing `filters.ts`:

| Rule | Why |
|---|---|
| `null` deletes the parameter | `/bas` beats `/bas?site=&days=&point=` |
| The default window is dropped | A URL should carry choices, not restate defaults |
| `__all__` never leaves the browser | It is a `<select>` sentinel. Absent already means all buildings to the server |

Filter changes use `router.replace`, so changing a filter twenty times does not
put twenty entries in the back button. Tab links are ordinary `<Link>`s, so
moving between tabs *is* in the history.

**The filtering itself still happens in SQL.** These helpers only read and
rewrite the query string; `siteFilter` in `lib/modules/bas/service.ts` is what
excludes rows. Nothing is fetched and then hidden.

---

## The trend chart must break across gaps, not draw through them

**The single thing most likely to be got wrong on this screen, and the one that
turns missing data into a confident lie.**

A line drawn straight across a hole asserts readings that were never taken. This
is not hypothetical here. On 21–22 August 2026 the station overwrote **22.7
hours** of every point on the site before the collector came back, and a straight
segment across that hole renders as a steady temperature — the most confident
possible drawing of data that no longer exists anywhere.

**Note the two different numbers.** The *collector* was silent for **64.3 hours**
(21 Aug 16:05 → 24 Aug 08:20). The hole in the *readings* is **22.7 hours**
(21 Aug 16:05 → 22 Aug 14:45), because when the collector came back it backfilled
everything the station still held — the station keeps 41.7 hours, so it recovered
the rest. 64.3 − 41.7 = 22.6, which is what `bas_data_gaps` records. The chart
shows the 22.7-hour hole because that is the hole in the data being plotted.

### How the break is made

Three mechanisms, because one is not enough to be noticed:

1. **`buildTrend` in the service inserts an explicit null sample** between any
   two readings further apart than the threshold, and Recharts is told
   `connectNulls={false}`. This is what actually stops the line. `connectNulls`
   already defaults to false — it is written out anyway, because a future edit
   that flipped it would silently draw through 22.7 hours of destroyed data.
2. **A shaded band** over every gap. A break on its own reads as a rendering
   artifact; a labelled band does not.
3. **A list under the chart**, naming each gap's start, end and duration in
   words.

### The threshold

`max(3 × collection_interval_s, 15 minutes)`. A multiple of the point's own
interval so it scales with how often the point is actually logged, and a floor
for points whose interval has not been filled in from Workbench — where the
alternative is either never breaking or breaking constantly.

At the lab station's 300 s interval that is 15 minutes. Measured cadence there is
a 300 s median against a 357 s mean, so ordinary late polls do not fragment the
line.

### Verifying it, which means against the real gap

Do not assume Recharts' default. Run it:

```bash
npm run bas:oracle -- --point 41 --days 7
```

and check `trendGaps` is non-empty for a 7-day window on any point at Spring
Grove Lab. Every active point there shows exactly one gap of 22.7 hours. A
1-day window shows none, which is also correct — the hole is outside it.

`tests/bas-point-explorer.test.ts` drives `buildTrend` directly with synthetic
series, and then writes a reading 30 hours old into the fixture and asserts the
gap appears end to end through the database.

---

## Distinct values, not standard deviation

**Got wrong twice before it was got right. The reasoning is here so it is not got
wrong a third time.**

To judge whether a sensor is alive, count how many **distinct values** it
produced. Do not threshold its standard deviation.

A sigma threshold is **unit-dependent** — "below 0.5" means something different
in °F, °C, percent open and pascals — and it is **untunable across buildings**.
Worse, it points the wrong way: a stuck sensor has a *low* standard deviation and
so does a genuinely stable room, so the test cannot separate them. It missed a
sensor frozen at 64.5 with σ = 0.08.

Distinct-value count does not care about units. A sensor sampling the physical
world produces many values; a dead one repeats a handful.

Live figures from this database, over 24 hours:

| Point | Readings | Distinct | Verdict |
|---|---|---|---|
| `Temp1` | 286 | 254 | healthy |
| `Temp2` | 286 | 252 | healthy |
| `Temp3` | 286 | 253 | healthy |
| `points_RoomT` | 286 | 28 | healthy — coarser resolution, still alive |

Thresholds are Grafana's, from panel 5: **red below 4, amber 4–19, green from
20**. `points_RoomT` at 28 sits above green with room to spare, which is the
point — a coarse sensor is not a stuck one.

**Zero readings is `neutral`, not red.** No evidence is not bad evidence, and
colouring it red would be as wrong as colouring it green.

---

## A null reading is not a missing reading, and the tile is how they stay apart

`bas_readings` allows a row with **zero** populated value columns. That is a
record the station returned empty — a sensor fault — and it is different from
**no row at all**, which means we never collected. Analysis that merges the two
reports equipment shutdowns that never happened.

The *Readings / null records* tile shows both numbers for exactly this reason,
and the wording changes to say which situation it is in:

| State | What the tile says |
|---|---|
| 0 readings | "No rows at all in this window… it means nothing was collected" |
| 286 readings, 0 nulls | "Every row carries a value" |
| 286 readings, 3 nulls | "…the station logged an entry and had nothing to put in it. That is a sensor fault, not a missing row" |

Both of the first two report **0 nulls** and they mean opposite things. That is
the whole reason the tile carries two numbers rather than one.

In the trend series the two are also kept apart: a null-valued row is a sample
with `value: null` and `isBreak: false`; a synthetic break is `isBreak: true`.
The line cannot cross either, but only one of them has a record behind it — and
the oracle counts only the real ones, so a point with a gap does not report a
false difference against Grafana.

**There are currently zero null-valued rows in the database.** The tile is
therefore untested by live data, and is covered by a fixture test that writes
one.

---

## Units, and the axis that must not lie

`points_RoomT` is in fahrenheit. `Temp1`, `Temp2` and `Temp3` carry **no unit at
all** — `bas_points.unit` is NULL.

The Point Explorer plots **one point at a time**, matching Grafana's dashboard
where `$point` is `multi: false`. That is a correctness decision, not a scoping
one: two of these on one axis would put a temperature in °F and a bare number on
the same line with nothing on screen saying they are different quantities, which
is how 55 °F and 12.8 °C end up looking like the same reading.

A single-point chart cannot express that mistake, so it does not need to guard
against it.

**The axis still says which situation it is in.** `axisLabel(null)` renders
"value (no unit recorded)" rather than leaving the axis bare, because a bare axis
reads as *no unit needed* and the truth is *unit unknown*. Those are different
claims.

### If a compare mode is ever added

It needs, and this is not optional:

- one Y axis per distinct unit, never a shared one;
- an explicit refusal — not a silent overlay — when a point has no unit, because
  an unknown unit cannot be shown to match any other;
- the unit on every series in the legend and the tooltip.

---

## Comparing the Point Explorer against Grafana

```bash
npm run bas:oracle                          # both dashboards, 7 days
npm run bas:oracle -- --point 41 --days 1   # one point, one window
```

`npm run bas:oracle` now covers **both** dashboards. It resolves which point the
screen would be showing — with no `--point`, whichever the picker offers first,
in the picker's own order — before either side runs, so the two are never asked
about different points.

Verified on 24 August 2026: every panel of both dashboards matched, across all
four points and both the 1-day and 7-day windows.

**Two comparison rules exist to stop false alarms, and both are narrower than
they look.**

*Trend sample count counts real rows only.* The screen's series carries synthetic
nulls that break the line across holes. There is no row behind them, so counting
them would report a difference on every point that has ever had a gap.

*Numbers are compared as numbers.* PostgreSQL renders `round(x::numeric, 2)` as
`-40.00`; JavaScript renders the float8 parsed from the same expression as `-40`.
Grafana is not even internally consistent — its Latest panel casts float8 straight
to text and gets `-40`, while its Range panels go through numeric and get
`-40.00`. Both sides round to two decimal places in SQL, so the comparison
normalises to six: well beyond what either side claims, and still catching any
real difference.

---

## `bas_readings.status` is empty, and that is not a collector fault

**Corrected 24 August 2026. The previous description of this column was wrong in
the worst available direction, so read this before acting on a NULL status.**

**Symptom that brings you here.** Every reading has `status IS NULL`. It looks
like the collector is dropping a field.

**It is not.** Measured, not inferred: **0 of 5,759 readings across all four
points** carry a status, and none ever will over this extraction path. The oBIX
`~historyQuery` response includes a `#RecordDef` prototype that declares exactly
what each record contains, and for these histories it declares two fields and no
more:

```xml
<abstime name="timestamp" tz="Etc/UTC"/>
<real name="value" unit="obix:units/fahrenheit"/>
```

Niagara does not send status with history records this way. **There is nothing to
fix in the code.** Do not go looking in `collector/obix.py`.

### What the column comment used to say, and why it mattered

Until this correction, `bas_readings.status` was documented as:

> Niagara status flags as reported, e.g. `{down}` or `{overridden}`. A value
> present with an override flag is not the same as a value the building actually
> produced.

That described a capability we have never had. Worse, it **inverted the meaning
of the data**. Someone reading a NULL against that comment concludes *the station
reported no problems*. The truth is *the station was never asked and never told
us*. Those are opposite readings of the same empty column, and the wrong one is
the reassuring one.

**NULL means "not supplied". It never means "no fault".**

This was not only a developer-facing note. `bas_v_data_dictionary` selects column
comments and exists to be pasted into an LLM prompt — so the comment was an
instruction to a model that writes SQL against this column. Both
`bas_readings.status` and `bas_v_reading.status` now carry the corrected text;
the view's column had no description at all, which invited a reader to fall back
on the base table's.

### The column stays

A Supervisor or a different extraction path may populate it later, and an
always-null column is cheaper than a migration. Do not drop it.

### The consequence: fault detection here is value-based only

We cannot ask what the station believes about a reading. That is the design
rather than a gap to work around — a rule saying *a room temperature of -40 is
not a temperature* works on Johnson Controls and Siemens too, and PH+B's
portfolio will not be all Niagara. A fault library built on values ports to the
next building; one built on vendor status flags does not.

### If somebody asks for status later — two routes, both UNVERIFIED

Neither has been tried. Neither is scheduled. They are recorded so nobody
re-derives them, and flagged so nobody quotes them as a plan.

| Route | What it would give | What it is |
|---|---|---|
| oBIX **points** carry a status facet even though history records do not. Reading current value + status alongside the history | *"the station says this point is in fault **right now**"* — never what it thought at 3am last Tuesday | A small collector addition. Present-tense only, so no use for analysing history |
| **Alarm extensions**, which is how Niagara buildings actually signal this. Alarms are separately queryable | The real signal, as engineered | Niagara engineering work with its own extraction path. **Not a configuration toggle** |

### And one thing that is genuinely unknown

**Whether the history itself can be configured to include status is UNKNOWN.**
Do not assert it either way.

What would settle it, in Workbench:

- what record type the history extension logs for these points, and whether a
  record type carrying status is available and selectable;
- whether the `ObixNetwork` exposes anything about record fields, or whether the
  `#RecordDef` prototype is fixed by the history's own configuration.

Until somebody looks, "we do not know" is the correct answer to give.

### Why the fix is a new migration and not an edit

The wrong text was in `20260821151125_add_bas_comments`, which is applied.
Editing an applied migration breaks its checksum, and the documented recovery is
`prisma migrate reset` — see *Editing a migration that has already been applied*.

**That advice is now out of date for this database and this entry supersedes it
for anything touching `bas_*`.** It was written in August against synthetic data,
before the cutover. The collector now writes `bas_readings` directly, the
standalone `bas` database is no longer being written to, and the station holds
41.7 hours. A reset would destroy readings that exist nowhere else.

The correction is `20260824180000_correct_bas_readings_status_comment`, which
contains two `COMMENT ON` statements and nothing else — no structural change and
no data change.

**So the old text is still on disk, in `20260821151125`, and must stay there.**
If you grep for `status flags as reported` that migration is what you will find
first. It is history, not documentation: migrations record what was run, and the
later one supersedes it. The authority on what a column means is
`\d+ bas_readings` against the live database, or `bas_v_data_dictionary` — both
of which now say the right thing.

---

## points_RoomT went to -40 and stayed there

**24 August 2026. The first genuine building observation this system has
produced, and a worked example of what value-based fault detection looks like.**

**What happened.** `points_RoomT` — the one real sensor at Spring Grove Lab, and
the only classified point (`zone_temp`, fahrenheit) — stepped from **76.1** to
exactly **−40** between `13:00` and `13:05` UTC, and has held there since. As of
this writing, 55 consecutive readings, every one of them −40, one distinct value.

```
 utc          edt     value_num
 08-24 12:55  08:55   76
 08-24 13:00  09:00   76.0999984741211
 08-24 13:05  09:05   -40          <- step
 08-24 13:10  09:10   -40
```

**Why −40 is not a temperature.** −40 is the one point where Celsius and
Fahrenheit are equal, which makes it a conventional out-of-range sentinel, and it
is a common **open-circuit signature** for a resistive temperature sensor: the
input reads full-scale-low when the wire is broken or the sensor has failed
open. A room does not go from 76 °F to −40 °F in five minutes and then hold
perfectly flat. **This reads as a wiring or sensor failure, not as weather.**

Stated as what it is: a plausible reading of a signature, not a diagnosis. The
building is not ours and nobody has been to look at the wire.

**Confirmed independently.** The same vertical step appears in Workbench's own
chart at 13:00 UTC. That is worth more than a second opinion — it also
**cross-checks our timestamps end to end**, since 13:05 UTC is 09:05 EDT and both
render the step at the same instant. After the four-hour Prisma timestamp defect
in August (*Timestamps written through Prisma were four hours out*), an
independent confirmation that our clock agrees with the station's is not a
formality.

### Why this is the worked example

**It was caught from the value alone.** `status` was NULL for every one of those
readings, as it is for all of them — the station told us nothing. No alarm
reached us, because we do not read alarms. The only evidence was the number.

That is exactly the argument in *`bas_readings.status` is empty*: a rule that
says −40 is not a room temperature needs no vendor cooperation, and it will work
unchanged on the next building whatever controller is in it.

**What the screens show.** On Point Explorer with `points_RoomT` selected:

- *Latest* reads **−40**, and *Range* reads **−40 to 78.4** at both 24 hours and
  7 days. That is the tell. A range spanning 118 degrees inside a day is not a
  room.
- *Distinct values* is **green at both windows** — 27 distinct across 288
  readings at 24 hours, 33 across 1,442 at 7 days. Measured, because the first
  draft of this entry guessed that the 24-hour figure would already have fallen
  and it had not.

**That green tile is worth understanding rather than treating as a miss.**
Distinct-value count answers *"is this sensor still moving"*, and it is a
**lagging** indicator by construction: the failure began at 09:05 EDT, so a
24-hour window still holds roughly seventeen hours of live data from before it.
The count only falls once the flat run dominates the window — around a day after
onset for the 24-hour view, a week for the 7-day one.

So the stuck-sensor tile is not what catches a fault like this, and it was never
meant to be. **The value is.** −40 is wrong the instant it appears; a flat line
takes a window's worth of time to become statistically obvious. Both signals are
worth having and they answer different questions on different timescales.

**What has NOT been done.** No fault rule has been written, nothing alerts on
this, and no `point_role`-driven range check exists yet — that is B5 territory.
This entry exists so the observation is not lost, and so the first rule written
has a real case to be tested against.
