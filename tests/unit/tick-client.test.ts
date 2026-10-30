// The Azure tick job's client (tech-stack.md G5, W4): POSTs to the tick with
// the secret header, succeeds only on 200, and turns network errors and
// timeouts into failed results.
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { callTick } from "@/worker/tick-client";

let server: Server | undefined;

afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
  server = undefined;
});

type Seen = { method?: string; url?: string; secret?: string | string[] };

async function serve(status: number, body: string, delayMs = 0): Promise<{ baseUrl: string; seen: Seen }> {
  const seen: Seen = {};
  server = createServer((request, response) => {
    seen.method = request.method;
    seen.url = request.url;
    seen.secret = request.headers["x-tick-secret"];
    setTimeout(() => response.writeHead(status, { "content-type": "application/json" }).end(body), delayMs);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe("callTick", () => {
  it("POSTs to /api/internal/tick with the secret header and returns the summary on 200", async () => {
    const summary = JSON.stringify({ queued: [], waited: true, remainingDueJobs: 0, timedOut: false, durationMs: 5 });
    const { baseUrl, seen } = await serve(200, summary);

    const result = await callTick({ baseUrl, secret: "s3cret" });

    expect(seen).toEqual({ method: "POST", url: "/api/internal/tick", secret: "s3cret" });
    expect(result).toEqual({ ok: true, status: 200, body: summary });
  });

  it.each([401, 400, 500, 503])("fails on status %i", async (status) => {
    const { baseUrl } = await serve(status, JSON.stringify({ error: "x" }));
    expect(await callTick({ baseUrl, secret: "s" })).toMatchObject({ ok: false, status });
  });

  it("fails without throwing when the app doesn't answer in time", async () => {
    const { baseUrl } = await serve(200, "{}", 500);
    const result = await callTick({ baseUrl, secret: "s", timeoutMs: 50 });
    expect(result).toEqual({ ok: false, status: null, body: "no response within 50 ms" });
  });

  it("fails without throwing when the app can't be reached", async () => {
    const result = await callTick({ baseUrl: "http://127.0.0.1:1", secret: "s" });
    expect(result).toMatchObject({ ok: false, status: null });
  });
});
