// Where to go after sign-in (tech-stack.md §3 rule 6): only a relative path
// is accepted, so a crafted link can't send a user to another site.

export const DEFAULT_SIGNED_IN_PATH = "/dashboard";

// A placeholder origin: `next` must resolve against it to a URL on it.
const SAME_ORIGIN = "http://same-origin.invalid";

/**
 * `next` as a path on this site, or `/dashboard`. The value is resolved with
 * the WHATWG URL parser, the same one the browser uses: it drops tabs and
 * newlines and reads `\` as `/`, so `/\t/evil.example` or `/\evil.example`
 * would otherwise slip past a prefix check and leave the site. Anything with
 * whitespace or control characters, or that resolves to another origin, is
 * refused, and so is a result that the parser's own clean-up turns into
 * another origin.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || /[\s\u0000-\u001f\u007f\\]/.test(next)) return DEFAULT_SIGNED_IN_PATH;
  let url: URL;
  try {
    url = new URL(next, SAME_ORIGIN);
  } catch {
    return DEFAULT_SIGNED_IN_PATH;
  }
  if (url.origin !== SAME_ORIGIN) return DEFAULT_SIGNED_IN_PATH;
  // The parser resolves `.` and `..`, so `/.//evil.example` comes out as
  // `//evil.example`; the result is checked again, as the browser will read it.
  const path = `${url.pathname}${url.search}${url.hash}`;
  if (!isSameOriginPath(path)) return DEFAULT_SIGNED_IN_PATH;
  return path;
}

/** True when `path` starts with a single `/` and stays on the origin it is resolved against. */
function isSameOriginPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  try {
    return new URL(path, SAME_ORIGIN).origin === SAME_ORIGIN;
  } catch {
    return false;
  }
}

/** The sign-in URL that returns to `pathWithQuery` afterwards. */
export function signInUrl(pathWithQuery: string): string {
  return `/sign-in?next=${encodeURIComponent(pathWithQuery)}`;
}
