// The first Admin of an environment (tech-stack.md AU8). Idempotent: an
// existing user with the email is promoted and reactivated instead of
// duplicated, which is also the way back in when no active Admin is left.
// Never sets a password: the Admin signs in with Entra (or dev sign-in).
import { eq } from "drizzle-orm";
import { z } from "zod";
import { type Tx, withTransaction } from "./index";
import { auditLog, users } from "./schema";

export type SeedAdminOutcome = "created" | "updated" | "unchanged";

export const seedAdminEmail = z.string().trim().toLowerCase().pipe(z.email());

/**
 * Creates or promotes the Admin for `email` in one transaction. Concurrent
 * runs are safe: the insert skips on the unique email, and the row is then
 * locked before it is read.
 */
export async function seedAdmin(input: { email: string; name?: string }): Promise<{ outcome: SeedAdminOutcome; userId: string }> {
  const email = seedAdminEmail.parse(input.email);
  const name = input.name?.trim() || email.split("@")[0];

  return withTransaction(async (tx) => {
    const [inserted] = await tx
      .insert(users)
      .values({ email, name, role: "ADMIN", isActive: true, emailVerified: true, image: null })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id });
    if (inserted) {
      await audit(tx, inserted.id, {});
      return { outcome: "created", userId: inserted.id };
    }

    const [existing] = await tx
      .select({ id: users.id, role: users.role, isActive: users.isActive, emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.email, email))
      .for("update");
    if (existing.role === "ADMIN" && existing.isActive && existing.emailVerified) {
      return { outcome: "unchanged", userId: existing.id };
    }
    await tx.update(users).set({ role: "ADMIN", isActive: true, emailVerified: true }).where(eq(users.id, existing.id));
    await audit(tx, existing.id, { previousRole: existing.role, wasActive: existing.isActive });
    return { outcome: "updated", userId: existing.id };
  });
}

/** `ADMIN_SEEDED` with no actor (a system action); details hold no personal data. */
function audit(tx: Tx, userId: string, details: Record<string, unknown>) {
  return tx
    .insert(auditLog)
    .values({ actorUserId: null, action: "ADMIN_SEEDED", subjectType: "USER", subjectId: userId, detailsJson: details });
}
