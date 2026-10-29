# Phase 12 Part E — the shadow run: plan

**Status: PLAN, written 2026-10-29, awaiting the owner's approval. Nothing
in it is built.** Parts A–D are complete (`docs/phase-12-part-d-verification.md`
→ *Part D is complete. What Part E inherits*). Phase 13 is not started.

Read first: `docs/PHASE-12.md` → *Part E*, `docs/phase-12-part-e-equivalence.md`
(the bar, written before any comparison ran, including the two named
divergences), `docs/PHASE-13.md`, `docs/PHASE-14.md`, and the Part C and
Part D verification records. Everything here is tagged the inventory's way:
**[observed]** was measured or read, **[inferred]** is reasoning,
**[decision]** is a choice this plan makes or asks the owner to make.

What Part E is, in the roadmap's words: for weeks, the cloud engine and
classifier run against a copy on a schedule while the laptop keeps running
the real process; outputs are compared automatically; the laptop is right
until proven otherwise; nothing is tuned to match; every difference is
investigated. Phase 12 is complete when the container has produced
equivalent output for a sustained period and the disagreements are
understood — *not when it runs*.

---

## 0 · The hard rules this plan is written under

1. **The laptop stays untouched throughout.** No edit to either scheduled
   task, the SharePoint spec, the live prompt or the cron. The laptop's two
   tasks are retired in Phase 14 and not before (`docs/PHASE-14.md` 3.3).
2. **Nothing the shadow does can write, move or rename anything live.** The
   engine's identity holds Write on the whole AI Sandbox site, so this
   cannot rest on that identity being careful. § 2 makes it incapacity.
3. **No sentinel is ever written where a flow watches.** The four names are
   written by the shadow only where Part C and Part D already write them: in
   the scratch copy, a sibling top-level folder outside every watched folder
   (`docs/phase-12-part-c-plan.md` → *Before cutover: the flow-trigger
   decision*, *What the eleven watch*). `classification_result.json` is
   doubly load-bearing — a trigger and the live classifier's "already read"
   marker — and § 6 holds it to the copy.
4. **Never two instances against live.** The container's store refuses
   `CO Managment Process` by name at construction and at every call; the
   reader identity cannot write; the laptop remains the one writer.
5. **The bar is not relaxed during the window.** A disagreement that turns
   out to be the bar's fault is fixed in a commit that says so, and the count
   restarts for the judgment it touches (equivalence doc, preamble).

---

## 1 · What the window measures, and what is already in hand

The equivalence doc's first finding reshapes Part E: the intake engine is
deterministic, so its bar is *identity after normalization*, and that bar
has been met on the eight fixture COs through both stores (Part C, five
runs, eight of eight). The classifier is the only judgment, and its bar is
semantic, judgment by judgment; Part D met it on the laptop's twenty
captured answers, three runs out of three, with every decline matched and
no STOP row ever.

So the window is **not** the first time either half is compared. What live
traffic adds, and only live traffic can add:

- **new inputs the fixtures do not hold** — new vendors, new COs, new
  project numbers, whatever the next month brings;
- **the cloud path end to end on a schedule** — the Graph store, the
  federated identity, the job, the image, the Key Vault reference, with
  nobody's laptop in the loop, which nothing in Part D exercised (the job
  spec has never run in Azure: D6 *What D6 does not prove*);
- **the rare paths** — the ones `docs/PHASE-12.md` names, if they occur;
- **the laptop's own cadence**, which the inventory could only infer from
  report filenames (§ 5: morning runs drifting up to +2h19m, weekdays with
  no morning report). The collector in § 3 sees every laptop run land.

**Volume, observed 2026-10-29 on the synced copy, names and dates only.**
[observed]

| | |
|---|---|
| Classifier items with a result, by month received | July 5 · August 6 · September 0 · October 8 (one undated) — 20 in all since the Option C migration |
| Queue folders today | `_to_classify` 4 (the pre-fix backlog, every one already read) · `_processed` 12 · `_needs_review` 1 · `_archive` 8 |
| Intake: COs in `1 - New Requests` | 5 folders; 3 `intake_*.json` dated October |

That is about **two classifier items a week and one intake CO a week** in
October. A four-week window at that rate is roughly eight classifier items
and four COs. § 8 is written for that number, not for the volume the
engine's own fixture set implies.

---

## 2 · Question 1 — feeding the copy, read-only by construction

### 2a · The identity: a fourth app registration, with Read and nothing else

The engine's app (`phb-co-engine`) holds `Sites.Selected` with **Write on
the whole AI Sandbox site**, which contains the live tree. Keeping a feeder
off the live tree with that identity would be configuration, and every guard
in this project is incapacity. So the feeder does not use that identity.
**[decision]**

