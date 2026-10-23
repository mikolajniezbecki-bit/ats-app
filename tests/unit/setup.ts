// Runs before every unit test file: a complete test-only configuration, so
// code that calls getConfig() (proxy.ts computes the CSP frame-src from it)
// works without a .env. Tests that check configuration errors set or clear
// process.env themselves. Mirrors tests/integration/worker-setup.ts.
const TEST_ENV: Record<string, string> = {
  DATABASE_URL: "postgres://ats:test-only@localhost:5432/ats",
  BETTER_AUTH_SECRET: "test-only-auth-secret",
  BETTER_AUTH_URL: "http://localhost:3000",
  APP_ENV: "ci",
  EMAIL_HASH_KEY: "test-only-hash-key",
  EMAIL_PROVIDER: "smtp",
  SMTP_HOST: "localhost",
  SMTP_PORT: "1025",
  AZURE_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true",
  TURNSTILE_SITE_KEY: "test-only-site-key",
  TURNSTILE_SECRET_KEY: "test-only-turnstile-secret",
  TICK_SECRET: "test-only-tick-secret",
};

for (const [key, value] of Object.entries(TEST_ENV)) process.env[key] ??= value;
