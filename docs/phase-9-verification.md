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
| **Not run, deliberately** | The send direction — it needed `PHB_ALLOW_SEND=true`, which production did not have until 2026-10-14. Re-checked against the mailbox and the production logs on 2026-10-14: still not run — § 6 |
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

This was the number that decided Part B. **It decided against it** — see
`docs/PHASE-9.md`, *Part B — evaluated and DECLINED*.

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
part.** Propagation is sub-second. The entire user-visible delay was the
platform's own poll interval.

**Acted on.** `POLL_INTERVAL_MS` went from 60 seconds to **20** — 180 requests an
hour per focused tab, 30 per 10-minute window, 0.3% of the ~10,000-per-10-minutes
budget Exchange allows per app per mailbox. Part B was declined on the strength of
this measurement; see `docs/PHASE-9.md` for the reasoning and the conditions that
would reopen it.

### Not measured — needs a person in Outlook

| Direction | Latency | Status |
|---|---|---|
| draft created in Outlook → appears in the platform | — | not run |
| draft edited in the platform → updated in Outlook | — | not run (Outlook side) |
| message moved in Outlook → reflected in the platform | — | not run |
| message deleted in Outlook → reflected in the platform | — | not run |
| draft sent from the platform → in Sent Items in Outlook | — | **not run** from production as of 2026-10-14 — checked, not assumed; § 6. The one platform send on record is Phase 6's, 2026-08-19, from development |
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
- [ ] Leave `PHB_ALLOW_SEND` at `false` **in development**. Production has been
      `true` since 2026-10-14 (`runbook.md` → *The send gate is open,
      deliberately*).
- [ ] Fill the send row from production: one draft, `ZZTEST` subject, addressed
      to the operator's own address and nobody else, sent from the deployed
      platform by the operator. Record the `sentDateTime` Exchange stamps on the
      Sent Items copy and the `mail.sent` audit row at `/admin/audit`. Until
      then the row stays as § 6 leaves it.

---

## 6. The send row, re-checked on 2026-10-14

**Why this section exists.** The production send gate was opened on 2026-10-14 on
the strength of a test send the platform owner recalled from 29 September: a
`ZZTEST` draft sent to themselves from the deployed platform, which arrived and
appeared in Sent Items. The owner asked for the exact timestamp to be read from
the mailbox rather than taken from memory. This section is what that check found.
Observed facts first; what is inferred from them is marked as such.

**What was searched, and what was there.** All times are UTC; subtract four hours
for Cincinnati.

| Source | Looked for | Found |
|---|---|---|
| `changeorder@` Sent Items, whole folder | any `ZZTEST` subject; anything 27 Sep – 2 Oct | 10 messages in the folder, all change-order traffic. No `ZZTEST` subject at any date. Nothing dated 27 Sep – 1 Oct; one message on 2 Oct, a `[CCHMC RFI 250] New CO logged` notice at 16:05:32 |
| `changeorder@`, every folder | any `ZZTEST` subject | three, all from August: the two `ZZTEST phase 8 reply source` messages of 26 Aug, and `ZZTEST [CCHMC RFI 229] test — edited 18:01:22`, sent 2026-08-19 **18:17:45** from `changeorder@` to the operator, body *Edited by the platform at 2026-08-19T18:01:22.396Z* — the Phase 6 send, from development, now filed in a project folder |
| `changeorder@`, every folder | everything 28 Sep – 30 Sep | two items. **`TEST `** — sent 2026-09-28 **17:51:29** as `changeorder@`, to Karthik, cc the operator, body *This is a test email for the Live Platform. Please ignore … Thanks, Mahi Sheth*; not a draft; **not in Sent Items**, in a folder the connector could not resolve by id. **`Test email`** — an unsent draft, no recipients, 2026-09-30 14:40:36, same folder |
| the operator's own mailbox, every folder | any `ZZTEST`; anything from `changeorder@` since 1 Sep; the `TEST ` message | no `ZZTEST` after 26 Aug; nothing from `changeorder@` since 1 Sep; no copy of `TEST ` although it was cc'd there. (Search-index results; a deleted or purged copy would read the same) |
| production console logs, 14 Sep 13:03 → 14 Oct, 3,152 lines | every `mail.*` event | exactly two: `mail.send_blocked` / `sendDraft` / *PHB_ALLOW_SEND is not true* at 2026-09-28 **17:00:50** and at 2026-10-02 **16:05:28**. Nothing else |
| Azure activity log, 26 Sep → 2 Oct | any write to the container app | none between 26 Sep and 1 Oct 18:15; every write on 1–2 Oct is the CI deploy principal, whose `az containerapp update --image` keeps env vars |

A successful send writes an audit row (`mail.sent`), not a log line, so silence
in the logs alone would prove nothing. The gate value does: it was `false` on
both sides of 29 September with no write to the app in between, and the service
refuses before any Graph call when it is.

**What this says (observed).** No send from the deployed platform has ever
succeeded, on 29 September or any other day in the log window. The platform
refused the two sends that were attempted. No `ZZTEST` message was sent from the
mailbox after 26 August. The only platform send that exists in the mailbox is the
Phase 6 one of 19 August, made from development under the `ZZTEST` fence.

**What probably happened (inferred, from timing only).** On 28 September the
platform refused a send at 17:00:50; the *PHB Internal Platform now Live*
announcement went to staff at 17:14; and at 17:51 `TEST ` left the mailbox as
`changeorder@`, signed by the operator. Its subject would fail the development
fence and production had just refused, so it was sent from another client —
most likely Outlook, where the operator has Full Access to the mailbox. On
2 October the platform refused again at 16:05:28, and four seconds later a real
change-order notice left the mailbox: someone tried the platform for a real send
and finished in Outlook. The 29 September memory most likely refers to the
28 September `TEST ` message, which was not a platform send and was not `ZZTEST`.

**The one check that would overturn this.** `/admin/audit` on production,
filtered to action `mail.sent`. That row is the only durable record of a platform
send, and this check could not reach the production database. If a `mail.sent`
row exists for 29 September, this section is wrong and the row above should be
filled from it; if none exists, the first production send is still ahead and
should be the supervised `ZZTEST` one described in § 5.

**What this changes.** Nothing about the gate's mechanics: it is open in
production by the owner's decision, and every send is still one human sending one
draft they have read. What it changes is the record — the gate was opened before,
not after, the first verified production send — and that is written in
`runbook.md` → *The send gate is open, deliberately* so the next person does not
inherit a verification that did not happen.
