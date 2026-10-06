# Cost Intelligence: component map

Use this to turn what someone calls a part of the screen ("the launcher", "the
ledger", "the filter") into the component and file that renders it.

The screens are **real UI over placeholder data**, apart from the checkpoint, which is
still grey placeholder bars, and the **Skill catalog**, which reads `cip_skills` (see
`lib/modules/cost-intelligence/skill-sync.ts`). Every other data source is in
`lib/modules/cost-intelligence/placeholder.ts` (runs) or `placeholder-settings.ts`
(Settings), marked `TODO(backend)`. The plan for making them real is `PLAN.md` beside
this file.

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
  ├─ click a row → RunDetail on the right
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
    workflows/           Workflows page
    access/              Access & roles page
    usage/               Usage & cost page
  views/
    runs-view.tsx           RunsView
    skill-catalog-view.tsx  SkillCatalogView
    skill-sync-button.tsx   SkillSyncButton (client) - the Sync button
    skill-list.tsx          SkillList (client) - the skills list; keeps the selected row in view
    workflows-view.tsx      WorkflowsView
    access-view.tsx         AccessView
    usage-view.tsx          UsageView
    parts.tsx               RunHistory, RunDetail, RunLauncher, RunMonitor, Timeline, Checkpoint, Node
  ui/
    Bar.tsx Button.tsx Card.tsx Dropdown.tsx FilterMenu.tsx Label.tsx
    Pill.tsx Segmented.tsx Table.tsx searchbar.tsx

lib/modules/cost-intelligence/
  constants.ts              module key and name
  types.ts                  runs: Run, RunActivity, LedgerEntry, RunStep, PinnedSkill, Option
                            settings: Skill, Workflow, Role, Permission, Person, Usage, Budget
  skill-sync.ts             syncSkills (folder -> cip_skills), listCatalogSkills, getLatestSkillSync
  placeholder.ts            PLACEHOLDER_RUNS / _WORKFLOWS / _PROJECTS, getPlaceholderRun, getPlaceholderActivity
  placeholder-settings.ts   PLACEHOLDER_SKILLS, _SETTINGS_WORKFLOWS, CIP_ROLES, CIP_PERMISSIONS, _PEOPLE, _USAGE, _BUDGET,
                            getPlaceholderSkill
```

**Pages are guards only, and stay server components.** Each `page.tsx` checks access
with `requireModuleAccess`, which reads the session through `next/headers` and so only
works on the server. Never put `"use client"` on a page: put state and hooks in a view.
`views/parts.tsx` and `views/runs-view.tsx` are client components.

## Page by page

### Runs · `/cost-intelligence` · `RunsView` (1a)

`RunsView` holds the selected run and the project filter, and reads `?new=1`.

| People call it | Component | Notes |
|---|---|---|
| the launcher, the sentence, "Run X on Y" | `RunLauncher`, centred above the cards (max 48rem) | Only when the URL has `?new=1`. Workflow and project dropdowns; Start run is disabled until both are chosen, then goes to the run's page |
| the project filter | `FilterMenu`, the filter icon beside the **Project** column header in `RunHistory` | "All projects", then one entry per project that has runs. The icon darkens while a filter is on |
| the runs table, the runs list | `RunHistory`, a `Table` inside the left card | Columns: Project, Workflow, Status, Started. 8 per page. Clicking a row selects it |
| the run panel, the right side | `RunDetail` | Id, status, project, workflow, started, and **Open run**. Shows the latest run until you pick one, or when the filter hides your pick; empty only when there are no runs |

### Run · `/cost-intelligence/runs/[runId]` · `RunMonitor`

The detailed view of one run. The page reads `runId` from `params`, looks up the run
and its `RunActivity` (`getPlaceholderRun` / `getPlaceholderActivity` for now), and
returns a 404 for an id that does not exist. A run with no activity renders empty
states rather than failing.

| People call it | Where |
|---|---|
| the run header | full-width top `Card` in `RunMonitor`: id, status, project, workflow, started |
| the ledger, the run log | left `Card` labelled **Run ledger**: one line per `LedgerEntry` (time, title, detail). A `Checkpoint` follows only when the run's status is "Waiting on you" |
| the status rail | right `Card` labelled **Status**: `Timeline` over the seven `RunStep`s. Done steps dark, the current one in the module colour, pending ones muted |
| pinned, versions, tokens, cost | right `Card` labelled **Pinned for this run**: each `PinnedSkill` (name, version), then Tokens and Estimated cost |

All Settings pages are for module admins only, and follow the mockups in the
**CIP Directions** design file.

### Skill catalog · `/cost-intelligence/settings` and `settings/skills/[skillId]` · `SkillCatalogView` (1d)

Real data from `cip_skills`, filled by a sync of the skills folder (`CIP_SKILLS_DIR`).
The skills list on the left, the selected skill on the right. Picking a skill goes to
its URL (`/settings/skills/{folder name}`); `/settings` opens on the first skill.
Unknown folder names 404. No skills yet shows an empty state that points at Sync.

| People call it | Where |
|---|---|
| the Sync button | `SkillSyncButton`, top right of the left `Card`. POSTs to `/api/modules/cost-intelligence/skills/sync`, then refreshes the page. Only a 409 or network error shows a message, floated under the button so the header never reflows |
| last synced | `SyncStatus` under the header: "Last synced …" (New York time) with the added / updated / removed counts, "Sync failed" with the reason, or "N could not be read" for a partial sync |
| the skills list | `SkillList`, left `Card`: one compact row per skill, name and version. The selected row is tinted in the module colour. Rows link with `scroll={false}` and the selected row scrolls back into view after the page re-renders |
| the skill detail | right `Card`: name, folder name, version, last updated, last synced, description |

Last-updated dates come from CHANGELOG headings and are stored as midnight UTC, so they
are formatted in UTC. Formatting them in New York time shows the day before.

### Workflows · `settings/workflows` · `WorkflowsView`

| People call it | Where |
|---|---|
| the workflows list | left `Card`: **New workflow**, then one compact row per workflow, name and status. The selected row is tinted in the module colour, like the skills list. Clicking one selects it |
| the workflow header | right `Card`: name, status, description, runs in 30 days, **Pause / Resume / Activate workflow** |
| the steps | **Steps · run in order**: numbered rows, each with a light `Segmented` **Follow live · vX** / **Pin vX** |

### Access & roles · `settings/access` · `AccessView`

| People call it | Where |
|---|---|
| the people table | left `Card`: **Add person**, then Name (initials, name, email), Role (`Dropdown`) and Last active. The last PCE can only be PCE |
| the role matrix | right `Card`, **What each role can do**: a permission per row, a role per column with its head count. PCE is fixed (grey ticks); the rest toggle |

### Usage & cost · `settings/usage` · `UsageView`

A dark `Segmented` 7 days / 30 days / Quarter, four stats (Runs, Tokens, Spend, Average
per run, totalled from the per-skill rows), **Spend per day** bars (hover for the
amount), the month's budget with a tick at the alert level and **Change budget**, and
**By skill** with a spend bar, runs, tokens, spend and per run.

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
| `Bar` | `ui/Bar.tsx` | A grey rounded placeholder bar. Width and height as props |
| `Button` | `ui/Button.tsx` | A button with no behaviour of its own. `variant`: `primary` (PHB red, `--phb-red-btn`) or `secondary` (white). Pass `onClick` for an action or `href` for navigation; also `disabled`, `fullWidth`, `type`. Icons go in `children` |
| `Card` | `ui/Card.tsx` | The platform's `.card` surface. Change the padding with the `padding` prop (default `p-5`), never with a `p-*` in `className`: that one loses to the default |
| `Pill` | `ui/Pill.tsx` | A small status label. `tone`: `ok` (teal), `draft` (purple), `muted` (grey), `warn` (orange). A tone is a state, never decoration |
| `Segmented` | `ui/Segmented.tsx` | Mutually exclusive buttons in one strip. `options`, `value`, `onChange`, `label`; `tone` `dark` (date range) or `light` (Follow live / Pin) |
| `Dropdown` | `ui/Dropdown.tsx` | A custom select with a rounded list. `options`, `placeholder`, `label` (accessible name); pass `value` + `onChange` to control it. Closes on blur |
| `FilterMenu` | `ui/FilterMenu.tsx` | A filter icon that opens a small option list; for a table header. `label`, `options`, `value`, `onChange`. Closes on blur |
| `Label` | `ui/Label.tsx` | Small uppercase section label (`.eyebrow`) |
| `Table` | `ui/Table.tsx` | Equal-width columns. `headers` (text or any node, e.g. a heading with a `FilterMenu`), `rows` (cells are any React node), optional `pageSize` for Previous / Next paging, optional `onRowClick` + `selected` (indexes into the whole `rows` array, not the page) |
| `SearchBar` | `ui/searchbar.tsx` | Live search over runs and (admins only) skills. `/` anywhere focuses it; arrows and Enter open a result, Escape closes. `search` reads placeholder data, marked `TODO(backend)` |
| `Node` | `views/parts.tsx` | The diamond on timelines and the version track. Hollow by default; `filled` for a solid one |
| `Timeline` | `views/parts.tsx` | The seven-step run timeline, from `steps` |
| `Checkpoint` | `views/parts.tsx` | A paused-run question with options and Answer and resume (placeholder bars, button not wired) |
| `RunHistory` | `views/parts.tsx` | The project filter and the runs table |
| `RunDetail` | `views/parts.tsx` | The quick-look panel for one `Run`, with Open run |
| `RunLauncher` | `views/parts.tsx` | "Run [workflow] on [project]" and Start run |
| `RunMonitor` | `views/parts.tsx` | The whole Run page for one `Run` and its optional `RunActivity`: header, ledger, Status, Pinned |

Icons come from **`lucide-react`**; do not hand-draw SVGs.

## What is wired

- Selecting a run, the project filter, and Previous / Next on the runs table.
- New run opening and closing the launcher; Back from a run page.
- The launcher's dropdowns, and Start run going to a run page. It goes to the first
  placeholder run until the backend returns a real id.
- Open run, and the Run page loading that run (404 for an unknown id).
- Search.
- Sync on the Skill catalog, which writes `cip_skills` and survives reload.
- Settings, all local to the page and lost on reload: picking a workflow, Pause /
  Resume / Activate, Follow live / Pin, changing a person's role, the role matrix
  checkboxes, and the usage range. Picking a skill is a link, so it survives reload.

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
- Placeholder data lives only in `lib/modules/cost-intelligence/placeholder.ts` and
  `placeholder-settings.ts`. Placeholder people use `@sample.invalid` addresses, like the
  dev seed, so none can be mistaken for a real employee.
- Colours come from the platform tokens in `app/globals.css`. The module's colour is
  `var(--module-accent)` (teal); teal, orange and maroon also mean ok, warning and error,
  so never use them for decoration. Primary buttons are PHB red (`--phb-red-btn`).
- Keep `ui/` components free of behaviour: handlers and data live in the view.
- When a skeleton becomes real, keep the component names above and replace the `Bar`
  placeholders inside them, so this file stays true.
- **If you add, rename or move a component, update this file in the same change.**
