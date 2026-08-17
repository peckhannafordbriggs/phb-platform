// PHB Platform - production infrastructure.
//
// Deployed at RESOURCE GROUP scope. The subscription and resource group are
// therefore chosen on the command line, not written down here:
//
//   az deployment group create \
//     --subscription <subscription-id> \
//     --resource-group <resource-group> \
//     --template-file infra/main.bicep \
//     --parameters @infra/main.parameters.json
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

@description('Image the container app runs. On the very first deployment the registry is empty, so this defaults to a public placeholder; CI replaces it with the real image on every deploy.')
param containerImage string = 'mcr.microsoft.com/k8se/quickstart:latest'

@description('Port the application listens on. Matches the Dockerfile.')
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
// later without a dump and restore. See docs/runbook.md.
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
            // CLAUDE.md prohibition 1. Nothing in this system sends
            // automatically, and this stays false until a human has verified an
            // end-to-end send.
            {
              name: 'PHB_ALLOW_SEND'
              value: 'false'
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
              initialDelaySeconds: 5
              periodSeconds: 10
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
// The redirect URI IT has to add to the SSO app registration in Part B.
output ssoRedirectUri string = 'https://${containerApp.properties.configuration.ingress.fqdn}/api/auth/callback/microsoft-entra-id'