| | |
|---|---|
| Registration | `phb-co-engine-reader`, owner an M365 group, no credential, a federated identity credential naming the platform's production identity — the same shape as the other three apps |
| Permission | `Files.SelectedOperations.Selected` (application), the Needs Review app's pattern (`runbook.md` → *What to ask IT for* → the Needs Review registration), **not** `Sites.Selected` |
| Grant | **Read** on `AI Sandbox / Documents / CO Managment Process` — the one folder, every subfolder. Read on the parent of the whole live tree, because the intake half (§ 4) reads `Change Order Intake`, `CO In Progress` and `CO Finalized` and the classifier half reads `Change Order Step 2` |
| What a write would do | Graph answers `403` whatever the code asks, because the grant has no write role. The token itself is the fence |

Why not widen `phb-platform-co-review` (Read on `_needs_review` only) with a
second grant: that app is the web app's identity for the Needs Review tab,
and widening it to the whole live tree widens what the web app *can* read
for the sake of a job that is not the web app. One registration per purpose,
the smallest grant that serves it — the rule the three existing apps
follow. The request text is `runbook.md` → *What to ask IT for* → Request 6
(the numbering has two *Request 5*s today; the new one takes 6 and the
runbook change notes the collision). **This request is the one external
dependency of Part E**, and IT turnaround has been days to weeks; the plan
puts it first.

**Interim, while the grant is pending — a dry run only, not the window.**
`tests/capture_classifier_fixtures.py` already reads the synced live Step 2
queue read-only from this laptop (D0), and `tests/build_copy.py` uploads
with a developer token. Running those by hand once builds a first batch so
the cloud pass and the comparison can be exercised before the reader exists.
It reintroduces a person and the laptop, so it proves the instrument and
**counts for nothing** toward the window.

### 2b · The code: a reader that cannot write, separately from the store

A new module in `phb-co-engine`, `co_livereader.py`, is how the feeder reads
live. Three properties, each with a test:

- **GET-only by construction.** It has no method that issues anything but
  `GET`; the one `requests.Session` it holds is wrapped so that any other
  verb raises before a request is built, and the test drives every method
  through a fake transport and asserts the verb list is `{GET}`.
- **Not a `FileStore`.** `GraphFileStore` refuses the live folder by name,
  and that refusal is the Phase 12 fence; the reader does not inherit from
  it, does not relax it, and the store's refusal stays exactly as it is
  (`tests/test_graph_root_jail.py` unchanged). The reader is the only code in
  the repository allowed to name `CO Managment Process`, and the static
  scanner's allow-list names it by file and function.
- **Its own identity.** It takes the reader app's client id from
  `CO_READER_APP_CLIENT_ID` and refuses to be constructed with the engine
  app's id (`CO_GRAPH_APP_CLIENT_ID`) — the job carries both variables and a
  test asserts a reader built with the engine's id raises.

What it reads, in this order, each run (names, sizes, `eTag`, `cTag` and
`lastModifiedDateTime` recorded for every item it touches):

| Read | Why |
|---|---|
| `Change Order Step 2/_to_classify/*/` — folder names, `classify_request.json`, `body.txt`, attachment **names and sizes** | the items |
| `_processed/*/`, `_needs_review/*/`, `_archive/**/` — folder names and, for an item the shadow holds, `classification_result.json` | the laptop's answers, wherever Response 2 moved them |
| `_index/*.json`, `_staging/**/{qa_log,completeness_log}.{json,md}`, `_handoff/*`, `bid_leaders.json`, `run_summary.md` | the state before the laptop's run, and the run's own summary after |
| `Bid Tracker.xlsx` tables `COTracker` and the master tracker's tables | the tracker snapshot — see 2c |
| `Change Order Intake/state/*.json` (`co_name`, `verdict`, `archived`) | the awaiting-PM list |
| `CO_Response_Agent_SKILL.md` — sha256 only | spec drift (§ 7) |
| `Change Order Intake/{1 - New Requests,2 - Returned for Info,3 - Ready for Vendor Pricing}/<CO>/` | the intake half, § 4 |

