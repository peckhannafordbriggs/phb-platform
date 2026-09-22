# Phase 12 Part C — plan, and what has been settled so far

Companion to `docs/PHASE-12.md`, which is the phase, and
`docs/phase-12-part-b-verification.md`, which is what Part C inherited.

Engine work lives in `phb-co-engine`. This file is the reasoning; that repo is
the code.

---

## Why this file exists

`PHASE-12.md` says Part C **needs** Azure and `Sites.Selected`. Read literally
that blocks the whole part on a request to Vitis. It does not: `Sites.Selected`
gates talking to one SharePoint site with an *application* identity, and most of
Part C is neither about that site nor about an application identity.

The split below is the useful one. It was worth writing down because the natural
reading of the phase doc costs weeks of waiting for a permission that only the
last step actually needs.

---

## Settled, by measurement

### The engine runs on Linux, and the extraction holds there

Part B's evidence was taken entirely on Windows under Python 3.12 and openpyxl
3.1.5. Its own *What is NOT verified* section says so: *"The refactored engine
has not run on Linux."* The engine's real runtime is `python3` in a Linux
sandbox, so every Part B conclusion carried that caveat.

It does now. `phb-co-engine/Dockerfile` builds the environment and
`tests/replay_differential.py` runs inside it:

```
  CCHMC Bulletin 09   EQUIVALENT      CCHMC RFI 187   EQUIVALENT
  CCHMC Bulletin 12   EQUIVALENT      CCHMC RFI 229   EQUIVALENT
  CCHMC Bulletin 13   EQUIVALENT      CCHMC RFI 238   EQUIVALENT
  CCHMC RFI 169       EQUIVALENT      ZZ PR-98        EQUIVALENT
```

All eight, on Linux, with no unexplained differences. Part B's central claim —
the extraction changed nothing — now holds on the platform the engine actually
runs on rather than the one it was tested on.

### The NEWLINE inference was right, and its label was wrong

Part B predicted its 10 `NEWLINE`-class files would vanish on Linux, reasoning
from `os.linesep`, and marked it an inference. **The prediction holds.** But the
first containerised run reported one file *"differing only in line endings"* — on
Linux, in a file containing no CR byte, which cannot be true. It did not
reproduce across four later runs.

The cause is a defect in the differ rather than flakiness.
`co_output_diff.normalize_text()` erases line endings **and** timestamps, and
`newline_only` was assigned on equality *after* that. So any difference the
normalizer erased landed in a class naming only one of the two possible causes.
A baseline/current pair straddling a minute boundary produces exactly that: the
run report's header carries the minute it was written in.

Demonstrated rather than argued — `tests/test_diff_classes.py`, six cases:

| input pair | before | now |
|---|---|---|
| differ by one minute, zero CR bytes | `newline_only` | `time_only` |
| differ by line endings only | `newline_only` | `newline_only` |
| differ by both at once | `newline_only` | `time_only` |
| differ by real content | `content` | `content` |

**This matters more for Part E than for Part B.** Part B's verdict is unchanged —
every file involved was equivalent either way. But Part E is nothing except weeks
of difference classification, and a class labelled "line endings" that also
catches timestamps invites a reader to wave away a real difference as a known
harmless one. Fixed before the shadow run starts, not after.

A consequence for the record: Part B's reported `NEWLINE 10` on Windows may have
included time-only files. On Windows both effects were present simultaneously, so
nothing could have distinguished them at the time.

### The timezone discrepancy: measured, and it is three fields

Part B left this: *"`scrub_timestamp` still ends in `Z` while holding local time
… A UTC container will read four hours off the laptop for the same instant;
describing that is Part C's job."*

Measured at the same instant:

| | emits | true UTC |
|---|---|---|
| laptop (`America/New_York`, `-0400`) | `2026-09-22T10:56:03Z` | `14:56:03` |
| container (`UTC`, `+0000`) | `2026-09-22T14:56:04Z` | `14:56:04` |

