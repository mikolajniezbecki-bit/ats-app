// Refused sign-ins (tech-stack.md AU2): Better Auth redirects an OAuth
// failure to /sign-in?error=<code>. The page shows one of two fixed texts and
// never the code itself, which anyone can put in a link.

/** Where Better Auth sends a refused OAuth sign-in. */
export const SIGN_IN_PATH = "/sign-in";

/**
 * Codes that mean "no active ATS user for this account": Better Auth's
 * sign-up refusal (unknown email, AU2), the AU5 inactive-user hook
 * (`ACCESS_NOT_GRANTED_CODE` in auth.ts), and a profile without email or UPN
 * (AU3, refused by Better Auth as `email_not_found`).
 */
export const ACCESS_NOT_GRANTED_ERRORS: readonly string[] = ["signup_disabled", "ACCESS_NOT_GRANTED", "email_not_found"];

export type SignInErrorKey = "accessNotGranted" | "failed";

/** The `SignIn` message key for an `?error=` value, or null when there is none. */
export function signInErrorKey(error: string | string[] | undefined): SignInErrorKey | null {
  if (error === undefined || error === "") return null;
  return typeof error === "string" && ACCESS_NOT_GRANTED_ERRORS.includes(error) ? "accessNotGranted" : "failed";
}
