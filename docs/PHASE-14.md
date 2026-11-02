# Phase 14 — Cutover checklist

**This is the one list for cutover day.** Everything that any document in
either repository says must happen at, before or after the moment the cloud
engine takes over from the laptop is gathered here, each item with the
document it came from. Nothing on this list was invented for it: if an item
has no pointer, it does not belong here. When a source document changes, change
the item; when an item is done, mark it here and leave the source as the
record of why.

Status as of **2026-11-02**: Phase 12 Parts A–D are complete, Part E is
built and waiting on Request 6 (the reader's grant), Phase 13 Part A exists
as the shadow's schedule and Parts B and C do not, and **the cutover prep
is built, on two draft pull requests titled `[HOLD until Part E passes]`,
one per repository, not to be merged until the shadow window passes.** § 8
below says, item by item, what is done, what can only happen on the day,
and the decisions the owner made the same day; § 9 is the order of
operations on the day. What gates the day is the sequence in § 0.

Read `docs/06-roadmap.md` → *Phase 14* for the goal, `docs/PHASE-12.md` for
what cutover is not (it is not Phase 12), and `docs/PHASE-13.md` for the
schedule that cutover repoints.

---

## 0 · What has to be true before cutover day

| # | Item | Source |
|---|---|---|
| 0.1 | **Done 2026-10-29.** Phase 12 Part D: the Cowork judgment steps replaced one at a time, lowest consequence first, every model response schema-validated, no model output naming a file, choosing a recipient or triggering a send. What Part E inherits from it is in `docs/phase-12-part-d-verification.md` → *D6* | `docs/PHASE-12.md` → *Part D* |
| 0.2 | Phase 13 is done: the container runs against the **copy** on the laptop's schedule, with failure and silence alerts, and the runbook entries written in that phase | `docs/PHASE-13.md` → *Where this sits in the sequence*, *Part C — Operations* |
| 0.3 | Phase 12 Part E is done: **weeks** of shadow running against the copy, every disagreement investigated, the laptop right until proven otherwise, equivalence for the judgment steps defined in writing before the window started (it is: `docs/phase-12-part-e-equivalence.md`). "Phase 12 is complete when the container has produced equivalent output for a sustained period, and the disagreements are understood. Not when it runs." | `docs/PHASE-12.md` → *Part E*; `docs/06-roadmap.md` → *Phase 12* |
| 0.4 | The shadow run never wrote any of the four sentinel files into the live tree, and the one stop-the-window condition in the equivalence doc (the container deciding where the laptop refused) never fired | `docs/phase-12-part-e-equivalence.md` → *Part 2* (the stop-the-window row under `needs_human`), *Part 3 · Structural invariants* |
| 0.5 | **Answered from the documents, 2026-11-02: nothing reads either value, and one check remains for the day.** The flow map, read from all eleven exports (`FLOW_FACTS_VERIFIED_2026-08-04.md`), lists every field Response 2 declares and reads and names no timestamp; every timestamp a flow writes anywhere is its own `utcNow()` (`PA_Flow_Spec_Stage2.md` *Last PA Action At*, `PA_Flow_Spec_Stage4.md` `transferred_at`, `Gate_D_Design_Spec.md` `date_solicited`). The build specs for the two sentinel readers name what they take from the payloads: Intake 2 reads `reply_email.to/cc/subject/body`, `co.name` and `deliverables.highlighted_form_filename` from `scrub_result.json`; Intake 3 reads `co.name`, `attempt`, `vendor_emails[]`, `vendor_roster`, `vendor_copy_filename` and `cc_list` from `vendor_drafts.json`. `scrub_timestamp` and `drafted_timestamp` are read by nothing but the differ, which normalises them away. The flows trigger on the filename. **So 1.4's value change is harmless to the flows as documented, and the `Z` can be corrected in a change of its own after cutover.** The check on the day, because the exports live inside the live tree and this prep did not read it: unzip the eleven ZIPs in `AI Files/Power Automate Flow Exports/` and `grep -l "scrub_timestamp\|drafted_timestamp" */definition.json` — the expected answer is no file; a hit reopens this item before the flag is turned on | `docs/phase-12-part-c-plan.md` → *The timezone discrepancy: measured, and it is three fields*; `docs/phase-12-part-e-equivalence.md` → *The timezone shift is expected and must not be normalized away*; `phb-co-engine` → `specs/power-automate/FLOW_FACTS_VERIFIED_2026-08-04.md` § 8, `PA_Flow_Spec_Stage2.md` § 4, `Gate_B_Modification_BuildSteps.md`, `Gate_B_SharedMailbox_Draft_BuildSteps.md` |
| 0.6 | **Decided 2026-10-29: both Anthropic keys stay as they are — personal keys linked to Jim; accepted risk.** Checked in the Claude Console on 2026-10-28: neither `ANTHROPIC-API-KEY` nor `CO-ANTHROPIC-API-KEY` expires, both are personal keys linked to Jim, and the owner decided not to replace them with service-account keys. **The risk, plainly:** the day Jim leaves the organization, Anthropic archives his personal keys, and both the BAS Analyze tab and the change-order classifier stop working at the next call, as `401 authentication_error`. Nothing warns beforehand. The recovery is a key swap, not a design change: `runbook.md` → *Both Anthropic keys fail at once as `401 authentication_error`*. Federation (`docs/phase-12-part-d-plan.md` § 11c) remains the hardening option after Part E, not a condition of cutover | `docs/phase-12-part-d-plan.md` → § 11a; `runbook.md` → *What expires, and when*, *Both Anthropic keys fail at once*; Anthropic → *Authentication* → *Key types* |

---

## 1 · The cutover diff: what changes in the engine the day the cloud takes over

The laptop runs the engine as it was before Part B (`phb-co-engine` `f8645b7`
plus whatever the operator has edited in place); the cloud runs the
repository's engine. **The cutover diff is the list of every way those two
differ, each confirmed on the day.** The known ways:

| # | Item | Source |
|---|---|---|
| **1.1** | **The intake rule.** The laptop still picks the newest `intake_*.json` by modified time. The repository engine picks it by the timestamp in the filename, falling back to modified time only for a legacy `intake.json` or a tie, and the new rule ships **only when the cloud engine takes over**. The cutover diff must list `_find_intake_json` (`_intakes_newest_first` beside it) and confirm the new rule is what is running — `tests/test_intake_selection.py` passing on the deployed image, and the first cloud run's state file naming the newest intake by name. A read-only survey on 2026-10-28 found no live folder where the two rules would choose differently, so no in-flight CO changes outcome on the day | `docs/phase-12-part-c-plan.md` → *Before cutover: the intake-selection rule*; `CLAUDE.md` → Part C paragraph; `docs/12-ai-layer-inventory.md` § 2 (the intake row); `run_workflow.py` → `_intakes_newest_first` docstring |
| 1.2 | **Remove the by-name refusal of `CO Managment Process` in `co_filestore.py`, deliberately, with its test.** Until this is done the Graph store cannot address the live tree at all, by construction; this is the one code change that *is* cutover, and it is made nowhere else and for no other reason | `docs/phase-12-part-c-plan.md` → *The two guards*; `runbook.md` → *The engine says `refusing to run: … is inside 'CO Managment Process', the live tree`*; `co_filestore.py` comment above `LIVE_LIBRARY_FOLDER` |
| 1.3 | **The dormant Bid Tracker write.** Removed from the repository lineage in Part B; **still present on the laptop** until cutover. The live mitigation stays in force until then: do not set `CO_BID_TRACKER_PATH`, and do not put a `Bid Tracker.xlsx` into `Change Order Intake`. After cutover the mitigation is no longer needed because the code is gone, and `tests/test_no_bid_tracker_write.py` is the guard. The laptop's own knowledge-base doc still tells a new operator to set `CO_BID_TRACKER_PATH` — an open doc edit the operator never made; it becomes moot when the laptop retires | `docs/12-ai-layer-inventory.md` § 3b (*Two things remain true of production*) and the *Open, and the operator's call* note; `WHY-ITS-BUILT-THIS-WAY.md` § 40 |
| 1.4 | **The timezone value change.** Three fields carry `datetime.now()` plus a literal `Z`: `scrub_timestamp` in `scrub_result.json`, `drafted_timestamp` in `vendor_drafts.json`, `history[].at` in the state file. On the laptop they are wrong by the UTC offset; in the container they are right. **The same event stamps four to five hours later after cutover**, in two sentinel payloads. Do not correct the `Z` in the same phase as the runtime-timezone change, or the diff becomes unreadable; answer item 0.5 first | `docs/phase-12-part-c-plan.md` → *The timezone discrepancy: measured, and it is three fields*; `docs/phase-12-part-e-equivalence.md` → *The timezone shift* |
| 1.5 | **The via-tmp sentinel write.** `vendor_drafts.json` is written as `<name>.tmp` then renamed. The sentinel flows' trigger was observed firing on the final name twice out of two with the rename landing one second after the create; two samples do not rule out a poll landing inside that second. If the shadow run ever shows a miss, the cure is one call-site change (write the final name once, as `scrub_result.json` already is), with the differential as its check | `docs/phase-12-part-c-plan.md` → *Before cutover: the flow-trigger decision* → *Outcome* |
| 1.6 | **The lock.** It is a lock file through the FileStore interface, best-effort, fails open, coordinates one machine, and is not a mutex. "Whether the mechanism should change at all is a Phase 14 question, decided at cutover with the live path in view." **Decided 2026-11-02: unchanged.** The lock stays a best-effort lock file through the store; the schedule is the guard (one job, `parallelism: 1`, a timeout shorter than the interval, no retry), and the lock is never described as mutual exclusion | `docs/PHASE-12.md` → *Part C* (the lock paragraph); `WHY-ITS-BUILT-THIS-WAY.md` § 42; `docs/12-ai-layer-inventory.md` → *The lock is best-effort* |
| 1.7 | **PDF rendering — premise corrected 2026-11-02.** The comparison image carried no LibreOffice and no PDF was compared, but **the laptop's run produces none either**: `render_xlsx_to_pdf` is defined and never called, in `f8645b7` as in the repository, and the A3 fixture store holds no rendered PDF. The only PDFs in the pipeline are the classifier's, drawn by `reportlab` (`render_qa_pdf.py`, `render_completeness_pdf.py`), which need no LibreOffice. So the image decision is about a function nothing calls, and no comparison re-run is owed either way. **Decided 2026-11-02: build without LibreOffice** (`--build-arg INCLUDE_LIBREOFFICE=false`, as every image so far); deleting the unused `render_xlsx_to_pdf` is a later cleanup, not part of cutover | `docs/phase-12-part-c-verification.md` → *What this does not prove* (corrected the same day); `docs/12-ai-layer-inventory.md` § 3c and § 5 (corrected) |
| 1.8 | **The `400` on folder creation.** Seen once, on the first comparison run, with the folder present afterwards; never reproduced; every store error now carries Graph's code and request id. If it recurs it is "a finding to understand before Phase 14", because it is the same `POST …:/children` the engine issues for every attempt folder | `docs/phase-12-part-c-plan.md` → *The first run*; `runbook.md` → *The comparison job stops with `HTTP 400` creating a folder*; `co_filestore.py` → `makedirs` comment |
| 1.9 | **`rglob` at depth.** Walked folder by folder, correct, never measured against a deep tree; "a performance question for Phase 14" | `docs/phase-12-part-b-verification.md` → the 2026-10-28 closure note |
| 1.10 | **Speed at volume.** The Graph half took 44 to 54 s per CO against 2 to 3 s locally, one round trip per file operation. Not a defect, inside a scheduled run's budget at a handful of COs a day; cutover planning should know the number | `docs/phase-12-part-c-verification.md` → *What this does not prove* |
| 1.11 | **The internal-sender rule.** The container decides a `@phb1899.com` sender in a vendor thread by code before any model call — `other` with no tracker effect, or `needs_human` when the message forwards or quotes vendor content — where the laptop asks the model. Owner's decision 2026-10-29, a named divergence in the equivalence doc so the shadow run does not call it a failure; after cutover it is simply how the classifier works | `docs/phase-12-part-e-equivalence.md` → *Named divergences*; `docs/phase-12-part-d-verification.md` → *D3*; `phb-co-engine` → `co_classifier/rules.py` → `internal_vendor_content` |
| 1.12 | **`render_qa_pdf.py` differs from the live copy.** The repository's renderer groups the answers from one email under one heading, shows the scope-request note an answer addresses (`answers_note`) beside it, and escapes vendor text; the live script on SharePoint does none of these. The container renders the handoff PDF with the repository's copy. At cutover the live script is replaced by the repository's, in the same step as the engine (item 1.1 and the `Change Order Step 2` scripts) | `phb-co-engine` → `Change Order Step 2/render_qa_pdf.py` (its docstring dates the change); `docs/phase-12-part-d-verification.md` → *D4* |

---

## 2 · Prompts and authority

| # | Item | Source |
|---|---|---|
| 2.1 | **Prompts move to the repository as source of truth only at cutover**, and the SharePoint copies are re-labelled as mirrors **the same day**. Until then SharePoint is authoritative and the repo copy is the mirror. Two authoritative copies is the defect this project exists to prevent | `docs/06-roadmap.md` → *Phase 12*; `docs/05-database-and-sources.md` → *AI prompts* row; `docs/PHASE-12.md` → *Part D* |
| 2.2 | The two scheduled-task prompts recorded verbatim in the SharePoint `CO Process Handoff` corpus (`09 Scheduled Task Prompts VERBATIM`) are what the cloud schedule must reproduce; the crons were checked against them in Phase 11 | `HANDOVER.md` § 6 (the paragraph before *Moving the AI layer off the laptop*); `docs/05-database-and-sources.md` |
| 2.3 | **Update the authoritative live spec and the live classifier prompt with the internal-sender rule at cutover**: in `CO_Response_Agent_SKILL.md` § 1 and in the scheduled-task prompt, a `@phb1899.com` sender in a vendor thread is never a vendor reply, forwarded or quoted vendor content goes to review, PM completeness replies are unchanged. Until cutover SharePoint stays authoritative, the repo mirror stays a mirror, and the laptop keeps using the model for these | `docs/phase-12-part-e-equivalence.md` → *Named divergences*; item 2.1 |
| 2.4 | **Update the authoritative live spec with the two Q&A decisions of 2026-10-29 at cutover**: § 3.1 says one Q&A entry per commitment (not per email) and that the handoff PDF groups the entries from one email; § 3.1 and § 4.0 describe `answers_note`, the scope-request note an answer addresses, carried as a field in `qa_log.json` and shown on the PDF. Until cutover SharePoint stays authoritative and the laptop keeps logging one entry per email | `docs/phase-12-part-e-equivalence.md` → *Named divergences* 2; item 2.1 |

---

## 3 · Scheduling and the laptop tasks

| # | Item | Source |
|---|---|---|
| 3.1 | **The Phase 13 job is repointed from the copy to live at cutover; the schedule itself does not change.** See the flag below: the repoint is not a configuration change alone | `docs/PHASE-13.md` → *Where this sits in the sequence* |
| 3.2 | **After cutover, pausing the schedule stops the pipeline.** Before it, pausing the shadow is free. The runbook entry Phase 13 writes must say both | `docs/PHASE-13.md` → *Part C — Operations* |
| 3.3 | **The laptop's two scheduled tasks keep running throughout Phases 12 and 13** and are retired only in Phase 14, after the centralized version has run correctly for a sustained period | `docs/PHASE-13.md` → *Out of scope*; `docs/06-roadmap.md` → *Phase 14* |
| 3.4 | **Never run both against the live folders at once.** The lock file and duplicate detection make double-running actively dangerous, not merely redundant. Cutover is a switch, not an overlap | `docs/PHASE-12.md` → *The prime directive*; `docs/06-roadmap.md` → *Phase 12*; `HANDOVER.md` → *Moving the AI layer off the laptop* |
| 3.5 | The DST decision for the schedule and its reasoning, recorded in Phase 13's runbook entries, carries over unchanged | `docs/PHASE-13.md` → *Part C — Operations* |

---

## 4 · Rollback

| # | Item | Source |
|---|---|---|
| 4.1 | **Keep the laptop path documented as rollback for at least a month after cutover.** Retire it only after that. The procedure is written for someone with no background — `runbook.md` → *Rolling the change-order engine back to the laptop*: who owns it (whoever currently owns the platform; Jim Schwarz is the person to ask if nobody does), what to have before starting and who to ask for each thing, the steps with what each should show, how to tell it worked, what to do when a step fails — and `HANDOVER.md` links to it | `docs/06-roadmap.md` → *Phase 14*; `HANDOVER.md` → *Moving the AI layer off the laptop*; `runbook.md` → *Rolling the change-order engine back to the laptop* |
| 4.2 | Rollback is the laptop's engine with the laptop's rules: the old intake rule (1.1), the dormant Bid Tracker write and its mitigation (1.3), the local-time `Z` stamps (1.4). Rolling back re-opens each of those; the month is for deciding not to | items 1.1, 1.3, 1.4 above |

---

## 5 · After cutover: production hardening

| # | Item | Source |
|---|---|---|
| 5.1 | Audit logs, error monitoring, security and permission review, backups, failed-job alerts, email action logging, AI execution logs, release process, recovery procedures — the roadmap's list for this phase, after the switch | `docs/06-roadmap.md` → *Phase 14* |
| 5.2 | The nightly database backup job exists in the template behind `enableDbBackup` and is not yet turned on | `runbook.md` → *Nightly database backup*; `CLAUDE.md` → the 2026-10-21 backup entry |

---

## 6 · Open decisions that do not block cutover

| # | Item | Source |
|---|---|---|
| 6.1 | **DECIDED 2026-11-02: the `PnP.Powershell` certificate on the `phb-co-engine` app registration STAYS.** A second way to be the engine app, private key on an IT workstation, valid to 2029-10-19; production authenticates through the managed identity only and never presents it. Kept by the owner's decision as an accepted exposure; nothing is asked of Vitis. The runbook section keeps the facts and the conditions that would reopen it | `runbook.md` → *Decision — the `PnP.Powershell` certificate on `phb-co-engine` stays*; `docs/phase-12-part-c-plan.md` → *Step 7, second pass* |
| 6.2 | The engine's `/me/` Graph mail calls in Intake 1, 6 and 7 resolve to whoever owns the flow connection; correct today, silently repoints on a connection swap. Parked by decision 2026-08-04, to be done before any swap, not after — a flow item, not an engine one, listed here because a cutover that also swaps connections would trip it | `phb-co-engine` → `specs/power-automate/FLOW_FACTS_VERIFIED_2026-08-04.md` § 1 |

---

## 7 · Closed before cutover — do not redo

| Item | Closed | Record |
|---|---|---|
| The two-store comparison: `GraphFileStore` and `LocalFileStore` equivalent on all eight fixture COs | 2026-10-28, fifth run | `docs/phase-12-part-c-verification.md` |
| The flow-trigger check: the sentinel flows' trigger fires on items the engine's identity creates through Graph, both write shapes, final names | 2026-10-28, two samples | `docs/phase-12-part-c-plan.md` → *Before cutover: the flow-trigger decision* |
| The intake-selection rule: decided, implemented in the repository, no current outcome changed | 2026-10-28 | `docs/phase-12-part-c-plan.md` → *Before cutover: the intake-selection rule*; item 1.1 is what remains of it |
| The site grant: `Sites.Selected`, Write on the AI Sandbox site, proven as the app | 2026-10-21 | `docs/phase-12-part-c-plan.md` → *Step 7, third pass* |
| Change Orders has its own Anthropic key, wired through Key Vault and parked for Part D | 2026-10-16 | `CLAUDE.md` → *Change Orders has its own Anthropic key* |

---

## 8 · Cutover prep status (2026-11-02)

Built on two draft pull requests, each titled `[HOLD until Part E passes]`
and not to be merged until the shadow window passes: `phb-co-engine`
`feat/cutover-prep-HOLD` (stacked on the image fix `fix/image-carries-job-scripts`,
which is **not** on hold and should merge now, because the shadow jobs
cannot start without it) and `phb-platform` `feat/cutover-prep-HOLD`
(stacked on `chore/cutover-prep-findings`, likewise not on hold). What
each item needed, and where it stands:

| # | Prep done | On the day, or still open |
|---|---|---|
| 0.1 | Done 2026-10-29 | — |
| 0.2 | Phase 13 Part A exists as the shadow's three scheduled jobs. **Parts B (the failure and silence alerts) and C (their runbook entries) are not built**: an alert rule that has never fired is a hope, and firing one needs the jobs deployed, which is the owner's deployment after Request 6 | Build Part B against the running shadow jobs during the window (plan § 15), test both alerts by making them fire, then re-target them at the live jobs on the day |
| 0.3, 0.4 | Nothing to build; the window and its record | The window; Request 6 is the gate |
| 0.5 | **Answered** (the row above) | The one-minute grep of the eleven `definition.json` files |
| 0.6 | Decided | — |
| 1.1 | In the repository since 2026-10-28; `tests/test_intake_selection.py` runs in the image's suite and the HOLD engine branch changes nothing here | Run the suite inside the cutover image; read the first cloud run's state file for the intake it named |
| 1.2 | **Done, on the engine HOLD branch.** `GraphFileStore` no longer refuses the live folder by name, at construction or at any call; the root jail is its only fence. What still refuses the live tree is listed in the comment above `LIVE_LIBRARY_FOLDER`: the shadow package refuses a copy root inside it on both stores (now on any path segment), the Part D classify job's script refuses a root without `scratch`, the local classifier entry point refuses a local root inside the synced library, and the reader addresses nothing else. `tests/test_cutover.py` (8 tests, required by `ci_suites.py`) holds the new shape, the real engine pointed where the laptop points runs past the old fence and stops only at a dead proxy, and both mutations (the refusal put back; the shadow's removed) fail by name | Merge the branch; build the image from merged `main`; prove it with `docker run --rm <image>` and the suite inside it |
| 1.3 | The code is gone from the repository lineage; `tests/test_no_bid_tracker_write.py` runs in the image; the deploy guards now assert the Bicep never sets `CO_BID_TRACKER_PATH` on any job | Confirm no `Bid Tracker.xlsx` sits in `Change Order Intake` (a read, as the reader app). The laptop's knowledge-base doc becomes moot when the laptop retires |
| 1.4 | Answered by 0.5: harmless to the flows. No code change at cutover, on purpose; the `Z` correction is its own later change | Read the first cloud run's `scrub_result.json` and state file: the stamps are UTC, four or five hours later than the laptop's for the same instant, and the differ's classes name it |
| 1.5 | Nothing to change unless the window shows a miss. The one call site is `write_vendor_drafts_json` → `FS.write_text_via_tmp(...)`; the cure would be the plain `write_text(..., allow_sentinel=SENTINEL_VENDOR_DRAFTS)` that `scrub_result.json` already uses | Decide from the window's reports |
| 1.6 | **Decided 2026-11-02: the lock stays as it is** — a lock file through the store, best-effort, failing open — and the schedule is the guard (one job, `parallelism: 1`, a timeout shorter than the interval, no retry), not the lock. The mechanism works unchanged through Graph (`create_exclusive`, exercised in Part C). Changing it would be engine surgery for a property the scheduler already provides | One read before the flag goes on: the live root's `.run_workflow.lock`. Absent, released or older than 30 minutes is fine (the first cloud run reclaims it); a fresh one from a laptop run still in flight makes the first cloud run exit without changes, which is correct, and the next schedule picks up |
| 1.7 | **Premise corrected** (the row above): no PDF is rendered by the intake engine on either side, so no comparison re-run is owed. **Decided 2026-11-02: build without LibreOffice** — `INCLUDE_LIBREOFFICE=false`, as every image so far has been: smaller, faster to pull, and the function it would serve has no caller. The alternative, the Dockerfile's default `true`, would carry `libreoffice-calc` and fonts for dead code. Deleting `render_xlsx_to_pdf` and the Dockerfile's LibreOffice stanza is a later cleanup of its own, not part of cutover | Build with `--build-arg INCLUDE_LIBREOFFICE=false`; `runbook.md` → *Cutover* carries the command |
| 1.8 | Unchanged; every store error carries Graph's code and request id | If the `400` recurs in the window's intake replays, it is a finding to understand before the day |
| 1.9, 1.10 | Nothing to build: the window's intake replays run the engine through the Graph store on a tree of the live depth, and each report carries the per-CO time | Carry the numbers from the window's record into this file at close |
| 1.11 | In code since Part D; the spec edit is 2.3 | — |
| 1.12 | The repository's renderer rides in the image and is what the container runs. **Whether the SharePoint copy is replaced on the day is disagreement 6 below**, for the owner | Per the decision |
| 2.1 | The merge of the engine HOLD branch is the moment the repository becomes authoritative | Re-label the SharePoint spec and prompts as mirrors the same day; apply the 2.3 and 2.4 text to the SharePoint spec the same day (the mirror in the image otherwise reports drift) |
| 2.2 | The two production jobs' crons default to the verified crons, in UTC for Eastern standard time, the classifier an hour after the intake; the deploy guards hold both and the hour gap | — |
| 2.3 | **Drafted**: the spec mirror gains § 1.5 *Internal senders* (engine HOLD branch), placed after § 1.4's rule so the sections the classify prompt quotes verbatim are byte-for-byte unchanged and no prompt version moves; the scheduled-task prompt's edit is `docs/phase-14-spec-and-prompt-edits.md` § 2 | Apply both to SharePoint and to the Cowork task on the day — see disagreement 7 on whether the task's edit is wanted at all |
| 2.4 | **Drafted**: § 3.1.1 *Entry granularity, and the note an answer addresses* and the § 4.0 `qa_log.json` row (engine HOLD branch), placed before § 3.2 so § 3.1's extract is unchanged; `tests/test_cutover.py` and `test_classifier_prompts.py` hold the placement | Apply to SharePoint on the day |
| 3.1 | **The repoint exists**: two scheduled jobs in `infra/main.bicep` behind `enableCoLive` (off, every live value blank), `<baseName>-co-intake-scrub` and `<baseName>-co-response-classifier`, from the one `coEngineImage`, running `infra/co-intake-job.sh` and `infra/co-classifier-job.sh`; the live root and the two tracker paths are parameters filled on the day and spelled nowhere in code; the deploy guards hold all of it, in the source and in the compiled ARM | Fill `coLiveRoot`, `coLiveBidTrackerPath`, `coLiveMasterPath`, set `enableCoLive` true and `enableCoShadow` false, deploy with the routine command |
| 3.2 | `runbook.md` → *Cutover: turning the live engine on* says both: pausing the shadow is free; pausing after cutover stops the pipeline | — |
| 3.3, 3.4 | § 9 is the order that makes it a switch and not an overlap | On the day, in that order |
| 3.5 | The live crons are written for Eastern standard time, as the shadow's are; the March 2027 change is a commit that says so | Phase 13 Part C's entry, when written, carries the same decision |
| 4.1, 4.2 | **The rollback is written for someone with no background**: `runbook.md` → *Rolling the change-order engine back to the laptop* (the words it uses, what to have before starting and who to ask, numbered steps each with what it should show, how to tell it worked, what to do when a step fails), linked from `HANDOVER.md`. It belongs to whoever currently owns the platform; Jim Schwarz is the person to ask if nobody does. Decided 2026-11-02: no individual is named | — |
| 5.1 | After the switch, per the roadmap | — |
| 5.2 | The owner's switch (`enableDbBackup`); not part of cutover | — |
| 6.1 | Decided | — |
| 6.2 | A flow item, unchanged; cutover swaps no connection | — |

