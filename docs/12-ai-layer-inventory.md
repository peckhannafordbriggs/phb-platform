# The AI layer — inventory

Phase 12 Part A2. What the change-order engine actually reads, writes, and
decides, and which of its assumptions are about the machine it happens to run on.

Everything after this depends on this file being right, so every claim is tagged:

- **[observed]** — read out of the code, or measured against the live library.
- **[inferred]** — a reasonable reading that nobody has confirmed. Treat as a
  question, not a fact.
- **[not observable from here]** — needs the operator's machine or the Power
  Platform portal. Listed rather than guessed.

Written 2026-09-10, read-only against the live SharePoint library. Nothing ran
against the live folders; the two scheduled tasks were untouched and the
2026-09-10 07:00 run had already completed normally at 08:27 before this started.

---

## 0 · Where the code lives now (Part A1)

Repository **`phb-co-engine`**, created 2026-09-10 at `C:\Users\Msheth\phb-co-engine`.
Local only — there is no remote yet, because creating one under the
`peckhannafordbriggs` org needs GitHub credentials this session did not have.
**Pushing it is the one piece of Part A still outstanding.**

| Commit | What |
|---|---|
| `f8645b7` | `run_workflow.py` + `co_state.py`, unmodified, plus `.gitignore` and `.gitattributes` |
| `8ffbf3a` | The companions: docs, specs, the two scheduled-task prompts, the response-engine runtime |
| `61da407` | The Bid Tracker seeding removed, with a guard — the one deliberate logic change in Part B, §3b |

The first commit is a photograph and was verified as one rather than assumed:
`git hash-object` of each SharePoint file equals the blob in the commit, and
`git cat-file blob | cmp` against the live file is clean. **[observed]**

```
run_workflow.py   196,429 B   sha256 a7a230eae42fed948904bf90c412fb244b81b1f5f6b9726d794ca4b92872ffde
co_state.py        19,918 B   sha256 738c8f62e09ef7b5decd2503c3688363fdd1092c89e3ec9cd2bc90ece3a7ca9d
```

Both files are pure LF with no BOM **[observed]**, so `.gitattributes` pins
`* -text` before anything was staged. Git for Windows normalising line endings
would have left the working tree differing from the authoritative copy while
every hash still looked plausible.

Repo paths mirror the SharePoint tree exactly (`AI Files\CO Intake Engine\…`,
`Change Order Step 2\…`), so repo and library can be compared with a directory
walk. Only `.md`, `.py` and `.ts` were mirrored: the tree is a subset **by
extension**, never by edit. 124 files tracked — 122 mirrored, plus `.gitignore`
and `.gitattributes`; no workbook, PDF, `.eml`, `.zip`, run report, state file or
`bid_leaders.json`.

### The repo is not the runtime, and two filed copies are stale

`Change Order Step 2` is the response engine's **runtime** home. The copies filed
under `AI Files\CO Response Engine` are older: **[observed]**

| File | Runtime (Step 2) | Filed under AI Files | Verdict |
|---|---|---|---|
| `archive_handed_off_cos.py` | 14,259 B | 14,013 B | filed copy is byte-identical to the runtime's own `.bak-20260729` — it is the superseded 2026-07-29 version |
| `CO_Response_Agent_SKILL.md` | 64,889 B | 56,475 B | the filename already says `DEV HISTORY - STALE` |
| `render_qa_pdf.py`, `render_completeness_pdf.py`, `bid_leaders.json` | — | — | identical, no drift |

Both stale copies are committed at their real paths. A mirror that dropped them
would misrepresent what is on that disk. **Edit the Step 2 copies, never the
filed ones.**

---

## 1 · The two scheduled tasks, in order

They are **Cowork scheduled tasks** — Claude running on the operator's Windows
laptop with the SharePoint library mounted into a Linux sandbox at
`/sessions/<session>/mnt/…`. They are the **only scheduled actors in the whole
pipeline**; every Power Automate gate is event-driven off a sentinel file. If
these two tasks stop existing, nothing scrubs and nothing classifies and *there
is no error anywhere* — the pipeline just goes quiet. **[observed** — stated in
`docs/09_Scheduled_Task_Prompts_VERBATIM.md`, and consistent with the failure
mode `docs/02-existing-co-system.md` already records**]**

| Task | Cron | Human |
|---|---|---|
| `co-intake-scrub` | `0 7,12 * * 1-5` | 7:00 AM & 12:00 PM, Mon–Fri |
| `co-response-classifier` | `0 8,13 * * 1-5` | 8:00 AM & 1:00 PM, Mon–Fri |

A third task, `phb-estimating-call-daily`, exists but is disabled and belongs to
a different workflow. **[observed** in doc 09, verified live 2026-07-31**]**

