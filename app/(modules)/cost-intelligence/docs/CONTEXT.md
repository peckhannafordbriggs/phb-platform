# Cost Intelligence: component map

Use this to turn what someone calls a part of the screen ("the launcher", "the
ledger", "the filter") into the component and file that renders it.

Runs, Workflows, Projects, the Skill catalog, Access and Usage & cost read and write the
database. Only the search bar's skill results still use placeholder data
(`placeholder-settings.ts`, marked `TODO(backend)`). Runs are executed by the worker
(`npm run cip:worker`, see `lib/modules/cost-intelligence/worker.ts`); with no worker
running, a new run stays **Queued**.

## Where the design came from

The design file was **CIP Directions** in Claude Design. It had four directions, and
people may refer to them by number:

| Direction | What it is | Where it went |
|---|---|---|
| **1a** | Runs dashboard: list of runs beside the selected run | `/cost-intelligence` |
| **1b** | Job page | **Dropped.** Projects are a filter on the Runs page instead |
| **1c** | New run: launching a run is a sentence; the run streams as a ledger | **Split.** The sentence is the launcher on Runs; the ledger is the Run page |
| **1d** | PCE Settings: skill catalog | `/cost-intelligence/settings` |

## How the screens fit together

```
Runs (/cost-intelligence)
  ├─ New run  → /cost-intelligence?new=1   launcher appears above the cards
  │               Start run → /cost-intelligence/runs/{id}
  ├─ click a row → RunSummary on the right
  │               Open run → /cost-intelligence/runs/{id}
  └─ Run (/cost-intelligence/runs/{id})    the monitor; Back → /cost-intelligence
```

There is **no new-run page**. The launcher's open state lives in the URL (`?new=1`), so
refresh and the browser's back button behave.

## Files

```
app/(modules)/cost-intelligence/
  cip-shell.tsx          CipShell    - chrome for every page (ground, header, tabs)
  cip-nav.tsx            CipNav      - tab bar; renders the page's `actions` on the right
  header-actions.tsx     NewRunActions, RunActions - what pages put on the right
  page.tsx               Runs page
  runs/[runId]/page.tsx  Run page (the monitor)
  settings/
    settings-nav.tsx     SettingsNav - the second tab bar inside Settings
    page.tsx             Skill catalog page
    skills/[skillId]/    Skill page
    workflows/[[...workflowId]]/  Workflows page; no id shows the first workflow
    projects/[[...projectId]]/    Projects page; no id shows the most recently changed project
    access/              Access & roles page
    usage/               Usage & cost page
  views/
    runs-view.tsx           RunsView, RunMonitor (client) - the Runs page and the Run page
    skill-catalog-view.tsx  SkillCatalogView
    side-list.tsx           SideList, SyncButton, SyncStatus (client) - the left list every Settings
                            page shares, the Sync button and the last-sync line
    workflows-view.tsx      WorkflowsView (client) - the list, New workflow, and the editor
    projects-view.tsx       ProjectsView - list, detail and live file tree
    access-view.tsx         AccessView
    usage-view.tsx          UsageView (client) - range, stats, spend per day, breakdowns, top runs
  ui/
    Button.tsx Card.tsx Dropdown.tsx FilterMenu.tsx Label.tsx
    Pill.tsx Segmented.tsx Table.tsx searchbar.tsx

lib/modules/cost-intelligence/
  constants.ts              module key and name
  types.ts                  settings: Skill, Role, RoleId, Permission
  access.ts                 CIP_ROLES, CIP_PERMISSIONS, listCipMembers (who has the module, PCE or Member)
  skill-sync.ts             syncSkills (folder -> cip_skills), listCatalogSkills, getLatestSkillSync
  workflows.ts              listWorkflows, getWorkflow, create/update/delete, setWorkflowSteps (cip_workflows)
  project-sync.ts           syncProjects (BID-DOC -> cip_projects, file info only), listProjects, readProjectFiles
  runs.ts                   createRun, cancelRun, answerCheckpoint, listRuns, getRun, listLaunchOptions (cip_runs)
  worker.ts                 workOnce: claims a queued run, runs each step with the Agent SDK on a copy of the
                            project, ask_user checkpoints, publishes ./out to AI FILES as _revN
                            (scripts/cip-worker.ts, Dockerfile.cip-worker)
  folder-store.ts           FolderStore: list / read / download, READ-ONLY. sharePointStore (Graph, CIP app:
                            secret locally, managed identity in prod) or localStore; skillsStore(),
                            projectsStore() pick SharePoint when CIP_SHAREPOINT_* is set
  usage.ts                  getUsage(range): spend from the worker's step_cost events, by day, skill,
                            project and workflow, plus the top runs
  placeholder-settings.ts   PLACEHOLDER_SKILLS (search bar only)
```

**Pages are guards only, and stay server components.** Each `page.tsx` checks access
with `requireModuleAccess`, which reads the session through `next/headers` and so only
works on the server. Never put `"use client"` on a page: put state and hooks in a view.
`views/runs-view.tsx` is a client component; the Runs page refreshes itself every few
seconds while a run is active.

## Page by page

### Runs · `/cost-intelligence` · `RunsView` (1a)

Real data from `cip_runs` (`lib/modules/cost-intelligence/runs.ts`). Any module member
can start, answer and cancel runs.

| People call it | Component | Notes |
|---|---|---|
| the launcher, the sentence, "Run X on Y" | `RunLauncher`, centred above the cards (max 48rem) | Only when the URL has `?new=1`. Lists Active workflows with no missing skills, and every project; a project with a run going says "(run going)" and is refused with the reason. Start run creates the run and goes to its page |
| the note bar, attach files | `RunNotes`, under the launcher sentence | **Mockup only:** the paperclip does nothing and the note is not sent with the run (`TODO(backend)`) |
| the project filter | `FilterMenu`, the filter icon beside the **Project** column header | "All projects", then one entry per project that has runs |
| the runs table, the runs list | a `Table` inside the left card | Columns: Project, Workflow, Status (a pill), Started. Newest first, 8 per page. Clicking a row selects it |
| the run panel, the right side | `RunSummary` | Id, status, project, workflow, started, cost, and **Open run**. Shows the latest run until you pick one |

Statuses: **Queued**, **Running**, **Waiting on you** (a checkpoint), **Completed**,
**Failed**, **Cancelled**. One active run per project; the workflow's steps are copied
onto the run when it starts, so editing a workflow never changes a run already going.

### Run · `/cost-intelligence/runs/[runId]` · `RunMonitor`

The detailed view of one run, from `getRun`; 404 for an unknown id. Refreshes itself
every few seconds while the run is Queued or Running.

| People call it | Where |
|---|---|
| the run header | top `Card`: id, status pill, **Cancel run** while active, project, workflow, started (and by whom), finished, model, and the error if it failed |
| the ledger, the run log | left `Card` **Run ledger**: one line per `cip_run_events` row, oldest first |
| the checkpoint, the question | `CheckpointForm`, under the ledger while the run is Waiting on you: the skill's question, its options as radio buttons plus **Something else** (free text), and **Answer and resume**, which puts the run back in the queue |
| the skills rail | right `Card` **Skills · run in order**: the copied steps, done / current / pending, with versions; then Tokens, Cost and the cap |
| the outputs | right `Card` **Outputs · AI FILES**: files the run wrote |

All Settings pages are for module admins only, and follow the mockups in the
**CIP Directions** design file.

### Skill catalog · `/cost-intelligence/settings` and `settings/skills/[skillId]` · `SkillCatalogView` (1d)

Real data from `cip_skills`, filled by a sync of the skills folder: SharePoint
(`CIP_SHAREPOINT_SKILLS_FOLDER`) or, locally, `CIP_SKILLS_DIR`.
The skills list on the left, the selected skill on the right. Picking a skill goes to
its URL (`/settings/skills/{folder name}`); `/settings` opens on the first skill.
Unknown folder names 404. No skills yet shows an empty state that points at Sync.

| People call it | Where |
|---|---|
| the Sync button | `SyncButton`, top right of the left `Card`. POSTs to `/api/modules/cost-intelligence/sync/skills` (one route serves `sync/skills` and `sync/projects`), then refreshes the page. Only a 409 or network error shows a message, floated under the button so the header never reflows |
| last synced | `SyncStatus` under the header: "Last synced …" (New York time) with the added / updated / removed counts, "Sync failed" with the reason, or "N could not be read" for a partial sync |
| the skills list | `SideList`, left `Card`: one compact row per skill, name and version. The selected row is tinted in the module colour. Rows link with `scroll={false}` and the selected row scrolls back into view after the page re-renders |
| the skill detail | right `Card`: name, folder name, version, last updated, last synced, description |

Last-updated dates come from CHANGELOG headings and are stored as midnight UTC, so they
are formatted in UTC. Formatting them in New York time shows the day before.

### Workflows · `settings/workflows` · `WorkflowsView`

Real data from `cip_workflows`. Every change saves at once and the page re-renders
from the database, so there is no unsaved state. Writes go through the routes under
`/api/modules/cost-intelligence/workflows`; rules live in `lib/modules/cost-intelligence/workflows.ts`.

| People call it | Where |
|---|---|
| the workflows list | `WorkflowList`, left `Card`: **New workflow** (opens a name field, creates a Draft and opens it), then one compact row per workflow, name and status. Each workflow is its own URL, like skills |
| the workflow header | right `Card`: name, status, description, last updated, pencil to edit name and description. **Activate** (Draft), **Pause** (Active), **Resume** (Paused); Activate is disabled with a reason when there are no steps or a skill is missing. **Delete** shows on Drafts only and asks once |
| the steps | **Steps · run in order**: numbered rows with name, folder, version, and up / down / remove. A skill no longer in the catalog shows **Missing from catalog**. **Add a skill** lists catalog skills not already in the workflow |

Status only moves Draft → Active ⇄ Paused. The last step of an Active or Paused
workflow cannot be removed.

### Projects · `settings/projects` and `settings/projects/[projectId]` · `ProjectsView`

Real data. Each direct subfolder of BID-DOC is a project: SharePoint
(`CIP_SHAREPOINT_PROJECTS_FOLDER`) or, locally, `CIP_PROJECTS_DIR`. The file tree is
read from the same place when a project opens. Sync reads file names, sizes and dates only, never contents. Data:
`lib/modules/cost-intelligence/project-sync.ts`.

| People call it | Where |
|---|---|
| the projects list | `SideList` with a filter, left `Card`: **Sync** and the last-sync line, a filter box, then one compact row per project with the date it last changed. Newest change first. Each project is its own URL |
| the project detail | right `Card`: name, path, files and size, last changed, AI FILES (count, or "Not created yet"), last synced, and the categories as pills |
| the file tree | **Files · read live from the folder**: native `<details>` folders, folders first, sizes on files. Read from disk on every page load, capped at 5,000 entries. Shows a plain message when the folder can't be read (in Azure until Graph lands) |

Categories are the project's top-level folders, plus **General** when files sit
directly in it. A folder that disappears is marked removed (`removed_at`) and hidden,
never deleted, because runs will point at projects; if it comes back it is restored.

### Access & roles · `settings/access` · `AccessView`

Real data, read-only. A Cost Intelligence grant makes someone a **Member**; the grant's
"Can change settings" flag makes them a **PCE**. Both are set by a platform admin in
`/admin`, so this page has no write path. Data: `listCipMembers()` in
`lib/modules/cost-intelligence/access.ts`.

| People call it | Where |
|---|---|
| the people table | left `Card`: **Manage in Admin** (links to `/admin`), then Name (initials, name, email), Role (PCE / Member pill) and Last active. Disabled employees are left out |
| the role matrix | right `Card`, **What each role can do**: `CIP_PERMISSIONS` from `access.ts`, a permission per row, PCE and Member columns with head counts. Fixed in code, read-only |

### Usage & cost · `settings/usage` · `UsageView`

PCE only. Real data from `getUsage` (`lib/modules/cost-intelligence/usage.ts`), which
sums the worker's `step_cost` events. A step counts on the day it last spent (New York
time). There is no budget here: the hard limit is the Anthropic Console spend limit.

