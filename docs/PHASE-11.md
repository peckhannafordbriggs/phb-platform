# Phase 11 — Verify the Existing Automation Still Works

Read `CLAUDE.md` and `docs/02-existing-co-system.md` first.

**This is a verification phase, not a build phase.** The expected outcome is a document
saying everything still works. If that requires code changes, something has gone wrong
and you should stop and report rather than fixing it quietly.

---

## Goal

Confirm that nine phases of platform work have not disturbed the change-order automation,
and record the evidence.

The design says they can't interfere: the platform and the flows never talk to each other,
both talk to Exchange and SharePoint, and the platform holds no state. This phase tests
that claim instead of trusting it.

---

## What must not be touched

Absolute, for the whole phase:

- **Do not modify, disable, re-authorize, rename, or export any Power Automate flow.**
  Reading a flow's run history in the portal is fine; changing anything is not.
- **Do not write the four sentinel filenames** anywhere: `scrub_result.json`,
  `vendor_drafts.json`, `transfer_ready.json`, `classification_result.json`.
- **Do not write `Bid Tracker.xlsx`.** Read-only, Graph workbook API only.
- **Do not trigger a flow deliberately**, including by creating a message or file that
  would satisfy a trigger.
- **Do not run the scheduled tasks off-schedule.**
- `PHB_ALLOW_SEND` stays `false`.

This phase observes. It does not exercise.

---

## What to verify

### 1. Flow health

For each of the 11 flows, from the Power Automate run history:

- Last successful run, and last failure if any
- Whether the failure pattern changed after the platform started reading the mailbox

Two known non-failures are already documented and should be recognized rather than
reported as new: `CO Intake 1` logs an ordinary email with no CO form as a stop, and
`CO Response 3` had a single Bid Tracker read hiccup on 6 August.

The question isn't "are the flows healthy in absolute terms" — they have documented
defects. It's **whether anything changed since the platform arrived.**

### 2. Nothing the platform did shows up in the pipeline

The platform has created, edited, moved, deleted and sent messages in the mailbox since
Phase 6. Confirm none of it leaked into the automation:

- No `ZZTEST` subject appears in `Bid Tracker.xlsx`
- No `ZZTEST` conversation triggered a flow run
- No CO state file references a platform-created message
- The nine drafts the verification scripts created and deleted left no trace beyond
  Deleted Items and Recoverable Items

`ZZTEST` fixtures are the natural probe here, because if anything was going to leak, they
would have.

### 3. State integrity

- SharePoint CO state files are intact and readable, and their count and modification
  times are consistent with the automation writing them rather than us
- `Bid Tracker.xlsx` row count and the workbook's table binding are unchanged — the
  ListObject still resolves, which is the failure mode a library write causes
- The `CO Managment Process` path is still spelled with one A

### 4. Scheduled task evidence

The two Cowork tasks run on a laptop and can't be inspected from here. What can be
checked:

- The most recent run reports exist in SharePoint, with expected timestamps
- The sentinel files the tasks produce have modification times consistent with scheduled
  runs
- No gap in the run reports that coincides with platform activity

If there's a gap, report it. Do not investigate by running anything.

### 5. The Outlook path still works

The platform must never be the only route. Confirm the operator's existing Outlook access
to `changeorder@phb1899.com` is unchanged, and that nothing the platform did removed a
permission, changed a folder the flows depend on, or altered the mailbox's configuration.

Folders the automation created — the `Projects` tree in particular — must be intact, since
Intake 6 and 7 file into them.

---

## Deliverable

`docs/phase-11-verification.md`, containing:

- A table of the 11 flows with last success, last failure, and whether the pattern changed
- The leak checks, each with what was queried and what came back
- State integrity results
- Scheduled task evidence, including any gap
- A plain statement of what was **observed** versus what was **inferred**. Anything that
  couldn't be checked from here is recorded as not run, not assumed

Then update `docs/runbook.md` with anything learned about how to perform this check again,
since it should be repeatable by someone who has never seen the system.

---

## Acceptance criteria

- [ ] All 11 flows accounted for, with the two documented non-failures recognized as such
- [ ] No `ZZTEST` artifact anywhere in the pipeline's state
- [ ] `Bid Tracker.xlsx` table binding intact, row count consistent
- [ ] SharePoint state files intact
- [ ] Scheduled task run reports present, or a gap explicitly reported
- [ ] Outlook access and the `Projects` folder tree unchanged
- [ ] `docs/phase-11-verification.md` written, distinguishing observed from inferred
- [ ] No flow, sentinel file, or Excel workbook was modified
- [ ] All existing tests still pass
- [ ] `PHB_ALLOW_SEND` still `false`

---

## Notes for the implementer

**A clean result is the expected result.** Don't manufacture findings. "Nothing changed,
and here's what I checked" is the deliverable.

**If something did change, stop and report it.** Do not fix a flow, a sentinel file, or
the tracker. Those are outside the platform's scope and a fix applied without
understanding could break a daily process.

**Some of this needs a person.** Flow run history is in the Power Automate portal, and the
scheduled tasks are on a laptop. Say clearly what you need looked up rather than inferring
from what's reachable through Graph.

**Stop and ask** before writing anything to SharePoint, touching a flow, or running any
script that isn't purely read-only.
