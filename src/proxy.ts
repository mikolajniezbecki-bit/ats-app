// tech-stack.md §3 rule 6: (a) the session cookie must be present outside the
// public paths, (b) every request gets a fresh request ID (M3), and (c) HTML
// pages get a nonce-based CSP whose frame-src is the Blob origin, and every
// response gets `nosniff` (§8, F5). Only the cookie's presence is checked: no
// database call and no role decision, which pages and route handlers make on
// the server (AU5, AU9).
import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { blobOrigin } from "@/server/adapters/storage/endpoints";
import { signInUrl } from "@/server/auth/redirect";
import { getConfig } from "@/server/config";
import { REQUEST_ID_HEADER, assignRequestId } from "@/server/request-id";
import { CSP_HEADER, contentSecurityPolicy, createNonce, isHtmlPagePath } from "@/server/security-headers";

/** Paths that need no session cookie: exact paths and prefixes ending in `/`. */
export const PUBLIC_PATHS = [
  "/",
  "/sign-in",
  "/api/auth/",
  // Has its own secret (W4).
  "/api/internal/tick",
  "/api/health",
  "/jobs",
  "/jobs/",
  "/apply/",
  "/sitemap.xml",
  "/robots.txt",
  "/_next/",
  "/favicon.ico",
] as const;

/** A top-level file name such as `/file.svg`: files served from `public/`. */
const PUBLIC_FILE = /^\/[^/]+\.[A-Za-z0-9]+$/;

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_FILE.test(pathname)) return true;
  return PUBLIC_PATHS.some((path) => (path.endsWith("/") && path !== "/" ? pathname.startsWith(path) : pathname === path));
}

export function proxy(request: NextRequest) {
  const { requestId, requestHeaders } = assignRequestId(request.headers);
  const { pathname, search } = request.nextUrl;

  // Next.js reads the nonce from the forwarded request's CSP header and puts
  // it on the scripts it renders; the browser enforces the response header.
  let csp: string | undefined;
  if (isHtmlPagePath(pathname)) {
    csp = contentSecurityPolicy({
      nonce: createNonce(),
      frameOrigin: blobOrigin(getConfig().storage),
      dev: process.env.NODE_ENV === "development",
      // Turnstile (F6) runs on the apply pages only.
      turnstile: pathname.startsWith("/apply/"),
    });
    requestHeaders.set(CSP_HEADER, csp);
  }

  let response: NextResponse;
  if (isPublicPath(pathname) || getSessionCookie(request)) {
    response = NextResponse.next({ request: { headers: requestHeaders } });
  } else if (pathname.startsWith("/api/")) {
    response = NextResponse.json({ error: "unauthorized" }, { status: 401 });
  } else {
    response = NextResponse.redirect(new URL(signInUrl(`${pathname}${search}`), request.url), 307);
  }
  response.headers.set(REQUEST_ID_HEADER, requestId);
  if (csp) response.headers.set(CSP_HEADER, csp);
  response.headers.set("X-Content-Type-Options", "nosniff");
  // Private postings (§5.2): never indexed, and links in them don't leak the slug.
  if (pathname.startsWith("/jobs/p/")) {
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    response.headers.set("Referrer-Policy", "no-referrer");
  }
  return response;
}

export const config = {
  // Static assets don't need a request ID.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
