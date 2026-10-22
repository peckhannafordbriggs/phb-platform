// PHB Platform - production infrastructure.
//
// Deployed at RESOURCE GROUP scope. The subscription and resource group are
// therefore chosen on the command line, not written down here:
//
//   az deployment group create \
//     --subscription <subscription-id> \
//     --resource-group <resource-group> \
//     --template-file infra/main.bicep \
//     --parameters @infra/main.parameters.json \
//     --parameters containerImage="$IMAGE"   # the image the app runs NOW; see containerImage
//
// Nothing in this file assumes anything about PH+B. Every value that identifies
// an organisation, a region, a person or an environment is a parameter without a
// default. `az bicep build --file infra/main.bicep` should be run before any
// deployment - see infra/README.md.

targetScope = 'resourceGroup'

// ---------------------------------------------------------------------------
// Naming and placement
// ---------------------------------------------------------------------------

@description('Azure region for every resource. No default: the right region is a decision about where the data lives.')
param location string

@minLength(3)
@maxLength(11)
@description('Short lowercase prefix for generated resource names, e.g. "phbplat". Kept short because a registry name is capped at 50 characters and has a uniqueness suffix appended.')
param namePrefix string

@description('Environment discriminator that becomes part of every resource name, e.g. "prod".')
param environmentName string

// Globally-unique names (registry, key vault, database server) need a suffix
// that is stable for a given resource group but not guessable across tenants.
var uniqueSuffix = take(uniqueString(resourceGroup().id), 6)
var baseName = toLower('${namePrefix}-${environmentName}')

var logAnalyticsName = '${baseName}-logs'
var managedEnvironmentName = '${baseName}-env'
var containerAppName = '${baseName}-app'
var identityName = '${baseName}-identity'
// Registry names are alphanumeric only.
var registryName = toLower(replace('${namePrefix}${environmentName}${uniqueSuffix}', '-', ''))
var keyVaultName = take('${baseName}-kv-${uniqueSuffix}', 24)
var postgresServerName = '${baseName}-pg-${uniqueSuffix}'

@description('Tags applied to every resource. Cost centre, owner group, and so on.')
param tags object = {}

// ---------------------------------------------------------------------------
// Container image
// ---------------------------------------------------------------------------

// NO DEFAULT, deliberately. Two things write this container app and each owns
// half of it: the deploy workflow (`az containerapp update --image`) sets the
// image and keeps everything else from the running revision, while a template
// deployment sets everything else and - because a deployment replaces the
// whole resource - the image too. This used to default to the public
// placeholder `mcr.microsoft.com/k8se/quickstart:latest`, and the parameters
// file never set it, so every routine template deployment after the first real
// deploy silently put the placeholder back. On 2026-10-13 that produced
// revision 0000053: a hello-world listening on :80 under probes for :3000,
// ActivationFailed, with the console log reading "Listening on :80..." - the
// placeholder's own line; Next prints "Ready in", never that. Making it
// required means a deployment that forgets it fails at parameter validation,
// before anything is created. Read the running image first:
//
//   az containerapp show -n <app> -g <rg> \
//     --query properties.template.containers[0].image -o tsv
//
// Only the very first deployment, when the registry is empty, passes the
// placeholder - explicitly, on the command line. infra/README.md has both
// commands; runbook.md -> "A template deployment fails activation".
@description('Image the container app runs. Required. Pass the image the app is running now (read it with `az containerapp show`), or the public placeholder on the very first deployment only.')
param containerImage string

// The image's own default. The Dockerfile sets PORT=3000 and EXPOSE 3000, the
// template does NOT set a PORT environment variable, and this one parameter
// feeds the ingress target port and both probes - so the image decides where
// the process listens and the template decides where the platform looks, and
// tests/deploy-guards.test.ts holds the two numbers equal. Do not add a PORT
// env entry below: the workflow path would carry it forward and the Dockerfile
// would stop being the single place the port is decided.
@description('Port the application listens on. Must equal PORT and EXPOSE in the Dockerfile; a test asserts it.')
param containerPort int = 3000

@description('CPU cores per replica. 0.5 with 1Gi is the smallest Container Apps combination that is not memory starved for a Node server.')
param containerCpu string = '0.5'

@description('Memory per replica.')
param containerMemory string = '1Gi'

@description('Scale to zero is deliberate at this user count - a cold start is cheaper than a replica idling all night.')
param minReplicas int = 0

@description('Upper bound on replicas. Small on purpose: Graph throttling concentrates on one mailbox through one app identity.')
param maxReplicas int = 3

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

@description('PostgreSQL major version.')
param postgresVersion string = '17'

@description('Flexible Server SKU name, e.g. Standard_B1ms.')
param postgresSkuName string

@description('Flexible Server tier: Burstable, GeneralPurpose or MemoryOptimized.')
@allowed([
  'Burstable'
  'GeneralPurpose'
  'MemoryOptimized'
])
param postgresSkuTier string

@description('Provisioned storage in GB.')
param postgresStorageGb int = 32

@description('Grow storage automatically when it approaches full. Defaults to Enabled, which is NOT the Azure default - a full disk makes the server refuse writes, which for this deployment is indistinguishable from the server being down. See the note above the resource before turning it off.')
@allowed([
  'Enabled'
  'Disabled'
])
param postgresStorageAutoGrow string = 'Enabled'

// Point-in-time retention is a parameter so that a template deployment cannot
// quietly reset a value somebody raised in the portal - the same drift that
// put the placeholder image back on 2026-10-13. The default is what the live
// server held when this was parameterised (7, read with `az postgres
// flexible-server show` on 2026-10-21). These backups live WITH the server and
// are lost with it; the nightly dump job below is the copy that is not.
@minValue(7)
@maxValue(35)
@description('Days of point-in-time restore the server keeps. Read the live value before a deployment and pass it; a lower number here shortens production\'s restore window on the next deployment.')
param postgresBackupRetentionDays int = 7

