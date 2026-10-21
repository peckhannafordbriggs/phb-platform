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
| Run it against a real drive | **half run, 2026-10-14** — the write side, as a signed-in person; the read side needs a token from a different client. See *Step 5 ran, half of it* below |

What the conformance harness targets, matching the four `GRAPH-TODO`s:
`append_bytes` (read-modify-write, Graph has no append), `create_exclusive` (the
409 from `conflictBehavior=fail`), whether `copy`'s async monitor is genuinely
settled when it returns, `rglob`'s cost by depth, and the upload-session path
above 4 MB.

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
needs a flow watching the copy, which means creating a twelfth flow.
Prohibition 2 forbids modifying, disabling, re-authorizing or exporting the
eleven; creating a new one on a copy is not literally any of those, but it is
close enough to the line to be a decision rather than an assumption.
`PHASE-12.md` says *"verify that rather than assuming it"*, so no amount of
reasoning closes it. **Decided 2026-10-21: not now.** The owner will decide
before Phase 14, and the decision is a required pre-cutover step — *Before
cutover: the flow-trigger decision* below has the evidence already in hand
and the two ways to close it.

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

## Step 5 ran, half of it (2026-10-14)

The token the Azure CLI already holds for a signed-in developer reaches Graph,
and the AI Sandbox library is a drive a developer can already write to, so the
harness was pointed at a scratch folder there (`/M Sheth Sandbox/
conformance-scratch`, deleted afterwards). No application identity, nothing
granted by anyone, nothing near `CO Managment Process`.

```
  ok   makedirs                                        ok   listdir  (9 entries)
  FAIL content transfer is pre-authenticated           ok   rglob    5 folders, 1.22s
  FAIL write_text / read_text round-trip               FAIL large write (upload session)
  FAIL write_bytes / read_bytes round-trip             ok   remove
  ok   size / mtime / is_file / is_dir                 ok   sentinel filenames still refused
  FAIL append_bytes                                    ok   Bid Tracker unreachable
  ok   create_exclusive on a free path
  ok   create_exclusive on a taken path  (FileExistsError - a real 409)
  FAIL copy settles before the next read
  FAIL move
                                                       9/16 operations behaved
```

**Every failure is one cause, and it is not the store.** Graph answers
`GET …/content` with a `302` to a `sharepoint.com` download URL, and that URL
has to arrive pre-authenticated (`tempauth=…`) because the client cannot carry
the Graph bearer across the hop. For a token whose *client* SharePoint refuses
— and the Azure CLI's first-party app is one; the same token gets
`invalid_request` from the SharePoint REST API directly — the download URL
carries no pre-auth and the hop is a 401, and the upload session's URL is
refused the same way (`401 FORBIDDEN` on the PUT). *(Corrected 2026-10-21: this
paragraph first said Graph "omits `@microsoft.graph.downloadUrl` altogether".
It does not; the check had asked for it in a form Graph ignores. See
*Step 7, third pass*.)* Every
metadata call and every small `PUT` succeeded, and the `copy` and `move`
destinations were present and the right size when listed; only reading them
back failed. The harness now checks this first and says it once
(`content transfer is pre-authenticated for this token`), instead of reporting
six store defects.

What the half-run did settle, on a real SharePoint library:

- `conflictBehavior=fail` on an existing item really is a 409, and the store
  raises `FileExistsError` for it. The harness used to accept *any* exception
  there — a run whose every request was a 400 passed the check — and now
  accepts only that one.
- Path addressing with the real folder names works end to end: the spaces, the
  misspelling, five levels deep. `rglob` over five nested folders took 1.22 s.
- `size` reports the written byte count (2048 of 2048) for a small file.

What it did not: byte round-trips, append, the upload session path, and whether
a copy is *settled* rather than merely present. Those are the read side, and
they need a token from a client SharePoint accepts. Two ways to get one, either
of which finishes step 5 in about a minute:

1. A developer pastes a token from the Graph Explorer's *Access token* tab
   (sign in, consent `Files.ReadWrite.All`), `CO_GRAPH_TOKEN=…`, and re-runs
   the same command. Dies in an hour; fine for a run.
2. Vitis ticks *Allow public client flows* on `phb-co-engine` — the app already
   carries admin consent for delegated `Files.ReadWrite.All` — and the engine
   can obtain its own delegated token by device code, repeatably. **Not yet
   built** in `co_graph_auth.py`, and not worth building until (2) is granted.

