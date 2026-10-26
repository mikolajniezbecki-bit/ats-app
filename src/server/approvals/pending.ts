// The pending approvals of one approver (ats-project-scope.md A5): the
// requisitions in PENDING_APPROVAL and the offers with approval_status
// PENDING whose approver_id is the user. Kept apart from ./index so the user
// management service can import it without an import cycle.
import { and, asc, eq } from "drizzle-orm";
import type { Db, Tx } from "../db";
import { applications, offers, requisitions } from "../db/schema";

/** The roles that can approve (A1). */
export const APPROVER_ROLES = ["HIRING_MANAGER", "ADMIN"] as const;

/**
 * The approver's pending items, each by its requisition number (offers in
 * task 36 add the candidate), requisitions first.
 */
export async function pendingApprovalsOf(db: Db | Tx, userId: string): Promise<string[]> {
  // One after the other: a transaction has a single connection.
  const pendingRequisitions = await db
    .select({ reqNumber: requisitions.reqNumber })
    .from(requisitions)
    .where(and(eq(requisitions.state, "PENDING_APPROVAL"), eq(requisitions.approverId, userId)))
    .orderBy(asc(requisitions.reqNumber));
  const pendingOffers = await db
    .select({ reqNumber: requisitions.reqNumber })
    .from(offers)
    .innerJoin(applications, eq(applications.id, offers.applicationId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .where(and(eq(offers.approvalStatus, "PENDING"), eq(offers.approverId, userId)))
    .orderBy(asc(requisitions.reqNumber));
  return [...pendingRequisitions, ...pendingOffers].map((row) => row.reqNumber);
}
