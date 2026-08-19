# Phase 5 — Read-Only Change Order Mailbox

Read `CLAUDE.md`, `docs/03-exchange-and-graph.md`, and `docs/02-existing-co-system.md`
first. Those define **how**, and override anything here on architecture.

`PHASE-4.md` built the mail service and verified it against the live mailbox. This phase
puts a UI on it.

---

## Goal

An employee with the `change-orders` grant can open the Change Orders tab and read the
real `changeorder@phb1899.com` mailbox — browse folders, scan a message list, open a
message, see who it's from and what's attached.

**Read-only.** No compose, no reply, no edit, no send, no move, no delete. Those are
Phase 6. Nothing in this phase may call a write operation, and the existing test that
fails if a write method appears on the service must still pass.

---

## Priority order

Build in this order. If time runs short, stopping after step 3 still ships something
useful, because the daily job is the Drafts loop and Outlook covers the rest.

1. **Drafts** — list and open. The daily job.
2. **Sent Items** — list and open, so a send can be confirmed.
3. **Message read** — recipients, subject, body, dates, attachment names.
4. **Inbox.**
5. **Folder tree**, including the nested Projects hierarchy.
6. **Pagination** — loading older messages.
7. **Search.**

---

## What Phase 4 learned about the real mailbox

Do not design against assumptions the live mailbox already disproved:

- **19 folders**, not the handful the well-known names suggest. `Projects` is a **child
  of Inbox**, so project folders sit at depth 2 and their contents at depth 3. A tree
  that stops at depth 1 shows `Projects` as empty rather than truncated — it looks
  correct and is wrong.
- **`wellKnownName` does not exist in Graph v1.0.** Folder identity comes from resolving
  the documented aliases. Never add it to a `$select`.
- **Subject tags are not `[CO: Owner|Bulletin]`.** The real formats are
  `[CCHMC RFI 229] ...`, `[CCHMC Bulletin 12] ...`, and some messages carry **no tag at
  all**. Anything that keys on a subject pattern must tolerate all three. `docs/03` has
  the verified formats.
- **Stale message IDs are ordinary.** Power Automate moves messages constantly, so a
  list can go stale between render and click. Graph returns
  `400 ErrorInvalidIdMalformed`, which the service already maps to `not_found`. The UI
  must handle it gracefully — a message that vanished is a normal event, not an error
  page.

---

## Layout

Three panes inside the platform shell, which already has its own sidebar:

```
┌──────────┬────────────┬──────────────┬──────────────────┐
│ Platform │ Mail       │ Message list │ Reading pane     │
│ sidebar  │ folders    │              │                  │
│          │            │  Subject     │  From / To       │
│ Home     │ Inbox      │  Sender      │  Date            │
│ Change   │  Projects ▸│  Date        │  Body            │
│  Orders  │ Drafts     │              │  Attachments     │
│ Admin    │ Sent Items │              │                  │
│          │ Deleted    │              │                  │
└──────────┴────────────┴──────────────┴──────────────────┘
```

Not a pixel requirement. Optimize for the real workflow: open Drafts, read a draft the
automation produced, decide whether it's ready.

Default the folder selection to **Drafts**, not Inbox. That's the job.

Design for real data, not placeholder data. Subjects are long and repetitive
(`[CCHMC Bulletin 12] Change Order Request — Additional Information Needed`), so
truncation and hierarchy matter more than they would with short fake subjects.

---

## Requirements

### Rendering the body

The service already returns sanitized HTML. Render it in a **sandboxed iframe with a
restrictive CSP**, and block remote images by default with an explicit "show images"
affordance. Vendor email is attacker-controlled — sanitization and sandboxing are
layers, not alternatives.

Handle plain-text bodies, empty bodies, and inline `cid:` images that have no
attachment resolution yet (Phase 6 territory — degrade visibly rather than breaking
layout).

### States

Every pane needs all four, and they will all occur in practice:

- **Loading** — skeletons, not spinners that shift layout
- **Empty** — the Drafts folder is genuinely empty most of the day. That state should
  read as "nothing to review," not as a failure
