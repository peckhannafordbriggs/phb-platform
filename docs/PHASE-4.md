# Phase 4 — Microsoft 365 Connection

Read `CLAUDE.md` and `docs/03-exchange-and-graph.md` first. Those define **how**, and
override anything here on architecture. `docs/02-existing-co-system.md` defines what
must not break.

---

## Goal

The backend can authenticate to Microsoft Graph as the platform's own identity and read
the real `changeorder@phb1899.com` mailbox, through a mail service layer that every
later phase builds on.

**No email UI in this phase.** The Change Orders page stays a placeholder. The proof
this phase works is a grant-gated endpoint returning real folder names from the real
mailbox.

---

## Credential status

The Graph app registration is being created by IT. It is **not** available yet.

This phase splits accordingly. Build Part A now. Part B is a short wiring-up step once
the credential arrives.

**Do not wait on the credential to start.** Do not stub the credential in a way that
becomes load-bearing — the token provider should be real code with a real
implementation, just unexercised until there's a secret to give it.

---

## Part A — buildable now, no credential

### 1. Environment configuration

Add to `lib/env.ts`, `.env.example`, and `.env.local`:

```
GRAPH_CLIENT_ID
GRAPH_CLIENT_SECRET      # local development only
GRAPH_TENANT_ID
CO_MAILBOX               # changeorder@phb1899.com
```

Rename these if the codebase has a better convention; keep the secret out of
`.env.example`.

These must **not** be required at app boot the way the Auth.js variables are. The
platform has to start and serve the admin screen with no Graph credential configured.
Validate them lazily, when the mail service is first used, and fail with a clear
message naming what's missing.

### 2. Graph client factory

`lib/modules/change-orders/graph/client.ts`

- App-only client credentials flow. `@azure/identity` +
  `@microsoft/microsoft-graph-client`.
- **Local development:** client secret credential.
- **Production:** managed identity / federated credential. Structure the factory so
  swapping is a one-line change behind an environment check, not a rewrite. Production
  must never accept a client secret.
- **Cache the token in memory.** Tokens last around an hour; fetching one per request
  is wasteful and will hit throttling. Refresh before expiry with a small margin.
- **`Prefer: IdType="ImmutableId"` on every request** — set it once in the client, as a
  default header, not at each call site. A call site that forgets it should be
  impossible.

### 3. Mail service

`lib/modules/change-orders/mail/service.ts`

The only thing in the codebase that talks to Graph. Route handlers and components call
the service; they never construct Graph URLs, never see tokens, never see raw Exchange
IDs beyond opaque strings.

Phase 4 surface — reads only:

- `listFolders()` — well-known folders plus child folders
- `getFolder(id)`
- `listMessages(folderId, { top, skipToken })` — metadata only: id, conversationId,
  subject, from, to, receivedDateTime, isDraft, isRead, hasAttachments
- `getMessage(id)` — including body
- `listAttachments(id)` — names, sizes, content types. **No content download.**

Every method targets `CO_MAILBOX` only. The mailbox address is not a parameter any
caller can supply — it comes from configuration. A caller must not be able to point
this service at another mailbox.

### 4. Guards

Enforced **inside the service**, not in route handlers, so no future call site can
bypass them:

- `PHB_ALLOW_SEND` must be `true` or any send throws. Nothing sends in this phase, but
  the check exists now so the code that needs it is added to something already correct.
- When `NODE_ENV !== 'production'`, write operations are permitted only on messages
  whose subject begins with `ZZTEST`. Reads unrestricted.

### 5. Error handling

Map Graph failures to typed application errors so callers never branch on HTTP status
codes or Graph error strings:

- authentication / credential failure
- forbidden — likely the access policy denying a mailbox
- not found
- throttled — respect `Retry-After`, retry once, then surface
- transient network failure
- unexpected

User-facing messages are non-technical. Server logs carry the detail.

**Never log:** tokens, message bodies, attachment content, full recipient lists.
Message IDs and folder IDs are fine.

### 6. HTML sanitization utility

`lib/modules/change-orders/mail/sanitize.ts`

Vendor email bodies are attacker-controlled HTML. Needed in Phase 5, but build and test
it here with real hostile fixtures: script tags, event handlers, `javascript:` URLs,
remote images, iframes, style-based exfiltration.

Server-side sanitization. Remote images stripped or blocked by default.