What it **never** copies: attachment content (the container sends filenames
only; a quote PDF stays where it is — D0's rule 3); any file under one of
the four sentinel names under that name (renamed by role on the way, the
fixture store's rule, the store walked afterwards and the run failed if any
is present); anything from `CO In Progress` / `CO Finalized` beyond folder
**names** (presence is all the engine checks).

### 2c · Does reading change anything live?

**Prediction [inferred]:** no. A Graph `GET` on an item's metadata, its
children or its content does not change `lastModifiedDateTime`, `eTag` or
`cTag`; SharePoint does not record last-access. A workbook-API read of a
table (`/workbook/tables/{name}/rows`) without a session is served from a
non-persisting session and saves nothing.

**Measured, every run, not assumed:** the reader records the three fields
for every live item before and after each run and the report carries a
*Live items changed during the read* line — expected empty. If it is ever
not empty for a file the reader touched and nothing else wrote, the window
stops until it is explained.

**The one read that is new to this project:** nothing has read the live
`Bid Tracker.xlsx` through the Graph workbook API yet — D0 captured its
tables with openpyxl from the synced copy, and `GraphWorkbookTrackers`
(`co_classifier/tracker.py`) is written from the reference and unexercised.
The tracker's table binding is the file the pipeline cannot afford to
disturb (prohibition 4; `docs/02-existing-co-system.md` → *Excel rules*). So:

1. the reader exercises `GraphWorkbookTrackers` first against a **renamed**
   copy of the workbook in the scratch folder (the store cannot upload the
   real name — `is_forbidden_workbook` refuses it on read and write — and
   that is the point), checked against D0's openpyxl capture of the same
   tables;
2. the first read of the live file is one run, by hand, with the three
   fields recorded before and after and Phase 11's table-binding check
   (`docs/phase-11-verification.md` § 2e) repeated the same day;
3. **[decision for the owner, after step 2]** if the workbook API read is
   shown to touch the file, the fallback is to download the bytes
   (`/content`) and read the tables with openpyxl in memory, which is how
   D0 read them and writes nothing — but prohibition 4's wording says *only
   through the Graph workbook API*, so switching is the owner's call and a
   one-line change to `CLAUDE.md`'s rule, not a quiet one.

Two facts about the workbook API to carry: list operations are not
paginated and cap around 256 rows (`docs/02`); `COTracker` is 32 rows plus
18 blank ones today, so the cap is far, and the reader asserts the row count
is under it.

---

## 3 · Question 2 — timing: what the laptop consumes, and what it does not

**What the laptop's run actually changes [observed, D0 and D3].** The
classifier writes `classification_result.json` into the item folder;
Response 2 then moves the folder to `_processed` or `_needs_review` and
updates the tracker (`Responded emails`, the received count, the rename).
The item's `classify_request.json`, `body.txt` and attachments are **not**
modified by any of that — they travel with the folder. What *is* consumed is
the **state before**: the tracker's rows, the Q&A and completeness logs, the
index. D3's first replay found exactly this: on today's tracker every count
the laptop proposed read as withheld, because Flow 2 had appended those
vendors after the laptop's run.

So the shadow has one hard timing requirement and one soft one:

- **Hard: snapshot the state before each laptop run.** The laptop's
  classifier fires at 08:00 and 13:00 America/New_York (`0 8,13 * * 1-5`
  [observed, the app log]). The feeder takes a **state snapshot** fifteen
  minutes before each — trackers, index, staging logs, intake state,
  `bid_leaders.json`, the spec's sha — and names it by the laptop run it
  precedes.
- **Soft: capture items whenever they are seen.** The feeder runs hourly on
  weekdays and captures every item it has not captured before, from
  whichever queue folder it is in, recording the folder and whether a result
  already existed at capture.

**Pairing.** Each captured item is run by the container against the newest
state snapshot taken **before the laptop's result for it** (`classified_utc`
in the laptop's result, once collected) — or, until the laptop's result
exists, the newest snapshot. An item that arrived after a snapshot and was
processed by the laptop before the next one is paired with the earlier
snapshot, which is the state the laptop saw. An item that arrived in the
fifteen minutes between the snapshot and the laptop's run, and was classified
before the feeder's next tick, is paired with a snapshot that predates a row
Flow 2 may have seeded in those minutes; that is the only race, it is a
quarter of an hour twice a day, and when it bites the scorer already reports
the affected rows as *not comparable* with the cause (`already_responded`,
closed or gone CO — the D3/D5 scorer rules) rather than as failures. The
report counts race-window items separately so the number is visible.

**The container's pass.** A batch is a fresh scratch tree built in the copy
from the captured items and their paired snapshot — the replay instrument's
own copy builder, on `GraphFileStore` instead of local — and the pass runs
on it through the Part D job's own script (`infra/classify-job.sh`). Items
with no result yet run in the next batch; an item runs once. The replay's
strip rule (D4: the laptop's own Q&A entries for a replayed item are its
output, not the state before it ran) applies unchanged to any item captured
after the laptop.

**Capturing the laptop's outputs afterwards.** The collector runs after each
laptop cron plus three hours (the inventory's observed morning drift is up to
+2h19m) and again at the end of the day, and for every shadow item looks in
`_to_classify`, `_processed`, `_needs_review` and `_archive` for the folder
and its `classification_result.json`, which it stores in the copy renamed by
role (`response-classification-payload.json`), beside the live
`run_summary.md` and the staging logs *after*. A laptop run that has not
landed by the end-of-day collection is reported as **laptop silent today**:
Part E records the laptop's cadence as a by-product, which Phase 13's
silence alert will later do for the cloud job.

---

## 4 · Question 3 — scope: both halves, by different mechanics

**Both, and for different reasons. [decision]**

### 4a · The classifier: a scheduled shadow (§ 3)

This is the half the roadmap's Part E was written for: a model's answers on
inputs nobody has seen, against the laptop's answers on the same inputs,
scored by the equivalence doc's Part 2 bars. The instrument is the Part D
replay scorer (`tests/classifier_replay.py`), lifted out of the fixture
store and pointed at live pairs; its verdict words, its named-divergence and
not-comparable rules, its three-run stability check and its Q&A
content-for-a-person section are kept as they are. Compared per item: the
first-check, the label, `increment_received`, the CO match, the bid leader,
the Q&A structure, `needs_human` with the asymmetry, confidence as a logged
pair; and Part 3's invariants on every pass.

### 4b · The intake engine: a post-hoc replay of every live CO, with the Part C instrument

The engine makes no model call; its bar is identity. Its inputs — the
intake JSON and workbook — are not changed by the laptop's run (the engine
copies them into the attempt folder and moves the CO folder to its bucket),
so there is **no timing problem**: the collector captures each new CO's
inputs and the laptop's Gate A artifacts *after* the laptop has run, the
container replays the inputs in a fresh batch tree on the Graph store
(exactly what `tests/compare_stores.py` does from `pristine/`), and
`co_output_diff.py` compares: `scrub_result` and `vendor_drafts` payloads
(captured renamed by role), the Review / Vendor Copy / Action Needed
workbooks and documents by shape, `Resend Email.html`, and the state file.

