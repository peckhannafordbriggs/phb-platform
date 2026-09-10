# Phase 12 Part B — verification record

What was done, what was measured, and what is still unproven. Companion to
`docs/12-ai-layer-inventory.md`, which is the inventory Part B was built from.

Engine work lives in `phb-co-engine`; Part B is commit `b32b23c`.

---

## What Part B changed

Every read, write, listing, copy, move, delete and workbook load in
`run_workflow.py` and `co_state.py` now goes through a `FileStore`. Two
implementations: `LocalFileStore`, which is what runs today, and
`GraphFileStore`, written and **not wired up**.

The 225 filesystem call sites were enumerated from the AST rather than grepped
for, so the work could be checked off a list instead of off memory. The
inventory's §2 and §3 tables still describe what the engine reads and writes;
what changed is only how it gets there.

**No logic changed.** Same order, same output. That claim is the whole of the
rest of this document.

### Deliberately not behind the interface

| | Why |
|---|---|
| Path arithmetic (`os.path.join`, `dirname`, `basename`, `splitext`) | String manipulation, not file access. The engine runs on Linux so these already produce forward slashes. Rewriting them would be a large diff buying nothing |
| `_glob_session_mount` | Finds where the store's root is mounted. Asking the store where the store is would be circular, and a Graph run never reaches it. A test asserts this is the **only** raw filesystem call left |
| Local scratch (`stage_*`) | Workbook writes stage outside the synced folder because OneDrive will otherwise observe a half-written file and merge the two versions into a corrupt blend; LibreOffice needs a real local file. Both stores need scratch — for Graph it is where a download lands on its way to LibreOffice — so it is store *methods* but explicitly not store *content* |
| In-memory validation | The base64 repair loads decoded bytes to check openpyxl can read them before writing anything, and the PDF path validates the staged local copy. Neither touches a store path. Both are in the test's `ALLOWED_RAW_CALLS` with reasons |

`--stage-dir` was added, defaulting to `/tmp` — what runs today. A container and
a test harness need somewhere else, and where a scratch file lives cannot affect
the bytes that land in the library.

---

## The two constraints

**`Bid Tracker.xlsx` is unreachable**, for reading as well as writing, since the
engine no longer has any reason to open it. Matched as a **substring**, not an
enumerated list of names — because the enumeration got it wrong on the first
attempt: `+++ PH+B BID TRACKER 2026 Edit.xlsx` was transcribed without the plus
in `PH+B` and so was not actually blocked. The new test caught that. The live
library also holds `.Bid Tracker.backup_*` and
`.Bid Tracker.broken_table_uid_*`, which a list would have to keep chasing.
Nothing the engine touches contains "bid tracker"; the report it owns is
`CO Status Tracker.xlsx`.

**The four sentinel filenames cannot be written by any ordinary write method.**
The two the engine legitimately writes require `allow_sentinel=` naming which one
is meant. A test asserts there are exactly two such call sites and that they name
the two expected constants. `transfer_ready.json` and `classification_result.json`
stay unlockable by any argument — Power Automate and the classifier own those.

That guard found its own bug, and the differential test is what surfaced it
rather than inspection: `write_text_via_tmp` authorised the destination but not
the rename that completes it, so **`vendor_drafts.json` never landed** and a
`.tmp` was left in the attempt folder — for exactly the complete-path COs, which
is the half of the pipeline that drafts vendor emails. A test now pins the rule
that a sentinel name plus a suffix is not a sentinel.

---

## Left alone on purpose

**The lock** is routed through the interface like any other file
(`create_exclusive`, `truncate_write`, `remove`) and **not fixed**. It still
fails open, one of its three outcomes is still "proceeding unlocked", and it
still coordinates only one machine — which the engine's own comment says. Part
C's protection is that the container points at a copy, not that the lock works.

**`scrub_timestamp` still ends in `Z` while holding local time.** Noted in the
store's docstring and in the differ, corrected nowhere. A UTC container will read
four hours off the laptop for the same instant; describing that is Part C's job,
not Part B's to change.

---

## Evidence

### Why the bar is differential, not just the fixtures

The A3 fixtures are Part B's stated bar. But they were captured across July to
September and the engine has legitimately moved in that window, so a fixture
mismatch on its own cannot separate *"the refactor broke something"* from *"the
engine changed"*.

So the primary evidence is differential: the pre-Part-B engine reconstructed
from git, both versions run over the same freshly-built tree from the fixture
inputs, outputs compared by `tests/co_output_diff.py`. Eight COs, chosen for
path coverage: the complete path, the returned-for-info path, the five-attempt
`CCHMC Bulletin 12` resubmission chain, both same-subject Bulletin 12
conversations, a CO carrying a P&ID attachment, and a ZZ test CO.

