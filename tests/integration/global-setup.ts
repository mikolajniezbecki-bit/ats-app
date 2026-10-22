// Runs once per `pnpm test:integration`: drops the databases of earlier runs,
// then creates and migrates the template database every worker clones (T2).
import type { TestProject } from "vitest/node";
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

  await runMigrations(databaseUrlFor(baseUrl, TEMPLATE_DATABASE), "src/server/db/migrations");

  project.provide("integrationDatabaseUrl", baseUrl);
}
