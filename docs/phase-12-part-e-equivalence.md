# Phase 12 Part E — what counts as equivalent

> **Recovered 2026-10-28.** Written on 2026-09-22 on the branch
> `chore/request4-delegated-alternative` (tip `46383e2`), which was never
> merged; the rest of that branch had been re-applied elsewhere and this file
> had not. Last checked against what is true now on **2026-10-28**: the
> differ and tests on `phb-co-engine` `main` (`e36ecbb`),
> `docs/12-ai-layer-inventory.md`, `docs/phase-12-part-c-plan.md`,
> `docs/phase-12-part-b-verification.md` and `docs/13-needs-review.md`. What
> that check changed: Part 1's class table now matches the differ as written
> (there is no `OOXML` class; Office files are compared by structure; more
> than `content` fails a run); the SharePoint workbook rewrite that the first
> Part C comparison run hit is recorded, because it decides how Office inputs
> *and* outputs are verified; the timezone section carries the measurement
> and the still-open question beneath it; and Part 3 names the one sentinel a
> shadow classifier must never write. The judgment-by-judgment bars in Part 2
> were checked against the inventory's § 4c table and are unchanged. The
> Part C plan's step 6 still reads *"not started"*; this file is that step.

Written **before** any shadow run, deliberately. `PHASE-12.md`:

> Judgment steps won't be byte-identical — an LLM response varies. Define
> equivalence for those explicitly: the same classification, the same fields
> flagged, the same decision. Semantic equivalence is the bar, and what counts as
> equivalent needs writing down **before the comparison starts, not after a
> disagreement**.

That ordering is the whole point. A bar set after seeing a disagreement is a bar
set to accommodate it. Nothing in this file may be relaxed during a shadow run;
if it turns out to be wrong, change it in a commit that says so and restart the
window.

---

## First: most of this phase needs no semantic bar at all

`docs/12-ai-layer-inventory.md` § 4a is unambiguous, and it changes the shape of
Part E:

> `run_workflow.py` is **fully deterministic**. The scrub is fixed cell
> addresses, regex validators, and a nine-entry typo dictionary. `verdict` is
> computed, not advised.

So the thing Part C containerises contains **no model call**. Its output is held
to **identity after normalization**, not to semantic equivalence, and the
tooling for that already exists — `tests/co_output_diff.py` with the classes
below. Do not apply a "semantically equivalent" standard to engine output; there
is nothing stochastic in it, and a difference there is a defect by definition.

"Identity" means two different things depending on the file, and the differ
already knows which (inventory § 7c): **bytes** for the JSON payloads, the
state files, the run reports and the CSV logs, once the allowlisted
time-derived values are normalized; **structure** for Office files, because
SharePoint rewrites a workbook's bytes after every write and the bytes are not
the engine's to control. Part 1 has the detail.

Judgment lives in `co-response-classifier`, a **separate** scheduled task
(§ 1b, § 4c). Semantic equivalence applies to that and only that, and it is
Part D's output being compared, not Part C's.

| What is being compared | Bar | Tooling |
|---|---|---|
| Intake engine output (Part C container) | identical after time normalization — bytes for text and JSON, structure for Office files | `co_output_diff.py`; `compare_stores.py` drives it for the local-store / Graph-store comparison on the copy |
| Classifier output (Part D) | semantic, per the table further down | not built yet — Part D is not started |
| Cowork wrapper behaviours (§ 4d) | behavioural checklist | not built yet |

**What has actually been compared so far (as of 2026-10-28).** The Part B
differential — the engine before and after the file-access extraction, on the
same eight captured COs — has run on Windows and inside the Linux container,
and again after the Graph store's root jail was added: eight of eight
`EQUIVALENT` every time. The local-store / Graph-store comparison on the
SharePoint copy (`compare_stores.py`, Part C step 10) has been attempted twice
and has not yet compared anything: the first run failed on the workbook
rewrite below, the second on the instrument's own report directory. Both are
fixed; the third run is the owner's to start and had not been recorded when
this file was checked. No shadow run against live traffic has happened. Every
verdict in this file is still a prediction.

---

## Part 1 · The engine: identity, and the classes

