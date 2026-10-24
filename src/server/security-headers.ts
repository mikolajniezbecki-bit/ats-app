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

/** Cloudflare Turnstile, allowed on the apply pages only (F6). */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/**
 * The CSP for HTML pages. `frameOrigin` is the browser-facing Blob origin
 * (never `*`); `dev` adds `'unsafe-eval'`, which only `next dev` needs;
 * `turnstile` adds the Turnstile origin to script-src and frame-src.
 */
export function contentSecurityPolicy({
  nonce,
  frameOrigin,
  dev,
  turnstile = false,
}: {
  nonce: string;
  frameOrigin: string;
  dev: boolean;
  turnstile?: boolean;
}): string {
  if (frameOrigin === "*" || !/^https?:\/\/[^/]+$/.test(frameOrigin)) {
    throw new Error("frame-src must be one http(s) origin");
  }
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}${turnstile ? ` ${TURNSTILE_ORIGIN}` : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    `frame-src ${frameOrigin}${turnstile ? ` ${TURNSTILE_ORIGIN}` : ""}`,
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

/** The nonce of a CSP header value, for scripts a page adds itself. */
export function nonceFromCsp(csp: string | null): string | undefined {
  return csp ? /'nonce-([^']+)'/.exec(csp)?.[1] : undefined;
}
