// Runs before every integration test file: points DATABASE_URL at this
// worker's own database (ats_test_<pool id>), cloned from the migrated
// template on the worker's first file. Workers never share a database (T2).
import { afterAll, inject } from "vitest";
import { stopJobQueue } from "@/server/adapters/job-queue";
import { closeDb } from "@/server/db";
import { TEMPLATE_DATABASE, WORKER_DATABASE_PREFIX, databaseUrlFor, quoteIdent, withAdminClient } from "./database";

// Test-only placeholders so getConfig() validates; DATABASE_URL is set below.
const TEST_ENV: Record<string, string> = {
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
  LOG_LEVEL: "silent",
};

const baseUrl = inject("integrationDatabaseUrl");
const database = `${WORKER_DATABASE_PREFIX}${process.env.VITEST_POOL_ID ?? "1"}`;

await withAdminClient(baseUrl, async (client) => {
  const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
  if (rowCount === 0) {
    await client.query(`CREATE DATABASE ${quoteIdent(database)} TEMPLATE ${quoteIdent(TEMPLATE_DATABASE)}`);
  }
});

process.env.DATABASE_URL = databaseUrlFor(baseUrl, database);
for (const [key, value] of Object.entries(TEST_ENV)) process.env[key] ??= value;

afterAll(async () => {
  await stopJobQueue();
  await closeDb();
});