@description('Administrator login for the database server. Not an email address, and not a person.')
param postgresAdminUsername string

// The two @secure() parameters below are OPTIONAL, and omitting one changes
// nothing (2026-10-21). Until then both were required on every deployment and
// whatever was typed was SET: on 2026-10-13 a value mistyped at the prompt
// rotated the production administrator password. Empty - the default - means
// "leave the existing value untouched": the server keeps its current password
// and DATABASE-URL keeps its current version; the session secret keeps its
// current version. Non-empty behaves as it always did. The decision is made
// ONCE, in the two `set…` variables below, and every use of either parameter
// is behind its variable, so an empty default can never set an empty password
// or create an empty secret version. See infra/README.md -> Deploy.
@secure()
@description('Administrator password. Optional: leave empty (the default) and the server keeps its current password and the DATABASE-URL secret keeps its current version. Required on the FIRST deployment, because a server cannot be created without one, and supplied again only when you mean to rotate it - a non-empty value SETS the password. Never commit it.')
param postgresAdminPassword string = ''

@description('Application database name.')
param databaseName string = 'phb_platform'

// ---------------------------------------------------------------------------
// Application configuration
// ---------------------------------------------------------------------------

@description('Comma-separated verified email domains permitted to sign in. Confirm the full list with IT.')
param allowedEmailDomains string

@description('Comma-separated bootstrap administrator addresses. If this is wrong when the seed runs, production comes up with zero admins and there is no UI path to fix it.')
param bootstrapAdminEmails string

@description('Public URL of the deployed app, used by Auth.js to build callback URLs. Leave empty on the first deployment - the URL does not exist until the container app does - then redeploy with it set.')
param authUrl string = ''

@secure()
@description('Auth.js session secret. Optional: leave empty (the default) and the AUTH-SECRET vault secret keeps its current version. Required on the first deployment (the container app references the secret and the reference must resolve), and supplied again only to rotate it, which signs every existing session out. Generate with `npx auth secret`.')
param authSecret string = ''

// ---------------------------------------------------------------------------
// Custom domain (2026-10-21)
// ---------------------------------------------------------------------------
//
// The app's own address (<app>.<env-suffix>.azurecontainerapps.io) always
// works and nothing here replaces it; a custom hostname is ADDED beside it,
// with a free Azure managed certificate issued on the environment. Two DNS
// records have to exist before the hostname is set, and both are checked by
// Azure when the certificate is issued:
//
//   CNAME  <hostname>        -> <app>.<env-suffix>.azurecontainerapps.io
//   TXT    asuid.<hostname>  -> the environment's customDomainVerificationId
//                               (a public UUID-like value, not a secret)
//
// A managed certificate cannot be issued for a hostname the app does not yet
// carry, and the app cannot bind a certificate that does not yet exist. So the
// FIRST deployment with customDomainName set runs with customDomainBound=false
// on the command line (hostname added, certificate issued), and every one after
// it runs with the default, true (hostname bound to the certificate). The
// default is true so that the parameters file never needs to carry the
// binding and a routine redeploy cannot drop it - exactly the placeholder-image
// rule above, in the other direction. authUrl is NOT changed by any of this:
// sign-in keeps building its callback on whatever authUrl says until the SSO
// app registration carries the new redirect URI as well.

@description('Custom hostname for the container app, e.g. "platform.example.com". Empty (the default) attaches no custom domain. Before setting it, the CNAME and the asuid TXT record described above must be live. The azurecontainerapps.io address the app already has keeps working beside it.')
param customDomainName string = ''

@description('Whether the custom hostname is bound to its managed certificate. Pass false ONLY on the first deployment that sets customDomainName: that pass adds the hostname and issues the certificate, which cannot be bound until it exists. Every later deployment leaves this at its default, true. Never write it into the parameters file.')
param customDomainBound bool = true

// Whitespace counts as empty: a stray space at a prompt must not become the
// administrator password. These two variables are the ONLY place the
// "was a value supplied" decision is made; every use of either secure
// parameter below is conditional on one of them.
var setPostgresAdminPassword = !empty(trim(postgresAdminPassword))
var setAuthSecret = !empty(trim(authSecret))

@description('Client ID of the SSO app registration. Not a secret; it appears in every authorization URL.')
param ssoClientId string

@description('Entra tenant ID. Not a secret.')
param ssoTenantId string

@description('Client ID of the Graph app registration. Empty until IT creates it; the mailbox module reports itself unconfigured until then.')
param graphClientId string = ''

@description('Graph app registration tenant ID.')
param graphTenantId string = ''

@description('Mailbox the Change Orders module may touch.')
param coMailbox string = ''

@description('Set to true once the Anthropic API key exists in Key Vault as ANTHROPIC-API-KEY - placed there by hand with `az keyvault secret set`, never as a template parameter. The container app then reads it by reference. Leave false until the secret exists: Container Apps resolves every Key Vault reference when it creates the revision, and a reference to a secret that is not there fails the whole deployment.')
param anthropicApiKeyInKeyVault bool = false

@description('Set to true once the Change Orders module\'s own Anthropic API key exists in Key Vault as CO-ANTHROPIC-API-KEY - a SECOND key, issued separately in the Anthropic Console so the change-order pipeline is billed, rate-limited and revoked independently of BAS Analyze, placed in the vault by hand, never as a template parameter. Read by the container app as CO_ANTHROPIC_API_KEY (lib/env.ts decides the name); nothing reads it until Phase 12 Part D is built, and absent it disables that and nothing else. Same conditional as the Anthropic key above, for the same reason.')
param coAnthropicApiKeyInKeyVault bool = false

