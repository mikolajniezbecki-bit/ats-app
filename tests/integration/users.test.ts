// User management through the API and the service (ats-project-scope.md
// §5.1, §3; tech-stack.md AU5, T5): create, role and name changes,
// deactivation with session deletion, reactivation, lock-out guards and the
// active-user picker.
import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { POST as deactivate } from "@/app/api/admin/users/[id]/deactivate/route";
import { POST as reactivate } from "@/app/api/admin/users/[id]/reactivate/route";
import { PATCH } from "@/app/api/admin/users/[id]/route";
import { POST } from "@/app/api/admin/users/route";
import { GET as picker } from "@/app/api/users/picker/route";
import { loadCurrentUser } from "@/server/auth/current-user";
import { getDb, withTransaction } from "@/server/db";
import { account, auditLog, requisitions, session, users } from "@/server/db/schema";
import { deactivateUser, listActiveUsers, updateUser } from "@/server/users";
import { insertRequisition, insertUser } from "./fixtures";
import { rolledBack } from "./helpers";
import { ORIGIN, signedIn } from "./sessions";

function request(method: string, path: string, body?: unknown, cookie?: string) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const create = (body: unknown, cookie?: string) => POST(request("POST", "/api/admin/users", body, cookie), undefined);
const patch = (id: string, body: unknown, cookie?: string) => PATCH(request("PATCH", `/api/admin/users/${id}`, body, cookie), params(id));
const deactivateCall = (id: string, cookie?: string) =>
  deactivate(request("POST", `/api/admin/users/${id}/deactivate`, undefined, cookie), params(id));
const reactivateCall = (id: string, cookie?: string) =>
  reactivate(request("POST", `/api/admin/users/${id}/reactivate`, undefined, cookie), params(id));
const pick = (query: string, cookie?: string) => picker(request("GET", `/api/users/picker?${query}`, undefined, cookie), undefined);

const newEmail = () => `user-${randomUUID()}@example.com`;

async function userRow(id: string) {
  const [row] = await getDb().select().from(users).where(eq(users.id, id));
  return row;
}
const auditFor = (userId: string) => getDb().select().from(auditLog).where(eq(auditLog.subjectId, userId));
const sessionCount = async (userId: string) => (await getDb().select().from(session).where(eq(session.userId, userId))).length;
const headersWith = (cookie: string) => new Headers({ cookie });

async function createdUser(cookie: string, body: Record<string, unknown>) {
  const response = await create(body, cookie);
  expect(response.status).toBe(201);
  return ((await response.json()) as { user: { id: string } }).user;
}

describe("create", () => {
  it("V1: an Admin creates an active, verified user without a password; the email is lower-cased; USER_CREATED is audited", async () => {
    const admin = await signedIn("ADMIN");
    const email = newEmail();
    const response = await create({ email: `  ${email.toUpperCase()} `, name: " Rita Recruiter ", role: "RECRUITER" }, admin.cookie);
    expect(response.status).toBe(201);
    const { user } = (await response.json()) as { user: { id: string } };

    expect(await userRow(user.id)).toMatchObject({ email, name: "Rita Recruiter", role: "RECRUITER", isActive: true, emailVerified: true, image: null });
    expect(await getDb().select().from(account).where(eq(account.userId, user.id))).toEqual([]);
    expect(await auditFor(user.id)).toEqual([
      expect.objectContaining({ action: "USER_CREATED", actorUserId: admin.userId, subjectType: "USER", detailsJson: { role: "RECRUITER" } }),
    ]);
  });

  it("a duplicate email returns 409, ignoring case and including inactive users", async () => {
    const admin = await signedIn("ADMIN");
    const email = newEmail();
    const user = await createdUser(admin.cookie, { email, name: "First", role: "INTERVIEWER" });

    const duplicate = await create({ email: email.toUpperCase(), name: "Second", role: "INTERVIEWER" }, admin.cookie);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "duplicate", message: "A user with this email already exists." });

    await deactivateCall(user.id, admin.cookie);
    const inactive = await create({ email, name: "Third", role: "INTERVIEWER" }, admin.cookie);
    expect(inactive.status).toBe(409);
    expect((await inactive.json()).message).toBe("A user with this email already exists but is inactive. Reactivate them instead.");
  });

  it("invalid input returns 400 with field errors", async () => {
    const admin = await signedIn("ADMIN");
    const response = await create({ email: "nope", name: "", role: "OWNER" }, admin.cookie);
    expect(response.status).toBe(400);
    expect((await response.json()).fields).toEqual({
      email: "Enter a valid email address.",
      name: "Enter 1 to 200 characters.",
      role: "Choose a role.",
    });
  });
});

