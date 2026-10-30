# Phase 12 Part E — verification record

The record of the shadow window: what was built to run it, what the window
saw week by week, every disagreement and what it turned out to be, the path
coverage table as it closed, and what the window proves and does not.
`docs/phase-12-part-e-plan.md` is the plan this follows (approved
2026-10-29, § 14 the decisions, § 15 the dates);
`docs/phase-12-part-e-equivalence.md` Parts 2–4 are the bars every verdict
below is scored by. Everything here is tagged the inventory's way:
**[observed]** was measured or read, **[decision]** was chosen.

---

## E1–E5 — what was built, 2026-10-29/30

All in `phb-co-engine` unless marked. Every suite green with the tree guard
on at each push; the counts are the CI runner's. **[observed]**

| Item | What | Where | Held by |
|---|---|---|---|
| E1 | the read-only reader of the live tree (GET only by construction, its own identity, the live folder named in one module) and what the feeder captures from it, renamed by role, attachment bytes never read | `co_shadow/reader.py`, `co_shadow/capture.py` | `tests/test_shadow_reader.py` (11); the static scanner covers the package |
| E2 | the batch on the copy's store from items and a snapshot, the pairing rule, the strip rule, the pass over it, Part 3's invariants over the store, STOP, rerun requests; the feed run; the spec mirror in the image | `co_shadow/batch.py`, `co_shadow/feed.py`, `infra/shadow-feed.sh` | `tests/test_shadow_feed.py` (10) |
| E3 | the scorer lifted into the package unchanged; the collector: the laptop's answers, the comparison, three re-runs once on a FAIL, STOP on the inverted row, the report and `WINDOW.md` | `co_shadow/score.py`, `co_shadow/collect.py`, `infra/shadow-collect.sh` | `tests/test_shadow_collect.py` (6); the replay's table test still holds the scorer |
| E4 | the intake half: a captured attempt replayed in a fresh tree with the Part C layout, both sides laid out alike, the differ's state-prefix rule (off by default) | `tests/shadow_intake_replay.py` (an instrument, beside the differ), `tests/co_output_diff.py` | `tests/test_shadow_intake.py` (5, one SKIPS without the fixture store) |
| E5 (`phb-platform`) | three jobs behind `enableCoShadow`, two identities, one secret, UTC crons for an EST window, nine plain values | `infra/main.bicep`, `infra/main.parameters.example.json`, `infra/README.md` | `tests/deploy-guards.test.ts` → *the Phase 12 Part E shadow run* |
| E6 (`phb-platform`) | this record; `runbook.md` → *The change-order shadow run*; `PHASE-13.md` corrected in place; `WHY-ITS-BUILT-THIS-WAY.md` § 76 | | the deploy guards' documentation scan |

**One finding on the way, from the real engine [observed].** The intake
replay's first run against the A3 fixture `CCHMC Bulletin 09` attempt 01
reported DIFFERS: the resend email greets a different person, the Action
Needed workbook carries a new name, and the Gate A payload's deliverables
fields moved. That is the engine of July against the engine of today, not
the instrument - the A3 capture predates engine edits the Part B
differential already accounts for - so the fixture test asserts the
instrument (both sides renamed by role, the payload paired, the state
compared under the prefix rule) and not EQUIVALENT. The window's bar is the
laptop's engine on the day, which is what the live replays compare.

**The one external dependency.** Request 6, the reader app registration
(`runbook.md` → *What to ask IT for*), sent 2026-10-29. Status: *(fill in)*.

---

## Day one

*(The first clean batch - items captured before a laptop run with a snapshot
that preceded it. Date, the copy's root, the image tag, the first report's
housekeeping lines: live items changed during the read, the first hand-run
read of the live Bid Tracker with its three fields before and after.)*

| | |
|---|---|
| Grant landed | |
| First hand-run tracker read: `eTag` / `cTag` / `lastModifiedDateTime` before → after | |
| Phase 11 table-binding check repeated | |
| Copy root, README deletion date | |
| Image | |
| `enableCoShadow` deployed | |
| First clean batch | |

---

## Week by week

*(One section per week: laptop run days seen, items scored, the verdict
totals, every FAIL and what it was, every STOP (expected: none), named
divergences counted, not-comparable causes counted, the intake replays and
their classes, spec drift, live items changed during reads, laptop silent
days, cost from the budget's actuals.)*

### Week 1

### Week 2

---

## Disagreements, one by one

*(Each FAIL or STOP: the item, the bar, both answers, the stability line,
what it turned out to be - unstable, scorer, bar, a named divergence added
by decision, a container defect fixed with its restart, or the laptop's own
defect - and the record pointer.)*

---

## Path coverage at close

| Path | Observed | Exercised synthetically | How |
|---|---|---|---|
| an incomplete PM submission | | | |
| a vendor reply that is not a quote | | | |
| an odd project number | | | |
| near-duplicate change orders | | | |
| a duplicate CO Key | | | |
| a reply before its CO exists | | | |
| a resubmission chain | | | |
| a PM completeness reply | | | |
| a decline on both sides | | | |

---

## What the window proves, and what it does not

*(Written at close. What it does not, known now: PDFs (no LibreOffice,
cutover item 1.7); the sweep on the live `_processed` set; the live Bid
Tracker read beyond the reader's own; the laptop's prompt, which the
shadow cannot see; any behaviour of the container on live timing.)*

---

## Closing

*(The date the floor was met, the owner's decision that the window is done,
and the deletion of the copy thirty days after cutover.)*
