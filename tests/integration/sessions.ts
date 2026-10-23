// Real dev sign-in sessions for route-handler tests (AU7): creates a user with
// a password through ensureDevUser() and signs in through Better Auth's
// handler, returning the session cookie a browser would send.
import { randomUUID } from "node:crypto";
import { createAuth } from "@/server/auth/auth";
import { ensureDevUser } from "@/server/auth/dev-users";
import { type AppConfig, getConfig } from "@/server/config";
import type { Role } from "@/server/policy/permissions";

export const ORIGIN = "http://localhost:3000";

let devAuth: ReturnType<typeof createAuth> | undefined;
let devConfig: AppConfig | undefined;

function auth() {
  const base = getConfig();
  devConfig ??= { ...base, auth: { ...base.auth, url: ORIGIN, devLogin: true } };
  devAuth ??= createAuth(devConfig);
  return { auth: devAuth, config: devConfig };
}

/** A new user with `role` and a live session: its ID and `Cookie` header value. */
export async function signedIn(role: Role): Promise<{ userId: string; cookie: string }> {
  const { auth: devAuthInstance, config } = auth();
  const email = `session-${randomUUID()}@example.com`;
  const password = `pw-${randomUUID()}`;
  const userId = await ensureDevUser({ email, name: "Session User", role, password }, config);
  const response = await devAuthInstance.handler(
    new Request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email, password }),
    }),
  );
  const cookie = response.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Secure-better-auth.session_token="))!
    .split(";")[0];
  return { userId, cookie };
}
