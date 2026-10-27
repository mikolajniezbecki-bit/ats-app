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
  "reports.view",
  "approval.reassign",
  ...READS,
];
const CREATORS: Action[] = ["requisition.create", "requisition.edit", "approval.withdraw", "masterData.pick", "users.pick", "templates.pick"];

/** What each role is allowed; everything else in the catalogue is denied. */
const ALLOWED: Record<Role, Action[]> = {
  ADMIN: [...ACTIONS],
  RECRUITER: ["staff.area", ...ADMIN_RECRUITER, ...CREATORS],
  // The reads are narrowed by resource rules (V3a, V4: tasks 20, 34; file
  // notes: task 33) and the row filters; offers never for Interviewers (V6).
  HIRING_MANAGER: ["staff.area", ...CREATORS, "approval.decide", ...READS],
  INTERVIEWER: ["staff.area", "application.read", "scorecard.read", "file.view"],
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

  it("V6: an Interviewer never reads requisitions or offers", () => {
    expect(can(user("INTERVIEWER"), "requisition.read")).toBe(false);
    expect(can(user("INTERVIEWER"), "offer.read")).toBe(false);
  });

  describe("application resource rules", () => {
    const hm = user("HIRING_MANAGER");
    const other = "00000000-0000-4000-8000-0000000000ff";
    const app = (overrides: Partial<{ hiringManagerId: string; approverId: string | null; createdByUserId: string; open: boolean; participant: boolean }> = {}) => ({
      requisition: { hiringManagerId: overrides.hiringManagerId ?? other, approverId: overrides.approverId ?? null, createdByUserId: overrides.createdByUserId ?? other },
      open: overrides.open ?? true,
      participant: overrides.participant ?? false,
    });

    it("V4: a Hiring Manager reads applications, scorecards and offers of V3a requisitions only", () => {
      for (const action of ["application.read", "scorecard.read", "offer.read"] as const) {
        expect(can(hm, action, app({ hiringManagerId: hm.id })), action).toBe(true);
        expect(can(hm, action, app({ approverId: hm.id })), action).toBe(true);
        expect(can(hm, action, app({ createdByUserId: hm.id })), action).toBe(true);
        expect(can(hm, action, app({ participant: true })), action).toBe(false);
      }
    });

    it("V5: an Interviewer reads an open application they currently interview for, and no other", () => {
      const interviewer = user("INTERVIEWER");
      expect(can(interviewer, "application.read", app({ participant: true }))).toBe(true);
      expect(can(interviewer, "application.read", app({ participant: true, open: false }))).toBe(false);
      expect(can(interviewer, "application.read", app({ participant: false }))).toBe(false);
    });

    it("V4, V6: application files follow the application; offer letters only for Hiring Managers in scope, never Interviewers", () => {
      const interviewer = user("INTERVIEWER");
      expect(can(hm, "file.view", { ownerType: "APPLICATION", application: app({ hiringManagerId: hm.id }) })).toBe(true);
      expect(can(hm, "file.view", { ownerType: "APPLICATION", application: app() })).toBe(false);
      expect(can(hm, "file.view", { ownerType: "OFFER", application: app({ hiringManagerId: hm.id }) })).toBe(true);
      expect(can(interviewer, "file.view", { ownerType: "APPLICATION", application: app({ participant: true }) })).toBe(true);
      expect(can(interviewer, "file.view", { ownerType: "OFFER", application: app({ participant: true }) })).toBe(false);
      expect(can(interviewer, "file.view", { ownerType: "APPLICATION" })).toBe(false);
    });
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
    it("V11: Admins and Recruiters view every application and offer file; Hiring Managers and Interviewers none", () => {
      for (const ownerType of ["APPLICATION", "OFFER"]) {
        expect(can(user("ADMIN"), "file.view", { ownerType })).toBe(true);
        expect(can(user("RECRUITER"), "file.view", { ownerType })).toBe(true);
      }
      for (const role of ["HIRING_MANAGER", "INTERVIEWER"] as const) {
        expect(can(user(role), "file.view", { ownerType: "APPLICATION", scorecardVisible: true })).toBe(false);
        expect(can(user(role), "file.view", { ownerType: "OFFER" })).toBe(false);
      }
    });

    it("V7, I9: every role views scorecard notes only when the scorecard is visible to them (drafts stay private)", () => {
      for (const role of ["ADMIN", "RECRUITER"] as const) {
        expect(can(user(role), "file.view", { ownerType: "SCORECARD", scorecardVisible: true })).toBe(true);
        expect(can(user(role), "file.view", { ownerType: "SCORECARD", scorecardVisible: false })).toBe(false);
      }
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
