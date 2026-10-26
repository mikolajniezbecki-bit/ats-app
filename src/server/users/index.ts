// User management (ats-project-scope.md §5.1, §3; tech-stack.md AU2, AU5):
// Admins create users, change their role or name, deactivate and reactivate
// them. Emails are immutable (they link the Entra account on first sign-in,
// AU4). Deactivation deletes the user's sessions in the same transaction.
// Audit rows hold IDs and roles only, never names or emails (M2).
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { type Db, type Tx, getDb } from "../db";
import { USER_ROLES, auditLog, session, users } from "../db/schema";
import { logger } from "../logger";
import { APPROVER_ROLES, pendingApprovalsOf } from "../approvals/pending";

export type Role = (typeof USER_ROLES)[number];
export type UserRow = typeof users.$inferSelect;
export type UserSummary = { id: string; name: string; email: string; role: Role };

const role = z.enum(USER_ROLES);
const name = z.string().trim().min(1).max(200);

export const createUserSchema = z
  .object({ email: z.string().trim().toLowerCase().pipe(z.email()), name, role })
  .strict();

/** Only role and name change; the email is refused (strict). */
export const updateUserSchema = z
  .object({ role: role.optional(), name: name.optional() })
  .strict()
  .refine((value) => value.role !== undefined || value.name !== undefined, { message: "empty" });

export const pickerRolesSchema = z.array(role);

export type UserError =
  | "invalid"
  | "duplicate"
  | "duplicateInactive"
  | "notFound"
  | "ownRole"
  | "ownDeactivation"
  | "lastAdmin"
  | "pendingApprovals";

export type UserResult =
  | { ok: true; user: UserRow; changed: boolean }
  | { ok: false; reason: UserError; fields?: Record<string, string>; pending?: string[] };

/**
 * A5: refuses while the user is the approver of a pending requisition or
 * offer. Runs under the user's FOR UPDATE lock; submit, re-approval and
 * reassignment hold the chosen approver's row FOR SHARE, so a concurrent
 * one either commits first (and is counted here) or sees the change.
 */
async function pendingApprovalsBlock(tx: Tx, userId: string): Promise<UserResult | undefined> {
  const pending = await pendingApprovalsOf(tx, userId);
  return pending.length > 0 ? { ok: false, reason: "pendingApprovals", pending } : undefined;
}

function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") for (const key of issue.keys) fields[key] = "notEditable";
    else fields[String(issue.path[0] ?? "_")] ??= "invalid";
  }
  return fields;
}

function audit(tx: Tx, actorUserId: string, action: string, userId: string, details: Record<string, unknown>) {
  return tx.insert(auditLog).values({ actorUserId, action, subjectType: "USER", subjectId: userId, detailsJson: details });
}

/** Admin list, sorted by name; `status` filters by the active flag. */
export function listUsers(status: "active" | "inactive" | "all", db: Db | Tx = getDb()): Promise<UserRow[]> {
  const filter = status === "all" ? undefined : eq(users.isActive, status === "active");
  return db.select().from(users).where(filter).orderBy(asc(users.name), asc(users.email));
}

/**
 * Creates an active user with `email_verified = true` (AU4 linking needs it),
 * no password and no account row. A taken email, also by an inactive user,
 * is a duplicate.
 */
export async function createUser(tx: Tx, actorUserId: string, input: unknown): Promise<UserResult> {
  const parsed = createUserSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fields: fieldErrors(parsed.error) };
  const { email, name: userName, role: userRole } = parsed.data;

  const inserted = await tx
    .insert(users)
    .values({ email, name: userName, role: userRole, emailVerified: true, image: null, isActive: true })
    .onConflictDoNothing({ target: users.email })
    .returning();
  if (inserted.length === 0) {
    const [existing] = await tx.select({ isActive: users.isActive }).from(users).where(eq(users.email, email));
    return { ok: false, reason: existing?.isActive === false ? "duplicateInactive" : "duplicate" };
  }
  const [user] = inserted;
  await audit(tx, actorUserId, "USER_CREATED", user.id, { role: userRole });
  logger.info({ user_id: user.id, actor_user_id: actorUserId }, "user created");
  return { ok: true, user, changed: true };
}

/**
 * Locks the active Admins, so two concurrent demotions or deactivations can't
 * both see "another Admin is left". Returns their IDs.
 */
async function lockActiveAdmins(tx: Tx): Promise<string[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, "ADMIN"), eq(users.isActive, true)))
    .orderBy(asc(users.id))
    .for("update");
  return rows.map((row) => row.id);
}

/** True when `user` is the only active Admin left. */
async function isLastActiveAdmin(tx: Tx, user: UserRow): Promise<boolean> {
  if (user.role !== "ADMIN" || !user.isActive) return false;
  const admins = await lockActiveAdmins(tx);
  return admins.length <= 1 && admins.includes(user.id);
}

