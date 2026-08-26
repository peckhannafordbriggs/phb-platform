# Phase 8 — live mailbox verification record

Run against `changeorder@phb1899.com` on 2026-08-26 with
`scripts/co-verify-phase8.ts`. `PHB_ALLOW_SEND` was `false` for the entire run and
was never changed: **nothing in Phase 8 sends**, so the send gate was never
involved. The script has no send path in it.

Fixtures, both created by the operator in Outlook:

| | What | Where |
|---|---|---|
| 1 | `ZZTEST phase 8 reply source` — from `msheth@phb1899.com`, Cc `msheth@phb1899.com`, one PDF attached (`Cost Intelligence System (1).pdf`) | Inbox |
| 2 | `ZZTEST phase 8 attachment draft` — one PDF attached (`JACE Discovery Checklist Rev 2.pdf`) | Drafts |

---

## What Exchange actually did

### Reply, reply-all, forward — all pass

`createReply`, `createReplyAll` and `createForward`, each with an empty `{}` POST
body.

| Claim | Observed |
|---|---|
| Conversation threading intact | **Pass, all three.** Every derived draft carried `conversationId` `AAQkADE0…gz0=`, identical to the source. This is the one that matters — Intake 6 matches replies by conversation ID. |
| Quoting present | **Pass.** 2,935-byte bodies against a source that was a few lines; Exchange wrote the quoted original. 13 editable text segments, so the Phase 6 editor has something to work with. |
| Derived subject inside the ZZTEST fence | **Pass.** `RE: ZZTEST phase 8 reply source` and `FW: …`. This is the prefix-skipping change earning its place — without it every one of these drafts would have been uneditable. |
| Forward carries the original attachments | **Pass, by content.** See the `size` finding below. |

**Reply-all recipients: not conclusively verified, and the fixture is why.** The
source was From `msheth@phb1899.com`, To `changeorder@`, Cc `msheth@phb1899.com`.
Exchange correctly deduplicated, so reply-all produced To `msheth@phb1899.com`,
Cc empty — *identical to plain reply*. The result is right, but it does not
distinguish reply from reply-all. Proving that needs a source whose Cc is a
different person from the sender. **Outstanding.**

### Compose from scratch — pass

An empty draft came back with `body` of 0 bytes, no segments, `bodyFormat` html.
Appending a paragraph into that genuinely-empty body worked, and a subsequent
splice edit replaced the text rather than duplicating it.

Worth knowing: Exchange **normalises the fragment on write**. `appendParagraph`
on an empty body has no `</body>` to insert before, so it appends
`<p>…</p>` bare; the next read returns
`<html><head><meta …charset=utf-8></head><body><p>…</p></body></html>`. So the
first append produces a fragment and every append after it inserts before a real
`</body>`. Both paths were exercised.

### Move — pass, with an important condition

Moved fixture 1 Inbox → `Projects / CCHMC Liberty Expansion / CCHMC RFI 229` →
`Processed CO's` → back to Inbox.

**With an immutable id the id survives exactly**: `idChanged: false`, and the id
still resolved afterwards with the new `parentFolderId`. That is PHASE-8's claim,
confirmed.

**With an id from `$search` it does not** — see finding 2.

### Delete — pass, after a fix

Verified on both a draft and a received message. See finding 1: the first
implementation was wrong and was changed.

### Attachments — pass

| Claim | Observed |
|---|---|
| Download matches the original byte for byte | **Pass.** `Cost Intelligence System (1).pdf` downloaded as 337,145 bytes, SHA-256 `64ec4ee8d9018e462f8c8aa3614c316ff0a34e95d13e09cfe51aa8eab46659e4` — identical to the file on disk. |
| Existing attachment survives an add | **Pass.** Fixture 2 went 1 → 2 attachments; the original's id was byte-identical before and after, and its content hash unchanged. |
| Others survive a remove | **Pass.** Back to 1 attachment, original still hashing the same. |
| Simple upload under 3 MB | **Pass.** 250,000-byte file, round-tripped to an identical SHA-256. |
| `createUploadSession` at or above 3 MB | **Pass.** 4,194,304-byte file in two chunks (3,276,800 + 917,504), PUT to the pre-authenticated URL with no `Authorization` header, round-tripped to an identical SHA-256. |

