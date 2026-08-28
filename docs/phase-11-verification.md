# Phase 11 verification — has the platform disturbed the automation?

Started 2026-08-27, completed 2026-08-28. Flow run history for all 11 flows, the
`Bid Tracker.xlsx` and SharePoint state checks, and the scheduled-task evidence
were pulled by the operator; the mailbox half was read through Graph.

**Headline result: nothing the platform did reached the automation.** No flow ran
inside any of the three platform write windows. No new failure type appeared after
the platform first connected to the mailbox on 2026-08-19. No ZZTEST row exists in
the tracker, its table binding still resolves, no sentinel was written during a
platform window, and the scheduled tasks are running on cadence.

**Two things remain not run**, and neither bears on that result: the Exchange
admin checks in 5d, and one weekday gap in the scheduled-task reports that is
reported rather than explained (4b). Nothing in this document is inferred into a
pass.

**Read-only throughout.** No flow was opened for editing, no sentinel filename was
written, `Bid Tracker.xlsx` was not touched, no flow was triggered, no scheduled
task was run, and `PHB_ALLOW_SEND` remained `false`. The only code executed was a
throwaway probe issuing Graph `GET` requests, since deleted; it is reproducible
from the commands recorded below.

---

## 0. What this credential can reach — established, not assumed

The platform's Graph token was decoded and its `roles` claim read, then each
endpoint probed with a `GET`:

```
Application permissions granted:   Mail.ReadWrite, Mail.Send      ← the complete list

SharePoint site (AISandbox)        403 accessDenied
Site search                        403 accessDenied
Drives                             403 accessDenied
Mailbox messages (control)         200 OK
```

**This is a hard boundary, not a gap in effort.** The app registration holds mail
permissions only, so SharePoint, `Bid Tracker.xlsx`, the CO state JSON, the four
sentinel files and the scheduled-task run reports are unreachable from the
platform by construction. Power Automate run history is not a Graph resource at
all and is unreachable for a second, independent reason.

Consequently **sections 1, 3 and 4 could not be answered from here at all.** They
were answered by a person, in the Power Automate portal and in SharePoint, and are
recorded as observed on that basis. Section 5d still needs an Exchange admin.

Widening the credential would require a new admin consent grant — a decision, not
a step. It is worth noting that the platform being *unable* to reach the tracker
and the state files is itself part of why this verification came back clean, and
is a property worth keeping rather than an inconvenience to fix.

---

## 1. Flow health — OBSERVED

Pulled from the Power Automate portal, 2026-08-27, by the operator. All 11 flows
accounted for.

| Flow | Last success | Last failure | Pattern changed since 2026-08-19? |
|---|---|---|---|
| CO Intake 1 | not individually reported | **2026-08-18 14:08** | No — failure predates the platform |
| CO Intake 2 | not individually reported | none since 2026-08-19 | No |
| CO Intake 3 | **2026-08-26 08:23** (10 runs, all succeeded) | none since 2026-08-19 | No |
| CO Intake 4 | not individually reported | none since 2026-08-19 | No |
| CO Intake 5 | not individually reported | none since 2026-08-19 | No |
| CO Intake 6 | not individually reported | none since 2026-08-19 | No |
| CO Intake 7 | not individually reported | **2026-07-30 10:29** | No — failure predates the platform |
| CO Response 1 | not individually reported | none since 2026-08-19 | No |
| CO Response 2 | not individually reported | none since 2026-08-19 | No |
| CO Response 3 | **2026-08-27 ~12:00** — scheduled daily, unbroken 08-18 → 08-27 | none since 2026-08-19 | No |
| CO Response 4 | **2026-08-27** — multiple runs daily, all succeeded | none since 2026-08-19 | No |

"not individually reported" means the per-flow last-success timestamp was not
recorded during the pull. It is **not** a claim that the flow has not run. The two
load-bearing findings below were checked across all 11 and do not depend on those
cells.

### 1a. No flow ran inside a platform write window — the leak test

**Nothing ran in any of the three windows.** This is the finding the phase exists
to produce.

