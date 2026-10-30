// The Azure `tick` job's client (tech-stack.md G5, W4; task 44 Q8): sends
// `POST {BETTER_AUTH_URL}/api/internal/tick` with the tick secret and reports
// the JSON summary. The image has no curl, so this is a compiled entry point
// (tick-cli.ts → /app/db/tick.mjs).
import { TICK_SECRET_HEADER } from "../server/domain/tick";

/** The tick returns within 180 s (W4); Container Apps cuts requests at 240 s. */
export const TICK_CLIENT_TIMEOUT_MS = 230_000;

export type TickClientOptions = {
  baseUrl: string;
  secret: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export type TickResult = { ok: boolean; status: number | null; body: string };

/** Calls the tick once. Never throws: a network error or timeout is a failed result with `status: null`. */
export async function callTick({
  baseUrl,
  secret,
  timeoutMs = TICK_CLIENT_TIMEOUT_MS,
  fetch: fetchFn = fetch,
}: TickClientOptions): Promise<TickResult> {
  const url = new URL("/api/internal/tick", baseUrl);
  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: { [TICK_SECRET_HEADER]: secret },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text();
    return { ok: response.status === 200, status: response.status, body };
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    const message = name === "TimeoutError" ? `no response within ${timeoutMs} ms` : String((err as Error).message ?? err);
    return { ok: false, status: null, body: message };
  }
}
