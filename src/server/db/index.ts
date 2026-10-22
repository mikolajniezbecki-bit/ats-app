// Database access (tech-stack.md §7): one lazily created pg.Pool per process
// (D5) and a transaction helper for domain services (D3). Nothing connects at
// import time, so `next build` needs no database (W1).
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { getConfig } from "../config";
import { logger } from "../logger";
import { buildPoolOptions } from "./pool-options";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
/** Transaction handle; domain services take it as their first parameter (D3). */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type DbState = { pool: pg.Pool; db: Db };

// Outside production the state lives on globalThis, so hot reload in
// `next dev` reuses the pool instead of opening a new one per reload.
const globalForDb = globalThis as typeof globalThis & { __atsDb?: DbState };
let state: DbState | undefined = globalForDb.__atsDb;

/** Creates a pool with the shared error listener; also used by db:migrate. */
export function createPool(connectionString: string, overrides?: pg.PoolConfig): pg.Pool {
  const pool = new pg.Pool(buildPoolOptions(connectionString, overrides));
  // An idle client dropped by the server emits here; without a listener the
  // process would crash. The error never contains the connection string.
  pool.on("error", (err: Error & { code?: string }) => {
    logger.error({ err: { message: err.message, code: err.code } }, "PostgreSQL pool error");
  });
  return pool;
}

/** The Drizzle instance; the pool is created on the first call. */
export function getDb(): Db {
  if (!state) {
    const pool = createPool(getConfig().databaseUrl);
    state = { pool, db: drizzle({ client: pool, schema }) };
    if (process.env.NODE_ENV !== "production") globalForDb.__atsDb = state;
  }
  return state.db;
}

/** Ends the pool; scripts and test teardown call it so the process can exit. */
export async function closeDb(): Promise<void> {
  const current = state;
  state = undefined;
  globalForDb.__atsDb = undefined;
  await current?.pool.end();
}

/**
 * Runs `fn(tx)` in one transaction: commits when it resolves, rolls back and
 * re-throws the original error when it rejects.
 */
export function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().transaction(fn);
}
