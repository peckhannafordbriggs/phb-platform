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

# The image the app is running NOW. A template deployment replaces the whole
# container app, image included, so it has to be told which image to keep.
IMAGE="$(az containerapp show -n <app> -g <resource-group> \
  --query properties.template.containers[0].image -o tsv)"

az deployment group create \
  --subscription <subscription-id> \
  --resource-group <resource-group> \
  --template-file infra/main.bicep \
  --parameters @infra/main.parameters.json \
  --parameters containerImage="$IMAGE"
```

That is the whole routine command. **The two `@secure()` parameters,
`postgresAdminPassword` and `authSecret`, are omitted on a routine deployment, and
omitting them leaves the existing values untouched** (since 2026-10-21): the database
server keeps its current administrator password, the `DATABASE-URL` vault secret keeps
its current version, and `AUTH-SECRET` keeps its current version. Each parameter
defaults to empty, empty or whitespace means "do not touch", and the template never
sends an empty password or writes an empty secret version - the password property is
left out of the server request altogether and the two secret resources are not
deployed. `tests/deploy-guards.test.ts` → *the two secure parameters are optional, and
omitted means unchanged* pins it both ways.

They are supplied in exactly two situations, and a non-empty value **sets** the value
it names:

```bash
# FIRST deployment only: a server cannot be created without a password, and the
# container app's references to both secrets must resolve.
#
# Or a deliberate ROTATION of one or both. A new postgresAdminPassword rotates the
# server's password and writes a new DATABASE-URL version in the same deployment;
# a new authSecret signs every existing session out. Pass only the one you mean to
# rotate. Read the value in with `read -s` rather than typing it on the line.
az deployment group create \
  ... \
  --parameters containerImage="$IMAGE" \
  --parameters postgresAdminPassword="$PGPASSWORD" authSecret="$(npx auth secret --raw)"
```

Until 2026-10-21 both were required on every deployment and whatever was typed was
set, which is how a value mistyped at the prompt on 2026-10-13 rotated the production
administrator password. See *A template deployment rotated the database administrator
password* in `runbook.md`. The values are passed on the command line and never written
to a file; Azure does not log the value of a secure parameter.

**`containerImage` is required and is never in the parameters file.** Two things write
the container app, and each owns half of it. The deploy workflow runs
`az containerapp update --image`, which sets the image and keeps every other setting
from the running revision - env vars, probes, scale, secrets. A template deployment is
the other way round: it sets every other setting from `main.bicep` and, because a
deployment replaces the whole resource, the image too. So a template deployment has to
carry the running image forward, and the parameter used to default to the public
placeholder instead. The parameters file never set it, and on 2026-10-13 a routine
redeploy (turning the two Key Vault flags on) put the placeholder back: revision
`0000053`, a hello-world listening on `:80` under probes for `:3000`, `ActivationFailed`.
Forgetting the parameter now fails at validation before anything is created, and
`tests/deploy-guards.test.ts` fails the build if a default comes back. See
*A template deployment fails activation* in `runbook.md`.

The corollary matters in the other direction too: **a change to env vars, probes or
scale in `main.bicep` reaches production only through a template deployment.** The
workflow never applies it. The readiness-probe tuning of 2026-09-30 sat in the template
for two weeks while every CI revision kept the old values, until that same redeploy
carried it.

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
az deployment group what-if   --subscription <subscription-id>   --resource-group <resource-group>   --template-file infra/main.bicep   --parameters @infra/main.parameters.json   --parameters containerImage="$IMAGE"
```

With the two secure parameters omitted, what-if shows no change on the server's
password or on either vault secret. If it reports `Microsoft.KeyVault/vaults/secrets`
`DATABASE-URL` or `AUTH-SECRET` as *Modify* or *Create*, a value was passed - stop and
check whether a rotation was intended.

## What gets created

- Log Analytics workspace — Container Apps requires one
- Container Apps managed environment and container app
- Azure Container Registry (Basic)
- Key Vault (RBAC authorization)
- PostgreSQL Flexible Server, plus the application database
- User-assigned managed identity, with `AcrPull` on the registry and
  `Key Vault Secrets User` on the vault
