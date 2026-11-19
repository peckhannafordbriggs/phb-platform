# PHB Internal Platform — Handover

*For whoever owns this after December 2026. Built by Karthik and Mahi as of December 2026.*

Read this first. It is deliberately short and deliberately honest — about what works, what
doesn't, what will break, and what you can safely ignore.

Three other documents matter, in this order:

| When | Read |
|---|---|
| Something is broken right now | `runbook.md` |
| You are about to change something | `WHY-ITS-BUILT-THIS-WAY.md` |
| You need to run it locally | `DEVELOPER-SETUP.md` |
| You are about to build a module | `PLATFORM-CONTEXT.md` |

---

## 1 · What this is, in one page

An internal web platform for Peck Hannaford + Briggs. Employees sign in with their PH+B
Microsoft account and see whichever internal systems an admin has granted them.

Two modules are in service, Change Orders and BAS. Karthik's two are built in the same
repository and deployed beside them.

**Change Orders** — a company-owned interface to the `changeorder@phb1899.com` mailbox. The
change-order automation (eleven Power Automate flows, SharePoint, and two scheduled AI
tasks) creates draft emails; a human reviews and sends them. This module lets that happen
in the platform instead of Outlook.

**BAS** — Building Automation. A collector on the office PC reads sensor history out of
the building controllers every 15 minutes and writes it to the platform's Azure database.
The module browses it, answers questions about it (Analyze), and writes scheduled health
reports from it (Reports).

**Cost Intelligence** (module 3) and **Freeze Protection** (module 5) — built by Karthik
(`krachamolla@phb1899.com`) in this same repository. Cost Intelligence runs its work in an
Azure job of its own; Freeze Protection holds each job's equipment schedule and its freeze
protection verification. How far each is in day-to-day use is Karthik's to say. They were
the first modules built by someone other than the platform's original author, which is
the point: the module contract in `PLATFORM-CONTEXT.md` was written to be followed rather
than explained in person. A Knowledge Base page is registered as well.

### Why it exists

Before this, running the change-order process required a specific laptop configuration: a
synced SharePoint library, a Claude desktop app with folders connected, two scheduled tasks
recreated by hand, and mailbox permission in Outlook. That setup has been handed between
operators once, and the handover took nineteen documents.

The platform's purpose is that an employee needs none of it. They sign in and the system is
there. Onboarding is a toggle, not a setup.

### What it is not

It is **not** a replacement for the change-order automation. Those eleven flows still run,
untouched, and should continue to. The platform sits alongside them.

---

## 2 · The two things that matter most

If you remember nothing else from this document, remember these.

### Outlook must keep working, permanently

The Change Orders module is an *additional* way to review and send change-order email.
Outlook is the original way and must stay functional forever. Don't remove anyone's mailbox
permission, don't decommission anything, don't build a feature the platform is the only
route to.

**Why this protects you.** If the platform breaks and nobody notices for a week, the change
orders still went out. That's the failure mode this design was chosen for, and it's what
makes the platform safe to own casually.

### The BAS database must never be stopped

The building controller keeps roughly 42 hours of sensor history and then **overwrites it
silently**. The collector reads it out every 15 minutes. Past that window, the platform
database is the only copy of that data in existence.

- The web app can be stopped or scaled to zero freely.
- **The PostgreSQL database cannot.** A stopped database means the collector can't write,
  and data is destroyed at the source while nothing is watching.
- Overnight is survivable. A weekend is not — measured at 64.3 h, 64.5 h and 113.4 h.
- Backups are a correctness requirement, not hygiene.

This has already cost real data three times: 22.6 hours per point over 21–24 August,
22.8 over 28–31 August, and 71.7 over 3–8 September. Two causes, not one — a sleeping
laptop, and a laptop away from the building network, which collects nothing even while
awake and firing on cadence. See `docs/09-bas-what-is-built.md`, *Proven in operation*.
The collector has since moved to the office PC and the database to Azure, which removes
both of those causes and not the rule: the office PC can still be switched off, and the
Azure server can still be stopped.

---

## 3 · How it runs

