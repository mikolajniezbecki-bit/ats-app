// Health checks (tech-stack.md M5): database and storage, concurrently, each
// with a 3 s timeout. The body is fixed: no host names, error text or
// secrets. A failure is logged with the error type only, never a connection
// string.
import { getStorage } from "./adapters/storage";
import { getPool } from "./db";
import { logger } from "./logger";

export const HEALTH_TIMEOUT_MS = 3_000;

type CheckResult = "ok" | "fail";
export type HealthBody = { status: "ok" | "fail"; database: CheckResult; storage: CheckResult };
type Check = (signal: AbortSignal) => Promise<unknown>;

async function runCheck(name: string, check: Check, timeoutMs: number): Promise<CheckResult> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new HealthTimeoutError());
    }, timeoutMs);
  });
  try {
    await Promise.race([check(controller.signal), timeout]);
    return "ok";
  } catch (err) {
    const type = err instanceof Error ? err.name : typeof err;
    const code = (err as { code?: unknown })?.code;
    logger.warn({ check: name, error_type: type, code: typeof code === "string" ? code : undefined }, "health check failed");
    return "fail";
  } finally {
    clearTimeout(timer);
  }
}

class HealthTimeoutError extends Error {
  override name = "HealthTimeoutError";
}

/** Runs both checks; `checks` and `timeoutMs` are injectable for tests. */
export async function runHealthChecks(
  checks: { database: Check; storage: Check } = {
    database: () => getPool().query("select 1"),
    storage: (signal) => getStorage().checkHealth(signal),
  },
  timeoutMs = HEALTH_TIMEOUT_MS,
): Promise<{ httpStatus: 200 | 503; body: HealthBody }> {
  const [database, storage] = await Promise.all([
    runCheck("database", checks.database, timeoutMs),
    runCheck("storage", checks.storage, timeoutMs),
  ]);
  const ok = database === "ok" && storage === "ok";
  return { httpStatus: ok ? 200 : 503, body: { status: ok ? "ok" : "fail", database, storage } };
}
