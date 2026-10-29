# Phase 14 — Cutover checklist

**This is the one list for cutover day.** Everything that any document in
either repository says must happen at, before or after the moment the cloud
engine takes over from the laptop is gathered here, each item with the
document it came from. Nothing on this list was invented for it: if an item
has no pointer, it does not belong here. When a source document changes, change
the item; when an item is done, mark it here and leave the source as the
record of why.

Status as of **2026-10-28**: Phase 12 Parts A, B and C are complete, Part D
and Part E are not started, Phase 13 is not started, and the two decisions
Part C left were both closed on 2026-10-28. Nothing in Part C gates this
phase. What gates it is the sequence below.

Read `docs/06-roadmap.md` → *Phase 14* for the goal, `docs/PHASE-12.md` for
what cutover is not (it is not Phase 12), and `docs/PHASE-13.md` for the
schedule that cutover repoints.

---

## 0 · What has to be true before cutover day

| # | Item | Source |
|---|---|---|
| 0.1 | Phase 12 Part D is done: the Cowork judgment steps replaced one at a time, lowest consequence first, every model response schema-validated, no model output naming a file, choosing a recipient or triggering a send | `docs/PHASE-12.md` → *Part D* |
| 0.2 | Phase 13 is done: the container runs against the **copy** on the laptop's schedule, with failure and silence alerts, and the runbook entries written in that phase | `docs/PHASE-13.md` → *Where this sits in the sequence*, *Part C — Operations* |
| 0.3 | Phase 12 Part E is done: **weeks** of shadow running against the copy, every disagreement investigated, the laptop right until proven otherwise, equivalence for the judgment steps defined in writing before the window started (it is: `docs/phase-12-part-e-equivalence.md`). "Phase 12 is complete when the container has produced equivalent output for a sustained period, and the disagreements are understood. Not when it runs." | `docs/PHASE-12.md` → *Part E*; `docs/06-roadmap.md` → *Phase 12* |
| 0.4 | The shadow run never wrote any of the four sentinel files into the live tree, and the one stop-the-window condition in the equivalence doc (the container deciding where the laptop refused) never fired | `docs/phase-12-part-e-equivalence.md` → *Part 2* (the stop-the-window row under `needs_human`), *Part 3 · Structural invariants* |
| 0.5 | The open question under the timezone shift is answered: does anything downstream **read** `scrub_timestamp` or `drafted_timestamp`, or do the flows only trigger on the filename? Belongs to Part D/E; must be known before the value moves (item 1.4) | `docs/phase-12-part-c-plan.md` → *The timezone discrepancy: measured, and it is three fields*; `docs/phase-12-part-e-equivalence.md` → *The timezone shift is expected and must not be normalized away* |

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
| 1.6 | **The lock.** It is a lock file through the FileStore interface, best-effort, fails open, coordinates one machine, and is not a mutex. "Whether the mechanism should change at all is a Phase 14 question, decided at cutover with the live path in view." Decide it; until then it must not be described as mutual exclusion anywhere | `docs/PHASE-12.md` → *Part C* (the lock paragraph); `WHY-ITS-BUILT-THIS-WAY.md` § 42; `docs/12-ai-layer-inventory.md` → *The lock is best-effort* |
| 1.7 | **PDF rendering.** The comparison image carried no LibreOffice, so `render_xlsx_to_pdf` returned `None` on both halves and no PDF was compared; the laptop's run produces one. Phase 14's image decides whether to install it, and if it does, the two-store comparison must be re-run with it on both sides | `docs/phase-12-part-c-verification.md` → *What this does not prove* |
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
| 4.1 | **Keep the laptop path documented as rollback for at least a month after cutover.** Retire it only after that | `docs/06-roadmap.md` → *Phase 14*; `HANDOVER.md` → *Moving the AI layer off the laptop* |
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
| 6.1 | **The `PnP.Powershell` certificate on the `phb-co-engine` app registration** — a second way to be the engine app, private key on an IT workstation, valid to 2029-10-19. Production authenticates through the managed identity only. Ask Vitis to remove it, or record why not. Nothing has been asked yet | `runbook.md` → *Open decision — the `PnP.Powershell` certificate*; `docs/phase-12-part-c-plan.md` → *Step 7, second pass* |
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