@description('Set to true once the BAS credential key exists in Key Vault as BAS-CREDENTIAL-KEY - the 32-byte base64 AES key that encrypts Niagara station passwords in bas_station_credentials, placed there by hand, never as a template parameter. It MUST be byte-identical to the BAS_CREDENTIAL_KEY in the .env of the collector on the office PC: every stored credential was encrypted under that key, and a different one turns them all into unreadable ciphertext. Same conditional as the Anthropic key, for the same reason.')
param basCredentialKeyInKeyVault bool = false

@description('BAS_CREDENTIAL_KEY_VERSION: the integer stamped on a credential row when a password is saved, so a key rotation does not need a flag day. Not a secret - a plain value. 1 is the version the key on the office PC carries and the default in the code; change it only when introducing a new key, together with the secret above.')
param basCredentialKeyVersion string = '1'

@description('Set to true once the Analyze database URL exists in Key Vault as BAS-ASK-DATABASE-URL - the connection URL of the bas_analyze role on THIS server (scripts/setup-bas-analyze-role.sql creates the role and the operator chooses its password at run time), placed in the vault by hand, never as a template parameter. Read by the container app as BAS_ASK_DATABASE_URL; absent, the Analyze tab says it is not configured and nothing else changes. Same conditional as the two secrets above, for the same reason.')
param basAskDatabaseUrlInKeyVault bool = false

// ---------------------------------------------------------------------------
// Cost Intelligence
// ---------------------------------------------------------------------------

@description('Create the Cost Intelligence run worker job. Off until the ANTHROPIC-API-KEY-CIP secret exists in the vault - the job cannot be created without it. See runbook.md, "Cost Intelligence worker in Azure".')
param enableCipWorker bool = false

@description('Worker image. Required when enableCipWorker is true: the image the job runs now (`az containerapp job show`), or on first enable a cip-worker image built with `az acr build`. No placeholder default, so a redeploy cannot reset it.')
param cipWorkerImage string = ''

@description('Tenant ID of the CIP app registration (SharePoint access). Not a secret.')
param cipAppTenantId string = ''

@description('Client ID of the CIP app registration. Production signs in as it with the managed identity and a federated credential; no secret.')
param cipAppClientId string = ''

@description('SharePoint skills folder, as ids:<driveId>/<itemId>.')
param cipSharePointSkillsFolder string = ''

@description('SharePoint BID-DOC folder, as ids:<driveId>/<itemId>.')
param cipSharePointProjectsFolder string = ''

// Change Orders → Needs Review (2026-10-21). A third app registration,
// phb-platform-co-review, read-only on the automation's _needs_review folder
// through Files.SelectedOperations.Selected - never the mail app, whose
// mailbox fence is load-bearing, and never a secret: production signs in as
// it with the managed identity and a federated credential, as the CIP app
// does. All three values are identifiers, not secrets. Blank leaves the
// Needs Review tab reporting itself not configured and nothing else changes.
@description('Tenant ID of the phb-platform-co-review app registration. Not a secret.')
param coReviewAppTenantId string = ''

@description('Client ID of the phb-platform-co-review app registration. Production signs in as it with the managed identity and a federated credential; no secret.')
param coReviewAppClientId string = ''

@description('The _needs_review folder, as ids:<driveId>/<itemId> or its browser URL.')
param coReviewSharePointFolder string = ''

@description('Model the skills run on. Empty means the default in lib/modules/cost-intelligence/runs.ts.')
param cipRunModel string = ''

// ---------------------------------------------------------------------------
// Nightly database backup
// ---------------------------------------------------------------------------

@description('Create the nightly database backup: a storage account with a blob container, a 90-day lifecycle rule, and a scheduled Container Apps Job that runs pg_dump and uploads the dump as the managed identity. Off by default so a fresh deployment is not refused on an image that is not in the registry yet - build it first (infra/README.md), then turn this on. See runbook.md, "Nightly database backup".')
param enableDbBackup bool = false

// Container Apps evaluates this in UTC and there is no time-zone setting on a
// job, so a fixed local time does not exist: 08:30 UTC is 03:30 in New York
// under standard time and 04:30 under daylight time. Either is the quiet part
// of the night for a building-automation database.
@description('When the backup runs, as a cron expression in UTC. The default is 08:30 UTC: 03:30 America/New_York in winter, 04:30 in summer.')
param dbBackupCron string = '30 8 * * *'

@minValue(1)
@description('Days a dump is kept in blob storage before the lifecycle rule deletes it.')
param dbBackupRetentionDays int = 90

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

@description('Create a resource-group budget. Off by default so a deployment cannot fail on a missing contact address.')
param enableBudget bool = false

@description('Monthly budget amount in the billing currency.')
param budgetAmount int = 50

@description('Addresses notified when the budget thresholds are crossed. Required when enableBudget is true.')
param budgetContactEmails array = []

@description('First day of the budget period, YYYY-MM-01. Azure rejects a start date in the past.')
param budgetStartDate string = ''

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: logAnalyticsName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

// ---------------------------------------------------------------------------
// Identity
//
// One user-assigned identity, used for three things: pulling from the registry,
// reading secrets from Key Vault, and - in a later phase - federating to the
// Graph app registration. User-assigned rather than system-assigned because it
// has to exist before the container app does, so IT can bind a federated
// credential to it. CLAUDE.md prohibition 6: never bind anything to a person.
// ---------------------------------------------------------------------------

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
  tags: tags
}

// ---------------------------------------------------------------------------
// Container registry
// ---------------------------------------------------------------------------

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    // The identity pulls with Entra credentials. Admin user is a shared
    // username and password that cannot be attributed to anyone.
    adminUserEnabled: false
  }
}

