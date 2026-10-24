// Apply anti-spam building blocks (ats-project-scope.md F6; tech-stack.md §3
// rules 6 and 9): client IP, rate-limit key and bypass rule, the Turnstile
// client with a fake HTTP client, and the CSP on the apply pages only.
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "@/proxy";
import { SITEVERIFY_URL, createTurnstileService } from "@/server/adapters/captcha";
import { getClientIp, rateLimitKeyForIp } from "@/server/http/client-ip";
import { shouldEnforceRateLimit } from "@/server/ratelimit";
import { nonceFromCsp } from "@/server/security-headers";

const headers = (values: Record<string, string>) => new Headers(values);

describe("getClientIp", () => {
  it("uses x-envoy-external-address first, over x-forwarded-for", () => {
    expect(getClientIp(headers({ "x-envoy-external-address": "203.0.113.7", "x-forwarded-for": "198.51.100.1" }))).toEqual({ ip: "203.0.113.7", source: "envoy" });
  });

  it("F6: uses the last x-forwarded-for entry and ignores a client-set first entry", () => {
    expect(getClientIp(headers({ "x-forwarded-for": "6.6.6.6, 10.0.0.1" }))).toEqual({ ip: "10.0.0.1", source: "xff-last" });
  });

  it("takes a single entry and trims spaces around entries", () => {
    expect(getClientIp(headers({ "x-forwarded-for": " 198.51.100.4 " })).ip).toBe("198.51.100.4");
    expect(getClientIp(headers({ "x-forwarded-for": "1.1.1.1 ,  2001:db8::1  " })).ip).toBe("2001:db8::1");
  });

  it("an invalid envoy header falls back to x-forwarded-for; invalid values count as absent", () => {
    expect(getClientIp(headers({ "x-envoy-external-address": "unknown", "x-forwarded-for": "198.51.100.9" }))).toEqual({ ip: "198.51.100.9", source: "xff-last" });
    for (const value of ["", "unknown", "198.51.100.9:443", "garbage", "1.1.1.1, nonsense"]) {
      expect(getClientIp(headers({ "x-forwarded-for": value })), value).toEqual({ ip: "127.0.0.1", source: "fallback" });
    }
  });

  it("no headers give 127.0.0.1", () => {
    expect(getClientIp(headers({}))).toEqual({ ip: "127.0.0.1", source: "fallback" });
  });
});

describe("rateLimitKeyForIp", () => {
  it("keys IPv4 by address and IPv4-mapped IPv6 as IPv4", () => {
    expect(rateLimitKeyForIp("203.0.113.7")).toBe("apply:203.0.113.7");
    expect(rateLimitKeyForIp("::ffff:203.0.113.7")).toBe("apply:203.0.113.7");
  });

  it("keys IPv6 by its /64, so addresses inside one /64 share a key", () => {
    expect(rateLimitKeyForIp("2001:db8:aa:bb:1:2:3:4")).toBe("apply:2001:db8:aa:bb::/64");
    expect(rateLimitKeyForIp("2001:db8:aa:bb::ffff")).toBe("apply:2001:db8:aa:bb::/64");
    expect(rateLimitKeyForIp("2001:DB8::1")).toBe("apply:2001:db8:0:0::/64");
    expect(rateLimitKeyForIp("2001:db8:aa:bc::1")).not.toBe(rateLimitKeyForIp("2001:db8:aa:bb::1"));
  });
});

describe("shouldEnforceRateLimit", () => {
  it("F6: dev login without the header bypasses; with it enforces", () => {
    expect(shouldEnforceRateLimit({ authDevLogin: true, headerValue: null })).toBe(false);
    expect(shouldEnforceRateLimit({ authDevLogin: true, headerValue: "true" })).toBe(true);
  });

  it("F6: without dev login the limit always applies and the header is ignored", () => {
    expect(shouldEnforceRateLimit({ authDevLogin: false, headerValue: null })).toBe(true);
    expect(shouldEnforceRateLimit({ authDevLogin: false, headerValue: "false" })).toBe(true);
  });
});

describe("Turnstile CaptchaService", () => {
  const fakeFetch = (respond: () => Promise<Response>) => {
    const calls: { url: string; body: URLSearchParams }[] = [];
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as URLSearchParams });
      return respond();
    }) as unknown as typeof fetch;
    return { fn, calls };
  };

  it("F6: success gives ok, and the request carries the secret, the token and remoteip", async () => {
    const { fn, calls } = fakeFetch(async () => Response.json({ success: true }));
    expect(await createTurnstileService({ secretKey: "secret", fetch: fn }).verify("token-1", "203.0.113.7")).toEqual({ ok: true });
    expect(calls[0].url).toBe(SITEVERIFY_URL);
    expect(Object.fromEntries(calls[0].body)).toEqual({ secret: "secret", response: "token-1", remoteip: "203.0.113.7" });
  });

  it("F6: success false, HTTP 500, a timeout, a network error and a missing token all fail closed", async () => {
    const service = (respond: () => Promise<Response>, timeoutMs?: number) => createTurnstileService({ secretKey: "s", fetch: fakeFetch(respond).fn, timeoutMs });
    expect(await service(async () => Response.json({ success: false, "error-codes": ["invalid-input-response"] })).verify("t", "1.1.1.1")).toEqual({
      ok: false,
      reason: "invalid-input-response",
    });
    expect(await service(async () => new Response("oops", { status: 500 })).verify("t", "1.1.1.1")).toEqual({ ok: false, reason: "http-500" });
    expect(await service(async () => Promise.reject(new TypeError("fetch failed"))).verify("t", "1.1.1.1")).toEqual({ ok: false, reason: "network-error" });

    const slow = createTurnstileService({
      secretKey: "s",
      timeoutMs: 20,
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as unknown as typeof fetch,
    });
    expect(await slow.verify("t", "1.1.1.1")).toEqual({ ok: false, reason: "timeout" });

    const { fn, calls } = fakeFetch(async () => Response.json({ success: true }));
    expect(await createTurnstileService({ secretKey: "s", fetch: fn }).verify("", "1.1.1.1")).toMatchObject({ ok: false });
    expect(await createTurnstileService({ secretKey: "s", fetch: fn }).verify(null, "1.1.1.1")).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });
});

describe("CSP for Turnstile", () => {
  const csp = (path: string) => proxy(new NextRequest(`http://localhost:3000${path}`, { headers: { cookie: "__Secure-better-auth.session_token=a.b" } })).headers.get("content-security-policy")!;
  const directive = (policy: string, name: string) => policy.split("; ").find((part) => part.startsWith(`${name} `))!;

  it("F6: /apply/<id> allows https://challenges.cloudflare.com in script-src and frame-src", () => {
    const policy = csp("/apply/0b9b1c38-6f0c-4f87-9a37-5a0f5f0f0f0f");
    expect(directive(policy, "script-src")).toContain("https://challenges.cloudflare.com");
    expect(directive(policy, "frame-src")).toContain("https://challenges.cloudflare.com");
    expect(nonceFromCsp(policy)).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("F6: /jobs and /dashboard don't", () => {
    for (const path of ["/jobs", "/dashboard"]) expect(csp(path), path).not.toContain("challenges.cloudflare.com");
  });
});