**All eight equivalent.** Every byte difference accounted for by class:

| class | files | what it is |
|---|---:|---|
| byte-identical | 12 | — |
| `NEWLINE` | 10 | CRLF→LF makes them byte-identical |
| `TIME` | 22 | identical after that plus blanking the A3 allowlist |
| `OOXML` | 40 | differing parts confined to `docProps/core.xml` |
| **`UNEXPLAINED`** | **0** | — |

None of the three classes is a behaviour change on Linux: `NEWLINE` is a no-op
there, `TIME` is the clock, `OOXML` is metadata the writer stamps — which Part A
measured on the live library, where two copies of one generated workbook shared
an mtime and differed in bytes.

### Against the A3 fixtures

6 of 14 artifacts reproduce **exactly** after time normalization. For **all 14**,
the pre- and post-refactor engines disagree with the fixture in *exactly the same
fields*. So where a fixture is not reproduced, the extraction is not why — the
unrefactored engine does not reproduce it either.

The reasons belong to the fixture set:

- A replay into a clean tree is always **attempt 01**, where a fixture was
  captured at attempt 03 or 06. Every field embedding the attempt number
  disagrees, `deliverables.attempt` included.
- Fixtures older than **2026-07-30** predate `submitter_note` and
  `reply_email.greeting_source`, and carry `null` where today's engine writes an
  empty string. Every fixture captured after those fields landed matches exactly.
- `CCHMC Bulletin 12`'s fixture note came from a different resubmission than the
  newest intake payload in the captured inputs.

I first hypothesised that fixture age alone explained everything. It does not —
the attempt-number effect is separate, and `greeting_source` changed value rather
than appearing. The check that tested the hypothesis refused to confirm it, which
is why it is stated this way here.

### One deliberate byte-level decision

Text goes out as bytes the caller encoded, never through Python's text-mode
newline translation. On Linux that is byte-for-byte what
`open(p, "w", encoding="utf-8")` did before, because `os.linesep` is `\n`. Off
Linux it is the same bytes instead of CRLF — which is the point, because Part C
requires the two stores to agree byte for byte and a store whose output depends
on the host's line-ending convention cannot. It is also why the differential test
can run on Windows at all. The run reports are the one place it shows, and the
differ reports it as its own class rather than folding it in.

### Reproducing it

`phb-co-engine/tests/replay_differential.py` reconstructs the baseline from git,
so the argument can be re-run rather than trusted:

```
python tests/replay_differential.py --fixtures <path to the A3 fixture store>
```

The fixtures are not in git. `tests/test_filestore_interface.py` and
`tests/test_no_bid_tracker_write.py` need no fixtures and run anywhere.

---

## What is NOT verified

**`GraphFileStore` has never run.** It is real code against the Graph Files API
— upload sessions for large files, server-side copy with the async monitor polled
to completion, `conflictBehavior=fail` for the exclusive create — and entirely
unexercised. Every phase of this project that touched an external system found
defects that mocked transports agreed with, and Graph Files will have its own
set. Open questions are marked `GRAPH-TODO` in place; the ones that matter:

- `append_bytes` is a read-modify-write with no atomicity. Graph has no append.
  The engine appends only to its two CSV audit logs and the lock means one
  writer, but Part C should confirm that still holds in a container.
- `create_exclusive` relies on a 409 from `conflictBehavior=fail`. It has not
  been measured for the race. It is no weaker than the lock it backs — which
  already fails open — but Part C must not describe it as a mutex either.
- `copy` polls an async monitor because the engine copies then immediately reads
  or removes the source. Whether the poll is genuinely settled before the next
  read needs a real library, not a fixture.
- `rglob` walks folder by folder. Correctness first; Part C should measure it
  against a deep tree before deciding whether a search query is worth the
  quirks.

**The refactored engine has not run on Linux.** Every measurement here was taken
on Windows under Python 3.12 with openpyxl 3.1.5 — the same openpyxl that
produced the live tracker, which is why workbook comparison is meaningful. The
engine's real environment is `python3` inside the Cowork sandbox. The
newline-class differences above exist *because* the harness ran on Windows and
would not appear on Linux; that is an inference from `os.linesep`, not a
measurement.

**Nothing ran against the live folders.** Every tree was built from the
gitignored fixture store into a scratch directory, and the live library was
untouched throughout.

---

## Related

- `docs/12-ai-layer-inventory.md` — the inventory this was built from, and the
  time-derived field list the differ implements
- `docs/PHASE-12.md` — the phase
- `phb-co-engine/AI Files/CO Intake Engine/co_filestore.py` — the interface
