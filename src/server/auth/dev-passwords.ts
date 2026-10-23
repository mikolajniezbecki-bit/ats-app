// Dev sign-in passwords (tech-stack.md AU7): the `credential` account that
// Better Auth's email-and-password sign-in checks. Shared by ensureDevUser()
// (e2e users) and the demo seed, which sets passwords without touching the
// user's role, name or active flag (D8).
import { and, eq } from "drizzle-orm";
import type { Tx } from "../db";
import { account } from "../db/schema";
import { getAuth } from "./auth";

/** Hashes with Better Auth's own hasher, so sign-in can verify it. */
export async function hashDevPassword(password: string): Promise<string> {
  return (await getAuth().$context).password.hash(password);
}

/** Creates or updates the user's `credential` account with `password`. */
export async function setDevPassword(tx: Tx, userId: string, password: string): Promise<void> {
  const hash = await hashDevPassword(password);
  const credential = and(eq(account.userId, userId), eq(account.providerId, "credential"));
  const [existing] = await tx.select({ id: account.id }).from(account).where(credential);
  if (existing) {
    await tx.update(account).set({ password: hash }).where(eq(account.id, existing.id));
  } else {
    await tx.insert(account).values({ userId, providerId: "credential", accountId: userId, password: hash });
  }
}
