// The whole Azure environment (tech-stack.md §1, G5; task 44). Deployed by
// .github/workflows/infra.yml into one resource group, in two stages (Q4):
//
//   foundation  Log Analytics, the identity, Key Vault with the generated
//               secrets, storage with the `files` container, the two role
//               assignments and the budget.
//   full        the same, plus PostgreSQL, the Container Apps environment,
//               the web app and the tick, db-migrate and db-seed jobs.
//
// `foundation` exists because Container App Key Vault references fail until
// the owner has added microsoft-client-secret, turnstile-secret-key and
// ghcr-pat (README "Azure setup").
targetScope = 'resourceGroup'

@allowed([
  'foundation'
  'full'
])
param stage string

@description('Short name prefix; with uniqueString(resourceGroup().id) it makes every resource name.')
@maxLength(5)
param prefix string = 'ats'

param location string = resourceGroup().location

@description('Region of the PostgreSQL server only; empty means location. Set when Standard_B1ms is not offered to the subscription in the resource group\'s region (infra.yml reads the POSTGRES_LOCATION variable).')
param postgresLocation string = ''

@description('Image tag in GHCR (a commit SHA pushed by main.yml). Required for stage full.')
param imageTag string = ''
param imageRepository string = 'ghcr.io/mikolajniezbecki-bit/ats-app'

@description('False only on the first full deployment, until db-migrate has created the app login (infra.yml).')
param deployWebApp bool = true

@description('True only on the first foundation deployment, when no generated secret exists yet (infra.yml decides).')
param createGeneratedSecrets bool = false

// Non-secret identifiers from GitHub Actions variables (infra.yml).
param ghcrUsername string
param microsoftClientId string
param turnstileSiteKey string
@description('The tenant domain, <tenant>.onmicrosoft.com.')
param demoUserDomain string
param budgetAlertEmail string

@description('Monthly budget in the subscription\'s billing currency (EUR 10 or the equivalent, M8).')
param budgetAmount int = 10
@description('First day of a month; committed once in main.bicepparam so reruns keep the budget.')
param budgetStartDate string

// Random values infra.yml generates on the first foundation run only
// (createGeneratedSecrets); empty otherwise. Written to Key Vault once, so
// they never replace an existing secret.
@secure()
param pgAdminPassword string = ''
@secure()
param pgAppPassword string = ''
@secure()
param betterAuthSecret string = ''
@secure()
param emailHashKey string = ''
@secure()
param tickSecret string = ''

var suffix = uniqueString(resourceGroup().id)
var tags = {
  project: 'ats'
}
var names = {
  workspace: '${prefix}-logs-${suffix}'
  identity: '${prefix}-id-${suffix}'
  keyVault: '${prefix}-kv-${suffix}'
  storage: '${prefix}st${suffix}'
  postgres: '${prefix}-pg-${suffix}'
  budget: '${prefix}-budget'
  environment: '${prefix}-env-${suffix}'
  web: '${prefix}-web-${suffix}'
  tick: '${prefix}-tick-${suffix}'
  migrate: '${prefix}-db-migrate-${suffix}'
  seed: '${prefix}-db-seed-${suffix}'
}
var databaseName = 'ats'
var postgresAdminLogin = 'atsadmin'
var postgresAppLogin = 'ats_app'
// Azure requires three character classes in the PostgreSQL admin password;
// the fixed prefix and suffix guarantee them whatever the random part holds.
var pgPassword = { admin: 'Pg${pgAdminPassword}x1', app: 'Pg${pgAppPassword}x1' }

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  params: {
    name: names.workspace
    location: location
    tags: tags
  }
}

module identity 'modules/identity.bicep' = {
  name: 'identity'
  params: {
    name: names.identity
    location: location
    tags: tags
  }
}

module keyVault 'modules/keyvault.bicep' = {
  name: 'keyvault'
  params: {
    name: names.keyVault
    location: location
    tags: tags
    identityPrincipalId: identity.outputs.principalId
    createGeneratedSecrets: createGeneratedSecrets
    // The server's host name follows from its name; it doesn't exist yet in foundation.
    postgresHost: '${names.postgres}.postgres.database.azure.com'
    postgresAdminLogin: postgresAdminLogin
    postgresAppLogin: postgresAppLogin
    databaseName: databaseName
    pgAdminPassword: pgPassword.admin
    pgAppPassword: pgPassword.app
    betterAuthSecret: betterAuthSecret
    emailHashKey: emailHashKey
    tickSecret: tickSecret
  }
}

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    name: names.storage
    location: location
    tags: tags
    identityPrincipalId: identity.outputs.principalId
  }
}

module budget 'modules/budget.bicep' = {
  name: 'budget'
  params: {
    name: names.budget
    amount: budgetAmount
    startDate: budgetStartDate
    alertEmail: budgetAlertEmail
  }
}

// Read only by the full stage's PostgreSQL module, after the foundation created it.
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: names.keyVault
}

module postgres 'modules/postgres.bicep' = if (stage == 'full') {
  name: 'postgres'
  params: {
    name: names.postgres
    location: empty(postgresLocation) ? location : postgresLocation
    tags: tags
    adminLogin: postgresAdminLogin
    // Always the stored password, never this run's seed (Q4).
    adminPassword: vault.getSecret('pg-admin-password')
    databaseName: databaseName
  }
  dependsOn: [
    keyVault
  ]
}

module apps 'modules/apps.bicep' = if (stage == 'full') {
  name: 'apps'
  params: {
    location: location
    tags: tags
    environmentName: names.environment
    webName: names.web
    tickJobName: names.tick
    migrateJobName: names.migrate
    seedJobName: names.seed
    workspaceName: monitoring.outputs.name
    identityId: identity.outputs.id
    identityClientId: identity.outputs.clientId
    keyVaultUri: keyVault.outputs.uri
    storageAccountUrl: storage.outputs.accountUrl
    image: '${imageRepository}:${imageTag}'
    ghcrUsername: ghcrUsername
    microsoftClientId: microsoftClientId
    turnstileSiteKey: turnstileSiteKey
    demoUserDomain: demoUserDomain
    deployWebApp: deployWebApp
  }
  dependsOn: [
    // The app's first revision connects to the database at start.
    postgres
  ]
}

output keyVaultName string = keyVault.outputs.name
output webName string = names.web
output migrateJobName string = names.migrate
output seedJobName string = names.seed
output tickJobName string = names.tick
output appUrl string = stage == 'full' ? apps!.outputs.appUrl : ''