## Step 7: the grant is consented, and the site half is not verifiable from here (2026-10-14)

Read live from Entra as a signed-in developer, not from anyone's say-so:

| | observed |
|---|---|
| App registration `phb-co-engine` | exists, created 2026-10-13, client id `85ca496d-3af9-4c3a-aa11-a6b7fd51105d`, single tenant |
| `Sites.Selected` (application) | requested **and consented** — an `appRoleAssignment` on the service principal dated 2026-10-13 13:49 UTC |
| `Files.ReadWrite.All` + `User.Read` (delegated) | consented for all users |
| Credentials | **none** — no secret, no certificate, no federated identity credential |
| Public client flows | off, no redirect URIs — so no device-code sign-in either |
| Owners | none |
| The site grant (the second step) | **cannot be read by this account**: `GET /sites/{id}/permissions` is `accessDenied`, and the SharePoint REST API refuses the CLI's token outright |

One indirect observation: the site's hidden *User Information List* holds 33
principals and **none** is `i:0i.t|ms.sp.ext|85ca496d-…`, the form a
`Sites.Selected` grant registers on the site. That is consistent with the grant
not having been made; it is not proof, and it is not written up as proof.

**Nothing can authenticate as the engine app today.** With no credential of any
kind, the definitive check — a request as the app — is impossible, and a
developer with no directory role and no ownership cannot add one. So "verify the
grant landed" reduces to one of three things somebody else does, cheapest first:

1. **Vitis reads it back**, one command, and sends the output:
   `Get-PnPAzureADAppSitePermission -Site https://peckhannafordbriggs.sharepoint.com/sites/AISandbox`
   (or `GET /sites/{siteId}/permissions` as an account with `Sites.FullControl.All`).
   If the app is absent, the grant command from Request 4 is the fix, with
   `-Permissions Write`.
2. **A federated identity credential on `phb-co-engine` for the engine
   repository's GitHub Actions**, the same mechanism the platform's deploy job
   uses (`runbook.md` → Request 3a, including the trap that the subject must be
   read off a run rather than built from the wizard). Then a workflow runs
   `tests/probe_site_grant.py` as the app and the 403-vs-200 is observed rather
   than reported. No secret, nothing expires, and it is the shape production
   will use anyway.
3. A client secret on the app for local development only. Permitted by
   prohibition 7's wording, and still the wrong answer here: the request to
   Vitis said *no client secret, please*, and nobody in the company owns the
   registration to rotate it.

`phb-co-engine/tests/probe_site_grant.py` is the instrument for whichever
arrives. It decodes the token's claims to say *which* identity was probed, and
a signed-in person's 200 is reported as proving nothing about the application —
verified live: as a developer it reads *reachable as a person, which proves
nothing about the application*, exit 0, and the write probe created and removed
a folder under the scratch path. The 403 branches are tested offline
(`test_site_grant_probe.py`) and have not been seen live, because no app token
exists to see them with.

**Identifiers the next run needs**, read from Graph on 2026-10-14:

```
site id   peckhannafordbriggs.sharepoint.com,7abfad4b-146d-4d07-928b-225ce24a7feb,96084a5d-a324-4fbe-bb1e-5d27a69d3d48
drive id  b!S62_em0UB02SiyJc4kp_611KCJYko75Pux5dJ6adPUh2meyF7kbNS7bA44dg1_Yg   (library "Documents")
app id    85ca496d-3af9-4c3a-aa11-a6b7fd51105d                                   (phb-co-engine)
```

The engine takes these as `--drive-id` / `CO_GRAPH_DRIVE_ID` and
`--live-path` (drive-relative, e.g. `/<copy folder>/Change Order Intake`);
there is no config file. The managed-identity path adds
`CO_GRAPH_MANAGED_IDENTITY_CLIENT_ID`, which is the *identity's* client id, not
the app's, and does not exist until the container is deployed.

### Where the copy lives — decided 2026-10-21: a sibling folder in AI Sandbox

**This section used to recommend a second site.** The platform owner decided
otherwise on 2026-10-21, and the reasoning on both sides is kept so the
decision can be revisited on its merits rather than rediscovered.

