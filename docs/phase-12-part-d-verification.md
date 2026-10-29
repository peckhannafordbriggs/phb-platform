# Phase 12 Part D — verification record

The record of what each Part D step built and what it was measured against,
in the order the steps landed. `docs/phase-12-part-d-plan.md` is the plan
this follows; `docs/phase-12-part-e-equivalence.md` Parts 2–4 are the bars
every replay below is scored by. Everything here is tagged the inventory's
way: **[observed]** was measured or read, **[decision]** was chosen.

---

## D0 — the fixtures, captured 2026-10-28

`phb-co-engine/tests/capture_classifier_fixtures.py`, run once, read-only,
against the synced live `Change Order Step 2` queue, into
`C:\Users\Msheth\phb-co-engine-fixtures\classifier\` — outside both
repositories, never committed, the A3 rules. **[observed]**

| | |
|---|---|
| Items with both a request and a result | **20**: `_to_classify` 4, `_processed` 7, `_needs_review` 1, `_archive` 8 |
| Results renamed by role | 20 → `response-classification-payload.json`; the store walked afterwards, **zero** trigger-shaped names |
| Attachment content | not captured — names and sizes only (`attachments.json`), because Part D sends the model filenames and nothing else |
| `_index` entries | 34 (18 `pm_thread`, 16 Gate B vendor sidecars) |
| Staging logs | 8 (`qa_log.*`, `completeness_log.*`) |
| Intake state records | 22 (`co_name`, `verdict`, `archived` only) |
| Trackers | as Excel **tables**, headers + rows: `COTracker` 32 rows × 22 columns; `ActiveBids` 16 × 19 (plus three other master tables) |
| Files, manifest, sha256 | 148, every one listed |

Two things the capture itself found, both worth knowing before any later
step reads the store:

- **Three of the twenty results are not classifier answers.** Two carry
  reasoning that says so in as many words — *"Synthetic result written
  directly by Claude at Alex's direction; no classifier run"* and *"FAKE
  TEST — simulated pm_thread index match for Flow 2 branch verification"* —
  and neither has a pm_thread index entry. The third (`ZZ MIG|PR-01`) is a
  real conversation-id match from 2026-07-16 whose tracker row **no longer
  exists**: the 2026-10-28 snapshot holds no such key and no row carries
  that conversation id. That is the plan's § 9a limit in a sharper form —
  test rows do get removed, so "rows are never deleted" holds for real COs
  and not for ZZ ones. All three are in `classifier/excluded.json` with the
  evidence beside each id; the replay processes them (the copy stays
  realistic) and does not score them. **[observed]**
- **The `COTracker` table range covers 18 blank rows** (`CO Key` empty).
  Every lookup ignores a row with no key, so nothing changes; the Graph
  workbook reader will see the same rows and must do the same. **[observed]**

Re-capture: run the tool again; it replaces the directory and the manifest
says when. Re-check `excluded.json` after every re-capture.

---

## D1 — the harness, 2026-10-28

`phb-co-engine` branch `feat/classifier-harness`. The package
`AI Files/CO Intake Engine/co_classifier/`, the store's third sanctioned
sentinel site, the capture tool, the replay instrument, and seven test
suites. No judgment is enabled under prompt version `2026-10-28.1`, which
holds only the shared preamble, so **D1 made no model call anywhere**.

### What is code now

Every rule in plan § 2a, in `rules.py` and `tracker.py`, each with a test
that states the rule as examples (`tests/test_classifier_rules.py`, 15):
the pm_thread first-check with the highest attempt winning; the three-signal
fallback; the conversation-id lookup on the lower-case `conversation IDs`
header, exact after trim; PA-confident acceptance; the duplicate-key rows;
open rows excluding closed and cancelled; "company already responded" by
address or company domain and never a generic provider; `increment_received`
true for quote and declined only and never for a revision or a repeat;
`mark_declined`; rename targets from the key and a sanitised company, with
` (2)` for a second file; the bid-leader email lookup, `Mark` → null; the
body excerpt that stops at a quoted reply; the note template; the locked
run-summary format with the Archive line last; `classified_utc` as true UTC.

Three conventions were taken from the laptop's own results rather than
from the spec, because the results are the bar **[observed]**: the note's
last line reads `Source: Change Order Step 2/_to_classify/<item>/` (the
spec's text says `CO Intake/`); an internal sender's `vendor.company` is
`PH+B (internal)`; a pm_completeness result carries `vendor.company: null`.
One laptop-only key, `classified_utc_note`, is not emitted; the differ will
need a listed rule for it (plan § 4).

### Two decisions D1 made and the plan did not

- **The pm-completeness fallback declines.** Spec § 2.0 step 4 says a
  subject-prefix hit with an internal sender and an awaiting-PM CO is
  `pm_completeness` at medium. Without an index entry the attempt and the
  `_staging/{project_token}/{bulletin_number}` location cannot be taken
  verbatim, and deriving them from a CO name is the re-derivation the spec
  forbids. So the result is `pm_completeness` / `subject_prefix` / medium
  with `needs_human = true`, reason `pm_completeness_fallback_unverified`,
  and no log append. None of the twenty fixtures takes this path.
  **[decision]**
- **A disabled bid-leader step yields null, not a decline.** The spec's own
  rule for an unresolved leader is "leave both null and move on"; the
  handoff still goes, unaddressed if need be. Treating the disabled step as
  a decline would make every quote `needs_human` for a field the spec
  itself leaves blank. **[decision]**

### What a pass does with nothing enabled

`tests/test_classifier_pass.py` (5) over a synthetic tree: the pm_thread
item is fully classified and its completeness log gains the synthesized
`returned_for_info` entry and the inbound entry, deduplicated; the
conversation-id and PA-confident items resolve and then decline as
`step_not_enabled` with label `other` / `low`; the cancelled CO is skipped
with no result and named in the summary; the duplicate CO Key declines
naming both rows' dates and respondents; the item with a result is skipped;
every `classification_result.json` in the tree sits in an item folder and
the single write site passes the constant; a dry run writes nothing, not
even the summary; the runtime trap with the package's modules as the engine
files records **zero** bypasses; and with a step enabled against a failing
transport the item is left unwritten, the pass continues, and the summary
says which item and why.

### The guards

- `tests/test_filestore_interface.py` (12) now scans the package too: every
  raw filesystem reference is allow-listed by file, function and name
  (`prompts.py`: the package's own prompt files; `render.py`: the
  renderer's script path and `subprocess.run`, the LibreOffice precedent),
  and there are **exactly three** sentinel write sites —
  `run_workflow.py:place_artifacts`, `run_workflow.py:write_vendor_drafts_json`,
  `co_classifier/orchestrator.py:apply_decision` — each by constant.
  `transfer_ready.json` still cannot be unlocked by anything.
- `tests/test_classifier_model.py` (10): the key resolves from
  `CO_ANTHROPIC_API_KEY` and the error names it; `ANTHROPIC_API_KEY` alone
  is refused; the request is one turn, structured output, no tools, the
  system text cached for an hour, `thinking` omitted; a schema failure is
  retried once with the failure as data and declines on the second; a
  refusal is its own outcome and is not retried; a transport error is
  logged with class and status and raised; the log line is the whitelist
  and nothing else, and a canary string in the body never reaches it.
- `tests/test_classifier_judgments.py` (8): with nothing enabled every
  judgment declines without a client; a step cannot be enabled before its
  prompt file exists; the email travels in labelled blocks and a closing
  tag inside the body is escaped; **an injected instruction obeyed by the
  model is refused by code** for match (a CO not among the open
  candidates) and for classify (a quote filename not among the attachments,
  a company carrying a path) — with the API absent, because the check is
  ours.
- `tests/test_classifier_schemas.py` (7): every judgment schema and the
  result schema are closed; the § 4.2 cross-field rules refuse what a
  schema cannot state (the full `quote` block, a low confidence without
  `needs_human`, a decline with a proposed count, a revision that
  increments, a rename target with a path, a pm result with a key).
- `tests/test_classifier_prompts.py` (5): the version matches its manifest;
  an in-place edit is a mismatch; no step is enabled under the first
  version.

**The image job caught the tests writing into the source tree
(2026-10-29).** The D1 branch's first CI run failed three suites with
`PermissionError` under `co_classifier/prompts/`: the judgment tests built
their throwaway prompt version inside the real prompts directory, and the
manifest test appended to the real `common.md` and restored it. The image
job mounts the checkout read-only, which is right — a test that crashed
mid-way would have left a real prompt file corrupted. The fix was to the
tests, not the mount: `prompts.use_prompts_dir()` is an explicit override
the tests enter with a temp copy of the directory, both tests work on the
copy and assert the real directory is untouched afterwards, and
`tests/ci_suites.py` now fingerprints the repo and the fixture store around
every suite (size and mtime per file, caches ignored) and fails any suite
that added, removed or changed a file, whatever its own summary says.
`tests/test_ci_tree_guard.py` (3) drives the guard and runs the runner over a
throwaway suite that writes beside itself to see it fail with *WROTE UNDER
THE REPO*. 21 of 21 suites pass on the laptop with the guard on.
**[observed]**

### The replay against the laptop

`python tests/classifier_replay.py --runs 1`, no step enabled, 2026-10-28.
**[observed]**

| | |
|---|---|
| Items processed | 20 (a fresh copy of the queue per run; the trackers' snapshot unchanged after the pass) |
| Excluded with evidence | 3 (above) |
| Scored | 17 |
| pm_thread items | **2, equivalent** on first-check, label, CO match and `needs_human` |
| conversation-id items | **4, equivalent** on CO match (the same key, the same method); label *not judged*; `needs_human` *more cautious* |
| everything else | 11: CO match *not judged* (the match step is off) or equivalent on both-null; `needs_human` *more cautious* or equivalent (the laptop's own declines) |
| FAIL rows | **0** |
| STOP rows (laptop declined, container decided) | **0** |
| Part 3 invariants | held: results only in item folders, no foreign sentinel, no temp file left, no count proposed under `needs_human`, no path in a rename target |

The report is written to `<work>/report.md`; the call log would be
`<work>/calls.jsonl` and is empty, because nothing was called.

### The command line

`python -m co_classifier --store local --root <copy> --bid-tracker-json … --dry-run`
over a copy of the fixtures: 20 decided, nothing written, the summary in
the locked format. The live Step 2 path as `--root` is refused by name
before anything is read. Enabling a step under the first version stops
with *no prompt file classify.md … cannot be enabled until its prompt is
written*. Enabling a step with only `ANTHROPIC_API_KEY` in the environment
stops with *CO_ANTHROPIC_API_KEY is not set … ANTHROPIC_API_KEY is another
module's key and is never used here*. **[observed]**

### What D1 does not prove

- Nothing about the model: no call was made. D2 makes the first.
- Nothing about Graph: the workbook-table reader is written from the API
  reference and unexercised, like `GraphFileStore` before Part C.
- No PDF was rendered: the renderer scripts are not in the image yet (D6),
  and a pass without them says so in its summary.
- The archive sweep is not ported; the Archive line says so.
- The `pm_completeness` fallback and the duplicate-key decline were
  exercised on synthetic items only; none of the twenty fixtures takes
  either path.

### Re-running D1's evidence

```
cd phb-co-engine
python tests/ci_suites.py                      # 20/20 suites; the replay SKIPS without the store
python tests/classifier_replay.py --runs 1     # with the store: the table above
python tests/capture_classifier_fixtures.py    # re-capture; then re-check excluded.json
```