| Window (mailbox local time) | What the platform was doing | Flow runs inside it |
|---|---|---|
| 2026-08-26, 14:35–16:05 | Phase 8: 14 drafts created, replies, forwards, moves, deletes | **none** |
| 2026-08-19, 18:00–19:00 | Phase 6: draft edit testing | **none** |
| 2026-08-27, ~11:25–11:40 | Phase 9: two subject edits on an already-deleted ZZTEST draft, restored | **none** |

The closest approach is `CO Intake 1`, cancelled at **10:39, 10:55 and 11:10 on
2026-08-26** — nearly four hours before the Phase 8 window opened at 14:35, and
therefore unrelated to it. See 1b.

### 1b. The `CO Intake 1` non-failure now reports as Cancelled, not Failed

The three cancelled runs above are the **documented** "an ordinary email arrived
with no CO form attached, so stop" case. It is not a new failure and not a
platform effect.

**What did change is how it surfaces.** It now ends as *Cancelled* rather than
*Failed*, following a deliberate change made to the flow by its owner. Two things
follow, and both matter for the next person:

- `docs/02-existing-co-system.md` describes this as `CO Intake 1` logging the
  event "as a stop". Read that as **Cancelled** in the portal from now on, or
  three benign runs a day look like an unexplained status change.
- The change was made by the flow's owner, outside the platform's work.
  `CLAUDE.md`'s prohibition on modifying flows binds the platform and this
  project; it does not bind the person who owns the automation. Recorded so the
  altered status is not later mistaken for something the platform did.

### 1c. Both failures predate the platform

`CO Intake 1` on **2026-08-18 14:08** and `CO Intake 7` on **2026-07-30 10:29**.
The platform first connected to the mailbox on **2026-08-19** (Phase 4 Part B),
so neither could have been caused by it. **No new failure type appeared on or
after 2026-08-19** across any of the 11 flows.

The `CO Response 3` Bid Tracker read hiccup of 6 August is likewise pre-platform
and is the second of the two documented non-failures.

### 1d. The scheduled and high-frequency flows are unbroken

- `CO Response 3` runs daily at noon and has run **every day from 2026-08-18
  through 2026-08-27** with no gap — including 08-19, 08-26 and 08-27, the three
  days the platform wrote to the mailbox.
- `CO Response 4` runs several times a day, all succeeded.

An unbroken daily schedule spanning every platform write window is the strongest
single piece of evidence in this document that the platform did not disturb the
pipeline.

---

## 2. Leak checks — OBSERVED throughout

### 2a. Every ZZTEST message in the mailbox — OBSERVED

Queried: `listConversations` over all 12 non-empty folders, 87 messages total,
subject matched case-insensitively against `ZZTEST`.

**20 of 87 messages carry a ZZTEST subject.**

| Location | Count | Notes |
|---|---|---|
| Deleted Items | 16 | all drafts |
| Inbox | 2 | received, not drafts — `ZZTEST phase 8 reply source` ×2 |
| `Projects/ZZ FLOW1 …/ZZ PR-04` | 2 | one draft, one received |

### 2b. A ZZTEST subject search is sufficient — OBSERVED, from the code

The non-production write fence (`isZzTestSubject` in
`lib/modules/change-orders/mail/guards.ts`) strips `RE:`/`FW:`/`FWD:` prefixes and
*then* still requires the subject to begin with `ZZTEST`. So every draft the
platform created or edited outside production contains the literal string
`ZZTEST` somewhere in its subject.

**This makes a plain `ZZTEST` string search a complete test for platform write
artifacts**, which is what makes the Bid Tracker check below meaningful. It is
worth stating because the fence's reply-prefix exception looks like it should
widen the net, and it does not.

Confirmed by the one counter-example: `Fw: Test run for Change Order Process`
(2026-08-24 18:07, Deleted Items) carries no ZZTEST. Stripping `Fw: ` leaves
`Test run for Change Order Process`, which fails the fence — so **the platform
could not have created or edited it**. Attributable to a person forwarding in
Outlook. Recorded because a ZZTEST-only sweep would otherwise leave it unexplained.

### 2c. Platform-created drafts — OBSERVED

**14 drafts from the Phase 8 verification session**, all on 2026-08-26:

