# Phase 9 verification — Part A

Against the live `changeorder@phb1899.com` mailbox, 2026-08-27.

Re-run with `scripts/co-verify-phase9.ts`. It contains no call to `sendDraft`,
never reads or sets `PHB_ALLOW_SEND`, and every write it makes is fenced to a
`ZZTEST` subject and restored afterwards.

`PHB_ALLOW_SEND` was `false` before this work, throughout it, and after it.
Nothing in Phase 9 sent a message.

---

## What was verified, and what was not

| | |
|---|---|
| Verified live | Conversation grouping over the whole mailbox; grouped-vs-flat equivalence; grouping cost; concurrent-edit detection; platform-write propagation |
| **Not run** | The four sync directions that need a person acting in Outlook |
| **Not run, deliberately** | The send direction — it needs `PHB_ALLOW_SEND=true` |
| **Not run, prohibited** | The flow-filing direction — flows must not be triggered or modified |

The four Outlook-driven rows below are unfilled because nobody drove them, not
because they failed. `scripts/co-verify-phase9.ts watch` is the instrument for
them and is described at the bottom.

---

## 1. Conversation grouping

`npx tsx scripts/co-verify-phase9.ts survey`

```
12 folders hold messages.
Folders containing a real thread (>1 message): 6
Longest conversation found: 7 messages
Grouped and flat listings agree everywhere. Grouping loses nothing.
```

**Grouping loses nothing.** For all 12 folders the survey read the folder twice —
once grouped, once flat and paged — and compared the message-id sets. They were
equal in every folder. This is the check that matters: a group that quietly drops
or duplicates a message would look tidier on screen, not broken.

**The mailbox is genuinely thread-heavy where it matters.** Sent Items is 8
messages in 8 conversations, so it renders as an ordinary flat list. The project
folders are the opposite — `CCHMC Bulletin 12` is 13 messages in 4 conversations,
`CCHMC RFI 229` is 7 in 2, `Sharc Laser Exhaust` is 9 in 4.

### The finding that justifies grouping on `conversationId` rather than subject

`CCHMC Bulletin 12` contains **two different conversations with a byte-identical
subject**:

```
RE: CCHMC Liberty Expansion — Change Order Scope Request — Due 08-11-2026
  conversationId AAQk…AHcoEcU5y8FHr_WeTEv1zng=   7 messages, 08-04 → 08-17
  participants: changeorder · Brandon Parker · Horvath, Brian

RE: CCHMC Liberty Expansion — Change Order Scope Request — Due 08-11-2026
  conversationId AAQk…ADKTXXwiLfdLkdbBoawVZiE=   4 messages, 07-30 → 08-11
  participants: Joel Schriner · Josh Bittner · Erich Knemeyer
```

Two vendors answering the same scope request start two threads with the same
subject. Grouping on subject would have merged 11 messages into one thread with
one false count and a participant list that mixes two unrelated conversations.
`conversationId` separates them correctly. This is not hypothetical tidiness —
it is the largest folder in the mailbox.

### Other observed behaviour

- **Immutable ids survive the grouped read.** Every id returned by
  `listConversations` begins `AAkALg…`, the immutable form. Grouping is built on
  `listMessages`, so it inherits the `Prefer: IdType="ImmutableId"` header rather
  than needing its own.
- **Drafts really do thread with the message they answer.** A conversation in
  Deleted Items holds three `RE:`/`FW:` drafts derived from one
  `ZZTEST phase 8 reply source`, all sharing its `conversationId`; another holds
  six. This is exactly the case that made "a draft inside a collapsed group must
  stay visible" a requirement rather than a nicety.
- **A draft can have no participants at all.** An unsent compose with no
  recipients yet reports neither `from` nor `to`, so the row has nobody to name.
  The pane says "Unknown participants" rather than rendering an empty line.
- **Display names arrive in `Last, First` form.** `Horvath, Brian` is real. The
  participant list is therefore joined with ` · ` and not with a comma, which
  would have read as four people where there are two.
- **Nothing truncated.** The largest folder holds 17 messages against a cap of
  500, so every grouped read in this mailbox is a single Graph request and the
  truncation banner has never yet had cause to appear.

### Cost

Median of 5 reads each, same session:

| Folder | flat (`$top=25`) | grouped |
|---|---|---|
| Inbox (14 items) | 220 ms | 196 ms |
| CCHMC Bulletin 12 (13) | 201 ms | 219 ms |
| Deleted Items (17) | 216 ms | 211 ms |

**Grouping is free at this mailbox size.** Both paths are one Graph request,
because every folder fits inside one page. The collect-to-a-cap design only
starts costing more when a folder exceeds 100 messages, and it is bounded at 5
requests.

---

## 2. Concurrent editing

`npx tsx scripts/co-verify-phase9.ts conflict <draftId>`

```
Draft: ZZTEST note fragmentation probe
changeKey held by the "editor": CQAAABYAAAAw0UboecHAQpVDzCJqvqKuAABNDuK1
changeKey after the outside edit:  CQAAABYAAAAw0UboecHAQpVDzCJqvqKuAABND+Zx

REFUSED with kind=conflict, as designed. The outside edit survives.
Subject restored to: ZZTEST note fragmentation probe
```

Two things confirmed against Exchange rather than assumed:

1. **A write changes the `changeKey`.** The whole detection scheme rests on this
   and nothing in the docs had checked it. It changed on a subject-only PATCH.
2. **A save carrying a stale `changeKey` is refused**, with `kind=conflict`, and
   the outside edit survives. The editor does not overwrite it.

