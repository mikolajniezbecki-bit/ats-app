// Security headers set by proxy.ts (tech-stack.md §3 rule 6c, §8;
// ats-project-scope.md F5): a nonce-based Content Security Policy on HTML
// pages and `X-Content-Type-Options: nosniff` on every response. They are set
// at run time, because `frame-src` depends on configuration and next.config
// headers are fixed at build time. Pure: no configuration reads here.

export const CSP_HEADER = "Content-Security-Policy";

/** A fresh base64 nonce for one request. */
export function createNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

/**
 * The CSP for HTML pages. `frameOrigin` is the browser-facing Blob origin
 * (never `*`); `dev` adds `'unsafe-eval'`, which only `next dev` needs.
 */
export function contentSecurityPolicy({ nonce, frameOrigin, dev }: { nonce: string; frameOrigin: string; dev: boolean }): string {
  if (frameOrigin === "*" || !/^https?:\/\/[^/]+$/.test(frameOrigin)) {
    throw new Error("frame-src must be one http(s) origin");
  }
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    `frame-src ${frameOrigin}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** HTML pages get the CSP; API routes and static files don't. */
export function isHtmlPagePath(pathname: string): boolean {
  return !pathname.startsWith("/api/") && !pathname.startsWith("/_next/") && !/\.[A-Za-z0-9]+$/.test(pathname);
}
