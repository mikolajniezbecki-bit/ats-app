// Dev users for Playwright (T4): the four shared e2e users and throwaway
// users for specs that change a user's role or active flag.
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { hostAppEnvironment } from "./env";

export const ROLES = {
  admin: { role: "ADMIN", email: "e2e-admin@example.com", name: "E2E Admin" },
  recruiter: { role: "RECRUITER", email: "e2e-recruiter@example.com", name: "E2E Recruiter" },
  "hiring-manager": { role: "HIRING_MANAGER", email: "e2e-hiring-manager@example.com", name: "E2E Hiring Manager" },
  interviewer: { role: "INTERVIEWER", email: "e2e-interviewer@example.com", name: "E2E Interviewer" },
} as const;

export type RoleKey = keyof typeof ROLES;
export type UserRole = (typeof ROLES)[RoleKey]["role"];

export type DevUser = { id: string; email: string; name: string; role: UserRole; password: string };

/** A fresh random password; never committed or logged. */
export function randomPassword(): string {
  return randomBytes(18).toString("base64url");
}

/** Creates or updates the user through ensureDevUser(), with a new password. */
export function ensureDevUser(user: Omit<DevUser, "id" | "password">): DevUser {
  const password = randomPassword();
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "tests/e2e/support/ensure-dev-user.ts"],
    { input: JSON.stringify({ ...user, password }), env: { ...process.env, ...hostAppEnvironment() }, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`ensureDevUser failed for ${user.email}: ${result.stderr}`);
  return { ...user, id: result.stdout.trim(), password };
}

/** A throwaway user only this spec changes. */
export function createThrowawayUser(role: UserRole = "RECRUITER"): DevUser {
  const id = randomUUID();
  return ensureDevUser({ email: `e2e-${id}@example.com`, name: `E2E ${id.slice(0, 8)}`, role });
}