`datetime.now()` is local; the `+ "Z"` claims UTC. On the laptop the suffix is
wrong by the UTC offset — four hours under EDT, five under EST. **In the
container it becomes accidentally correct**, because the container's local time
*is* UTC.

Three fields do this, and two of them are in sentinel payloads:

| field | written into | trigger? |
|---|---|---|
| `scrub_timestamp` (`run_workflow.py:2735`) | `scrub_result.json` | yes — a flow trigger |
| `drafted_timestamp` (`run_workflow.py:2398`) | `vendor_drafts.json` | yes — a flow trigger |
| history `now` (`co_state.py:311`) | `state/<CO>.json` | no |

Every other `datetime.now()` in the engine writes a naive local time with **no**
`Z`. Those are ambiguous but not mislabelled, and the container changes their
value too — they are simply not claiming anything false about it.

**What this is not:** a container bug. The container is right and the laptop has
been wrong since the field was written. **What it is:** a value change at
cutover. The same event stamps four to five hours later after the move, in three
fields, two of which reach Power Automate.

**Not yet answered, and it belongs to Part D/E rather than here:** whether
anything downstream *reads* those two values, as opposed to merely triggering on
the filename. The flows trigger on filename — `CLAUDE.md` and
`docs/02-existing-co-system.md` are consistent on that — but "the flow triggers
regardless" is a different claim from "nothing consumes the value", and only the
second one makes this harmless. Do not correct the `Z` before knowing which:
changing it and changing the runtime timezone in the same phase makes the
resulting diff unreadable.

---

## The three buckets

### 1 · Needs nothing from anyone

| | state |
|---|---|
| Containerise the engine | **done** — `Dockerfile`, `requirements.txt`, `.dockerignore` |
| Run the engine on Linux | **done** — all eight COs equivalent |
| Settle the NEWLINE inference | **done** — confirmed, and the class renamed |
| Describe the timezone discrepancy | **done** — measured above |
| `--store` selection seam | **done** — `--store local\|graph`, defaulting to local |
| Container cannot reach the live library | **done by construction** — see below |
| Part E equivalence definitions | not started — desk work, and `PHASE-12.md` says to write them *before* comparisons begin |

### 2 · Buildable now, verifiable on a substitute drive

`GraphFileStore.__init__(drive_id, token_provider, session=None, …)` takes a
drive id and a token *callable*. It has no idea whether that drive is a
SharePoint document library or a OneDrive for Business drive: `/drives/{id}/root:/path:`
is the same API surface for both. So the transport can be debugged against any
drive a developer can already reach.

| | state |
|---|---|
| URL construction for the real path names | **done** — `tests/test_graph_url_shapes.py`, 7 cases, no network |
| Conformance harness | **done** — `tests/store_conformance.py`, 15/15 against `LocalFileStore` |
| Run it against a real drive | **blocked on Vitis** — see below. This was expected to need only a token; it does not |

What the conformance harness targets, matching the four `GRAPH-TODO`s:
`append_bytes` (read-modify-write, Graph has no append), `create_exclusive` (the
409 from `conflictBehavior=fail`), whether `copy`'s async monitor is genuinely
settled when it returns, `rglob`'s cost by depth, and the upload-session path
above 4 MB.

**The substitute-drive route needs a grant too, which was not the original
reading.** The plan assumed a developer could obtain a delegated token
unaided and exercise `GraphFileStore` against their own OneDrive with nobody's
permission. Tried on 2026-09-22, and neither route exists in this tenant:

- Graph Explorer requires **admin consent** before issuing a token carrying any
  Files or Sites scope.
- `az account get-access-token --resource https://graph.microsoft.com` returns a
  token with **neither** scope, so it cannot address a drive at all.

So the distinction between "blocked on a token" and "blocked on a permission"
collapses: both need Vitis. What survives is the *size* of the ask —
**delegated** `Files.ReadWrite.All` for one person is far smaller than an
application-level `Sites.Selected` grant, is bounded by that person's own
access, and expires in an hour. It is item 2 of `runbook.md` → *Request 4*.