// AcrPull, by role definition GUID. The name must be deterministic for the
// assignment to be idempotent across redeployments.
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, identity.id, acrPullRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------------------------------------------------------------------------
// Key Vault
// ---------------------------------------------------------------------------

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    // RBAC rather than access policies: role assignments are visible in the
    // same place as every other permission, and are what the identity below
    // actually uses.
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    // enablePurgeProtection is deliberately not set. Once enabled it cannot be
    // turned off, and a vault name is then unusable for 90 days after deletion -
    // which is exactly what hurts while a first deployment is still being
    // iterated on. Turn it on once the deployment has settled.
    publicNetworkAccess: 'Enabled'
  }
}

// Key Vault Secrets User - read secret values, nothing else.
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource keyVaultRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, identity.id, keyVaultSecretsUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      keyVaultSecretsUserRoleId
    )
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL Flexible Server
// ---------------------------------------------------------------------------

// THIS SERVER MUST NOT STOP ACCEPTING WRITES.
//
// The container app scales to zero freely - a cold start costs a few seconds.
// The database is not equivalent: the BAS collector writes into bas_readings on
// a cadence, and the JACE only retains about 42 hours before the controller
// rolls the data off. Time the database spends unable to accept a write is data
// that stops existing anywhere. See docs/08-bas-and-niagara.md.
//
// Two mechanisms could take writes away, and they are NOT the same thing:
//
//   Auto-stop. Does not exist for PostgreSQL Flexible Server. There is no
//   auto-stop, auto-pause or auto-shutdown property on this resource type and
//   no such flag on `az postgres flexible-server create` - only a MANUAL
//   `az postgres flexible-server stop`, which a person has to run and which
//   auto-restarts after 7 days. (Auto-pause is an Azure SQL serverless
//   feature. Do not go looking for it here again.) Nothing below disables it
//   because there is nothing to set.
//
//   A full disk. This one is real and reachable. At 100% the server refuses
//   writes, which for the collector is indistinguishable from the server being
//   down, and recovery needs a person to notice and resize. `autoGrow` is the
//   guard. Azure defaults it to Disabled; this template defaults it to Enabled
//   and states so, because the failure it prevents destroys data that exists
//   nowhere else, and the cost of growing a disk is recoverable while the
//   readings are not. Turning it off is a decision to monitor free space by
//   hand.
//
// No budget action, cost policy or automation is attached to this server. The
// budget below only sends mail; a budget that could stop a resource would put
// the paragraph above at the mercy of a spending threshold.
resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: postgresServerName
  location: location
  tags: tags
  sku: {
    name: postgresSkuName
    tier: postgresSkuTier
  }
  properties: {
    version: postgresVersion
    administratorLogin: postgresAdminUsername
    // The password is present in the request ONLY when one was supplied. A
    // flexible server PUT without administratorLoginPassword keeps the
    // current password; one with it SETS it, whatever it is. Spreading an
    // empty object leaves the property out of the request altogether, which
    // is not the same as sending it empty or null.
    ...(setPostgresAdminPassword ? { administratorLoginPassword: postgresAdminPassword } : {})
    storage: {
      storageSizeGB: postgresStorageGb
      autoGrow: postgresStorageAutoGrow
    }
    backup: {
      backupRetentionDays: postgresBackupRetentionDays
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

// THE COLLATION IS LOAD-BEARING.
//
// Every department and position list is ORDER BY name ASC, so the ordering is
// the database's, not the application's. `C` or `POSIX` compares raw bytes and
// sorts every uppercase letter before every lowercase one, which puts `AI`
// ahead of `Administrative` and the lists in visibly the wrong order.
//
// en_US.utf8 is also the Flexible Server default, and it is set explicitly here
// anyway: a default is something that can change, and this cannot be corrected
// later without a dump and restore. See runbook.md.
resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// Lets other Azure services - the container app - reach the server. This is the
// documented 0.0.0.0 sentinel, which means "Azure internal traffic", NOT the
// whole internet.
resource allowAzureServices 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgres
  name: 'AllowAllAzureServicesAndResourcesWithinAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// ---------------------------------------------------------------------------
// Secrets
//
// Written into Key Vault from secure parameters, so no value is ever in this
// repository or in a parameters file that gets committed. Azure does not log
// the value of a parameter marked @secure().
//
// Both secret resources are CONDITIONAL on their parameter having been
// supplied (2026-10-21). A deployment that omits the parameter does not touch
// the secret: no PUT, no new version, the container app's reference keeps
// resolving to the version already there. A deployment that supplies it writes
// a new version, exactly as before. The resources keep their symbolic names so
// the container app and the worker job still depend on them, and ARM ignores a
// dependency on a resource whose condition is false.
//
// Key Vault secret names allow alphanumerics and hyphens only, hence the naming
// that differs from the environment variables they become.
// ---------------------------------------------------------------------------

// Only meaningful when a password was supplied; with none it would be a URL
// with an empty password, and the conditional below is what keeps that URL
// from ever being written.
var databaseUrl = 'postgresql://${postgresAdminUsername}:${uriComponent(postgresAdminPassword)}@${postgres.properties.fullyQualifiedDomainName}:5432/${databaseName}?sslmode=require'

resource databaseUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (setPostgresAdminPassword) {
  parent: keyVault
  name: 'DATABASE-URL'
  properties: {
    value: databaseUrl
  }
}

resource authSecretSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (setAuthSecret) {
  parent: keyVault
  name: 'AUTH-SECRET'
  properties: {
    value: authSecret
  }
}

// The Anthropic API key is deliberately NOT a resource here and not a
// parameter. The two secrets above are generated at deploy time and were, until
// 2026-10-21, passed on every deploy; this one is issued once by the Anthropic
// Console and pasted into the vault once, by the person holding it, so a
// routine redeploy never needs it on the command line and can never overwrite
// it with a blank. The template only knows the name it is stored under.
// infra/README.md has the command; runbook.md has what goes wrong.
var anthropicApiKeySecretName = 'ANTHROPIC-API-KEY'

// The Change Orders module's Anthropic key is the same shape and a DIFFERENT
// key (2026-10-16): issued separately in the Anthropic Console, pasted into
// the vault once by hand, so the change-order pipeline and BAS Analyze are
// billed, rate-limited and revoked independently. The template knows the
// name only.
var coAnthropicApiKeySecretName = 'CO-ANTHROPIC-API-KEY'

// The BAS credential key is the same shape: issued once (generated on the
// office PC, where the collector already uses it), pasted into the vault once
// by hand, never on a deploy's command line. The template knows the name only.
var basCredentialKeySecretName = 'BAS-CREDENTIAL-KEY'

// The Analyze database URL is the third of the same shape: the bas_analyze
// role's connection URL on this server, built by the operator after running
// scripts/setup-bas-analyze-role.sql, pasted into the vault once, never on a
// deploy's command line. The template knows the name only.
var basAskDatabaseUrlSecretName = 'BAS-ASK-DATABASE-URL'

var hasCustomDomain = !empty(trim(customDomainName))
var managedCertificateName = 'mc-${replace(toLower(trim(customDomainName)), '.', '-')}'
// Built with resourceId() rather than a symbolic reference ON PURPOSE. The
// certificate depends on the app (the hostname must be on the app before Azure
// will issue for it), so a symbolic reference from the app back to the
// certificate would be a cycle. The id is a string the app carries; on the
// bound pass the certificate already exists, because the unbound pass made it.
var managedCertificateId = resourceId('Microsoft.App/managedEnvironments/managedCertificates', managedEnvironmentName, managedCertificateName)
// The one custom-domain entry the ingress carries, in one of its two states.
// A bound entry names the certificate; an unbound one does not carry the key
// at all, which is not the same as carrying it empty.
var customDomains = hasCustomDomain
  ? [
      customDomainBound
        ? {
            name: trim(customDomainName)
            bindingType: 'SniEnabled'
            certificateId: managedCertificateId
          }
        : {
            name: trim(customDomainName)
            bindingType: 'Disabled'
          }
    ]
  : []

// ---------------------------------------------------------------------------
// Container Apps
// ---------------------------------------------------------------------------

resource managedEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: managedEnvironmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: containerAppName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnvironment.id
    configuration: {
      ingress: {
        // Reachable from the internet. Sign-in is still gated by Entra, the
        // tenant check and the domain allow-list.
        external: true
        targetPort: containerPort
        transport: 'auto'
        allowInsecure: false
        // The custom hostname, if any, beside the app's own address. See the
        // Custom domain section above for the two-pass binding.
        customDomains: customDomains
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: [
        {
          name: 'database-url'
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${databaseUrlSecret.name}'
          identity: identity.id
        }
        {
          name: 'auth-secret'
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${authSecretSecret.name}'
          identity: identity.id
        }
        // Conditional, because a reference to a secret that is not in the
        // vault fails the revision - see the anthropicApiKeyInKeyVault param.
        ...(anthropicApiKeyInKeyVault
          ? [
              {
                name: 'anthropic-api-key'
                keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${anthropicApiKeySecretName}'
                identity: identity.id
              }
            ]
          : [])
        ...(coAnthropicApiKeyInKeyVault
          ? [
              {
                name: 'co-anthropic-api-key'
                keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${coAnthropicApiKeySecretName}'
                identity: identity.id
              }
            ]
          : [])
        ...(basCredentialKeyInKeyVault
          ? [
              {
                name: 'bas-credential-key'
                keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${basCredentialKeySecretName}'
                identity: identity.id
              }
            ]
          : [])
        ...(basAskDatabaseUrlInKeyVault
          ? [
              {
                name: 'bas-ask-database-url'
                keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${basAskDatabaseUrlSecretName}'
                identity: identity.id
              }
            ]
          : [])
      ]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: containerImage
          resources: {
            cpu: json(containerCpu)
            memory: containerMemory
          }
          env: [
            // Secrets by reference. The value never appears in the resource
            // definition, the deployment history, or `az containerapp show`.
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
            {
              name: 'AUTH_SECRET'
              secretRef: 'auth-secret'
            }
            // Everything below is configuration, not secret.
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'AUTH_URL'
              value: authUrl
            }
            {
              name: 'AUTH_MICROSOFT_ENTRA_ID_ID'
              value: ssoClientId
            }
            {
              name: 'AUTH_MICROSOFT_ENTRA_ID_TENANT_ID'
              value: ssoTenantId
            }
            {
              name: 'ALLOWED_EMAIL_DOMAINS'
              value: allowedEmailDomains
            }
            {
              name: 'BOOTSTRAP_ADMIN_EMAIL'
              value: bootstrapAdminEmails
            }
            // CLAUDE.md prohibition 1 still holds: nothing in this system
            // sends automatically. This gate was 'false' from the first
            // deployment until 2026-10-14, when the platform owner opened it
            // after a supervised test send on 2026-09-29 (a ZZTEST draft to the
            // operator's own address, which arrived and appeared in Sent
            // Items). It is 'true' here so a template deployment does not
            // close it again; every send is still one human, one draft, one
            // deliberate action. Exactly the lowercase string - 'TRUE' and
            // 'True' leave the gate shut. tests/deploy-guards.test.ts holds
            // this value. To close it in an emergency, see runbook.md ->
            // "The send gate is open, deliberately".
            {
              name: 'PHB_ALLOW_SEND'
              value: 'true'
            }
            {
              name: 'GRAPH_CLIENT_ID'
              value: graphClientId
            }
            {
              name: 'GRAPH_TENANT_ID'
              value: graphTenantId
            }
            // Deliberately absent: GRAPH_CLIENT_SECRET. Production authenticates
            // to Graph with the managed identity and a federated credential, and
            // createGraphCredential throws if a secret is set in production.
            {
              name: 'GRAPH_MANAGED_IDENTITY_CLIENT_ID'
              value: identity.properties.clientId
            }
            {
              name: 'CO_MAILBOX'
              value: coMailbox
            }
            // BAS Analyze's key, read lazily by readAnalyzeEnv in
            // lib/modules/bas/analyze/env.ts. Absent disables the Analyze tab
            // (B5) and nothing else; the platform boots without it. By
            // reference like the two secrets at the top of this list - never
            // a plain value. It is the Anthropic SDK's default variable name,
            // which is why Change Orders has its own entry below.
            ...(anthropicApiKeyInKeyVault
              ? [
                  {
                    name: 'ANTHROPIC_API_KEY'
                    secretRef: 'anthropic-api-key'
                  }
                ]
              : [])
            // Change Orders' key, read lazily by readChangeOrderAnthropicEnv
            // in lib/modules/change-orders/anthropic-env.ts - a different key
            // from the one above, never a fallback to it. Nothing reads it
            // until Phase 12 Part D; absent then disables the engine's model
            // calls and nothing else. By reference, never a plain value.
            ...(coAnthropicApiKeyInKeyVault
              ? [
                  {
                    name: 'CO_ANTHROPIC_API_KEY'
                    secretRef: 'co-anthropic-api-key'
                  }
                ]
              : [])
            // Read lazily by credentialKeyState in lib/modules/bas/credentials.ts.
            // Absent disables storing and decrypting station logins and nothing
            // else. By reference, like the key above - never a plain value. The
            // version beside it is a plain integer, not a secret, read only
            // when a password is saved (currentKeyVersion).
            ...(basCredentialKeyInKeyVault
              ? [
                  {
                    name: 'BAS_CREDENTIAL_KEY'
                    secretRef: 'bas-credential-key'
                  }
                  {
                    name: 'BAS_CREDENTIAL_KEY_VERSION'
                    value: basCredentialKeyVersion
                  }
                ]
              : [])
            // Read lazily by readAnalyzeEnv in lib/modules/bas/analyze/env.ts,
            // beside the Anthropic key: the Analyze tab needs both and says
            // which is missing. By reference, like the others - never a plain
            // value, and never DATABASE_URL: this is the read-only bas_analyze
            // role, not the platform's own connection.
            ...(basAskDatabaseUrlInKeyVault
              ? [
                  {
                    name: 'BAS_ASK_DATABASE_URL'
                    secretRef: 'bas-ask-database-url'
                  }
                ]
              : [])
            // Cost Intelligence: skill sync, project sync and the file tree read
            // SharePoint as the CIP app. No secret: the managed identity above.
            {
              name: 'PHB_PLATFORM_CIP_APP_TENANT_ID'
              value: cipAppTenantId
            }
            {
              name: 'PHB_PLATFORM_CIP_APP_CLIENT_ID'
              value: cipAppClientId
            }
            {
              name: 'CIP_SHAREPOINT_SKILLS_FOLDER'
              value: cipSharePointSkillsFolder
            }
            {
              name: 'CIP_SHAREPOINT_PROJECTS_FOLDER'
              value: cipSharePointProjectsFolder
            }
            // Change Orders → Needs Review: the _needs_review folder, read as
            // the phb-platform-co-review app. No secret: the managed identity
            // above. The names are decided in lib/env.ts.
            {
              name: 'PHB_PLATFORM_CO_REVIEW_APP_TENANT_ID'
              value: coReviewAppTenantId
            }
            {
              name: 'PHB_PLATFORM_CO_REVIEW_APP_CLIENT_ID'
              value: coReviewAppClientId
            }
            {
              name: 'CO_REVIEW_SHAREPOINT_FOLDER'
              value: coReviewSharePointFolder
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/api/health'
                port: containerPort
              }
              initialDelaySeconds: 10
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/api/health'
                port: containerPort
              }
              // Tuned from a measured cold start (2026-09-30, runbook.md ->
              // "A cold start takes about 30 seconds"): the web container is
              // listening 1.7 s after it starts, and with a 5 s initial delay
              // and a 10 s period the readiness gate alone cost 8 to 12 of the
              // 30 s. 1 s and 2 s take most of that back. /api/health touches
              // nothing, so a 2 s period costs the process nothing to answer.
              initialDelaySeconds: 1
              periodSeconds: 2
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
  // The app cannot start until it may pull its image and read its secrets.
  // Without these, a first deployment fails on a race that looks like a
  // permissions bug.
  dependsOn: [
    acrPull
    keyVaultRead
  ]
}

// ---------------------------------------------------------------------------
// Custom domain: the free managed certificate
// ---------------------------------------------------------------------------

// Issued by Azure on the environment for the hostname, validated through the
// CNAME. Deployed AFTER the container app, because Azure refuses to issue for
// a hostname no app in the environment carries; the app carries it from its
// first (unbound) pass on. Re-deploying an issued certificate is a no-op, and
// Azure renews it on its own - nothing here expires on a schedule a person has
// to keep (prohibition 7).
resource managedCertificate 'Microsoft.App/managedEnvironments/managedCertificates@2024-03-01' = if (hasCustomDomain) {
  parent: managedEnvironment
  name: managedCertificateName
  location: location
  tags: tags
  properties: {
    subjectName: trim(customDomainName)
    domainControlValidation: 'CNAME'
  }
  dependsOn: [
    containerApp
  ]
}

// ---------------------------------------------------------------------------
// Cost Intelligence run worker
//
// A Container Apps Job, not an app: it runs only while there is work. Every
// 15 seconds the scaler counts queued runs (and running ones whose worker
// stopped sending heartbeats) and starts one execution per run; each one runs
// `cip-worker.ts --once` - claims one run with FOR UPDATE SKIP LOCKED, works on
// it until it finishes or waits on a question, and exits. No retry: a failed
// run stays Failed and says why.
//
// ANTHROPIC-API-KEY-CIP is created in the vault by hand, never through a
// parameter, so the key is in no deployment history. It is Cost Intelligence's
// own key, separate from the platform's ANTHROPIC-API-KEY, so its spend shows
// on its own and it can be revoked alone. The job cannot be created until it
// exists, hence enableCipWorker.
// ---------------------------------------------------------------------------

resource cipWorkerJob 'Microsoft.App/jobs@2024-03-01' = if (enableCipWorker) {
  name: '${baseName}-cip-worker'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: managedEnvironment.id
    configuration: {
      triggerType: 'Event'
      // One run, including the agent's work, gets an hour.
      replicaTimeout: 3600
      replicaRetryLimit: 0
      eventTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
        scale: {
          minExecutions: 0
          maxExecutions: 3
          pollingInterval: 15
          rules: [
            {
              name: 'cip-runs-to-work-on'
              type: 'postgresql'
              metadata: {
                query: 'SELECT count(*) FROM cip_runs WHERE status = \'queued\' OR (status = \'running\' AND heartbeat_at < now() - interval \'10 minutes\')'
                targetQueryValue: '1'
              }
              auth: [
                {
                  secretRef: 'database-url'
                  triggerParameter: 'connection'
                }
              ]
            }
          ]
        }
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: [
        {
          name: 'database-url'
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${databaseUrlSecret.name}'
          identity: identity.id
        }
        {
          name: 'anthropic-api-key'
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/ANTHROPIC-API-KEY-CIP'
          identity: identity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'cip-worker'
          image: cipWorkerImage
          command: [
            'npx'
            'tsx'
            'scripts/cip-worker.ts'
            '--once'
          ]
          resources: {
            cpu: json('2.0')
            memory: '4Gi'
          }
          env: [
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
            {
              name: 'ANTHROPIC_API_KEY'
              secretRef: 'anthropic-api-key'
            }
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'GRAPH_MANAGED_IDENTITY_CLIENT_ID'
              value: identity.properties.clientId
            }
            {
              name: 'PHB_PLATFORM_CIP_APP_TENANT_ID'
              value: cipAppTenantId
            }
            {
              name: 'PHB_PLATFORM_CIP_APP_CLIENT_ID'
              value: cipAppClientId
            }
            {
              name: 'CIP_SHAREPOINT_SKILLS_FOLDER'
              value: cipSharePointSkillsFolder
            }
            {
              name: 'CIP_SHAREPOINT_PROJECTS_FOLDER'
              value: cipSharePointProjectsFolder
            }
            {
              name: 'CIP_RUN_MODEL'
              value: cipRunModel
            }
          ]
        }
      ]
    }
  }
  dependsOn: [
    acrPull
    keyVaultRead
  ]
}

