// PostgreSQL Flexible Server (G5, D5; task 44 Q3, Q7): version 17, B1MS with
// 32 GB, 7-day local backups and nothing that raises the cost (auto-grow,
// high availability, geo-redundant backup off). Password authentication only
// (TO-18); public access limited to Azure services; TLS required. The app
// login is created by the db-migrate job, not here.
param name string
param location string
param tags object
param adminLogin string
@secure()
param adminPassword string
param databaseName string

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '17'
    administratorLogin: adminLogin
    administratorLoginPassword: adminPassword
    storage: {
      storageSizeGB: 32
      autoGrow: 'Disabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    authConfig: {
      activeDirectoryAuth: 'Disabled'
      passwordAuth: 'Enabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

// The child resources deploy one at a time: server → firewall rule →
// configuration → database. A new server keeps working for a while after it
// reports Succeeded, and parallel child writes then fail with ServerIsBusy
// (first full deploy in francecentral, on require_secure_transport).

// 0.0.0.0–0.0.0.0 is Azure's "allow Azure services" rule.
resource allowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2025-08-01' = {
  parent: server
  name: 'AllowAllWindowsAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource secureTransport 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = {
  parent: server
  name: 'require_secure_transport'
  properties: {
    value: 'on'
    source: 'user-override'
  }
  dependsOn: [
    allowAzure
  ]
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2025-08-01' = {
  parent: server
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
  dependsOn: [
    // Server configuration changes and database creation can't overlap.
    secureTransport
  ]
}

output host string = server.properties.fullyQualifiedDomainName
