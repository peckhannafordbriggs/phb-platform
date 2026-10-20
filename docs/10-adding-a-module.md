# Adding a module

Read this before adding a module, not after. It is written for two readers at
once: a new developer who has never opened this repository, and an AI agent
given "add a module" as a task. Everything here is a file path you can open, a
command you can run, or a check you can verify.

The one thing to take away if you read nothing else:

> **A module row reaches development and test databases through
> `prisma/seed.ts`, and reaches PRODUCTION only through a migration.** You need
> both, with the same values, and the migration carries
> `ON CONFLICT (key) DO NOTHING`.

Section 4 is the story of how that rule was learned.

---

## 1. What a module is here

The platform is one login, one sidebar, and a set of modules. An employee sees
a module in the sidebar only when an admin has granted it to them. A module is
made of five pieces:

| Piece | What it is | Where it lives |
|---|---|---|
| **A row in the `modules` table** | The module's key, name, description, icon, sort order and status. **This row is what makes the module exist.** The sidebar, the admin screen and every access check read it. | The database: `prisma/seed.ts` **and** a migration (section 3) |
| **A grant per employee** | A row in `module_grants` saying this employee may open this module. Admins create these in the admin screen; no code creates them. | The database, through `/admin` |
| **A page** | The screen a granted employee sees at `/<key>`. It checks the grant server-side before rendering anything. | `app/(modules)/<key>/page.tsx` |
| **A constants file** | The module key as a TypeScript constant, so code never spells it as a loose string. | `lib/modules/<key>/constants.ts` |
| **An accent entry** | Which of the logo's five colours the module wears in the sidebar and header. | `lib/module-accent.ts`, the `ASSIGNED` map |

The row is what makes it exist. The code is what makes it do something.

A module that does something will also have an API namespace
(`app/api/modules/<key>/*`), a service layer (`lib/modules/<key>/*`) and
possibly a settings screen. Those are described in `PLATFORM-CONTEXT.md` under
*The integration contract*. This document is about the five pieces above,
because they are the ones a module cannot be seen without.

Two words that come up constantly:

- **key** — the short, stable identifier, lowercase with hyphens:
  `change-orders`, `bas`, `cost-intelligence`, `knowledge-base`. It is the
  primary key of the `modules` table, the URL segment, and what every access
  check compares. It never changes once a module exists. Authorization keys on
  this, never on the display name.
- **grant** — permission for one employee to open one module. Nothing else
  grants access: not being an admin, not having a company account, not having
  the page deployed.

---

## 2. Where each piece goes — Cost Intelligence as the worked example

Cost Intelligence (`cost-intelligence`) is the smallest module in the
repository: a row, a constants file, a page that shows a placeholder card, and
an accent entry. It is the minimum that makes a module visible and grantable.
Copy its shape; substitute your key.

### 2a. The constants file — `lib/modules/cost-intelligence/constants.ts`

```ts
/** Authorization key for the Cost Intelligence module. Matches the seeded row and the URL segment. */
export const COST_INTELLIGENCE_MODULE_KEY = "cost-intelligence";

export const COST_INTELLIGENCE_MODULE_NAME = "Cost Intelligence";
```

The key constant must equal the directory name under `app/(modules)/` and the
`key` of the database row. Three spellings of the same string, and all three
have to agree.

### 2b. The page — `app/(modules)/cost-intelligence/page.tsx`

```tsx
import { notFound } from "next/navigation";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { requireModuleAccess } from "@/lib/authz";
import {
  COST_INTELLIGENCE_MODULE_KEY,
  COST_INTELLIGENCE_MODULE_NAME,
} from "@/lib/modules/cost-intelligence/constants";

export const dynamic = "force-dynamic";

export default async function CostIntelligencePage() {
  const access = await requireModuleAccess(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) notFound();

  return (
    <ModulePlaceholder
      moduleKey={COST_INTELLIGENCE_MODULE_KEY}
      title={COST_INTELLIGENCE_MODULE_NAME}
    />
  );
}
```

Two lines matter. `requireModuleAccess` is the security boundary: an employee
without a grant gets a 404, whether or not the sidebar showed them a link. And
`ModulePlaceholder` is the designed "Content not available — this module has no
screens in this build yet" card, so a granted module with no screens yet says
so rather than erroring.

The directory `app/(modules)/` already has a `layout.tsx` that wraps every
module in the platform shell (sidebar, header). You do not add a layout.

### 2c. The accent entry — `lib/module-accent.ts`

```ts
const ASSIGNED: ReadonlyMap<string, number> = new Map([
  ["change-orders", 0],
  ["bas", 1],
  ["cost-intelligence", 3],
  ["knowledge-base", 4],
]);
```