// ---------------------------------------------------------------------------
// Nightly database backup
//
// The readings in this database exist nowhere else once the JACE rolls them
// off, and the server's own point-in-time backups are lost with the server.
// This is the copy that is not: a pg_dump every night, as a Container Apps
// Job on a schedule, uploaded to a blob container that nothing else writes.
//
// Three pieces, all behind enableDbBackup, which is off by default for the
// same reason enableCipWorker is - the job names an image that has to be in
// the registry before the job can be created:
//
//   the storage account, one container (`dumps`), a lifecycle rule that
//   deletes a dump after dbBackupRetentionDays, and blob soft delete for the
//   fortnight after;
//   a Storage Blob Data Contributor assignment for the platform's identity,
//   scoped to that one container - the only credential the upload has. The
//   account refuses shared-key access altogether, so there is no account key
//   to leak and no SAS to expire (prohibition 7);
//   the job, running infra/db-backup/backup.sh from an image built once
//   (`db-backup:pg17`) from infra/db-backup/Dockerfile. It reads DATABASE-URL
//   by reference, the same secret the app and the CIP worker read, and the
//   script moves the password into libpq's own environment variables so that
//   pg_dump runs with no connection argument at all.
//
// Why the administrator's connection and not a backup role of its own. The
// office PC's dump runs as `bas_backup`, a member of pg_read_all_data; on an
// Azure Flexible Server at PostgreSQL 16 and later the administrator is not a
// superuser and holds that predefined role without ADMIN OPTION, so it cannot
// grant it (Microsoft Q&A 1767915, azure-service-operator issue 4639). The
// alternative is per-table grants, and that is the exact shape that failed the
// office backup silently for three weeks when a migration added a table the
// role had never been granted (runbook.md -> "Repointing the collector also
// repoints the nightly backup"). A dump as the owner of every object is
// complete by construction and stays complete through every migration, and
// enabling it is one parameter flip rather than a role, a password and a
// vault secret first. The cost is that the job holds a credential that can
// write; what bounds it is that the image holds pg_dump, curl and this script
// and nothing else, and the secret is by reference and never printed.
// ---------------------------------------------------------------------------

