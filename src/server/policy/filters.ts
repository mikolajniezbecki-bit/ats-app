// Row-level query filters (ats-project-scope.md V9, tech-stack.md D6): each
// returns a Drizzle condition to put in a query's WHERE, so visibility is
// never written ad hoc in a handler. They deny by default: a role whose
// visibility rule isn't implemented yet sees no rows.
//
//   db.select().from(requisitions).where(and(scopeRequisitionsFor(user), ...))
//
// Admin (V1) and Recruiter (V2) see everything. Hiring Managers see the
// requisitions of V3a; their application reads (V3b: task 36) and the
// Interviewer's (V5, V6: task 34) get their conditions from those tasks.
// Scorecards follow V5 and V7 for every participant without broader access
// (task 33).
import { type SQL, eq, or, sql } from "drizzle-orm";
import { requisitions } from "../db/schema";
import { OPEN_STATUSES } from "../domain/pipeline";
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

const OPEN_LIST = sql.join(
  OPEN_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

/**
 * V5: `user` is a current (not removed) participant of a non-cancelled
 * interview on the application `applicationId` refers to, and that
 * application is open and not anonymized. `applicationId` is an SQL
 * expression, so the condition works inside other queries.
 */
export function participatesIn(user: PolicyUser, applicationId: SQL): SQL {
  return sql`exists (
    select 1 from interview_participants p
    join interviews i on i.id = p.interview_id
    join applications a on a.id = i.application_id
    where i.application_id = ${applicationId}
      and p.user_id = ${user.id} and p.removed_at is null
      and i.status <> 'CANCELLED'
      and a.status in (${OPEN_LIST}) and a.anonymized_at is null
  )`;
}

/**
 * V1, V2: every scorecard (callers leave out other people's drafts). V5, V7
 * for anyone else: their own scorecards on an application they participate
 * in; other participants' submitted ones only once one of their own there is
 * submitted and none is reopened-but-not-resubmitted. Enforced in SQL, so a
 * hidden scorecard is absent from every response, not only from the UI.
 */
export function scopeScorecardsFor(user: PolicyUser | null | undefined): SQL {
  if (!user || user.isActive === false || user.role === "ADMIN" || user.role === "RECRUITER") return adminOrRecruiterOnly(user);
  const application = sql`(select si.application_id from interviews si where si.id = interview_scorecards.interview_id)`;
  const own = (extra: SQL) => sql`exists (
    select 1 from interview_scorecards o join interviews oi on oi.id = o.interview_id
    where oi.application_id = ${application} and o.interviewer_id = ${user.id} and ${extra}
  )`;
  return sql`(${participatesIn(user, application)} and (
    interview_scorecards.interviewer_id = ${user.id}
    or (interview_scorecards.submitted_at is not null
      and ${own(sql`o.submitted_at is not null`)}
      and not ${own(sql`o.reopened_at is not null and o.submitted_at is null`)})
  ))`;
}

export function scopeOffersFor(user: PolicyUser | null | undefined): SQL {
  return adminOrRecruiterOnly(user);
}
