# Cost Intelligence: the plan

## What we are building

A place in the PHB Platform where an estimator picks a job and a workflow, presses
**Start run**, and gets finished estimating documents saved back into the job's
**AI FILES** folder. When the run needs a human (a question only the engineer can
answer, or an Excel file that has to be recalculated), it pauses, asks, and carries
on once answered.

## How it works, in one paragraph

Anthropic's **Managed Agents** does the thinking. It runs Claude with our published
skills inside a locked-down container. **Our platform does everything else.** It
reads the job folder from SharePoint, hands the files to the agent, shows questions
to the engineer, sends the answers back, and saves the results to AI FILES. The agent
never talks to SharePoint or Outlook directly; only our platform does, and it is only
allowed to write to AI FILES.

## Before we start

These need answers first. Nothing below can be tested without them.

1. **An Anthropic account.** A first-party Anthropic API account (not through
   Microsoft Foundry, because Managed Agents is not available there). The key goes in
   Key Vault.
2. **SharePoint access.** Ask IT for `Sites.Selected` on the site that holds the job
   folders. Without it the platform cannot read a single job.
3. **Sign-off on where documents go.** Job files are processed in Anthropic's
   containers. Someone has to approve that. If the answer is no, we run the containers
   in our own Azure instead, which takes more setup but changes nothing else.
4. **Accept that it is beta.** Managed Agents is in beta. Fine for a pilot; worth a
   conscious yes before the business depends on it.

## The steps

Each step makes one of the existing skeleton screens real. Do them in order, and do
not start the next until the "done when" line is true.

### Step 1: One run, start to finish, no pauses

- Create one agent with one skill (bid kickoff).
- Copy a real job folder somewhere safe to use as a test job.
- Start a run against it and get a document back.

**Done when:** the kickoff document from the test job is correct, and we have seen
exactly which files left our tenant.

### Step 2: Hearing about progress

- Add a webhook endpoint so Anthropic tells us when a run moves forward.
- Save every step into our own run history (the ledger).
- Make the Runs page and the Run page show real runs.

**Done when:** you can start a run, close the tab, come back later, and the page shows
exactly what happened.

### Step 3: Asking the engineer a question

- Give the agent a `request_decision` tool.
- When it asks, show the question and its options on the run and on the job page.
- Send the answer back, and save it as job memory so later runs reuse it.

**Done when:** a run pauses on a real question, waits overnight without cost, and
finishes correctly after it is answered.

### Step 4: The Excel save

- Give the agent an `await_excel_save` tool.
- Save the workbook to AI FILES, and let the engineer open it, recalculate and save.
- Have the platform check the saved workbook itself (for example `CE Import!M2705`)
  before letting the run continue.

**Done when:** a run cannot move past this step with an unsaved or wrong workbook.

### Step 5: Saving results safely

- Collect everything the agent produced and write it to the job's AI FILES folder.
- Refuse, in code, any write outside AI FILES.
- Name files the way the team already does (R01, R02 and so on).

**Done when:** a test that tries to write outside AI FILES is refused.

### Step 6: Publishing skills (the Settings page)

- Keep the skills in the `PHB-CIS-skills` repository.
- The cost engineer tests a change against a test job, then presses **Publish**.
- Publishing creates a new version. New runs use it; runs already going keep theirs.

**Done when:** a skill change reaches new runs only after it has been tested and
published, and never mid-run.

### Step 7: Cost and access

- Put a spending cap on every run, and show tokens and cost on the Run page.
- Only offer the job folders the signed-in person can open in SharePoint.

**Done when:** a run that hits its cap pauses rather than overspending, and nobody can
start a run on a job they cannot see in SharePoint.

## What we are not building (yet)

- A chat window. The design is runs and checkpoints, not a conversation.
- A copy of SharePoint in our database. Job folders are always read live.
- Automatic sending of anything. Every output is a file a person opens and checks.

## Where things will live

| Piece | Location |
|---|---|
| Screens | `app/(modules)/cost-intelligence/` |
| Service code (Anthropic, SharePoint, guards) | `lib/modules/cost-intelligence/` |
| Run history, decisions, published versions | New `cip_*` tables in Postgres |
| Skills | The `PHB-CIS-skills` repository |
| Failure notes | `runbook.md`, written as each step lands |
