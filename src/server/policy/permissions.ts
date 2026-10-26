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
  "application.bulkEmail": ADMIN_RECRUITER, // §5.4 bulk actions
  "interview.manage": ADMIN_RECRUITER,
  "offer.manage": ADMIN_RECRUITER,
  "export.hires": ADMIN_RECRUITER, // V10
  "export.reports": ADMIN_RECRUITER, // V10
  "approval.reassign": ADMIN_RECRUITER, // A4

  // Admin, Recruiter and Hiring Manager (§3).
  "requisition.create": CREATORS,
  // Hiring Managers edit only drafts they created (resource rule below).
  "requisition.edit": CREATORS,
  "masterData.pick": CREATORS,
  "users.pick": CREATORS,
  // Requisition, offer and bulk-email forms list active templates (task 16, Q10).
  "templates.pick": CREATORS,

  // A2, A3: only the current approver of a pending item, never its submitter (resource rule below).
  "approval.decide": APPROVERS,
  // A9: the submitter, any Recruiter or any Admin (resource rule below).
  "approval.withdraw": CREATORS,

  // V1, V2; Hiring Managers within V3a (resource rule below). Hiring Manager
  // application reads (V4) and Interviewer reads (V5/V6) are added with their
  // resource rules (tasks 34, 36).
  "requisition.read": CREATORS,
  "application.read": ADMIN_RECRUITER,
  "scorecard.read": ADMIN_RECRUITER,
  "offer.read": ADMIN_RECRUITER,
  // Admin and Recruiter see every file; other roles only scorecard notes
  // they may read (V7, V11; resource rule below; task 34 adds V4/V6 files).
  "file.view": EVERY_ROLE,
} as const satisfies Record<string, readonly Role[]>;

export type Action = keyof typeof PERMISSIONS;

export const ACTIONS = Object.keys(PERMISSIONS) as Action[];

/** The requisition columns the resource rules read. */
export type RequisitionResource = { hiringManagerId: string; approverId: string | null; createdByUserId: string };

/** V3a: the Hiring Manager is the requisition's hiring manager, approver or creator. */
export function inRequisitionScope(user: PolicyUser, requisition: RequisitionResource): boolean {
  return requisition.hiringManagerId === user.id || requisition.approverId === user.id || requisition.createdByUserId === user.id;
}

/**
 * A file as the `file.view` rule sees it. `scorecardVisible` is set by the
 * caller for SCORECARD files, after the scopeScorecardsFor() query (V7).
 */
export type FileResource = { ownerType: string; scorecardVisible?: boolean };

/** A pending or decided approval: a requisition or an offer (A1–A9). */
export type ApprovalResource = { pending: boolean; approverId: string | null; submittedByUserId: string | null };

type ResourceRule = (user: PolicyUser, resource: unknown) => boolean;

/**
 * Rules on the record, checked after the role matrix when a resource is
 * given. Without a resource only the role is checked (e.g. opening the list
 * page); the record itself is then read through a row-level filter (D6).
 */
const RESOURCE_RULES: Partial<Record<Action, ResourceRule>> = {
  "requisition.read": (user, resource) =>
    user.role !== "HIRING_MANAGER" || inRequisitionScope(user, resource as RequisitionResource),
  "requisition.edit": (user, resource) =>
    user.role !== "HIRING_MANAGER" || (resource as RequisitionResource).createdByUserId === user.id,
  "approval.decide": (user, resource) => {
    const approval = resource as ApprovalResource;
    return approval.pending && approval.approverId === user.id && approval.submittedByUserId !== user.id;
  },
  "file.view": (user, resource) => {
    if (user.role === "ADMIN" || user.role === "RECRUITER") return true;
    const file = resource as FileResource;
    return file.ownerType === "SCORECARD" && file.scorecardVisible === true;
  },
  "approval.withdraw": (user, resource) => {
    const approval = resource as ApprovalResource;
    return approval.pending && (user.role === "ADMIN" || user.role === "RECRUITER" || approval.submittedByUserId === user.id);
  },
};

/**
 * True when `user` may perform `action`. Denies by default: no user, an
 * inactive user, or an action outside the catalogue. `resource` is the record
 * acted on, for the resource rules above; role-level actions ignore it.
 */
export function can(user: PolicyUser | null | undefined, action: Action, resource?: unknown): boolean {
  if (!user || user.isActive === false) return false;
  if (!Object.hasOwn(PERMISSIONS, action)) return false;
  const roles: readonly Role[] = PERMISSIONS[action];
  if (!roles.includes(user.role)) return false;
  const rule = RESOURCE_RULES[action];
  return resource === undefined || rule === undefined || rule(user, resource);
}