| People call it | Where |
|---|---|
| the date range | dark `Segmented` 7 days / 30 days / 90 days; sets `?range=` and the page reloads the data |
| the stats | Spend, Runs, Average per run, Tokens (all for the range) and **<Month> so far** (the calendar month, whatever the range) |
| the spend chart | **Spend per day**, one bar per day of the range, hover for the amount |
| the breakdown | light `Segmented` By skill / By project / By workflow over one table: runs, tokens, spend, per run, with a spend bar |
| the top runs | **Most expensive runs**, a `Table` of the 10 costliest runs in the range; a row opens the run |

## The chrome

| People call it | Component | File |
|---|---|---|
| the header, "Cost Intelligence" title | `ModuleHeader` (platform component) | `components/module-header.tsx` |
| the tabs, Runs / Settings | `CipNav` | `cip-nav.tsx` |
| the search bar, the New run / Back button (top right) | Whatever the **page** passes as `actions` to `CipShell`, which hands it to `CipNav`. Two ready-made sets: `NewRunActions` (search, and **New run**, which opens the launcher or closes it when `launcherOpen`) on Runs and every Settings page. Both take `canAdminister`, which decides whether search lists skills; `RunActions` (search, and **Back** to Runs) on a run page | `header-actions.tsx` |
| the settings tabs | `SettingsNav`, which reuses `CipNav` with no `actions`, so nothing shows on its right | `settings/settings-nav.tsx` |
| the tinted background | `.dashboard-ground`, applied by `CipShell` | `cip-shell.tsx` |