describe("role and name", () => {
  it("a role change applies on the user's next request and is audited with fromRole and toRole", async () => {
    const admin = await signedIn("ADMIN");
    const target = await signedIn("RECRUITER");
    expect((await loadCurrentUser(headersWith(target.cookie)))?.role).toBe("RECRUITER");

    expect((await patch(target.userId, { role: "HIRING_MANAGER" }, admin.cookie)).status).toBe(200);
    expect((await loadCurrentUser(headersWith(target.cookie)))?.role).toBe("HIRING_MANAGER");
    expect(await auditFor(target.userId)).toEqual([
      expect.objectContaining({ action: "USER_ROLE_CHANGED", detailsJson: { fromRole: "RECRUITER", toRole: "HIRING_MANAGER" } }),
    ]);
  });

  it("the same role is a no-op, and a name change writes no audit row", async () => {
    const admin = await signedIn("ADMIN");
    const target = await createdUser(admin.cookie, { email: newEmail(), name: "Typo Nmae", role: "INTERVIEWER" });
    const before = (await auditFor(target.id)).length;

    expect(await (await patch(target.id, { role: "INTERVIEWER" }, admin.cookie)).json()).toMatchObject({ changed: false });
    expect(await (await patch(target.id, { name: "Typo Name" }, admin.cookie)).json()).toMatchObject({ changed: true });
    expect((await userRow(target.id)).name).toBe("Typo Name");
    expect(await auditFor(target.id)).toHaveLength(before);
  });

  it("sending an email returns 400: the email is immutable", async () => {
    const admin = await signedIn("ADMIN");
    const target = await createdUser(admin.cookie, { email: newEmail(), name: "Fixed", role: "INTERVIEWER" });
    const response = await patch(target.id, { email: newEmail() }, admin.cookie);
    expect(response.status).toBe(400);
    expect((await response.json()).fields).toMatchObject({ email: "The email can't be changed." });
  });

  it("an Admin can't change their own role", async () => {
    const admin = await signedIn("ADMIN");
    const response = await patch(admin.userId, { role: "RECRUITER" }, admin.cookie);
    expect(response.status).toBe(400);
    expect((await response.json()).message).toBe("You can't change your own role.");
    expect((await userRow(admin.userId)).role).toBe("ADMIN");
  });

  it("the last active Admin can't be demoted", async () => {
    await rolledBack(async (tx) => {
      const last = await insertUser(tx, "ADMIN");
      await tx.update(users).set({ isActive: false }).where(and(eq(users.role, "ADMIN"), ne(users.id, last.id)));
      const actor = (await insertUser(tx, "RECRUITER")).id;
      expect(await updateUser(tx, actor, last.id, { role: "RECRUITER" })).toEqual({ ok: false, reason: "lastAdmin" });
      // With a second active Admin it is allowed.
      await insertUser(tx, "ADMIN");
      expect(await updateUser(tx, actor, last.id, { role: "RECRUITER" })).toMatchObject({ ok: true, changed: true });
    });
  });
});

