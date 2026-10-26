// Row-level query filters (ats-project-scope.md V9, tech-stack.md D6): each
// returns a Drizzle condition to put in a query's WHERE, so visibility is
// never written ad hoc in a handler. They deny by default: a role whose
// visibility rule isn't implemented yet sees no rows.
//
//   db.select().from(requisitions).where(and(scopeRequisitionsFor(user), ...))
//
// Admin (V1) and Recruiter (V2) see everything. Hiring Managers see what
// belongs to their V3a requisitions (V3a, V4); the one V3a condition below is
// shared by all four filters. Interviewers see open applications they
// interview for (V5) and scorecards under V7; never offers (V6). V3b: a
// Hiring Manager who is (or was last) the approver of an offer on an
// application also sees that application, its offers, submitted scorecards
// and files, but not its requisition's pages (scopeRequisitionsFor stays V3a).
import { type SQL, sql } from "drizzle-orm";
import { requisitions } from "../db/schema";
import { OPEN_STATUSES } from "../domain/pipeline";
import type { PolicyUser } from "./permissions";

const ALL_ROWS: SQL = sql`true`;
const NO_ROWS: SQL = sql`false`;

const active = (user: PolicyUser | null | undefined): user is PolicyUser => !!user && user.isActive !== false;
const broad = (user: PolicyUser) => user.role === "ADMIN" || user.role === "RECRUITER";

/**
 * V3a: the requisition `requisitionId` (an SQL expression) has `user` as its
 * hiring manager, approver or creator. Approvers keep access after their
 * decision, because `approver_id` stays (§7).
 */
export function inV3a(user: PolicyUser, requisitionId: SQL): SQL {
  return sql`exists (
    select 1 from requisitions v3a
    where v3a.id = ${requisitionId}
      and (v3a.hiring_manager_id = ${user.id} or v3a.approver_id = ${user.id} or v3a.created_by_user_id = ${user.id})
  )`;
}

/**
 * V3b: `user` is `approver_id` of an offer on the application
 * `applicationId` (an SQL expression). Kept after the decision and after a
 * withdrawal, because `approver_id` keeps the latest submission (§7, Q3).
 */
export function approvesOfferOn(user: PolicyUser, applicationId: SQL): SQL {
  return sql`exists (select 1 from offers v3b where v3b.application_id = ${applicationId} and v3b.approver_id = ${user.id})`;
}

/** V1, V2; V3a: a Hiring Manager's requisitions as hiring manager, approver or creator. */
export function scopeRequisitionsFor(user: PolicyUser | null | undefined): SQL {
  if (!active(user)) return NO_ROWS;
  if (broad(user)) return ALL_ROWS;
  return user.role === "HIRING_MANAGER" ? inV3a(user, sql`${requisitions.id}`) : NO_ROWS;
}

/** V1, V2; V4: applications on a Hiring Manager's V3a requisitions; V5: an Interviewer's open applications they interview for. */
export function scopeApplicationsFor(user: PolicyUser | null | undefined): SQL {
  if (!active(user)) return NO_ROWS;
  if (broad(user)) return ALL_ROWS;
  if (user.role === "HIRING_MANAGER") return sql`(${inV3a(user, sql`"applications"."requisition_id"`)} or ${approvesOfferOn(user, sql`"applications"."id"`)})`;
  return user.role === "INTERVIEWER" ? participatesIn(user, sql`"applications"."id"`) : NO_ROWS;
}

/** V1, V2; V4: offers on a Hiring Manager's V3a applications. V6: Interviewers never see offers. */
export function scopeOffersFor(user: PolicyUser | null | undefined): SQL {
  if (!active(user)) return NO_ROWS;
  if (broad(user)) return ALL_ROWS;
  if (user.role === "HIRING_MANAGER") {
    return sql`(${inV3a(user, sql`(select oa.requisition_id from applications oa where oa.id = "offers"."application_id")`)} or ${approvesOfferOn(user, sql`"offers"."application_id"`)})`;
  }
  return NO_ROWS;
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
 * V1, V2: every scorecard (callers leave out other people's drafts). V4:
 * a Hiring Manager sees the submitted scorecards on V3a applications and
 * their own; V7 hides nothing from them (Q2), and outside V3a they have no
 * access, also as a participant (Q5). V5, V7 for Interviewers: their own
 * scorecards on an application they participate in; other participants'
 * submitted ones only once one of their own there is submitted and none is
 * reopened-but-not-resubmitted. Enforced in SQL, so a hidden scorecard is
 * absent from every response, not only from the UI.
 */
export function scopeScorecardsFor(user: PolicyUser | null | undefined): SQL {
  if (!active(user)) return NO_ROWS;
  if (broad(user)) return ALL_ROWS;
  const ownOrSubmitted = sql`(interview_scorecards.interviewer_id = ${user.id} or interview_scorecards.submitted_at is not null)`;
  if (user.role === "HIRING_MANAGER") {
    const requisition = sql`(select sa.requisition_id from interviews si join applications sa on sa.id = si.application_id where si.id = interview_scorecards.interview_id)`;
    const application = sql`(select si.application_id from interviews si where si.id = interview_scorecards.interview_id)`;
    return sql`((${inV3a(user, requisition)} or ${approvesOfferOn(user, application)}) and ${ownOrSubmitted})`;
  }
  if (user.role !== "INTERVIEWER") return NO_ROWS;
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