A file lands in exactly one bucket. The differ's `equivalent` property is the
definition of a passing run, and it is **false** if any of the four failing
buckets holds anything.

| Bucket | Meaning | Verdict |
|---|---|---|
| in no class | identical after normalization — raw bytes equal for text and JSON; same `workbook_shape` / `docx_shape` for Office files, whatever the bytes did | pass |
| `newline_only` | a text file equal once line endings are collapsed, and **only** that | pass, but see below |
| `time_only` | a text file equal once time-derived bytes are normalized, line endings already equal | pass |
| `content` | anything else — including a workbook whose shape differs, a CSV whose rows differ beyond the timestamp column, a JSON delta at a listed path | **fail — investigate before continuing** |
| `unlisted` | a timestamp-shaped value **that differs** at a JSON path with no normalization rule | **fail — do not widen the regex to silence it** |
| only in one tree | a file present on one side and not the other | **fail** |
| could not compare | a read or parse error | **fail** |

There is no `OOXML` class. An Office file is read by content — `workbook_shape`
is cell values, number formats, fills, hyperlinks, table names and ranges,
column widths and sheet dimensions; `docx_shape` is the document text with the
engine's own `Date:` line normalized — and the parts that carry SharePoint's
and openpyxl's metadata (`docProps/`, `customXml/`, `[trash]/`,
`_rels/.rels`) are never looked at. Two workbooks with the same shape are
*identical* to the differ. Two with different shapes are `content`, reported
as *workbook content differs*. PDFs, `.eml`, `.zip` and images are compared
by bytes and fall into `content` if they differ.

Three rules about these that were learned rather than designed:

**`newline_only` appearing on Linux is itself a finding.** Both sides write
`\n` there, so the class should be empty. It appeared once because the class was
assigned on equality after a normalizer that erased line endings *and*
timestamps — a timestamp difference wearing a newline label. Fixed, and
`tests/test_diff_classes.py` pins it with six tests (line endings only,
timestamp only, both at once, real content, identical, and that neither
passing class affects the verdict). If it reappears on Linux, something real
is happening.

**`unlisted` exists to stop the comfortable fix.** A timestamp-shaped value at an
unknown path means either a new time-derived field (add it to `TIME_FIELDS_JSON`
*and* to `12-ai-layer-inventory.md` § 7b) or a genuine difference. Widening the
regex until the report is quiet destroys the only signal that would have caught
the second case. The differ's own report says the same thing under the heading
`UNLISTED TIME FIELD`.

