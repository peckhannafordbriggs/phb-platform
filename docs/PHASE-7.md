# Phase 7 — Deploy to Production

Read `CLAUDE.md` first. `docs/06-roadmap.md` Phase 7 has the production requirements.

---

## Goal

The platform runs in Azure, reachable at a URL, deployed from CI rather than a personal
machine. All four bootstrap admins can sign in.

## Subscription status

The Azure subscription is being requested. It is **not** available yet.

Part A needs nothing from Azure. Part B is provisioning and first deploy.

**Do not hardcode subscription IDs, resource group names, regions, or resource names
anywhere.** They are inputs. Part A should be complete and reviewable with none of them
known.

---

## Part A — buildable now

### 1. Containerize

- `output: 'standalone'` in `next.config.ts`
- Multi-stage `Dockerfile`: dependencies → build → minimal runtime
- Runs as a non-root user
- `.dockerignore` covering `node_modules`, `.git`, `.env*`, test files, `docs`

**Prisma in a container is the classic failure here.** The query engine is a native
binary and must match the container's libc — a Debian-built engine on Alpine fails at
runtime, not at build time, with an unhelpful error. Set `binaryTargets` explicitly to
match whichever base image you choose, and make sure `openssl` is present in the
runtime stage.

Verify the container actually runs against your local Postgres before moving on. A
Dockerfile that builds but doesn't boot is worth nothing.

### 2. Infrastructure as code

Bicep, in `infra/`. Parameterized — subscription, resource group, region, and resource
names are all parameters with no defaults that assume PH+B specifics.

Resources:

- Container Apps environment + container app
- Azure Database for PostgreSQL Flexible Server
- Azure Container Registry (Basic)
- Key Vault
- Log Analytics workspace (Container Apps requires one)
- User-assigned managed identity, with role assignments for ACR pull and Key Vault
  secret read

**The database must be created with a collation that sorts case-insensitively** —
`en_US.utf8`, the Flexible Server default. `C` or `POSIX` sorts `AI` before
`Administrative` and puts every department and position list in the wrong order.
Set it explicitly in the Bicep rather than relying on the default, and see the collation
section in `runbook.md`.

Scale to zero is fine for this user count. Set a budget alert.

### 3. CI workflow

GitHub Actions, in `.github/workflows/`:

- **On every push and PR:** install, typecheck, lint, test against a Postgres service
  container, build.
- **On push to main:** build the image, push to ACR, deploy the container app.

The deploy job must be structured so it's inert until the Azure secrets exist — skipped
cleanly rather than failing red on every push between now and provisioning.

Authenticate to Azure with OIDC federated credentials, not a service principal secret.
Nothing that expires.

### 4. Migrations and seeding on deploy

Decide and document how `prisma migrate deploy` runs against production — a pre-deploy
step in CI is simplest. It must not run automatically on container start, or every
replica races.

The production seed runs **once**, manually, on first deploy. `npm run seed:dev` must be
impossible to run against production — verify the existing guard.

### 5. Production configuration

Inventory every environment variable and where it lives — Key Vault for secrets,
container app config for the rest. Update `.env.example` with a note on the production
source of each.

Non-negotiable in production:

- `BOOTSTRAP_ADMIN_EMAIL` — all four addresses, comma-separated. **If this is wrong when
  the seed runs, production comes up with zero admins and there is no UI path to fix
  it.**
- `PHB_ALLOW_SEND=false` until sending is verified end to end
- No `GRAPH_CLIENT_SECRET`. Production already refuses to boot with one set; that's
  deliberate
- `ALLOWED_EMAIL_DOMAINS` — confirm the full verified-domain list with IT first

### 6. Health probe

Container Apps needs a liveness/readiness endpoint. Unauthenticated, returns no
information about the system beyond up/down. Do not reuse the mailbox health endpoint —
that one is grant-gated and reports configuration state.

### 7. Runbook

Entries for: a failed deploy, a failed migration on deploy, the app up but the database
unreachable, zero admins after seeding, and the collation check.

---

## Part B — once the subscription exists

Needs: subscription ID, resource group name, region, and **Contributor access on the
resource group**. Without the last one nothing can be deployed, and it's the one most
often forgotten when a subscription is created.

1. Deploy the infrastructure. Verify the database collation with actual values, not by
   reading the collation name.
2. Secrets into Key Vault.
3. **Second IT request:** a federated identity credential on the SSO app registration,
   bound to the managed identity — which has to exist first, so this can't be bundled
   with the original request. Also add the production redirect URI:
   `https://<production-url>/api/auth/callback/microsoft-entra-id`
4. First deploy. Run migrations, then the production seed once.
5. Confirm four employee rows with `is_platform_admin = true` and `entra_oid` null.
6. Sign in on the production URL, complete onboarding, reach the admin screen.
7. Budget alert. Confirm the URL is reachable only by tenant accounts.

---

## Out of scope

Custom domain names. Staging environments. Autoscaling beyond scale-to-zero.
Multi-region. Anything Graph or mail related. Any Phase 5 UI.

---

## Acceptance criteria

**Part A**

- [ ] `docker build` succeeds and the container boots against local Postgres
- [ ] All 235 tests, typecheck, lint, and build still pass
- [ ] Bicep validates with placeholder parameters — no PH+B specifics hardcoded
- [ ] Database collation set explicitly in the Bicep
- [ ] CI runs tests on push; the deploy job skips cleanly without Azure secrets
- [ ] Every environment variable documented with its production source
- [ ] Runbook entries written
- [ ] No secret in any committed file

**Part B**

- [ ] Infrastructure deployed, collation verified with actual values
- [ ] CI deploys on push to main
- [ ] Four admin rows exist after seeding
- [ ] All four can sign in and reach the admin screen
- [ ] Budget alert active
