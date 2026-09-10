# Phase 12 — Centralize the AI Logic

Read `CLAUDE.md`, `docs/02-existing-co-system.md`, and
`WHY-ITS-BUILT-THIS-WAY.md` before anything else. This phase touches the one system
in the project that the business depends on every day.

---

## The prime directive

**The running pipeline must not be disturbed.** Not slowed, not partially migrated, not
"briefly stopped to test something."

Every previous phase was safe because the platform sat *beside* the automation and
couldn't reach it. This phase replaces a working component of it. That changes the risk
profile completely, and the sequencing below exists because of it.

Three rules that hold for the entire phase:

1. **Nothing runs against the live SharePoint folders except the existing scheduled
   tasks.** All development work targets a copy.
2. **Never run two instances against live at once.** The lock file and the intake
   signature duplicate-detection make double-running actively dangerous, not merely
   redundant.
3. **Cutover is not in this phase.** Phase 12 ends with a container that produces
   provably identical output while the laptop keeps running. Switching over is Phase 14.

---

## What this phase is replacing

Two Claude scheduled tasks on one Windows machine, driving `run_workflow.py`
(~196 KB of Python) plus `co_state.py`, against a locally-synced SharePoint library.

The pipeline's contract with Power Automate is **four exact filenames** appearing in
SharePoint. That contract does not change in this phase, or ever. The container writes
the same files to the same paths, and the eleven flows never learn anything moved.

---

## Part A — Inventory and version control

**No behaviour changes. Nothing containerized. This part needs no Azure, no new
permissions, and no API key.**

### A1 · Get the engine into version control

`run_workflow.py`, `co_state.py` and their companions currently live in a synced
SharePoint folder. That is a risk today independent of this phase — a 196 KB script that
runs the business daily, with no history, no diff, and no way to answer "what changed."

Create `phb-co-engine` under the `peckhannafordbriggs` org, or a directory in an
existing repo if that's cleaner. Commit the current state **unmodified** as the first
commit, so there's a known-good baseline to diff every later change against.

Do not reformat, do not lint, do not tidy. The first commit is a photograph.

**Code and prompts only — no data.** The engine lives beside real change-order data:
vendor emails, pricing, `state/*.json` with live CO content. None of that goes into git,
for the same reason the platform never commits real message content as fixtures. Write
the `.gitignore` first, before the first commit, and check what's staged against it.

### A2 · Inventory what actually happens

Read the code and the two scheduled task prompts, and write
`docs/12-ai-layer-inventory.md` recording:

- Every file the engine reads, and from where
- Every file it writes, and to where — flagging the four sentinel filenames explicitly
- Every point where a Claude judgment call happens rather than deterministic logic, and
  what each one decides
- What each of the two scheduled tasks does, in order
- Every external dependency: Excel, SharePoint paths, the lock file, anything
  environment-specific
- Every Windows-specific assumption — path separators, drive letters, line endings, the
  synced-folder location

**Distinguish what you observed in the code from what you inferred.** This inventory is
the input to everything after it, and a wrong assumption here propagates.

### A3 · Establish the output contract

Before changing anything, capture what a correct run produces. Pick several real past
runs and record, for each:

- The exact bytes of each sentinel JSON written
- The resulting `state/*.json`
- The run report

This becomes the fixture set the shadow-run diff compares against in Part E. Without it
there's no definition of "identical" to test against.

**The fixtures contain real business data — they stay out of git.** Store them in a
gitignored directory or the private SharePoint, referenced by path.

**Record which bytes are time-derived.** Run reports and state files embed timestamps, so
a replay can never match a past run byte-for-byte unless the clock is pinned or those
fields are normalized. Decide which now — an injectable clock in the harness, or a
normalizer in the differ — because "byte-identical" is only a usable bar once
time-derived bytes are accounted for.

---

## Part B — Extract the file-access interface

**Still no Azure, no new permissions, no container. Behaviour must be unchanged.**

One interface, two implementations:

- `LocalFileStore` — the filesystem, exactly what runs today
- `GraphFileStore` — SharePoint via Microsoft Graph, written but not yet used

Every read and write in the engine goes through the interface. Nothing else in the script
changes: same logic, same order, same output.

**The test that matters:** with `LocalFileStore` selected, the engine produces output
byte-identical to the Part A3 fixtures once time-derived bytes are pinned or normalized,
per A3's decision. If it doesn't, the extraction changed behaviour and it isn't done.
(If A2 finds any judgment call inline in the replayed path rather than in the Cowork
layer, those outputs are compared semantically, not byte-wise — an LLM response varies.)

Two constraints that survive the refactor:

- **`Bid Tracker.xlsx` is never written through this interface, or any other.** Power
  Automate binds to the Excel table and a library rewrite silently breaks it. Read-only,
  Graph workbook API only.
- **The four sentinel filenames are written only where they're written today.** The
  interface must not make it easier to write one by accident.

---

## Part C — Containerize

**Needs: Azure (Phase 7 complete), and `Sites.Selected` Graph permission on the
AISandbox site — a third request to Vitis.**

Package the engine with the `GraphFileStore` implementation. Python container, same
codebase, no logic changes.

- Runs against a **copy** of the SharePoint tree, never the live one
- Credentials via managed identity, no secrets in the image
- **The lock stays a lock file, through the FileStore interface** — it's just a file, so
  it works identically in both implementations, and it keeps the engine free of any
  platform-database dependency. Whether the mechanism should change is a Phase 14
  question, decided at cutover. In this phase the container points only at the copy, so
  it can never contend for the live lock — and that isolation, not the lock, is what
  protects the pipeline.