What this adds that Part C did not have: COs the fixture store does not
hold, and the two rare intake paths the roadmap names (an incomplete PM
submission, an odd project number) if they occur. What it needs that Part C
did not: a rule for the state file, because the laptop's state keeps
growing after Gate A (Gate B/C/D history entries) and the copy's stops there
— the differ compares `verdict`, the scrub fields and the **history prefix**
up to the Gate A entry, by a listed rule added to `co_output_diff.py` with
its test; a resubmission (attempt 02 and later) is replayed with the earlier
attempts in the same tree, the way the five-attempt Bulletin 12 chain
already is.

**Not compared, by decision, and said in every report:** `CO Status
Tracker.xlsx` (regenerated from the whole live state, which the copy does
not hold), the CSV logs, the run report beyond the lines for the replayed
COs, and the archive sweep's tally (the copy's `_processed` is not the
live one; the sweep's evidence is D6's differential against the script).
The hold list is honoured on the laptop and moot in the copy (the two held
COs are not replayed). The sweep runs in the copy every pass, as a pass
must, on the copy's own items.

**LibreOffice.** The comparison image carried none, so no PDF was compared
in Part C (cutover item 1.7). Part E runs the same image; the PDF stays
uncompared, and the record says so. Installing it is Phase 14's image
decision, not this window's.

---

## 5 · Question 4 — scheduling: Phase 13's schedule, not Phase 13's alerts

**Manual triggers are not enough.** The feeder must run hourly on weekdays
and the state snapshot must land at fixed minutes before each laptop run;
that is around sixty executions a week for weeks, and a window that depends
on someone starting them is the laptop's failure mode moved to a person.

**The minimum is Phase 13 Part A's mechanism without Part B:** Container
Apps Jobs with a `Schedule` trigger, which the repository already has a
pattern for (`infra/main.bicep` → the nightly backup job: `triggerType:
'Schedule'`, `cronExpression`, `parallelism: 1`, `replicaCompletionCount:
1`). No Azure Monitor alerts, no silence rule yet: during the window the
daily report **is** the absence check, and a job that did not run shows as a
missing report the owner reads. Phase 13 Part B then adds the alerts to
jobs that already exist. **[decision]**

Three jobs, one image:

| Job | Does | Cron (UTC) | Timeout |
|---|---|---|---|
| `co-shadow-feed` | reader: capture new items and new intake COs; at :45 before each laptop classifier run, the state snapshot; build the batch; run the classifier pass on it | hourly 11:00–22:00 weekdays, i.e. `0 11-22 * * 1-5` | 45 min — under the interval, so two cannot overlap |
| `co-shadow-collect` | reader: collect the laptop's results and Gate A artifacts; replay intake COs; score; write the report; raise STOP | `0 16,21,23 * * 1-5` (the laptop's 08:00 and 13:00 ET plus three hours, and end of day) | 90 min |
| the Part D classify job | unchanged, Manual, for re-running one batch by hand during an investigation | — | 30 min |

**Time zone, decided now because the window straddles none and is in
EST.** Container Apps cron is UTC (the backup job's comment says so, and
its 08:30 UTC is written as 03:30 New York in winter). DST ends on
2026-11-01, before the window starts, so the laptop's 08:00 / 13:00 ET are
13:00 / 18:00 UTC for the whole window, and the crons above assume that. The
next shift is March 2027: by then either cutover has happened and Phase 13's
DST decision governs, or the crons move by an hour in a commit that says so.
**[decision]**

**Overlap.** Each feed run's timeout is shorter than its interval, so a
second execution cannot start while one runs; the collector's three runs
are hours apart. What the platform does when a schedule fires during a
running execution is still verified rather than assumed, by the Phase 13
acceptance item, but Part E does not depend on the answer. The feeder and
the collector are idempotent by item id either way.

**Where the job definitions live.** Part C's and Part D's jobs were YAML
specs filled by hand outside the repository (they carry the subscription
id) and created by the owner. Three scheduled jobs for weeks is the point
at which they belong in the Bicep behind a flag (`enableCoShadow`, the
`enableDbBackup` pattern, default false), deployed with the routine template
command. **[decision for the owner, § 13]** — it is Phase 13 Part A's
acceptance box (*Both jobs defined in Bicep*) arriving early, and it means
`tests/deploy-guards.test.ts` holds the jobs' env entries the way it holds
the web app's.