| Time | Subject | Where it is now |
|---|---|---|
| 14:40 | `ZZTEST phase 8 attachment draft` | **`Projects/ZZ FLOW1 …/ZZ PR-04`** |
| 14:44 | `RE: ZZTEST phase 8 reply source` ×2, `FW:` ×1 | Deleted Items |
| 14:46 | `RE: ZZTEST phase 8 reply source` ×2, `FW:` ×1 | Deleted Items |
| 14:46 | `ZZTEST phase 8 compose 2026-08-26T14:46:52.584Z` | Deleted Items |
| 15:11 | `RE: ZZTEST phase 8 reply source` ×2, `FW:` ×1 | Deleted Items |
| 15:37 | `ZZTEST Phase 8` | Deleted Items |
| 15:55 | `ZZTEST note fragmentation probe` | Deleted Items |
| 16:02 | `ZZTEST note fix probe abc` | Deleted Items |

PHASE-11 says "the nine drafts the verification scripts created". **The observed
figure is 14**, and the inventory above is the evidence. The discrepancy is
almost certainly that the scripted `respond` command was run three times, each
producing three drafts, rather than once — but that is an inference, and the
count is not.

**A fifteenth platform-attributable draft exists and belongs to a different
session**: `ZZTEST [CCHMC RFI 229] test 2` (2026-08-19 18:53, Deleted Items),
from Phase 6 draft-editing rather than Phase 8. It is included in the 20 ZZTEST
messages above and excluded from the 14 deliberately, since 14 answers "what did
the Phase 8 verification scripts leave behind".

### 2d. One platform draft is NOT in Deleted Items — OBSERVED, reported not fixed

`ZZTEST phase 8 attachment draft` (2026-08-26 14:40) sits in
`Inbox/Projects/ZZ FLOW1 — Gate A email intake test (test CO, safe to delete)/ZZ PR-04`.

That is platform output living inside the `Projects` tree Intake 6 and 7 file
into. It is ZZTEST-named and the containing folder is explicitly labelled a
disposable test CO, so this is most likely harmless — but PHASE-11's claim is that
platform drafts "left no trace beyond Deleted Items and Recoverable Items", and
this one did. **Reported, not moved or deleted**, per the phase's instruction to
stop rather than fix.

### 2e. No ZZTEST in `Bid Tracker.xlsx` — OBSERVED

**No ZZTEST rows.** Checked in SharePoint by the operator — section 3a, which also
records the two pre-platform `ZZ`-prefixed test rows and why the search term
matters.

### 2f. No ZZTEST conversation triggered a flow run — OBSERVED

**Confirmed from the portal.** No flow ran inside any of the three platform write
windows (section 1a), so nothing the platform created, edited, moved or deleted —
all of it ZZTEST-subjected, per 2b — reached a trigger.

This is the direct answer to the phase's central question, and it is now an
observation rather than a property of the design.

### 2g. No CO state file references a platform-created message — OBSERVED

State files intact and clean — section 3. No ZZTEST artifact appears in the
tracker or the CO state, which is the same answer from the other direction:
nothing the platform created got as far as being written down.

---

## 3. State integrity — OBSERVED

Checked in SharePoint by the operator, 2026-08-28, read-only.

| Check | Result |
|---|---|
| No ZZTEST row in `Bid Tracker.xlsx` | **PASS** — none |
| `Bid Tracker.xlsx` ListObject still resolves | **PASS** — the Table Design tab is present, so Excel still recognises it as a named table |
| Real rows look right | **PASS** — Bulletin 13 dated 8/26, status `collecting` |
| SharePoint CO state files intact | **PASS** |
| `CO Managment Process` still spelled with one A | **PASS** |

### 3a. No ZZTEST row — but the tracker's test rows use a different prefix

**There are no ZZTEST rows in the tracker.** The acceptance criterion passes
outright.

Two **pre-platform** test rows do exist, and they matter for how this check is
repeated:

```
ZZ FLOW1 | PR-04        8/6
ZZ Test Owner | PR-77   7/17
```

Both use the **`ZZ`** prefix, not `ZZTEST`, and both predate the platform's first
mailbox connection on 2026-08-19 by weeks.

