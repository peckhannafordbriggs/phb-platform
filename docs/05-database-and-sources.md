# Database and source of truth

## The rule

Before creating any table or persisting anything from an external system, answer:

**Who is the authoritative owner of this information?**

If the answer isn't "the platform," don't store it. The database must not become a
mirror of Microsoft 365.

## Source-of-truth table

| Data | Owner |
|---|---|
| Change-order email, folders, drafts, sent items | **Exchange** |
| CO pipeline state, run reports, Q&A logs | **SharePoint** |
| Bid Tracker rows | **`Bid Tracker.xlsx`**, written by Power Automate |
| Flow execution state | **Power Automate** |
| Employee identity (who exists, is the account active) | **Entra ID** |
| Employee platform profile (position, department) | **Platform** |
| Module definitions | **Platform** |
| Employee → module grants | **Platform** |
| Audit events | **Platform** |
| AI prompts | **SharePoint** today (`docs/09_Scheduled_Task_Prompts_VERBATIM.md`). Moves to the platform only at cutover of the centralized AI logic, with the SharePoint copy re-labeled a mirror on the same day. Until then, SharePoint wins. |

Never create a second authoritative copy. When one is unavoidable, name the winner
explicitly and put a banner on the loser.

## Foundation schema

Prisma models. Names are indicative; follow Prisma conventions.

```
Employee
  id                    uuid pk
  entraOid              text unique nullable   -- set on first sign-in, immutable after
  email                 text unique            -- lowercased, from token, never user input
  firstName             text
  lastName              text
  positionId            fk Position nullable
  positionOther         text nullable          -- when "Other" selected; flags admin cleanup
  departmentId          fk Department nullable
  profileCompleted      boolean default false
  status                enum(active, disabled) default active
  isPlatformAdmin       boolean default false
  sessionsValidAfter    timestamptz nullable   -- reject sessions issued before this
  firstSeenAt           timestamptz
  lastLoginAt           timestamptz nullable
  createdAt / updatedAt timestamptz

Module
  key                   text pk                -- 'change-orders'
  displayName           text
  description           text nullable
  icon                  text nullable
  sortOrder             int
  status                enum(active, hidden) default active

ModuleGrant
  id                    uuid pk
  employeeId            fk Employee
  moduleKey             fk Module
  grantedById           fk Employee
  grantedAt             timestamptz
  unique (employeeId, moduleKey)

Position
  id                    uuid pk
  name                  text unique
  status                enum(active, hidden) default active

Department
  id                    uuid pk
  name                  text unique
  status                enum(active, hidden) default active

AuditEvent
  id                    uuid pk
  actorEmployeeId       fk Employee nullable   -- null = system
  action                text                   -- see below
  targetEmployeeId      fk Employee nullable
  moduleKey             text nullable
  metadata              jsonb nullable
  occurredAt            timestamptz
```

`AuditEvent` is **append-only**. No updates, no deletes, ever.

Actions recorded by the foundation: `employee.provisioned`,
`employee.profile_completed`, `employee.disabled`, `employee.enabled`,
`employee.admin_granted`, `employee.admin_revoked`, `grant.added`, `grant.removed`,
`login.denied`.

Mail and scheduled-job work adds `mail.draft_edited`, `mail.sent`, `mail.deleted`,
`mail.moved`, and job events. Do not build a general audit framework — add action
strings as needed.

## Not in the foundation schema

No message table. No folder table. No attachment table. No delta token table. No
subscription table. No prompt table. No job table.

Each of those arrives with the phase that needs it, or not at all.

## Seeds

- `Module`: one row, `change-orders`.
- `Position`: so early users aren't all choosing "Other" — Accounting,
  Administrative, Co-Op Intern, Controls Engineer, Estimator, Executive, Foreman,
  Project Engineer, Project Manager, Superintendent. Admin-editable after, and
  employees can change their own.
- `Department`: confirmed with the operator — Administrative, AI, Controls, Engineer,
  Estimator, Foreman, Piping, Project Manager, Service, Sheet Metal, VDC.
  Admin-editable after.
- Bootstrap admins from `BOOTSTRAP_ADMIN_EMAIL`, a comma-separated list. Idempotent,
  and never re-promotes someone demoted through the UI unless no active admin
  remains — see the Bootstrap section of `docs/04-auth-and-permissions.md`.

## Migrations

All schema changes go through Prisma Migrate. Version controlled, reproducible,
clearly named, small. Never alter a production schema by hand.

**Reference-data changes go through a migration too**, not a manual edit. There is no
application path that deletes a `Position` or a `Department` — hiding must not break
employees already assigned to a value, and both foreign keys are `ON DELETE RESTRICT`.
So removing one is a migration, which is also the only way it reaches every
environment identically. `20260817000000_replace_departments` is the worked example:
reassign, audit, then delete.
