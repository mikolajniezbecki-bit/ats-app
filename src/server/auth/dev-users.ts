// Dev sign-in users (tech-stack.md AU7, T4): creates or updates a user and its
// password (`credential`) account. Used by the Playwright setup and, from
// task 17, by the demo seed. Refuses to run unless AUTH_DEV_LOGIN=true.
import { type AppConfig, getConfig } from "../config";
import { withTransaction } from "../db";
import { users } from "../db/schema";
import type { UserRole } from "./current-user";
import { setDevPassword } from "./dev-passwords";

export type DevUser = { email: string; name: string; role: UserRole; password: string };

/**
 * Makes sure the user exists, is active, has `email_verified = true`, the
 * given name and role, and signs in with `password` (hashed with Better
 * Auth's hasher). Returns the user ID.
 */
export async function ensureDevUser(input: DevUser, config: AppConfig = getConfig()): Promise<string> {
  if (!config.auth.devLogin) throw new Error("ensureDevUser() runs only with AUTH_DEV_LOGIN=true (AU7)");
  const email = input.email.toLowerCase();

  return withTransaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ email, name: input.name, role: input.role, isActive: true, emailVerified: true })
      .onConflictDoUpdate({
        target: users.email,
        set: { name: input.name, role: input.role, isActive: true, emailVerified: true },
      })
      .returning({ id: users.id });

    await setDevPassword(tx, user.id, input.password);
    return user.id;
  });
}