**What was recommended, and why.** `Sites.Selected` is granted per site. A
copy in a sibling folder of the same library means the app holds Write on the
site that contains the live `CO Managment Process` — so the container would be
kept off the live tree by configuration (`--live-path`) rather than by
incapacity, which is the weaker of the two and the opposite of how every other
guard in this project is built. A copy site would give the app Write on a site
holding *no* live folder.

**Why AI Sandbox was chosen anyway.**

1. **The comparison is about the real target library.** Bucket 3 says so in
   its first row: *only the real target library counts*. Library throttling,
   list view thresholds and how a server-side copy settles are exactly the
   behaviours Part B warned do not transfer between drives. A second site is a
   second library, and a comparison passed there would still have to be
   re-run here before anyone trusted it.
2. **A second site costs two things nobody on the team can do** — creating a
   team site and a second `Sites.Selected` grant on it from Vitis — for a
   copy that is deleted when the comparison is written up.
3. **The weakness the recommendation named is answered in code, not by
   placement.** Two guards in `GraphFileStore` (next section) make the fence
   incapacity: the store is confined to the folder it is given, and refuses
   the live folder by name whatever it is given. The engine cannot be pointed
   at the live tree in graph mode without a code change.
4. **The flow-trigger argument for a copy site was wrong.** A "file created"
   trigger's folder parameter scopes it, so a flow watching the copy's folder
   does not need a copy site. The check is deferred regardless — see *Before
   cutover* below.

**The copy, exactly.** Library `Documents` on the AISandbox site (drive id
above), top-level folder `phb-co-engine scratch` — the root the step 7 job
used — and under it:

```
/phb-co-engine scratch/part-c-copy-2026-10-21/
    README.txt                  says it is not the live tree, and when to delete it
    pristine/_manifest.json     every input file with its byte count and sha256
    pristine/<CO name>/         the replay inputs of one fixture run, byte for byte
    runs/<id>/<tag>/CMP/        one engine tree per comparison run, built from pristine
    runs/<id>/<tag>/rep/        that run's report
```

The string `CO Managment Process` appears nowhere under it; `--sharepoint-root`
is `…/CMP` and the engine's `CO In Progress` / `CO Finalized` checks resolve
inside the copy. Built on 2026-10-21 by `tests/build_copy.py` *(phb-co-engine)*
from the A3 fixture store, as the developer with the Azure CLI's token (small
PUTs work for it; reads do not, and the comparison verifies every download
against the manifest instead): **8 COs, 21 files, 549,143 bytes**, every size
matching the fixture store exactly when read back by metadata.

**Which COs, and why.** The eight the Part B and Part C differentials ran —
CCHMC Bulletin 09, the Bulletin 12 chain with both same-subject conversations,
Bulletin 13, RFI 169, 187, 229, 238, and ZZ PR-98 — because they are the only
fixture runs with replay inputs and between them cover every path the engine
has: returned for information, complete, the old template, a five-attempt
resubmission, two conversations with one subject, and two attachment copies
(RFI 238's P&ID, Bulletin 13's image), which are the only inputs that exercise
Graph server-side copy through the real engine.

**What data is in it, decided: real, not scrambled.** The intake JSON (the
PM's address, subject, ACC link, note) and the intake workbook (project,
owner, GC, dates, six PH+B names, the change narrative, the vendor table of
company, contact and email), plus the two attachments. **No pricing**: the
intake path is a request for pricing; quotes, `Bid Tracker.xlsx` and the
response engine live under `Change Order Step 2` and the transferred
packages, none of which is in the copy. Scrambling was declined because the
copy sits in the library the originals already sit in, readable by the same
people, so it adds no disclosure; a scrambler would have to preserve cell
positions, formats, the typo dictionary's hits and the label-search fallback,
and would be new code needing its own verification; and it would cut the
link to the fixture store, where six of fourteen artifacts reproduce exactly.
**Never in the copy**: anything a flow writes or triggers on —
`transfer_ready.json`, `classification_result.json`, `bid_tracker_ready.json`,
`draft_written.json` and the two engine sentinels as inputs — the Archive
folders, prior attempts, and the whole of Step 2. The builder reads the
fixture store and never the live folder, so none of those can travel, and it
refuses the six names outright on top of the store's own sentinel rule.

**Delete it** when the comparison is written up, and record the date here.

