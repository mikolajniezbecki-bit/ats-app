import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { isPublicPath, proxy } from "@/proxy";
import { safeNextPath, signInUrl } from "@/server/auth/redirect";
import { REQUEST_ID_HEADER } from "@/server/request-id";

const SESSION_COOKIE = "__Secure-better-auth.session_token=abc.def";

function request(path: string, cookie?: string) {
  return new NextRequest(`http://localhost:3000${path}`, { headers: cookie ? { cookie } : {} });
}

describe("public paths", () => {
  it.each([
    "/",
    "/sign-in",
    "/api/auth/get-session",
    "/api/auth/sign-in/email",
    "/api/internal/tick",
    "/api/health",
    "/jobs",
    "/jobs/123",
    "/jobs/p/abc",
    "/apply/123",
    "/sitemap.xml",
    "/robots.txt",
    "/_next/static/chunk.js",
    "/favicon.ico",
    "/file.svg",
  ])("%s needs no session cookie", (path) => {
    expect(isPublicPath(path)).toBe(true);
  });

  it.each(["/dashboard", "/admin", "/admin/users", "/api/admin/anything", "/sign-in/extra", "/jobsx", "/api/internal/other", "/a/b.svg"])(
    "%s needs the cookie",
    (path) => {
      expect(isPublicPath(path)).toBe(false);
    },
  );
});

describe("proxy", () => {
  it("redirects a protected page without the cookie to sign-in with next, keeping the request ID", () => {
    const response = proxy(request("/dashboard?tab=open"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/sign-in?next=%2Fdashboard%3Ftab%3Dopen");
    expect(response.headers.get(REQUEST_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns 401 JSON for a protected API route without the cookie", async () => {
    const response = proxy(request("/api/admin/anything"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(response.headers.get(REQUEST_ID_HEADER)).toBeTruthy();
  });

  it("never redirects the tick, which has its own secret (W4)", () => {
    const response = proxy(new NextRequest("http://localhost:3000/api/internal/tick", { method: "POST" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("lets a request with the session cookie through without checking it", () => {
    expect(proxy(request("/dashboard", SESSION_COOKIE)).headers.get("location")).toBeNull();
    expect(proxy(request("/api/admin/anything", SESSION_COOKIE)).status).toBe(200);
  });
});

describe("next after sign-in", () => {
  it.each([
    ["https://evil.example", "/dashboard"],
    ["//evil.example", "/dashboard"],
    ["/\\evil.example", "/dashboard"],
    ["evil", "/dashboard"],
    ["", "/dashboard"],
    [undefined, "/dashboard"],
    ["/\t/evil.example", "/dashboard"],
    ["/\n/evil.example", "/dashboard"],
    ["/\r/evil.example", "/dashboard"],
    ["/\n\\evil.example", "/dashboard"],
    [" //evil.example", "/dashboard"],
    ["/ /evil.example", "/dashboard"],
    ["/%09/evil.example", "/%09/evil.example"],
    ["/dashboard?x=1", "/dashboard?x=1"],
    ["/dashboard?x=1#top", "/dashboard?x=1#top"],
    ["/admin/users", "/admin/users"],
  ])("%s goes to %s", (next, expected) => {
    expect(safeNextPath(next)).toBe(expected);
  });

  it.each([
    "/.//evil.example",
    "/..//evil.example",
    "/a/..//evil.example",
    "/%2e//evil.example",
    "/%2E%2E//evil.example",
    "/./%2e//evil.example",
  ])("%s, which the parser cleans up to //evil.example, goes to /dashboard", (next) => {
    expect(safeNextPath(next)).toBe("/dashboard");
  });

  it("never sends the browser to another origin, for any mix of slashes, dots, encodings and whitespace", () => {
    // Every three-part combination of these pieces, followed by a host.
    const pieces = ["/", "\\", ".", "..", "%2e", "%2E%2e", "%2f", "%5c", "\t", "\n", "\r", " ", "\u0000", "a"];
    const base = "http://localhost:3000";
    for (const a of pieces) {
      for (const b of pieces) {
        for (const c of pieces) {
          const next = `/${a}${b}${c}/evil.example`;
          const result = safeNextPath(next);
          expect(result.startsWith("/") && !result.startsWith("//"), JSON.stringify(next)).toBe(true);
          // How window.location.assign() will read it.
          expect(new URL(result, base).origin, JSON.stringify(next)).toBe(base);
        }
      }
    }
  });

  it("encodes the path and query into the sign-in URL", () => {
    expect(signInUrl("/dashboard")).toBe("/sign-in?next=%2Fdashboard");
  });
});
