// File storage (tech-stack.md §8, F4, F8; task 44 Q5). The app signs in with
// the managed identity and user delegation keys only, so shared keys are off.
// Blob soft delete and versioning are off, so a purged CV is really gone
// (RT4, task 40). The private `files` container is created here; the app never
// creates it in Azure.
param name string
param location string
param tags object
param identityPrincipalId string

// Built-in role: Storage Blob Data Contributor.
var storageBlobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource account 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: account
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: false
    }
    containerDeleteRetentionPolicy: {
      enabled: false
    }
    isVersioningEnabled: false
  }
}

resource files 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'files'
  properties: {
    publicAccess: 'None'
  }
}

resource blobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(account.id, identityPrincipalId, storageBlobDataContributor)
  scope: account
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributor)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// No trailing slash: also the CSP frame-src origin (§8).
output accountUrl string = 'https://${account.name}.blob.${environment().suffixes.storage}'
