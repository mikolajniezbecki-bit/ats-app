// The policy module (ats-project-scope.md §3, V1, V2, V9; tech-stack.md AU9):
// every authorization decision goes through can(). Authentication only says
// who the user is; this file says what each role may do. Pure, so it is
// unit-tested without a database.
//
// Later tasks extend the matrix here, never somewhere else. Resource rules
// (V3a, A2, V3b, V5–V8) are added to can() by the tasks that implement them;
// until then a role without its rule is denied (D6).
import { USER_ROLES } from "../db/schema/administration";

export type Role = (typeof USER_ROLES)[number];

/** Who is asking. `isActive: false` is denied everything, like no user. */
export type PolicyUser = { id: string; role: Role; isActive?: boolean };

const ADMIN = ["ADMIN"] as const satisfies Role[];
const ADMIN_RECRUITER = ["ADMIN", "RECRUITER"] as const satisfies Role[];
const CREATORS = ["ADMIN", "RECRUITER", "HIRING_MANAGER"] as const satisfies Role[];
const APPROVERS = ["ADMIN", "HIRING_MANAGER"] as const satisfies Role[];
const EVERY_ROLE = USER_ROLES;

/** The action catalogue and its role matrix, in one place. */
export const PERMISSIONS = {
  // Signed-in staff pages: the back-office home.
  "staff.area": EVERY_ROLE,

  // Admin only (§3).
  "admin.area": ADMIN,
  "settings.manage": ADMIN,
  "masterData.manage": ADMIN,
  "templates.manage": ADMIN,
  "users.manage": ADMIN,
  "outbox.view": ADMIN,
  "jobs.view": ADMIN,
  "requisition.reopen": ADMIN, // L7
  "application.correctHired": ADMIN, // R4
  "scorecard.reopen": ADMIN, // V8

  // Admin and Recruiter (§3).
  "requisition.manage": ADMIN_RECRUITER,
  "requisition.publish": ADMIN_RECRUITER,
  "application.changeStatus": ADMIN_RECRUITER,
  "interview.manage": ADMIN_RECRUITER,
  "offer.manage": ADMIN_RECRUITER,
  "export.hires": ADMIN_RECRUITER, // V10
  "export.reports": ADMIN_RECRUITER, // V10
  "approval.reassign": ADMIN_RECRUITER, // A4

  // Admin, Recruiter and Hiring Manager (§3).
  "requisition.create": CREATORS,
  "masterData.pick": CREATORS,
  "users.pick": CREATORS,
  // Requisition, offer and bulk-email forms list active templates (task 16, Q10).
  "templates.pick": CREATORS,

  // Role level only; A2 and the current-approver check come with task 22.
  "approval.decide": APPROVERS,

  // V1, V2. Hiring Manager (V3/V4) and Interviewer (V5/V6) reads are added
  // with their resource rules (tasks 20, 34, 36).
  "requisition.read": ADMIN_RECRUITER,
  "application.read": ADMIN_RECRUITER,
  "scorecard.read": ADMIN_RECRUITER,
  "offer.read": ADMIN_RECRUITER,
  "file.view": ADMIN_RECRUITER,
} as const satisfies Record<string, readonly Role[]>;

export type Action = keyof typeof PERMISSIONS;

export const ACTIONS = Object.keys(PERMISSIONS) as Action[];

/**
 * True when `user` may perform `action`. Denies by default: no user, an
 * inactive user, or an action outside the catalogue. `resource` is the record
 * acted on, for the resource rules later tasks add; role-level actions
 * ignore it.
 */
export function can(user: PolicyUser | null | undefined, action: Action, resource?: unknown): boolean {
  void resource;
  if (!user || user.isActive === false) return false;
  if (!Object.hasOwn(PERMISSIONS, action)) return false;
  const roles: readonly Role[] = PERMISSIONS[action];
  return roles.includes(user.role);
}
