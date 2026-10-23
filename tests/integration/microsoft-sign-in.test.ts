// Microsoft Entra sign-in against the test database (AU1–AU4). No real tenant
// is reached (G3): the real callback runs with Microsoft's token endpoint
// mocked, returning a synthetic ID token. Each test creates its own users.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "@/server/auth/auth";
import { loadCurrentUser } from "@/server/auth/current-user";
import { ACCESS_NOT_GRANTED_ERRORS } from "@/server/auth/sign-in-errors";
import { type AppConfig, getConfig } from "@/server/config";
import { getDb } from "@/server/db";
import { account, session, users } from "@/server/db/schema";

const ORIGIN = "http://localhost:3000";
const TENANT = "11111111-2222-4333-8444-555555555555";
const CLIENT_ID = "test-only-client-id";
const AUTHORIZE = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`;
const TOKEN = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;

function config(microsoft: boolean): AppConfig {
  const base = getConfig();
  return {
    ...base,
    auth: {
      ...base.auth,
      url: ORIGIN,
      microsoft: microsoft ? { clientId: CLIENT_ID, tenantId: TENANT, clientSecret: "test-only-client-secret" } : null,
    },
  };
}

const auth = createAuth(config(true));
const noMicrosoftAuth = createAuth(config(false));

type Claims = { sub?: string; oid?: string; email?: string; preferred_username?: string; name?: string };

/** An unsigned JWT: the code flow reads the ID token Microsoft returned over TLS without verifying it again. */
function idToken(claims: Claims): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  return `${part({ alg: "RS256", typ: "JWT", kid: "test" })}.${part({
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    aud: CLIENT_ID,
    tid: TENANT,
    iat: now,
    exp: now + 3600,
    ...claims,
  })}.c2lnbmF0dXJl`;
}

/** URLs the auth code asked for; Microsoft's token endpoint answers with `claims`. */
let requested: string[] = [];
let tokenClaims: Claims = {};

beforeEach(() => {
  requested = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    requested.push(url);
    if (url === TOKEN) {
      return Response.json({
        token_type: "Bearer",
        access_token: "test-only-access-token",
        expires_in: 3600,
        id_token: idToken(tokenClaims),
      });
    }
    if (/microsoft(online)?\.com/.test(url)) return new Response("unexpected", { status: 500 });
    return realFetch(input, init);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function post(instance: ReturnType<typeof createAuth>, path: string, body: unknown) {
  return instance.handler(
    new Request(`${ORIGIN}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify(body),
    }),
  );
}

/** `name=value` pairs from Set-Cookie headers, as a Cookie header. */
const cookiesOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

/**
 * Runs the whole flow: `sign-in/social`, then the real callback with the
 * state it issued, Microsoft answering with `claims`. Returns the callback's
 * redirect target and the session cookie it set, if any.
 */
async function signInWithMicrosoft(claims: Claims, { requestSignUp = false } = {}) {
  tokenClaims = claims;
  const start = await post(auth, "/sign-in/social", {
    provider: "microsoft",
    callbackURL: "/dashboard",
    ...(requestSignUp ? { requestSignUp: true } : {}),
  });
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state")!;

  const callback = await auth.handler(
    new Request(`${ORIGIN}/api/auth/callback/microsoft?code=test-code&state=${encodeURIComponent(state)}`, {
      headers: { cookie: cookiesOf(start) },
    }),
  );
  expect(callback.status, "the callback redirects, never a 500").toBe(302);
  const location = new URL(callback.headers.get("location")!, ORIGIN);
  const sessionCookie = callback.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Secure-better-auth.session_token="))
    ?.split(";")[0];
  return { location, sessionCookie };
}

/** A pre-created ATS user, as an Admin (or the seed) creates them. */
async function preCreatedUser({ active = true, name = "Ada Admin" } = {}) {
  const email = `entra-${randomUUID()}@tenant.onmicrosoft.com`;
  const [row] = await getDb()
    .insert(users)
    .values({ email, name, role: "RECRUITER", isActive: active, emailVerified: true })
    .returning();
  return row;
}

const usersWithEmail = (email: string) => getDb().select().from(users).where(eq(users.email, email));
const accountsOf = (userId: string) => getDb().select().from(account).where(eq(account.userId, userId));
const sessionsOf = (userId: string) => getDb().select().from(session).where(eq(session.userId, userId));
const accountsWithId = (accountId: string) => getDb().select().from(account).where(eq(account.accountId, accountId));

function expectAccessNotGranted(location: URL) {
  expect(location.pathname).toBe("/sign-in");
  expect(ACCESS_NOT_GRANTED_ERRORS).toContain(location.searchParams.get("error"));
}

const entraIds = () => ({ sub: `sub-${randomUUID()}`, oid: randomUUID() });