```
Employee browser
      │  Microsoft sign-in (Entra ID)
      ▼
Next.js app (Azure Container Apps, eastus2) — https://platform.phb1899.com
      │
      ├──► PostgreSQL (Azure) ── employees, grants, audit, BAS readings, reports
      ├──► Microsoft Graph ──► changeorder@phb1899.com mailbox; SharePoint folders
      └──► Key Vault ── secrets, by reference, never in the template

Container Apps Jobs, same identity and database, no web traffic:
      Cost Intelligence worker · BAS Reports scheduler and worker
      · nightly database backup (built, not yet turned on — § 7)

Separately, and independently:

Building controllers ──► Python collector on the office PC (phb-bas) ──► same PostgreSQL
Change-order automation (11 Power Automate flows) ──► same mailbox
```

**Deployed as of 9 September 2026, in `eastus2`.** That diagram is the shape of the
running system rather than a plan. All seven Azure resources are up, the migrations are
applied, and the production seed has run once. Sign-in to the deployed site works and
has for weeks: the admins, Mahi and two testers use it. The container app serves
whatever the last merge to `main` deployed — real images built by CI, not the
placeholder, which last appeared in the 13 October incident (`runbook.md` → *A template
deployment fails activation*). See
*Production deployment* below. `runbook.md` → *Deploying to Azure (Phase 7 Part B)* is
kept current and this is a summary.

The platform and the change-order automation **never talk to each other.** Both talk to
Exchange. That independence was verified in Phase 11 — no flow ran during any platform
write window, and nothing the platform did appeared in the pipeline's state.

### Three repositories

| Repo | Contains |
|---|---|
| `phb-platform` | The web app, the jobs, database schema, every module, CI, Azure templates |
| `phb-bas` | The Python collector, Grafana dashboards, MCP server, backup scripts |
| `phb-co-engine` | The change-order engine and classifier, containerised for the move off the laptop (§ 6). Not yet the live engine |

The database is the only connection between `phb-platform` and `phb-bas`. Neither
repository's tests can exercise the other — worth knowing before you trust a green suite.

### Stack

Next.js 15 / TypeScript / React / Tailwind. PostgreSQL with Prisma. Auth.js with the
Microsoft Entra ID provider. Microsoft Graph. Azure Container Apps, Postgres Flexible
Server, Key Vault. Tests in Vitest against a real Postgres database.

Deliberately boring. No microservices, no message queue, no Redis: the background work
runs as Container Apps Jobs, and their queues are rows in the same database.

---

## 4 · Access and accounts

### Who can sign in

Anyone with a `@phb1899.com` account. Signing in grants nothing — an admin has to enable
each module per person.

There is **no create-employee function.** Employees appear in the admin list when they
first sign in. This is intentional.

### The five admins

The list below is what production's `BOOTSTRAP_ADMIN_EMAIL` held when this was written,
not a statement of who should be an admin: to change it, edit the variable on the
container app and redeploy (the seed adds admins, it never removes them), and
add or remove the admin flag on the Admin screen. Remember the platform refuses
to leave zero active admins.

Seeded from the `BOOTSTRAP_ADMIN_EMAIL` environment variable:
- `krachamolla@phb1899.com`
- `msheth@phb1899.com`
- `jschwarz@phb1899.com`
- `jschriner@phb1899.com`
- `bbolten@phb1899.com`

Admins can grant and revoke module access, enable and disable employees, manage the admin
flag, and edit positions and departments. The system refuses to leave zero active admins.

### To remove someone who has left

Disable them in the admin screen. Don't delete — a deleted row orphans their audit history,
and their name is the only record of who sent a given change-order email. Disabling revokes
access on their next request.

IT disabling their Entra account is the outer backstop; SSO then fails regardless.

### The Microsoft app registrations

The platform's own, created by Vitis Technologies (Cost Intelligence and the
Knowledge Base hold their own folder-scoped registrations; `.env.example`
names them):

| Registration | Purpose | Notes |
|---|---|---|
| SSO | Employee sign-in | Client ID `220921c1-f23e-4d01-b354-736884ba3d00`. Client secret expires **13 August 2028** |
| Change Order Mail | Graph access to the mailbox | Client ID `d1795907-d017-4a5e-9da3-033c4bee4ec1`. Scoped by Exchange policy to that one mailbox. **No SharePoint access, by design** |
| phb-platform-co-review | Read-only Graph access to ONE SharePoint folder, `_needs_review`, for the Needs Review tab | Client ID `b9e81eed-5153-4d73-a72a-1f729e37ad21`, created 2026-10-21. `Files.SelectedOperations.Selected` consented, to be granted Read on that folder only. **As of 2026-11-11 it has no federated identity credential**, so production cannot sign in as it, the three template parameters stay blank and the tab says "not connected"; the folder grant is unconfirmed. It will sign in with the managed identity; no secret. `runbook.md` → *What to ask IT for* → *Request 5 status* |
| phb-platform-bas-mail | Sends BAS report email from `controlls@phb1899.com` | **Requested, not confirmed** (Request 7). `Mail.Send` only, fenced by its own Exchange policy to that one mailbox, managed identity and no secret. Until it exists, and `BAS_REPORTS_ALLOW_SEND` is opened (§ 8), report email does not go and each delivery says why. `runbook.md` → *Turning report email on* |

