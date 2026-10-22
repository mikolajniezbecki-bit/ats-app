// The signed-in user of the current request (tech-stack.md AU5). The session
// and the user's role and active flag are read from the database on every
// request (the cookie cache is off) and memoized only within one request.
import "server-only";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { cache } from "react";
import { getDb } from "../db";
import { type USER_ROLES, users } from "../db/schema";
import { getAuth } from "./auth";

export type UserRole = (typeof USER_ROLES)[number];

export type CurrentUser = { id: string; email: string; name: string; role: UserRole };

/**
 * The user behind the session cookie in `requestHeaders`, or null when there
 * is no valid, unexpired session or the user is inactive. Better Auth slides
 * the session's expiry (AU6) while looking it up.
 */
export async function loadCurrentUser(requestHeaders: Headers): Promise<CurrentUser | null> {
  const result = await getAuth().api.getSession({ headers: requestHeaders });
  if (!result) return null;
  const [user] = await getDb()
    .select({ id: users.id, email: users.email, name: users.name, role: users.role, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, result.user.id));
  if (!user?.isActive) return null;
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

/** The current request's user; React's cache() makes it one lookup per request. */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => loadCurrentUser(await headers()));

/**
 * For protected route handlers: the signed-in user, or a 401 JSON response
 * when the session is missing, expired or belongs to an inactive user.
 * proxy.ts only checks that a cookie is present (§3 rule 6).
 */
export async function requireApiUser(request: Request): Promise<CurrentUser | Response> {
  const user = await loadCurrentUser(request.headers);
  return user ?? Response.json({ error: "unauthorized" }, { status: 401 });
}