Add a line for your key. The number is an index into the five logo colours
(red, cyan, orange, teal, pink). Four are taken; **index 2, orange, is the one
left**. After that the palette is exhausted and a sixth module needs a design
decision rather than a line — `tests/module-accent.test.ts` is where that is
asserted. An unassigned key still gets a colour (the file explains the
fallback), but assign it anyway: the sidebar and the header compute the colour
separately, and only an assignment keeps them agreeing.

### 2d. The seed row — `prisma/seed.ts`

```ts
const MODULES = [
  // ... change-orders, bas ...
  {
    key: "cost-intelligence",
    displayName: "Cost Intelligence",
    description:
      "Bid estimates and the reasoning behind each cost line.",
    icon: "calculator",
    sortOrder: 300,
  },
  // ... knowledge-base ...
];
```

The seed upserts every row in that list. Status is not in the object: it takes
the column default, `active`, and the seed never writes status on re-run so an
admin who hid a module is not overridden by the next deploy.

### 2e. The migration — `prisma/migrations/<timestamp>_register_<key>/migration.sql`

Section 3. **This is the piece that was missed.**

### Build order, with commands

1. Create `lib/modules/<key>/constants.ts` (2a).
2. Create `app/(modules)/<key>/page.tsx` (2b).
3. Add the `ASSIGNED` line (2c).
4. Add the row to `MODULES` in `prisma/seed.ts` (2d).
5. Create the migration folder and file by hand (section 3). The folder name is
   a 14-digit timestamp, an underscore, and a name:
   `prisma/migrations/20261001120000_register_cost_intelligence_and_knowledge_base/`
   is the example. Prisma records migrations by folder name; nothing else
   registers it.
6. Apply and seed locally:

   ```bash
   npx prisma migrate deploy        # applies the migration to your development database
   npm run db:test:setup            # applies it to the test database (the suite refuses to run otherwise)
   npm run seed                     # idempotent; your dev database gets the row from here too
   ```

7. Run the guard, then the suite:

   ```bash
   npm test -- tests/module-registry.test.ts
   npm test
   ```

8. Grant yourself the module at `/admin` (section 6) and open `/<key>`.

Checks you can verify rather than remember:

- `grep -rn "'<key>'" prisma/migrations/` prints a line inside an
  `INSERT INTO modules`.
- `grep -n 'key: "<key>"' prisma/seed.ts` prints a line.
- `ls app/(modules)/<key>/page.tsx` exists.
- `grep -n '"<key>"' lib/module-accent.ts` prints a line inside `ASSIGNED`.
- `npm test -- tests/module-registry.test.ts` passes. It fails, naming the
  key and this document, if any of the first two are missing.

---

## 3. The production rule

Three kinds of database run this platform, and they come into being
differently:

| Database | How it gets its tables | How it gets its module rows |
|---|---|---|
| Your development database (`DATABASE_URL`) | `npx prisma migrate deploy` | `npm run seed` — you ran it when you set up |
| The test database (`TEST_DATABASE_URL`) | `npm run db:test:setup` | The tests build their own rows per file |
| CI's test database | `npm run db:test:setup` in `.github/workflows/ci.yml` | Same |
| **Production (Azure)** | `npx prisma migrate deploy`, run by `.github/workflows/deploy.yml` on every merge to `main` | **The seed ran ONCE, by hand, on 9 September 2026, and never runs again.** `deploy.yml` says so in a comment and does not call it. |

So: **a fresh database gets its module rows from the seed. Production is never
fresh.** The one database that matters most is the one database the seed does
not reach. Anything that only the seed adds exists everywhere except there.

That is why a module needs both:

- **The seed line**, so every fresh database (a new developer's machine, CI, a
  rebuilt test database) has the row.
- **The migration**, so production has it. Migrations are the only thing that
  runs against production automatically.

Same values in both, and the migration ends with `ON CONFLICT (key) DO
NOTHING`, so on every database the seed already populated it inserts nothing
and changes nothing, and running it twice is safe. The migration must never
`UPDATE` an existing row: an admin may have changed the status, and a deploy
must not undo that.

The shape, from `20261001120000_register_cost_intelligence_and_knowledge_base`:

```sql
INSERT INTO modules (key, display_name, description, icon, sort_order, status)
VALUES
  (
    'cost-intelligence',
    'Cost Intelligence',
    'Bid estimates and the reasoning behind each cost line.',
    'calculator',
    300,
    'active'
  )
ON CONFLICT (key) DO NOTHING;
```

Write `status` explicitly. `active` means a granted employee sees it; `hidden`
means nobody can open it even with a grant, and it does not appear in the admin
screen's module filter. There is no admin screen that changes a module's
status, so a row that lands `hidden` needs a second migration or a hand edit on
production to turn on. Land `active` unless you have a reason not to, and write
the reason in the migration's comment.

