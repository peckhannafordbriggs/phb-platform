# Admin → Employees on the shared kit: before and after (2026-11-13)

The record for the pull request that restyled the Admin Employees screen onto
`components/ui/` and changed three things about how it behaves: the default
*Show* is Everyone, the default sort is fewest grants first, and the column
per module became one Access column with chips and an expandable row
(`CLAUDE.md` → *Admin → Employees on the shared kit*; `runbook.md` →
*Admin panel (Phase 10)* → *The Access column, and a row's expanded panel*).

| Capture | What it shows |
|---|---|
| `before-employees.png` | `main` at 107c318: the old page on the same data. *With a grant* by default, so three of the fourteen people - the ones who signed in and have no access - are not on it; one column per module, sixteen of them, running off the right edge of a 1440-wide window; name ascending. |
| `after-employees.png` | This branch, the same data: the module shells' chrome with the three header actions as kit buttons, the kit search box and dropdowns, Apply the one red primary. Everyone, fewest grants first, the three people with no access at the top, newest sign-in first. One Access column, a count in words - *No access*, *1 module*, *16 modules* - and nothing else; every row is one line whatever the person holds. (A first pass put a chip per module on the row; the owner asked for the count alone the same day.) |
| `after-employees-expanded.png` | Grace Lindqvist's row expanded from its chevron: sixteen module cards in a wrapping grid of four, her five granted modules first and the eleven others after, each with its diamond in its colour and its full name, a switch for the grant on each, *Can change settings* on the two granted modules that have a settings screen (Building Automation, Cost Intelligence) and not on Change Orders, *Open full record* at the corner. The only place on the list that names a specific grant. The table's scroll box measured 1094 px of 1094 during the capture: nothing scrolls sideways. |
| `after-employees-narrowed.png` | Two letters typed into the search box: the page narrowed live to three rows, and the count line reading *3 of 14 on this page match. Apply to search all 14.* - the one place the screen says that what you see is this page narrowed and not the query re-run. |

## Method

Playwright's Chromium at 1440 wide, full page, against two dev servers on
this machine: a detached worktree of `main` at 107c318 and this branch, both
pointed at the **test** database rather than the development one, signed in
with a session minted with `next-auth/jwt` from the development `AUTH_SECRET`
for the owner's own employee row.

**Every employee on these captures but the owner's row is invented**, under
the dev seed's `seed.invalid` domain: thirteen people with a spread of
grants, statuses, positions, departments and sign-in dates, one with a
free-text position, one disabled, two platform admins. **Eleven of the
sixteen modules are invented too** - Safety Reports, Fleet, Timesheets,
Permits, Warranty Claims, Tool Crib, Submittals, Punch Lists, Training,
Drawings, Service Calls - registered in the test database's `modules` table
for the capture only, so the "fifteen or more modules" case in the request
is what the expanded capture shows rather than something argued from five.
Their diamonds wear the chrome purple, which is what `lib/module-accent.ts`
hands a module the palette has no slot for. The row expanded and the search
typed were driven through the page's own controls, not by navigating to a
URL. The test database was dropped and recreated with `npm run
db:test:setup` afterwards, so nothing of the seed outlives the capture.

## The other modules, byte for byte

The kit gained two things here - `Table` took `columns` and `detail`, and
`Switch` was added - and `ModuleHeader` took an `accent`. Each defaults to
what it rendered before, and that was proved rather than asserted: six
screens were captured from the `main` worktree and from this branch with
the same harness, against the **development** database (the real BAS
stations and report runs), and compared as files and pixel by pixel in
Chromium. (The comparison was run on the first pass, which also added a
`Chip` component; the second pass deleted it, unused by anything but the
Employees list, and touched no other kit file, so the result stands.)

| Screen | Result |
|---|---|
| Cost Intelligence, Runs | byte-identical, 1440 × 900 |
| Freeze Protection, the project catalog | byte-identical, 1440 × 900 |
| Knowledge Base | byte-identical, 1440 × 900 |
| Building Automation, Projects | byte-identical, 1440 × 900 |
| Building Automation, Settings | byte-identical, 1440 × 1102 |
| Building Automation, Reports → Usage (a kit `Table` with ten rows) | byte-identical, 1440 × 1800 |

Those twelve files are not kept here: a pair that is identical records
nothing a sentence does not. For that comparison the owner's development
row was given the Cost Intelligence, Knowledge Base and Freeze Protection
grants and the three were deleted afterwards; the row holds `bas` and
`change-orders` again, as it did.