**No Office file can be verified by bytes, in either direction.** Inventory
§ 7c measured it on the way out — the live tracker and its own `copy2`
snapshot share an mtime and differ in bytes — and the first Part C comparison
run (2026-10-21) measured it on the way **in**: of eight pristine workbooks
uploaded to the SharePoint copy, seven came back as different bytes, three
grown by exactly 3,095 bytes and **four the same size with different bytes**.
A size check would have missed half of them. The decision taken there holds
for Part E: Office inputs are verified by the differ's `workbook_shape`
fingerprint (`shape_sha256` in the copy's manifest), Office outputs are
compared by the same shape, and bytes decide for everything else. A shadow run
that compares a workbook's sha256 is wrong by construction, and a run report
that says a workbook *matched by bytes* should be disbelieved.

### The timezone shift is expected and must not be normalized away

Measured in Part C, at the same instant on 2026-09-22: the laptop
(`America/New_York`) emitted `2026-09-22T10:56:03Z` and the container (UTC)
emitted `2026-09-22T14:56:04Z`. `datetime.now()` is local and the `+ "Z"`
claims UTC, so the laptop's value has been wrong by the UTC offset — four hours
under EDT, five under EST — since the field was written, and the container's is
accidentally right. The same event therefore stamps four to five hours later
after the cutover, in three fields — `scrub_timestamp` (`scrub_result.json`),
`drafted_timestamp` (`vendor_drafts.json`) and `history[].at` in
`state/<CO>.json`. The first two are inside sentinel payloads that Power
Automate triggers on. Every other `datetime.now()` in the engine writes a naive
local time with no `Z`: those values move too, but they were never claiming
anything false.

For the differ this is a listed field, normalized away, and a run that differs
only here is equivalent. **But it must not be quietly absorbed into the
allowlist and forgotten**, because the open question underneath it is not a
formatting one: does anything downstream *read* those two values, or do the
flows only trigger on the filename? The Part C plan records this as **not yet
answered** and belonging to Part D/E, and says not to correct the `Z` before
knowing — changing the value and the runtime timezone in the same phase makes
the resulting diff unreadable. Until it is answered, the shift is a known
pending risk, not a settled non-issue. Record it in every run summary rather
than filtering it out.

A neighbouring question is **not** this one and has its own gate: whether a
Power Automate trigger fires on a file an application-only principal wrote
through Graph. That is the *Before cutover* section of the Part C plan,
deferred by the owner on 2026-10-21 and required before Phase 14. Part E
cannot answer it, because a shadow run writes nothing a flow watches.

---

## Part 2 · The classifier: equivalence, judgment by judgment

From inventory § 4c, whose table of judgments this follows. `needs_human` is
listed last because it governs all the others.

### PM completeness first-check — exact

Boolean. Is this inbound a PM completeness reply? A disagreement means the two
runs are processing the same message as different *kinds* of thing, so every
downstream comparison is meaningless. **Any disagreement fails the run.**

### Classification — exact label; confidence is a signal, not a bar

One of quote / question / answer / declined / other.

**The label must match exactly.** Not "both produced the same
`increment_received`" — that is a weaker bar that would let quote↔declined pass,
and the label itself lands in `tracker_update.classification_value`, which a
human reads on the tracker.

Confidence need not match. Log the pair; a systematic drift (the container
consistently less confident) is worth knowing even though no single case fails
on it.

**`increment_received` must match exactly, and is checked separately** even
though it is derived from the label — true for quote and declined only. It moves
a received count on the Bid Tracker. Checking it independently catches the case
where labels agree and the derivation has drifted.

### CO match — exact, including both-null

Which change order this reply belongs to. The inventory calls this the highest
consequence judgment: it decides which change order a vendor's money lands
against.

- Same CO → equivalent.
- Both declined to match (both null) → equivalent. Declining is a legitimate
  answer and the human path handles it — as of 2026-10-21, fourteen of the
  fifteen items the classifier had flagged were exactly this: a reply about a
  change order that did not exist yet (`docs/13-needs-review.md` § 5).
- One matched and the other did not → **not equivalent**, and this is the most
  serious disagreement Part E can produce. It is the one to stop on.

### Bid leader resolution — exact, including both-null

Which estimator receives the handoff. Same rules as CO match: both-null is
equivalent, one-null is not. Lower consequence — a wrong answer yields a null and
a human — but a *silently different* answer names the wrong person on a
handoff draft.

### Q&A extraction — structural automatically, content by a person

The only judgment whose output is free text in a vendor-facing document, so it
cannot be compared automatically and must not be waved through on a string
similarity score.

Automatable:
- the **same number** of question/answer pairs
- pairs in the **same order**
- each question mapped to the **same source** (message, attachment, page)

Not automatable — a person compares:
- whether each answer conveys the **same commitment**. Different wording is fine;
  a different obligation, price, date or scope is not.

Flag every Q&A extraction for human comparison. Do not sample: this is the one
output a vendor reads.

### `needs_human` — exact, and the asymmetry is the point

The safety valve for everything above.

| laptop | container | verdict |
|---|---|---|
| false | false | equivalent |
| true | true | equivalent — compare `review_text` for topic, not wording |
| false | **true** | container is *more* cautious. Not a failure. Log it; a pattern means the prompt moved |
| **true** | false | **FAIL, and stop the window.** The container is deciding where the laptop refused to |

That last row is the one thing in this document that should stop a shadow run
rather than be recorded and reviewed later. Every other disagreement is evidence;
this one is the safety property inverting.

`review_text` is free text. Compare topic, never wording. Since 2026-10-21 the
live pipeline also moves a refused item's folder into `_needs_review` beside the
note, and the Needs Review tab in the platform shows both; neither changes what
the judgment is or how it is compared.

### Draft composition — must remain absent

The inventory: *"There is no draft-composition judgment step to migrate at all."*

There is nothing to define here, and that is the definition: **if any model
output in Part D composes message text, the scope has been exceeded** and it is
a phase violation rather than an equivalence question.

---

## Part 3 · Structural invariants — checked every run, never negotiable

These are not equivalence questions. If any fails, the run is void and the work
stops, because the safety model rather than the migration has broken.

- `increment_received` remains a **proposal** inside the classification result
  that Power Automate applies. The model never touches Excel.
- No model output composes or sends an email. Every outbound message is drafted
  by a flow and sent by a human.
- No model output chooses a filename. The four sentinels are constants in code.
- No model output chooses a recipient.
- `Bid Tracker.xlsx` is never written.
- **A shadow run writes none of the four sentinel files into the live tree.**
  `classification_result.json` in particular is doubly load-bearing: it is a
  flow trigger, and its presence inside an item folder is what tells the live
  classifier an item has already been read (`docs/13-needs-review.md` § 9). A
  shadow classifier that wrote it would not merely fire a flow; it would
  silence the live classifier on that item.

---

## Part 4 · Model variance is not a migration defect

The same input can produce different output from the same model on two runs. So a
laptop/container disagreement has two possible causes and they need separating
before anything is "fixed".

**Before investigating any judgment disagreement, re-run the same input against
the container three times.**

- Container disagrees with **itself** → model variance. Record it, and treat the
  judgment as unstable rather than treating the laptop as right. An unstable
  judgment is its own finding: it means the prompt or the schema is
  under-constrained.
- Container agrees with itself and differs from the laptop → a real behavioural
  difference. Now `PHASE-12.md` applies: *"the laptop is right until proven
  otherwise."*

Do not tune the container to match a single disagreement. Three self-consistent
runs before touching anything.

---

## Part 5 · The Cowork wrapper behaviours (§ 4d)

Not model judgments, and easy to lose silently, which is exactly why they need a
checklist rather than a diff. Containerising "the engine" drops them unless
something asserts they survived:

- [ ] a truncated mount copy is detected and self-healed
- [ ] a corrupt tracker is treated as a non-event, not a failure
- [ ] the hold list is honoured
- [ ] the run summary is written

Each needs a deliberate exercise; none appears in an output diff, because when
they are missing there is simply no output to compare.

---

## Part 6 · Running the window

**Weeks, not days**, per `PHASE-12.md`. The pipeline sees cases that do not occur
daily — an incomplete PM submission, a vendor reply that is not a quote, a CO
with an unusual project number. The engine's own fixture set needed eight COs to
cover its paths; a week of live traffic may cover fewer.

**Track path coverage, not elapsed days.** The window is done when the rare paths
have actually occurred, and "three weeks with no returned-for-info case" means
the window has not tested the returned-for-info path no matter how long it ran.

Every run records: the bucket counts per file, which Office files matched by
shape while their bytes differed, every judgment pair with its verdict, the
timezone shift (present, expected), and any structural invariant check that
did not run.

**Phase 12 is complete when the container has produced equivalent output for a
sustained period and the disagreements are understood. Not when it runs.**

---

## Related

- `docs/PHASE-12.md` — the phase, and the instruction to write this first
- `docs/12-ai-layer-inventory.md` § 4 — where judgment actually happens; § 7b,
  the time-derived field list; § 7c, why Office files are compared by structure
- `docs/phase-12-part-c-plan.md` — what Part C settled: the timezone
  measurement, the workbook rewrite on upload, and the flow-trigger decision
  that gates Phase 14
- `docs/phase-12-part-b-verification.md` — the eight-CO differential and its
  classes
- `docs/13-needs-review.md` — what a refusal looks like on the live pipeline
- `phb-co-engine/tests/co_output_diff.py` — the buckets in Part 1, the
  `TIME_FIELDS_JSON` allowlist and `workbook_shape`
- `phb-co-engine/tests/test_diff_classes.py` — what stops the classes drifting
- `phb-co-engine/tests/compare_stores.py` — the local-store / Graph-store
  comparison on the copy, and the shape fingerprint for Office inputs
