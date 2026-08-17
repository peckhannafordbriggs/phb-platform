# Infrastructure

Bicep for the production deployment. Deployed at **resource group scope**, so the
subscription and resource group are chosen on the command line rather than written
down here.

Nothing in this directory assumes anything about PH+B. Every value that identifies an
organisation, region, person or environment is a parameter without a default.

## Files

| File | What |
|---|---|
| `main.bicep` | Every resource |
| `main.parameters.example.json` | Placeholder values. Copy to `main.parameters.json`, which is gitignored |

## Validate without an Azure subscription

Compiling is not deploying and needs no credentials. CI runs both on every push:

```bash
az bicep install
az bicep build --file infra/main.bicep --stdout > /dev/null
az bicep lint --file infra/main.bicep
```

## Deploy

```bash
cp infra/main.parameters.example.json infra/main.parameters.json
# fill it in, then:

az deployment group create \
  --subscription <subscription-id> \
  --resource-group <resource-group> \
  --template-file infra/main.bicep \
  --parameters @infra/main.parameters.json \
  --parameters postgresAdminPassword="$PGPASSWORD" authSecret="$(npx auth secret --raw)"
```

The two `@secure()` parameters are passed on the command line and never written to a
file. Azure does not log the value of a secure parameter.

**`Contributor` on the resource group is required.** It is the permission most often
forgotten when a subscription is created, and without it every command above fails
after the parameters have been filled in.

## What gets created

- Log Analytics workspace — Container Apps requires one
- Container Apps managed environment and container app
- Azure Container Registry (Basic)
- Key Vault (RBAC authorization)
- PostgreSQL Flexible Server, plus the application database
- User-assigned managed identity, with `AcrPull` on the registry and
  `Key Vault Secrets User` on the vault
- Optionally a resource-group budget (`enableBudget`, off by default)

## Three things that are deliberate

**The database collation is set explicitly to `en_US.utf8`.** Every department and
position list is `ORDER BY name ASC`, so the ordering belongs to the database. `C` or
`POSIX` compares raw bytes and sorts `AI` before `Administrative`. It is also the
Flexible Server default — set anyway, because a default can change and this cannot be
corrected later without a dump and restore. See the collation section of
`docs/runbook.md`.

**The identity is user-assigned, not system-assigned.** It has to exist before the
container app so IT can bind a federated identity credential to it, and because
`CLAUDE.md` prohibition 6 forbids binding anything to an individual.

**`GRAPH_CLIENT_SECRET` is not defined at all.** Production authenticates to Graph with
the managed identity and a federated credential. `createGraphCredential` throws if a
secret is present with `NODE_ENV=production` — a test asserts the Bicep does not supply
one either.

## First deployment ordering

The container app needs an image and its secrets before it can start, and its own URL
before Auth.js can build a callback. So the first pass is not a single command:

1. Deploy with `containerImage` left at its default. It points at a public placeholder
   image, so the app comes up before the registry has anything in it.
2. Take `containerAppUrl` from the outputs, and redeploy with `authUrl` set to it.
3. Give IT the `ssoRedirectUri` output and the `managedIdentityClientId` output — the
   redirect URI goes on the SSO app registration, and the federated credential is bound
   to that identity. Neither can be requested before this deployment exists.
4. Push to `main`. CI builds the real image, runs migrations, and deploys it.
5. Run the production seed **once**, by hand. See `docs/runbook.md`.
