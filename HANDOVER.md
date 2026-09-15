# PHB Internal Platform — Handover

*For whoever owns this after December 2026. Written August 2026 by Mahi Sheth, the
co-op intern who built it.*

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

Two modules are in service and a third is being built.

**Change Orders** — a company-owned interface to the `changeorder@phb1899.com` mailbox. The
change-order automation (eleven Power Automate flows, SharePoint, and two scheduled AI
tasks) creates draft emails; a human reviews and sends them. This module lets that happen
in the platform instead of Outlook.

**BAS** — Building Automation. A collector reads sensor history out of a building
controller every 15 minutes and stores it in the platform database. Two dashboards read it.

**Cost Intelligence** — module 3, in progress, built by Karthik
(`krachamolla@phb1899.com`) in this same repository. Not in service yet. It is the first
module built by someone other than the platform's original author, which is the point:
the module contract in `PLATFORM-CONTEXT.md` was written to be followed rather than
explained in person.

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

---

## 3 · How it runs

```
Employee browser
      │  Microsoft sign-in (Entra ID)
      ▼
Next.js app (Azure Container Apps — once deployed; see below)
      │
      ├──► PostgreSQL  ── platform data: employees, grants, audit, BAS readings
      ├──► Microsoft Graph ──► changeorder@phb1899.com mailbox
      └──► Key Vault ── secrets

Separately, and independently:

Building controller ──► Python collector (phb-bas) ──► same PostgreSQL
Change-order automation (11 Power Automate flows) ──► same mailbox
```

**Deployed as of 9 September 2026, in `eastus2`.** That diagram is now the shape of the
running system rather than a plan. All seven Azure resources are up, the migrations are
applied, and the production seed has run once. What is *not* yet true: the container app
still serves a placeholder image, because CI cannot deploy the real one until one app
registration exists — see *Production deployment* below. `runbook.md` →
*Deploying to Azure (Phase 7 Part B)* is kept current and this is a summary.

The platform and the change-order automation **never talk to each other.** Both talk to
Exchange. That independence was verified in Phase 11 — no flow ran during any platform
write window, and nothing the platform did appeared in the pipeline's state.

### Two repositories

| Repo | Contains |
|---|---|
| `phb-platform` | The web app, database schema, both modules, CI, Azure templates |
| `phb-bas` | The Python collector, Grafana dashboards, MCP server, backup scripts |

The database is the only connection between them. Neither repository's tests can exercise
the other — worth knowing before you trust a green suite.

### Stack

Next.js 15 / TypeScript / React / Tailwind. PostgreSQL with Prisma. Auth.js with the
Microsoft Entra ID provider. Microsoft Graph. Azure Container Apps, Postgres Flexible
Server, Key Vault. Tests in Vitest against a real Postgres database.

Deliberately boring. No microservices, no message queue, no Redis.

---

## 4 · Access and accounts

### Who can sign in

Anyone with a `@phb1899.com` account. Signing in grants nothing — an admin has to enable
each module per person.

There is **no create-employee function.** Employees appear in the admin list when they
first sign in. This is intentional.

### The four admins

Seeded from the `BOOTSTRAP_ADMIN_EMAIL` environment variable:

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

Two, both created by Vitis Technologies:

| Registration | Purpose | Notes |
|---|---|---|
| SSO | Employee sign-in | Client ID `220921c1-f23e-4d01-b354-736884ba3d00`. Client secret expires **13 August 2028** |
| Change Order Mail | Graph access to the mailbox | Client ID `d1795907-d017-4a5e-9da3-033c4bee4ec1`. Scoped by Exchange policy to that one mailbox |

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
| SSO client secret expires | **13 August 2028** | Local sign-in fails with `AADSTS7000215`. Whether production is affected is an **open question** — see `runbook.md` → *Does production sign-in need the SSO client secret?* | Ask IT for a new secret. `runbook.md` → *What expires, and when* |
| BAS database stopped | If anyone applies a cost policy that stops it | Silent data destruction at the controller | Restart immediately; check for gaps on the Collection Health screen |
| Azure spend alert | If misconfigured, or growth | Email at $150/month | Expected spend is $60–100 |
| Collector host offline | Laptop closed, machine rebooted, network down | Gaps appear on Collection Health | Restart the collector. Anything past ~42 hours is already gone |
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
delete. Conversation grouping.

1,274 automated tests as of 2026-09-14, plus verification records in `docs/` for Phases
1, 8, 9, 11 and 12 Part B.

**The UI redesign shipped too**, across several phases rather than as one. The palette is
sampled from the logo and every value carries the WCAG measurement that justifies it;
Archivo and Figtree are split by role rather than by size; the quartered diamond is the
signature. BAS was rebuilt around a headroom hero tile, Home became a personal launcher,
and Change Orders gained resizable panes, breakpoints and keyboard navigation. The record
is `docs/DESIGN-BRIEF.md` and the token comments in `app/globals.css`.