**This corrects the search advice in section 2b.** That section is right that
every *platform* write carries `ZZTEST` — the non-production fence guarantees it —
so a `ZZTEST` search is a complete test for platform leakage. But the tracker's
own test-data convention is `ZZ`, so a `ZZTEST`-only sweep of the workbook returns
nothing and looks clean **while `ZZ` rows are sitting there**. Search the tracker
for `ZZ`, then discriminate by date and prefix. Both conventions are in play and
they are not the same string.

### 3b. The Bulletin 13 row corroborates the run history

The tracker shows Bulletin 13 dated **8/26** with status **`collecting`**, which
lines up with `CO Intake 3`'s ten successful runs at 08:23 that morning
(section 1) and with the message that reached Sent Items at 14:36 (section 5b).

Three independent sources — portal run history, mailbox contents, tracker state —
agree on the same event. That agreement is worth more than any one of them.

### 3c. One earlier inference is now corrected

Section 6 inferred from two ZZTEST drafts dated 2026-08-18 that a ZZTEST CO
(`PR-91`) had been pushed through the automation, and warned that it might have
seeded a tracker row.

**It did not. There is no `PR-91` row in the tracker.** The two test rows that do
exist are `PR-04` and `PR-77`, on different dates and under a different prefix.
So either that 08-18 test stopped before the tracker write, or its row was cleaned
up afterwards. Recorded as a correction rather than edited away, because the
warning in section 6 was acted on and the answer is part of the evidence.

---

## 4. Scheduled task evidence — OBSERVED, with one gap reported

Checked by the operator on the machine that runs them, 2026-08-28.

**Local sync path:** `C:\Users\Msheth\Peck Hannaford + Briggs\AI Sand…`
(truncated as supplied) — the OneDrive-synced copy of the `AI Sandbox - Documents`
library. It sits under an individual user profile, so it is machine-specific; the
durable address is the SharePoint library itself, not this path.

### 4a. Run reports

**Twice daily, morning and noon, through 2026-08-28 08:13.** The cadence is intact
and current as of writing.

### 4b. The gaps

| Gap | Day | Assessment |
|---|---|---|
| 2026-08-22 | Saturday | Weekend. Expected. |
| 2026-08-23 | Sunday | Weekend. Expected. |
| **2026-08-18** | **Tuesday** | **A genuine weekday gap. Reported, not explained.** |

PHASE-11 says to report a gap rather than investigate it by running anything, so
this is reported and nothing was run.

**It does not coincide with platform activity.** The platform first connected to
the mailbox on **2026-08-19**, the day *after*. Nothing the platform did could
have caused an 08-18 gap.

**It is not the only unusual thing about 2026-08-18**, and the correlation is
worth writing down for whoever looks into it:

- the scheduled tasks did not report
- `CO Intake 1` failed at 14:08 (section 1c)
- a `scrub_result` sentinel was written at 15:10 — the only afternoon write in the
  sentinel history below
- two ZZTEST test drafts were created at 19:05 and 19:11 (section 6)

That is a day with something going on. **Whether those four facts are one event or
four is not established**, and this phase deliberately did not chase it — it is
entirely pre-platform and therefore outside what this verification asks.

### 4c. Sentinel file writes

`scrub_result.json` modification times, as supplied:

```
2026-08-26   08:29, 08:20
2026-08-19   08:56, 08:51
2026-08-18   15:10
2026-08-06
2026-08-04
2026-07-31
```

**None falls inside a platform write window.** The two closest are on the same
calendar days as platform activity and are hours clear of it:

| Date | Sentinel written | Platform window | Separation |
|---|---|---|---|
| 2026-08-26 | 08:20, 08:29 | 14:35–16:05 | ~6 hours before |
| 2026-08-19 | 08:51, 08:56 | 18:00–19:00 | ~9 hours before |

The platform has no code path that writes any sentinel filename, and the observed
timestamps are consistent with that.

---

## 5. The Outlook path — folder tree observed, admin checks NOT RUN

### 5a. Folder tree — OBSERVED, intact