---

## 6 · Question 5 — nothing leaks into the live process

Five properties, each with its mechanism and the test that holds it:

| Property | Mechanism | Held by |
|---|---|---|
| The container's `needs_human` items never reach the live `_needs_review` | the container writes its result into the **copy's** item folder; no flow runs on the copy, so no note is written and nothing moves; the Needs Review tab reads the live folder through a grant scoped to that one folder, so it cannot see the copy by construction | `tests/test_classifier_pass.py` (results only in item folders under the root); the platform's `tests/co-review-read-only.test.ts` and the folder grant |
| No sentinel is written in a folder a flow watches | the four names are written only at the three sanctioned sites, through a store whose root is the copy, a sibling top-level folder outside every watched folder; the reader cannot write at all; the collector stores every captured sentinel renamed by role and walks the copy afterwards | `tests/test_filestore_interface.py` (exactly three sites); the reader's verb test; the collector's name walk, the capture tool's rule 2 |
| Never two instances against live | the container's store refuses `CO Managment Process` by name whatever it is given; the reader's grant is Read; the laptop is the one writer | `tests/test_graph_root_jail.py`; the reader's identity test; the grant |
| Nothing from the model names a file, a recipient or a send | unchanged from Part D: no tool declared, closed schema, candidate check, filenames built by code | the Part D suites |
| The Bid Tracker is never written | `is_forbidden_workbook` on read and write in the store; the reader has no write verb; the live read is measured (§ 2c) | `tests/test_no_bid_tracker_write.py`; the reader tests; the per-run change line |

One more, because it is the one a copy can get wrong quietly: **the copy
holds vendor and PM content** — emails, intake forms, names — in the library
the originals already sit in, readable by the same people (the Part C
decision, *real, not scrambled*). It holds no attachment content and no
pricing beyond what a vendor wrote in an email body. It is deleted when the
window is written up, and the record carries the date, as Part C's does.

---

## 7 · Question 6 — reporting

**Each collector run writes one report** into the copy,
`reports/<date>-<time>.md`, and rewrites `reports/WINDOW.md`, the running
state of the window. Each report carries, in this order:

1. **STOP, if any** — the one row that stops the window: the laptop
   declined (`needs_human: true`) and the container decided (`false`) on
   the same item. The collector writes a `STOP` file at the copy's root
   beside the report; **the feed job refuses to run its classifier pass
   while that file exists** (checked first, before any read), so the window
   is stopped by the next tick without anyone remembering to stop it. A
   person investigates, records the finding in the verification doc, and
   removes the file; the removal is a line in the next report.
2. **FAIL rows**, each with the item, the bar, both answers, and the
   three-run stability result once it has run (§ 7, next paragraph).
3. **Container more cautious** — logged, counted, never a failure; a run of
   them on one judgment is called out as *a pattern worth reading*, because
   the equivalence doc says that is what a moved prompt looks like.
4. **Named divergences**, by rule and count (the internal-sender rule, Q&A
   granularity), never failures.
5. **Not comparable**, by cause (race-window item, `already_responded`, a
   closed or gone CO, tracker unreadable).
6. **Equivalent**, by bar, with the running totals.
7. **The Q&A content section** — every extraction beside the laptop's, for
   a person; never sampled.
8. **The intake replays** — per CO, the differ's classes and verdict; the
   timezone shift present and expected; which Office files matched by
   shape while their bytes differed.
9. **Path coverage** — the § 8 table, updated.
10. **Housekeeping** — live items changed during the read (expected none);
    laptop silent today, if so; spec drift (the live spec's sha against the
    repository mirror's — a change means the laptop and the container are
    working to different rubrics from that day, and the report says so
    until a person re-captures the mirror); the laptop's run times as
    observed; the pass's own summary and the sweep's tally.

**Stability before investigation (equivalence doc, Part 4).** Any FAIL on
a judgment triggers three re-runs of that item against its paired snapshot
in the next feed run — the replay instrument's rule — and the next report
says *unstable* (the container disagreed with itself: a prompt finding,
not a laptop-is-right finding) or *consistent* (now the laptop is right
until proven otherwise). Nothing is changed in a prompt on the strength of
one disagreement; a prompt change during the window is a new version, a
commit that says why, and a restart of the count for that judgment.

**Who reads it.** The owner, daily, from the copy folder in the browser
(the report is markdown in SharePoint, readable there) or from the
collector's job log, which prints it. Weekly, the owner or an agent folds
the week into `docs/phase-12-part-e-verification.md` — the record, the way
Parts C and D have one — item by item for anything not equivalent. The
platform's UI shows nothing of this, by `docs/PHASE-12.md`'s rule that this
work changes no platform code.

---

## 8 · Question 7 — exit criteria

**Coverage, not elapsed days, with a floor.** The window is done when all
of the following are true, and not before:

- **at least twenty laptop weekdays** have passed since the first clean
  batch (a batch whose items were all captured before the laptop's run,
  with a snapshot that preceded it) — four calendar weeks;
