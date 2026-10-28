# Phase 12 Part C — verification record

The two-store comparison reached its acceptance bar on 2026-10-28: on the
fifth run, `20261028-155543`, the change-order engine produced **equivalent
output through `GraphFileStore` and `LocalFileStore` for all eight fixture
COs**, with both halves reading the same intake file for each of the three
COs that have two. This file is the record: what the bar was, what ran, the
five runs including the four that failed and why, what the result proves,
what it does not, and what was kept and deleted afterwards.

Companion to `docs/phase-12-part-c-plan.md`, which holds the reasoning run by
run, and `docs/phase-12-part-b-verification.md`, which is what Part C
inherited. The instrument is `tests/compare_stores.py` in `phb-co-engine`.

Every figure below is from the instrument's own transcript of the run, saved
before the scratch copy was deleted (*Artifacts*, at the end). Where
something is inferred rather than observed, it says so.

---

## The bar

`docs/phase-12-part-e-equivalence.md`, written 2026-09-22 before any
comparison ran: two trees are equivalent when every file is byte-identical
once **time-derived bytes** are normalized — the timestamps the engine
stamps into state files, run reports and CSV rows, and the run report's own
filename. Workbooks and Word documents compare by structure (cell values,
formats, fills, table ranges, widths; paragraph text), because SharePoint
rewrites Office files on upload (inventory §7c). The differ,
`tests/co_output_diff.py`, names a surviving difference by class: *content
differs*, *unlisted time field*, *only in A/B*, *could not compare*; and
reports two classes that do **not** break equivalence: *differ only in line
endings* and *differ only in a timestamp*.

Both halves run in one container from one image, so Python, openpyxl, the
clock's zone and the absence of LibreOffice are the same on both sides. The
store is the only variable.

## What ran