async function lockUser(tx: Tx, id: string): Promise<UserRow | undefined> {
  if (!z.uuid().safeParse(id).success) return undefined;
  const [user] = await tx.select().from(users).where(eq(users.id, id)).for("update");
  return user;
}

/**
 * Changes the role and/or name. An Admin can't change their own role; the
 * last active Admin can't be demoted; the approver of pending items can't
 * become a Recruiter or Interviewer (A5), but Hiring Manager ↔ Admin is
 * fine. The same role is a no-op; a name change writes no audit row (names
 * are personal data, M2).
 */
export async function updateUser(tx: Tx, actorUserId: string, id: string, input: unknown): Promise<UserResult> {
  const parsed = updateUserSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fields: fieldErrors(parsed.error) };
  // Admins first, then the user, in the same order everywhere (no deadlock).
  await lockActiveAdmins(tx);
  const user = await lockUser(tx, id);
  if (!user) return { ok: false, reason: "notFound" };

  const roleChanges = parsed.data.role !== undefined && parsed.data.role !== user.role;
  if (roleChanges && user.id === actorUserId) return { ok: false, reason: "ownRole" };
  if (roleChanges && (await isLastActiveAdmin(tx, user))) return { ok: false, reason: "lastAdmin" };
  if (roleChanges && !(APPROVER_ROLES as readonly Role[]).includes(parsed.data.role!)) {
    const blocked = await pendingApprovalsBlock(tx, id);
    if (blocked) return blocked;
  }
  const nameChanges = parsed.data.name !== undefined && parsed.data.name !== user.name;
  if (!roleChanges && !nameChanges) return { ok: true, user, changed: false };

  const [updated] = await tx
    .update(users)
    .set({ ...(roleChanges ? { role: parsed.data.role } : {}), ...(nameChanges ? { name: parsed.data.name } : {}) })
    .where(eq(users.id, id))
    .returning();
  if (roleChanges) {
    await audit(tx, actorUserId, "USER_ROLE_CHANGED", id, { fromRole: user.role, toRole: updated.role });
  }
  logger.info({ user_id: id, actor_user_id: actorUserId, role_changed: roleChanges, name_changed: nameChanges }, "user updated");
  return { ok: true, user: updated, changed: true };
}

/**
 * Deactivates the user and deletes all their sessions in one transaction,
 * so they are signed out on their next request (AU5). Other references stay
 * (§5.1), except that the approver of pending items is refused until they
 * are reassigned (A5). An already inactive user is left as is.
 */
export async function deactivateUser(tx: Tx, actorUserId: string, id: string): Promise<UserResult> {
  await lockActiveAdmins(tx);
  const user = await lockUser(tx, id);
  if (!user) return { ok: false, reason: "notFound" };
  if (!user.isActive) return { ok: true, user, changed: false };
  if (user.id === actorUserId) return { ok: false, reason: "ownDeactivation" };
  if (await isLastActiveAdmin(tx, user)) return { ok: false, reason: "lastAdmin" };
  const blocked = await pendingApprovalsBlock(tx, id);
  if (blocked) return blocked;

  const [updated] = await tx.update(users).set({ isActive: false }).where(eq(users.id, id)).returning();
  const deleted = await tx.delete(session).where(eq(session.userId, id)).returning({ id: session.id });
  await audit(tx, actorUserId, "USER_DEACTIVATED", id, { sessionsDeleted: deleted.length });
  logger.info({ user_id: id, actor_user_id: actorUserId, sessions_deleted: deleted.length }, "user deactivated");
  return { ok: true, user: updated, changed: true };
}

/** Reactivates an inactive user; an active one is left as is. */
export async function reactivateUser(tx: Tx, actorUserId: string, id: string): Promise<UserResult> {
  const user = await lockUser(tx, id);
  if (!user) return { ok: false, reason: "notFound" };
  if (user.isActive) return { ok: true, user, changed: false };
  const [updated] = await tx.update(users).set({ isActive: true }).where(eq(users.id, id)).returning();
  await audit(tx, actorUserId, "USER_REACTIVATED", id, {});
  logger.info({ user_id: id, actor_user_id: actorUserId }, "user reactivated");
  return { ok: true, user: updated, changed: true };
}

/**
 * The user picker (§5.1): active users only, with any of `roles` (all roles
 * when none are given), sorted by name. Used by the approver, recruiter,
 * hiring manager and interviewer pickers.
 */
export function listActiveUsers(options: { roles?: readonly Role[] } = {}, db: Db | Tx = getDb()): Promise<UserSummary[]> {
  const roles = options.roles && options.roles.length > 0 ? options.roles : undefined;
  return db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role })
    .from(users)
    .where(and(eq(users.isActive, true), roles ? inArray(users.role, [...roles]) : undefined))
    .orderBy(asc(users.name), asc(users.email));
}