- **no STOP row ever** (cutover item 0.4);
- **every FAIL explained** in the record: unstable, scorer, bar, named
  divergence added by decision, or a container defect fixed with its
  restart; none open;
- **every path in the table below either observed live or exercised
  synthetically in the copy**, with the record saying which;
- **the cloud path ran unattended for the whole window**: every scheduled
  execution either ran or is accounted for.

The paths, how each is recognised in the data, and what happens if it never
comes:

| Path | Recognised by | If it does not occur naturally |
|---|---|---|
| Incomplete PM submission | the laptop's CO lands in `2 - Returned for Info`, state verdict `returned_for_info` | already held by eleven A3 fixture runs with the laptop's output, replayed through the cloud store in Part C; the window re-replays one of them on its schedule so the path runs on the cloud path at least once |
| A vendor reply that is not a quote | the laptop's label is `question`, `answer`, `declined` or `other` on an outside sender | held by the D0 fixtures (3 / 3 / 3 / 3 of each) — re-replayed on the schedule once; a live one still expected at October's mix |
| An odd project number | a CO whose project token is absent from the master tracker or whose number the scrub's validator rejects | `P&G|Permit Pack 4, Bulletin 4` in the D0 fixtures; one crafted intake in the copy with a token the master does not carry, scored against the engine's own rule |
| Near-duplicate change orders | two **open** keys within one distinctive word of each other in a snapshot (the bid-leader tokeniser decides), and a reply resolved by body inference while both are open | **not held by any fixture** (D5: no email sat between two open COs a word apart). A crafted item and a crafted snapshot in the copy; the bar is the spec's close-call guard — null, and a decline naming both |
| A duplicate CO Key | two rows with the same key in a snapshot | one row for every key in today's tracker. A crafted snapshot in the copy; the bar is the spec's 2026-08-04 rule — decline naming both rows' dates and respondents |
| A reply before its CO exists | the laptop's `needs_human` with no match, the 14-of-15 case | expected to occur; held by five D0 declines |
| A resubmission chain (attempt 02+) | a second `intake_*.json` for a CO already scrubbed | the five-attempt Bulletin 12 chain, replayed on the schedule once |
| A PM completeness reply | a `pm_thread` index hit | held by four D0 fixtures; expected live |
| A model decline on both sides | both `needs_human`, topics compared | expected |

**The synthetic rule. [decision]** A synthetic exercise is a crafted item
or intake plus, where needed, a crafted snapshot, placed in the **copy
only**, named `ZZSHADOW …` so it can never be mistaken for a capture, run by
the same job through the same code, and scored **against the spec's rule,
not against a laptop answer** — there is none. It ticks the path's box as
*exercised synthetically*, which the record and the cutover checklist carry
as a weaker word than *observed*. The owner may instead put a real ZZ test
CO through the live intake, as the operator has before (the tracker's `ZZ`
rows), so that the laptop produces an answer and the path is *observed*;
that is an action on the live process, with drafts created that nobody
sends, and it is the owner's deliberate call each time, never the plan's.

**What resets the count.** A prompt-version change resets the twenty days
for the judgment it touches; a scorer or reader fix does not; a STOP that
is investigated and found to be the laptop's own defect is recorded as
such and does not reset, by the owner's written decision in the record.

**What the window does not and cannot prove**, written now: PDFs (no
LibreOffice); the sweep on the live `_processed` set; the live Bid Tracker
read beyond the reader's own reads; the laptop's prompt itself, which the
shadow cannot see (an edit in the Cowork UI is invisible — the `diff -r`
in `_live-scheduled-tasks/README.md` is run by hand each week and the
report carries the date it was last run); and any behaviour of the
container on live timing, because it never runs on live until Phase 14.

---

## 9 · Question 8 — cost

From the Part D replays [observed]: D5's full replay was 72 calls for about
$3, so about **4 cents a call** at list prices with the hour-long cache; an
item takes one classify call, one Q&A call when it is not `other`, one match
call when neither deterministic signal found a row, and a bid-leader call
only on an ambiguous master match — three calls on the worst item. A pass's
first call writes the cached system block, about a dime (plan § 10).

| | per weekday | per week | basis |
|---|---|---|---|
| Model calls at October's volume (~0.4 items a day) | ≈ $0.10 | ≈ $0.50 | 3 calls × $0.04 + $0.10 cache write, on the passes that have an item; empty passes make no call |
| Stability re-runs on a disagreement | — | ≈ $0.40 each | 3 runs × up to 3 calls |
| Intake replays | $0 | $0 | no model |
| Compute: three jobs, ~15 feed runs and 3 collector runs a weekday, 0.5 vCPU / 1 GiB, a few minutes each | pennies | ≈ $0.10–0.20 | consumption pricing per vCPU-second and GiB-second; the Graph store's ~50 s per intake CO is inside this |
| Graph reads | $0 | $0 | |
| Storage in the copy | $0 | $0 | kilobytes a day, under the library's quota |

