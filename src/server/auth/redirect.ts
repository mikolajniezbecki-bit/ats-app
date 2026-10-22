// Where to go after sign-in (tech-stack.md §3 rule 6): only a relative path
// is accepted, so a crafted link can't send a user to another site.

export const DEFAULT_SIGNED_IN_PATH = "/dashboard";

/** `next` if it is a relative path (one leading `/`, not `//` or `/\`), otherwise `/dashboard`. */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return DEFAULT_SIGNED_IN_PATH;
  return next;
}

/** The sign-in URL that returns to `pathWithQuery` afterwards. */
export function signInUrl(pathWithQuery: string): string {
  return `/sign-in?next=${encodeURIComponent(pathWithQuery)}`;
}