### 1a · `co-intake-scrub`

1. Mount `CO Managment Process` via `mcp__cowork__request_cowork_directory`.
   Mounting the *parent* is deliberate: it grants the engine at
   `AI Files\CO Intake Engine`, the live data at `Change Order Intake`, and the
   transferred packages at `CO In Progress` / `CO Finalized` in one grant.
2. Copy `run_workflow.py` and `co_state.py` into a scratch workdir and check
   **both staleness and integrity** — `py_compile` plus a `grep` for the
   `JSON-first queue` design marker. The bash mount can serve a truncated,
   partially-synced copy; the documented self-heal is to re-read the file with
   the Read tool (which forces a fresh host-side download) and rewrite it into
   the workdir. **Never modify the original.**
3. Run `CO_REPORT_DIR="$ENG" python3 run_workflow.py --live-path "…/Change Order Intake" --sharepoint-root "…/CO Managment Process"`.
4. Summarise: COs processed with verdict and target folder, COs skipped, any
   WARN or failure. Run autonomously; ask nothing.
5. Honour a **hold list** of named COs to leave alone (`CCHMC Bulletin 09`,
   `CCHMC RFI 169` as of the captured prompt). The engine already skips them
   because their verdict is set, so the list is belt-and-braces.

Note what is *not* in that command line: neither `--scan-text` nor
`--language-flags`. **The scheduled intake run contains no model judgment at
all** — see §4. **[observed]**

### 1b · `co-response-classifier`

1. Read the spec at `Change Order Step 2\CO_Response_Agent_SKILL.md` first.
   Where prompt and spec disagree, **the spec wins**.
