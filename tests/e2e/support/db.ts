// Direct database access for specs: checks and the few changes a spec makes
// to its own throwaway users (T4). Never to the four shared e2e users.
import pg from "pg";
import { E2E_DATABASE_URL } from "./env";

let pool: pg.Pool | undefined;

export function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: E2E_DATABASE_URL, max: 2 });
  return pool;
}

export async function query<T extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await db().query<T>(text, values)).rows;
}