---

## Three things the docs had wrong

Every Graph phase so far has found defects a mocked transport agreed with. This
phase found three, and two of them were in the specification rather than the code.

### 1. `DELETE /messages/{id}` does not put a message in Deleted Items

`docs/03` and `PHASE-8.md` both said it did. It does not.

Observed, on a draft and again on a received message: after `DELETE`, the
message's `parentFolderId` resolved to a folder named **`Deletions`** holding 209
items — Recoverable Items \ Deletions, the dumpster. The user-visible **Deleted
Items** folder held 4 items and never saw the message.

The message is still recoverable, and still addressable by the same immutable id,
so nothing was destroyed. But recovery is via Outlook's *Recover Deleted Items
from Server* dialog rather than by opening a folder and dragging — a materially
worse experience, bounded by the deleted-item retention window, and not what the
confirmation dialog promised.

**Fixed by changing the code, not the wording.** `deleteMessage` now issues
`POST /messages/{id}/move  { "destinationId": "deleteditems" }`. Re-verified: the
message lands in the real Deleted Items folder, id unchanged. That is strictly
*more* recoverable than `DELETE`, and it makes the UI copy true. Softening the
promise instead would have made a reversible action feel irreversible in a
mailbox a daily process runs through.

### 2. `$search` ignores `Prefer: IdType="ImmutableId"`

The header was on the wire — asserted at the transport — and `$search` returned
standard ids anyway.

Same message, same folder, both requests carrying the header:

```
listMessages    AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A…TPFR8QAA   immutable
searchMessages  AAMkADE0NjQyNmExLTYzMTEtNGYwYS04Mj…M8YDjAAA=   standard
```

Stripping the header from `listMessages` produced the `AAMkAD…` form, which is
how the two were told apart: the header **is** working, on everything except
`$search`.

A standard id is folder-scoped and changes on a move. So the first move attempt —
using an id the survey had obtained by search — reported `idChanged: true` and the
old id then 404'd. The move itself was correct; the message was where it should
be, and `moveMessage` returned the right new immutable id.

**A GET cannot translate one id form to the other.** Asking for a message by its
standard id returns that same standard id: Graph echoes back whichever form
addressed the resource. Only a collection request yields an immutable id.

**Not currently breaking anything**, because the reading pane clears after a move
and treats a stale id as "no longer here". But it violates the invariant in
`docs/03` and it is a latent hazard. See `docs/runbook.md` for the two candidate
fixes; choosing between them is a product decision, because the cheap one
(`$filter contains(subject,…)`) narrows search from full-text to subject-only.

### 3. An attachment's `size` is not its content length

`size` carries per-attachment storage overhead, and the overhead is not preserved
across a copy:

| | Reported `size` | Actual content |
|---|---|---|
| On the received message | 337,527 | 337,145 |
| On the forward of it | 337,532 | 337,145 |
| Fixture 2's PDF | 162,651 | 162,371 |

The content was byte-identical in every case. The verification script originally
asserted `size` equality — both for "the download is complete" and for "the
forward carries the same attachment" — and failed on a 5-byte difference that
meant nothing. Both checks now compare **content hashes**, and the size check is a
bound rather than an equality.

Nothing in the application depended on this; `size` is only ever displayed.

---

## Still outstanding

- **Reply-all recipients.** Needs a source message whose Cc is somebody other
  than the sender. The fixture's Cc was the sender, so Exchange deduplicated and
  reply-all was indistinguishable from reply.
- **The `$search` id decision.** Finding 2. Nothing is broken today; the fix is a
  product choice.
- **A browser pass over the UI.** Everything above went through the service, which
  is where every rule is enforced — but the folder picker, the delete dialog, the
  compose prompt and the attachment panel have not been clicked through by a
  person.
