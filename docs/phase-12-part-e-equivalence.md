# Phase 12 Part E — what counts as equivalent

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
to **byte-identity**, not to semantic equivalence, and the tooling for that
already exists — `tests/co_output_diff.py` with the classes below. Do not apply a
"semantically equivalent" standard to engine output; there is nothing stochastic
in it, and a difference there is a defect by definition.

Judgment lives in `co-response-classifier`, a **separate** scheduled task
(§ 4c). Semantic equivalence applies to that and only that, and it is Part D's
output being compared, not Part C's.

| What is being compared | Bar | Tooling |
|---|---|---|
| Intake engine output (Part C container) | byte-identical after time normalization | `co_output_diff.py` |
| Classifier output (Part D) | semantic, per the table further down | not built yet |
| Cowork wrapper behaviours (§ 4d) | behavioural checklist | not built yet |

---

## Part 1 · The engine: byte-identity, and the four classes

A file falls into exactly one class. Only `content` fails a run.

| Class | Meaning | Verdict |
|---|---|---|
| identical | raw bytes equal | pass |
| `newline_only` | equal once line endings are collapsed, and **only** that | pass, but see below |
| `time_only` | equal once time-derived bytes are normalized, line endings already equal | pass |
| `OOXML` | differing parts confined to `docProps/core.xml` | pass |
| `content` | anything else | **fail — investigate before continuing** |
| `unlisted` | a timestamp-shaped value at a path with no normalization rule | **fail — do not widen the regex to silence it** |

Two rules about these that were learned rather than designed:

**`newline_only` appearing on Linux is itself a finding.** Both sides write
`\n` there, so the class should be empty. It appeared once because the class was
assigned on equality after a normalizer that erased line endings *and*
timestamps — a timestamp difference wearing a newline label. Fixed, and
`tests/test_diff_classes.py` pins it. If it reappears on Linux, something real
is happening.

**`unlisted` exists to stop the comfortable fix.** A timestamp-shaped value at an
unknown path means either a new time-derived field (add it to `TIME_FIELDS_JSON`
*and* to `12-ai-layer-inventory.md` § 7b) or a genuine difference. Widening the
regex until the report is quiet destroys the only signal that would have caught
the second case.

### The timezone shift is expected and must not be normalized away

Measured in Part C: the laptop emits local time carrying a `Z` suffix, the
container emits real UTC. The same event therefore stamps four to five hours
apart across the cutover, in three fields — `scrub_timestamp`
(`scrub_result.json`), `drafted_timestamp` (`vendor_drafts.json`) and the
`state/<CO>.json` history.

For Part E this is `time_only` and passes. **But it must not be quietly absorbed
into the allowlist and forgotten**, because the open question underneath it is
not a formatting one: does anything downstream *read* those two values, or do the
flows only trigger on the filename? Until that is answered, the shift is a known
pending risk, not a settled non-issue. Record it in every run summary rather than
filtering it out.

---

## Part 2 · The classifier: equivalence, judgment by judgment

From § 4c. `needs_human` is listed last because it governs all the others.

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
  answer and the human path handles it.
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

`review_text` is free text. Compare topic, never wording.

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

Every run records: the class counts per file, every judgment pair with its
verdict, the timezone shift (present, expected), and any structural invariant
check that did not run.

**Phase 12 is complete when the container has produced equivalent output for a
sustained period and the disagreements are understood. Not when it runs.**

---

## Related

- `docs/PHASE-12.md` — the phase, and the instruction to write this first
- `docs/12-ai-layer-inventory.md` § 4 — where judgment actually happens, and § 7b,
  the time-derived field list
- `docs/phase-12-part-c-plan.md` — what Part C settled, including the timezone
  measurement
- `phb-co-engine/tests/co_output_diff.py` — the classes in Part 1
- `phb-co-engine/tests/test_diff_classes.py` — what stops them drifting
