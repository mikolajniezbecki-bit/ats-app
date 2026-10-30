// The Container Apps environment, the web app and the tick, db-migrate and
// db-seed jobs (G5, W8, M5; task 44 Q8, Q10). All four run the same image,
// with the same identity, registry and environment list (§3 rule 8).
param location string
param tags object
param environmentName string
param webName string
param tickJobName string
param migrateJobName string
param seedJobName string
param workspaceName string
param identityId string
param identityClientId string
param keyVaultUri string
param storageAccountUrl string
param image string
param ghcrUsername string
param microsoftClientId string
param turnstileSiteKey string
param demoUserDomain string
@description('False only on the first full deployment, until db-migrate has created the app login (infra.yml).')
param deployWebApp bool

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: workspaceName
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: workspace.properties.customerId
        sharedKey: workspace.listKeys().primarySharedKey
      }
    }
    zoneRedundant: false
  }
}

// Used for sign-in, sitemap URLs and approval-email links (AU1).
var appUrl = 'https://${webName}.${environment.properties.defaultDomain}'

// Key Vault references, resolved by the identity. Container App secret name
// = Key Vault secret name.
var vaultSecretNames = [
  'database-url'
  'better-auth-secret'
  'microsoft-client-secret'
  'email-hash-key'
  'turnstile-secret-key'
  'tick-secret'
  'ghcr-pat'
]
var vaultSecrets = [
  for secretName in vaultSecretNames: {
    name: secretName
    keyVaultUrl: '${keyVaultUri}secrets/${secretName}'
    identity: identityId
  }
]
var adminSecret = {
  name: 'database-admin-url'
  keyVaultUrl: '${keyVaultUri}secrets/database-admin-url'
  identity: identityId
}

var registries = [
  {
    server: 'ghcr.io'
    username: ghcrUsername
    passwordSecretRef: 'ghcr-pat'
  }
]

// One environment list for the web app and every job (Q8). Never here:
// AUTH_DEV_LOGIN, DEMO_USER_PASSWORD, local storage and SMTP settings
// (checked by infra/check-arm.mjs).
var sharedEnv = [
  { name: 'APP_ENV', value: 'azure' }
  { name: 'EMAIL_PROVIDER', value: 'outbox' }
  { name: 'LOG_LEVEL', value: 'info' }
  { name: 'BETTER_AUTH_URL', value: appUrl }
  { name: 'MICROSOFT_CLIENT_ID', value: microsoftClientId }
  { name: 'MICROSOFT_TENANT_ID', value: tenant().tenantId }
  { name: 'AZURE_STORAGE_ACCOUNT_URL', value: storageAccountUrl }
  { name: 'AZURE_CLIENT_ID', value: identityClientId }
  { name: 'TURNSTILE_SITE_KEY', value: turnstileSiteKey }
  { name: 'DEMO_USER_DOMAIN', value: demoUserDomain }
  { name: 'DATABASE_URL', secretRef: 'database-url' }
  { name: 'BETTER_AUTH_SECRET', secretRef: 'better-auth-secret' }
  { name: 'MICROSOFT_CLIENT_SECRET', secretRef: 'microsoft-client-secret' }
  { name: 'EMAIL_HASH_KEY', secretRef: 'email-hash-key' }
  { name: 'TURNSTILE_SECRET_KEY', secretRef: 'turnstile-secret-key' }
  { name: 'TICK_SECRET', secretRef: 'tick-secret' }
]
var jobEnv = concat(sharedEnv, [{ name: 'WORKER_ENABLED', value: 'false' }])

var identity = {
  type: 'UserAssigned'
  userAssignedIdentities: {
    '${identityId}': {}
  }
}

// Its start-up exits while the app login doesn't exist yet, so the first full
// deployment creates it only after db-migrate has run (infra.yml).
resource web 'Microsoft.App/containerApps@2024-03-01' = if (deployWebApp) {
  name: webName
  location: location
  tags: tags
  identity: identity
  properties: {
    environmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: registries
      secrets: vaultSecrets
    }
    template: {
      containers: [
        {
          name: 'web'
          image: image
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: concat(sharedEnv, [{ name: 'WORKER_ENABLED', value: 'true' }])
          // M5: readiness and startup only. No liveness probe on /api/health,
          // so a storage outage doesn't restart the app.
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/api/health'
                port: 3000
              }
              // 30 s + 10 × 10 s: over 2 minutes for a cold start.
              initialDelaySeconds: 30
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 10
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/api/health'
                port: 3000
              }
              periodSeconds: 30
              timeoutSeconds: 10
              failureThreshold: 3
            }
          ]
        }
      ]
      // W8: 0–1 replicas with the default HTTP scale rule.
      scale: {
        minReplicas: 0
        maxReplicas: 1
      }
    }
  }
}

resource tick 'Microsoft.App/jobs@2024-03-01' = {
  name: tickJobName
  location: location
  tags: tags
  identity: identity
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Schedule'
      scheduleTriggerConfig: {
        cronExpression: '0 * * * *'
        parallelism: 1
        replicaCompletionCount: 1
      }
      replicaTimeout: 300
      replicaRetryLimit: 0
      registries: registries
      secrets: vaultSecrets
    }
    template: {
      containers: [
        {
          name: 'tick'
          image: image
          command: [
            'node'
            'db/tick.mjs'
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: jobEnv
        }
      ]
    }
  }
}

resource migrate 'Microsoft.App/jobs@2024-03-01' = {
  name: migrateJobName
  location: location
  tags: tags
  identity: identity
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Manual'
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      replicaTimeout: 600
      replicaRetryLimit: 0
      registries: registries
      // The only resource with the admin connection (G5).
      secrets: concat(vaultSecrets, [adminSecret])
    }
    template: {
      containers: [
        {
          name: 'db-migrate'
          image: image
          command: [
            'node'
            'db/migrate.mjs'
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: concat(jobEnv, [{ name: 'DATABASE_ADMIN_URL', secretRef: 'database-admin-url' }])
        }
      ]
    }
  }
}

resource seed 'Microsoft.App/jobs@2024-03-01' = {
  name: seedJobName
  location: location
  tags: tags
  identity: identity
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Manual'
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      replicaTimeout: 1800
      replicaRetryLimit: 0
      registries: registries
      secrets: vaultSecrets
    }
    template: {
      containers: [
        {
          name: 'db-seed'
          image: image
          // SEED_ADMIN_EMAIL is set per execution (README "Azure setup"):
          // then seed:admin promotes that user instead of running db:seed.
          command: [
            '/bin/sh'
            '-c'
            'if [ -n "$SEED_ADMIN_EMAIL" ]; then exec node db/seed-admin.mjs --email "$SEED_ADMIN_EMAIL"; else exec node db/seed.mjs; fi'
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: jobEnv
        }
      ]
    }
  }
}

output appUrl string = appUrl
output migrateJobName string = migrate.name
output seedJobName string = seed.name
output tickJobName string = tick.name