describe("AU1 provider configuration", () => {
  it("AU1: sign-in/social returns the single-tenant authorize URL with the expected redirect URI", async () => {
    const response = await post(auth, "/sign-in/social", { provider: "microsoft", callbackURL: "/dashboard" });

    expect(response.status).toBe(200);
    const url = new URL(((await response.json()) as { url: string }).url);
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/microsoft`);
  });

  it("AU1: without the Microsoft variables the provider doesn't exist", async () => {
    const response = await post(noMicrosoftAuth, "/sign-in/social", { provider: "microsoft", callbackURL: "/dashboard" });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});

describe("AU2 invite-only", () => {
  it("AU2: an email with no ATS user is refused, and no user, account or session is created", async () => {
    const ids = entraIds();
    const email = `stranger-${randomUUID()}@tenant.onmicrosoft.com`;

    const { location, sessionCookie } = await signInWithMicrosoft({ ...ids, email, name: "Stranger" });

    expectAccessNotGranted(location);
    expect(sessionCookie).toBeUndefined();
    expect(await usersWithEmail(email)).toHaveLength(0);
    expect(await accountsWithId(ids.oid)).toHaveLength(0);
  });

  it("AU2: requestSignUp: true is refused the same way", async () => {
    const email = `stranger-${randomUUID()}@tenant.onmicrosoft.com`;

    const { location } = await signInWithMicrosoft({ ...entraIds(), email }, { requestSignUp: true });

    expectAccessNotGranted(location);
    expect(await usersWithEmail(email)).toHaveLength(0);
  });

  it("AU2: an inactive pre-created user gets no session and the same message", async () => {
    const user = await preCreatedUser({ active: false });

    const { location, sessionCookie } = await signInWithMicrosoft({ ...entraIds(), email: user.email });

    expectAccessNotGranted(location);
    expect(sessionCookie).toBeUndefined();
    expect(await sessionsOf(user.id)).toHaveLength(0);
  });

  it("AU2: a profile with neither email nor preferred_username is refused without a 500", async () => {
    const ids = entraIds();

    const { location } = await signInWithMicrosoft({ ...ids, name: "No Mailbox" });

    expectAccessNotGranted(location);
    expect(await accountsWithId(ids.oid)).toHaveLength(0);
  });

  it("AU2: the Microsoft Graph photo endpoint is never called", async () => {
    const user = await preCreatedUser();

    await signInWithMicrosoft({ ...entraIds(), email: user.email });

    expect(requested.filter((url) => url.includes("graph.microsoft.com"))).toEqual([]);
    expect(requested).toContain(TOKEN);
  });
});

describe("AU4 account linking", () => {
  it("AU4: the first sign-in links the Entra account to the pre-created user", async () => {
    const user = await preCreatedUser();
    const ids = entraIds();

    const { location, sessionCookie } = await signInWithMicrosoft({
      ...ids,
      // AU3: the UPN fallback, mixed case.
      preferred_username: user.email.toUpperCase(),
      name: "A. Admin",
    });

    expect(location.pathname).toBe("/dashboard");
    // Better Auth's Microsoft provider keys the account on `oid`, the
    // object ID that stays the same across UPN renames.
    const accounts = await accountsOf(user.id);
    expect(accounts.map((a) => ({ providerId: a.providerId, accountId: a.accountId }))).toEqual([
      { providerId: "microsoft", accountId: ids.oid },
    ]);
    expect(await sessionsOf(user.id)).toHaveLength(1);
    expect(await loadCurrentUser(new Headers({ cookie: sessionCookie! }))).toMatchObject({ id: user.id });
    // Sign-in never overwrites the Admin-maintained profile (AU3).
    const [row] = await usersWithEmail(user.email);
    expect({ name: row.name, email: row.email, role: row.role, image: row.image }).toEqual({
      name: "Ada Admin",
      email: user.email,
      role: "RECRUITER",
      image: null,
    });
  });

  it("AU4: a later sign-in with a renamed UPN matches the stored account ID", async () => {
    const user = await preCreatedUser();
    const ids = entraIds();
    await signInWithMicrosoft({ ...ids, email: user.email });

    const renamed = `renamed-${randomUUID()}@tenant.onmicrosoft.com`;
    const { location, sessionCookie } = await signInWithMicrosoft({ ...ids, email: renamed });

    expect(location.pathname).toBe("/dashboard");
    expect(await loadCurrentUser(new Headers({ cookie: sessionCookie! }))).toMatchObject({ id: user.id, email: user.email });
    expect(await accountsOf(user.id)).toHaveLength(1);
    expect(await usersWithEmail(renamed)).toHaveLength(0);
  });

  it("AU4: an account already linked to user A signs in as A even if the email is user B's", async () => {
    const a = await preCreatedUser();
    const b = await preCreatedUser();
    const ids = entraIds();
    await signInWithMicrosoft({ ...ids, email: a.email });

    const { sessionCookie } = await signInWithMicrosoft({ ...ids, email: b.email });

    expect(await loadCurrentUser(new Headers({ cookie: sessionCookie! }))).toMatchObject({ id: a.id });
    expect(await accountsOf(b.id)).toHaveLength(0);
    expect(await sessionsOf(b.id)).toHaveLength(0);
  });
});
