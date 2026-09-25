# Cost Intelligence: component map

Use this to turn what someone calls a part of the screen ("the decision card", "the
ledger", "the pipeline") into the component and file that renders it.

The screens are **skeletons**: the real layout from the Claude Design concepts, drawn
in grey placeholder bars. No data, no backend yet. The plan for making them real is
`PLAN.md` at the repository root.

## Where the design came from

The design file was **CIP Directions** in Claude Design. It had four directions, and
people may refer to them by number:

| Direction | What it is | Route here |
|---|---|---|
| **1a** | Runs dashboard: list of runs beside the selected run | `/cost-intelligence` |
| **1b** | Job page: the job is the page | `/cost-intelligence/jobs/[jobId]` |
| **1c** | New run: launching a run is a sentence; the run streams as a ledger | `/cost-intelligence/runs/new` |
| **1d** | PCE Settings: skill catalog | `/cost-intelligence/settings` |

## Files

```
app/(modules)/cost-intelligence/
  cip-shell.tsx          CipShell    - chrome for every page (ground, header, tabs)
  cip-nav.tsx            CipNav      - underlined tab bar (+ search bar and button, right)
  page.tsx               Runs page
  runs/new/page.tsx      New run page
  runs/[runId]/page.tsx  Run page
  jobs/page.tsx          Jobs page
  jobs/[jobId]/page.tsx  Job page
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
    job-view.tsx         JobView, JobsView
    settings-views.tsx   SkillCatalogView, SkillView, SettingsTableView
    parts.tsx            RunDetail, Timeline, Checkpoint, FileRow, Node
  ui/
    Bar.tsx Button.tsx Card.tsx Label.tsx Table.tsx searchbar.tsx
```

**Pages are guards only.** Each `page.tsx` checks access and renders one view. The
layout lives in `views/`, the reusable pieces in `views/parts.tsx`, and the smallest
building blocks in `ui/`.

## Page by page

### Runs · `/cost-intelligence` · `RunsView` (1a)

Two columns.

| People call it | Component | Notes |
|---|---|---|
| the filters, the filter pills | placeholder `div` at the top of the left card in `RunsView` | All · Needs you · In progress · Completed · Failed or cancelled |
| the runs table, the runs list | `Table` inside the left card | 8 rows, 4 columns: Job, Workflow, Status, Started |
| the run panel, the right side | `RunDetail` | Same component as the Run page |

### Run · `/cost-intelligence/runs/[runId]` · `RunView`

Just `RunDetail`, full width. Inside `RunDetail`, top to bottom:

| People call it | Where |
|---|---|
| the run header | first block of `RunDetail`: job number and run number, status pill, job name, pinned skill chips, "started by" |
| the timeline, the steps | `Timeline`: seven steps, Queued, Preparing files, Running, Awaiting decision, Awaiting Excel save, Writing outputs, Completed |
| the decision card, the question, the checkpoint | `Checkpoint`: question, context, options, answer button |
| the footer, cancel run | last row of `RunDetail`: "keeps running if you close this tab" and Cancel run |

### New run · `/cost-intelligence/runs/new` · `NewRunView` (1c)

| People call it | Where |
|---|---|
| the launcher, the sentence, "Run X on Y" | top `Card`: workflow picker, job picker, Start run button |
| the workflow chips | row of pills under the launcher |
| the ledger, the run log | left `Card` labelled **Run ledger**: timestamped entries, then a `Checkpoint` with options in three columns |
| the status rail | right `Card` labelled **Status**, containing `Timeline` |
| pinned, versions, tokens, cost | right `Card` labelled **Pinned for this run**: skill versions and MD5s, then Tokens and Estimated cost |

### Jobs · `/cost-intelligence/jobs` · `JobsView`

A search box, then a grid of job cards (job number, name, SharePoint path, status).

### Job · `/cost-intelligence/jobs/[jobId]` · `JobView` (1b)

| People call it | Where |
|---|---|
| the job header | top `Card`: job number and name, SharePoint path, Switch job and New run buttons |
| the pipeline, the skill track | lower half of the same top card, labelled **Skill pipeline**: four stages, each a `Node` with skill name, `skill @ version`, status |
| the stage card | left `Card` labelled **Stage**: current stage, status pill, progress bar |
| job memory, the facts | middle `Card` labelled **Job memory**: six fact tiles |
| the files | middle `Card` labelled **Files**: `FileRow` list (AI FILES and SharePoint) |
| waiting on you, the deck | right `Card` labelled **Waiting on you**: a `Checkpoint` |

### Settings · `/cost-intelligence/settings` · `SkillCatalogView` (1d)

Module admins only. Three columns under `SettingsHeading`.

| People call it | Where |
|---|---|
| the settings header | `SettingsHeading`: title, repo and branch, "checked against Git" |
| the skills list | left `Card`: one row per skill, name and status |
| the skill detail | `SkillDetail` (middle): title and status, version track, "changes on main" list, SKILL.md block |
| the version track | row of four `Node`s at the top of `SkillDetail` |
| test, publish, the right rail | `PublishRail`: **Test against a fixture** checklist, then **Publish** |

`SettingsHeading`, `SkillDetail` and `PublishRail` are local to `settings-views.tsx`,
not exported.

### Other settings pages

| Page | Component |
|---|---|
| Skill · `settings/skills/[skillId]` | `SkillView`: `SkillDetail` and `PublishRail`, no skills list |
| Workflows · `settings/workflows` | `SettingsTableView` |
| Access & roles · `settings/access` | `SettingsTableView` |
| Usage & cost · `settings/usage` | `SettingsTableView` with four stat tiles on top |

## The chrome

| People call it | Component | File |
|---|---|---|
| the header, "Cost Intelligence" title | `ModuleHeader` (platform component) | `components/module-header.tsx` |
| the tabs, Runs / Jobs / Settings | `CipNav` | `cip-nav.tsx` |
| the search bar, the New run button (top right) | `SearchBar` and `Button`, rendered inside `CipNav` | `ui/searchbar.tsx`, `ui/Button.tsx` |
| the settings tabs | `SettingsNav`, which reuses `CipNav` | `settings/settings-nav.tsx` |
| the tinted background | `.dashboard-ground`, applied by `CipShell` | `cip-shell.tsx` |

The **Settings** tab only appears for Cost Intelligence **module admins** (the
"Can change settings" flag on the grant), not for every platform admin. Every settings
page checks this itself with `requireModuleAdmin`.

## Building blocks

| Component | File | What it draws |
|---|---|---|
| `Bar` | `ui/Bar.tsx` | A grey rounded placeholder bar. Width and height as props |
| `Button` | `ui/Button.tsx` | A button-shaped placeholder; `filled` uses the teal accent |
| `Card` | `ui/Card.tsx` | The platform's `.card` surface with padding |
| `Label` | `ui/Label.tsx` | Small uppercase section label (`.eyebrow`) |
| `Table` | `ui/Table.tsx` | Header line plus rows of bars, one bar per column |
| `SearchBar` | `ui/searchbar.tsx` | Placeholder, not built yet |
| `Node` | `views/parts.tsx` | The hollow diamond on timelines and pipelines |
| `Timeline` | `views/parts.tsx` | The seven-step run timeline |
| `Checkpoint` | `views/parts.tsx` | A paused-run question with options |
| `RunDetail` | `views/parts.tsx` | The whole run panel |
| `FileRow` | `views/parts.tsx` | One file: type badge, name, meta |

## Words that mean something specific here

| Word | Meaning |
|---|---|
| **Run** | One execution of a workflow against one job |
| **Job** | A bid or project folder in SharePoint, e.g. `24-118 Riverside Medical Tower` |
| **Workflow** | A chain of skills, e.g. Bid kickoff then Estimate population |
| **Skill** | A versioned `SKILL.md` package from the `PHB-CIS-skills` repo, e.g. `phb-estimate-population @ v2.3.1` |
| **Checkpoint** | Where a run pauses for a person: a decision, or an Excel save |
| **Ledger** | The timestamped record of what a run did |
| **Job memory** | Decisions from earlier runs, carried into every new run on that job |
| **AI FILES** | The one folder in a job where runs are allowed to write |
| **PCE** | Principal Cost Engineer: owns the skill catalog and publishing |

## Rules when changing these screens

- Put UI in `views/` or `ui/`, never in `page.tsx`.
- Do not move the chrome into a `layout.tsx`. A layout wraps a 404 page too, which
  would reveal the module to someone without access.
- Colours come from the platform tokens in `app/globals.css`. The module's colour is
  `var(--module-accent)` (teal); teal, orange and maroon also mean ok, warning and error,
  so never use them for decoration.
- When a skeleton becomes real, keep the component names above and replace the `Bar`
  placeholders inside them, so this file stays true.
- **If you add, rename or move a component, update this file in the same change.**
