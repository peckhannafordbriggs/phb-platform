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

@description('Administrator login for the database server. Not an email address, and not a person.')
param postgresAdminUsername string

@secure()
@description('Administrator password. Supply at deploy time; never commit it. Rotate through Key Vault afterwards.')
param postgresAdminPassword string

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
@description('Auth.js session secret. Generate with `npx auth secret`.')
param authSecret string

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

@description('Model the skills run on. Empty means the default in lib/modules/cost-intelligence/runs.ts.')
param cipRunModel string = ''

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
    administratorLoginPassword: postgresAdminPassword
    storage: {
      storageSizeGB: postgresStorageGb
      autoGrow: postgresStorageAutoGrow
    }
    backup: {
      backupRetentionDays: 7
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
// Key Vault secret names allow alphanumerics and hyphens only, hence the naming
// that differs from the environment variables they become.
// ---------------------------------------------------------------------------

var databaseUrl = 'postgresql://${postgresAdminUsername}:${uriComponent(postgresAdminPassword)}@${postgres.properties.fullyQualifiedDomainName}:5432/${databaseName}?sslmode=require'

resource databaseUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'DATABASE-URL'
  properties: {
    value: databaseUrl
  }
}

resource authSecretSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'AUTH-SECRET'
  properties: {
    value: authSecret
  }
}

// The Anthropic API key is deliberately NOT a resource here and not a
// parameter. The two secrets above are generated at deploy time and are
// passed on every deploy; this one is issued once by the Anthropic Console and
// pasted into the vault once, by the person holding it, so a routine redeploy
// never needs it on the command line and can never overwrite it with a blank.
// The template only knows the name it is stored under. infra/README.md has the
// command; runbook.md has what goes wrong.
var anthropicApiKeySecretName = 'ANTHROPIC-API-KEY'

// The BAS credential key is the same shape: issued once (generated on the
// office PC, where the collector already uses it), pasted into the vault once
// by hand, never on a deploy's command line. The template knows the name only.
var basCredentialKeySecretName = 'BAS-CREDENTIAL-KEY'

// The Analyze database URL is the third of the same shape: the bas_analyze
// role's connection URL on this server, built by the operator after running
// scripts/setup-bas-analyze-role.sql, pasted into the vault once, never on a
// deploy's command line. The template knows the name only.
var basAskDatabaseUrlSecretName = 'BAS-ASK-DATABASE-URL'

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
            // Read lazily by readAnthropicApiKey in lib/env.ts. Absent
            // disables BAS Ask (B5) and the Phase 12 Part D engine calls and
            // nothing else; the platform boots without it. By reference like
            // the two secrets at the top of this list - never a plain value.
            ...(anthropicApiKeyInKeyVault
              ? [
                  {
                    name: 'ANTHROPIC_API_KEY'
                    secretRef: 'anthropic-api-key'
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
// The redirect URI IT has to add to the SSO app registration in Part B.
output ssoRedirectUri string = 'https://${containerApp.properties.configuration.ingress.fqdn}/api/auth/callback/microsoft-entra-id'