**Height.** `CipShell` is exactly one screen tall: the header stays put and only the area
below it scrolls. The platform sidebar is pinned at full height too. The Skill catalog,
Workflows and Access views fill the leftover height (`flex-[1_1_0px]`, never below
`min-h-[22rem]`) and their cards scroll inside instead of growing. Below the `lg` / `xl`
breakpoint the cards stack and the page scrolls instead.

The **Settings** tab only appears for Cost Intelligence **module admins** (the
"Can change settings" flag on the grant), not for every platform admin. Every settings
page checks this itself with `requireModuleAdmin`.

## Building blocks

| Component | File | What it is |
|---|---|---|
| `Button` | `ui/Button.tsx` | A button with no behaviour of its own. `variant`: `primary` (PHB red, `--phb-red-btn`) or `secondary` (white). Pass `onClick` for an action or `href` for navigation; also `disabled`, `fullWidth`, `type`. Icons go in `children` |
| `Card` | `ui/Card.tsx` | The platform's `.card` surface. Change the padding with the `padding` prop (default `p-5`), never with a `p-*` in `className`: that one loses to the default |
| `Pill` | `ui/Pill.tsx` | A small status label. `tone`: `ok` (teal), `draft` (purple), `muted` (grey), `warn` (orange). A tone is a state, never decoration |
| `Segmented` | `ui/Segmented.tsx` | Mutually exclusive buttons in one strip. `options`, `value`, `onChange`, `label`; `tone` `dark` (date range) or `light` |
| `Dropdown` | `ui/Dropdown.tsx` | A custom select with a rounded list. `options`, `placeholder`, `label` (accessible name); pass `value` + `onChange` to control it. Closes on blur |
| `FilterMenu` | `ui/FilterMenu.tsx` | A filter icon that opens a small option list; for a table header. `label`, `options`, `value`, `onChange`. Closes on blur |
| `Label` | `ui/Label.tsx` | Small uppercase section label (`.eyebrow`) |
| `Table` | `ui/Table.tsx` | Equal-width columns. `headers` (text or any node, e.g. a heading with a `FilterMenu`), `rows` (cells are any React node), optional `pageSize` for Previous / Next paging, optional `onRowClick` + `selected` (indexes into the whole `rows` array, not the page) |
| `SearchBar` | `ui/searchbar.tsx` | Live search; for now only (admins only) placeholder skills, run results come back with real search. `/` anywhere focuses it; arrows and Enter open a result, Escape closes. Marked `TODO(backend)` |

