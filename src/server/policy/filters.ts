// Row-level query filters (ats-project-scope.md V9, tech-stack.md D6): each
// returns a Drizzle condition to put in a query's WHERE, so visibility is
// never written ad hoc in a handler. They deny by default: a role whose
// visibility rule isn't implemented yet sees no rows.
//
//   db.select().from(requisitions).where(and(scopeRequisitionsFor(user), ...))
//
// Admin (V1) and Recruiter (V2) see everything. Hiring Managers see the
// requisitions of V3a; their application reads (V3b: task 36) and the
// Interviewer's (V5–V7: tasks 33, 34) get their conditions from those tasks.
import { type SQL, eq, or, sql } from "drizzle-orm";
import { requisitions } from "../db/schema";
import type { PolicyUser } from "./permissions";

const ALL_ROWS: SQL = sql`true`;
const NO_ROWS: SQL = sql`false`;

/** V1/V2: unrestricted for active Admins and Recruiters; nothing for anyone else yet. */
function adminOrRecruiterOnly(user: PolicyUser | null | undefined): SQL {
  if (!user || user.isActive === false) return NO_ROWS;
  return user.role === "ADMIN" || user.role === "RECRUITER" ? ALL_ROWS : NO_ROWS;
}

/** V1, V2; V3a: a Hiring Manager's requisitions as hiring manager, approver or creator. */
export function scopeRequisitionsFor(user: PolicyUser | null | undefined): SQL {
  if (user && user.isActive !== false && user.role === "HIRING_MANAGER") {
    return or(
      eq(requisitions.hiringManagerId, user.id),
      eq(requisitions.approverId, user.id),
      eq(requisitions.createdByUserId, user.id),
    )!;
  }
  return adminOrRecruiterOnly(user);
}

export function scopeApplicationsFor(user: PolicyUser | null | undefined): SQL {
  return adminOrRecruiterOnly(user);
}

export function scopeScorecardsFor(user: PolicyUser | null | undefined): SQL {
  return adminOrRecruiterOnly(user);
}

export function scopeOffersFor(user: PolicyUser | null | undefined): SQL {
  return adminOrRecruiterOnly(user);
}