The Outlook half — a person editing the same draft in Outlook — was **not run**.
The mechanism is identical: Outlook has never heard of our editor, so its write
is exactly the unconditional write this command performs. What a human still has
to confirm is that the banner appears and reads sensibly.

**Where the editor now notices it.** Previously a conflict surfaced only when a
save failed. The lock-refresh poll already re-reads the draft every 45 s, so it
now compares the `changeKey` on that read and raises the banner while somebody is
still typing rather than after they finish. Saving and sending are both blocked
until they reload, and the reload button says plainly when reloading will discard
unsaved changes.

**Lock TTL.** 90 s TTL, refreshed every 45 s — half, so one lost refresh (a
dropped request, a throttle, a sleeping laptop) still leaves a whole interval
before the lock lapses under an active editor. Pinned by a test in
`tests/draft-locks.test.ts` rather than left as a comment, because the two numbers
only work as a pair.

---

## 3. Sync latency

This is the number that decides whether Part B is worth building.

### Measured: platform write → visible in a folder listing

`npx tsx scripts/co-verify-phase9.ts propagate <draftId>`, three runs:

```
PATCH + re-read returned in 414ms.   Visible in the folder LISTING after 207ms (1 listing read).
PATCH + re-read returned in 380ms.   Visible in the folder LISTING after 228ms (1 listing read).
PATCH + re-read returned in 375ms.   Visible in the folder LISTING after 209ms (1 listing read).
```

The listing is polled every 250 ms and the change was present on the **first**
read every time, so 207–228 ms is an upper bound on Exchange's propagation, not a
measurement of it. The real figure is somewhere below one poll interval.

This distinction is worth keeping: re-reading the message you just wrote proves
nothing, because `updateDraft` re-reads it anyway and that read is served
consistently. The pane lists the folder, which is a different index. It is that
index this measures.

**Conclusion, and it is the important one for Part B: Exchange is not the slow
part.** Propagation is sub-second. The entire user-visible delay is the
platform's own 60-second poll interval. If 60 seconds turns out to be too long,
the cheap lever is the poll interval — not a subscription lifecycle, a renewal
job, a validation endpoint and dropped-notification reconciliation.

### Not measured — needs a person in Outlook

| Direction | Latency | Status |
|---|---|---|
| draft created in Outlook → appears in the platform | — | not run |
| draft edited in the platform → updated in Outlook | — | not run (Outlook side) |
| message moved in Outlook → reflected in the platform | — | not run |
| message deleted in Outlook → reflected in the platform | — | not run |
| draft sent from the platform → in Sent Items in Outlook | — | **not run**: needs `PHB_ALLOW_SEND=true` |
| message filed by a flow → reflected in the platform | — | **not run**: flows must not be triggered |

To fill the first four:

```
npx tsx scripts/co-verify-phase9.ts watch <folderId> <needle> appear|vanish
```

It polls every 2 s so what it reports is Exchange's propagation rather than the
platform's UI interval, and it says so in its own output. `survey` prints the
`folderId` of every folder. Use a `ZZTEST` subject as the needle.

The send row should be filled only during a deliberate, supervised send test,
with the draft addressed to the operator's own address and never to a vendor, and
with `PHB_ALLOW_SEND` returned to `false` immediately afterwards.

---

## 4. Resilience

Verified by test rather than against the live mailbox, because provoking a real
throttle on a shared production mailbox is not a reasonable thing to do:

- **Throttling** — `tests/mail-retry-notice.test.ts` drives the real middleware
  chain onto a stubbed 429 with `Retry-After`, and checks the retry is captured,
  attributed to the right request when two run concurrently, and still reported
  when the retry itself fails. The pane says "the mailbox was busy, that took an
  extra Ns" afterwards, and "still loading — the mailbox may be busy" during any
  request over 2.5 s. It cannot be streamed: the retry happens inside the single
  HTTP request the browser made.
- **Failed poll** — the poll is quiet, so a failure leaves the list and the
  editor exactly as they are. A *successful* poll used to be the bigger problem
  in flat mode: it re-reads page one, silently discarding every older page
  somebody had loaded. It now skips while extra pages are loaded, the same way it
  already skips during a search.
- **Failed "load older"** — no longer replaces the pane with an error state,
  which threw away every message already loaded in order to report a failure. The
  error appears beside the button, which becomes "Try again".
- **Failed autosave still blocks the send.** `canSend` requires
  `save.status !== "failed"`, and now also that the draft has not changed
  underneath the editor.
- **Credential expiry** — `mail_auth_failed` and `mail_access_denied` render the
  same whole-module "Not connected to the mailbox" state as
  `mail_not_configured`, naming Outlook as the working path. Not a crash, and not
  a Graph error string.
- **Stale ids** — `not_found` has its own state on every surface: "That is no
  longer in the mailbox", with the way back rather than a retry that cannot work.

---

## 5. What a person still has to do

- [ ] Open a real vendor thread in the platform and confirm it expands to the
      right messages. `CCHMC Bulletin 12` is the interesting one — it must show
      **two** threads with the same subject, 7 messages and 4, not one of eleven.
- [ ] Confirm an unsent draft reply stays visible in a collapsed group.
- [ ] Edit the same `ZZTEST` draft in Outlook and in the platform, and confirm
      the conflict banner appears and offers the reload.
- [ ] Fill the four Outlook rows in the latency table with `watch`.
- [ ] Leave `PHB_ALLOW_SEND` at `false`.
