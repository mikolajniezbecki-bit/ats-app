// Log Analytics (tech-stack.md M7): 0.1 GB/day cap and 30-day retention keep
// ingestion inside the free 5 GB/month. No diagnostic settings send data here;
// only the Container Apps environment's console and system logs arrive.
param name string
param location string
param tags object

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    workspaceCapping: {
      dailyQuotaGb: json('0.1')
    }
  }
}

output id string = workspace.id
output name string = workspace.name