### The two guards (2026-10-21)

Both in `co_filestore.GraphFileStore` *(phb-co-engine,
`feat/graph-store-root-jail`)*, each with tests, built before the copy was:

| guard | what it does | where it bites |
|---|---|---|
| **the root jail** | `root` is a required constructor argument; every request URL is built from a path check against it, so a path outside the root never becomes a request. The drive root is refused as a root, because the live tree is in it | every store method, before any HTTP |
| **the live folder, by name** | `CO Managment Process` as the first path segment is refused at every call whatever the root, case-insensitively, and a root inside it is refused at construction — before the engine fetches a token, so the refusal cannot read like an auth error | construction, and every call |

The one write permitted above the root is `makedirs` creating the root's own
ancestor folders, so a fresh scratch root can be made. In graph mode the
engine now requires `--sharepoint-root` as well as `--drive-id` and
`--live-path`, validates the root first, and refuses a `--live-path` or
`CO_REPORT_DIR` outside it up front. Writing the tests found a real ordering
defect: `replace`, `copy` and `move` looked at the destination before the
source, so `replace(<live>, <copy>)` would have asked Graph whether the
destination existed before anything refused the source. Both paths are now
confined before any request in all three.

`tests/test_graph_root_jail.py`, 14 tests, offline: every store method with a
live path on a session whose every call raises; every spelling; traversal;
case; the ancestor door; and **the real engine as a subprocess, pointed exactly
where the laptop points, which stops at the root with no token set** — the
test the owner asked for. Mutation: with the by-name refusal removed, 5 of
the 14 fail and the jail still reports the same paths as outside, so the two
layers are independent. The Part B differential was re-run afterwards: all
eight COs EQUIVALENT. Removing the by-name refusal is the Phase 14 cutover
change, made deliberately and nowhere else.

### The comparison instrument, and the job that runs it

`tests/compare_stores.py` *(phb-co-engine)*, per CO under `pristine/`:
download and verify the inputs against the manifest; build a local tree and
run the engine with `--store local`; build a Graph tree under `runs/<id>/`
by server-side copy from `pristine` and run the engine with `--store graph`;
download that tree, rewriting the Graph-side paths it recorded in its state
files to the download location (the differ then strips both roots to
`<ROOT>`, as it already does for the laptop-versus-container case); and hand
both trees to `tests/co_output_diff.py`. Both halves run in one container, so
the store is the only variable. **It has not run yet.** It can only run as
the engine app, which exists only inside Azure, so it is a Container Apps job
exactly like step 7's: image `phb-co-engine:part-c-compare` (built in the
production registry 2026-10-21 from the branch, `INCLUDE_LIBREOFFICE=false`
as step 7 was, so neither half renders a PDF), `infra/compare-job.sh`
base64-encoded as the command, the step 7 spec's identity, environment,
registry and six `CO_*` values, plus
`CO_COPY_ROOT=/phb-co-engine scratch/part-c-copy-2026-10-21`. Timeout: allow
1800 s; eight COs, two engine runs each, through Graph. The log reads
`### COMPARE`, one block per CO ending in `EQUIVALENT` or `NOT EQUIVALENT`,
a `SUMMARY`, `### COMPARE EXIT n`, `### DONE`. Creating the job is the
owner's action, as before.

**Pre-registered expectation.** SharePoint stamps a workbook after a write
(§7c of the inventory), so the Graph half's copied intake workbooks carry
injected OOXML parts the local half's byte copies do not. The differ compares
workbooks structurally, so this should not surface; if it does, it is a differ
class to widen, not an engine difference. Anything else that survives
normalization is a store disagreement and is the finding Part C exists for.

### The first run (2026-10-21, `runs/20261021-193816`): two failures, neither the store's

The owner created and ran the job the same day. It failed before any
comparison happened, in two ways. Neither was a store disagreement.

**1. The pre-registered expectation hit the inputs, not the outputs.** Six
COs failed the input check against the manifest, each on its workbook. The
check was `sha256(bytes read back) == sha256(fixture bytes)`, and Graph's own
`quickXorHash` on every pristine file, read afterwards by metadata, says why:

