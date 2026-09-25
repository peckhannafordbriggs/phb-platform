# Cost Intelligence: component map

Use this to turn what someone calls a part of the screen ("the launcher", "the
ledger", "the filter") into the component and file that renders it.

The screens are **part skeleton, part real UI**. The chrome, the runs list and detail,
the launcher, the Run page's ledger, status and pinned cards, the dropdowns and the
buttons are real components over placeholder data; the checkpoint and most of Settings
are still grey placeholder bars. No backend yet: every data source is in
`lib/modules/cost-intelligence/placeholder.ts`, marked `TODO(backend)`. The plan for
making them real is `PLAN.md` beside this file.

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
  cip-nav.tsx            CipNav      - tab bar (+ search bar and New run / Back, right)
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
    runs-view.tsx        RunsView
    settings-views.tsx   SkillCatalogView, SkillView, SettingsTableView
    parts.tsx            RunHistory, RunDetail, RunLauncher, RunMonitor, Timeline, Checkpoint, Node
  ui/
    Bar.tsx Button.tsx Card.tsx Dropdown.tsx FilterMenu.tsx Label.tsx Table.tsx searchbar.tsx

lib/modules/cost-intelligence/
  constants.ts           module key and name
  types.ts               Run, RunActivity, LedgerEntry, RunStep, PinnedSkill, Option
  placeholder.ts         PLACEHOLDER_RUNS / _WORKFLOWS / _PROJECTS, getPlaceholderRun, getPlaceholderActivity
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

### Settings · `/cost-intelligence/settings` · `SkillCatalogView` (1d)

Module admins only. Three columns under `SettingsHeading`.

| People call it | Where |
|---|---|
| the settings header | `SettingsHeading`: title, repo and branch, "checked against Git" |
| the skills list | left `Card`: one row per skill, name and status |
| the skill detail | `SkillDetail` (middle): title and status, version track, "changes on main" list with a Review button, SKILL.md block |
| the version track | row of four `Node`s at the top of `SkillDetail` |
| test, publish, the right rail | `PublishRail`: **Test against a fixture** checklist and Run test, then **Publish** |

`SettingsHeading`, `SkillDetail` and `PublishRail` are local to `settings-views.tsx`,
not exported.

### Other settings pages

| Page | Component | Table columns |
|---|---|---|
| Skill · `settings/skills/[skillId]` | `SkillView`: `SkillDetail` and `PublishRail`, no skills list | |
| Workflows · `settings/workflows` | `SettingsTableView` | Workflow, Skills, Runs, Updated |
| Access & roles · `settings/access` | `SettingsTableView` | Employee, Role, Granted, Last active |
| Usage & cost · `settings/usage` | `SettingsTableView` with four stat tiles on top | Project, Workflow, Runs, Tokens, Cost |

The settings column names are placeholders, not decided.

## The chrome

| People call it | Component | File |
|---|---|---|
| the header, "Cost Intelligence" title | `ModuleHeader` (platform component) | `components/module-header.tsx` |
| the tabs, Runs / Settings | `CipNav` | `cip-nav.tsx` |
| the search bar | `SearchBar`, rendered inside `CipNav` | `ui/searchbar.tsx` |
| the New run / Back button (top right) | `Button` inside `CipNav`. On a run page (`/runs/…`): **Back** to Runs. Elsewhere: **New run**, which opens the launcher, or closes it when it is already open | `ui/Button.tsx` |
| the settings tabs | `SettingsNav`, which reuses `CipNav` | `settings/settings-nav.tsx` |
| the tinted background | `.dashboard-ground`, applied by `CipShell` | `cip-shell.tsx` |

The **Settings** tab only appears for Cost Intelligence **module admins** (the
"Can change settings" flag on the grant), not for every platform admin. Every settings
page checks this itself with `requireModuleAdmin`.

## Building blocks

| Component | File | What it is |
|---|---|---|
| `Bar` | `ui/Bar.tsx` | A grey rounded placeholder bar. Width and height as props |
| `Button` | `ui/Button.tsx` | A button with no behaviour of its own. `variant`: `primary` (PHB red, `--phb-red-btn`) or `secondary` (white). Pass `onClick` for an action or `href` for navigation; also `disabled`, `fullWidth`, `type`. Icons go in `children` |
| `Card` | `ui/Card.tsx` | The platform's `.card` surface with padding |
| `Dropdown` | `ui/Dropdown.tsx` | A custom select with a rounded list. `options`, `placeholder`, `label` (accessible name); pass `value` + `onChange` to control it. Closes on blur |
| `FilterMenu` | `ui/FilterMenu.tsx` | A filter icon that opens a small option list; for a table header. `label`, `options`, `value`, `onChange`. Closes on blur |
| `Label` | `ui/Label.tsx` | Small uppercase section label (`.eyebrow`) |
| `Table` | `ui/Table.tsx` | Equal-width columns. `headers` (text or any node, e.g. a heading with a `FilterMenu`), `rows` (cells are any React node), optional `pageSize` for Previous / Next paging, optional `onRowClick` + `selected` (indexes into the whole `rows` array, not the page) |
| `SearchBar` | `ui/searchbar.tsx` | Search input with clear button. `searchCostIntelligence` is a stub marked `TODO(backend)` |
| `Node` | `views/parts.tsx` | The hollow diamond on timelines and pipelines |
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
- Placeholder data lives only in `lib/modules/cost-intelligence/placeholder.ts`.
- Colours come from the platform tokens in `app/globals.css`. The module's colour is
  `var(--module-accent)` (teal); teal, orange and maroon also mean ok, warning and error,
  so never use them for decoration. Primary buttons are PHB red (`--phb-red-btn`).
- Keep `ui/` components free of behaviour: handlers and data live in the view.
- When a skeleton becomes real, keep the component names above and replace the `Bar`
  placeholders inside them, so this file stays true.
- **If you add, rename or move a component, update this file in the same change.**