describe("deactivate and reactivate", () => {
  it("AU5: deactivation deletes all sessions, so the cookie no longer authenticates, and is audited", async () => {
    const admin = await signedIn("ADMIN");
    const target = await signedIn("RECRUITER");
    expect(await sessionCount(target.userId)).toBe(1);

    const response = await deactivateCall(target.userId, admin.cookie);
    expect(response.status).toBe(200);
    expect((await userRow(target.userId)).isActive).toBe(false);
    expect(await sessionCount(target.userId)).toBe(0);
    expect(await loadCurrentUser(headersWith(target.cookie))).toBeNull();
    expect(await auditFor(target.userId)).toEqual([
      expect.objectContaining({ action: "USER_DEACTIVATED", actorUserId: admin.userId, subjectType: "USER", detailsJson: { sessionsDeleted: 1 } }),
    ]);

    // Already inactive: 200, nothing changes, no audit row.
    expect(await (await deactivateCall(target.userId, admin.cookie)).json()).toMatchObject({ changed: false });
    expect(await auditFor(target.userId)).toHaveLength(1);
  });

  it("AU5: if the audit insert fails, the user stays active and keeps their sessions", async () => {
    const admin = await signedIn("ADMIN");
    const target = await signedIn("INTERVIEWER");
    const db = getDb();
    // A trigger that fails only this user's audit row.
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION fail_audit_${target.userId.replaceAll("-", "_")}() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'forced audit failure'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_audit_${target.userId.replaceAll("-", "_")} BEFORE INSERT ON audit_log
      FOR EACH ROW WHEN (NEW.subject_id = '${target.userId}')
      EXECUTE FUNCTION fail_audit_${target.userId.replaceAll("-", "_")}();`));
    try {
      await expect(deactivateCall(target.userId, admin.cookie)).rejects.toThrow();
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER fail_audit_${target.userId.replaceAll("-", "_")} ON audit_log;
        DROP FUNCTION fail_audit_${target.userId.replaceAll("-", "_")}();`));
    }
    expect((await userRow(target.userId)).isActive).toBe(true);
    expect(await sessionCount(target.userId)).toBe(1);
    expect(await loadCurrentUser(headersWith(target.cookie))).not.toBeNull();
  });

  it("an Admin can't deactivate themselves", async () => {
    const admin = await signedIn("ADMIN");
    const response = await deactivateCall(admin.userId, admin.cookie);
    expect(response.status).toBe(400);
    expect((await response.json()).message).toBe("You can't deactivate yourself.");
    expect((await userRow(admin.userId)).isActive).toBe(true);
  });

  it("the last active Admin can't be deactivated", async () => {
    await rolledBack(async (tx) => {
      const last = await insertUser(tx, "ADMIN");
      await tx.update(users).set({ isActive: false }).where(and(eq(users.role, "ADMIN"), ne(users.id, last.id)));
      expect(await deactivateUser(tx, (await insertUser(tx, "RECRUITER")).id, last.id)).toEqual({ ok: false, reason: "lastAdmin" });
      const [row] = await tx.select().from(users).where(eq(users.id, last.id));
      expect(row.isActive).toBe(true);
    });
  });

  it("reactivation lets the user sign in again and is audited", async () => {
    const admin = await signedIn("ADMIN");
    const target = await signedIn("HIRING_MANAGER");
    await deactivateCall(target.userId, admin.cookie);

    const response = await reactivateCall(target.userId, admin.cookie);
    expect(response.status).toBe(200);
    expect((await userRow(target.userId)).isActive).toBe(true);
    expect((await auditFor(target.userId)).map((row) => row.action)).toEqual(["USER_DEACTIVATED", "USER_REACTIVATED"]);
    // A fresh sign-in works again (the old session was deleted).
    const again = await signedInAgain(target.userId);
    expect(again).not.toBeNull();
  });

  it("deactivation leaves other references in place: the requisition's recruiter_id is unchanged", async () => {
    const admin = await signedIn("ADMIN");
    const recruiter = await signedIn("RECRUITER");
    const requisition = await withTransaction((tx) => insertRequisition(tx, { recruiterId: recruiter.userId }));
    await deactivateCall(recruiter.userId, admin.cookie);
    const [row] = await getDb().select().from(requisitions).where(eq(requisitions.id, requisition.id));
    expect(row.recruiterId).toBe(recruiter.userId);
  });
});

/** Signs in once more as an existing dev user by giving it a fresh password. */
async function signedInAgain(userId: string) {
  const { createAuth } = await import("@/server/auth/auth");
  const { ensureDevUser } = await import("@/server/auth/dev-users");
  const { getConfig } = await import("@/server/config");
  const row = await userRow(userId);
  const base = getConfig();
  const config = { ...base, auth: { ...base.auth, url: ORIGIN, devLogin: true } };
  const password = `pw-${randomUUID()}`;
  await ensureDevUser({ email: row.email, name: row.name, role: row.role, password }, config);
  const response = await createAuth(config).handler(
    new Request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email: row.email, password }),
    }),
  );
  return response.ok ? response : null;
}

