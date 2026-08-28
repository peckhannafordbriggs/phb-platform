# Phase 10 — Admin Panel Refinement

Read `CLAUDE.md`, `docs/04-auth-and-permissions.md`, and
`WHY-ITS-BUILT-THIS-WAY.md` first. Those define **how**, and override anything here.

The admin panel's core shipped in Phase 3 and works. This phase is scale and polish, not
new capability.

---

## Goal

The admin screen holds up when there are hundreds of employees and more than one module,
and an admin can answer "who has access to what, and when did that change" without opening
a database client.

**No new authorization capability.** No roles, no per-module admins, no group-based grants.
Those are explicitly deferred in `docs/04`.

---

## What already works — do not rebuild

Employee list with search, filters and pagination. Grant toggles per module. Enable and
disable. The admin flag. Position and department editing. Append-only audit log with a
database trigger. Four guardrails: an admin can't remove their own admin flag, can't
disable themselves, the system refuses to leave zero active admins, and there is no
create-employee endpoint.

Verify each still holds rather than assuming. If anything below would change one, stop and
ask.

---

## Priority order

1. **The audit log becomes usable** — it's the most valuable thing here and currently the
   least accessible
2. **Bulk grant and revoke** at real volume
3. **List usability** — filters, sorting, empty and loading states
4. **Positions and departments management**
5. **Two-module reality** — the screen was built when only Change Orders existed

---

## Requirements

### 1. The audit log

Every grant, revoke, disable, enable, admin-flag change, department change and position
change already writes a row. The table is append-only, enforced by a trigger. What's
missing is a way to read it.

- A filterable view: by target employee, by acting admin, by action, by date range
- Employee detail shows that person's own history inline — the common question is "why does
  this person have access" and it should be answerable without leaving the page
- Human-readable rendering. `grant.added` with two UUIDs is not an answer; "Jim Schwarz
  granted Change Orders to Sarah Martin on 12 September" is
- The distinction between an employee changing their own position and an admin changing it
  is already recorded in the event metadata (`self`). Surface it

**Do not add a delete or edit path.** The trigger will reject it, and that's the point.

### 2. Bulk operations

Multi-select on the list, then grant or revoke a module across the selection.

- A confirmation showing how many employees and which module, before anything happens
- One audit row per employee, not one for the batch — the log has to answer "when did *this
  person* get access"
- Partial failure is possible. Report what succeeded and what didn't; never leave the admin
  guessing
- The guardrails apply to every member of the selection. A bulk operation cannot
  accidentally leave zero admins or disable the acting admin

**Bulk applies to grants and status only.** Nothing else, and nothing that sends anything —
see the send prohibitions in `CLAUDE.md`.

### 3. List usability at volume

The seed already produces 130+ fake employees. Test against that, not against four rows.

- Sortable columns: name, last sign-in, status
- The default filter is "has at least one grant", with a toggle to show everyone. Keep it —
  the list accumulates anyone who ever signed in
- Filter by module, status, department, and by "no grants" as its own case
- Real empty states: no results from a filter reads differently from no employees at all
- Loading states that don't shift layout
- Show the count, and make it clear when a filter is active

### 4. Positions and departments

Both are admin-managed lists already. What's needed is the care around changing them.

- Add, rename, hide. **Never delete a value an employee is assigned to** — hiding is the
  mechanism, and hiding must not break an existing assignment
- A hidden value still renders on the detail page of an employee assigned to it, so nobody
  sees a blank field and assumes data loss
- Assigning a hidden value is refused server-side, not just absent from the dropdown
- Show how many employees hold each value, so an admin knows what a rename affects
- Display order relies on database collation sorting case-insensitively. `runbook.md`
  has the note; don't add per-query `COLLATE`

### 5. Two modules exist now

The screen was built when Change Orders was the only module. BAS is real.

- The grant matrix renders a column per active module from the `modules` table. Verify it
  actually does, with two modules present
- Filtering by module must work for either
- Nothing may hardcode a module key in the UI. Authorization keys on the stable `key`, never
  a display label

---

## Out of scope

- Roles of any kind
- Per-module admins
- Group-based grants mapped to Entra security groups
- Creating employees
- Editing or deleting audit rows
- Anything touching the mailbox, Graph, SharePoint, Power Automate, or BAS data
- Changing the login gate

---

## Hard constraints

- **The four guardrails must still hold**, including under bulk operations
- **No create-employee endpoint.** The existing test asserting its absence must still pass
- **Audit rows remain append-only.** The trigger stays
- **Grants are still read from the database on every request.** No caching them into a
  session or token
- **A missing module grant still returns 404**, and admin routes still return 403
- Every `/api/admin/*` route independently verifies `isPlatformAdmin`
- All existing tests must still pass

---

## Acceptance criteria

- [ ] Build, typecheck, lint clean; all existing tests still pass
- [ ] Audit log is filterable by target, actor, action and date
- [ ] Employee detail shows that employee's history, human-readable
- [ ] Self-changed versus admin-changed position is distinguishable in the log
- [ ] No endpoint can edit or delete an audit row — asserted by test
- [ ] Bulk grant and revoke work, writing one audit row per employee
- [ ] A bulk operation cannot leave zero active admins — asserted by test
- [ ] A bulk operation cannot disable the acting admin — asserted by test
- [ ] Partial bulk failure reports which employees succeeded and which didn't
- [ ] Sorting, filtering and pagination behave correctly against 130+ seeded employees
- [ ] Filtering by "no grants" works
- [ ] Empty-from-filter and empty-entirely are visually distinct
- [ ] Hiding a position or department leaves existing assignments intact and visible
- [ ] Assigning a hidden value is refused server-side — asserted by test
- [ ] Employee counts per position and department are shown
- [ ] The grant matrix renders correctly with both modules present
- [ ] No module key is hardcoded in the UI — verified by grep
- [ ] A non-admin gets 403 from every `/api/admin/*` route, including new ones
- [ ] All four guardrails re-verified

---

## Notes for the implementer

**The audit log is the point of this phase.** Under app-only Graph auth, Exchange records
the application as sender rather than the person — so the platform's audit table is the
only record of who did what. It's currently written correctly and read with difficulty.
Fix the reading.

**Test against the seeded volume.** Sorting and pagination bugs only appear past a page.
`npm run seed:dev` gives you 130+ employees, some disabled, some with incomplete profiles,
some on free-text positions.

**Click through it.** Two of the three bugs found in Phase 8 came from a person using the
UI, not from a test. That applies to an admin screen as much as a mail client.

**Stop and ask** before adding a role concept, a create-employee path, anything that
weakens a guardrail, or anything that lets a bulk action do more than grant, revoke, enable
or disable.