The change-order engine's registrations, including the read-only reader the shadow run is
waiting on (Request 6), belong to `phb-co-engine`; `runbook.md` → *What to ask IT for* has
every request and its status.

**The mailbox fence is load-bearing.** Graph application permissions reach every mailbox in
the tenant by default. An Exchange ApplicationAccessPolicy restricts this app to
`changeorder@phb1899.com` alone, verified as `Granted` for that mailbox and `Denied` for
another. If anyone ever recreates that app registration, the policy must be recreated with
it, and verified.

---

## 5 · What will break, and when

This is the section to keep. Everything here is a known future failure with a known cause.

| What | When | Symptom | What to do |
|---|---|---|---|
| SSO client secret expires | **13 August 2028** | Local sign-in fails with `AADSTS7000215`. **Production is not affected**: it carries no secret and authenticates the token exchange with the managed identity, matched by a federated identity credential on the SSO app registration — `runbook.md` → *Production sign-in authenticates with the managed identity*. If production ever fails with a secret-shaped error, the fault is that a secret was deployed at all. | Ask IT for a new secret, for developer machines only. `runbook.md` → *What expires, and when* |
| BAS database stopped | If anyone applies a cost policy that stops it | Silent data destruction at the controller | Restart immediately; check for gaps on the Collection Health screen |
| Azure spend alert | If misconfigured, or growth | Email at a forecast of 80 % and at 100 % of the $150/month budget, to `msheth@phb1899.com` and `jschwarz@phb1899.com` (`budgetContactEmails` in the gitignored parameters file, both since 2026-11-02) | Expected spend is $60–100. When either person leaves, put a current address in the parameters file and redeploy - `runbook.md` → *Verify the deployment before migrating*, step 1 |
| Collector host offline | The office PC switched off, rebooted or off the network | Gaps appear on Collection Health | Restart the collector. Anything past ~42 hours is already gone |
| The Anthropic keys stop | **The day Jim leaves the organisation** | BAS Analyze says the key was rejected, and the change-order classifier stops at its next call. Reports use the same BAS key for their written sentences, so those go too | The BAS key and the Change Orders key are personal keys linked to Jim, kept that way by the owner's decision of 29 October 2026 as an accepted risk. Replace them before he leaves, not after. `runbook.md` → *Both Anthropic keys fail at once as `401 authentication_error`* |
| Node or dependency EOL | Eventually | Build or deploy failures | Routine maintenance |

**The Graph client secret is deliberately not in that table.** Production
authenticates to Graph with a managed identity and a federated identity credential,
and `createGraphCredential` throws on startup if a `GRAPH_CLIENT_SECRET` is present
with `NODE_ENV=production` — so the secret cannot reach production, and its expiry
cannot break it. It still exists in `.env.local` and will expire eventually, which
will break the mailbox **on developer machines only**. That is in `runbook.md` →
*What expires, and when*, where a developer hitting it will look.

**None of these fail loudly.** That's the pattern across this whole system — the
characteristic bug isn't a crash, it's something that quietly didn't happen. `runbook.md`
is organized around symptoms for exactly that reason.

---

## 6 · What is finished and what isn't

### Change Orders — working and verified

Sign in, employee provisioning, admin-controlled access, the full mailbox: folder tree,
message list, reading pane, search, attachments. Draft review, editing and sending —
verified end to end against the live mailbox. Reply, reply-all, forward, compose, move,
delete. Conversation grouping. Pictures in a message body are shown.

A **Needs Review** tab lists the notes the change-order classifier leaves in SharePoint's
`_needs_review` folder, beside the email each one is about. It is read-only by
construction — a handled note is still moved by a person in SharePoint — and it says "not
connected" until its app registration can sign in (§ 4).

