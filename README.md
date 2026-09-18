# PHB Platform

Internal platform for Peck Hannaford + Briggs. One sign-in, one frontend,
internal systems as modules, access granted per employee by an admin.

Three modules: **Change Orders** (a company-owned interface to the
`changeorder@phb1899.com` mailbox), **BAS** (building-automation sensor data),
and **Cost Intelligence**, in progress.

---

## New here?

**Start with [`DEVELOPER-SETUP.md`](DEVELOPER-SETUP.md).** It is the ordered
path from a clean machine to a passing test suite — installs, databases,
`.env.local`, seeds — plus the handful of things that will bite you if nobody
says them out loud. Do not piece setup together from this file.

Then, depending on what you are about to do:

| You are about to | Read |
|---|---|
| Build a module | [`PLATFORM-CONTEXT.md`](PLATFORM-CONTEXT.md) — what the platform already provides, and the contract a module satisfies |
| Change something that exists | [`WHY-ITS-BUILT-THIS-WAY.md`](WHY-ITS-BUILT-THIS-WAY.md) |
| Work on anything at all | [`CLAUDE.md`](CLAUDE.md) — the rules, short |
| Fix something broken | [`runbook.md`](runbook.md) — organised by symptom |
| Inherit this whole thing | [`HANDOVER.md`](HANDOVER.md) |

Environment variables are listed in `.env.example`, and where each value comes
from is [`runbook.md` → *Filling in `.env.local` on a new
machine*](runbook.md#filling-in-envlocal-on-a-new-machine). Only five are
required to boot, so the app runs and the whole suite passes before any
Microsoft credential arrives.

This file is the reference for the parts that are neither setup nor rules:
commands, database conventions, testing, and layout.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Vitest against `TEST_DATABASE_URL` |
| `npm run db:test:setup` | Creates and migrates the test database. Idempotent; run after a new migration. |
| `npm run seed` | Modules, positions, departments, bootstrap admin. Idempotent, safe in production. |
| `npm run seed:dev` | 130 fake employees for search and pagination testing. Refuses to run with `NODE_ENV=production`, or against any `DATABASE_URL` that is not localhost. |

Run `npm run seed` before `npm run seed:dev`.

## Database

All schema changes go through Prisma Migrate - never by hand.

```bash
npx prisma migrate dev --name what_changed    # author: writes it, applies it to MIGRATE_DEV_DATABASE_URL
npx prisma migrate deploy                     # apply: DATABASE_URL, locally and in Azure alike
npx prisma generate                           # regenerate the client
```

Prisma 7 takes the connection URL from `prisma.config.ts` (which loads
`.env.local`) rather than from `schema.prisma`, and connects through the
`@prisma/adapter-pg` driver adapter. The generated client lands in
`lib/generated/prisma` and is gitignored - run `npx prisma generate` after a
clean clone if your editor cannot resolve it.

`prisma.config.ts` also decides *which* URL. `migrate dev`, `migrate reset` and
`db push` go to `MIGRATE_DEV_DATABASE_URL`, and are refused if it is unset, not
local, the same database as `DATABASE_URL`, or holds any `bas_readings` rows;
everything else goes to `DATABASE_URL`. Locally that database holds the BAS
collector's readings, which is the reason. `runbook.md` → *Which command touches
which database*.

Prisma fields are camelCase; database tables and columns are snake_case via
`@@map` / `@map`. That keeps the raw SQL in `runbook.md` free of quoted
identifiers, which matters because those queries are the recovery path for
someone who has never seen this codebase.

`audit_events` is append-only, enforced by a database trigger. A consequence:
**deleting an employee row fails**, because the audit foreign keys are
`ON DELETE SET NULL` and that fires the trigger. Deactivate instead - that is
the documented rule, now enforced.

## Testing

Tests run against a **real PostgreSQL database**, not a mocked Prisma client.
The only thing mocked is `auth()`, so a test can act as a given employee; every
query, guard and route handler in the path is the real one.

Before the first run, once:

```bash
npm run db:test:setup   # creates TEST_DATABASE_URL's database and migrates it
npm test
```

`db:test:setup` is idempotent - run it again after any new migration. It refuses to
run if `TEST_DATABASE_URL` is missing, or if it points at the same database as
`DATABASE_URL`, because the suite truncates every table between test files.

It does not seed. Seeded rows would be truncated before the first assertion; each
test builds the fixtures it needs.

The authorization tests are the ones that matter. They assert that an ungranted
request is rejected - not that a granted one succeeds.

## Layout

```
app/
  (platform)/        shell, home, admin
  (modules)/         module UI - change-orders, bas, and each new module
  api/
    me/              the only source the sidebar uses
    onboarding/
    admin/           every route independently verifies isPlatformAdmin
    modules/         every route here is grant-gated
lib/
  auth/              login gate, self-provisioning
  authz/             the authorization boundary
  db/                Prisma client
  admin/             admin operations and guardrails
  modules/           module services - one directory per module key
prisma/              schema, migrations, seeds
tests/               Vitest suites
```

A new module adds a directory in each of those three places and a row in
`modules`. Nothing else changes: the sidebar and the admin grant matrix both
render from that table, so neither has a hardcoded module list.
`PLATFORM-CONTEXT.md` has the full contract.

`lib/auth`, `lib/authz` and `lib/db` never import from `lib/modules/*`.
Dependencies point one way.

## Operations

Failure modes, symptoms and fixes: `runbook.md`.