| | |
|---|---|
| Engine | `phb-co-engine`, branch `feat/graph-store-root-jail`, tip 1e77037 at the fifth run |
| Image | `phbplatprodovwzv7.azurecr.io/phb-co-engine:part-c-compare-6`, `INCLUDE_LIBREOFFICE=false` |
| Job | `phbplat-prod-co-compare`, a manual Container Apps job in `phbplat-prod-env`, identity `phbplat-prod-identity`, 1800 s timeout, 0.5 CPU / 1 GiB |
| Identity to SharePoint | the `phb-co-engine` app registration (`Sites.Selected`, Write on the AI Sandbox site), reached by a federated credential naming the platform's production identity — `--graph-auth federated`; no secret anywhere |
| Inputs | `/phb-co-engine scratch/part-c-copy-2026-10-21/pristine/` — the eight fixture COs' replay inputs (an intake workbook, one or two `intake_*.json`, attachments where the CO had them), uploaded 2026-10-21, manifest refreshed 19:56 UTC that day with structural fingerprints |
| Per CO | inputs re-downloaded and verified against the manifest; a Graph tree built by server-side copy under `runs/<id>/<tag>/CMP/`; a local tree in `/tmp` from the same bytes carrying the Graph copy's mtimes; the engine run once with `--store local` and once with `--store graph`, each confined to its own `CMP`; the Graph tree downloaded; both trees diffed |
| Output of a run | `runs/<id>/compare-transcript.txt` (everything printed, in order), `runs/<id>/_logs/<tag>-{local,graph}.log` (each engine's whole stdout and stderr), the eight Graph trees in place |

## Five runs

| # | Date (UTC) | Run id | Image | Execution | Outcome | What was wrong, and whose fault |
|---|---|---|---|---|---|---|
| 1 | 2026-10-21 19:38 | `20261021-193816` | `part-c-compare` | not in the job's history on 2026-10-28 (the job was recreated after it); log saved by the owner | Nothing compared | **Instrument.** Inputs verified by bytes, and SharePoint rewrites 7 of 8 uploaded workbooks; the one CO that passed crashed on a `400` creating a folder, body dropped. Office inputs verify by structure since; every store error carries Graph's code and request id |
| 2 | 2026-10-21 20:32 | `20261021-203211` | `part-c-compare-2` | `z5k50xy` | Nothing compared: Graph engine `rc=1` in 1 s on all eight | **Instrument — setup mistake 1.** The report directory was put beside `CMP` while the engine's jail root was `CMP`; the engine refused, correctly, and the instrument printed only the exit code, having copied the Part B differential's reading of exit 1 as "ran" |
| — | 2026-10-21 → 28 | | `part-c-compare-3` built, never run | | | **Process.** The fix was built into `-3` and the filled spec said `-3`, but the job in Azure was never updated and still carried `-2` a week later. Caught before the third start; `job show` before `job start` has been the rule since |
| 3 | 2026-10-28 14:24 | `20261028-142400` | `part-c-compare-4` | `tiwby16` | Nothing compared: Graph engine `rc=1` in 7 s on all eight, `FileNotFoundError` on the intake JSON | **Engine.** `sorted(cands, key=os.path.getmtime)` in `_find_intake_json` reached the container's disk for a file that existed only in SharePoint — the one filesystem access Part B's extraction missed, because its guard scanned calls and a key function is a reference. Fixed (`key=FS.mtime`); every filesystem reference inventoried; the scan rewritten; a runtime trap added |
| 4 | 2026-10-28 15:08 | `20261028-150825` | `part-c-compare-5` | `z32kar4` | Graph engine `rc=0` on all eight; **six EQUIVALENT, two DIFFERS** (Bulletin 12, ZZ PR-98) | **Instrument — setup mistake 2.** The local tree's files were written back to back, so the two intakes' mtimes were whatever the job's kernel stamped, and the local half picked the OLDER intake while the Graph half picked the newer. Not a store disagreement: every differing file was a field from the intake JSON. The transcript also said only "DIFFERS", because the differ's `report()` had bound `sys.stdout` at import, before the transcript's tee |
| 5 | 2026-10-28 15:55 | `20261028-155543` | `part-c-compare-6` | `oynbdk3` | **Eight of eight EQUIVALENT** | — |

Two of the five were the instrument misconfiguring its own inputs (runs 2
and 4), one was a process slip between runs (the job spec), one was an
engine defect the comparison existed to find (run 3), and one was a wrong
assumption about SharePoint (run 1). The store itself was never found at
fault. That the instrument needed five attempts to ask the question
correctly is recorded here on purpose: each failure also hardened the
instrument — ordered transcript, full engine logs, stderr on any non-zero
exit, classes and files in the SUMMARY, both halves on one clock, the intake
each half picked printed — and those are what make the fifth run's verdict
readable without trusting anyone's memory.

## The fifth run

`SUMMARY  run 20261028-155543`, verbatim:

```
  CCHMC Bulletin 09        EQUIVALENT
  CCHMC Bulletin 12        EQUIVALENT
  CCHMC Bulletin 13        EQUIVALENT
  CCHMC RFI 169            EQUIVALENT
  CCHMC RFI 187            EQUIVALENT
  CCHMC RFI 229            EQUIVALENT
  CCHMC RFI 238            EQUIVALENT
  ZZ PR-98                 EQUIVALENT

GraphFileStore and LocalFileStore produced equivalent output for every
CO once time-derived bytes are normalized.
```

Per CO, from the transcript:

| CO | Inputs | Graph tree built | local engine | graph engine | Files downloaded | Classes reported |
|---|---|---|---|---|---|---|
| CCHMC Bulletin 09 | workbook (rewritten by SharePoint, content identical), 1 intake | 18.5 s | rc 0, 2.0 s | rc 0, 47.5 s | 10 | none |
| CCHMC Bulletin 12 | workbook (rewritten), 2 intakes | 20.1 s | rc 0, 2.6 s | rc 0, 49.8 s | 10 | run report: timestamp only |
| CCHMC Bulletin 13 | workbook (rewritten), PNG, 2 intakes | 19.8 s | rc 0, 2.6 s | rc 0, 51.8 s | 12 | run report: timestamp only |
| CCHMC RFI 169 | workbook (rewritten), 1 intake | 18.8 s | rc 0, 2.1 s | rc 0, 49.1 s | 10 | run report: timestamp only |
| CCHMC RFI 187 | workbook (rewritten), 1 intake | 19.2 s | rc 0, 2.7 s | rc 0, 52.4 s | 10 | run report: timestamp only |
| CCHMC RFI 229 | workbook (rewritten), 1 intake | 17.4 s | rc 0, 2.7 s | rc 0, 51.7 s | 10 | none |
| CCHMC RFI 238 | workbook (bytes identical), PDF, 1 intake | 19.1 s | rc 0, 2.7 s | rc 0, 51.3 s | 12 | run report: timestamp only |
| ZZ PR-98 | workbook (rewritten), 2 intakes | 19.2 s | rc 0, 2.5 s | rc 0, 53.7 s | 10 | run report: timestamp only |

*Timestamp only* is the expected non-breaking class: the two halves ran a
minute apart and the run report's header carries the minute it was written
in. The two COs with no class at all ran within the same minute.

The three two-intake COs, the line the fourth run earned:

```
intakes   intake_20260729200259.json 2026-10-28T15:57:25Z, intake_20260730141559.json 2026-10-28T15:57:27Z
intake    local picked intake_20260730141559.json, graph picked intake_20260730141559.json

intakes   intake_20260825171424.json 2026-10-28T15:58:49Z, intake_20260825172438.json 2026-10-28T15:58:50Z
intake    local picked intake_20260825172438.json, graph picked intake_20260825172438.json

intakes   intake_20260722170746.json 2026-10-28T16:05:48Z, intake_20260722172908.json 2026-10-28T16:05:49Z
intake    local picked intake_20260722172908.json, graph picked intake_20260722172908.json
```

The copies landed one to two seconds apart, no tie, both halves on the same
clock, both picking the newer intake — the one the laptop picks.

Every input line read *bytes identical to the fixture* or *content identical,
bytes rewritten by SharePoint* with the touched OOXML parts named; no input
failed verification. No `400` recurred on folder creation.

## What this proves

- `GraphFileStore` and `LocalFileStore` are interchangeable for the engine's
  Gate A path on real change orders: the intake read, the 22-field scrub,
  the attempt folder (`Intake Form.xlsx`, the Review and Vendor Copy
  workbooks, `Review.docx` or `Action Needed.docx`, `Resend Email.html`,
  `scrub_result.json`, `vendor_drafts.json`), the state file, the two
  tracker workbooks, the run report, misc attachments carried into the
  attempt folder (PNG, PDF), and the CSV audit appends.
- The two sentinel writes (`scrub_result.json`, `vendor_drafts.json`) are
  produced through Graph with the same content as locally. They were written
  into a copy whose folder no flow watches; whether a Graph-written sentinel
  triggers a flow identically is the *Before cutover* question, not this one.
- The engine runs on Linux, as the engine's own identity, against SharePoint,
  with no secret and no laptop in the path.
- Part B's four `GRAPH-TODO`s hold on the real library: the real 409 behind
  `create_exclusive`, append as read-modify-write with one writer, a
  server-side copy settled before the next read (every CO copies then reads
  its inputs; no stale read in 40 CO-runs across the five runs), and `rglob`
  over the tree. Step 7's conformance harness had already exercised each as
  the app (15 of 16, the 16th the check's own premise, since corrected).

## What this does not prove

- **PDF rendering.** The image carries no LibreOffice, so
  `render_xlsx_to_pdf` returned `None` on both halves and no PDF was
  produced or compared. The laptop's run produces one. Phase 14's image
  decides whether to install it; if it does, the comparison must be re-run
  with it on both sides.
- **The later gates.** The copies' `CO In Progress` and `CO Finalized` were
  empty, so transfer detection ran only in the negative. Nothing here
  exercises the Gate C/D paths.
- **Flow triggering — closed later the same day, by observation.** Whether
  a file written through Graph by the app triggers the sentinel flows'
  trigger as a sync-written file does was not part of the comparison. It
  was then observed: a throwaway flow on the same trigger type fired on both
  of the engine's write shapes under the app identity, final names, two
  samples (`docs/phase-12-part-c-plan.md` → *Before cutover: the
  flow-trigger decision*).
- **The intake-selection rule — closed later the same day, in the
  repository.** The fourth run showed that "newest `intake_*.json` by mtime"
  is an assumption about the store's clock. The fifth run passed because
  both halves had one clock. The engine in the repository now sorts by the
  creation time in the name; the laptop's copy keeps the old rule until
  cutover (`docs/phase-12-part-c-plan.md` → *Before cutover: the
  intake-selection rule*).
- **Concurrency.** One engine, one CO at a time. `append_bytes` is still a
  read-modify-write; the lock is still a file that fails open.
- **Speed at volume.** The Graph half took 44 to 54 s per CO against 2 to
  3 s locally — about twenty times slower, one Graph round trip per file
  operation. Not a defect, and well inside a scheduled run's budget for the
  volumes seen (a handful of COs a day), but cutover planning should know
  the number.
- **Eight COs** from one project family plus one synthetic. The inputs are
  what the fixture store holds, not a sample chosen for coverage.

## Artifacts

**Kept.** The instrument's own records, saved to the owner's machine before
the folder was deleted, outside both repositories because the engine logs
name real change orders: `C:\Users\Msheth\compare-runs\` holds a README,
the transcripts of runs 3, 4 and 5, and the three engine logs the fourth
run's classification rests on. The owner's saved job logs for runs 1 and 2
are `C:\Users\Msheth\compare-job-2026-10-21.log` and
`compare-job-run2.log` (UTF-16, and out of order, as Log Analytics returns
them). The job's execution history was read on 2026-10-28 before deletion:
`z5k50xy` (run 2, `-2`), `tiwby16` (run 3, `-4`), `z32kar4` (run 4, `-5`),
`oynbdk3` (run 5, `-6`), all `Succeeded` as executions whatever the
comparison inside them said.

**Deleted on 2026-10-28, after this record was written.**

- The job `phbplat-prod-co-compare` (ARM `DELETE`, confirmed `ResourceNotFound`
  afterwards).
- The copy, `/phb-co-engine scratch/part-c-copy-2026-10-21` in the AI Sandbox
  library: 5,569,036 bytes in 3 items — `pristine/` (9 items: eight COs'
  inputs and `_manifest.json`), `README.txt`, and `runs/` holding
  `20261021-193816` (empty), `20261021-203211` (8 trees, 558 KB),
  `20261028-142400` (599 KB), `20261028-150825` (1.9 MB), `20261028-155543`
  (1.9 MB). It went to the site recycle bin. The parent folder
  `phb-co-engine scratch` stays, empty, for the next instrument.

Nothing under `CO Managment Process` was touched at any point; the store
refuses that name at every call and at construction, and the job's identity
was granted on the AI Sandbox site only.

## Re-running the comparison

Everything needed is in the two repositories except two files the owner
holds: the fixture store (`phb-co-engine-fixtures`, real data, beside the
`phb-co-engine` checkout) and the filled job spec (carries the subscription
id). In order:

1. **Rebuild the copy**, from the laptop with a developer token:
   `MSYS_NO_PATHCONV=1 CO_GRAPH_TOKEN=<az account get-access-token --resource https://graph.microsoft.com> python tests/build_copy.py --drive-id <drive id> --root "/phb-co-engine scratch/part-c-copy-<date>"`. The manifest it writes carries the structural fingerprints; nothing a flow writes is ever uploaded (the builder refuses those names).
2. **Build the image** in the production registry: `az acr build --registry <registry> --image phb-co-engine:<tag> --build-arg INCLUDE_LIBREOFFICE=false .` from the `phb-co-engine` root, then pull it and run `tests/test_compare_layout.py` and `tests/test_graph_root_jail.py` inside it — the tag is not the proof, the tests inside are.
3. **Recreate the job** from the filled spec with the new tag and the new `CO_COPY_ROOT`: `az containerapp job create -n phbplat-prod-co-compare -g <resource group> --yaml <filled spec>`; the spec's command is `infra/compare-job.sh` base64-encoded. Creating it is the owner's action.
4. `job show` to read the tag back, `job start`, then read
   `runs/<id>/compare-transcript.txt` in the copy, not the job log.
5. Delete the job and the copy when done, and add the run to the table above.

The runbook's four comparison-job symptoms (`runbook.md`, from *The
comparison job says `pristine inputs do not match`*) cover what each earlier
run hit.