| | workbooks | what SharePoint did |
|---|---|---|
| grew by exactly 3,095 bytes | Bulletin 09, RFI 169, ZZ PR-98 | parts added — the three with no SharePoint metadata before (a PM's original attachment, a synthetic form) |
| **same size, different bytes** | Bulletin 12, 13, RFI 187, 229 | stamped in place — captured from the library, so they already carried the parts |
| unchanged | RFI 238 | — |
| JSON, PNG, PDF | all 14 | unchanged, hash for hash |

So **7 of 8 uploaded workbooks are not the bytes that were uploaded**, and a
size check would have missed four of them. This is §7c of the inventory
observed on the way *in* rather than the way *out*, and it means no byte
check can ever verify an uploaded workbook. **Decision: Office inputs verify
by structure.** The manifest now carries `shape_sha256`, the sha256 of the
differ's own `workbook_shape` (cell values, formats, fills, table ranges,
widths — what the engine decides from), plus every zip part's digest;
`compare_stores.py` verifies an `.xlsx`/`.docx` by the fingerprint and prints
which parts the rewrite added or changed, as evidence; bytes still decide for
everything else. The manifest was rewritten in place
(`build_copy.py --manifest-only`) rather than re-uploading, which would only
re-stamp. The two halves of the comparison were never affected: both read the
same downloaded bytes, the local half writing them into its tree and the
Graph half copying them server-side. What the check ties down is the link to
the fixture store, and a structural match is the right link — it is what the
differ uses for outputs, by the same §7c reasoning.

**2. The one CO that passed crashed creating a folder.** `400 Bad Request` on
`…/runs:/children`, creating the run folder — and the folder was there
afterwards, empty, created by `phb-co-engine` at 19:38:29. `raise_for_status()`
had dropped the body that would have said what was bad. Three things it was
not, each tested from a developer token the same evening: the exact
folder-creation sequence the job ran, traced request by request, succeeds
(eight `makedirs`, every `POST` 201); the root jail did not change how
folders are created — the trace shows the same lookups and the same creates
as before, plus the ancestor lookups; and a date-shaped folder name creates
and takes children fine. It is not reproducible from here, and the cause is
in the body. So: every Graph error from the store is now a `GraphRequestError`
carrying Graph's code, message and request id, with no `raise_for_status` left
in the store; `makedirs` settles an ambiguous answer by looking the folder up
again — continuing with a loud warning if it exists, raising with the body if
not — because existence is what it promises and the first run showed the two
can disagree; `CO_GRAPH_TRACE=1` prints every request's method, status and
path for a run that needs it; and `compare_stores.py` carries on to the next
CO when one crashes, so one fault does not cost the other seven.
`tests/test_graph_errors_and_inputs.py`, 11 tests. **If the 400 recurs, the
log will now say what it was**, and that is a finding to understand before
Phase 14, since it is the same operation the engine performs on every attempt
folder.

**What the run left:** one empty folder, `runs/20261021-193816`, version 1,
created by the engine app. Nothing else; `pristine/` is untouched apart from
the rewritten manifest. Three probe folders made from the developer token
while diagnosing were deleted the same minute.

**Second attempt:** image `phb-co-engine:part-c-compare-2`, the same job
spec with the tag changed. Not yet run.

## Step 7, second pass (2026-10-21): the credential is the platform's identity, and the test needs a job

Vitis reported the federated credential added and the site grant made. Read
back from Entra:

| | observed |
|---|---|
| Federated identity credential `phb-platform-prod` | issuer: this tenant; subject `282bcb43-60e4-4d90-aa62-cea74fd719ae`; audience `api://AzureADTokenExchange` |
| That subject | `phbplat-prod-identity`, the platform's production user-assigned identity (client id `d6ed7dd3-a599-444b-b043-90f1e7282bea`) |
| Also on the app | a **certificate** credential, `PnP.Powershell`, valid 2026-10-19 → 2029-10-19, subject `PnPAutomationCert`, issued for a workstation — the one Vitis used to run the grant |
| The site grant | still not readable by a non-admin; now provable **as the app** |

Two consequences, one of them a decision for the owner:

1. **The app can be authenticated only from inside Azure, as the platform's
   identity.** Not from a laptop, not from GitHub Actions. So the probe and
   the harness run as a Container Apps **job** in `phbplat-prod-env`, carrying
   `phbplat-prod-identity`, from the engine image in the production registry.
   That is exactly how the Cost Intelligence worker job authenticates to its
   own app registration, so it is the conventional shape here, not a new one.