Why not seed production on every deploy instead? Because the seed also writes
the bootstrap admin rows from `BOOTSTRAP_ADMIN_EMAIL`, and a deploy that re-ran
it could silently recreate an admin someone had deliberately removed. That is
decided and recorded in `deploy.yml`; do not re-open it to save writing a
migration.

What `docs/05-database-and-sources.md` says about reference data in general —
"adding reference data: seed (a migration may also add it)" — is true for
positions and departments because they are admin-editable in the UI and nobody
needs one to exist on a particular day. A module row is different: the code
that ships beside it is unreachable until the row exists, so for modules the
migration is not optional.

---

## 4. What happened in September 2026

Cost Intelligence and Knowledge Base shipped their pages on 23 September 2026
(PR #25): constants, pages, accent entries, and rows in `prisma/seed.ts`. Every
test passed. Both modules appeared on every developer machine and in CI. Both
could be granted, both rendered their placeholder card, both wore the right
colour.

The deployed platform could not show either to anyone. Production's `modules`
table held `bas` and `change-orders`, because the seed had run there once on
9 September, before either row existed, and never ran again. The pages were
deployed and guarded on a key that no row carried, so no admin could grant
them and no sidebar could list them.

Nobody's test could have caught it. Every test database runs the seed, or
builds the row it needs by hand, so every test sees a world in which the row
exists. The miss was found by a person querying the production `modules` table
on 24 September — caught before it mattered, because nobody had yet been
promised either module in production. Then, with the fix still unwritten a
week later, the same gap nearly shipped a second time. The migration named
above is the fix, and `tests/module-registry.test.ts` now fails the build
before there can be a third.

The lesson in one line: **"works on my machine" and "exists in production" are
separated by exactly one migration, and no test catches it because every test
database runs the seed.**

---

## 5. Verifying after a deploy

The deploy workflow applies migrations and rolls the revision; it does not
check that the rows arrived. Check it yourself, once, after the deploy that
carries your migration.

**The query.** Connect to the production database the way `runbook.md` →
*Verify the deployment before migrating* describes (a connection string with
`sslmode=require`, and your client address on the server's firewall), then:

```sql
SELECT key, display_name, status, sort_order
  FROM modules
 ORDER BY sort_order;
```

Your key is a row, with `status = 'active'`. If it is not there, the migration
did not apply — `SELECT migration_name, finished_at FROM _prisma_migrations
ORDER BY started_at DESC LIMIT 5;` says whether it ran, and `runbook.md` →
*A migration fails on deploy* is the next step.

**The admin screen.** Sign in to the deployed platform as a platform admin and
open `/admin`. The *Module* filter above the employee list offers one option
per active module; yours is in it. Open any employee: the grants section shows
one toggle per module, and yours is there. If the filter and the toggle both
lack it, the row is missing or `hidden`; if they have it, the row is right and
what remains is granting.

---

## 6. How grants work

A grant is one row in `module_grants`: an employee, a module key, who granted
it and when, and an `is_module_admin` flag that only matters for modules with
a settings screen. Admins create and remove grants at `/admin`, individually
or in bulk. Every change is an audit row.

What a grant does, and does not do:

- **A module with no grants is invisible to everyone, no matter what its row
  says.** The sidebar lists only modules the signed-in employee holds a grant
  for (`listGrantedModules` in `lib/authz/guard.ts`), and the page guard
  (`requireModuleAccess`) answers 404 without one. A freshly registered module
  shows up for nobody until an admin grants it — including the admin.
- **Being a platform admin is not a grant.** An admin can grant themselves a
  module; they do not hold it by default. `CLAUDE.md` states this as a settled
  decision.
- **A `hidden` module is unreachable even with a grant.** The guard checks the
  module's status as well as the grant. Hiding is how a module is taken out of
  service without deleting anyone's grant.
- **Grants are not seeded and not migrated.** They are per-person decisions,
  and a migration must not name a person (`docs/05-database-and-sources.md`,
  *What a migration must not contain*). After a deploy, a new module has zero
  grants in production until an admin acts.

So the full path from "merged" to "a person sees it" is: migration applied by
the deploy → row exists → admin opens `/admin`, finds the employee, turns the
module on → the employee's next page load shows it in the sidebar.

---

## The guard, and what it cannot do

`tests/module-registry.test.ts` runs in the suite and in CI. It drives the real
migration file against the real test database in both states (seed-populated:
nothing changes; empty: both rows appear with the seed's values), and it walks
every directory under `app/(modules)/` and fails — naming the key and this
document — if the key is missing from `prisma/seed.ts` or from every
migration. `change-orders` and `bas` are allowed through without a migration
because they were seeded on production by hand; that allowlist is two entries
long and the test asserts it stays that way.

It cannot check that the migration **ran** on production. Only section 5 does
that.