// Storage account names: 3-24 characters, lowercase letters and digits only,
// globally unique. 11 + 4 + 2 + 6 at the longest prefix is 23.
var backupStorageAccountName = toLower(replace('${namePrefix}${environmentName}bk${uniqueSuffix}', '-', ''))
var dbBackupContainerName = 'dumps'

// Built once, from infra/db-backup/Dockerfile, into this registry; named by
// the server's major version so the client cannot drift from it. Not a
// parameter: nothing in the image changes with the application, so there is
// no per-commit tag for a redeploy to get wrong.
var dbBackupImage = '${registry.properties.loginServer}/db-backup:pg${postgresVersion}'

resource backupStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = if (enableDbBackup) {
  name: backupStorageAccountName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    // Geo-redundant: the second copy sits in the paired region. The server's
    // own backups are locally redundant and in the same region as the server,
    // so a regional loss is the one event they cannot answer and the one this
    // copy exists for. At this database's size the whole account is pennies
    // a month over LRS, which is what a nightly dump of a few megabytes costs
    // at any redundancy tier. Not read-access (RA-GRS): nothing reads the
    // secondary day to day, and a failover is a deliberate act.
    name: 'Standard_GRS'
  }
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    // No account keys, so nothing but a role assignment can write or read a
    // dump. `az storage blob` then needs `--auth-mode login` and a data-plane
    // role on the container - runbook.md says which.
    allowSharedKeyAccess: false
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource backupBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = if (enableDbBackup) {
  parent: backupStorage
  name: 'default'
  properties: {
    // A deleted dump - by the lifecycle rule or by a person - can be undeleted
    // for a fortnight. Costs the space of the deleted blobs for those days.
    deleteRetentionPolicy: {
      enabled: true
      days: 14
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 14
    }
  }
}

