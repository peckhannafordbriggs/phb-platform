# Vision and module architecture

## What the platform is for

Build internal infrastructure once. Grant employees access to it.

Today, using the change-order system requires a specific laptop configuration: a
synced SharePoint library, a Claude desktop app with folders connected, two scheduled
tasks recreated by hand, and mailbox permission in Outlook. That setup has already
been handed between operators once, and the handover took nineteen documents.

The platform's purpose is that an employee needs none of it. They sign in and the
system is there.

## Shape

```
PHB Platform
│
├── Home              (personal launcher)
├── Change Orders     (module 1)
├── BAS               (module 2 - building automation)
├── Cost Intelligence (module 3 - in progress)
└── Admin
```

Persistent left sidebar. Visible items derive from the employee's actual module
grants, never a hardcoded list.

## Module architecture

Change Orders is a module, not the platform, and so is every module after it. Keep the
boundary clean without building a plugin framework. Three modules in, the shape has not
needed one — which is the evidence that it should stay this way.

```
app/
├── (platform)/          core shell, home, admin
├── (modules)/
│   ├── change-orders/   module UI
│   ├── bas/
│   └── <your module>/
lib/
├── auth/                identity, session
├── authz/               grant checks, middleware
├── db/                  Prisma client, queries
└── modules/
    ├── change-orders/   module services (Graph mail service lives here)
    ├── bas/
    └── <your module>/
app/api/
├── me/
├── admin/
└── modules/
    ├── change-orders/   every route here is grant-gated
    ├── bas/
    └── <your module>/
```

Adding a future module should be: insert a `modules` row, add a route namespace under
`app/api/modules/<key>/`, add UI under `app/(modules)/<key>/`, and a service layer under
`lib/modules/<key>/`. The sidebar and admin screen pick it up automatically because both
render from the `modules` table.

`PLATFORM-CONTEXT.md` is the full version of that contract, written for someone about to
build one. This file is the architecture; that one is the instructions.

Nothing in `lib/auth`, `lib/authz`, or `lib/db` may import from `lib/modules/*` —
any module, not just Change Orders. Dependencies point one way.

## Module registry

The `modules` table drives the sidebar and the admin grant matrix. A module is a row:
`key`, `display_name`, `description`, `icon`, `sort_order`, `status`.

Authorization always keys on the stable `key` (`change-orders`, `bas`, …), never a
display label. A module's display name can be renamed in the admin screen without
touching a single authorization check, which is the point of the split.

## Change Orders UI

An email-oriented workspace. Conceptual desktop layout:

```
┌──────────┬────────────┬──────────────┬──────────────────┐
│ Platform │ Mail       │ Message list │ Reading pane     │
│ sidebar  │ folders    │              │                  │
│          │            │  Subject     │  From / To       │
│ Home     │ Inbox      │  Sender      │  Body            │
│ Change   │ Drafts     │  Date        │  Attachments     │
│  Orders  │ Sent       │              │                  │
│ Admin    │ Deleted    │              │  [Edit] [Send]   │
│          │ Projects ▸ │              │                  │
└──────────┴────────────┴──────────────┴──────────────────┘
```

Not a pixel-level requirement. Optimize for the real workflow, which is: open
Drafts, read a draft the automation produced, edit it, send it.

## Frontend principles

Professional internal software. Clarity, speed, familiar interactions, keyboard
usability, clean hierarchy.

Avoid: heavy animation, consumer AI styling, anything that looks like Claude or
ChatGPT, pixel-copying Outlook.

## Home

**This shipped and is no longer undecided.** Home was held as a deliberate placeholder
for most of the build — "do not invent a dashboard" was the rule, and it was the right
one while nobody knew what belonged there. It was designed once there were real
requirements, and it is now a personal launcher: what changed since you were last here,
and the modules you actually hold grants for.

The original instinct still applies to anything you are tempted to add to it. Home
renders per-employee and shows nothing about modules a person cannot reach. See
`docs/DESIGN-BRIEF.md` and the *Home* section of `runbook.md`.
