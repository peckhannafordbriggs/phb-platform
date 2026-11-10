# The BAS module on the shared kit: before and after (2026-11-10)

The record for the pull request that moved every Building Automation screen
onto `components/ui/` - physical style only - and added the Points drawer
(`docs/09-bas-what-is-built.md` → *Points editing*, `runbook.md` → *How do I
rename a point*).

| View | Before | After |
|---|---|---|
| Settings, the office station's points expanded | `before-bas-settings.png` | `after-bas-settings.png` |
| The Points drawer (new) | — | `after-bas-points-drawer.png` |
| Point Explorer, a custom range with readings | `before-bas-explorer.png` | `after-bas-explorer.png` |
| Collection Health | `before-bas-health.png` | `after-bas-health.png` |
| Analyze, one question answered | `before-bas-analyze.png` | `after-bas-analyze.png` |
| Reports | `before-bas-reports.png` | `after-bas-reports.png` |
| Reports, Generated | `before-bas-reports-generated.png` | `after-bas-reports-generated.png` |

Every colour is the one the screen had: the Analyze teal panel, its gold
bubbles and purple accent, the module's cyan on the tab underline and the
trend line, the purple on the range strips, maroon for data lost and for
alarms, the tone tints on the tiles. What moved is the tab bar, the buttons,
the dropdowns, the segmented strips, the search boxes, the pills, the
section eyebrows and the table headings.

## How they were made

Headless Chrome over the DevTools protocol against a development server, at
1440 wide and tall enough for each page, signed in with a session minted
from the development `AUTH_SECRET` for the owner's own employee row. The BAS
data is the development database's real data - the office station and the
Spring Grove lab, their points, 87,100 readings, three report definitions
and five runs. **The one Analyze question was answered from a fixture
inside the browser**: no model was called and the development server's log
holds no `POST /api/modules/bas/analyze` line. The Point Explorer capture
asks for 15 to 29 September 2026, the last fortnight the local database holds
readings for.

The Cost Intelligence, Freeze Protection and Change Orders captures from the
kit's own pull request were re-taken on this branch with the same harness
and compared byte for byte, since the kit gained props here; the pull
request records the result.