**What this prep did not read, by instruction:** the live tree. The laptop's
engine (`CO Managment Process/AI Files/CO Intake Engine/run_workflow.py`)
and the eleven flow exports both live inside it, so item 2 of the prep
(the engine comparison) is `f8645b7` — verified byte-identical to the
laptop's copy on 2026-09-10 — against the repository, and the in-place
edits the operator may have made since are confirmed on the day, which is
what the diff section already asks. The comparison by function, over 58
commits and 945 changed lines in `run_workflow.py` and 107 in `co_state.py`:
every hunk is the Part B store extraction (filesystem calls behind `FS.*`,
CSV and JSON writes assembled in memory, the lock through `create_exclusive`,
staging through the store's scratch area) **except** the three this file
already names — the intake rule (1.1: `_intake_name_time`,
`_intakes_newest_first`, `_find_intake_json`), the Bid Tracker write (1.3:
`BID_TRACKER_PATH_HOST`, `_resolve_bid_tracker_path`,
`seed_response_bid_tracker` and their call in `place_artifacts`, removed) and
graph mode itself (`main`: `--store`, `--drive-id`, `--graph-auth`,
`--sharepoint-root` required in graph mode, `--stage-dir`). The timezone
value (1.4) is a runtime difference, not a code one. Nothing else in the
diff changes what the engine writes, which is what the Part B differential
measured (eight of eight) and the window's intake replays measure again on
live inputs.

## 9 · Order of operations on the day

Each step's source is the item it serves. Cutover is a switch, not an
overlap (3.4): nothing after step 4 starts until step 4 is done.

1. **Preconditions, all true**: the window is written up and the owner has
   said it is done (0.3); no STOP ever (0.4); the grep in 0.5 found no file;
   the four pull requests are merged in order — `phb-co-engine`
   `fix/image-carries-job-scripts` then `feat/cutover-prep-HOLD`;
   `phb-platform` `chore/cutover-prep-findings` then `feat/cutover-prep-HOLD`;
   the image is built from merged `main` without LibreOffice (1.7, decided)
   and tagged for the day (`runbook.md` → *Cutover*), and `docker run --rm
   <image>` prints `phb-co-engine image OK`; the suite runs inside the image
   (`tests/ci_suites.py`, or at least `tests/test_cutover.py` and
   `tests/test_intake_selection.py`) and passes (1.1, 1.2).
2. **The laptop's last runs land**: the 12:00 intake and the 13:00
   classifier (America/New_York) both write their report and summary
   (3.3). Read them.
3. **Disable the laptop's two scheduled tasks** in the Cowork app — disable,
   not delete; they are the rollback (4.1). Confirm the third, duplicate
   definition (`co-response-side-clasification`) carries no schedule.
4. **Read the live root once, as the reader app**: no fresh
   `.run_workflow.lock` (1.6); no `Bid Tracker.xlsx` in `Change Order
   Intake` (1.3); nothing in `1 - New Requests` mid-ingest.
5. **The parameters file**: `enableCoShadow` false (the shadow's three jobs
   go; the copy stays for the rollback month), `enableCoLive` true,
   `coLiveRoot`, `coLiveBidTrackerPath`, `coLiveMasterPath` filled,
   `coEngineImage` the day's tag, `containerImage` read from the running
   app as always. Deploy with the routine command; read the two job names
   back from the outputs (3.1).
6. **First cloud runs, by hand, before the schedule fires**: start the
   intake job, read its log — `FileStore : graph`, the root, **`LIVE
   TREE`**, the run report under `run_reports`, the state file naming the
   newest intake by name (1.1), the UTC stamps (1.4) — then the classifier
   job the same way (`run_summary.md` in the spec's locked format; the
   trackers read through the workbook API). Then leave the schedule to it.
7. **SharePoint, the same day**: apply the 2.3 and 2.4 text to the live
   spec; re-label the spec and the prompts as mirrors (2.1); the engine
   copies per disagreement 6.
8. **Record the day** in § 7 of this file: each item of § 1 as confirmed,
   with what was read.
9. **The rollback month** (4.1, 4.2): the laptop stays as it is, tasks
   disabled, nothing deleted; rollback is `runbook.md` → *Rolling the
   change-order engine back to the laptop*, written for someone with no
   background.
   The copy is deleted thirty days after this day (plan § 6).

## Where the documents disagree, or have gone stale

Found while gathering the list. Flagged here; the first two were corrected
in the same change that created this file, the rest are left for their
owners.

1. **Is cutover a repoint or a code change?** `docs/PHASE-13.md` says *"At
   cutover, the same job gets repointed — the schedule itself doesn't
   change."* `docs/phase-12-part-c-plan.md`, `runbook.md` and
   `co_filestore.py` say the Graph store refuses `CO Managment Process` by
   name at construction and at every call, and that removing that refusal
   is the Phase 14 change. Both are true of different layers, but a reader
   of PHASE-13 alone would expect to change one environment variable. **It
   is a code change, a new image and the repoint, in that order** (items 1.2
   and 3.1). PHASE-13 is not changed here; it should say so when Phase 13 is
   written up.
2. **Stale status lines, corrected 2026-10-28:** `docs/PHASE-12.md`'s Part C
   banner said two decisions were open before Phase 14, and
   `docs/phase-12-part-e-equivalence.md` said the flow-trigger decision
   was deferred and gates Phase 14. Both were true when written and not
   since 2026-10-28.
3. **"Run in parallel" versus "never run both against live."**
   `docs/06-roadmap.md` → *Phase 14* says to retire the laptop only after the
   centralized version *"has run correctly in parallel for a sustained
   period"*; `docs/PHASE-12.md`, the roadmap's own Phase 12 section and
   `HANDOVER.md` say never to run both against the live folders. They agree
   only if "in parallel" means the shadow run against the copy. Read it that
   way; the wording is left as is.
4. **"Byte-identical" versus "equivalent."** `docs/PHASE-12.md`'s Part C
   checklist box says byte-identical; the bar that was actually set and met
   is byte-identical once time-derived bytes are normalized, with Office
   files compared by structure. The box's tick text already says so; the
   heading wording is left.
5. **Line numbers in the inventory** refer to the pre-removal engine
   (`f8645b7`), which is what the laptop runs; the repository's line numbers
   have moved. Not a disagreement, but a trap for anyone diffing on the day:
   diff by function name, not by line.
6. **Does the SharePoint engine copy get replaced on the day?** Item 1.12
   says the live `render_qa_pdf.py` is replaced by the repository's "in the
   same step as the engine (item 1.1 and the `Change Order Step 2`
   scripts)"; item 4.2 says rollback is "the laptop's engine with the
   laptop's rules". Both cannot hold: a laptop that runs the repository's
   engine runs the new intake rule and no Bid Tracker write, and its task
   prompt copies two files where the repository's engine needs a third
   (`co_filestore.py`). **Decided 2026-11-02: no — the SharePoint copies
   are not replaced on the day.** The container carries its own
   engine and renderer; the SharePoint copies become the rollback engine,
   re-labelled as such and not authoritative (2.1), untouched for the month;
   when the laptop retires they are replaced or deleted with it. Then 1.12
   is moot and 4.2 is exactly right.
7. **Item 2.3 asks for the scheduled-task prompt to take the internal-sender
   rule at cutover; item 4.2 says rollback runs the laptop's rules.** After
   cutover the Cowork task is disabled and runs only as rollback, so editing
   it changes what rollback does. **Decided 2026-11-02: no — the task is
   not edited.** A rollback is the laptop exactly as it ran through the
   window, which is what 4.2 promises. The edit stays drafted in
   `docs/phase-14-spec-and-prompt-edits.md` § 2 so the decision can be
   reopened with the text in hand.
