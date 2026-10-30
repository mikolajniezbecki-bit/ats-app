// The one user-assigned identity of the web app and the three jobs (G5): it
// reads Key Vault secrets and the storage account's blobs.
param name string
param location string
param tags object

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: name
  location: location
  tags: tags
}

output id string = identity.id
output clientId string = identity.properties.clientId
output principalId string = identity.properties.principalId
