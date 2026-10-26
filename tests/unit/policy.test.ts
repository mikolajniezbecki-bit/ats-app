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
  "application.bulkEmail",
  "interview.manage",
  "offer.manage",
  "export.hires",
  "export.reports",
  "approval.reassign",
  ...READS,
];
const CREATORS: Action[] = ["requisition.create", "requisition.edit", "approval.withdraw", "masterData.pick", "users.pick", "templates.pick"];

/** What each role is allowed; everything else in the catalogue is denied. */
const ALLOWED: Record<Role, Action[]> = {
  ADMIN: [...ACTIONS],
  RECRUITER: ["staff.area", ...ADMIN_RECRUITER, ...CREATORS],
  // requisition.read: within V3a only (resource rule, task 20). file.view:
  // scorecard notes they may read only (resource rule, task 33).
  HIRING_MANAGER: ["staff.area", ...CREATORS, "approval.decide", "requisition.read", "file.view"],
  INTERVIEWER: ["staff.area", "file.view"],
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
      // A Hiring Manager's requisition reads have their rule since task 20 (V3a,
      // below); file.view has its resource rule since task 33 (tested below).
      const pending = READS.filter((action) => action !== "file.view" && (role !== "HIRING_MANAGER" || action !== "requisition.read"));
      for (const action of pending) expect(can(user(role), action), `${role} ${action}`).toBe(false);
    }
    expect(can(user("INTERVIEWER"), "requisition.read")).toBe(false);
  });

  describe("requisition resource rules", () => {
    const hm = user("HIRING_MANAGER");
    const other = "00000000-0000-4000-8000-0000000000ff";
    const requisition = (overrides: Partial<{ hiringManagerId: string; approverId: string | null; createdByUserId: string }>) => ({
      hiringManagerId: other,
      approverId: null,
      createdByUserId: other,
      ...overrides,
    });

    it("V3: a Hiring Manager reads a requisition as its hiring manager, approver or creator, and no other", () => {
      expect(can(hm, "requisition.read", requisition({ hiringManagerId: hm.id }))).toBe(true);
      expect(can(hm, "requisition.read", requisition({ approverId: hm.id }))).toBe(true);
      expect(can(hm, "requisition.read", requisition({ createdByUserId: hm.id }))).toBe(true);
      expect(can(hm, "requisition.read", requisition({}))).toBe(false);
    });

    it("V2: a Recruiter reads and edits any requisition", () => {
      expect(can(user("RECRUITER"), "requisition.read", requisition({}))).toBe(true);
      expect(can(user("RECRUITER"), "requisition.edit", requisition({}))).toBe(true);
    });

    it("V3: a Hiring Manager edits only requisitions they created", () => {
      expect(can(hm, "requisition.edit", requisition({ createdByUserId: hm.id }))).toBe(true);
      expect(can(hm, "requisition.edit", requisition({ hiringManagerId: hm.id }))).toBe(false);
      expect(can(user("INTERVIEWER"), "requisition.edit", requisition({ createdByUserId: user("INTERVIEWER").id }))).toBe(false);
    });
  });

  describe("file resource rule", () => {
    it("V11: Admins and Recruiters view every file; Hiring Managers and Interviewers no application or offer file", () => {
      for (const ownerType of ["APPLICATION", "OFFER", "SCORECARD"]) {
        expect(can(user("ADMIN"), "file.view", { ownerType })).toBe(true);
        expect(can(user("RECRUITER"), "file.view", { ownerType })).toBe(true);
      }
      for (const role of ["HIRING_MANAGER", "INTERVIEWER"] as const) {
        expect(can(user(role), "file.view", { ownerType: "APPLICATION", scorecardVisible: true })).toBe(false);
        expect(can(user(role), "file.view", { ownerType: "OFFER" })).toBe(false);
      }
    });

    it("V7: other roles view scorecard notes only when the scorecard is visible to them", () => {
      expect(can(user("INTERVIEWER"), "file.view", { ownerType: "SCORECARD", scorecardVisible: true })).toBe(true);
      expect(can(user("INTERVIEWER"), "file.view", { ownerType: "SCORECARD", scorecardVisible: false })).toBe(false);
      expect(can(user("INTERVIEWER"), "file.view", { ownerType: "SCORECARD" })).toBe(false);
      expect(can(user("INTERVIEWER", false), "file.view", { ownerType: "SCORECARD", scorecardVisible: true })).toBe(false);
    });
  });

  it("AU9: no user, an inactive user and an unknown action are denied", () => {
    expect(can(null, "staff.area")).toBe(false);
    expect(can(undefined, "staff.area")).toBe(false);
    expect(can(user("ADMIN", false), "admin.area")).toBe(false);
    expect(can(user("ADMIN"), "nonexistent.action" as Action)).toBe(false);
    expect(can(user("ADMIN"), "toString" as Action)).toBe(false);
  });
});
