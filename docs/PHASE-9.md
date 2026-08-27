# Phase 9 — Conversations, Sync and Reliability

Read `CLAUDE.md`, `docs/03-exchange-and-graph.md`, and `docs/02-existing-co-system.md`
first. Those define **how**, and override anything here on architecture.

Phases 4–8 built the mail service, the mailbox UI, draft edit/send, and full email
actions. This phase makes the experience feel live and hold up when things go wrong.

---

## Goal

Two independent things:

**Conversation grouping** — messages that belong to the same thread read as one item, the
way Outlook shows them. The change-order mailbox is unusually thread-heavy: a vendor
pricing request generates a long back-and-forth, and a change order *is* effectively a
conversation.

**Reliability** — Outlook and the platform behave like two clients of one mailbox, and a
throttle, a network failure, or a concurrent edit doesn't lose someone's work.

Part A needs nothing from Azure. Part B is the webhook question and can't be built
locally.

---

## Part A — buildable now

### 1. Conversation grouping

Every message carries `conversationId`. Phase 8 verified it survives replies, and
Intake 6 matches vendor replies on it, so it's already load-bearing in the automation.

- Group messages in a folder by `conversationId` into a collapsible row: subject,
  participant names, message count, newest date
- Expand to the individual messages, newest last
- A single-message conversation renders as an ordinary row, not a group of one
- Grouping happens in our process, not via `$orderby=conversationId` — same
  collect-and-sort approach search already uses, and it composes with the existing
  newest-first ordering
- **Grouping must be toggleable**, defaulting to on. Someone hunting one specific message
  wants the flat list

Interaction with paging is the real design question. A conversation can span pages, so a
group assembled from one page is incomplete and looks complete. Decide deliberately:
either group only within what's loaded and say so, or collect to a cap the way search
does. **Tell me which and why before building it** — a group that silently hides messages
is the failure this codebase cares about most.

Drafts complicate it: an unsent draft reply shares the conversation with the message it
answers. A draft inside a collapsed group must stay visible, since reviewing it is the
job.

### 2. Concurrent editing

Outlook and the platform can edit the same draft, and the operator has the mailbox open
in Outlook. Last write wins — Graph offers no useful concurrency control.

Phase 6 built an advisory lock keyed on the immutable ID. Improve the honesty of it:

- Detect that a draft changed underneath the editor and say so, offering to reload rather
  than silently overwriting
- Show clearly when a draft is locked by someone else in the platform, and by whom
- A lock must never strand a draft — the 90-second TTL and refresh already handle a closed
  tab; verify it
- Accept that Outlook can still win, and tell the user. Do not pretend to prevent it

### 3. Resilience

- **Throttling.** Respect `Retry-After`. One retry exists already; make the UI show that
  a request is being retried rather than appearing frozen
- **Transient network failure.** A failed poll should not clear the pane or drop the
  editor's state. A failed autosave must already block a send — verify it still does
- **Credential expiry.** A clear "not connected" state, not a crash and not a Graph error
  string
- **Stale IDs.** Power Automate moves messages constantly. Already mapped to `not_found`;
  make sure every surface handles it as a normal event
- **Recovery.** Every error state needs a way forward — retry, reload, or go back to the
  list. An error with no action is a dead end

### 4. Two-way sync verification

Not a build task. Verify against the live mailbox and record it in
`docs/phase-9-verification.md`:

```
draft created in Outlook       → appears in the platform
draft edited in the platform   → updated in Outlook
message moved in Outlook       → reflected in the platform
message deleted in Outlook     → reflected in the platform
draft sent from the platform   → in Sent Items in Outlook
message filed by a flow        → reflected in the platform
```

Use `ZZTEST` fixtures throughout. Record the observed latency of each, since that's the
number that decides whether Part B is worth doing at all.

---

## Part B — needs Azure

Graph change notifications require a public HTTPS endpoint Microsoft can reach for the
validation handshake, so this cannot be built or tested locally.

