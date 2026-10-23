// The CSP and nosniff headers set by proxy.ts (tech-stack.md §3 rule 6c, §8;
// ats-project-scope.md F5).
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contentSecurityPolicy, createNonce, isHtmlPagePath } from "@/server/security-headers";

const composeLike = {
  APP_ENV: "ci",
  DATABASE_URL: "postgres://ats:pw@localhost:5432/ats",
  BETTER_AUTH_SECRET: "test",
  BETTER_AUTH_URL: "http://localhost:3000",
  EMAIL_HASH_KEY: "test",
  EMAIL_PROVIDER: "smtp",
  SMTP_HOST: "mailpit",
  SMTP_PORT: "1025",
  AZURE_STORAGE_CONNECTION_STRING:
    "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=a2V5;BlobEndpoint=http://azurite:10000/devstoreaccount1;",
  AZURE_STORAGE_PUBLIC_URL: "http://localhost:10000/devstoreaccount1",
  TURNSTILE_SITE_KEY: "test",
  TURNSTILE_SECRET_KEY: "test",
  TICK_SECRET: "test",
};

describe("contentSecurityPolicy()", () => {
  it("F5: is the restrictive policy with the nonce and the Blob origin as frame-src", () => {
    expect(contentSecurityPolicy({ nonce: "abc", frameOrigin: "http://localhost:10000", dev: false })).toBe(
      "default-src 'self'; script-src 'self' 'nonce-abc' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src http://localhost:10000; " +
        "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    );
  });

  it("adds 'unsafe-eval' only for next dev", () => {
    expect(contentSecurityPolicy({ nonce: "n", frameOrigin: "http://localhost:10000", dev: true })).toContain(
      "script-src 'self' 'nonce-n' 'strict-dynamic' 'unsafe-eval';",
    );
    expect(contentSecurityPolicy({ nonce: "n", frameOrigin: "http://localhost:10000", dev: false })).not.toContain("unsafe-eval");
  });

  it("F5: refuses * or a source with a path as frame-src", () => {
    expect(() => contentSecurityPolicy({ nonce: "n", frameOrigin: "*", dev: false })).toThrow();
    expect(() => contentSecurityPolicy({ nonce: "n", frameOrigin: "http://localhost:10000/devstoreaccount1", dev: false })).toThrow();
  });

  it("creates a fresh nonce each time", () => {
    const a = createNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(createNonce()).not.toBe(a);
  });

  it("treats pages as HTML, but not API routes or static files", () => {
    expect(isHtmlPagePath("/files/123")).toBe(true);
    expect(isHtmlPagePath("/")).toBe(true);
    expect(isHtmlPagePath("/api/health")).toBe(false);
    expect(isHtmlPagePath("/_next/static/chunk.js")).toBe(false);
    expect(isHtmlPagePath("/logo.png")).toBe(false);
  });
});

describe("proxy security headers", () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(composeLike)) vi.stubEnv(key, value);
  });
  afterEach(() => vi.unstubAllEnvs());

  async function run(path: string, cookie = true) {
    vi.resetModules();
    const { proxy } = await import("@/proxy");
    const headers = new Headers(cookie ? { cookie: "__Secure-better-auth.session_token=abc" } : {});
    return proxy(new NextRequest(`http://localhost:3000${path}`, { headers }));
  }

  it("F5: a page gets the CSP with frame-src http://localhost:10000 and a fresh nonce per request, plus nosniff", async () => {
    const first = await run("/files/123");
    const second = await run("/files/123");
    const csp = first.headers.get("content-security-policy")!;
    expect(csp).toContain("frame-src http://localhost:10000;");
    expect(csp).not.toContain("azurite");
    expect(first.headers.get("x-content-type-options")).toBe("nosniff");
    const nonce = (value: string | null) => /'nonce-([^']+)'/.exec(value ?? "")?.[1];
    expect(nonce(csp)).toBeDefined();
    expect(nonce(second.headers.get("content-security-policy"))).not.toBe(nonce(csp));
    // Forwarded to Next.js, which nonces its scripts from the request header.
    expect(first.headers.get("x-middleware-request-content-security-policy")).toBe(csp);
  });

  it("F5: the sign-in redirect also carries the CSP; API routes get nosniff but no CSP", async () => {
    const redirect = await run("/dashboard", false);
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("content-security-policy")).toContain("frame-src http://localhost:10000;");

    const api = await run("/api/health");
    expect(api.headers.get("content-security-policy")).toBeNull();
    expect(api.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
