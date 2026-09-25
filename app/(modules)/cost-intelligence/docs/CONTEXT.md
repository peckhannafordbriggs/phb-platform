# Cost Intelligence: component map

Use this to turn what someone calls a part of the screen ("the decision card", "the
ledger", "the filter") into the component and file that renders it.

The screens are **part skeleton, part real UI**. The chrome, the runs list and detail,
the dropdowns and the buttons are real components over placeholder data; the ledger,
the timeline, the checkpoint and most of Settings are still grey placeholder bars. No
backend yet: every data source is a `PLACEHOLDER_*` constant marked `TODO(backend)`.
The plan for making them real is `PLAN.md` beside this file.

## Where the design came from

The design file was **CIP Directions** in Claude Design. It had four directions, and
people may refer to them by number:

| Direction | What it is | Route here |
|---|---|---|
| **1a** | Runs dashboard: list of runs beside the selected run | `/cost-intelligence` |
| **1b** | Job page | **Dropped.** Projects are a filter on the Runs page instead |
| **1c** | New run: launching a run is a sentence; the run streams as a ledger | `/cost-intelligence/runs/new` |
| **1d** | PCE Settings: skill catalog | `/cost-intelligence/settings` |

## Files

```
app/(modules)/cost-intelligence/
  cip-shell.tsx          CipShell    - chrome for every page (ground, header, tabs)
  cip-nav.tsx            CipNav      - underlined tab bar (+ search bar and New run / Back, right)
  page.tsx               Runs page
  runs/new/page.tsx      New run page
  runs/[runId]/page.tsx  Run page
  settings/
    settings-nav.tsx     SettingsNav - the second tab bar inside Settings
    page.tsx             Skill catalog page
    skills/[skillId]/    Skill page
    workflows/           Workflows page
    access/              Access & roles page
    usage/               Usage & cost page
  views/
    runs-view.tsx        RunsView, RunView
    new-run-view.tsx     NewRunView
    settings-views.tsx   SkillCatalogView, SkillView, SettingsTableView
    parts.tsx            Run (type), RunHistory, RunDetail, Timeline, Checkpoint, Node
  ui/
    Bar.tsx Button.tsx Card.tsx Dropdown.tsx Label.tsx Table.tsx searchbar.tsx
```

**Pages are guards only.** Each `page.tsx` checks access and renders one view. The
layout lives in `views/`, the reusable pieces in `views/parts.tsx`, and the smallest
building blocks in `ui/`.

## Page by page

### Runs · `/cost-intelligence` · `RunsView` (1a)

Two columns. `RunsView` is a client component: it holds the selected run and the
project filter.

| People call it | Component | Notes |
|---|---|---|
| the project filter | `Dropdown` at the top of `RunHistory` | "All projects", then one entry per project that has runs |
| the runs table, the runs list | `RunHistory`, a `Table` inside the left card | Columns: Project, Workflow, Status, Started. 8 per page. Clicking a row selects it |
| the run panel, the right side | `RunDetail` | Same component as the Run page. "Select a run" when nothing is selected |

### Run · `/cost-intelligence/runs/[runId]` · `RunView`

Just `RunDetail`, full width. Not loaded from `runId` yet, so it shows the empty state.

`RunDetail` today shows the run id, status, project, workflow and start time. The design
also puts the `Timeline`, a `Checkpoint` and a footer ("keeps running if you close this
tab", Cancel run) in it; they come back when a run carries that data.

### New run · `/cost-intelligence/runs/new` · `NewRunView` (1c)

Two columns: the launcher and ledger on the left, Status and Pinned on the right. The
top-right button reads **Back** on this page instead of **New run**.

| People call it | Where |
|---|---|
| the launcher, the sentence, "Run X on Y" | top-left `Card`: workflow `Dropdown`, project `Dropdown`, Start run button |
| the ledger, the run log | left `Card` labelled **Run ledger**: timestamped entries, then a `Checkpoint` with options in three columns |
| the status rail | right `Card` labelled **Status**, containing `Timeline` |
| pinned, versions, tokens, cost | right `Card` labelled **Pinned for this run**: skill versions, then Tokens and Estimated cost |

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
| the New run / Back button (top right) | `Button`, rendered inside `CipNav`: **Back** on `/runs/new`, **New run** everywhere else | `ui/Button.tsx` |
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
| `Label` | `ui/Label.tsx` | Small uppercase section label (`.eyebrow`) |
| `Table` | `ui/Table.tsx` | Equal-width columns. `headers`, `rows` (cells are any React node), optional `pageSize` for Previous / Next paging, optional `onRowClick` + `selected` (indexes into the whole `rows` array, not the page) |
| `SearchBar` | `ui/searchbar.tsx` | Search input with clear button. `searchCostIntelligence` is a stub marked `TODO(backend)` |
| `Node` | `views/parts.tsx` | The hollow diamond on timelines and pipelines |
| `Timeline` | `views/parts.tsx` | The seven-step run timeline (placeholder bars) |
| `Checkpoint` | `views/parts.tsx` | A paused-run question with options and Answer and resume (placeholder bars, button not wired) |
| `RunDetail` | `views/parts.tsx` | The run panel for one `Run` |
| `RunHistory` | `views/parts.tsx` | The project filter and the runs table |

Icons come from **`lucide-react`**; do not hand-draw SVGs.

## What is wired

Only these do anything: selecting a run on Runs, the project filter, Previous / Next on
the runs table, the New run and Back buttons, and the two New run dropdowns. Every other
button renders its label and has no handler; wire each one in its own view as the
backend for it lands, never inside `Button`.

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

- Put UI in `views/` or `ui/`, never in `page.tsx`.
- Do not move the chrome into a `layout.tsx`. A layout wraps a 404 page too, which
  would reveal the module to someone without access.
- Colours come from the platform tokens in `app/globals.css`. The module's colour is
  `var(--module-accent)` (teal); teal, orange and maroon also mean ok, warning and error,
  so never use them for decoration. Primary buttons are PHB red (`--phb-red-btn`).
- Keep `ui/` components free of behaviour: handlers and data live in the view.
- When a skeleton becomes real, keep the component names above and replace the `Bar`
  placeholders inside them, so this file stays true.
- **If you add, rename or move a component, update this file in the same change.**