**Under a dollar a week, under ten dollars for the window**, with the
model calls the only line that moves. At five times October's volume it is
still under five dollars a week. The compute figure is a list-price estimate
from memory, flagged as such; the Part C job's five runs left no visible
mark on the budget, and the budget's actuals after the first week replace
the estimate in the record.

---

## 10 · What in `PHASE-13.md` is now wrong, given Parts C and D

`docs/PHASE-13.md` was written before Part C ran and before Part D existed.
Read it with these corrections; the document itself is changed when Phase 13
is written up, except where § 12 says this plan's PR changes a line.

1. **"At cutover, the same job gets repointed — the schedule itself doesn't
   change."** Cutover is a **code change, a new image and the repoint, in
   that order**: the Graph store refuses `CO Managment Process` by name and
   removing that refusal is the Phase 14 change (`docs/PHASE-14.md` 1.2;
   its *Where the documents disagree* item 1 already flags this).
2. **"Two Container Apps Jobs … one per task, mirroring what runs today."**
   The classifier is no longer a Cowork task to mirror: it is
   `python -m co_classifier` in the same image, with its own job spec
   (`infra/classify-job.yaml.template`, Manual, Part D) that has never run
   in Azure. And the shadow needs **three** jobs, not two (§ 5): a feeder,
   the container's passes, and a collector, because a comparison has to
   read the laptop's side after the laptop has run.
3. **"12 A–D … (D: key wired 2026-10-01)."** That date is the BAS key.
   Change Orders has its own key since 2026-10-16, `CO-ANTHROPIC-API-KEY`,
   and it reaches the **job** as a Key Vault reference under the platform's
   identity; `coAnthropicApiKeyInKeyVault` stays false because the web app
   never reads it (plan § 11b). Both keys are personal keys linked to Jim by
   the owner's decision of 2026-10-29 (`docs/PHASE-14.md` 0.6).
4. **"Job configuration lives in the Bicep … Nothing clicked together in
   the portal."** Part C's and Part D's jobs were YAML specs filled by hand
   outside the repository and created by the owner, because they carry the
   subscription id. The Bicep now has the scheduled-job pattern (the backup
   job); § 5 asks the owner whether the shadow jobs go there now.
5. **"Intake runs before the classifier on purpose. Keep the gap."** True
   after cutover. During the shadow the two halves are independent — the
   classifier half runs on a schedule tied to the *laptop's* runs and the
   intake half is a post-hoc replay — so the ordering requirement does not
   apply to the shadow's crons and must not be copied into them.
6. **The classifier's tracker reads.** PHASE-13 assumes the classifier job
   reads what the laptop reads. The Part D classifier reads the trackers
   from a **snapshot JSON** (`--trackers snapshot`), and the Graph workbook
   reader that a post-cutover job would need is unexercised. Part E
   exercises it read-only through the reader (§ 2c); Phase 13's cutover
   configuration (`--trackers graph`) depends on that result.
7. **Timeouts.** "Generous enough for the slowest observed run" now has a
   number PHASE-13 did not: the Graph store takes 44–54 s per intake CO
   against 2–3 s locally (cutover item 1.10), one round trip per file
   operation.
8. **The silence alert.** Still the Phase 13 deliverable, unchanged — but
   Part E's collector detects the **laptop's** silence as a by-product
   (§ 3), which PHASE-13 did not anticipate and which is worth keeping in the
   record: the morning-run drift the inventory could only infer gets
   measured.
9. **"Phase 13 drives Part E."** Half right. Part E needs Phase 13's
   schedule mechanism (Part A) and not its alerts (Part B); § 5 states the
   minimum so the two phases do not block each other in a circle.

Not wrong, still true: everything runs against the copy; the laptop tasks
are not modified; the alert destination is a group; the BAS collector's
laptop dependency is out of scope.

---

## 11 · What this part does not do

- No change to any flow, sentinel name, path, the eleven flows' trigger
  behaviour, the human-send gate, the laptop's tasks, the SharePoint spec or
  prompt (`docs/PHASE-14.md` 2.1–2.4 are cutover items).
- No run against the live tree by the container, in either direction; no
  write to live by anything the shadow runs.
- No tuning toward the laptop. A prompt change is a decision, a version, a
  restart.
- No alerting (Phase 13 Part B), no cutover (Phase 14), no platform UI or
  platform code beyond the Bicep flag the owner may choose and the
  documentation: `PHASE-12.md`'s rule holds.
- No model change during the window. Plan § 10 said *revisit with Part E
  data*; that is after the window, with its data, not inside it.
- No attachment content anywhere in the copy; no scrambling of what is
  there (the Part C decision stands and its reasons apply unchanged).

---

## 12 · Delivery

All in `phb-co-engine` unless marked; one branch per change; the agent stops
at the push.