Verify `GraphFileStore` produces byte-identical output to `LocalFileStore` against the
same inputs. Two implementations of one interface disagreeing is the failure this part
exists to catch.

**One known trap:** writing a file through Graph changes its metadata. Power Automate
matches on filenames, so this *should* be irrelevant — verify that rather than assuming
it, because the flows are the thing that must not break.

---

## Part D — Move the judgment to the Claude API

**Needs: a company Anthropic API key.** BAS phase B5 is blocked on the same thing.

Replace the Cowork judgment steps one at a time, lowest consequence first. From the
inventory, that ordering is likely: language review, then classification, then any draft
composition — but confirm against A2 rather than taking my word.

For each:

- **The prompt moves to the repo**, versioned. SharePoint remains authoritative until
  Phase 14 cutover, and the repo copy is a mirror until that day. Two authoritative
  copies is the defect this project exists to prevent.
- **Validate every model response against a strict schema** before anything touches disk.
- **Model output must never choose a filename.** The sentinel filenames are load-bearing;
  they are constants in code, not values in a response.
- **Model output must never choose recipients or trigger a send.** The human-send gate is
  the entire safety model and this phase does not touch it.
- **Log the prompt version, tokens, latency and outcome** for every call.

### Prompt injection is a real risk here

Vendor and PM email bodies are untrusted input to the classifier. A vendor can put
instructions in an email. Mitigations: pass email content as clearly delimited data,
never as instructions; validate output against a schema; and keep the constraints above,
which mean the worst case is a wrong classification rather than a wrong action.

---

## Part E — Shadow run and diff

The container runs against a copy on the same schedule as the laptop, and their outputs
are compared automatically.

- **Weeks, not days.** The pipeline sees cases that don't occur daily — an incomplete
  PM submission, a vendor reply that isn't a quote, a CO with an unusual project number.
  Cutting this short is how a rare-path bug reaches production.
- Diff the sentinel JSON payloads, `state/*.json`, and the run reports
- **Where the two disagree, the laptop is right until proven otherwise.** Investigate
  every difference; don't tune the container until it matches.
- Judgment steps won't be byte-identical — an LLM response varies. Define equivalence for
  those explicitly: the same classification, the same fields flagged, the same decision.
  Semantic equivalence is the bar, and what counts as equivalent needs writing down before
  the comparison starts, not after a disagreement.

Phase 12 is complete when the container has produced equivalent output for a sustained
period, and the disagreements are understood. **Not when it runs.**

---

## Out of scope

- **Cutover.** Phase 14. The laptop keeps running throughout.
- **Scheduling and alerting.** Phase 13.
- Any change to the eleven Power Automate flows
- Any change to the four sentinel filenames or the paths they're written to
- Any change to the platform's mail module
- Any change to the human-send gate
- Rewriting, refactoring or "improving" engine logic. Anything beyond the file-access
  extraction is a separate decision with its own justification

---

## Hard constraints

- **Never write `Bid Tracker.xlsx`** from code. Graph workbook API, read-only.
- **Never write a sentinel filename** outside the one place the engine already writes it.
- **Never run the container and the laptop against live simultaneously.**
- **Never fix the SharePoint path spelling.** `CO Managment Process`, one A.
- **Do not touch the eleven flows.**
- The platform's existing tests must still pass. This work should not require changes to
  `phb-platform` at all — if it does, stop and ask.

---

## Acceptance criteria

**Part A**

- [ ] Engine committed unmodified as a first commit in version control
- [ ] `.gitignore` written before the first commit; no CO data, vendor content, or state
      files tracked — verified against what's staged
- [ ] `docs/12-ai-layer-inventory.md` written, distinguishing observed from inferred
- [ ] Output fixtures captured from several real past runs, stored outside git, with
      time-derived bytes identified and a pin-or-normalize decision recorded
- [ ] Nothing in the live pipeline changed

**Part B**

- [ ] One file-access interface, two implementations
- [ ] `LocalFileStore` produces byte-identical output to the Part A3 fixtures
- [ ] `Bid Tracker.xlsx` is unreachable through the interface
- [ ] The live scheduled tasks still run unchanged

**Part C**

- [ ] Container runs against a copy, never live
- [ ] `GraphFileStore` output byte-identical to `LocalFileStore`
- [ ] Graph metadata changes verified not to affect flow triggering
- [ ] The container cannot acquire the live lock

**Part D**

- [ ] Each judgment step replaced individually, lowest consequence first
- [ ] Every response schema-validated before touching disk
- [ ] No model output can name a file, choose a recipient, or trigger a send
- [ ] Prompts versioned in the repo; SharePoint still authoritative
- [ ] Every call logged with prompt version and outcome

**Part E**

- [ ] Shadow running on schedule against a copy
- [ ] Automated diff of sentinel JSON, state files and run reports
- [ ] Equivalence defined in writing for the judgment steps before comparison began
- [ ] A sustained period of equivalent output, with every disagreement investigated

---

## Notes for the implementer

**Part A is not a formality.** The inventory is the input to every later part, and the
fixtures are the only definition of "correct" this phase has. Rushing it means Part E
has nothing to compare against.

**Verify against the real thing.** Every phase touching an external system found defects
that mocked transports agreed with. Graph Files will have its own set.

**A rare-path bug is the realistic failure here.** The common cases will work early and
look finished. What breaks is the incomplete submission, the odd project number, the
vendor reply that isn't a quote. Those are why Part E is measured in weeks.

**Stop and ask** before changing any engine logic beyond the file-access extraction,
before anything runs against the live folders, before touching a flow, and before
anything that would let the container and the laptop run at once.