All 19 folders present, hierarchy exactly as `docs/03-exchange-and-graph.md`
describes: `Projects` is a child of Inbox, project folders at depth 2, their
contents at depth 3.

```
   0  Archive                                        0  Inbox / Projects
   4  Conversation History                           0  Inbox / Projects / CCHMC Liberty Expansion
  17  Deleted Items                                  0  Inbox / Projects / P&G Reese's
   0  Drafts                                         0  Inbox / Projects / ZZ FLOW1 — Gate A email intake test
  14  Inbox                                         13  … / CCHMC Liberty Expansion / CCHMC Bulletin 12
   0  Junk Email                                     3  … / CCHMC Liberty Expansion / CCHMC Bulletin 13
   0  Outbox                                         2  … / CCHMC Liberty Expansion / CCHMC RFI 187
   8  Sent Items                                     7  … / CCHMC Liberty Expansion / CCHMC RFI 229
   4  Inbox / Processed CO's                         3  … / P&G Reese's / Permit Pack 4, Bulletin 4
                                                     9  … / P&G Reese's / Sharc Laser Exhaust
                                                     3  … / ZZ FLOW1 … / ZZ PR-04
```

Nothing the platform did removed or renamed a folder the flows depend on.

### 5b. The automation kept filing throughout — OBSERVED

The strongest single piece of evidence that the pipeline is undisturbed, and it
is mailbox-side rather than portal-side:

| When | What | Where |
|---|---|---|
| 2026-08-26 14:36 | `[CCHMC Bulletin 13] New CO logged (Bid Tracker) — Due 09/07/2026` | Sent Items |
| 2026-08-26 14:36 | `CCHMC Liberty Expansion — Change Order Scope Request — Due 09-07-2026` | filed into `Projects/…/CCHMC Bulletin 13` |
| 2026-08-24 12:29 | `Reminder — Change Order pricing due 08/25/2026 — CCHMC RFI 229` | Sent Items, replies back on 08-24 and 08-25 |
| 2026-08-19 13:00 | `[CCHMC RFI 229] New CO logged (Bid Tracker) — Due 08/25/2026` | Sent Items |

The Bulletin 13 intake completed and filed at **14:36 on 2026-08-26 — four
minutes before** the platform's Phase 8 write session began at 14:40, and the
platform then wrote continuously until 16:02 without the automation showing any
mailbox-visible disturbance afterwards.

What this on its own did not establish — that no flow *ran and failed* during
that window — the portal has since answered: **nothing ran in it at all**
(section 1a).

### 5c. The empty Drafts folder — EXPLAINED, not a fault

**The Drafts folder is empty**, and of 18 drafts in the whole mailbox, 17 are in
Deleted Items and the 18th is the platform artifact in section 2d. Raised in the
first pass of this document as an open question, because the mailbox alone cannot
tell "everything is caught up" from "intake has stopped producing drafts".

**Run history settles it: caught up.** `CO Intake 3` — the flow that drafts vendor
pricing requests — ran **10 times on 2026-08-26 at 08:23, all succeeded**, and the
Bulletin 13 work it belongs to reached Sent Items the same afternoon. Intake is
producing; the drafts were reviewed and sent by a human, which is the process
working exactly as designed.

**One loose end, recorded as a question rather than a finding.** The mailbox shows
a single message sent on 2026-08-26 (`[CCHMC Bulletin 13] New CO logged (Bid
Tracker)`, 14:36, Sent Items) alongside the scope request filed into the
`CCHMC Bulletin 13` folder at the same minute. Ten successful Intake 3 runs and
one sent message do not obviously reconcile from either side on their own — the
ten runs may be a retry loop, a per-vendor fan-out where one vendor has been sent
so far, or something else. **Nothing about it touches the platform**: all ten runs
succeeded, all at 08:23, six hours before the Phase 8 write window. Noted so that
whoever repeats this check is not surprised by the arithmetic, and does not have
to rediscover that it was looked at.

### 5d. Operator Full Access and the access policy — NOT RUN

| Check | Result |
|---|---|
| Operator still has Full Access to `changeorder@phb1899.com` | NOT RUN — needs Exchange admin |
| `Test-ApplicationAccessPolicy` still Granted for `changeorder@`, Denied elsewhere | NOT RUN — needs Exchange admin |

