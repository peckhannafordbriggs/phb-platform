# The shared UI kit: before and after (2026-11-10)

The record for the pull request that promoted Cost Intelligence's component
kit to `components/ui/` and moved the Change Orders chrome onto it
(`WHY-ITS-BUILT-THIS-WAY.md` § 78, `docs/07-conventions.md` → *UI*).

| View | Before | After |
|---|---|---|
| Change Orders, Mailbox tab, Drafts open | `before-co-mailbox-list.png` | `after-co-mailbox-list.png` |
| Change Orders, a draft open in the reading pane | `before-co-mailbox-open.png` | `after-co-mailbox-open.png` |
| Change Orders, Needs Review, a note open | `before-co-review-open.png` | `after-co-review-open.png` |
| Cost Intelligence, Runs | `before-cip-runs.png` | `after-cip-runs.png` |

The two Cost Intelligence files are byte-identical, and so were the Freeze
Protection register captures (not kept here): the kit renders what the module
rendered. The Change Orders pairs differ only in the chrome - tabs, pane
headers, buttons, pills, the segmented control, the selected-row treatment on
the review list - and in nothing the reading pane shows.

## How they were made

Headless Chrome over the DevTools protocol against a development server, at
1440 x 900, signed in with a session minted from the development `AUTH_SECRET`
for the owner's own employee row. **Every Change Orders API response was
answered inside the browser from invented fixtures** - the names, subjects,
addresses and the one email body are made up, no request reached Graph, and
the development server's log holds no `/api/modules/change-orders` line. The
Cost Intelligence view is the development database's real, empty state.

The captures were compared pixel by pixel in Chrome (both PNGs decoded to a
canvas); "byte-identical" above is `cmp` on the files.
