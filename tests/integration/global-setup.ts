// Runs once per `pnpm test:integration`: drops the databases of earlier runs,
// then creates and migrates the template database every worker clones (T2),
// including the pgboss schema and queues.
import type { TestProject } from "vitest/node";
import { ensureJobQueues } from "@/server/adapters/job-queue";
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

  project.provide("integrationDatabaseUrl", baseUrl);
}
