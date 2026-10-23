// The role matrix of the policy module (ats-project-scope.md §3, V1, V2, V9;
// tech-stack.md AU9), as a table of every role against every action.
import { describe, expect, it } from "vitest";
import { ACTIONS, type Action, type PolicyUser, type Role, can } from "@/server/policy/permissions";

const user = (role: Role, isActive = true): PolicyUser => ({ id: "00000000-0000-4000-8000-000000000001", role, isActive });

const ADMIN_ONLY: Action[] = [
  "admin.area",
  "settings.manage",
  "masterData.manage",
  "templates.manage",
  "users.manage",
  "outbox.view",
  "jobs.view",
  "requisition.reopen",
  "application.correctHired",
  "scorecard.reopen",
];
const READS: Action[] = ["requisition.read", "application.read", "scorecard.read", "offer.read", "file.view"];
const ADMIN_RECRUITER: Action[] = [
  "requisition.manage",
  "requisition.publish",
  "application.changeStatus",
  "interview.manage",
  "offer.manage",
  "export.hires",
  "export.reports",
  "approval.reassign",
  ...READS,
];
const CREATORS: Action[] = ["requisition.create", "masterData.pick", "users.pick", "templates.pick"];

/** What each role is allowed; everything else in the catalogue is denied. */
const ALLOWED: Record<Role, Action[]> = {
  ADMIN: [...ACTIONS],
  RECRUITER: ["staff.area", ...ADMIN_RECRUITER, ...CREATORS],
  HIRING_MANAGER: ["staff.area", ...CREATORS, "approval.decide"],
  INTERVIEWER: ["staff.area"],
};

describe("can()", () => {
  it("V1: Admin is allowed every action in the catalogue", () => {
    for (const action of ACTIONS) expect(can(user("ADMIN"), action), action).toBe(true);
  });

  it("V2: Recruiter reads all requisitions, applications, scorecards, offers and files, and manages them", () => {
    for (const action of ADMIN_RECRUITER) expect(can(user("RECRUITER"), action), action).toBe(true);
  });

  it("V2: Recruiter is denied every Admin-only action", () => {
    for (const action of ADMIN_ONLY) expect(can(user("RECRUITER"), action), action).toBe(false);
  });

  it.each(Object.keys(ALLOWED) as Role[])("V1: %s gets exactly the actions the matrix lists", (role) => {
    const allowed = ACTIONS.filter((action) => can(user(role), action));
    expect(allowed.sort()).toEqual([...new Set(ALLOWED[role])].sort());
  });

  it("AU9: Hiring Manager and Interviewer are signed in but denied reads until their rules exist", () => {
    for (const role of ["HIRING_MANAGER", "INTERVIEWER"] as const) {
      for (const action of READS) expect(can(user(role), action), `${role} ${action}`).toBe(false);
    }
  });

  it("AU9: no user, an inactive user and an unknown action are denied", () => {
    expect(can(null, "staff.area")).toBe(false);
    expect(can(undefined, "staff.area")).toBe(false);
    expect(can(user("ADMIN", false), "admin.area")).toBe(false);
    expect(can(user("ADMIN"), "nonexistent.action" as Action)).toBe(false);
    expect(can(user("ADMIN"), "toString" as Action)).toBe(false);
  });
});
