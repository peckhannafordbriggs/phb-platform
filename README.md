# PHB Platform

Internal platform for Peck Hannaford + Briggs. One sign-in, one frontend,
internal systems as modules, access granted per employee by an admin.

Read `CLAUDE.md` before working on this. Architecture and rules live in `docs/`.
Current scope is `PHASE-1.md`.

**Phase 1 makes no Microsoft Graph calls and no Claude API calls.** Change Orders
is a placeholder page.

---

## Requirements

| | |
|---|---|
| Node | 20 LTS or newer |
| Package manager | npm |
| Database | PostgreSQL 14+ (developed against 17, installed natively - no Docker) |

## Local setup

```bash
npm install
cp .env.example .env.local     # then fill it in - see below
createdb phb_platform          # or: psql -U postgres -c "CREATE DATABASE phb_platform"
npx prisma migrate dev
npm run seed
npm run db:test:setup          # creates and migrates the test database
npm run dev
```

The app runs at http://localhost:3000.

`npm install` will report that some packages have install scripts awaiting
approval. The approvals this project needs are already pinned in `package.json`
under `allowScripts` (Prisma's engines, esbuild, sharp, unrs-resolver), so a
clean clone does not need to approve anything by hand.

### Environment variables

Every variable is listed in `.env.example` with no real values. Fill in
`.env.local`, which is gitignored.

**Where each value comes from — what to generate yourself, what to copy, and the
three things to request from IT — is in
[`runbook.md`](runbook.md#filling-in-envlocal-on-a-new-machine).**
That includes what still works while you wait for a request to come back: the app
boots and the whole test suite passes without any Microsoft credential.

| Variable | What it is |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `TEST_DATABASE_URL` | A **separate** database, used only by `npm test` |
| `AUTH_SECRET` | Signs session cookies. Yours alone; it need not match anyone else's |
| `AUTH_URL` | `http://localhost:3000` locally |
| `AUTH_MICROSOFT_ENTRA_ID_ID` | Client ID of the **SSO** app registration |
| `AUTH_MICROSOFT_ENTRA_ID_SECRET` | Client secret - **local development only**, never in Azure |
| `AUTH_MICROSOFT_ENTRA_ID_TENANT_ID` | Tenant ID; the token's `tid` must match it |
| `ALLOWED_EMAIL_DOMAINS` | Comma-separated allow-list of verified email domains |
| `BOOTSTRAP_ADMIN_EMAIL` | Comma-separated. Each address is seeded as a platform admin. |
| `PHB_ALLOW_SEND` | The send gate. Must stay `false` outside production. |
| `GRAPH_CLIENT_ID`, `GRAPH_TENANT_ID`, `GRAPH_CLIENT_SECRET` | Change Orders mailbox. Absent is a supported state - the module reports itself unconfigured |
| `CO_MAILBOX` | The only mailbox the platform may touch |

The SSO app registration is **separate** from the Graph mail app registration -
different permissions, different credential lifecycles, different consent
stories.

`TEST_DATABASE_URL` must differ from `DATABASE_URL`. The suite truncates every
table between test files and refuses to start if the two match.

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
npx prisma migrate dev --name what_changed    # create and apply
npx prisma migrate deploy                     # apply in a deployed environment
npx prisma generate                           # regenerate the client
```

Prisma 7 takes the connection URL from `prisma.config.ts` (which loads
`.env.local`) rather than from `schema.prisma`, and connects through the
`@prisma/adapter-pg` driver adapter. The generated client lands in
`lib/generated/prisma` and is gitignored - run `npx prisma generate` after a
clean clone if your editor cannot resolve it.

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
  (modules)/         module UI - change-orders
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
  modules/           module services
prisma/              schema, migrations, seeds
tests/               Vitest suites
```

`lib/auth`, `lib/authz` and `lib/db` never import from `lib/modules/*`.
Dependencies point one way.

## Operations

Failure modes, symptoms and fixes: `runbook.md`.
