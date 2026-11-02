// The two connection-string secrets, database-url (app login) and
// database-admin-url (db-migrate), rewritten for the current PostgreSQL host.
//
// The foundation stage writes them once, before any server exists. The host
// name follows from the server name, which includes the database region
// (main.bicep), so a change of POSTGRES_LOCATION before the first server was
// created leaves them pointing at a host that will never exist. main.bicep
// deploys this module in the full stage only when the postgresHost tag on
// database-url differs from the current host (infra.yml reads the tag from the
// control plane), so an ordinary rerun adds no new secret version.
param vaultName string
@description('The project tags plus postgresHost, which infra.yml compares on the next run.')
param tags object
param postgresHost string
param adminLogin string
param appLogin string
param databaseName string
@description('The stored pg-admin-password, read with getSecret.')
@secure()
param adminPassword string
@description('The stored pg-app-password, read with getSecret.')
@secure()
param appPassword string

var connection = '${postgresHost}:5432/${databaseName}?sslmode=require'

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: vaultName
}

resource databaseUrl 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'database-url'
  tags: tags
  properties: {
    value: 'postgres://${appLogin}:${appPassword}@${connection}'
  }
}

resource databaseAdminUrl 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'database-admin-url'
  tags: tags
  properties: {
    value: 'postgres://${adminLogin}:${adminPassword}@${connection}'
  }
}