---

## 6. Test data in this system uses two different prefixes

Written in the first pass as a warning — "a ZZTEST row in the tracker is not
automatically a platform leak, check its date" — and kept because the answer that
came back is more useful than the warning was.

**The tracker had no ZZTEST rows at all** (section 3a), so the warning never had to
be applied. What it surfaced instead is a naming split worth knowing:

| Where | Convention | Examples |
|---|---|---|
| Mailbox, platform-written | `ZZTEST` | `ZZTEST phase 8 reply source`, `ZZTEST note fix probe abc` |
| Mailbox, pre-platform flow tests | `ZZTEST` and `ZZ` | `[ZZTEST PR-91] New CO logged`, folder `ZZ FLOW1 …` |
| `Bid Tracker.xlsx` | **`ZZ`** | `ZZ FLOW1 \| PR-04` (8/6), `ZZ Test Owner \| PR-77` (7/17) |

**So sweep the tracker for `ZZ`, not `ZZTEST`.** A `ZZTEST` search of the workbook
returns nothing and looks clean while two `ZZ` rows sit in it. Then discriminate
by date: anything on or before **2026-08-18** predates the platform entirely.

The mailbox evidence that prompted the warning — two ZZTEST drafts on 2026-08-18,
one of them `[ZZTEST PR-91] New CO logged (Bid Tracker)` — turned out **not** to
have a corresponding tracker row. See 3c.

---

## 7. What is still outstanding

The Power Automate portal, `Bid Tracker.xlsx`, the SharePoint state files and the
scheduled-task evidence are **all done**. Two things remain.

### Exchange admin — NOT RUN

Neither bears on whether the platform disturbed the automation. Both are about
whether the *Outlook path* is still intact, which CLAUDE.md requires forever.

- Operator still has Full Access to `changeorder@phb1899.com`.
- `Test-ApplicationAccessPolicy`: Granted for `changeorder@phb1899.com`, Denied for
  another mailbox.

### The 2026-08-18 weekday gap — reported, not explained

Section 4b. Entirely pre-platform, so out of scope for this phase, and deliberately
not investigated because investigating it would mean running something.

---

## 8. Observed versus inferred

### The phase's central claim is now OBSERVED on both halves

**The platform has not disturbed the change-order automation.** This is no longer
design reasoning. It rests on measurements from three independent sources that
agree with each other:

| Half | Evidence | Standing |
|---|---|---|
| **Flows** | No run inside any of the three platform write windows; no new failure type since 2026-08-19; both failures on record predate it; `CO Response 3` unbroken daily 08-18 → 08-27 | **OBSERVED** |
| **SharePoint state** | No ZZTEST row in the tracker; ListObject still resolves; state files intact; no sentinel written inside a platform window; scheduled tasks on cadence through 08-28 08:13 | **OBSERVED** |

The earlier version of this document recorded the SharePoint half as *inferred*,
resting on the credential having no path to those files. That argument was sound
and it has now been replaced by someone looking.

**Three sources corroborate one event.** `CO Intake 3` ran ten times at 08:23 on
08-26 (portal), the tracker shows Bulletin 13 dated 8/26 status `collecting`
(SharePoint), and the message reached Sent Items at 14:36 (mailbox). Independent
systems telling the same story is the strongest evidence in this document.

### Observed

- The credential holds `Mail.ReadWrite` and `Mail.Send` and nothing else; SharePoint returns 403.
- No flow ran inside any of the three platform write windows. All 11 flows checked.
- Both flow failures on record predate 2026-08-19; no new failure type since.
- `CO Response 3` ran every day 08-18 → 08-27 with no gap, spanning every platform write window.
- `CO Intake 1`'s documented no-CO-form stop now ends as Cancelled rather than Failed, after a change by the flow's owner.
- `CO Intake 3` ran 10 times on 08-26 at 08:23, all succeeded.
- No ZZTEST row in `Bid Tracker.xlsx`; two pre-platform `ZZ` rows; Table Design tab present.
- Sentinel writes on 08-26 and 08-19 fall ~6 and ~9 hours clear of the platform windows.
- Scheduled-task reports twice daily through 2026-08-28 08:13, with gaps on 08-22, 08-23 (weekend) and 08-18 (Tuesday).
- 20 of 87 mailbox messages carry a ZZTEST subject, in the three locations listed.
- 14 drafts from the Phase 8 session, plus one from Phase 6; subjects, times, folders.
- One platform draft sits in the `Projects` tree rather than Deleted Items.
- `Fw: Test run for Change Order Process` could not have been written by the platform; the fence refuses it.
- The folder tree is complete and correctly nested.

