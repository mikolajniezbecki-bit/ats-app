// Better Auth against the test database (AU5, AU6, AU7, AU10). The auth
// handler is called with Request objects; each test creates its own users.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ACCESS_NOT_GRANTED, DISABLED_AUTH_PATHS, createAuth } from "@/server/auth/auth";
import { loadCurrentUser, requireApiUser } from "@/server/auth/current-user";
import { ensureDevUser } from "@/server/auth/dev-users";
import { type AppConfig, getConfig } from "@/server/config";
import { getDb } from "@/server/db";
import { session, users } from "@/server/db/schema";

const ORIGIN = "http://localhost:3000";
const HOUR = 60 * 60 * 1000;

function config(devLogin: boolean): AppConfig {
  const base = getConfig();
  return { ...base, auth: { ...base.auth, url: ORIGIN, devLogin } };
}

const devAuth = createAuth(config(true));
const noDevAuth = createAuth(config(false));

function call(auth: ReturnType<typeof createAuth>, path: string, body: unknown, cookie?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", origin: ORIGIN };
  if (cookie) headers.cookie = cookie;
  return auth.handler(new Request(`${ORIGIN}/api/auth${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
}

async function newUser({ active = true, role = "RECRUITER" as const } = {}) {
  const email = `user-${randomUUID()}@example.com`;
  const password = `pw-${randomUUID()}`;
  const id = await ensureDevUser({ email, name: "Test User", role, password }, config(true));
  if (!active) await getDb().update(users).set({ isActive: false }).where(eq(users.id, id));
  return { id, email, password };
}

/** The session cookie (`name=value`) from a sign-in response. */
function sessionCookie(response: Response): string | undefined {
  return response.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Secure-better-auth.session_token="))
    ?.split(";")[0];
}

async function signIn(email: string, password: string) {
  const response = await call(devAuth, "/sign-in/email", { email, password });
  return { response, cookie: sessionCookie(response) };
}

const sessionsOf = (userId: string) => getDb().select().from(session).where(eq(session.userId, userId));
const headersWith = (cookie: string) => new Headers({ cookie });

describe("AU10 schema and disabled endpoints", () => {
  it("AU10: sign-up is refused and creates no user", async () => {
    const email = `signup-${randomUUID()}@example.com`;
    const response = await call(devAuth, "/sign-up/email", { email, password: "long-enough-password", name: "X" });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await getDb().select().from(users).where(eq(users.email, email))).toHaveLength(0);
  });

  it("AU10: update-user can't set role, nor isActive from an inactive user's cookie", async () => {
    const user = await newUser();
    const { cookie } = await signIn(user.email, user.password);

    const roleChange = await call(devAuth, "/update-user", { role: "ADMIN" }, cookie);
    expect(roleChange.status).toBe(404);

    await getDb().update(users).set({ isActive: false }).where(eq(users.id, user.id));
    const reactivate = await call(devAuth, "/update-user", { isActive: true }, cookie);
    expect(reactivate.status).toBe(404);

    const [row] = await getDb().select().from(users).where(eq(users.id, user.id));
    expect({ role: row.role, isActive: row.isActive }).toEqual({ role: "RECRUITER", isActive: false });
  });

  it("AU10: every other self-service path returns 404", async () => {
    const user = await newUser();
    const { cookie } = await signIn(user.email, user.password);
    for (const path of DISABLED_AUTH_PATHS) {
      expect((await call(devAuth, path, {}, cookie)).status, path).toBe(404);
    }
  });
});

describe("AU7 dev sign-in", () => {
  it("AU7: with dev login off, a correct email and password get no session", async () => {
    const user = await newUser();
    const response = await call(noDevAuth, "/sign-in/email", { email: user.email, password: user.password });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(sessionCookie(response)).toBeUndefined();
    expect(await sessionsOf(user.id)).toHaveLength(0);
  });

  it("AU7: with dev login on, sign-in creates a session row and later requests are authenticated", async () => {
    const user = await newUser();
    const { response, cookie } = await signIn(user.email, user.password);

    expect(response.status).toBe(200);
    expect(await sessionsOf(user.id)).toHaveLength(1);
    expect(await loadCurrentUser(headersWith(cookie!))).toEqual({
      id: user.id,
      email: user.email,
      name: "Test User",
      role: "RECRUITER",
    });
  });

  it("AU7: a wrong password and an unknown email get the same refusal", async () => {
    const user = await newUser();
    const wrong = await call(devAuth, "/sign-in/email", { email: user.email, password: "not-the-password" });
    const unknown = await call(devAuth, "/sign-in/email", { email: `nobody-${randomUUID()}@example.com`, password: "x".repeat(12) });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect((await wrong.json()).code).toBe((await unknown.json()).code);
  });
});

describe("AU5 active check", () => {
  it("AU5: an inactive user can't sign in, sees the AU2 message, and gets no session row", async () => {
    const user = await newUser({ active: false });
    const { response, cookie } = await signIn(user.email, user.password);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "ACCESS_NOT_GRANTED", message: ACCESS_NOT_GRANTED });
    expect(cookie).toBeUndefined();
    expect(await sessionsOf(user.id)).toHaveLength(0);
  });

  it("AU5: a user deactivated in the database is signed out on the next request", async () => {
    const user = await newUser();
    const { cookie } = await signIn(user.email, user.password);
    expect(await loadCurrentUser(headersWith(cookie!))).not.toBeNull();

    await getDb().update(users).set({ isActive: false }).where(eq(users.id, user.id));

    expect(await loadCurrentUser(headersWith(cookie!))).toBeNull();
  });

  it("AU5: a role change applies on the next request without signing in again", async () => {
    const user = await newUser();
    const { cookie } = await signIn(user.email, user.password);

    await getDb().update(users).set({ role: "HIRING_MANAGER" }).where(eq(users.id, user.id));

    expect((await loadCurrentUser(headersWith(cookie!)))?.role).toBe("HIRING_MANAGER");
  });
});

describe("AU6 sessions", () => {
  it("AU6: the session cookie is HTTP-only, Secure, SameSite=Lax, Path=/ with an 8 h lifetime", async () => {
    const user = await newUser();
    const { response } = await signIn(user.email, user.password);

    const setCookie = response.headers.getSetCookie().find((c) => c.startsWith("__Secure-better-auth.session_token="))!;
    const attributes = setCookie.split(";").map((part) => part.trim().toLowerCase());
    expect(attributes).toEqual(expect.arrayContaining(["httponly", "secure", "samesite=lax", "path=/", "max-age=28800"]));

    const [row] = await sessionsOf(user.id);
    expect(Math.abs(row.expiresAt.getTime() - (Date.now() + 8 * HOUR))).toBeLessThan(60_000);
  });

  it("AU6: a session last refreshed 2 h ago slides to now + 8 h; one refreshed 10 min ago doesn't change", async () => {
    const stale = await newUser();
    const fresh = await newUser();
    const staleCookie = (await signIn(stale.email, stale.password)).cookie!;
    const freshCookie = (await signIn(fresh.email, fresh.password)).cookie!;
    const age = async (userId: string, ms: number) => {
      await getDb()
        .update(session)
        .set({ updatedAt: new Date(Date.now() - ms), expiresAt: new Date(Date.now() - ms + 8 * HOUR) })
        .where(eq(session.userId, userId));
      return (await sessionsOf(userId))[0].expiresAt;
    };
    await age(stale.id, 2 * HOUR);
    const freshExpiry = await age(fresh.id, 10 * 60 * 1000);

    await loadCurrentUser(headersWith(staleCookie));
    await loadCurrentUser(headersWith(freshCookie));

    const [slid] = await sessionsOf(stale.id);
    expect(Math.abs(slid.expiresAt.getTime() - (Date.now() + 8 * HOUR))).toBeLessThan(60_000);
    expect((await sessionsOf(fresh.id))[0].expiresAt).toEqual(freshExpiry);
  });

  it("AU6: an expired session counts as signed out; a protected API gets 401", async () => {
    const user = await newUser();
    const { cookie } = await signIn(user.email, user.password);
    await getDb()
      .update(session)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(session.userId, user.id));

    expect(await loadCurrentUser(headersWith(cookie!))).toBeNull();
    const result = await requireApiUser(new Request(`${ORIGIN}/api/anything`, { headers: { cookie: cookie! } }));
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
    expect(await (result as Response).json()).toEqual({ error: "unauthorized" });
  });

  it("sign-out deletes the session row", async () => {
    const user = await newUser();
    const { cookie } = await signIn(user.email, user.password);

    const response = await call(devAuth, "/sign-out", {}, cookie);

    expect(response.status).toBe(200);
    expect(await sessionsOf(user.id)).toHaveLength(0);
  });
});

describe("ensureDevUser", () => {
  it("is idempotent, reactivates and updates the role and password, and refuses without dev login", async () => {
    const email = `dev-${randomUUID()}@example.com`;
    const first = await ensureDevUser({ email, name: "A", role: "INTERVIEWER", password: "first-password" }, config(true));
    await getDb().update(users).set({ isActive: false }).where(eq(users.id, first));
    const second = await ensureDevUser({ email, name: "B", role: "ADMIN", password: "second-password" }, config(true));

    expect(second).toBe(first);
    const [row] = await getDb().select().from(users).where(eq(users.id, first));
    expect(row).toMatchObject({ name: "B", role: "ADMIN", isActive: true, emailVerified: true });
    expect((await signIn(email, "first-password")).response.status).toBe(401);
    expect((await signIn(email, "second-password")).response.status).toBe(200);

    await expect(ensureDevUser({ email, name: "C", role: "ADMIN", password: "x" }, config(false))).rejects.toThrow(/AUTH_DEV_LOGIN/);
  });
});
