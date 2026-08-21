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
| **"Search results, ordered by relevance rather than date"** | Graph's `$search` rejects `$orderby`, so search results genuinely are not newest-first. | Nothing. Clear the search box to get the ordered list back. |

**Real failures** show "That did not load" with a Try again button, and the
underlying code is in the log as `"event":"mail.graph_call_failed"`. The
`outcome` field names which — `auth_failed`, `mailbox_forbidden`, `throttled`,
`network`. Each has its own section above.

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

**What the Change Orders screen contributes.** It polls the selected folder once
a minute, and **only while the tab is visible** — switching away stops the timer,
and returning fires one catch-up read. A search is never polled. So an idle open
tab costs one request per minute, and a backgrounded one costs nothing.

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
| Add a paragraph | An insertion before `</body>`. Nothing existing is rewritten. |
| Edit HTML source | **Replaces the whole body.** The escape hatch, for structural changes. |
| Subject / recipients only | The body is not sent at all, so it cannot change. |

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
| `P1001: Can't reach database server` | The firewall rule allowing Azure services was removed, or the server is stopped. Burstable tier servers can be stopped to save money and stay stopped. | `az postgres flexible-server show -g <rg> -n <server> --query state`. Confirm the `AllowAllAzureServicesAndResourcesWithinAzureIps` rule exists. |
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

# BAS — Building Automation module

## The BAS schema lives in two places, and `schema.prisma` is not all of it

**Read this before changing anything about the `bas_*` tables.** It is the one
thing about this module that is not discoverable from the code.

Prisma models tables, columns and indexes. It does not model **CHECK
constraints**, **generated columns**, or **views**. So three things are defined
in the migration SQL rather than in `prisma/schema.prisma`:

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
It compares row counts table by table, counts how many tables it compared, and
rolls back with `INCONCLUSIVE` if that count is short. That check exists because
`Test-BasRestore.ps1` once printed `RESTORE VERIFIED` after a bad format string
threw inside its comparison loop and skipped all ten tables. **Always count what
you actually checked, and refuse to pass on zero.**

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
