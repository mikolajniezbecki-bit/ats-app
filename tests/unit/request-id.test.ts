import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onRequestError } from "@/instrumentation";
import { proxy } from "@/proxy";
import { logger } from "@/server/logger";
import { REQUEST_ID_HEADER, assignRequestId } from "@/server/request-id";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("request ID", () => {
  it("M3: assigns a fresh UUID v4 per request and replaces a client-sent ID", () => {
    const incoming = new Headers({ [REQUEST_ID_HEADER]: "abc", accept: "text/html" });
    const first = assignRequestId(incoming);
    const second = assignRequestId(incoming);

    expect(first.requestId).toMatch(UUID_V4);
    expect(second.requestId).not.toBe(first.requestId);
    expect(first.requestHeaders.get(REQUEST_ID_HEADER)).toBe(first.requestId);
    expect(first.requestHeaders.get("accept")).toBe("text/html");
    expect(incoming.get(REQUEST_ID_HEADER)).toBe("abc");
  });

  it("M3: proxy returns the ID and forwards the same ID to server code", () => {
    const response = proxy(new NextRequest("http://localhost:3000/", { headers: { [REQUEST_ID_HEADER]: "abc" } }));
    const returned = response.headers.get(REQUEST_ID_HEADER);

    expect(returned).toMatch(UUID_V4);
    // NextResponse.next({ request: { headers } }) passes overridden request headers this way.
    expect(response.headers.get(`x-middleware-request-${REQUEST_ID_HEADER}`)).toBe(returned);
  });
});

describe("onRequestError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("M4: logs the error once with request_id and the path without its query string", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const err = new Error("boom");

    await onRequestError(
      err,
      { path: "/jobs/1?email=jane.doe@example.com", method: "GET", headers: { [REQUEST_ID_HEADER]: "req-1" } },
      {
        routerKind: "App Router",
        routePath: "/jobs/[id]",
        routeType: "render",
        renderSource: "react-server-components",
        revalidateReason: undefined,
      },
    );

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toMatchObject({ err, request_id: "req-1", path: "/jobs/1" });
    expect(JSON.stringify(error.mock.calls[0])).not.toContain("jane.doe");
  });
});
