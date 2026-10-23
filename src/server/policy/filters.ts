// Row-level query filters (ats-project-scope.md V9, tech-stack.md D6): each
// returns a Drizzle condition to put in a query's WHERE, so visibility is
// never written ad hoc in a handler. They deny by default: a role whose
// visibility rule isn't implemented yet sees no rows.
//
//   db.select().from(requisitions).where(and(scopeRequisitionsFor(user), ...))
//
// Admin (V1) and Recruiter (V2) see everything. Hiring Manager (V3a: task 20,
// V3b: task 36) and Interviewer (V5–V7: tasks 33, 34) get their conditions
// from those tasks.
import { type SQL, sql } from "drizzle-orm";
import type { PolicyUser } from "./permissions";

const ALL_ROWS: SQL = sql`true`;
const NO_ROWS: SQL = sql`false`;

/** V1/V2: unrestricted for active Admins and Recruiters; nothing for anyone else yet. */
function adminOrRecruiterOnly(user: PolicyUser | null | undefined): SQL {
  if (!user || user.isActive === false) return NO_ROWS;
  return user.role === "ADMIN" || user.role === "RECRUITER" ? ALL_ROWS : NO_ROWS;
}

export function scopeRequisitionsFor(user: PolicyUser | null | undefined): SQL {
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