Icons come from **`lucide-react`**; do not hand-draw SVGs.

## What is wired

- Selecting a run, the project filter, and Previous / Next on the runs table.
- New run opening and closing the launcher; Back from a run page.
- Start run, which creates a real queued run and goes to its page.
- Open run, the Run page, Cancel run, and Answer and resume.
- Runs execute when the worker is running: the ledger, steps, cost and outputs fill in
  live, and a skill's question appears under the ledger.
- Search.
- Sync on the Skill catalog, which writes `cip_skills` and survives reload.
- Sync on Projects, which writes `cip_projects`; picking a project is a link and the
  file tree is read live.
- Workflows: create, rename, steps, Activate / Pause / Resume and Delete draft all
  write `cip_workflows` and survive reload. Picking a workflow or a skill is a link.
- Usage & cost: the range is in the URL; the breakdown choice is local to the page.
- Access & roles reads real grants. It has no controls; access changes happen in Admin.

Every other button renders its label and has no handler. Wire each one in its own view
as the backend for it lands, never inside `Button`.

## Words that mean something specific here

| Word | Meaning |
|---|---|
| **Run** | One execution of a workflow against one project |
| **Project** | A bid or job folder in SharePoint, e.g. `24-118 Riverside Medical Tower`. SharePoint and the team call these job folders; the platform calls them projects |
| **Workflow** | A chain of skills, e.g. Bid kickoff then Estimate population |
| **Skill** | A versioned `SKILL.md` package from the `PHB-CIS-skills` repo, e.g. `phb-estimate-population @ v2.3.1` |
| **Checkpoint** | Where a run pauses for a person: a decision, or an Excel save |
| **Ledger** | The timestamped record of what a run did |
| **Project memory** | Decisions from earlier runs, carried into every new run on that project |
| **AI FILES** | The one folder in a project where runs are allowed to write |
| **PCE** | Principal Cost Engineer: owns the skill catalog and publishing |

## Rules when changing these screens

- Put UI in `views/` or `ui/`, never in `page.tsx`. Pages stay server components.
- Do not move the chrome into a `layout.tsx`. A layout wraps a 404 page too, which
  would reveal the module to someone without access.
- A run's page gets its data from the run id, never from the launcher. Start run
  creates the run and navigates to its id; the page looks it up.
- Placeholder data lives only in `placeholder-settings.ts`. Placeholder people use `@sample.invalid` addresses, like the
  dev seed, so none can be mistaken for a real employee.
- Colours come from the platform tokens in `app/globals.css`. The module's colour is
  `var(--module-accent)` (teal); teal, orange and maroon also mean ok, warning and error,
  so never use them for decoration. Primary buttons are PHB red (`--phb-red-btn`).
- Keep `ui/` components free of behaviour: handlers and data live in the view.
- **If you add, rename or move a component, update this file in the same change.**
