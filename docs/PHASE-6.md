# Phase 6 — Drafts: Review, Edit, Send

Read `CLAUDE.md`, `docs/03-exchange-and-graph.md`, and `docs/02-existing-co-system.md`
first. Those define **how**, and override anything here on architecture.

This is the first phase that writes to the real mailbox and the first that can send email
to people outside the company. Treat it accordingly.

---

## Goal

An employee with the `change-orders` grant can open a draft the automation created,
review it, edit it if needed, and send it. The sent message appears in
`changeorder@phb1899.com` Sent Items, indistinguishable from one sent through Outlook.

This is the actual daily job of the Change Order process and the highest-value part of
the platform.

---

## The safety model — read this before writing any code

Every outbound message in the change-order system is created as an **unsent draft** and
sent by a human who has read it. `sendMail` appears **zero times** across all 11 Power
Automate flows. That is deliberate, and it is the only thing standing between an AI
draft and a vendor's inbox.

**Never build:**

- Auto-send of any kind
- Bulk send, send-all, or multi-select send
- A scheduled or deferred send
- "Send and next" that advances before the send confirms
- Any path where a single action sends more than one message

One human, one draft, one deliberate action, having seen the content. If a requirement
seems to need otherwise, stop and ask.

---

## Priority order

1. Open a draft in an editable state
2. Edit recipients, subject, body — with autosave
3. Send, with confirmation
4. Verify in Sent Items
5. Conflict handling and locking

---

## Requirements

### Editing

`PATCH /users/{mailbox}/messages/{id}` through the mail service. Never construct Graph
calls outside it.

- To, Cc, Bcc, subject, body
- Autosave on a debounce, with a visible saved/saving/failed indicator. A silent failed
  save on a message someone is about to send is the worst outcome in this phase
- Preserve existing attachments untouched — do not read, rewrite, or reattach them
- Preserve the subject tag. The real formats are `[CCHMC RFI 229] ...`,
  `[CCHMC Bulletin 12] ...`, and some messages carry no tag. Do not parse, normalize, or
  regenerate them; downstream filing depends on the exact string
- Editing is only permitted on messages where `isDraft` is true. Refuse anything else in
  the service, not the UI

### Sending

```
POST /users/{mailbox}/messages/{id}/send
```

**Never `sendMail` with a copied body.** That loses the attachments Power Automate
attached, the subject tag, and conversation threading — all three matter to flows that
run afterward.

- Flush any pending autosave and confirm it succeeded **before** sending. Sending a
  draft whose last edit didn't persist sends the wrong content
- A confirmation step showing the actual recipient list. Not a generic "are you sure" —
  show who this is about to go to
- Disable the send control while in flight. Double-sending is not recoverable
- After a successful send the draft no longer exists. Clear the pane, refresh the list,
  and say clearly that it went
- Write an audit event: who sent, draft id, recipients, subject, timestamp. Under
  app-only auth Exchange records the app rather than the person, so **this audit row is
  the only record of who sent it**

### The guards

Both already exist in the service. This is the phase that exercises them.

- `PHB_ALLOW_SEND` must be `true` or a send throws. It stays **`false` in development and
  false in production** until sending has been verified end to end
- Outside production, writes are permitted only on messages whose subject begins with
  `ZZTEST`, and the subject is read from Exchange rather than taken from the caller

Do not weaken, bypass, or add an override to either. Development testing happens on
`ZZTEST` drafts you create in Outlook.

### Conflict handling

Outlook and the platform can edit the same draft, and the operator has the mailbox open
in Outlook. Last write wins — Graph offers no useful concurrency control here.

- Take an advisory lock in the platform database, keyed on the message's immutable id,
  with a short expiry so a closed tab doesn't lock a draft forever
- Show when a draft is being edited elsewhere in the platform
- Detect that a draft changed underneath you and say so rather than silently overwriting
- Accept that Outlook can still win. Tell the user; don't pretend to prevent it

### Errors that will actually happen

- The draft was sent or deleted from Outlook while open — `not_found`, handled as a
  normal event
- A stale immutable id after Power Automate moved something
- Autosave failed and the user clicks send
- Send failed after the draft was already gone
- Throttling mid-edit
- Credential expired

None of these should surface a Graph error string.

---

## Out of scope

- Compose from scratch, reply, reply-all, forward
- Adding or removing attachments
- Moving or deleting messages
- Attachment content download
- Rich-text editing beyond what the existing body format needs
- CO context panel
- Graph subscriptions, delta queries, any mailbox table
- SharePoint, Power Automate, Claude API

---

## Hard constraints

- **Never persist** message bodies, attachment content, or mailbox state. The advisory
  lock table stores an id, a holder, and an expiry — nothing about the message.
- **No `sendMail`.** The existing test that fails if it appears anywhere in the module
  must still pass.
- **Do not touch** the 11 flows, the four sentinel filenames, or `Bid Tracker.xlsx`.
- All 308 existing tests must still pass.
- The service remains the only thing that talks to Graph.

---

## Acceptance criteria

**Automated**

- [ ] Build, typecheck, lint clean; all 308 existing tests still pass
- [ ] Send throws with `PHB_ALLOW_SEND` unset or false
- [ ] Outside production, a write to a non-`ZZTEST` subject throws, with the subject read
      from Exchange
- [ ] `sendMail` appears nowhere in the module
- [ ] Editing a non-draft message is refused in the service
- [ ] A pending autosave is flushed and confirmed before a send proceeds
- [ ] A failed autosave blocks the send
- [ ] The send control cannot be triggered twice
- [ ] Sending writes an audit event with sender, recipients, and subject
- [ ] Unauthenticated → 401; no grant → 404, on every new route
- [ ] Advisory locks expire and do not strand a draft
- [ ] Subject tags survive an edit byte-for-byte

**Manual, against the live mailbox**

- [ ] Create a `ZZTEST` draft in Outlook; it appears in the platform
- [ ] Edit body, subject, and recipients in the platform; the changes appear in Outlook
- [ ] An existing attachment survives an edit
- [ ] With `PHB_ALLOW_SEND=true`, send a `ZZTEST` draft to yourself only
- [ ] It arrives, and appears in `changeorder@` Sent Items in Outlook
- [ ] The subject tag and threading are intact in the sent copy
- [ ] Delete a draft in Outlook while it's open in the platform — clean handling
- [ ] Set `PHB_ALLOW_SEND` back to `false` afterward

---

## Notes for the implementer

**Verify against the live mailbox, not fixtures.** Phases 4 and 5 each turned up defects
that mocked transports agreed with — `wellKnownName`, the folder depth, `$skip` versus
`$skiptoken`. Writes have more surface than reads.

**Test sends go to yourself, never to a vendor.** Every manual send in this phase uses a
`ZZTEST` draft addressed only to your own address.

**The audit row is the only record of who sent a message.** Treat it as the deliverable
it is, not as logging.

**Stop and ask** before anything that sends more than one message per human action,
weakens either guard, needs a new table beyond the lock, or conflicts with `CLAUDE.md`.
