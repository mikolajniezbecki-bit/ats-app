// Key Vault (G5, task 44 Q4, Q6): Azure RBAC, 7-day soft delete, purge
// protection off (so a rebuild can purge and reuse the name, G6), and
// template deployment on, so main.bicep reads the PostgreSQL admin password
// back with getSecret on every rerun.
//
// The generated secrets are written only when `createGeneratedSecrets` is
// true. infra.yml sets it on the first foundation deployment, when none of
// them exists, so a rerun never adds a new version. The owner's own secrets
// (microsoft-client-secret, turnstile-secret-key, ghcr-pat) are never written
// here.
param name string
param location string
param tags object
param identityPrincipalId string
param createGeneratedSecrets bool
@description('Host name of the PostgreSQL server, which may not exist yet.')
param postgresHost string
param postgresAdminLogin string
param postgresAppLogin string
param databaseName string

@secure()
param pgAdminPassword string
@secure()
param pgAppPassword string
@secure()
param betterAuthSecret string
@secure()
param emailHashKey string
@secure()
param tickSecret string

// Built-in role: Key Vault Secrets User.
var keyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    tenantId: tenant().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    // enablePurgeProtection is left out: it can't be set to false, only omitted.
    enabledForTemplateDeployment: true
    publicNetworkAccess: 'Enabled'
  }
}

resource secretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, identityPrincipalId, keyVaultSecretsUser)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUser)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

var connection = '${postgresHost}:5432/${databaseName}?sslmode=require'
var generated = createGeneratedSecrets
  ? [
      { name: 'pg-admin-password', value: pgAdminPassword }
      { name: 'pg-app-password', value: pgAppPassword }
      { name: 'better-auth-secret', value: betterAuthSecret }
      { name: 'email-hash-key', value: emailHashKey }
      { name: 'tick-secret', value: tickSecret }
      { name: 'database-url', value: 'postgres://${postgresAppLogin}:${pgAppPassword}@${connection}' }
      { name: 'database-admin-url', value: 'postgres://${postgresAdminLogin}:${pgAdminPassword}@${connection}' }
    ]
  : []

resource secrets 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = [
  for secret in generated: {
    parent: vault
    name: secret.name
    tags: tags
    properties: {
      value: secret.value
    }
  }
]

output name string = vault.name
output uri string = vault.properties.vaultUri