| PR | Contents | Done when |
|---|---|---|
| **E0** (no code) | the IT request for `phb-co-engine-reader` — `runbook.md` → *What to ask IT for* → Request 6 (`phb-platform`) | sent; the grant is the one external dependency |
| **E1** reader | `co_livereader.py`: GET-only, own identity, the live folder named here and nowhere else; capture of items (names, request, body, attachment names), snapshots, laptop results renamed by role, intake COs; the per-run change line; the sentinel name walk; `tests/test_livereader.py` | the verb test, the identity test and the name walk pass with a fake transport; the static scanner allow-lists the file |
| **E2** batch and pass | the batch builder on `GraphFileStore` (the replay's copy builder, generalised), snapshot pairing, the STOP check, `infra/shadow-feed.sh` | a batch built from a captured item runs through the Part D pass on the copy, locally against a fake Graph |
| **E3** collector and scorer | the replay scorer over live pairs, the report, `WINDOW.md`, STOP, the stability re-run request, spec-drift and laptop-silence lines; `infra/shadow-collect.sh` | the scorer's self-test passes on crafted pairs for every verdict word, including a STOP that writes the file and a feed run that refuses while it exists |
| **E4** intake replay | capture of a live CO's inputs and Gate A artifacts; replay on the Graph store (`compare_stores.py` generalised); the state-prefix rule in `co_output_diff.py` with its test; the chain case | the eight fixture COs still eight of eight through the new path; a crafted post-Gate-B state matches on the prefix and fails on a changed scrub field |
| **E5** the jobs | three specs — YAML templates, or the Bicep flag `enableCoShadow` by the owner's choice (§ 13) — crons, timeouts, both app client ids, the key reference; `tests/test_classifier_image.py` extended to the two scripts | `az bicep build` and the deploy guards pass if Bicep; the templates carry placeholders only if YAML |
| **E6** docs (`phb-platform`) | `docs/phase-12-part-e-verification.md` skeleton (the record, with the path table and the per-week sections); `runbook.md` symptoms (*the shadow stopped: a `STOP` file*, *a report says live items changed during the read*, *spec drift*, *laptop silent today*, *the feed job finds no grant*); `PHASE-13.md` item 1 of § 10 corrected in place; `CLAUDE.md` current state; `WHY-ITS-BUILT-THIS-WAY.md` § on the read-only reader | the deploy guards pass; nothing restates another doc |

**Owner's actions, in order:** send Request 6; after the grant, the first
hand-run read of the live tracker with the fields recorded (§ 2c step 2);
build the copy root and create the jobs (or deploy the flag); watch the
first clean batch land; read the daily report; decide the § 13 items.

---

## 13 · Decisions for the owner

1. **The reader's identity.** A fourth registration with Read on
   `CO Managment Process` (recommended, § 2a) — or widen
   `phb-platform-co-review` with a second grant and share it.
2. **The live Bid Tracker read.** Workbook API as prohibition 4 reads
   today, measured on the first run (§ 2c) — and if that read is shown to
   touch the file, whether to download bytes and read with openpyxl in
   memory, which changes `CLAUDE.md`'s wording.
3. **Scope.** Both halves (§ 4, recommended), or the classifier alone with
   the intake half left to its Part C evidence.
4. **Where the jobs are defined.** The Bicep behind `enableCoShadow`
   (recommended: three scheduled jobs for weeks, and Phase 13's box early)
   — or YAML specs by hand as Parts C and D did.
5. **The synthetic rule and the live ZZ option** (§ 8): accept *exercised
   synthetically* as the word for a path that does not occur, and decide
   case by case whether to put a real ZZ CO through the live intake.
6. **The floor.** Twenty laptop weekdays after the first clean batch
   (§ 8), or longer.
7. **The report's home.** The copy folder and the job log (§ 7), read
   daily by the owner — or a different reader.
8. **The copy's deletion date**, written into its README on day one.

---

## Related

- `docs/PHASE-12.md` → *Part E*, *Hard constraints*, *Acceptance criteria*
- `docs/phase-12-part-e-equivalence.md` — the bar; Parts 2–4 are the
  scorer, Part 3 the invariants, Part 6 the window
- `docs/phase-12-part-c-verification.md` — the instrument this reuses for
  the intake half, and the five runs it took to make it honest
- `docs/phase-12-part-d-verification.md` — the replay scorer, its verdict
  words and the three tracker-moved-on rules the shadow inherits; *What
  Part E inherits*
- `docs/phase-12-part-d-plan.md` § 9b–9c, § 10, § 11b
- `docs/PHASE-13.md`, with § 10 above beside it
- `docs/PHASE-14.md` 0.2–0.5, 1.7, 1.10, 3.1–3.5
- `docs/12-ai-layer-inventory.md` § 1 (the two tasks and their crons), § 2,
  § 3a, § 4d, § 5 (the lock, the run report, the observed cadence), § 7b
- `docs/13-needs-review.md` § 5–9 — what a refusal looks like live
- `phb-co-engine`: `tests/capture_classifier_fixtures.py`,
  `tests/build_copy.py`, `tests/compare_stores.py`,
  `tests/classifier_replay.py`, `tests/co_output_diff.py`,
  `co_classifier/tracker.py` (`GraphWorkbookTrackers`),
  `infra/classify-job.yaml.template`, `_live-scheduled-tasks/README.md`
