// Request correlation (tech-stack.md §13 M3): proxy.ts gives every request a
// fresh ID on the forwarded request and the response; server code reads it
// back from the request headers.
import { headers } from "next/headers";
import type { Logger } from "pino";
import { logger } from "./logger";

export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Copies the incoming headers and sets a fresh UUID v4 as the request ID.
 * A client-sent x-request-id is always replaced, never trusted.
 */
export function assignRequestId(incoming: Headers): { requestId: string; requestHeaders: Headers } {
  const requestId = crypto.randomUUID();
  const requestHeaders = new Headers(incoming);
  requestHeaders.set(REQUEST_ID_HEADER, requestId);
  return { requestId, requestHeaders };
}

/** The current request's ID, for server components, server actions and route handlers. */
export async function getRequestId(): Promise<string | undefined> {
  return (await headers()).get(REQUEST_ID_HEADER) ?? undefined;
}

/** A child logger bound to the current request's `request_id`. */
export async function getRequestLogger(): Promise<Logger> {
  return logger.child({ request_id: await getRequestId() });
}
