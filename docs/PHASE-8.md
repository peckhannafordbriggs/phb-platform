# Phase 8 — Full Email Actions

Read `CLAUDE.md`, `docs/03-exchange-and-graph.md`, and `docs/02-existing-co-system.md`
first. Those define **how**, and override anything here on architecture.

Phases 4–6 built the mail service, the read-only mailbox, and draft edit/send. This phase
adds the rest of a working mail client.

---

## Goal

An employee with the `change-orders` grant can do their normal change-order email work
entirely in the platform: write a new message, reply, forward, manage attachments, file
messages into folders, and delete.

Every operation goes to the real Exchange mailbox. Nothing is stored locally.

---

## The safety model still applies

Nothing in this phase weakens it. Read the send rules in `CLAUDE.md` again before
starting.

- Every send is one human, one message, one deliberate action, having seen the content
- **No bulk send, send-all, multi-select send, "send and next", or scheduled send**
- `PHB_ALLOW_SEND` and the `ZZTEST` fence apply to every new write, not just drafts
- Compose and reply create **drafts first**, then send from the draft — same path Phase 6
  built. There is no direct compose-and-send

The last point matters: it means every outbound message exists as a reviewable draft
before it goes, including ones a human wrote from scratch.

---

## Priority order

1. **Reply, reply-all, forward** — the most common actions after reviewing a draft
2. **Move** between folders
3. **Delete**
4. **Attachments** — add and remove, and download existing ones
5. **Compose from scratch** — least used, since most messages originate from the
   automation

---

## Requirements

### Reply, reply-all, forward

Use Graph's own operations, not string assembly:

```
POST /messages/{id}/createReply
POST /messages/{id}/createReplyAll
POST /messages/{id}/createForward
```

Each returns a real Exchange draft with quoting, threading, and the `In-Reply-To` and
`References` headers correct. Building a reply by concatenating the original body into a
new message loses conversation threading, and Intake 6 matches replies by conversation
ID — so a broken thread breaks the automation's filing.

Once created, the draft flows into the **existing Phase 6 editor**. Do not build a second
editing surface. The same splice-based body editing, the same autosave, the same
confirmation dialog, the same audit row.

For forward, the original attachments come along by default. Verify that rather than
assuming it.

### Compose from scratch

`POST /users/{mailbox}/messages` creates an empty draft, which then opens in the Phase 6
editor. No separate compose window with its own send button.

An empty body has no text segments to splice, so the editor needs a sensible starting
state — this is the case the "add a paragraph" affordance was built for. Check it works
from genuinely empty.

### Move

```
POST /messages/{id}/move   { destinationId }
```

The message gets a **new ID** unless immutable IDs are in use — they are, on every
request, so the ID survives. Verify that against the live mailbox rather than trusting it.

A folder picker over the existing tree, including the nested Projects hierarchy. Moving
into `Projects` or a project subfolder is the realistic case, since that's where the
automation files things.

### Delete

```
DELETE /messages/{id}
```

This moves the message to Deleted Items. It is recoverable.

> **Corrected during verification.** It does not. Against the live mailbox `DELETE`
> puts the message in Recoverable Items \ Deletions, not in Deleted Items. The
> platform issues `move` to `deleteditems` instead, which does what this paragraph
> intended. See `docs/phase-8-verification.md`.

**Never expose `permanentDelete`.** Not behind a confirmation, not in an admin screen,
nowhere. There is no legitimate need for it here and it destroys the audit trail.

Confirm before deleting, and say plainly that it goes to Deleted Items rather than
implying permanence.

### Attachments

**Download existing** — stream through the backend from Graph. Never persist to disk or
database. Set a correct content type and a safe filename; do not let an attachment name
drive a filesystem path.

**Add** — simple upload under 3 MB, `createUploadSession` above that. Enforce a size
limit and reject executable content types.

**Remove** — only from a draft, never from a sent or received message.