3,018 automated tests across the platform as of 18 November 2026, plus verification
records in `docs/` for Phases 1, 8, 9, 11 and 12 Parts B–D, BAS Analyze, the
value-plausibility check and Reports Phase 2.

**The UI redesign shipped too**, across several phases rather than as one. The palette is
sampled from the logo and every value carries the WCAG measurement that justifies it;
Archivo and Figtree are split by role rather than by size; the quartered diamond is the
signature. BAS was rebuilt around a headroom hero tile, Home became a personal launcher,
and Change Orders gained resizable panes, breakpoints and keyboard navigation. The record
is `docs/DESIGN-BRIEF.md` and the token comments in `app/globals.css`.

### BAS — working, on real building data

Twenty-four `bas_*` tables, six views, the collector running, six tabs — a Projects tab
of cards, Point Explorer, Analyze, Reports, Collection Health, and a Settings tab behind a
module-admin permission — and scoped database accounts for the collector, the web app and
Analyze. How the data is backed up is in § 7.

**Analyze (B5, 2026-09-21)** is a question box: the model writes one read-only `SELECT`,
it runs as the `bas_analyze` role, and every answer shows the rows, the points and period covered, the hours of
the period nobody was watching, and whether the readings held actually span the period
asked about. Verified live on 21 September against the office data. It needs two things,
and production has both: the Anthropic API key in Key Vault (`ANTHROPIC_API_KEY`,
rotated to a non-expiring key on 16 October 2026) and the `bas_analyze` role on the
Azure database (created 13 October 2026 with `scripts/setup-bas-analyze-role.sql`, its
URL in the vault as `BAS-ASK-DATABASE-URL`). The deployed tab answers questions end to
end, checked 21 October 2026. Without either the tab says it is not configured and
nothing else is affected. A key can be revoked
or run out of credit, and when it does this tab stops, and so do the written sentences in
Reports, which use the same key; `runbook.md` → *Analyze says the model service rejected
the API key*.

**Reports (November 2026)** turn Jim's health-report spec — twenty questions,
`docs/BAS Health Report Build Spec.md` — into a scheduled report per building. Code
computes every number and decides every status; the model writes only the sentences
around them. Each run is stored as a page and a PDF. Two Container Apps Jobs run them: a
scheduler on a 15-minute cron and a worker that drains the queue, both under one
module-wide safety ceiling on spend and time per run that a module admin edits on the
Usage page. **Report email is built and does not send yet**: it waits on the sender app
registration (§ 4) and its own gate (§ 8). It is the one deliberate automatic send in the
platform, from `controlls@phb1899.com`, and never from the Change Orders mailbox. Expect
the office's reports to read mostly *Not Monitored*: its controller does not trend zone
setpoints, fan status or compressors, and that is a station change, not a platform fault.
`runbook.md` has a section per symptom, all under *Reports:*.

B7 added a project level above buildings and encrypted station credentials. The record is
`docs/09-bas-what-is-built.md`; the reasoning is `docs/08-bas-and-niagara.md`.

**The data is real.** The office JACE has been connected since August 2026 and the
module runs on its readings, with the lab station (four synthetic points, not PH+B's
asset) still collected beside it. The history was moved into the Azure database, so the
deployed site shows readings back to 21 February 2024. For the next building the question isn't the
controller's address — it's whether history extensions are configured on its station at
all. If nobody ever set them up, that becomes a Niagara engineering job before it's a
data job.

### Not built, deliberately

- **The CO context panel** — a draft shown alongside its change-order record. The most
  attractive feature proposed and the only one with no Outlook fallback. Cut so nobody
  becomes dependent on the platform.
- **Graph webhooks** — evaluated, measured, declined. Polling every 20 seconds uses 0.3% of
  the API budget and Exchange responds in 250 ms.
- **BAS fault rules and anomaly detection** — the second half of the original *Ask*
  design in `docs/08`. B5 shipped as the Analyze tab (one `SELECT` per question, see
  the BAS section) and stopped there.
- **Moving the change-order AI off the laptop** — not finished rather than not built; see
  below.

### Production deployment (Phase 7 Part B) — deployed, CI live, sign-in working

Part A built the Dockerfile, the CI pipeline and the Bicep. Part B deployed them on
9 September 2026. **Do not act on this summary without reading `runbook.md` →
*Deploying to Azure (Phase 7 Part B)***, which is kept current.