resource dumpsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = if (enableDbBackup) {
  parent: backupBlobService
  name: dbBackupContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource backupLifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = if (enableDbBackup) {
  parent: backupStorage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'delete-dumps-after-retention'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                '${dbBackupContainerName}/'
              ]
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: dbBackupRetentionDays
                }
              }
            }
          }
        }
      ]
    }
  }
}

// Storage Blob Data Contributor - read, write and delete blobs; nothing on
// the account itself. Scoped to the one container, not the account.
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource backupBlobWrite 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableDbBackup) {
  scope: dumpsContainer
  name: guid(backupStorage.id, dbBackupContainerName, identity.id, storageBlobDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      storageBlobDataContributorRoleId
    )
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource dbBackupJob 'Microsoft.App/jobs@2024-03-01' = if (enableDbBackup) {
  name: '${baseName}-db-backup'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: managedEnvironment.id
    configuration: {
      triggerType: 'Schedule'
      // A dump of this database takes seconds; half an hour is the ceiling
      // for a server under load, after which the execution is Failed.
      replicaTimeout: 1800
      // One retry, for a transient refusal from the server or the storage
      // endpoint. Both attempts failing is a Failed execution, as it should be.
      replicaRetryLimit: 1
      scheduleTriggerConfig: {
        cronExpression: dbBackupCron
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: [
        {
          name: 'database-url'
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${databaseUrlSecret.name}'
          identity: identity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'db-backup'
          image: dbBackupImage
          // The script, and no argument. An argument is on the command line
          // of every execution's record; the script takes everything it
          // needs from the environment below.
          command: [
            '/usr/local/bin/phb-db-backup'
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            // By reference, never a plain value - and the only secret the
            // job holds. The script turns it into PGHOST/PGUSER/PGPASSWORD
            // and unsets it before pg_dump runs.
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
            // Everything below is configuration, not secret.
            // Built from the name and the cloud's storage suffix rather than
            // read off the account resource: the two are conditional on the
            // same parameter, but the compiler cannot see that and warns
            // (BCP318) that the account may be null.
            {
              name: 'BACKUP_BLOB_ENDPOINT'
              value: 'https://${backupStorageAccountName}.blob.${environment().suffixes.storage}/'
            }
            {
              name: 'BACKUP_CONTAINER'
              value: dbBackupContainerName
            }
            // Which identity to ask the Container Apps identity endpoint for
            // a token as. The role assignment above is what makes the answer
            // useful.
            {
              name: 'AZURE_CLIENT_ID'
              value: identity.properties.clientId
            }
          ]
        }
      ]
    }
  }
  dependsOn: [
    acrPull
    keyVaultRead
    backupBlobWrite
  ]
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

resource budget 'Microsoft.Consumption/budgets@2023-05-01' = if (enableBudget) {
  name: '${baseName}-monthly'
  properties: {
    category: 'Cost'
    amount: budgetAmount
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: budgetStartDate
    }
    notifications: {
      // Warn well before the limit, then again at it. A notification that only
      // fires at 100% arrives after the money is spent.
      forecasted80: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 80
        thresholdType: 'Forecasted'
        contactEmails: budgetContactEmails
      }
      actual100: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 100
        thresholdType: 'Actual'
        contactEmails: budgetContactEmails
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Outputs. Consumed by CI and by the Part B checklist. No secret is output.
// ---------------------------------------------------------------------------

output containerAppName string = containerApp.name
output containerAppUrl string = 'https://${containerApp.properties.configuration.ingress.fqdn}'
output registryName string = registry.name
output registryLoginServer string = registry.properties.loginServer
output keyVaultName string = keyVault.name
output postgresServerName string = postgres.name
output postgresFqdn string = postgres.properties.fullyQualifiedDomainName
output databaseName string = database.name
output managedIdentityName string = identity.name
output managedIdentityClientId string = identity.properties.clientId
output managedIdentityPrincipalId string = identity.properties.principalId
// Set as the AZURE_CIP_WORKER_JOB repository variable so deploys update its image.
output cipWorkerJobName string = enableCipWorker ? cipWorkerJob.name : ''
// The backup job and where its dumps land, for `az containerapp job execution
// list` and `az storage blob list` in runbook.md -> "Nightly database backup".
output dbBackupJobName string = enableDbBackup ? dbBackupJob.name : ''
output dbBackupStorageAccountName string = enableDbBackup ? backupStorage.name : ''
// The redirect URI IT has to add to the SSO app registration in Part B.
output ssoRedirectUri string = 'https://${containerApp.properties.configuration.ingress.fqdn}/api/auth/callback/microsoft-entra-id'
// The custom hostname's address and ITS redirect URI, empty when no custom
// domain is set. The second is a further redirect URI to ADD to the SSO app
// registration - the one above stays, because the app's own address keeps
// working and authUrl may still point at it.
output customDomainUrl string = hasCustomDomain ? 'https://${trim(customDomainName)}' : ''
output customDomainSsoRedirectUri string = hasCustomDomain ? 'https://${trim(customDomainName)}/api/auth/callback/microsoft-entra-id' : ''