A draft the automation created already carries attachments that downstream flows expect.
Removing one is a legitimate human decision, but adding or removing must not disturb the
others. Verify an existing attachment survives when a second is added.

### Errors that will happen

- Moving into a folder that was deleted or renamed in Outlook
- Deleting a message someone already deleted
- Replying to a message that's since been moved
- An attachment over the size limit
- Throttling during an attachment upload
- A stale ID after Power Automate filed something

None of these should surface a Graph error string, and none should look like a crash.

---

## Out of scope

- Graph change notifications, subscriptions, delta queries — that's Phase 9
- Any message, folder, or delta-token table
- Permanent delete, of anything
- Rules, categories, flags, read/unread bulk operations
- Calendar, contacts, tasks
- CO context panel
- SharePoint, Power Automate, Claude API

---

## Hard constraints

- **Never persist** message bodies, attachment content, or mailbox state. The draft lock
  table stays as it is — id, holder, expiry, nothing else.
- **No `sendMail`.** Every send is `POST /messages/{id}/send` on an existing draft. The
  test that fails if `sendMail` appears anywhere in the module must still pass.
- **The service write-method allowlist must be updated deliberately.** Phase 6 turned the
  "no writes exist" test into an allowlist precisely so a new way of changing the mailbox
  has to be named in a test before shipping. Name each one.
- **Do not touch** the 11 flows, the four sentinel filenames, or `Bid Tracker.xlsx`.
- All 416 existing tests must still pass.
- The service remains the only thing that talks to Graph.

---

## Acceptance criteria

**Automated**

- [ ] Build, typecheck, lint clean; all 416 existing tests still pass
- [ ] Every new write is named in the service allowlist test
- [ ] `sendMail` appears nowhere in the module
- [ ] `permanentDelete` appears nowhere in the module
- [ ] Every new write respects `PHB_ALLOW_SEND` and the `ZZTEST` fence, with the subject
      read from Exchange
- [ ] No method can send more than one message per call
- [ ] Attachment removal is refused on a non-draft
- [ ] Oversized and executable attachments are rejected
- [ ] Attachment filenames cannot escape into a filesystem path
- [ ] Unauthenticated → 401, no grant → 404, on every new route
- [ ] Move and delete write audit events

**Manual, against the live mailbox — all on `ZZTEST` drafts and messages**

- [ ] Reply to a real message: quoting present, conversation threading intact in Outlook
- [ ] Reply-all includes the right recipients
- [ ] Forward carries the original attachments
- [ ] A composed-from-scratch draft opens in the editor and can be edited
- [ ] Move a `ZZTEST` message into a Projects subfolder; it appears there in Outlook and
      the ID still resolves afterward
- [ ] Delete a `ZZTEST` message; it appears in Deleted Items in Outlook
- [ ] Download an attachment; the file matches the original byte-for-byte
- [ ] Add an attachment to a `ZZTEST` draft; the existing one survives
- [ ] Remove an attachment; the others survive
- [ ] `PHB_ALLOW_SEND` back to `false` afterward

---

## Notes for the implementer

**Verify against the live mailbox.** Every Graph phase so far found defects that mocked
transports agreed with — `wellKnownName`, folder depth, `$skip` versus `$skiptoken`,
Exchange rewriting U+00A0, `<td><p>` in pasted cells. Writes have more surface than
reads, and this phase adds five new kinds.

**Reuse the Phase 6 editor for everything.** Reply, forward, and compose all produce
drafts. A second editing surface would mean a second place the splice logic, the
autosave, and the send confirmation could drift.

**Threading is load-bearing.** Intake 6 matches replies by conversation ID. A reply that
breaks the thread breaks the automation's filing, silently, and nobody notices until a
message doesn't get filed.

**Stop and ask** before anything that sends more than one message per human action,
weakens either guard, adds a table holding mailbox data, exposes permanent delete, or
conflicts with `CLAUDE.md`.