| | |
|---|---|
| Running | Seven resources in `eastus2` at the first deployment, with Container Apps Jobs added since (§ 3). Every migration on `main` is applied by the deploy job on merge — 39 as of 18 November 2026; the count is in `prisma/migrations/`, not here. The production seed ran once, by hand, on 9 September, and never again: a module row reaches production by migration |
| Address | `https://platform.phb1899.com` since 22 October 2026, with a managed certificate; the original `azurecontainerapps.io` address still answers, and a sign-in started there finishes on the new one |
| Region | `eastus2`, not `eastus` — PostgreSQL Flexible Server is **offer-restricted** in `eastus` for this subscription. A restriction, not a quota, so more capacity cannot be requested |
| Sign-in | Works, and has for weeks: the admins, Mahi and two testers use the deployed site. The production redirect URI is therefore in place |
| Image | Real images built from `main` by CI; the deploy app registration is done (`AZURE_CLIENT_ID` set on 16 September 2026), so a merge to `main` runs a real deploy. The placeholder last appeared in the 13 October incident, `runbook.md` → *A template deployment fails activation* |
| Mail | The deployed Change Orders module reads the mailbox, so the Graph federated credential from `runbook.md` → *Request 2* is in place. The send gate has been open in production since 14 October 2026 (§ 8) |

Three permission walls were hit getting here, all from *scope* rather than from the role
names, and all worth knowing before the next Azure task: resource provider registration
is subscription-scoped; `roleAssignments/write` is in Contributor's `notActions`; and Key
Vault **purge** is subscription-scoped, because a soft-deleted vault does not live in a
resource group.

Two traps worth carrying out of it:

- A vault deleted from `eastus` is purged **from `eastus`**, even when the redeployment
  targets `eastus2`. The region argument is where it was, not where it is going.
- `az keyvault list-deleted` returns an **empty array rather than an error** when you
  lack permission to see deleted vaults. That reads exactly like "the name is free" and
  is not. Use `checkNameAvailability`, which answers honestly.

**The BAS data is in the Azure database, and the collector writes there.** The one-shot
move, `scripts/bas-migrate-to-azure/` (export, import in one transaction as a role that
cannot touch the platform's tables, check), was tested against a faithful scratch copy
on 29 September 2026 and has since been run: the deployed Point Explorer shows readings
from 21 February 2024 onward, and the collector on the office PC writes to the Azure
server every 15 minutes, so the deployed site shows today's readings (both checked
20–21 October 2026). `scripts/setup-bas-collector-role.sql` is the collector's
least-privilege role for the Azure server. `BAS_CREDENTIAL_KEY` and `ANTHROPIC_API_KEY`
reach the container app from Key Vault by reference as of 2026-10-01
(`BAS-CREDENTIAL-KEY`, `ANTHROPIC-API-KEY`, each behind a boolean parameter), and the
Analyze tab's `BAS_ASK_DATABASE_URL` the same way since 2026-10-13. The three secret
VALUES are set in the vault by hand and nothing in the repository can tell you whether
that has been done — the deployed site is the check, and as of 21 October 2026 it
passes: the station-login panel decrypts the stored JACE credentials and the Analyze
tab answers. If either says it is not configured in production, a flag went back to
false or the revision predates the deployment that turned it on; `infra/README.md` has
the steps to re-set and confirm each. Each module that calls a model has its **own**
Anthropic key, so they are billed, rate-limited and revoked independently, and none falls
back to another: BAS (`ANTHROPIC_API_KEY`), Change Orders (`CO_ANTHROPIC_API_KEY`, read by
the classifier in `phb-co-engine`'s job and never by the web app, so
`coAnthropicApiKeyInKeyVault` stays false), Cost Intelligence (`ANTHROPIC-API-KEY-CIP`, on
its worker job) and Freeze Protection (`FP_ANTHROPIC_API_KEY`, its schedule import). All of it is in `runbook.md` → *Moving
the BAS data to the Azure database* and the sections after it, and *Secrets set by hand
in Key Vault*.

### Moving the AI layer off the laptop

The two scheduled AI tasks that drive the change-order automation still run on one Windows
machine — **this one**, under `C:\Users\Msheth`, not the previous operator's. The Cowork
app log settles that, and the crons match what `09 Scheduled Task Prompts VERBATIM`
recorded — that is a document in the SharePoint `CO Process Handoff` corpus (see § 9),
not a file in this repository. Moving them into Azure is Phases 12–14.

