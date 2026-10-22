// Builds the node-postgres pool options from a connection string (D5). Pure,
// so the TLS decision is unit-tested without a database.
import type { PoolConfig } from "pg";

/** sslmode values that mean "no TLS"; anything else (Azure: `require`) means verified TLS. */
const NO_TLS_MODES = new Set(["disable"]);

export const POOL_MAX = 10;

/** Fail fast instead of hanging when PostgreSQL is down or unreachable. */
export const CONNECTION_TIMEOUT_MS = 5_000;

/**
 * TLS follows `sslmode` in the URL: absent or `disable` (Compose) connects in
 * plain text; any other mode (`require` in Azure, tech-stack.md §3) connects
 * with TLS and full certificate verification. `sslmode` is removed from the
 * string because node-postgres would otherwise parse it and override `ssl`
 * (pg-connection-string's meaning of `require` is changing between versions).
 */
export function buildPoolOptions(connectionString: string, overrides: Partial<PoolConfig> = {}): PoolConfig {
  const url = new URL(connectionString);
  const sslmode = url.searchParams.get("sslmode");
  url.searchParams.delete("sslmode");

  return {
    connectionString: url.toString(),
    ssl: sslmode === null || NO_TLS_MODES.has(sslmode) ? false : { rejectUnauthorized: true },
    max: POOL_MAX,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    ...overrides,
  };
}