### 7. Proof endpoint

`GET /api/modules/change-orders/mailbox/health`

Grant-gated like every module route. Returns folder display names and item counts, plus
whether a credential is configured.

With no credential: a clear "not configured" response, not a crash.

### 8. Tests

Against a **mocked Graph transport** — intercept at the HTTP layer with recorded
fixtures. Do not mock the mail service itself; that tests the mock.

Cover:

- `Prefer: IdType="ImmutableId"` present on every outgoing request
- token cached across calls, not refetched per request
- each Graph error status maps to the right typed error
- throttling honors `Retry-After` and retries once
- the mailbox address cannot be overridden by a caller
- `PHB_ALLOW_SEND` false → send throws
- non-production write to a non-`ZZTEST` subject → throws
- sanitizer strips every hostile fixture
- health endpoint: unauthenticated → 401; authenticated without grant → 404
- no token or body content appears in logs

---

## Part B — once the credential arrives

1. Put the values in `.env.local`.
2. Call the health endpoint and confirm real folder names come back — Inbox, Drafts,
   Sent Items, Deleted Items, and the Projects tree.
3. **Verify the fence from our side.** Attempt one read against a mailbox other than
   `changeorder@phb1899.com` using the same credential, in a throwaway script, and
   confirm Graph returns 403. IT's `Test-ApplicationAccessPolicy` output is their
   verification; this is ours. Delete the script afterward.
4. Confirm a draft the automation created is visible through `getMessage`, and that its
   `[CO: Owner|Bulletin]` subject tag is intact.
5. Record in `runbook.md`: the Graph client ID, tenant ID, secret expiry date, the
   symptom when the credential fails, and the fact that production uses a federated
   credential so an expiring secret can only ever affect a developer machine.

---

## Out of scope

Do not build any of this in Phase 4:

- Any Change Orders UI — no folder tree, no message list, no reading pane
- Sending, editing, replying, forwarding, moving, deleting
- Attachment content download
- Search
- Graph change notifications, subscriptions, or webhooks
- Any message, folder, delta-token, or subscription table
- SharePoint access, and do not request `Sites.Selected` yet
- Power Automate integration of any kind
- Claude API

---

## Hard constraints

- **Never persist** message bodies, attachment content, or mailbox state. If a table
  holding mailbox data seems necessary, stop and ask.
- **No `sendMail`, ever** — not in this phase, not in any phase. Sends happen by
  posting to an existing draft.
- **Do not touch the 11 Power Automate flows**, the four sentinel filenames, or
  `Bid Tracker.xlsx`.
- The 62 Phase 1–3 tests must still pass. Nothing in this phase should require changes
  to `lib/auth`, `lib/authz`, or the existing schema. If it does, stop and ask.

---

## Acceptance criteria

**Part A — no credential needed**

- [ ] `npm run build`, `npx tsc --noEmit`, `npx eslint .` clean
- [ ] All Phase 4 tests pass, and all 62 existing tests still pass
- [ ] The app boots and the admin screen works with **no** Graph credential configured
- [ ] Health endpoint returns a clear "not configured" response rather than crashing
- [ ] Health endpoint returns 401 unauthenticated, 404 without a module grant
- [ ] `Prefer: IdType="ImmutableId"` is asserted present on every request in tests
- [ ] Mailbox address cannot be supplied by a caller — proven by test
- [ ] Send throws with `PHB_ALLOW_SEND` unset — proven by test
- [ ] Sanitizer defeats every hostile fixture
- [ ] No secret in any committed file

**Part B — credential required**

- [ ] Health endpoint returns real folder names from `changeorder@phb1899.com`
- [ ] A read against a different mailbox returns 403 — verified from our side
- [ ] An automation-created draft is readable, subject tag intact
- [ ] Runbook entries written

---

## Notes for the implementer

**Build the service boundary carefully — it's the load-bearing part.** Every later
phase adds methods to this service. If Graph details leak into route handlers now,
they leak everywhere later.

**The fence verification in Part B is not paranoia about IT.** Access policies can take
up to an hour to propagate, and a policy that silently didn't apply looks identical to
one that did until you test it. Do it once, from our side, and record the result.

**Stop and ask** if a task appears to need a new significant dependency, a schema
change, SharePoint access, or anything that conflicts with `CLAUDE.md`.