2. **The certificate is a credential that expires**, on an app that will hold
   Write on a SharePoint site, and its private key is on a workstation nobody
   in the company controls. Prohibition 7 is about production and this is not
   the production path — but the engine's rule is *no client secret, please*,
   and a certificate is the same thing with a longer fuse. Ask Vitis to remove
   it now that the grant is made; the federated credential is the one the
   engine uses. **Decision for the platform owner, recorded here, not taken.**

### What was built for it

- `co_graph_auth.federated` *(phb-co-engine)*: the identity's token for the
  exchange audience, presented as a `client_assertion` to the app — the
  platform's `managed-identity-assertion.ts` in Python, with no SDK. It reads
  the **container app's** identity endpoint (`IDENTITY_ENDPOINT` +
  `IDENTITY_HEADER`), which is not IMDS; the existing `managed-identity` mode
  assumed IMDS and would have failed on Container Apps with a message that
  reads like "no identity assigned". Both modes now share one token fetch.
  Entra's error body is kept on refusal, because it carries the AADSTS code
  that says which half of the credential is wrong. Six offline tests assert
  the shape of both requests and that no secret is in the form.
- `--graph-auth federated` on the engine, the harness and the probe; three
  env values, none secret: `CO_GRAPH_APP_CLIENT_ID`, `CO_GRAPH_TENANT_ID`,
  `CO_GRAPH_MANAGED_IDENTITY_CLIENT_ID`.
- The image now carries `tests/` and keeps the engine at its repository path
  (`/app/AI Files/CO Intake Engine`, with `/app/engine` as a link), so the
  instruments find it as they do in a checkout.
- `phbplatprodovwzv7.azurecr.io/phb-co-engine:step7` — built in the registry
  on 2026-10-21 with `az acr build … --build-arg INCLUDE_LIBREOFFICE=false`
  (run `ch24`, succeeded). The local CLI crashed printing pip's output
  (`charmap` codec); the build is server-side and finished regardless. Set
  `PYTHONIOENCODING=utf-8` before `az acr` commands on Windows.
- `infra/step7-job.sh` *(phb-co-engine)*: what the job runs — the probe with
  the write probe, then the full harness, both against
  `/phb-co-engine scratch/conformance-scratch`, a top-level folder of the
  AI Sandbox library beside `CO Managment Process` and never inside it.

### Running it — needs the platform owner

Creating a job in the production resource group is a production deploy, and
the agent's permission mode refused it (correctly: a new resource, with the
production identity attached). The filled job spec is a one-off file outside
both repositories — it carries the subscription id — and the sequence is:

```
export PYTHONIOENCODING=utf-8
az containerapp job create -n phbplat-prod-co-step7 -g <resource group> --yaml <filled spec>
az containerapp job start  -n phbplat-prod-co-step7 -g <resource group>
az containerapp job execution list -n phbplat-prod-co-step7 -g <resource group> -o table
az containerapp job logs show -n phbplat-prod-co-step7 -g <resource group> \
    --container step7 --execution <execution name>
az containerapp job delete -n phbplat-prod-co-step7 -g <resource group> --yes
```

The spec: `type: Microsoft.App/jobs`, `location: eastus2`, user-assigned
identity `phbplat-prod-identity`, environment `phbplat-prod-env`, trigger
`Manual`, timeout 900 s, no retries, registry `phbplatprodovwzv7.azurecr.io`
pulled with the same identity, image `phb-co-engine:step7`, `cpu 0.5`,
`memory 1Gi`, command `sh -c "echo <base64 of infra/step7-job.sh> | base64 -d | sh"`
(base64 because `--args -c …` is parsed as an option by the CLI, and a YAML
spec sidesteps it), and the six `CO_*` environment values above plus
`CO_SITE_ID`. The log reads in three parts: `### PROBE` with its verdict line
and `### PROBE EXIT n`, `### CONFORMANCE` with the 16 checks, `### DONE`.
Then delete the job and the scratch folder; keep the log.

**What the log will say, by case** — the probe's exit code is the answer the
owner asked for:

| exit | identity line | verdict |
|---|---|---|
| 0 | `application app 85ca496d-…`, roles `Sites.Selected` | working — the site grant is present |
| 2, roles shown | same | consent done, **no grant on this site** |
| 2, roles empty | `application`, roles `-` | no consent (or a token issued before it) |
| 3 | any | bad token — and `no token: Entra refused the assertion …` before it means the federated credential did not match (the AADSTS code follows) |

