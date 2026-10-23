// Guards (ats-project-scope.md V9, tech-stack.md AU9): pages, route handlers
// and server actions load the user on the server and ask can(). proxy.ts
// only checks that a cookie is present (§3 rule 6), so these are the real
// checks.
import "server-only";
import { forbidden, redirect } from "next/navigation";
import { type CurrentUser, getCurrentUser, loadCurrentUser } from "../auth/current-user";
import { signInUrl } from "../auth/redirect";
import { type Action, can } from "./permissions";

/** Thrown by server actions when the caller may not perform the action. */
export class ForbiddenError extends Error {
  override name = "ForbiddenError";
  constructor(readonly action: Action) {
    super(`Forbidden: ${action}`);
  }
}

/**
 * Pages: the signed-in user, or a redirect to sign-in. The cookie can be
 * present but stale, expired or belong to an inactive user (AU5, AU6).
 */
export async function requireUser(nextPath = "/dashboard"): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect(signInUrl(nextPath));
  return user;
}

/** Pages: the signed-in user if `can()` allows `action`, else the 403 page with HTTP 403. */
export async function requirePermission(action: Action, resource?: unknown, nextPath?: string): Promise<CurrentUser> {
  const user = await requireUser(nextPath);
  if (!can(user, action, resource)) forbidden();
  return user;
}

/**
 * Route handlers: runs `handler` only for a signed-in user allowed `action`.
 * No valid session: 401 `{"error":"unauthorized"}`; signed in without the
 * permission: 403 `{"error":"forbidden"}`.
 */
export function withPermission<Context = unknown>(
  action: Action,
  handler: (request: Request, user: CurrentUser, context: Context) => Response | Promise<Response>,
): (request: Request, context: Context) => Promise<Response> {
  return async (request, context) => {
    const user = await loadCurrentUser(request.headers);
    if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!can(user, action)) return Response.json({ error: "forbidden" }, { status: 403 });
    return handler(request, user, context);
  };
}

/** Server actions: the signed-in user if allowed `action`; otherwise throws ForbiddenError. */
export async function authorizeAction(action: Action, resource?: unknown): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user || !can(user, action, resource)) throw new ForbiddenError(action);
  return user;
}