### BAS — working, on synthetic data

Fourteen tables, six views, the collector running, three tabs — Collection Health, Point
Explorer and a Settings tab behind a module-admin permission — three scoped database
accounts, nightly backups with a tested restore.

B7 added a project level above buildings and encrypted station credentials. The record is
`docs/09-bas-what-is-built.md`; the reasoning is `docs/08-bas-and-niagara.md`.

**The open dependency:** everything runs against four synthetic points on a lab station
that isn't PH+B's asset. The real question isn't the controller's address — it's whether
history extensions are configured on a production station at all. If nobody ever set them
up, this becomes a Niagara engineering job before it's a data job.

### Not built, deliberately

- **The CO context panel** — a draft shown alongside its change-order record. The most
  attractive feature proposed and the only one with no Outlook fallback. Cut so nobody
  becomes dependent on the platform.
- **Graph webhooks** — evaluated, measured, declined. Polling every 20 seconds uses 0.3% of
  the API budget and Exchange responds in 250 ms.
- **BAS plain-English querying (B5)** — designed, not started. Blocked on a company
  Anthropic API key.
- **Moving the change-order AI off the laptop** — see below. Parts A and B are done.

### Production deployment (Phase 7 Part B) — deployed, one step from live

Part A built the Dockerfile, the CI pipeline and the Bicep. Part B deployed them on
9 September 2026. **Do not act on this summary without reading `runbook.md` →
*Deploying to Azure (Phase 7 Part B)***, which is kept current.

| | |
|---|---|
| Running | Seven resources in `eastus2`, twelve migrations applied, the production seed run once, four admin rows with `entra_oid` null until each first sign-in |
| Region | `eastus2`, not `eastus` — PostgreSQL Flexible Server is **offer-restricted** in `eastus` for this subscription. A restriction, not a quota, so more capacity cannot be requested |
| Remaining | Three Entra changes with Vitis, written out as one email in `runbook.md` → *Request 2*. Until the deploy app registration exists, CI skips itself and the container app serves a placeholder; until the redirect URI exists, nobody can sign in |

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

### Moving the AI layer off the laptop

The two scheduled AI tasks that drive the change-order automation still run on one Windows
machine — **this one**, under `C:\Users\Msheth`, not the previous operator's. The Cowork
app log settles that, and the crons match what `09 Scheduled Task Prompts VERBATIM`
recorded — that is a document in the SharePoint `CO Process Handoff` corpus (see § 9),
not a file in this repository. Moving them into Azure is Phases 12–14.

**Phase 12 Parts A and B are done.** The engine is in version control for the first time
(`phb-co-engine`), the inventory that every later part depends on is written
(`docs/12-ai-layer-inventory.md`), a dormant `Bid Tracker.xlsx` write was found and
removed, and one file-access interface has been extracted with two implementations. The
Graph one has never run. Parts C, D and E are not started.

It's the only work in this project that can break a pipeline the business depends on daily,
so the sequence matters: extract a file-access layer from a ~196 KB Python script,
containerize it, shadow-run against a copy for weeks, and diff the output before cutover.
Never run both against the live folders at once — the lock file and duplicate detection
make that actively dangerous. Keep the laptop path documented as rollback for at least a
month after cutover.

---

## 7 · Routine operations

**Granting someone access.** Admin → find them (they must have signed in once) → toggle the
module on. Effective immediately.

**Someone leaves.** Disable them in Admin. Don't delete.

**Checking BAS health.** The Collection Health screen at `/bas`. *Points at risk* counts
both confirmed data loss and points whose capacity is unknown — **unknown is not safe and
never renders green.**

**Deploying a change.** Every change reaches `main` through a pull request, including the
platform owner's own. Each developer works on their own branch — Mahi's is `mahi`,
Karthik's is his — and someone other than the author reviews and merges. On merge to
`main`, CI runs the tests, builds the container image and boots it, and compiles the
Bicep. Nothing deploys from a personal machine.

`deploy.yml` triggers on `main` and is gated on the `AZURE_*` repository variables. Six
of the seven are set; it skips on `AZURE_CLIENT_ID`, which needs the deploy app
registration Vitis has not created yet. A skip shows as a **grey** check, not a red one —
that is the gate working, not a broken pipeline. Once that client ID is set, the same
push deploys.

**Restoring the BAS database.** `Test-BasRestore.ps1` in `phb-bas` restores to a scratch
database and compares. Run it occasionally — an untested backup isn't a backup.

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
because development runs against the live mailbox — there is no test mailbox.

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
| The Cost Intelligence module | Karthik (`krachamolla@phb1899.com`) |

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

*First written 28 August 2026; last revised 14 September 2026, when the platform was
deployed and a second developer joined. Where I wasn't sure, I said so rather than
guessing — that convention runs through the whole `docs/` folder and is worth keeping.*
