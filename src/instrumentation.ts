// Process start-up (W1) and unhandled request errors (M4).
import type { Instrumentation } from "next";

/**
 * Runs once when the server starts. Only on the Node.js runtime and never
 * during `next build`, so the build needs no database or secrets; Node-only
 * modules are loaded inside that branch.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { runWebProcess } = await import("./worker/startup");
  await runWebProcess();
}

export const onRequestError: Instrumentation.onRequestError = async (err, request) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { logger } = await import("./server/logger");
  const requestId = request.headers["x-request-id"];

  logger.error(
    {
      err,
      digest: typeof err === "object" && err !== null && "digest" in err ? String(err.digest) : undefined,
      request_id: typeof requestId === "string" ? requestId : undefined,
      method: request.method,
      // Query strings may contain personal data.
      path: request.path.split("?")[0],
    },
    "Unhandled request error",
  );
};
