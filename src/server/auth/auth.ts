// Better Auth (tech-stack.md §4, AU1–AU7, AU10). The instance is created on
// the first getAuth() call and never at import time, so `next build` needs
// neither a database nor secrets (W1).
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import { type AppConfig, getConfig } from "../config";
import { getDb } from "../db";
import { account, session, users, verification } from "../db/schema";
import { MissingIdentityError, mapProfileToUser } from "./microsoft-profile";
import { SIGN_IN_PATH } from "./sign-in-errors";

/** AU6: 8 h sessions, refreshed (sliding) at most once an hour. */
export const SESSION_EXPIRES_IN_SECONDS = 8 * 60 * 60;
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60;

/** AU2/AU5: shown to unknown (Entra) and inactive users. */
export const ACCESS_NOT_GRANTED = "Access not granted, contact your ATS admin.";
export const ACCESS_NOT_GRANTED_CODE = "ACCESS_NOT_GRANTED";

/**
 * AU10: users are Admin-managed (§5.1), so every self-service endpoint is
 * off. Disabled paths return 404.
 */
export const DISABLED_AUTH_PATHS = [
  "/update-user",
  "/change-email",
  "/change-password",
  "/set-password",
  "/delete-user",
  "/request-password-reset",
  "/reset-password",
  "/link-social",
  "/unlink-account",
] as const;

/**
 * AU1–AU4: the Microsoft provider for the single project tenant, or none when
 * the Microsoft variables are not set (getConfig() requires all three or none).
 */
function microsoftProvider(microsoft: AppConfig["auth"]["microsoft"]) {
  if (!microsoft) return {};
  return {
    microsoft: {
      clientId: microsoft.clientId,
      clientSecret: microsoft.clientSecret,
      // A GUID, never `common` or `organizations`: only the owner's tenant (AU1).
      tenantId: microsoft.tenantId,
      // AU2: invite-only. The first alone would still let a client send
      // `requestSignUp: true`.
      disableImplicitSignUp: true,
      disableSignUp: true,
      // AU3: the photo is discarded anyway, so Graph is never called.
      disableProfilePhoto: true,
      // Admin-maintained name and email stay as they are.
      overrideUserInfoOnSignIn: false,
      mapProfileToUser(profile: { email?: string | null; preferred_username?: string | null }) {
        // Better Auth's type has no `null` image; `undefined` replaces the
        // profile picture all the same, and the column stays NULL.
        try {
          return { email: mapProfileToUser(profile).email, image: undefined };
        } catch (error) {
          // An empty email makes Better Auth refuse with `email_not_found`,
          // which /sign-in shows as the AU2 message, instead of a 500.
          if (error instanceof MissingIdentityError) return { email: "", image: undefined };
          throw error;
        }
      },
    },
  };
}

export function createAuth(config: AppConfig) {
  return betterAuth({
    secret: config.auth.secret,
    baseURL: config.auth.url,
    basePath: "/api/auth",
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: { user: users, session, account, verification },
    }),
    telemetry: { enabled: false },
    user: {
      // `role` and `is_active` are read by the app but never written through
      // the auth API (AU10).
      additionalFields: {
        role: { type: "string", required: false, input: false },
        isActive: { type: "boolean", required: false, input: false, defaultValue: true },
      },
    },
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      // Off, so every lookup reads the database and AU5 applies at once.
      cookieCache: { enabled: false },
    },
    // AU7: password sign-in exists only for dev sign-in, never with sign-up.
    emailAndPassword: { enabled: config.auth.devLogin, disableSignUp: true },
    disabledPaths: [...DISABLED_AUTH_PATHS],
    socialProviders: microsoftProvider(config.auth.microsoft),
    account: {
      // AU4: the first Entra sign-in links to the Admin-created user with the
      // same email (`email_verified = true`); later ones match the account ID.
      accountLinking: { enabled: true, trustedProviders: ["microsoft"] },
    },
    // AU2: refused OAuth sign-ins land on /sign-in?error=<code>, which never
    // echoes the code.
    onAPIError: { errorURL: `${config.auth.url}${SIGN_IN_PATH}` },
    // AU7: F6 is the only rate limit; Better Auth's reads the first
    // x-forwarded-for entry, which §3 rule 9 forbids.
    rateLimit: { enabled: false },
    advanced: {
      // AU6: Secure even on http://localhost (Chromium accepts it there).
      useSecureCookies: true,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
      database: { generateId: "uuid" },
      // §3 rule 9: no client IP from the first x-forwarded-for entry is stored.
      ipAddress: { disableIpTracking: true },
    },
    databaseHooks: {
      session: {
        create: {
          // AU5: never a session for an inactive user, whatever the sign-in path.
          before: async (newSession) => {
            const [user] = await getDb()
              .select({ isActive: users.isActive })
              .from(users)
              .where(eq(users.id, newSession.userId));
            if (!user?.isActive) {
              throw new APIError("FORBIDDEN", { message: ACCESS_NOT_GRANTED, code: ACCESS_NOT_GRANTED_CODE });
            }
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

// Outside production the instance lives on globalThis, so hot reload reuses it.
const globalForAuth = globalThis as typeof globalThis & { __atsAuth?: Auth };

/** The auth instance of this process, created on first use. */
export function getAuth(): Auth {
  globalForAuth.__atsAuth ??= createAuth(getConfig());
  return globalForAuth.__atsAuth;
}