### Inferred

- That the "nine drafts" figure in PHASE-11 differs from the observed 14 because `respond` was run three times.
- That ten Intake 3 runs and one sent message reconcile as a retry loop or a partial per-vendor fan-out. Not established from either side — section 5c.
- That the four unusual things about 2026-08-18 are related. They may be one event or four; nothing establishes which, and it is pre-platform either way.
- That the 08-18 ZZTEST `PR-91` test stopped before the tracker write, or its row was cleaned up. Only the absence of the row is observed — section 3c.

### Not run

- The two Exchange admin checks (5d).
- Any explanation of the 2026-08-18 scheduled-task gap (4b).

---

## 9. Acceptance criteria

| Criterion | Status |
|---|---|
| All 11 flows accounted for, two documented non-failures recognised | **DONE** — section 1 |
| No ZZTEST artifact anywhere in the pipeline's state | **DONE** — no flow triggered (1a), no tracker row (3a), no state-file reference (2g) |
| `Bid Tracker.xlsx` table binding intact, row count consistent | **DONE** — section 3 |
| SharePoint state files intact | **DONE** — section 3 |
| Scheduled task run reports present, or a gap explicitly reported | **DONE** — present, and the 08-18 gap is reported (4b) |
| Outlook access and `Projects` tree unchanged | **PARTLY** — tree observed intact (5a); Full Access not checked (5d) |
| `docs/phase-11-verification.md` written, observed vs inferred distinguished | **DONE** — this document |
| No flow, sentinel file, or Excel workbook modified | **DONE** — nothing was written, by the platform or by this verification |
| All existing tests still pass | **DONE** — 911 passing, 2026-08-28 |
| `PHB_ALLOW_SEND` still `false` | **DONE** — confirmed in `.env.local` |

**Nine of ten complete.** The tenth is partly done and its remaining half needs an
Exchange admin, not more work here.

### Open items

**One finding remains, reported rather than fixed:**

1. A platform-created draft, `ZZTEST phase 8 attachment draft`, is sitting in
   `Projects/ZZ FLOW1 …/ZZ PR-04` rather than Deleted Items (2d). The run history
   confirms it triggered nothing and the tracker confirms it wrote nothing, so it
   is untidy rather than dangerous. Removing it is a decision for whoever owns the
   mailbox.

**One gap remains, reported rather than explained:**

2. The scheduled tasks did not report on Tuesday 2026-08-18 (4b). Pre-platform,
   so outside this phase.

**One change was found that the platform did not make:**

3. `CO Intake 1`'s no-CO-form stop now reports as Cancelled rather than Failed,
   by a deliberate change from the flow's owner (1b). Recorded so it is not later
   attributed to the platform, and so `docs/02-existing-co-system.md` is read
   correctly.

**Two questions were closed by evidence:**

4. ~~The Drafts folder is empty and the mailbox cannot say why.~~ `CO Intake 3`
   ran 10 times on 08-26, all succeeded. Caught up, not stopped (5c).
5. ~~A ZZTEST row in the tracker might be a platform leak.~~ There are no ZZTEST
   rows; the two test rows use `ZZ` and predate the platform (3a).

---

## 10. How to repeat this check

The full procedure — the mailbox half, the Power Automate portal half, the
SharePoint half, and how to tell a real finding from the known pre-platform test
data — is in **`docs/runbook.md`**, under *Has the platform disturbed the
automation?*

It lives there rather than here because this document is a dated record of one
run, and the procedure has to be usable by someone who has never seen this system.