- Optionally a resource-group budget (`enableBudget`, off by default)
- Optionally the Cost Intelligence run worker, a Container Apps Job (`enableCipWorker`,
  off by default and on in production since 2026-10-20; see `runbook.md`, "Cost
  Intelligence worker in Azure")

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

## Four secrets are set by hand, not by the template

Four secrets are issued elsewhere and pasted into the vault once, by a person:
the Anthropic API key (next heading), the Change Orders module's own Anthropic
key (the heading after it), the BAS credential key and the Analyze database
URL. The template knows their names only - `ANTHROPIC-API-KEY`,
`CO-ANTHROPIC-API-KEY`, `BAS-CREDENTIAL-KEY` and `BAS-ASK-DATABASE-URL` - and
references each from the container app behind a boolean parameter. All four
are read under the managed identity's existing **Key Vault Secrets User**
grant on the vault; no new role assignment is needed, and
`tests/deploy-guards.test.ts` asserts that from the template's grants.

All four exist in the production vault as of 2026-10-21, and the first three
flags are on; `coAnthropicApiKeyInKeyVault` stays false until Phase 12 Part D
reads the key. `runbook.md` → *Secrets set by hand in Key Vault* carries the
dated status, and the commands below are for re-setting or rotating one.

## The Anthropic API key is set by hand, not by the template

`DATABASE-URL` and `AUTH-SECRET` are written into Key Vault by the template from
secure parameters, on the deployment that supplies them - the first one, and a
deliberate rotation; a deployment that omits them leaves both alone (see *Deploy*).
The Anthropic API key is different: it is issued once by the Anthropic Console, and
the person holding it puts it in the vault themselves. The template never sees the value - it knows only
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

## The Change Orders Anthropic key is a second key, set the same way

`CO_ANTHROPIC_API_KEY` is the Change Orders module's **own** Anthropic API key
(2026-10-16): a second key, issued separately in the Anthropic Console, so the
change-order pipeline and BAS Analyze are billed, rate-limited and revoked
independently of each other. It is wired exactly like the key above - Key Vault
`CO-ANTHROPIC-API-KEY`, referenced from the container app as
`CO_ANTHROPIC_API_KEY` when `coAnthropicApiKeyInKeyVault` is true - and it is
deliberately **not** the SDK's default variable name, because a client built
without an explicit key would otherwise read the BAS key silently
(`runbook.md` → *The Change Orders Anthropic key, the same way*). Nothing reads
it until Phase 12 Part D is built, so the flag stays false until then - the
secret itself is already in the production vault, parked; absent,
it disables those calls and nothing else.

```powershell
# 1. Same vault as above.
# 2. Set the secret. A DIFFERENT key from ANTHROPIC-API-KEY - create one in the
#    Anthropic Console for the change-order pipeline. Read-Host keeps it out of
#    the command line and the shell history.
az keyvault secret set --vault-name <vault-name> --name CO-ANTHROPIC-API-KEY --value (Read-Host "Change Orders Anthropic API key")

# 3. Confirm it exists WITHOUT printing it.
az keyvault secret show --vault-name <vault-name> --name CO-ANTHROPIC-API-KEY --query "{enabled:attributes.enabled, updated:attributes.updated}"

# 4. Set coAnthropicApiKeyInKeyVault to true in infra/main.parameters.json and redeploy.
```

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

## The Analyze database URL is the bas_analyze role on this server

`BAS_ASK_DATABASE_URL` is the connection URL the Analyze tab's SQL runs through:
a separate, read-only PostgreSQL role, `bas_analyze`, on the **same** server and
database as the platform. It is not `DATABASE_URL`, which can write. The role is
created by `scripts/setup-bas-analyze-role.sql`, run as the server administrator
with a password you choose at run time (the file's header has the exact command,
including how to do it from the portal's Cloud Shell when you are off the office
network), and the URL is then built by hand and pasted into the vault once.

```powershell
# 1. Create or rotate the role on the Azure database (see the script's header;
#    it prompts for nothing itself - you pass the password as -v pw=...). It
#    prints the URL shape at the end and the password nowhere.

# 2. Same vault as above. Set the secret from the URL you built:
#      postgresql://bas_analyze:<password>@<server>.postgres.database.azure.com:5432/phb_platform?sslmode=require
#    Read-Host keeps it out of the command line and the shell history.
az keyvault secret set --vault-name <vault-name> --name BAS-ASK-DATABASE-URL --value (Read-Host "BAS_ASK_DATABASE_URL for the bas_analyze role")

# 3. Confirm it exists WITHOUT printing it.
az keyvault secret show --vault-name <vault-name> --name BAS-ASK-DATABASE-URL --query "{enabled:attributes.enabled, updated:attributes.updated}"

# 4. Set basAskDatabaseUrlInKeyVault to true in infra/main.parameters.json and
#    redeploy - with the RUNNING image, as under *Deploy*.
```

To confirm it works on the deployed site: `/bas/analyze` shows the *Things people
ask* chips instead of *Analyze is not configured on this server*, and one real
question - "When did the collector last run, and did it succeed?" - comes back as
an answer with its evidence panel. A *permission denied* answer means the role
is missing a grant: `runbook.md` → *Analyze answers "permission denied" for every
question*. To rotate, run the script again with a new password, set the secret
again, and create a new revision.

## First deployment ordering

The container app needs an image and its secrets before it can start, and its own URL
before Auth.js can build a callback. So the first pass is not a single command:

1. Deploy with `containerImage=mcr.microsoft.com/k8se/quickstart:latest`, passed
   explicitly on the command line. That public placeholder lets the app resource exist
   before the registry has anything in it. It listens on `:80`, not `:3000`, so its
   revision never passes the probes - expected on this one pass and a fault on any
   other. This is the only time the placeholder is ever passed.
2. Take `containerAppUrl` from the outputs, and redeploy with `authUrl` set to it (still
   the placeholder image: nothing else exists yet).
3. Give IT the `ssoRedirectUri` output and the `managedIdentityClientId` output — the
   redirect URI goes on the SSO app registration, and the federated credential is bound
   to that identity. Neither can be requested before this deployment exists.
4. Push to `main`. CI builds the real image, runs migrations, and deploys it.
5. Run the production seed **once**, by hand. See `runbook.md`.
6. Set the hand-set secrets as above - `BAS-CREDENTIAL-KEY` from the collector's
   `.env`, `ANTHROPIC-API-KEY` from the Anthropic Console, `BAS-ASK-DATABASE-URL` from
   the `bas_analyze` role the script creates - then redeploy with
   `basCredentialKeyInKeyVault=true`, `anthropicApiKeyInKeyVault=true` and
   `basAskDatabaseUrlInKeyVault=true`. Nothing before this step needs any of them.
   `CO-ANTHROPIC-API-KEY` and `coAnthropicApiKeyInKeyVault=true` join this step
   once Phase 12 Part D gives the change-order pipeline something to call with it.
   From here on every redeploy passes the **running** image, read with the
   `az containerapp show` line under *Deploy* - step 4 has put a real one there, and
   the placeholder must never come back.
