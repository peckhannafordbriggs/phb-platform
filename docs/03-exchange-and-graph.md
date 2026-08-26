# Exchange and Microsoft Graph

## Exchange is the source of truth

```
                Exchange
                   │
          ┌────────┴────────┐
          ▼                 ▼
       Outlook         PHB Platform
```

Both are clients of the same mailbox. Required behavior:

```
Email arrives in Exchange        → visible in Outlook AND in the platform
Draft created in Outlook         → visible in the platform
Draft edited in the platform     → updated draft visible in Outlook
Employee clicks Send in platform → sent through Exchange, lands in Sent Items
Message moved/deleted in Outlook → reflected in the platform
```

The platform must not create an independent email system, and must not maintain a
second copy of mailbox state.

## No sync engine

With 1–3 users this is settled:

- Reads go **live to Graph** on request.
- Short-lived in-memory cache only (seconds), for list views.
- **No message index table. No delta token store. No Graph change notifications /
  webhooks / subscriptions.** Poll the current folder on an interval while the tab is
  focused.
- Writes go **straight through to Graph** synchronously, then re-read. No write
  queue, no optimistic local store.

If the platform's mailbox tables can't be dropped and rebuilt from Graph with no loss,
a second mailbox has been built by accident.

Webhooks become worth their reliability cost only when a background job must react to
inbound mail with no human present. Polling versus change notifications gets decided
when two-way sync and reliability are built, not before.

## Never persist

Message bodies. Attachment content. Anything from `Bid Tracker.xlsx`. Anything from
the SharePoint CO state files.

## Authentication

App-only (client credentials). One Entra app registration with Graph **application**
permissions:

- `Mail.ReadWrite`
- `Mail.Send`

Scoped by an Exchange **ApplicationAccessPolicy** to a mail-enabled security group
containing only `changeorder@phb1899.com`. Without that policy, these permissions
reach every mailbox in the company. The policy is part of the setup, not a follow-up.

Credentials:

- **Production:** Azure managed identity + federated identity credential. Nothing
  expires.
- **Local development:** client secret in `.env.local`. Never committed, never used in
  Azure.

## Graph rules

**Always send `Prefer: IdType="ImmutableId"`.** On every request, without exception.
By default a message ID changes when the message moves folders — and Power Automate
moves messages constantly. Any ID captured without this header goes stale silently.

**`$search` ignores that header, so the platform does not use `$search`.** Verified
against the live mailbox in Phase 8: the same message in the same folder came back with
an immutable ID (`AAkALg…`) from a `$filter` listing and a standard, folder-scoped ID
(`AAMkAD…`) from `$search`, with the header present on both requests. A standard ID
**does** change on a move, so every ID the search box produced was one move from dead.

A GET cannot translate one: Graph echoes back whichever ID form addressed the resource,
so only a collection request yields an immutable ID.

**Searching a folder therefore means `$filter=contains(subject,'…')`.** Subject only —
not the body, not the sender, not attachment names. Accepted deliberately: subjects in
this mailbox carry the bracketed project tag people actually search for, and a stale ID
is a correctness bug where a narrower search is a smaller feature.

**`$filter` and `$orderby` cannot be combined on messages.** Exchange answers
`400 InefficientFilter`, for `contains` and `startswith` alike. So a subject search sends
no ordering and Exchange returns neither date nor relevance order — a real folder came
back 08-19, 08-19, 08-18, 08-25, 08-06. A plain folder listing (no `$filter`) *does*
order by `receivedDateTime desc`. The UI says which one it is showing. Adding an
`$orderby` to the search path does not degrade it, it breaks every search outright.

**Reply and forward via Graph, not by hand.** Use `createReply`, `createReplyAll`,
`createForward`. They return a real Exchange draft with quoting and threading intact.

**Send the existing draft, never `sendMail`.**

```
POST /users/{mailbox}/messages/{id}/send
```

Sending via `sendMail` with a copied body loses the attachments Power Automate
attached, the bracketed subject tag that downstream filing depends on, and
conversation threading.

**The subject tag, as it actually appears in the mailbox.** Earlier drafts of these
docs wrote it as `[CO: Owner|Bulletin]`. That was schematic, not literal — verified
against `changeorder@phb1899.com` in Phase 4 Part B. The real format is a bracketed
project and change-order identifier at the start of the subject:

```
[CCHMC RFI 229] New CO logged (Bid Tracker) — Due 08/25/2026
[CCHMC Bulletin 12] Change Order Request — Additional Information Needed — …
[ZZTEST PR-91] New CO logged (Bid Tracker) — Due 08/14/2026
```

Not every automation message carries one — the scope-request drafts start with the
project name and no brackets:

```
CCHMC Liberty Expansion — Change Order Scope Request — Due 08-11-2026
```

So **nothing may filter on the literal string `[CO:`** — it appears nowhere in the
mailbox — and nothing may assume a tag is present at all. Preserve the subject
exactly and let a human read it.

**Attachments:** simple upload under 3 MB; `createUploadSession` above that.

**HTML email bodies are attacker-controlled.** Vendors send them. Sanitize
server-side, render in a sandboxed iframe with CSP, block remote images by default.

**Delete is not permanent — but `DELETE` does not do what this doc used to claim.**
Verified against the live mailbox in Phase 8, on both a draft and a received message:
`DELETE /messages/{id}` moves the message to **Recoverable Items \ Deletions** — the
dumpster — and the user-visible Deleted Items folder never sees it. Recovering from
there needs Outlook's *Recover Deleted Items from Server* dialog and is bounded by the
deleted-item retention window.

So a platform "delete" is implemented as an explicit **move to `deleteditems`**, which
is what actually lands a message in Deleted Items where anyone can drag it back. That is
strictly more recoverable than `DELETE`, and it is what the confirmation dialog promises.

Never expose `permanentDelete`.

**Throttling** concentrates on one mailbox through one app identity — roughly 10k
requests per 10 minutes, ~4 concurrent is the practical ceiling. Not a constraint at
this user count, but don't poll aggressively.

**Concurrent editing.** Outlook and the platform editing one draft is last-write-wins.
Take an advisory lock in the platform DB, show the user when a draft is locked, and
accept that Outlook can still overwrite.

## Service boundary

```
Route handler → mail service → Graph client → Microsoft Graph
```

No raw Graph calls in route handlers or components. The frontend must never see
tenant IDs, Graph scopes, Exchange IDs, tokens, or URL construction — it asks for
"the change-order inbox."

## Development guards

Both enforced inside the mail service, not at the route layer:

- `PHB_ALLOW_SEND` must be `true` or any send throws.
- When `NODE_ENV !== 'production'`, write operations are permitted only on messages
  whose subject begins with `ZZTEST`. Reads unrestricted.

## SharePoint

Stays behind the scenes. Employees get no SharePoint UI. Do not duplicate SharePoint
data into the platform database.

When the backend eventually needs SharePoint reads for CO context, it uses Graph with
`Sites.Selected` granted on the `AISandbox` site only. Not needed until then — do not
request the permission early.

## Power Automate

Untouched. The platform and the flows never talk to each other; both talk to Exchange
and SharePoint. That independence is what makes the platform safe to build and
redeploy while the pipeline runs.

If the backend ever needs to trigger a flow, the mechanism is **writing the
sentinel file** to SharePoint via Graph — zero flow edits, no premium license, no
secret to rotate. Do not introduce Power Automate HTTP triggers.
