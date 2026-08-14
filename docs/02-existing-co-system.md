# The existing Change Order system

Read this before any task touching Microsoft 365, SharePoint, Power Automate, or the
mailbox. This system runs PH+B's change-order process daily. It works. Its
characteristic failure mode is **going quiet with no error anywhere**.

---

## The four layers

| Layer | What | Runs where |
|---|---|---|
| State | per-CO JSON files + `co_state.py` | SharePoint |
| Engine | `run_workflow.py` (~196 KB Python) | one Windows machine |
| Judgment | 2 Claude scheduled tasks | same machine |
| I/O | 11 Power Automate flows | `changeorder@phb1899.com` |

Layers 1 and 4 survive anyone leaving. Layers 2 and 3 exist on one laptop.

## The mailbox

`changeorder@phb1899.com` — a **licensed user mailbox**. It owns the Power Automate
connections for all 11 flows. The current operator has Full Access to it in Outlook.

## The 11 flows

`CO Intake 1-7` and `CO Response 1-4`. Event-driven, triggered by files appearing in
SharePoint with exact filenames, plus mailbox triggers. Not in a Power Platform
Solution — loose in the default environment.

**Do not modify, disable, rename, re-authorize, or export any flow.** Current
definitions are exported and archived; that archive is the recovery set, not a
starting point for edits.

## The safety model — the single most important fact

**Nothing this system produces is ever sent automatically.**

Every outbound message is created as an **unsent draft** in `changeorder@`. A human
opens it, reviews it, and clicks Send. `sendMail` appears **zero times** across all
11 flows. This is deliberate.

Five kinds of draft the automation produces:

| Draft | Created by |
|---|---|
| PM resend — additional info needed | Intake 2 |
| Vendor pricing request, one per vendor | Intake 3 |
| Estimating team notification | Intake 5 |
| Vendor reminder (one per CO, ever) | Response 3 |
| Bid-leader handoff | Response 4 |

The platform's whole job is to make reviewing and sending these drafts possible
without Outlook. It must never shortcut the human step.

## The four load-bearing filenames

Each flow watches a folder and fires when a file with an **exact** name appears:

```
scrub_result.json           → Intake 2    drafts the PM resend
vendor_drafts.json          → Intake 3    drafts vendor emails, seeds the tracker
transfer_ready.json         → Intake 4    builds the SharePoint CO folder
classification_result.json  → Response 2  updates the tracker, files quote PDFs
```

A file saved as `scrub_result (1).json` triggers nothing and reports no error.

**Never write a file with one of these names.** When the platform eventually needs to
trigger a flow, writing the correct sentinel is the integration mechanism — but only
as a deliberate, specified task, never incidentally.

## Excel rules

**`Bid Tracker.xlsx`** — live operational state, written by Power Automate. Power
Automate binds to the Excel ListObject. Writing this file with openpyxl (or any
library that rewrites the workbook) regenerates internal table IDs; the file still
looks correct but the flow silently stops resolving the table. This has happened in
production.

- Never write it from code.
- Read only via the Graph workbook API.
- Its list operations have no pagination and cap around 256 rows.

**`CO Status Tracker.xlsx`** — a generated read-only report, rebuilt from the JSON
state on every scrub. Never hand-edit; edits are overwritten.

## Paths

The SharePoint site is `peckhannafordbriggs.sharepoint.com/sites/AISandbox`, library
`AI Sandbox - Documents`.

The folder is spelled **`CO Managment Process`** — one A. Every flow depends on the
literal string. **Do not fix the spelling.**

## Known defects — do not "fix" without an explicit task

- **`/me/` in Intake 1, 6 and 7** (six occurrences each). Resolves to whoever owns
  the connection, which is `changeorder@` today. Correct by coincidence; would
  silently repoint on a connection swap. Parked by decision.
- **Two Office Scripts** used by Intake 1 are hosted in a personal OneDrive. If that
  account goes away, intake stops.
- **Duplicate tracker rows** exist for at least one CO with the same CO key.
- **Fixed waits** substitute for race handling in several flows (1 min, 30 sec).

These are pre-existing, documented, and outside the platform's scope. Do not touch
them as a side effect of platform work.

## What the platform must never assume

- That it can stop the automation "briefly" to test something.
- That Outlook access can be removed once the platform works.
- That a flow can be edited to make platform integration easier.
- That the AI layer can be moved before the platform is stable and someone owns it.