## Step 7, third pass (2026-10-21): the job ran as the app, and the one failure was the check

The platform owner created and ran the job. From the log, as reported:

| | result |
|---|---|
| `probe_site_grant.py` | **exit 0** — identity `application`, roles `Sites.Selected`; site, drive and listing 200; the write probe created and removed a folder: **the grant is present, and it is Write** |
| `store_conformance.py` | **15 of 16** |
| the one failure | `content transfer is pre-authenticated for this token` — while the text and binary round-trips, append, copy, move and the 5 MiB upload all passed |

So: **the credential works, the site grant is present, and `GraphFileStore`
holds on the real library as the real identity.** Every one of Part B's four
`GRAPH-TODO`s was exercised against SharePoint by the identity production will
use: the 409 behind `create_exclusive`, append as read-modify-write, a
server-side copy settled before the next read, `rglob` over a nested tree, and
the upload-session path above 4 MB.

What the library showed afterwards, read before deleting it: the whole tree
under `phb-co-engine scratch/conformance-scratch` created by `phb-co-engine`
(`copy_dst.txt` by *SharePoint App* — the server-side copy runs as SharePoint,
not as the caller), `audit.csv` at 12 bytes (three appended rows), `large.bin`
at exactly 5,242,880, `lock.lck`, `move_dst.txt` and no `move_src.txt`, five
`marker.json` five levels deep. The probe's `write-probe` folder was gone, as
the probe removes it. Deleted; the library root is back to its seven
pre-existing folders, and nothing else was written anywhere.

### The failing check's premise was wrong, and the fix is the check

The check asked Graph for the item with
`$select=id,size,@microsoft.graph.downloadUrl` and treated a missing URL as
"SharePoint refuses this client". Graph ignores the annotation when it is named
in `$select`; the documented form is `content.downloadUrl`. Measured against
the file the job left, as a signed-in developer:

| request | `@microsoft.graph.downloadUrl` |
|---|---|
| no `$select` | present |
| `$select=id,size,@microsoft.graph.downloadUrl` | **absent** (four keys back) |
| `$select=id,size,content.downloadUrl` | present |

So the check reported "no downloadUrl" for every token — the engine app's
included, whose reads all passed. The URL's presence was never the signal;
whether the hop to `sharepoint.com` succeeds is. The lineage finding from the
first pass stands on the reads, not on the metadata: the developer token's
download URL, fetched with no header, is still a 401, and the six content
operations still fail for it.

The check now performs an actual read of what it just wrote. A 401 from
`sharepoint.com` on that read is the lineage diagnosis, said once; anything
else is a store failure reported as itself; and the download URL, asked for
properly, is printed as information. Re-run: local 16/16; as the developer
9/16 with the same six reads failing and the first check now naming the cause
*from a read*. **Not re-run as the app** — that is another job, and the fix
changes only how the check decides, not what the store does.

**What remains for Part C** is now exactly the plan's bucket 3: the
byte-identical comparison of `GraphFileStore` output against `LocalFileStore`
on a copy of the tree, and the flow-trigger check. Step 6 (Part E
equivalence, in writing) is still not started. The job can be re-created from
the same spec for the next run; the image is in the registry.

**Later the same day**, the guards were built, the copy was built and the
comparison was packaged as a job — *Where the copy lives*, *The two guards*
and *The comparison instrument* above. The comparison itself has not run.

## Before cutover: the flow-trigger decision (required)

`PHASE-12.md` Part C: *"writing a file through Graph changes its metadata.
Power Automate matches on filenames, so this should be irrelevant — verify
that rather than assuming it."* The owner deferred the verification on
2026-10-21. **Phase 14 does not start until it is either done or explicitly
waived in writing here**, because it is the acceptance criterion most likely
to be discovered late, and after cutover the only flows that could reveal it
are the eleven, on live data.