**Phase 12 Parts A to D are done, and Part E is built and waiting on one grant.** The
engine is in version control for the first time
(`phb-co-engine`), the inventory that every later part depends on is written
(`docs/12-ai-layer-inventory.md`), a dormant `Bid Tracker.xlsx` write was found and
removed, and one file-access interface has been extracted with two implementations. The
Graph one has run against SharePoint as the engine's own identity, from a container in
Azure, and produced output equivalent to the local store's on all eight fixture COs
(2026-10-28; `docs/phase-12-part-c-verification.md`). The two before-cutover decisions
were closed the same day: the intake rule is in the repository, and the sentinel flows'
trigger was observed firing on files the engine's identity wrote through Graph
(`docs/phase-12-part-c-plan.md` → *Before cutover*). Part D (29 October) turned the
laptop's classifier into tested code with four model judgments, each of which may decline
to a person, and replayed it against the laptop's own live answers
(`docs/phase-12-part-d-verification.md`). Part E, the shadow run beside the laptop, is
built; it waits on a read-only app registration requested on 29 October (Request 6), and
its window — at least ten laptop weekdays — starts the business day after that lands
(`docs/phase-12-part-e-verification.md`).

It's the only work in this project that can break a pipeline the business depends on daily,
so the sequence matters: extract a file-access layer from a ~196 KB Python script,
containerize it, shadow-run against a copy for weeks, and diff the output before cutover.
Never run both against the live folders at once — the lock file and duplicate detection
make that actively dangerous. Keep the laptop path documented as rollback for at least a
month after cutover. **When cutover day comes, work from `docs/PHASE-14.md`**: it is the
one list of everything the documents say must happen then, each item with its source,
starting with the ways the laptop's engine and the repository's engine differ.

---

## 7 · Routine operations

**Granting someone access.** Admin → Employees → find them (they must have signed in once;
the default order puts people with no access at the top) → open the row with its chevron →
switch the module on. Effective immediately, and recorded: the audit log screen shows
sign-ins, grants, admin changes and disables. Mail sends, BAS questions and the rest are
recorded too, but read with SQL rather than on that screen (`runbook.md` → *The audit log
screen does not show a mail send, a BAS question or a profile change*).

**Someone leaves.** Disable them in Admin. Don't delete.

**Checking BAS health.** The Projects tab at `/bas` shows each project's points at risk; the Collection Health screen at `/bas/health` has the detail. *Points at risk* counts
both confirmed data loss and points whose capacity is unknown — **unknown is not safe and
never renders green.**

**Deploying a change.** Every change reaches `main` through a pull request, including the
platform owner's own. One branch per change, named for what it is — `feat/`, `fix/`,
`refactor/`, `chore/` (which covers documentation) or `release/` — and deleted once it
merges; nobody has a standing personal branch. Someone other than the author reviews and
merges. On merge to `main`, CI runs the tests, builds the container image and boots it,
and compiles the Bicep. Nothing deploys from a personal machine.

`deploy.yml` triggers on `main` and is gated on the `AZURE_*` repository variables. All
seven are set — `AZURE_CLIENT_ID` was the last, on 16 September 2026 — so **a merge to
`main` deploys to production**: image build, migration, revision rollout. The job skips
itself, as a **grey** check rather than a red one, only when one of the first three
variables is empty. Since all are set, a grey check is no longer the gate working; it
means somebody cleared a variable. `runbook.md` → *A deploy fails*.

**Changing the Azure resources themselves** is a template deployment, run by hand, and it
replaces the whole container app with what the template and the gitignored parameters file
say. Two rules come from the times that went wrong. Read the running images and pass them
on the command line (`infra/README.md` → *Deploy*), or the template puts back the
placeholder or a stale image. And run what-if first: if it shows any Delete line, or a
scale change under the app, stop. **A change made by hand in the portal or with `az` is
drift until the parameters file says the same thing** — the next deployment silently
reverts it, as it nearly did twice in November 2026 (a Key Vault reference and the app's
scale). `runbook.md` → *A template what-if shows the container app losing a secret,
gaining blank variables, or changing its probes*.