2. For every item folder under `_to_classify\` (each is one inbound email:
   `classify_request.json`, `body.txt`, attachments), skipping any that already
   has a classification result:
   - **PM completeness first-check.** Compare the item's `conversation_id`
     against the `pm_thread` index files in `_index\`, exact match only. On a
     hit the CO identity is taken **verbatim** from the index entry and never
     re-derived; append to the completeness log, regenerate its PDF, emit the
     §3.4 contract, and skip steps below.
   - **Classify** into exactly one of quote / question / answer / declined /
     other, with confidence high/medium/low. Dominant intent wins; the
     secondary goes in `secondary_intents[]`.
   - **Match the CO** by inbound `conversation_id`, else by body inference.
     Read `Bid Tracker.xlsx` **read-only** to validate. No confident single
     match → `needs_human`, never a guess.
   - **Resolve the bid leader** by fuzzy-matching the CO against the read-only
     master tracker, then looking the first name up in `bid_leaders.json`. No
     confident match, or an ambiguous name, → null.
   - **Append to the Q&A log** for question/answer items and regenerate
     `qa_log.pdf` via `render_qa_pdf.py`.
   - **Write the classification result** into the item folder, exactly per §4.2.
3. Run the **archive step every pass**, even on an empty queue:
   `CO_STEP2_ROOT=… python3 archive_handed_off_cos.py`.
4. Overwrite `run_summary.md` in the locked format. The `Archive:` line is
   always last and always the script's own output verbatim.

Its hard rules, verbatim in intent: never send email; never move files between
`_to_classify` / `_needs_review` / `_processed` or into final Bid Docs (Power
Automate owns all queue moves — the archive sweep into `_archive\` is the one
sanctioned exception); never edit either tracker; never modify the `_index\`
files; ask rather than guess. **[observed]**

---

## 2 · Everything the engine reads

All paths relative to the live root, `CO Managment Process\Change Order Intake`,
unless stated. **[observed]** throughout unless tagged.

| Read | Where | Why |
|---|---|---|
| `intake.json` / `intake_*.json` | `1 - New Requests\<CO>\` | The queue source Power Automate Gate A writes. Both fixed and timestamped names accepted; newest wins |
| The intake workbook (`*.xlsx`) | `1 - New Requests\<CO>\` | The 22-field Gate A scrub reads fixed cells |
| `state\<CO>__<hash>.json` | `state\`, `state\Archive\` | **The work queue and the state record.** Filename is a sanitised CO name plus 8 hex of `sha1(exact name)`, so two CO names that sanitise alike cannot collide |
| `CO Status Tracker.xlsx` | live root | Legacy pending-row fallback during the JSON transition, and `co_state.py`'s drift diagnostic |
| `.Tracking_lastgood.xlsx` | live root | Restore source when the tracker is found corrupt |
| `Bid Tracker.xlsx` | resolved at runtime, see §3b | Read to locate the `COTracker` table before appending. **This is a write path, not a read-only one** |
| `ReadyForTransfer\<CO>\` | live root | Presence ⇒ Gate B done |
| `CO In Progress\<CO>\`, `CO Finalized\<CO>\` | one level **above** the live root | Presence ⇒ Gate C done (transferred). Legacy fallback `BidDocs_Sandbox\<CO>\` |
| `draft_written.json` | anywhere under the transferred dir, `rglob` | Presence ⇒ Gate D done |
| The `vendor_drafts` payload it just wrote | attempt dir | Re-read as the canonical source for the Bid Tracker seed, so the row cannot disagree with what Power Automate will draft |
| `--language-flags` JSON | caller-supplied | Advisory language-review flags, `{co_name: [{sheet,cell,text,reason}]}` |
| `.run_workflow.lock` | live root | Lock holder / staleness |
| `1 - New Requests\_parse\` | live root | Stale staging files to sweep |

The transferred-package check reaches **above** the live root. That is why the
scheduled task mounts the parent and passes `--sharepoint-root`.

---

## 3 · Everything the engine writes

### 3a · The load-bearing filenames

Four filenames are the pipeline's entire contract with Power Automate. A file
appearing in a watched folder with one of these **exact** names *is* the trigger;
`scrub_result (1).json` triggers nothing and reports no error.

| Filename | Fires | The engine's relationship to it |
|---|---|---|
| `scrub_result.json` | Intake 2 — PM resend draft | **Written**, once, `run_workflow.py:2899`, into the attempt dir |
| `vendor_drafts.json` | Intake 3 — vendor drafts + tracker seed | **Written**, once, `write_vendor_drafts_json` at `:2684`, called from `:2907`, complete COs only |
| `transfer_ready.json` | Intake 4 — builds the SharePoint CO folder | **Never written.** Power Automate writes it, into the same attempt folder — see the warning below |
| `classification_result.json` | Response 2 — tracker + quote filing | **Never written** by this engine. The classifier writes it |

So the engine writes exactly two of the four, each in exactly one place, both
inside a per-attempt directory. **[observed]**

> **`transfer_ready.json` shares a folder with the engine's own artifacts.**
> Anything that copies an attempt directory copies a live trigger out with it.
> This is not theoretical: the first pass of the A3 fixture capture carried nine
> `transfer_ready.json` files into the fixture store under their real name before
> the pass was redone with all four names covered. Any tooling in Parts B, C and
> E that walks an attempt directory needs the same guard.

### 3b · The write that a hard prohibition forbids

`CLAUDE.md` prohibition 4 and `docs/02-existing-co-system.md` both say
`Bid Tracker.xlsx` is never written from code, because Power Automate binds to
the Excel `ListObject` and a library rewrite regenerates the internal table IDs —
the file still looks right and the flow silently stops resolving the table.

**`run_workflow.py` contained code that did exactly that.** **[observed]** It has
since been removed — see the resolution at the end of this section. What follows
describes it as Part A found it, and every line number is from the pre-removal
engine (`phb-co-engine` `f8645b7`); the laptop still runs that version until the
Phase 14 cutover.

`seed_response_bid_tracker` (`:2434`) loaded the workbook with `openpyxl`,
appended a `collecting` row, **re-set `tbl.ref` to extend the table over the new
row**, and saved through `atomic_save_xlsx` — a full workbook rewrite. It wrote a
rolling `.BidTracker_pre_seed_backup.xlsx` next to the tracker first. It was
gated on `RESPONSE_AGENT_INTEGRATION = True` (`:145`), documented as a one-line
kill switch. Failures were swallowed and never blocked Gate A.

**It was unreachable, which is the only reason it was not already a problem.**
`_resolve_bid_tracker_path` (`:2416`) tried exactly two candidates:

1. `CO_BID_TRACKER_PATH`, defaulting to
   `~\OneDrive - Peck Hannaford + Briggs\Documents\Claude\Projects\Change Order Intake\Bid Tracker.xlsx`
   — a retired OneDrive location; the OneDrive copy was retired 2026-07-20.
2. `dirname(live_path)\Change Order Intake\Bid Tracker.xlsx`, which resolves to
   *inside* the intake folder.

Neither exists. **[observed]** — checked both, and the only `Bid Tracker.xlsx`
anywhere under `CO Managment Process` is in `Change Order Step 2`, which neither
candidate points at. The function returned
`skipped — Bid Tracker.xlsx not reachable`.

Supporting evidence that it is genuinely dormant rather than merely quiet: no run
report mentions the seed at all — the string appears in 0 of 159 reports — and no
complete CO has been scrubbed in the reported window. **[observed]** Evidence it
did once run: `.BidTracker_pre_seed_backup.xlsx`, a name only this code writes,
sits in `CO Response Engine\_archive\06_Data_Backups\`. **[observed]**

And the failure it would cause has a name on disk. `Change Order Step 2` contains
`.Bid Tracker.broken_table_uid_2026-07-31_1003.xlsx` alongside
`.Bid Tracker.backup_2026-07-31_1003.xlsx` — a broken table UID, preserved and
repaired at the same minute. **[observed]** That this particular code caused that
particular break is **[inferred]**; the timestamps and the failure mode match,
but the repair is not attributed in anything I read.

**Resolved — removed in `phb-co-engine` `61da407`.** Reported by Part A, then
removed on an explicit decision as **the one deliberate logic change in Part B**,
in its own commit so the FileStore extraction stays a pure refactor. The
reasoning for making it an exception: leaving it makes the Part B acceptance
criterion unmeetable, and routing the seed through the FileStore would satisfy
the letter of "the tracker is unreachable through the interface" and none of its
intent, because the harm is the workbook rewrite rather than the plumbing that
reaches it.

Gone: `seed_response_bid_tracker`, `_resolve_bid_tracker_path`, the three
`BID_TRACKER_*` constants, the `CO_BID_TRACKER_PATH` override and the call site.
Kept deliberately: `RESPONSE_AGENT_INTEGRATION`, which gated **two** things —
the seeding *and* the vendor-email subject prefix. Deleting the constant would
have silently changed every vendor subject line; it now gates the prefix alone.
Also kept byte for byte: `vendor_roster` and `co_key` in the `vendor_drafts`
payload, because Power Automate seeds that tracker row from the payload and
always could. The seed was a second writer of a row Power Automate already owns.

**No output bytes change**, verified by reading rather than asserted: the removed
code's only effects were the workbook write, its backup copy, a
`_meta["bid_tracker_seed"]` key and a stdout line. `_meta` is never serialized —
both `json.dump` sites write a separately-built `payload` dict with no `_meta`
member — and that key had no reader, which is why the string appears in 0 of 159
run reports. The §7 fixtures remain the bar for Part B, unmoved.

Guarded by `phb-co-engine/tests/test_no_bid_tracker_write.py`: five checks, no
third-party dependencies. It fails if a path to that workbook reappears, if a
`BID_TRACKER`-shaped identifier is defined, if `CO_BID_TRACKER_PATH` is read, or
if any workbook write targets a destination outside an explicit allowlist — so a
new `.xlsx` write anywhere in the engine becomes a reviewed act. It asserts it
actually scanned the files it means to, and it carries two canaries: a synthetic
module that must trip every check, and a prose sample that must trip none,
because the engine legitimately writes *"here's how it's logged in our Bid
Tracker"* into the PM reply email and the first version of the guard flagged it.
The hazard is a path, not the words. Run against the pre-removal blob from
`f8645b7` it reports 11 violations, catching the original at five independent
layers.

**Two things remain true of production.** SharePoint stays authoritative until
the Phase 14 cutover, so the laptop still runs the version carrying this code —
the path is removed from the repo lineage Parts B–E build on, not yet from the
machine. Until cutover the live mitigation is operational and unchanged: do not
set `CO_BID_TRACKER_PATH`, and do not put a `Bid Tracker.xlsx` into
`Change Order Intake`. And Part C must not mount the library such that either
retired candidate path resolves.

### 3c · Everything else written

| Written | Where | Notes |
|---|---|---|
| `state\<CO>__<hash>.json` | live root | Atomic: `mkstemp` + `fsync` + `os.replace`, same directory. Append-only history, capped at 50 entries |
| Gate A artifact set | attempt dir | `Intake Form.xlsx`, `Review.xlsx`, `Review.docx`, `Action Needed.xlsx`, `Action Needed.docx`, `Vendor Copy.xlsx`, `Resend Email.html`, `CO Request - … - {Review,Vendor Copy,Action Needed}.xlsx` |
| `Language Review Notice.txt` | attempt dir | Only when language flags were passed in |
| `CO Status Tracker.xlsx` | live root | Rebuilt from `state\` every run from a **fresh `openpyxl.Workbook()`**. The engine is its only writer, so merge conflicts are structurally impossible |
| `.Tracking_lastgood.xlsx` | live root | `copy2` snapshot after a good regenerate; also heals a missing table in place first |
| `Corrupt Tracking\<name>_<ts>.xlsx` | live root | The broken tracker is parked before restoring from lastgood. The engine does not *cause* that corruption |
| `<tracker>.b64orig_<ts>` | live root | A tracker that arrives base64-encoded is decoded in place and the original parked. Validated as a real workbook before overwriting |
| `Duplicates_Log.csv` | live root | Append. Header `Marked At,CO Name,Reason,Canonical Row` |
| `Cleared_Rows_Log.csv` | live root | Append. Timestamp + the 12 tracker columns. **Written before any row is deleted; if the log write fails, the rows are not removed** |
| `run_reports\Workflow_Run_Report_<YYYY-MM-DD_HHMM>.md` | `CO_REPORT_DIR` | Best-effort — see §5 |
| `.run_workflow.lock` | live root | See §5 |
| A rendered `.pdf` | attempt dir | LibreOffice headless, optional |
| `/tmp` staging files | `/tmp` | Every workbook and PDF write stages outside the synced folder first |
| Archive moves | `…\Archive\` inside each bucket, `state\Archive\` | `shutil.move`, deliberately: on the synced library a plain delete is the risky operation |

Deletes are best-effort by design: OneDrive frequently refuses `os.remove` with
`Operation not permitted`, and every such site catches and continues. **[observed]**

---

## 4 · Where a model makes a judgment call

This is the part Part D replaces, and the honest answer reorders Part D's
suggested sequence.

### 4a · The intake engine makes none

`run_workflow.py` is **fully deterministic**. **[observed]** The scrub is fixed
cell addresses (`REQUIRED_FIELDS`, 22 of them), regex validators, and a
nine-entry typo dictionary — `nad→and`, `teh→the`, `recieve→receive` and six
more. "Yellow = Claude-touched" is a *colour legend* describing which cells the
automation edited, not a model call. `verdict` is computed, not advised.

### 4b · Language review — an optional, unwired handoff

The one model hook in the engine is a two-pass handoff:

- `--scan-text` dumps each pending CO's intake-form text as JSON and exits.
  Read-only, no lock, no writes.
- a model reads that and writes `{co_name: [{sheet,cell,text,reason}]}`
- `--language-flags <path>` feeds it back; flagged cells are highlighted orange,
  a `Language Review Notice.txt` is written, and **the CO still advances**.

**Decides:** whether a PM's wording is unprofessional or sensitive to put in
front of a vendor. Purely advisory — it changes highlighting and adds a notice,
never the verdict or the routing. **[observed]**

**The scheduled task does not use either flag.** **[observed]** So this hook is
dormant in production. That makes it the lowest-consequence thing in Part D by a
wide margin — and also means replacing it proves very little, because nothing
currently depends on it.

### 4c · The classifier is where all the judgment actually is

Every real model decision in the pipeline is in `co-response-classifier`:

| Judgment | Decides | Consequence if wrong |
|---|---|---|
| PM completeness first-check | Is this inbound a PM completeness reply? | Wrong log, wrong CO identity |
| Classification | quote / question / answer / declined / other, + confidence | Feeds `tracker_update.classification_value` and `increment_received` (true for quote and declined only) — a wrong call moves a received count |
| CO match | Which CO this reply belongs to | A reply filed against the wrong change order |
| Bid leader resolution | Which estimator gets the handoff | Wrong person named on a handoff draft |
| Q&A extraction | What goes in the Q&A log and its PDF | Wrong content in a vendor-facing document |
| `needs_human` + `review_text` | Whether to refuse to decide | The safety valve for all of the above |
| Draft composition | Nothing — see below | — |

Two structural safety properties already hold and must survive Part D:
`increment_received` is a **proposal** inside the classification result that
Power Automate applies — the model never touches Excel; and no model output
composes or sends an email. Every outbound message is drafted by a flow and sent
by a human.

**Revised Part D ordering, per A2 rather than assumption:** language review is
lowest-consequence but nearly meaningless to migrate; the real first step is
**bid leader resolution** (narrow, schema-shaped, a wrong answer yields a null
and a human), then **classification**, then **CO matching** (highest
consequence — it decides which change order a vendor's money lands against).
There is no draft-composition judgment step to migrate at all.

### 4d · Judgment the Cowork wrapper adds, which the container must reproduce

The scheduled task prompts carry operational judgment that is not in either
script and would be silently lost by "containerise the engine": detecting a
truncated mount copy and self-healing it, deciding a corrupt tracker is a
non-event, honouring the hold list, and writing the run summary. **[observed]**

---

## 5 · External dependencies

| Dependency | Used for | Fails how |
|---|---|---|
| `openpyxl` (3.1.5 observed in generated file metadata) | Every workbook read and write | Hard requirement |
| `python-docx` | The human-readable summary | **Optional** — falls back to a plaintext `.txt` |
| `co_state.py` | The queue itself | **Hard** — `main()` raises `SystemExit` if the import fails |
| `libreoffice` binary, headless | `xlsx → pdf` | Optional — returns `None`, workflow continues |
| `reportlab` | The classifier's Q&A and completeness PDFs | Needed by `render_qa_pdf.py` / `render_completeness_pdf.py` |
| `/tmp`, writable | Staging for **every** workbook and PDF write | See §6 |
| The Cowork mount `/sessions/*/mnt/<name>` | Path discovery | Glob; session names change every run, so nothing is hardcoded |
| OneDrive sync client | Getting SharePoint onto local disk | The source of most defensive code here |
| ~~`Bid Tracker.xlsx` + its `COTracker` table~~ | Was the dormant seed. **No longer a dependency of the engine** — removed, §3b. Still a dependency of the laptop's copy until Phase 14 | §3b |
| Master tracker, sheet `Active Estimates`, table `ActiveBids` | Bid leader lookup, read-only | Classifier |
| `bid_leaders.json` | First name → email | **Not in git** — real names and addresses |
| Two Office Scripts in a personal OneDrive | Intake 1 | Pre-existing single point of failure, recorded in `docs/02` |

**The lock is best-effort and is not a mutex.** `acquire_run_lock` has three
outcomes, and one of them is `(True, None)` — *proceeding unlocked*, logged as a
warning. Any failure to manage the lock file lets the run continue, deliberately,
so lock infrastructure can never wedge the pipeline. A lock marked `released` is
reclaimed immediately; an unreadable one is treated as stale; anything older than
30 minutes is reclaimed, and if OneDrive blocks the delete it is claimed by
overwriting in place. The code says so in as many words: *"Same-machine only —
OneDrive sync lag means it does not coordinate across two different machines."*
**[observed]**

That sentence is the load-bearing one for Phase 12's rule that two instances must
never run against live at once. **The lock will not enforce it.** What protects
the pipeline in Part C is that the container points only at a copy, exactly as
the phase doc says.

**The run report is not a run log.** `detect_report_dir()` returns `None` when
nothing resolves, and `write_summary_report` then writes nothing while the run
completes normally. **[observed]** A missing report does not mean a missing run —
which matters for Part E, where "diff the run reports" presumes they exist.

Observed cadence, from the 159 reports on disk: the afternoon run lands
12:03–12:05 against a 12:00 cron, every weekday, reliably. The morning run has
drifted — 07:04–07:10 through 2026-08-06, then 07:48–09:19 from 2026-08-07
onward, up to +2h19m past its 07:00 cron. Weekdays with no morning report:
2026-08-10 through 08-13, 08-18, 08-24. 2026-09-07 has a single 19:01 run.
**[observed]** Whether those are late fires, absent fires, or runs whose report
write was skipped is **[not observable from here]** — a Cowork task only fires
while the app is running, which would explain drift **[inferred]**.

---

## 6 · Windows and environment assumptions

The important surprise: **the engine does not run on Windows.** It runs as
`python3` inside the Cowork Linux sandbox, against the OneDrive-synced Windows
folder surfaced at `/sessions/<session>/mnt/…`. **[observed]** — `/tmp` staging,
`/sessions/*/mnt` globs, and the task prompts' `python3` invocations all agree.
Part C is therefore not a Windows→Linux port; it is a change of *how the files
are reached*, which is exactly the Part B seam.

| Assumption | Where | Consequence |
|---|---|---|
| **`/tmp` exists and is writable** | `atomic_save_xlsx` `:470`, `render_xlsx_to_pdf` `:1735`. Hardcoded, no fallback | On a bare Windows host `/tmp` resolves to `C:\tmp`; the stage write raises and `atomic_save_xlsx` turns it into a `RuntimeError`. Every workbook write would fail. The intake prompt already warns `/tmp` may not be writable and to use a workdir under the outputs mount **[observed]**; the engine has no such option **[observed]** |
| **`/sessions/*/mnt/<name>` layout** | `_glob_session_mount` `:377` | Auto-detection returns nothing outside Cowork. The scheduled task passes `--live-path` and `--sharepoint-root` explicitly, so it does not rely on the glob |
| **`~\OneDrive - Peck Hannaford + Briggs`** and **`~\Peck Hannaford + Briggs\AI Sandbox - Documents`** | `:107`, `:116` | Derived from `expanduser("~")` **on purpose** — "derive the base from the current user instead of baking in a specific person." The library name is identical for every PH+B user |
| **`C:\Users\Aaichele\…` hardcoded in code** | `archive_handed_off_cos.py:47`, `DEFAULT_STEP2_ROOT` | The one place that *does* bake in a person, against the pattern `run_workflow.py` follows and against `CLAUDE.md` prohibition 6. Overridable by `CO_STEP2_ROOT` or `--root`, and the scheduled task sets `CO_STEP2_ROOT` **[observed]** — so it is a latent, not active, failure. **The operator leaves in December 2026; when that account goes, this default breaks** |
| **`C:\Users\Aaichele\…` hardcoded in both task prompts** | `Schedlued\*\SKILL.md` | Same problem, in the prompts. `docs/09` supplies *portable* rewrites that resolve the root per-machine, and says the hardcoded ones were superseded 2026-08-04 |
| **OneDrive refuses deletes** | ~10 `os.remove` sites, the lock, the Inbox sweep | Every one catches and continues. Not a bug — the platform behaviour that shaped this code |
| **OneDrive can serve a truncated file** | Task prompt step 2 | The reason for `py_compile` + design-marker verification before every run |
| **Windows path constraints in state filenames** | `co_state._safe_name` | Non-alphanumerics → `_`, trailing dots stripped, 80-char cap, plus 8 hex of `sha1` of the exact name so sanitisation cannot collide |
| **Backslash paths in config, forward slashes in output** | throughout | Good news: paths *inside* the sentinel payloads are relative to the live root with forward slashes — `3 - Ready for Vendor Pricing/CCHMC RFI 229/01/Intake Form.xlsx` **[observed]**. Nothing environment-specific leaks into the flow contract, so Part B has one fewer thing to normalise |
| **`CO Managment Process`, one A** | everywhere | Do not fix it. Every flow depends on the literal |
| **Line endings** | both engine files | Pure LF, no BOM. Pinned in `.gitattributes` |

---

## 7 · The output contract (Part A3)

### 7a · What was captured

20 real past runs, read-only, into **`C:\Users\Msheth\phb-co-engine-fixtures`** —
deliberately **outside** the `phb-co-engine` working tree, so no `git add -f` or
stray `git init` can reach it. `phb-co-engine/.gitignore` covers `fixtures/`,
`_fixtures/`, `*.json` and `*.xlsx` as well.

`MANIFEST.json` records, per file: source path, original filename, byte length
and sha256. `README.md` in that directory explains the rules to the next person.

| | Count |
|---|---|
| Runs | 20 — 9 complete, 11 returned for information |
| Output artifacts | 129 |
| Sentinel payloads | 38 |
| With the resulting state file | 19 |
| With the matching run report | 20 |
| With replay inputs (`intake_*.json` + workbook) | 14 |

Chosen for path coverage, not convenience: the five-attempt `CCHMC Bulletin 12`
resubmission chain, **both** Bulletin 12 conversations with the byte-identical
subject line, the old-template case whose answers sit five rows higher, a CO with
an attached P&ID PDF, the two COs currently held awaiting resubmission, and six
runs across four ZZ-prefixed test COs — the only ones safe to replay against
anything live, because of the ZZTEST fence.

**No file in the store is named like a flow trigger.** All four names are
renamed by role on capture and the original recorded as data. This was not
belt-and-braces: the first pass covered only the two names the engine writes and
carried nine `transfer_ready.json` files out under their real name. The store was
rebuilt and a guard now asserts zero.

### 7b · Which bytes are time-derived

Measured by scanning the captured fixtures, not by reading the source, so the
list is evidence:

| Artifact | Field | Source |
|---|---|---|
| `scrub_result` payload | `scrub_timestamp` | `datetime.now()` at `:2845` |
| `vendor_drafts` payload | `drafted_timestamp` | `:2385` |
| `vendor_drafts` payload | `vendor_emails[].subject`, `.body` | The due date, rendered `MM-DD-YYYY`, inside vendor-facing text |
| `transfer_ready` payload | `completed_at` | Power Automate, not the engine |
| `state.json` | `created_at`, `updated_at`, `history[].at`, `extra.archived_at` | `co_state.py:302` and `:3505`, `:3549`, `:3631` |
| run report | filename `…_<YYYY-MM-DD_HHMM>.md`, and the `#` heading | `:2988`, `:2991` |
| run report | body — reclaimed-lock and archive lines | Embeds prior-run timestamps |
| `CO Status Tracker.xlsx` | `docProps/core.xml` → `dcterms:created`, `dcterms:modified` | Exactly two fields. Zip member mtimes are pinned to 1980-01-01 by openpyxl and are **not** a source **[measured]** |
| CSV logs | `Cleared At`, `Marked At` | `:805`, `:1310`, `:3409`, `:3621` |
| `.run_workflow.lock` | `started`, `released_at` | Not an output artifact, but it changes every run |
| Backup filenames | `Corrupt Tracking\…_<ts>`, `.b64orig_<ts>` | `:599`, `:871` |

Not time-derived, and not otherwise nondeterministic: `co.due_date` and
`due_date_display` come from the PM's form, and `os.getpid()` / `abs(hash(dest))`
appear only in `/tmp` staging filenames, never in output. **[observed]**

### 7c · Two traps that make naive byte-comparison wrong

**The `Z` is a lie.** `scrub_timestamp` and `drafted_timestamp` are
`datetime.now().isoformat() + "Z"` — **local** time labelled UTC. `CCHMC RFI 229`
reads `2026-08-19T08:51:20Z` and its run report is `2026-08-19_0851`; August in
Cincinnati is UTC−4, so the real UTC instant was 12:51. **[observed]** A Part C
container running in UTC will produce timestamps four hours off the laptop's for
the *same instant*. **That is not drift, and a differ that parses these as UTC
will report it as one.**

**An Office artifact read back from the library is not the bytes the engine
wrote.** SharePoint stamps a generated workbook after the write. Measured on the
live tracker: `CO Status Tracker.xlsx` and its own `.Tracking_lastgood.xlsx`
snapshot — a `copy2` of it — share an mtime to the second (2026-09-10 08:27:23)
and **differ in bytes**, 14,944 vs 14,918, different sha256. Both declare
`Openpyxl 3.1.5` as their generator. The live copy carries an extra
`MediaServiceImageTags` property in `docProps/custom.xml`; both carry a
SharePoint `ContentTypeId`, `customXml/item1-3`, and four orphaned
`[trash]/*.dat` parts. **[observed]** That the injection is SharePoint's column
metadata is **[inferred]**, but the drift itself is measured — and it happens
*without any run*, so a fixture can go stale sitting still.

**Therefore: compare workbooks structurally — cell values, table ref, column
widths, fills — never byte-wise.** Byte comparison is sound for the JSON
payloads, the state files and the run reports, and only those.

### 7d · The decision: normalize in the differ, do not pin the clock

**Normalize.** Recorded here with the reasoning, because A3 asks for the decision
and not just an option.

1. The clock is read in 20+ places, including the lock file, two backup filename
   patterns and the report filename. Threading an injectable clock through all of
   them is engine surgery, and Part B's whole constraint is that nothing changes
   but file access.
2. Part E compares a live container run against a live laptop run at *different
   wall-clock instants*. A pinned clock cannot help there. The differ has to
   normalize regardless, so building it once serves B, C and E.
3. Pinning would **hide** the `Z` defect. Normalizing surfaces it.

Two requirements on that normalizer, both consequences of §7c:

- It carries an **explicit allowlist** of time-derived fields — the table in §7b
  — and **fails on any timestamp-shaped value it has no rule for**. A new time
  field must break the diff rather than pass silently.
- It compares Office artifacts structurally and JSON, state and reports
  byte-wise after normalization. Nothing in it should treat a `Z` suffix as UTC.

---

## 8 · What I could not observe, and what still needs an answer

**[not observable from here]**

- The scheduled tasks' actual configuration. It lives in the Claude app on the
  operator's machine under a different Windows account. The
  `Schedlued\*\SKILL.md` copies I committed hardcode `C:\Users\Aaichele\…`, so
  they correspond to the pre-2026-08-04 originals, **not** to the portable
  rewrites `docs/09` tells a new operator to paste. Which text the scheduler
  sends today is unconfirmed. Part D versions prompts in the repo — it needs to
  know which of the three representations is live first.
- Whether `CO_BID_TRACKER_PATH` is set in the scheduled tasks' environment. This
  still matters: the repo no longer reads that variable, but the laptop runs the
  pre-removal engine until Phase 14, and if the variable is set there, §3b is
  armed rather than dormant *on the machine that actually runs the pipeline*.
  The prompts do not set it **[observed]**, but the app's own environment is not
  visible from here. **Worth checking on the operator's machine before Part C.**
- Whether the 2026-08-10..13, 08-18 and 08-24 report gaps are late fires, absent
  fires, or skipped report writes.
- Who repaired the broken Bid Tracker table on 2026-07-31, and what wrote it.

**Decided**

- The dormant `Bid Tracker.xlsx` write in §3b: **removed**, as the one
  deliberate engine-logic change in Part B, with a guard that fails if it comes
  back. See §3b for what went, what was kept, and what is still true of the
  laptop until the Phase 14 cutover.

**Outstanding in Part A**

- Push `phb-co-engine` to the `peckhannafordbriggs` org. The repo, the ignore
  rules and all three commits exist locally; only the remote is missing.

---

## Related

- `docs/02-existing-co-system.md` — what must not break, and why
- `docs/PHASE-12.md` — the phase this inventory serves
- `WHY-ITS-BUILT-THIS-WAY.md` — the decisions behind the constraints above
- `C:\Users\Msheth\phb-co-engine-fixtures\README.md` — the fixture store's own rules
