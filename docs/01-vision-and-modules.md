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
├── Home            (dashboard - intentionally undesigned, keep it simple)
├── Change Orders   (module 1)
├── Future System A
├── Future System B
└── Admin
```

Persistent left sidebar. Visible items derive from the employee's actual module
grants, never a hardcoded list.

## Module architecture

Change Orders is a module, not the platform. Keep the boundary clean without building
a plugin framework.

```
app/
├── (platform)/          core shell, home, admin
├── (modules)/
│   └── change-orders/   module UI
lib/
├── auth/                identity, session
├── authz/               grant checks, middleware
├── db/                  Prisma client, queries
└── modules/
    └── change-orders/   module services (Graph mail service lives here)
app/api/
├── me/
├── admin/
└── modules/
    └── change-orders/   every route here is grant-gated
```

Adding a future module should be: insert a `modules` row, add a route namespace under
`app/api/modules/<key>/`, add UI under `app/(modules)/<key>/`. The sidebar and admin
screen pick it up automatically because both render from the `modules` table.

Nothing in `lib/auth`, `lib/authz`, or `lib/db` may import from
`lib/modules/change-orders`. Dependencies point one way.

## Module registry

The `modules` table drives the sidebar and the admin grant matrix. A module is a row:
`key`, `display_name`, `description`, `icon`, `sort_order`, `status`.

Authorization always keys on the stable `key` (`change-orders`), never a display
label.

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

Deliberately undecided. Keep it a placeholder until there are real requirements. Do
not invent a dashboard.