describe("user picker", () => {
  it("returns active users only, filtered by any of the given roles, as { id, name, email, role }", async () => {
    await rolledBack(async (tx) => {
      const hm = await insertUser(tx, "HIRING_MANAGER");
      const admin = await insertUser(tx, "ADMIN");
      const recruiter = await insertUser(tx, "RECRUITER");
      const inactiveHm = await insertUser(tx, "HIRING_MANAGER");
      await tx.update(users).set({ isActive: false }).where(eq(users.id, inactiveHm.id));

      const ids = async (roles?: ("HIRING_MANAGER" | "ADMIN" | "RECRUITER")[]) => (await listActiveUsers({ roles }, tx)).map((u) => u.id);
      const approvers = await ids(["HIRING_MANAGER", "ADMIN"]);
      expect(approvers).toEqual(expect.arrayContaining([hm.id, admin.id]));
      expect(approvers).not.toContain(recruiter.id);
      expect(approvers).not.toContain(inactiveHm.id);
      const approverRows = await listActiveUsers({ roles: ["HIRING_MANAGER", "ADMIN"] }, tx);
      expect(new Set(approverRows.map((u) => u.role))).toEqual(new Set(["HIRING_MANAGER", "ADMIN"]));

      const onlyRecruiters = await listActiveUsers({ roles: ["RECRUITER"] }, tx);
      expect(onlyRecruiters.every((u) => u.role === "RECRUITER")).toBe(true);
      expect(onlyRecruiters.map((u) => u.id)).toContain(recruiter.id);

      const all = await ids();
      expect(all).toEqual(expect.arrayContaining([hm.id, admin.id, recruiter.id]));
      expect(all).not.toContain(inactiveHm.id);
      expect(Object.keys((await listActiveUsers({}, tx))[0]).sort()).toEqual(["email", "id", "name", "role"]);
      const names = (await listActiveUsers({}, tx)).map((u) => u.name);
      expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    });
  });

  it("GET /api/users/picker filters by repeated role parameters and refuses an invalid role", async () => {
    const { cookie } = await signedIn("RECRUITER");
    const response = await pick("role=HIRING_MANAGER&role=ADMIN", cookie);
    expect(response.status).toBe(200);
    const { users: list } = (await response.json()) as { users: { role: string }[] };
    expect(list.every((u) => u.role === "HIRING_MANAGER" || u.role === "ADMIN")).toBe(true);
    expect((await pick("role=OWNER", cookie)).status).toBe(400);
  });

  it.each(["ADMIN", "RECRUITER", "HIRING_MANAGER"] as const)("V1: %s may use the picker", async (role) => {
    expect((await pick("", (await signedIn(role)).cookie)).status).toBe(200);
  });

  it("AU9: an Interviewer gets 403 from the picker, no session 401", async () => {
    expect((await pick("", (await signedIn("INTERVIEWER")).cookie)).status).toBe(403);
    expect((await pick("")).status).toBe(401);
  });
});

describe("users API access (T5)", () => {
  it.each(["RECRUITER", "HIRING_MANAGER", "INTERVIEWER"] as const)("AU9: %s gets 403 from every /api/admin/users endpoint and nothing changes", async (role) => {
    const admin = await signedIn("ADMIN");
    const target = await createdUser(admin.cookie, { email: newEmail(), name: "Target", role: "INTERVIEWER" });
    const { cookie } = await signedIn(role);
    const email = newEmail();

    expect((await create({ email, name: "Nope", role: "ADMIN" }, cookie)).status).toBe(403);
    expect((await patch(target.id, { role: "ADMIN", name: "Changed" }, cookie)).status).toBe(403);
    expect((await deactivateCall(target.id, cookie)).status).toBe(403);
    await deactivateCall(target.id, admin.cookie);
    expect((await reactivateCall(target.id, cookie)).status).toBe(403);

    expect(await userRow(target.id)).toMatchObject({ role: "INTERVIEWER", name: "Target", isActive: false });
    expect(await getDb().select().from(users).where(eq(users.email, email))).toEqual([]);
  });

  it("AU9: without a session every endpoint returns 401", async () => {
    const id = randomUUID();
    expect((await create({ email: newEmail(), name: "x", role: "ADMIN" })).status).toBe(401);
    expect((await patch(id, { name: "x" })).status).toBe(401);
    expect((await deactivateCall(id)).status).toBe(401);
    expect((await reactivateCall(id)).status).toBe(401);
  });
});