**Do not start Part B until Part A's latency numbers exist.** The polling interval may
already be good enough, in which case Part B is work that adds a subscription lifecycle,
a renewal job, a validation endpoint, and dropped-notification reconciliation for no user
benefit.

If it does go ahead:

- Subscriptions on the mailbox, renewed on a schedule — mail subscriptions expire in
  roughly three days
- Lightweight notifications only: IDs, no encrypted resource data. The certificate
  management isn't worth it
- **Treat every notification as untrusted.** Validate `clientState`, return 202
  immediately, and use the notification only as a signal to go read Graph. Never trust
  payload content
- **Keep polling as the floor.** Notification delivery is best-effort. A dropped
  notification should cost minutes, not days
- A reconciliation pass that catches what notifications missed

---

## Out of scope

- Any message, folder, or delta-token table. **Nothing about the mailbox is persisted.**
- Delta queries — they imply stored tokens, which imply a sync engine
- CO context panel
- SharePoint, Power Automate, Claude API
- New email actions; Phase 8 closed that

---

## Hard constraints

- **Never persist** message bodies, attachment content, or mailbox state. The draft lock
  table stays as it is — id, holder, expiry, nothing else.
- **No `sendMail`, no `permanentDelete`.** The tests that fail if either appears must
  still pass.
- Grouping is a **display** concern. It must not change what a move, delete, or send acts
  on. Acting on a group is not a thing — see the send prohibitions in `CLAUDE.md`.
- **Do not touch** the 11 flows, the four sentinel filenames, or `Bid Tracker.xlsx`.
- All existing tests must still pass.
- The service remains the only thing that talks to Graph.

---

## Acceptance criteria

**Part A — automated**

- [ ] Build, typecheck, lint clean; all existing tests still pass
- [ ] Conversations group correctly, including single-message and draft-containing threads
- [ ] Grouping toggles off to a flat list
- [ ] Newest-first ordering survives grouping
- [ ] A conversation spanning a page boundary behaves as decided, and the UI says so if
      incomplete
- [ ] A concurrent modification is detected and surfaced, not silently overwritten
- [ ] Locks expire and never strand a draft
- [ ] A failed poll does not clear the pane or drop editor state
- [ ] A failed autosave still blocks a send
- [ ] Throttling retries once and the UI reflects it
- [ ] Every error state offers an action
- [ ] No new table stores mailbox data

**Part A — manual, live mailbox, `ZZTEST` fixtures only**

- [ ] A real vendor thread groups correctly and expands to the right messages
- [ ] An unsent draft reply stays visible in a collapsed group
- [ ] Edit the same draft in Outlook and the platform; the conflict is surfaced
- [ ] All six sync directions verified, with observed latency recorded
- [ ] `PHB_ALLOW_SEND` back to `false` afterward

**Part B**

- [ ] Only started if Part A's latency numbers justify it
- [ ] Validation handshake succeeds; `clientState` verified on every notification
- [ ] Subscriptions renew automatically; a missed renewal is visible, not silent
- [ ] Polling still runs as the floor
- [ ] A dropped notification is recovered by reconciliation

---

## Notes for the implementer

**Verify against the live mailbox.** Every Graph phase found defects that mocked
transports agreed with — `wellKnownName`, folder depth, `$skip` versus `$skiptoken`,
Exchange rewriting U+00A0, `<td><p>` in pasted cells, `DELETE` landing in Recoverable
Items, `$search` ignoring immutable IDs.

**Grouping is display only.** The moment a group can be acted on as a unit, the
one-human-one-message rule is at risk. Keep every action on individual messages.

**Part A's latency numbers are the deliverable that decides Part B.** Measure them
honestly. If polling at 60 seconds is fine in practice, saying so is a better outcome than
building a subscription lifecycle.

**Stop and ask** before adding a table, changing the paging model, weakening a guard, or
anything that lets an action apply to more than one message.