- **Error** — mapped from the service's typed errors. Never show a Graph error string.
  A missing credential must say the module isn't configured, not crash
- **Not found** — a message that moved or was sent by someone else. Clear the reading
  pane, refresh the list, no error page

### Polling

No Graph subscriptions or webhooks. Poll the selected folder on an interval **only
while the tab is focused**, and stop when it isn't. Keep it gentle — throttling
concentrates on one mailbox through one app identity.

### Search

`$search` behaves differently from `$filter`: it doesn't support `$orderby`, and result
ordering is by relevance. Scope it to the selected folder for this phase; cross-folder
search is a later concern.

### Service additions

Extend `lib/modules/change-orders/mail/service.ts` — do not bypass it. Route handlers
and components construct no Graph URLs, see no tokens, and never handle a raw Graph
response. Any new method needs the same treatment as Phase 4's: typed errors,
`Prefer: IdType="ImmutableId"`, mailbox not overridable by a caller.

### Authorization

Every route under `app/api/modules/change-orders/*` goes through the existing guard.
The page itself needs a server-side grant check too — hiding a sidebar item is not
authorization.

---

## Out of scope

- Any write: compose, reply, reply-all, forward, draft edit, send, move, delete
- Attachment **content** download (names and sizes only in this phase)
- Graph change notifications, subscriptions, delta queries
- Any message, folder, or delta-token table. **Nothing about the mailbox is persisted.**
- CO context panel — linking a draft to its run report or Q&A log
- SharePoint access, and do not request `Sites.Selected`
- Power Automate or Claude API

---

## Hard constraints

- **Never persist** message bodies, attachment content, or mailbox state. If a table
  holding mailbox data seems necessary, stop and ask.
- **No write operations of any kind**, including `sendMail`.
- **Do not touch** the 11 Power Automate flows, the four sentinel filenames, or
  `Bid Tracker.xlsx`.
- The 256 existing tests must still pass. Nothing here should require changes to
  `lib/auth`, `lib/authz`, or the schema. If it does, stop and ask.
- Development guards stay in force: writes outside production restricted to `ZZTEST`
  subjects, `PHB_ALLOW_SEND` required for sends. Neither should be exercised in this
  phase.

---

## Acceptance criteria

- [ ] `npm run build`, `npx tsc --noEmit`, `npx eslint .` clean; all 256 existing tests
      still pass
- [ ] Drafts is the default folder on opening the tab
- [ ] The full folder tree renders, including `Projects` and its children at depth 2
      and 3 — verified against the live mailbox, not fixtures
- [ ] A real message opens: sender, recipients, date, sanitized body, attachment names
- [ ] Body renders in a sandboxed iframe; remote images blocked by default
- [ ] Hostile HTML fixtures render inert — no script execution, no layout escape
- [ ] Empty Drafts shows an empty state, not an error
- [ ] A stale message ID shows a clean "no longer here" state and refreshes the list
- [ ] Missing Graph credential shows a "not configured" state; the app still boots and
      the admin screen still works
- [ ] Unauthenticated request to any mail route → 401; authenticated without the grant
      → 404; direct navigation to `/change-orders` without the grant does not render
- [ ] Polling stops when the tab loses focus
- [ ] Pagination loads older messages in a folder with more than one page
- [ ] Search returns results within the selected folder
- [ ] No write method exists on the service — the existing guard test still passes
- [ ] No new table stores mailbox data
- [ ] Runbook entries for: credential expired, throttled by Graph, folder tree
      truncated, message not found on open

---

## Notes for the implementer

**Verify against the live mailbox, not fixtures.** Phase 4 proved that mocked
transports miss the defects that matter. Fixtures are right for the hostile-HTML tests
and the error mapping; the folder tree and message rendering need the real thing.

**The empty state is not an edge case.** Drafts is empty most of the day. It's the first
thing the primary user sees, and it needs to read as normal.

**Stop and ask** if a task appears to need a write operation, a new table, SharePoint
access, a significant new dependency, or anything conflicting with `CLAUDE.md`.
