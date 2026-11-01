// Parameters for infra/main.bicep. Nothing environment-specific or secret is
// committed: infra.yml exports these environment variables from its inputs,
// the GitHub Actions variables and, on the first foundation run only, the
// generated secrets (README "Azure setup").
using 'main.bicep'

param stage = readEnvironmentVariable('INFRA_STAGE', 'foundation')
param prefix = 'ats'
param imageTag = readEnvironmentVariable('INFRA_IMAGE_TAG', '')
param deployWebApp = bool(readEnvironmentVariable('INFRA_DEPLOY_WEB_APP', 'true'))
param createGeneratedSecrets = bool(readEnvironmentVariable('INFRA_CREATE_GENERATED_SECRETS', 'false'))

param ghcrUsername = readEnvironmentVariable('GHCR_USERNAME', '')
param microsoftClientId = readEnvironmentVariable('MICROSOFT_CLIENT_ID', '')
param turnstileSiteKey = readEnvironmentVariable('TURNSTILE_SITE_KEY', '')
param demoUserDomain = readEnvironmentVariable('DEMO_USER_DOMAIN', '')
param budgetAlertEmail = readEnvironmentVariable('BUDGET_ALERT_EMAIL', '')
// Optional: the database's region when it differs from the resource group's.
param postgresLocation = readEnvironmentVariable('POSTGRES_LOCATION', '')

// EUR 10, or the same amount in the subscription's billing currency (M8).
param budgetAmount = 10
// First day of the month the budget starts counting; fixed, so reruns keep it.
param budgetStartDate = '2026-11-01'

param pgAdminPassword = readEnvironmentVariable('INFRA_PG_ADMIN_PASSWORD', '')
param pgAppPassword = readEnvironmentVariable('INFRA_PG_APP_PASSWORD', '')
param betterAuthSecret = readEnvironmentVariable('INFRA_BETTER_AUTH_SECRET', '')
param emailHashKey = readEnvironmentVariable('INFRA_EMAIL_HASH_KEY', '')
param tickSecret = readEnvironmentVariable('INFRA_TICK_SECRET', '')