`Sites.Read.All` was offered as an alternative and would unblock only half:
it is read-only, and the operations most likely to surprise are writes — the
exclusive create behind the lock, the chunked upload above 4 MB, the
server-side copy, the move and the delete. Worth taking if it is easier to
approve, but it does not close step 5.

**What a substitute drive cannot settle**, and must not be written up as if it
had: SharePoint-specific behaviour — list view thresholds, library throttling,
and whether a server-side copy settles the same way on a document library as on
a OneDrive drive. That last one is the `GRAPH-TODO` least likely to transfer.

### 3 · Genuinely blocked

| | why |
|---|---|
| `GraphFileStore` byte-identical to `LocalFileStore` **as an acceptance criterion** | only the real target library counts |
| *"Graph metadata changes verified not to affect flow triggering"* | needs a SharePoint copy **with a trigger watching it** — see below |
| `rglob` against a deep real tree | the measurement is about the real library's shape |

**The flow-triggering check has a problem beyond permissions.** Verifying it
needs a copy site *and* a flow watching that copy, which means creating a
twelfth flow. Prohibition 2 forbids modifying, disabling, re-authorizing or
exporting the eleven; creating a new one on a copy is not literally any of those,
but it is close enough to the line to be a decision rather than an assumption.
`PHASE-12.md` says *"verify that rather than assuming it"*, so no amount of
reasoning closes it. Worth settling early — it is the acceptance criterion most
likely to be discovered late.

---

## Why the container cannot reach the live library

Not the lock file. Part B is explicit that the lock still fails open, still has
"proceeding unlocked" among its outcomes, and still coordinates a single machine.

Three things, none of which is a lock:

1. **No mount.** The engine derives its default roots from `expanduser("~")` and
   a OneDrive folder that does not exist in the image. `detect_live_path()` globs
   `/sessions/*/mnt/…`, which is also absent. Nothing is reachable unless
   somebody mounts it.
2. **Graph mode auto-detects nothing.** `--store graph` *requires* both
   `--drive-id` and `--live-path`, and `--drive-id` has no default — there is no
   value it could fall back to that is not somebody's real library. Both must be
   typed.
3. **Fixtures are mounted read-only** and never enter an image layer;
   `.dockerignore` denies by default for the same reason `.gitignore` does.

---

## Sequence

1. ~~Dockerfile and requirements~~ — done
2. ~~Differential inside the container~~ — done; settled Linux, the NEWLINE
   inference, and the differ defect
3. ~~Write up the timezone finding~~ — done, above
4. ~~`--store` seam~~ — done
5. ~~Define Part E equivalence for the judgment steps, in writing, first~~ —
   done, `docs/phase-12-part-e-equivalence.md`. Deliberately written *before*
   any comparison runs, per `PHASE-12.md`: deciding what counts as equivalent
   after seeing a disagreement is how a bar gets moved to fit.
6. **Exercise `GraphFileStore` against a drive** — waiting on Request 4 item 2.
   `CO_GRAPH_TOKEN=<token> python tests/store_conformance.py --store graph
   --drive-id <id> --root "/conformance-scratch"`. Expect findings; Part B's own
   warning is that every external system in this project produced defects that
   mocked transports agreed with.
7. When `Sites.Selected` lands: re-run 6 against the real library, then the
   byte-identical comparison and the flow-trigger check

Steps 1–5 are complete without anybody granting anything. Steps 6 and 7 both
need Vitis — 6 needs one delegated scope for one person, 7 needs the
application grant.

---

## Related

- `docs/PHASE-12.md` — the phase, and the acceptance criteria this plans against
- `docs/phase-12-part-b-verification.md` — what Part C inherited, including the
  four `GRAPH-TODO`s
- `docs/12-ai-layer-inventory.md` — §7b is the time-derived field list the differ
  implements
- `runbook.md` → *What to ask IT for* → *Request 3* — the Sites.Selected request,
  with the delegated alternative
