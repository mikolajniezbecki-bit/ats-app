// Only onRequestError for now (M4); task 8 adds register() with getConfig().
import type { Instrumentation } from "next";

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
