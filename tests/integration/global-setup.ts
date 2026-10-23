// Runs once per `pnpm test:integration`: drops the databases of earlier runs,
// then creates and migrates the template database every worker clones (T2),
// including the pgboss schema and queues, and makes sure Azurite has the
// private `files` container (tech-stack.md §8).
import type { TestProject } from "vitest/node";
import { ensureJobQueues } from "@/server/adapters/job-queue";
import { createStorageService } from "@/server/adapters/storage";
import { createPool } from "@/server/db";
import { runMigrations } from "@/server/db/migrator";
import {
  TEMPLATE_DATABASE,
  WORKER_DATABASE_PREFIX,
  baseDatabaseUrl,
  databaseUrlFor,
  quoteIdent,
  withAdminClient,
} from "./database";

declare module "vitest" {
  export interface ProvidedContext {
    integrationDatabaseUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<void> {
  const baseUrl = baseDatabaseUrl();

  await withAdminClient(baseUrl, async (client) => {
    const { rows } = await client.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE starts_with(datname, $1)",
      [WORKER_DATABASE_PREFIX],
    );
    for (const { datname } of rows) {
      await client.query(`DROP DATABASE ${quoteIdent(datname)} WITH (FORCE)`);
    }
    await client.query(`CREATE DATABASE ${quoteIdent(TEMPLATE_DATABASE)}`);
  });

  const templateUrl = databaseUrlFor(baseUrl, TEMPLATE_DATABASE);
  await runMigrations(templateUrl, "src/server/db/migrations");
  // The pgboss schema and the four queues, as db:migrate creates them (J5).
  const pool = createPool(templateUrl, { max: 2 });
  try {
    await ensureJobQueues({ pool });
  } finally {
    await pool.end();
  }

  // Azurite starts empty; the workers use the same connection string (worker-setup.ts).
  const storage = createStorageService({
    mode: "connectionString",
    connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING ?? "UseDevelopmentStorage=true",
    publicUrl: undefined,
  });
  try {
    await storage.ensureContainer();
  } catch {
    throw new Error("Cannot reach Azurite for the integration tests. Start it with `docker compose up -d azurite`.");
  }

  project.provide("integrationDatabaseUrl", baseUrl);
}