**Backing up and restoring the database.** The BAS readings live in the Azure database
now, so that is the copy that matters. Today its only backup is the server's own
point-in-time restore, kept for 7 days and lost with the server. A nightly dump to blob
storage, outside the server, was built on 21 October 2026 behind `enableDbBackup` and
**is not yet turned on**: `runbook.md` → *Nightly database backup* has the switch-on
steps, the weekly "did it run" check (nothing alerts on a missed night), and the restore
procedure. Turn it on, then run the restore once, before you need it — an untested backup
isn't a backup. `Test-BasRestore.ps1` in `phb-bas` is the restore test for the office
PC's own database, the primary copy before the move to Azure.

**Verifying the platform hasn't disturbed the automation.** `runbook.md` has the full
repeatable procedure under *Has the platform disturbed the automation?* — six steps across
the mailbox, the Power Automate portal, SharePoint, the collector host and Exchange admin.

---

## 8 · Things to know that aren't written anywhere else

**The SharePoint path is misspelled.** `CO Managment Process` — one A. All eleven flows
depend on the literal string. Do not fix it.

**Two test-data conventions are live and they're different strings.** The platform uses
`ZZTEST`. The Bid Tracker's own test rows use `ZZ`. Searching for `ZZTEST` in that workbook
returns nothing and looks clean while two `ZZ` rows sit in it.

**Four filenames are load-bearing** in the automation: `scrub_result.json`,
`vendor_drafts.json`, `transfer_ready.json`, `classification_result.json`. Each triggers a
flow when it appears. A file saved as `scrub_result (1).json` triggers nothing and reports
no error. Never write these names.

**`Bid Tracker.xlsx` must never be written by a script.** Power Automate binds to the Excel
table; a library rewrite regenerates internal IDs and the flow silently stops resolving it.
Read it through the Graph workbook API only.

**`PHB_ALLOW_SEND` gates every send.** It must be `false` outside production. It exists
because development runs against the live mailbox — there is no test mailbox. In
production it has been `true` since 2026-10-14, pinned by the template; the date, the
reason and the one-command emergency close are in `runbook.md` → *The send gate is
open, deliberately*.

**BAS report email has a gate of its own, `BAS_REPORTS_ALLOW_SEND`,** written on every
template deployment from `basReportsAllowSend` (default `false`). It is deliberately not
`PHB_ALLOW_SEND`: reusing the open Change Orders gate would have started mailing reports
the day the code deployed. Report email is the only automatic send in the platform, and
it is scoped to `controlls@phb1899.com`; the Change Orders rule — one human, one draft,
one deliberate send — is untouched (`CLAUDE.md` prohibition 1;
`WHY-ITS-BUILT-THIS-WAY.md` § 87).

**One outstanding oddity, harmless.** On 26 August, CO Intake 3 logged ten successful runs
but one message reached Sent Items. Possibly a per-vendor fan-out, possibly retries.
Nothing to do with the platform. Worth understanding if you ever work on that flow.

---

## 9 · Who to ask

| Topic | Who |
|---|---|
| Azure, Entra, app registrations, Microsoft licensing | Vitis Technologies |
| Mailbox permissions, M365 access | Brenda Bolten |
| The change-order process itself | Whoever is operating it |
| BAS / Niagara / the building controller | Building Controls & Solutions (the lab station's licence holder) |
| The Cost Intelligence and Freeze Protection modules | Karthik (`krachamolla@phb1899.com`) |
| What a BAS health report should ask | Jim, the author of `docs/BAS Health Report Build Spec.md` |

The change-order automation has its own nineteen-document handoff set in SharePoint under
`CO Process Handoff`. Start with `00 START HERE` and `08 WHY ITS BUILT THIS WAY`. That
corpus is about the automation; this repository's `docs/` is about the platform.

---

## 10 · What I would do first, in your position

1. **Confirm you can sign in and reach the admin screen.** If not, nothing else matters —
   go to `runbook.md` → *Zero admins after seeding*.
2. **Check the BAS Collection Health screen.** It's the only part of this system where
   neglect destroys something irrecoverable.
3. **Read `WHY-ITS-BUILT-THIS-WAY.md` before your first change.** Most of what looks odd is
   odd on purpose.

---

*First written 28 August 2026; revised 14 September 2026, when the platform was deployed
and a second developer joined; last revised 18 November 2026, to match what is running:
the data in Azure, Reports and the jobs, the Admin screen, and the drift rule. Where I wasn't sure, I said so rather than
guessing — that convention runs through the whole `docs/` folder and is worth keeping.*