**What the eleven watch** (from the engine's own flow map): Intake 2 watches
`2 - Returned for Info` every minute; Intake 3 watches `3 - Ready for Vendor
Pricing` every five; Intake 5 polls `CO In Progress` with a filename
condition; all under `CO Managment Process`. The copy is a sibling top-level
folder and so outside every watched folder — the library's six other
top-level folders see daily activity and fire nothing, which Phase 11's
run-history check can confirm from the portal.

**Evidence already in hand, with no flow involved** (read live 2026-10-21):

- Power Automate's own `transfer_ready.json` in an archived Bulletin 13
  attempt folder was created by API — author `changeorder`, application
  `Microsoft Power Platform` — and Intake 4 fires on exactly that file every
  time. So a "file created" trigger in this pipeline already fires on files
  that did not arrive through the OneDrive sync client.
- The engine's sync-written `scrub_result.json` and `vendor_drafts.json`
  beside it differ from the Power Automate file only in author, editor and
  application fields; content type, version and name are identical.
- A Graph app-only write shows the app as author, and a server-side copy
  shows `SharePoint App` — observed on the step 7 scratch tree.
- No card in the seven intake flows reads author or editor, per the
  card-level map (*inferred* for expressions, which the map does not list
  exhaustively).

**What that does not prove**: that the trigger's poll picks up an item
created by an application-only principal. No documented exclusion exists;
that is reasoning, and the phase doc asks for observation.

**Two ways to close it, cheapest first:**

1. **A disposable personal flow.** In the owner's own environment and
   connection, trigger *When a file is created (properties only)* on the AI
   Sandbox library with the folder set to the copy's
   `…/CMP/Change Order Intake/2 - Returned for Info`, one Compose action,
   deleted after one observed run on a file the comparison job wrote. It
   touches none of the eleven, uses no shared connection and sends nothing;
   whether it sits inside prohibition 2's spirit is the owner's call. It does
   not need a copy site.
2. **Observe what the trigger would see.** Query the library's list items the
   way the trigger does (`/sites/{id}/lists/{listId}/items` filtered on
   `Created`, or the drive `delta`) and show an app-created item appears with
   the same shape as a Power Automate-created one. Strong, and still not the
   trigger.

Record the outcome, or the waiver and its reasoning, here.

## Sequence

1. ~~Dockerfile and requirements~~ — done
2. ~~Differential inside the container~~ — done; settled Linux, the NEWLINE
   inference, and the differ defect
3. ~~Write up the timezone finding~~ — done, above
4. ~~`--store` seam~~ — done
5. **Exercise `GraphFileStore` against a substitute drive** — **half done,
   2026-10-14**: the write side, as a signed-in person, against a scratch folder
   in the AI Sandbox library. The read side needs a token from a client
   SharePoint accepts (above). `CO_GRAPH_TOKEN=<token> python
   tests/store_conformance.py --store graph --drive-id <id> --root
   "/<scratch>"`; from Git Bash set `MSYS_NO_PATHCONV=1`, or the shell rewrites
   the root into a Windows path and every request is a 400.
6. Define Part E equivalence for the judgment steps, in writing, first — not
   started
7. **Done through the probe and the harness, 2026-10-21** (*Step 7, third
   pass*): the credential works, the site grant is present and Write, and
   15 of 16 checks pass as the app with the 16th a defect in the check
8. **The two guards — done 2026-10-21**, with tests, before anything was
   copied (*The two guards*)
9. **The copy — built 2026-10-21** at
   `/phb-co-engine scratch/part-c-copy-2026-10-21` (*Where the copy lives*)
10. **The byte-identical comparison — first run failed before comparing
    anything** (*The first run*): inputs verified by bytes where SharePoint
    rewrites workbooks, and a 400 whose body was dropped. Both fixed; image
    `phb-co-engine:part-c-compare-2`; the second run is the owner's to start
11. **The flow-trigger decision — deferred, required before Phase 14**
    (*Before cutover*)

Steps 1–4 and 8–9 are complete without anybody granting anything. Step 5 needs
a token from the right client, not a permission. Step 10 needs the owner to run
one job. Step 11 needs a decision.

---

## Related

- `docs/PHASE-12.md` — the phase, and the acceptance criteria this plans against
- `docs/phase-12-part-b-verification.md` — what Part C inherited, including the
  four `GRAPH-TODO`s
- `docs/12-ai-layer-inventory.md` — §7b is the time-derived field list the differ
  implements
- `runbook.md` → *What to ask IT for* → *Request 3* — the Sites.Selected request,
  with the delegated alternative
