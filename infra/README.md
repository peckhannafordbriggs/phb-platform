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

**`Contributor` on the resource group is NOT sufficient.** Verified against a real
subscription, not inferred from the role name. Two things in this template are outside
it:

- **Resource provider registration** is a subscription-scoped action. On a new
  subscription all six providers this template needs are `NotRegistered`, and an RG
  Contributor gets `AuthorizationFailed` on `.../register/action`. Someone with
  subscription scope has to do it once.
- **The two role assignments** (`AcrPull`, `Key Vault Secrets User`) need
  `Microsoft.Authorization/roleAssignments/write`, which is in Contributor's
  `notActions`. `az deployment group what-if` reports this before creating anything.

So the deploying principal needs `User Access Administrator` (or `Owner`) **on the
resource group**, plus that one-off provider registration. The full detail, the exact
error text, and the two grant options are under *Deploying to Azure (Phase 7 Part B)* in
`runbook.md`.

Run `what-if` first — it catches both without creating anything:

```bash
az deployment group what-if   --subscription <subscription-id>   --resource-group <resource-group>   --template-file infra/main.bicep   --parameters @infra/main.parameters.json   --parameters postgresAdminPassword="$PGPASSWORD" authSecret="$AUTH_SECRET"
```

## What gets created

- Log Analytics workspace — Container Apps requires one
- Container Apps managed environment and container app
- Azure Container Registry (Basic)
- Key Vault (RBAC authorization)
- PostgreSQL Flexible Server, plus the application database
- User-assigned managed identity, with `AcrPull` on the registry and
  `Key Vault Secrets User` on the vault
- Optionally a resource-group budget (`enableBudget`, off by default)

## Four things that are deliberate

**The database collation is set explicitly to `en_US.utf8`.** Every department and
position list is `ORDER BY name ASC`, so the ordering belongs to the database. `C` or
`POSIX` compares raw bytes and sorts `AI` before `Administrative`. It is also the
Flexible Server default — set anyway, because a default can change and this cannot be
corrected later without a dump and restore. See the collation section of
`runbook.md`.

**The identity is user-assigned, not system-assigned.** It has to exist before the
container app so IT can bind a federated identity credential to it, and because
`CLAUDE.md` prohibition 6 forbids binding anything to an individual.

**`GRAPH_CLIENT_SECRET` is not defined at all.** Production authenticates to Graph with
the managed identity and a federated credential. `createGraphCredential` throws if a
secret is present with `NODE_ENV=production` — a test asserts the Bicep does not supply
one either.

**The database has no auto-stop, and the budget cannot stop anything.** The container app
scales to zero freely; the database must not, because the BAS collector's source data
rolls off the JACE after about 42 hours. PostgreSQL Flexible Server has no auto-stop
property to disable — only a manual `stop` — so the reachable failure is a full disk,
which makes the server refuse writes. `postgresStorageAutoGrow` is the guard: Azure
defaults it to `Disabled` and this template defaults it to `Enabled`, because the
failure it prevents destroys data held nowhere else while the cost of a larger disk is
recoverable. The budget carries notification contacts only and no action group, so no
spending threshold can stop the server.

## Two secrets are set by hand, not by the template

Two secrets are issued elsewhere and pasted into the vault once, by a person:
the Anthropic API key (next heading) and the BAS credential key (the heading
after it). The template knows their names only - `ANTHROPIC-API-KEY` and
`BAS-CREDENTIAL-KEY` - and references each from the container app behind a
boolean parameter. Both are read under the managed identity's existing **Key
Vault Secrets User** grant on the vault; no new role assignment is needed, and
`tests/deploy-guards.test.ts` asserts that from the template's grants.

## The Anthropic API key is set by hand, not by the template

`DATABASE-URL` and `AUTH-SECRET` are written into Key Vault by the template from
secure parameters, because both are generated at deploy time. The Anthropic API key
is different: it is issued once by the Anthropic Console, and the person holding it
puts it in the vault themselves. The template never sees the value - it knows only
the name, `ANTHROPIC-API-KEY`, and references it from the container app as the
`ANTHROPIC_API_KEY` environment variable when `anthropicApiKeyInKeyVault` is true.

Order matters. Container Apps resolves every Key Vault reference when it creates a
revision, so the secret has to exist before the parameter is turned on.

```powershell
# 1. Find the vault. Its name carries a hash suffix, so read it rather than guess it.
az keyvault list --resource-group <resource-group> --query "[].name" -o tsv

# 2. Set the secret. Read-Host keeps the key out of the command line and the
#    shell history; it is echoed to the screen, so do this at your own desk.
az keyvault secret set --vault-name <vault-name> --name ANTHROPIC-API-KEY --value (Read-Host "Anthropic API key")

# 3. Confirm it exists WITHOUT printing it.
az keyvault secret show --vault-name <vault-name> --name ANTHROPIC-API-KEY --query "{enabled:attributes.enabled, updated:attributes.updated}"

# 4. Set anthropicApiKeyInKeyVault to true in infra/main.parameters.json and redeploy.
```

The vault uses RBAC, so setting a secret needs **Key Vault Secrets Officer** on the
vault. `Contributor` and `Owner` on the resource group are management-plane roles
and do not grant it - expect `ForbiddenByRbac` without it, the same shape as the
three permission walls under *Deploying to Azure* in `runbook.md`.

The key does not expire, which is what prohibition 7 requires; it can be revoked in
the Anthropic Console. To rotate, run step 2 again with the new key - a new version
of the same secret - and create a new revision so the app picks it up.

## The BAS credential key is copied from the collector, byte for byte

`BAS_CREDENTIAL_KEY` is the AES-256 key that encrypts Niagara station passwords in
`bas_station_credentials`. It is **not generated for Azure**: every stored credential
was encrypted on the office PC under the collector's key, and the collector keeps
using that key wherever it runs. The value in the vault must be the value in the
collector's `.env` on the office PC, byte for byte - one character out and every
stored credential is unreadable ciphertext (`runbook.md` → *The BAS credential key,
the same way*). `BAS_CREDENTIAL_KEY_VERSION` is not a secret; it is the
`basCredentialKeyVersion` parameter, default `"1"`, which is what the office PC's rows
carry.

```powershell
# 1. Same vault as above.
# 2. Set the secret from the collector's .env. Read-Host keeps it out of the
#    command line and the shell history.
az keyvault secret set --vault-name <vault-name> --name BAS-CREDENTIAL-KEY --value (Read-Host "BAS_CREDENTIAL_KEY, exactly as in the collector .env")

# 3. Confirm it exists WITHOUT printing it. A 32-byte key is 44 base64
#    characters; a different length is a truncated or padded paste.
az keyvault secret show --vault-name <vault-name> --name BAS-CREDENTIAL-KEY --query "{enabled:attributes.enabled, updated:attributes.updated, length:length(value)}"

# 4. Set basCredentialKeyInKeyVault to true in infra/main.parameters.json and redeploy.
```

To confirm it works on the deployed site: Settings → a station that has a stored
login → the login panel shows the username and *password set* rather than
`decrypt_failed` or *not configured*, and *Replace* is offered. Do not re-enter a
password to make a red panel go green - that re-encrypts it under whatever key the
container has, and if that key is wrong the collector can no longer read it.

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
5. Run the production seed **once**, by hand. See `runbook.md`.
6. Set the two hand-set secrets as above - `BAS-CREDENTIAL-KEY` from the collector's
   `.env`, `ANTHROPIC-API-KEY` from the Anthropic Console - then redeploy with
   `basCredentialKeyInKeyVault=true` and `anthropicApiKeyInKeyVault=true`. Nothing
   before this step needs either.
